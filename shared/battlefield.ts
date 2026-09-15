import type { DroneId, Pose } from './types';
import type { ResourceNode } from './rts';

// Simulator and player-renderer data. Never import this module into drone tools
// or put these coordinates, distances, or camera calibration in actor prompts.
const bases = [
  { x: -44.7, z: 39.3 }, // West 3rd / Plum: covered access to downtown.
  { x: 53.4, z: 20.7 }, // East 3rd / Broadway: beside the Lytle Park approach.
];
// The geographic origin is inside Fifth Third Center. This open Third Street
// center is 1.1 units from the bases' geometric midpoint and fits all three cargo
// footprints without moving the sourced city geometry.
const center = { x: 4.4, z: 31.1 };
const halfway = bases.map(base => ({ x: (base.x + center.x) / 2, z: (base.z + center.z) / 2 }));
const offsets = [{ x: -1.8, z: 1.2 }, { x: 0, z: 2.1 }, { x: 1.8, z: 0.8 }];
const ids: DroneId[] = ['drone-1', 'drone-2', 'drone-3', 'drone-4', 'drone-5', 'drone-6'];
const spawns = Object.fromEntries(ids.map((id, index) => {
  const site = bases[Math.floor(index / 3)], target = halfway[Math.floor(index / 3)], offset = offsets[index % 3];
  const x = site.x + offset.x, z = site.z + offset.z, y = 1.8;
  const dx = target.x - x, dz = target.z - z;
  return [id, { x, y, z,
    yaw: Math.atan2(-dx, -dz) * 180 / Math.PI,
    pitch: Math.atan2(1.1 - y, Math.hypot(dx, dz)) * 180 / Math.PI,
  } satisfies Pose];
})) as Record<DroneId, Pose>;

const deposit = (id: string, x: number, z: number, capacity: number): ResourceNode =>
  ({ id, x, y: 0.45, z, remaining: capacity, capacity });

/** Three finite cargo placements along the two bases' approaches to the center. */
export const BATTLEFIELD = {
  bases,
  center,
  spawns,
  resources: [
    deposit('salvage-west', halfway[0].x, halfway[0].z, 120),
    deposit('salvage-center', center.x, center.z, 480),
    deposit('salvage-east', halfway[1].x, halfway[1].z, 120),
  ] satisfies ResourceNode[],
  // An initial player camera composition, not a wall or an agent observation.
  focus: { x: [center.x - 112, center.x + 112], z: [center.z - 92.5, center.z + 92.5] } as { x: [number, number]; z: [number, number] },
};
