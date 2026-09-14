import type { Drone, DroneId, Obstacle } from '../shared/types.ts';
import { RTS_CONFIG, type Point } from '../shared/rts.ts';
import { sphereContact, terrainContact } from './rts-geometry.ts';

/** Simulated vehicle hardware. Distances are local game units (10 metres/unit). */
export const LOCAL_SENSOR_CONFIG = Object.freeze({
  proximityRange: 4, proximityRadius: 0.5, downwardRange: 20, maxAgeMs: 150,
  // The controller protects the actual airframe, not a point at its centre.
  vehicleRadius: RTS_CONFIG.droneRadius, clearanceMargin: 0.025,
});
export type RangeValidity = 'valid' | 'out-of-range' | 'unavailable';
export interface RangeReading {
  direction: Point;
  distance: number | null;
  validity: RangeValidity;
  coverage: { shape: 'swept-sphere' | 'ray'; radius: number; maxDistance: number };
}
export interface LocalRangeSample {
  sequence: number; frame: 'local'; units: 'world_units';
  acquiredAt: string; acquiredAtMs: number; simTime: number;
  origin: Point;
  proximity: RangeReading[];
  downward: RangeReading;
}

const DIRECTIONS: readonly Point[] = Object.freeze([-1, 0, 1].flatMap(x => [-1, 0, 1].flatMap(y =>
  [-1, 0, 1].filter(z => x || y || z).map(z => {
    const length = Math.hypot(x, y, z); return Object.freeze({ x: x / length, y: y / length, z: z / length });
  }))));
const point = ({ x, y, z }: Point): Point => ({ x, y, z });

/**
 * A fixed beam's near field includes its origin sphere. When the wider guard
 * shell is occupied but the airframe is clear, measure the largest clear inner
 * footprint instead of treating that guard-shell overlap as physical contact
 * in every direction. The reported coverage always includes the airframe.
 * This calculation is bounded to the sensor's existing near-field envelope;
 * it neither consults a requested target nor supplies a surface identity.
 */
function measuredFootprint(origin: Point, obstacles: readonly Obstacle[], peers: readonly Drone[]): number {
  const { proximityRadius, vehicleRadius } = LOCAL_SENSOR_CONFIG;
  let clearRadius = Math.min(proximityRadius, origin.y);
  for (const box of obstacles) {
    const angle = (box.rotation ?? 0) * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    const dx = origin.x - box.x, dz = origin.z - box.z;
    // Match the conservative padded-OBB collision/measurement primitive.
    const clearance = Math.max(Math.abs(c * dx - s * dz) - box.width / 2,
      Math.abs(origin.y - (box.baseY ?? 0) - box.height / 2) - box.height / 2,
      Math.abs(s * dx + c * dz) - box.depth / 2);
    clearRadius = Math.min(clearRadius, clearance);
  }
  for (const peer of peers) clearRadius = Math.min(clearRadius,
    Math.hypot(origin.x - peer.x, origin.y - peer.y, origin.z - peer.z) - RTS_CONFIG.droneRadius);
  if (clearRadius >= proximityRadius) return proximityRadius;
  // Leave a measured gap at the inner footprint's boundary, while retaining
  // positive lateral coverage for any strictly clear physical starting pose.
  return vehicleRadius + Math.max(0, clearRadius - vehicleRadius) * 0.95;
}

/**
 * Only this simulated sensor has geometry access. Its fixed 26 beams never aim
 * at a requested waypoint, classify an object, or return a contact coordinate.
 * A beam measures the first centre-travel distance of its stated swept sphere;
 * that is deliberately different from an unpadded pencil range measurement.
 */
export class LocalSensors {
  private sequences = new Map<DroneId, number>();

  clear(drone?: DroneId) { if (drone) this.sequences.delete(drone); else this.sequences.clear(); }

  acquire(drone: Drone, obstacles: readonly Obstacle[], drones: readonly Drone[], simTime: number,
    acquiredAtMs = performance.now()): LocalRangeSample {
    const origin = point(drone), range = LOCAL_SENSOR_CONFIG.proximityRange;
    // Broad-phase exclusion is private implementation of finite hardware range.
    // Bounding radii include rotated footprints and tier base heights.
    const nearby = obstacles.filter(box => Math.hypot(box.x - drone.x, box.z - drone.z)
      <= Math.hypot(box.width, box.depth) / 2 + range + LOCAL_SENSOR_CONFIG.proximityRadius
      && (box.baseY ?? 0) <= drone.y + range + LOCAL_SENSOR_CONFIG.proximityRadius
      && (box.baseY ?? 0) + box.height >= drone.y - LOCAL_SENSOR_CONFIG.downwardRange);
    const peers = drones.filter(peer => peer.id !== drone.id && peer.alive !== false
      && Math.hypot(peer.x - drone.x, peer.y - drone.y, peer.z - drone.z) <= LOCAL_SENSOR_CONFIG.downwardRange + 2 * LOCAL_SENSOR_CONFIG.proximityRadius);
    const footprint = measuredFootprint(origin, nearby, peers);
    const read = (direction: Point, maxDistance: number, radius: number): RangeReading => {
      const end = { x: origin.x + direction.x * maxDistance,
        y: origin.y + direction.y * maxDistance, z: origin.z + direction.z * maxDistance };
      let fraction = terrainContact(origin, end, nearby, radius)?.t;
      for (const peer of peers) {
        const hit = sphereContact(origin, end, peer, peer, RTS_CONFIG.droneRadius + radius);
        if (hit !== undefined && (fraction === undefined || hit < fraction)) fraction = hit;
      }
      return { direction: point(direction), distance: fraction === undefined ? null : fraction * maxDistance,
        validity: fraction === undefined ? 'out-of-range' : 'valid',
        coverage: { shape: radius ? 'swept-sphere' : 'ray', radius, maxDistance } };
    };
    const sequence = (this.sequences.get(drone.id) ?? 0) + 1;
    this.sequences.set(drone.id, sequence);
    return { sequence, frame: 'local', units: 'world_units', acquiredAt: new Date().toISOString(),
      acquiredAtMs, simTime, origin,
      proximity: DIRECTIONS.map(direction => read(direction, range, footprint)),
      downward: read({ x: 0, y: -1, z: 0 }, LOCAL_SENSOR_CONFIG.downwardRange, 0) };
  }
}

export function rangeSampleFresh(sample: LocalRangeSample, nowMs = performance.now()): boolean {
  const age = nowMs - sample.acquiredAtMs;
  return Number.isFinite(age) && age >= -0.001 && age <= LOCAL_SENSOR_CONFIG.maxAgeMs;
}
