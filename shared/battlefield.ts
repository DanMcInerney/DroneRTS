import type { DroneId, Pose } from './types';
import type { ResourceNode } from './rts';

// Simulator and player-renderer data. Never import this module into drone tools
// or put these coordinates, distances, or camera calibration in actor prompts.
const launchSites = [
  { x: -44.7, z: 39.3 }, // West 3rd / Plum: covered access to downtown.
  { x: 53.4, z: 20.7 }, // East 3rd / Broadway: beside the Lytle Park approach.
];
const offsets = [{ x: -1.8, z: 1.2 }, { x: 0, z: 2.1 }, { x: 1.8, z: 0.8 }];
const ids: DroneId[] = ['drone-1', 'drone-2', 'drone-3', 'drone-4', 'drone-5', 'drone-6'];
const spawns = Object.fromEntries(ids.map((id, index) => {
  const site = launchSites[Math.floor(index / 3)], offset = offsets[index % 3];
  const x = site.x + offset.x, z = site.z + offset.z, y = 1.8;
  const dx = site.x - x, dz = site.z - z;
  return [id, { x, y, z,
    yaw: Math.atan2(-dx, -dz) * 180 / Math.PI,
    pitch: Math.atan2(1.1 - y, Math.hypot(dx, dz)) * 180 / Math.PI,
  } satisfies Pose];
})) as Record<DroneId, Pose>;

const deposit = (id: string, x: number, z: number, capacity: number): ResourceNode =>
  ({ id, x, y: 0.45, z, remaining: capacity, capacity });

/** Compact, asymmetric urban routes with equal opening economies. */
export const BATTLEFIELD = {
  spawns,
  resources: [
    deposit('salvage-west', launchSites[0].x, launchSites[0].z, 80),
    deposit('salvage-east', launchSites[1].x, launchSites[1].z, 80),
    deposit('salvage-riverfront', 10.842, 28.66, 220),
    deposit('salvage-fountain', 5.696, 2.353, 180),
    deposit('salvage-court', -1.681, -35.356, 180),
  ] satisfies ResourceNode[],
  // An initial player camera composition, not a wall or an agent observation.
  focus: { x: [-112, 112], z: [-90, 95] } as { x: [number, number]; z: [number, number] },
};
