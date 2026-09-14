import type { DroneId, Obstacle, Pose, RadioMessage, Treasure } from '../shared/types.ts';
import { DRONE_CAMERA } from '../shared/camera-profile.ts';
import { intersectsBuilding } from './world-geometry.ts';

type Intersection = { x: number; z: number };
interface Observation {
  drone: DroneId;
  pose: Pose;
  mission: number;
  simTime: number;
  imageAvailable: boolean;
}
interface Report {
  drone: DroneId;
  message: RadioMessage;
  mission: number;
  simTime: number;
}
const CHEST_COUNT = 6;
const EVIDENCE_LIFETIME = 30;
const CHEST_FOCUS_HEIGHT = 0.55;
const RECOGNITION_DISTANCE = 5.5;
const FRAME_INSET = 0.92;

/** Server-only objective rules. None of its evidence or results are drone observations. */
export class TreasureHunt {
  private sightings = new Map<DroneId, { ids: string[]; mission: number; simTime: number }>();

  constructor(private readonly intersections: readonly Intersection[], private readonly random = Math.random) {}

  newMap(previous: readonly Treasure[] = []) {
    const used = new Set(previous.map(chest => `${chest.x},${chest.z}`));
    const candidates = this.intersections.filter(point => !used.has(`${point.x},${point.z}`));
    if (candidates.length < CHEST_COUNT) throw new Error('City has too few unoccupied street intersections for a new treasure layout');
    // Partial Fisher-Yates selects distinct junctions without modifying geographic data.
    for (let i = 0; i < CHEST_COUNT; i++) {
      const pick = i + Math.floor(this.random() * (candidates.length - i));
      [candidates[i], candidates[pick]] = [candidates[pick], candidates[i]];
    }
    return this.restart(candidates.slice(0, CHEST_COUNT).map((point, i) => ({
      id: `chest-${i + 1}`, x: point.x, y: 0, z: point.z, found: false,
    })));
  }

  /** A launch resets progress and evidence while retaining the player's selected map. */
  restart(treasures: readonly Treasure[]) {
    this.sightings.clear();
    return { treasures: treasures.map(({ id, x, y, z }): Treasure => ({ id, x, y, z, found: false })), completed: false };
  }

  recordObservation(sample: Observation, treasures: readonly Treasure[], buildings: readonly Obstacle[]) {
    this.sightings.set(sample.drone, {
      ids: sample.imageAvailable ? visibleTreasures(sample.pose, treasures, buildings) : [],
      mission: sample.mission, simTime: sample.simTime,
    });
  }

  report({ drone, message, mission, simTime }: Report, treasures: Treasure[]) {
    const sighting = this.sightings.get(drone);
    if (message.from !== drone || message.kind !== 'found' || !/\b(chests?|treasure)\b/i.test(message.text)
      || !sighting || sighting.mission !== message.mission || message.mission !== mission
      || simTime - sighting.simTime > EVIDENCE_LIFETIME) return;
    const chest = sighting.ids.map(id => treasures.find(item => item.id === id)).find(item => item && !item.found);
    if (!chest) return;
    chest.found = true; chest.foundBy = drone; chest.foundAt = simTime;
    return {
      event: { id: chest.id, drone, simTime },
      completed: treasures.length > 0 && treasures.every(item => item.found),
    };
  }
}

/** Private recognition rules share the actual optical calibration, never a sensor/tool field. */
export function visibleTreasures(pose: Pose, treasures: readonly Treasure[], buildings: readonly Obstacle[]): string[] {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const yaw = radians(pose.yaw), pitch = radians(pose.pitch);
  const forward = { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
  const right = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
  const up = { x: Math.sin(yaw) * Math.sin(pitch), y: Math.cos(pitch), z: Math.cos(yaw) * Math.sin(pitch) };
  const dot = (a: { x: number; y: number; z: number }, b: typeof a) => a.x * b.x + a.y * b.y + a.z * b.z;
  const distance = (chest: Treasure) => Math.hypot(chest.x - pose.x, chest.y + CHEST_FOCUS_HEIGHT - pose.y, chest.z - pose.z);
  return treasures.filter(chest => {
    const target = { x: chest.x, y: chest.y + CHEST_FOCUS_HEIGHT, z: chest.z };
    const delta = { x: target.x - pose.x, y: target.y - pose.y, z: target.z - pose.z };
    const depth = dot(delta, forward), vertical = Math.tan(radians(DRONE_CAMERA.fov / 2));
    return !chest.found && distance(chest) <= RECOGNITION_DISTANCE && depth > 0.1
      && Math.abs(dot(delta, up)) < depth * vertical * FRAME_INSET
      && Math.abs(dot(delta, right)) < depth * vertical * (DRONE_CAMERA.width / DRONE_CAMERA.height) * FRAME_INSET
      && !buildings.some(building => intersectsBuilding(pose, target, building));
  }).sort((a, b) => distance(a) - distance(b)).map(chest => chest.id);
}
