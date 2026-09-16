import type { DroneId, Obstacle, Pose } from './types';
import { apronServicePositions, type ResourceNode, type ServicePad } from './rts';
import downtown from './downtown.json';

// Physical enclosure for new matches. Inner faces coincide with the existing
// flight bounds; the thin solids extend outward, leaving the usable map intact.
// The renderer gives these a translucent treatment instead of city façades.
const [west, east] = downtown.x, [north, south] = downtown.z, [bottom, ceiling] = downtown.y;
const thickness = 0.2, centerX = (west + east) / 2, centerZ = (north + south) / 2;
export const BATTLEFIELD_BOUNDARIES: readonly Obstacle[] = [
  { id: 'arena-wall-west', x: west - thickness / 2, z: centerZ, width: thickness, depth: south - north + 2 * thickness, baseY: bottom, height: ceiling - bottom + thickness },
  { id: 'arena-wall-east', x: east + thickness / 2, z: centerZ, width: thickness, depth: south - north + 2 * thickness, baseY: bottom, height: ceiling - bottom + thickness },
  { id: 'arena-wall-north', x: centerX, z: north - thickness / 2, width: east - west + 2 * thickness, depth: thickness, baseY: bottom, height: ceiling - bottom + thickness },
  { id: 'arena-wall-south', x: centerX, z: south + thickness / 2, width: east - west + 2 * thickness, depth: thickness, baseY: bottom, height: ceiling - bottom + thickness },
  { id: 'arena-ceiling', x: centerX, z: centerZ, width: east - west + 2 * thickness, depth: south - north + 2 * thickness, baseY: ceiling, height: thickness },
];

// Simulator/player data only. Never expose locations or routes to actors.
// Opposite west/east rooftops: Paycor Headquarters and the Queen City Square
// podium. Equal 56m aprons align with the existing roof boxes, which stay intact.
const servicePads: ServicePad[] = [
  { id: 'service-blue', team: 'blue', x: -25.673, y: 1.28, z: 11.541, rotation: 10.171, zoneSize: 5.6, serviceHeight: 6 },
  { id: 'service-red', team: 'red', x: 41.343, y: 1.8, z: 13.161, rotation: 11.173, zoneSize: 5.6, serviceHeight: 6 },
];
const ids: DroneId[] = ['drone-1', 'drone-2', 'drone-3', 'drone-4', 'drone-5', 'drone-6'];
const spawns = Object.fromEntries(ids.map((id, index) => {
  const pad = servicePads[Math.floor(index / 3)];
  const point = apronServicePositions(pad, pad.zoneSize!)[index % 3];
  return [id, { ...point, y: pad.y + 1.8,
    yaw: Math.atan2(point.x - pad.x, point.z - pad.z) * 180 / Math.PI,
    pitch: -55,
  } satisfies Pose];
})) as Record<DroneId, Pose>;

const deposit = (id: string, x: number, y: number, z: number, capacity: number, rotation: number): ResourceNode =>
  ({ id, x, y, z, zoneSize: 3.2, rotation, kind: 'cache', reserved: 0, remaining: capacity, capacity, extractionMultiplier: 1 });

export const BATTLEFIELD = {
  spawns, servicePads,
  resources: [
    // Existing IDs retain recording/fixture compatibility; new-match aprons sit
    // on the Westin, Atrium One and Dixie Terminal North roofs, respectively.
    // Square aprons follow each roof's grid and leave their service airspace clear.
    deposit('salvage-vine-fourth', -2.546, 1.8, 8.557, 120, 11.57),
    deposit('salvage-main-fourth', 26.982, 8.1, 15.43, 120, 11.035),
    deposit('salvage-walnut-fourth', 5.857, 3.8, 19.672, 600, 10.813),
  ] satisfies ResourceNode[],
  focus: { x: downtown.x, z: downtown.z } as { x: [number, number]; z: [number, number] },
};
