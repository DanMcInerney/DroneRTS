import type { DroneId, Pose } from './types';
import { apronServicePositions, type ResourceNode, type ServicePad } from './rts';
import downtown from './downtown.json';

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

const deposit = (id: string, x: number, z: number, zoneSize: number, capacity: number, rotation = 0): ResourceNode =>
  ({ id, x, y: 0, z, zoneSize, rotation, kind: 'cache', reserved: 0, remaining: capacity, capacity, extractionMultiplier: 1 });

export const BATTLEFIELD = {
  spawns, servicePads,
  resources: [
    // Nearest Fourth Street crossings to each base/center midpoint. Small
    // measured offsets clear the sourced corner boxes without moving the city.
    deposit('salvage-vine-fourth', -5.854, 17.161, 2.5, 120),
    deposit('salvage-main-fourth', 21.86, 11.589, 2.5, 120, 11),
    // Walnut/Fourth is the source road junction nearest the map center (9,13).
    // A 0.05-unit east offset fits a 20m apron between all four corner buildings.
    deposit('salvage-walnut-fourth', 8.126, 14.521, 2, 600),
  ] satisfies ResourceNode[],
  focus: { x: downtown.x, z: downtown.z } as { x: [number, number]; z: [number, number] },
};
