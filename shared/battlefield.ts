import type { DroneId, Pose } from './types';
import type { ResourceNode, ServicePad } from './rts';
import downtown from './downtown.json';

// Simulator and player-renderer data. Never import this module into drone tools
// or put battlefield coordinates or route information in actor prompts.
const launchSites = [
  { x: -27, z: 39.2 }, // West Third Street forecourt, west of Race.
  { x: 40, z: 30.2 }, // East Third Street forecourt, south of the tower cluster.
];
// Broad Third Street verges leave the entire six-unit service volume clear.
const serviceSites = [{ x: -27, z: 41 }, { x: 40, z: 32 }];
const offsets = [{ x: -1.8, z: 1.2 }, { x: 0, z: 2.1 }, { x: 1.8, z: 0.8 }];
const ids: DroneId[] = ['drone-1', 'drone-2', 'drone-3', 'drone-4', 'drone-5', 'drone-6'];
const spawns = Object.fromEntries(ids.map((id, index) => {
  const site = launchSites[Math.floor(index / 3)], offset = offsets[index % 3];
  const x = site.x + offset.x, z = site.z + offset.z, y = 1.8;
  const service = serviceSites[Math.floor(index / 3)];
  const dx = service.x - x, dz = service.z - z;
  return [id, { x, y, z,
    yaw: Math.atan2(-dx, -dz) * 180 / Math.PI,
    pitch: -55, // Look into the visible marked base apron before exploring.
  } satisfies Pose];
})) as Record<DroneId, Pose>;

const deposit = (id: string, x: number, z: number, zoneSize: number, capacity: number, extractionMultiplier = 1): ResourceNode =>
  ({ id, x, y: 0, z, zoneSize, kind: 'cache', reserved: 0, remaining: capacity, capacity, extractionMultiplier });

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
    deposit('salvage-race-third', -17.07, 33.978, 3, 60), // Race / Third.
    deposit('salvage-vine-fourth', -5.854, 17.161, 2.5, 60), // Vine / Fourth.
    deposit('salvage-main-second', 26.366, 34, 3, 60), // Main / Second.
    deposit('salvage-sycamore-fifth', 33.356, -4.393, 2.5, 60), // Sycamore / Fifth.
    // Broad open forecourt immediately south of Vine / Third. The stable ID
    // remains for recordings; this rules revision intentionally moves the depot.
    deposit('salvage-fountain', -3, 35, 4, 600),
  ] satisfies ResourceNode[],
  // An initial player camera composition, not a wall or an agent observation.
  focus: { x: downtown.x, z: downtown.z } as { x: [number, number]; z: [number, number] },
};
