import type { DroneId, Pose } from './types';
import type { ResourceNode, ServicePad } from './rts';

// Simulator and player-renderer data. Never import this module into drone tools
// or put these coordinates, distances, or camera calibration in actor prompts.
const launchSites = [
  { x: -44.7, z: 39.3 }, // West 3rd / Plum: covered access to downtown.
  { x: 53.4, z: 20.7 }, // East 3rd / Broadway: beside the Lytle Park approach.
];
// Broad Third Street verges leave the entire six-unit service volume clear.
const serviceSites = [{ x: -44.2, z: 42 }, { x: 53.4, z: 23 }];
const offsets = [{ x: -1.8, z: 1.2 }, { x: 0, z: 2.1 }, { x: 1.8, z: 0.8 }];
const ids: DroneId[] = ['drone-1', 'drone-2', 'drone-3', 'drone-4', 'drone-5', 'drone-6'];
const spawns = Object.fromEntries(ids.map((id, index) => {
  const site = launchSites[Math.floor(index / 3)], offset = offsets[index % 3];
  const x = site.x + offset.x, z = site.z + offset.z, y = 1.8;
  const service = serviceSites[Math.floor(index / 3)];
  const dx = service.x - x, dz = service.z - z;
  return [id, { x, y, z,
    yaw: Math.atan2(-dx, -dz) * 180 / Math.PI,
    pitch: -55, // Look into the visible service-cube floor before exploring.
  } satisfies Pose];
})) as Record<DroneId, Pose>;

const deposit = (id: string, x: number, z: number, zoneSize: number, capacity: number, extractionMultiplier = 1): ResourceNode =>
  ({ id, x, y: 0, z, zoneSize, remaining: capacity, capacity, extractionMultiplier });

/** Paired exploration opportunities around a rich central contest; no launch-site salvage. */
export const BATTLEFIELD = {
  spawns,
  servicePads: [
    { id: 'service-blue', team: 'blue', ...serviceSites[0], y: 0, zoneSize: 6 },
    { id: 'service-red', team: 'red', ...serviceSites[1], y: 0, zoneSize: 6 },
  ] satisfies ServicePad[],
  resources: [
    // Mapped intersection centers, with edges sized to fill each crossing while
    // clearing the corner buildings. Keep stable IDs for recordings and fixtures.
    deposit('salvage-race-fourth', -17.07, 33.978, 3, 150), // Race / Third.
    deposit('salvage-main-fourth', 26.366, 34, 3, 150), // Main / Second.
    deposit('salvage-elm-fifth', -36.307, 8.704, 2.5, 150), // Elm / Fifth.
    deposit('salvage-sycamore-fifth', 33.356, -4.393, 2.5, 150), // Sycamore / Fifth.
    deposit('salvage-fountain', -5.854, 17.161, 2.4, 900, 1.5), // Vine / Fourth, south of Fountain Square.
  ] satisfies ResourceNode[],
  // An initial player camera composition, not a wall or an agent observation.
  focus: { x: [-112, 112], z: [-90, 95] } as { x: [number, number]; z: [number, number] },
};
