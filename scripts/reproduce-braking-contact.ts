/** Offline QA fixture from the 2026-09-14 battle. Never imported by actors.
 * Prints contact evidence rather than asserting that the known bug stays present.
 * Run: node --import tsx scripts/reproduce-braking-contact.ts
 */
import { DroneMotion, type MotionBlockReason } from '../server/drone-motion.ts';
import { LocalSensors } from '../server/local-sensors.ts';
import { sphereContact } from '../server/rts-geometry.ts';
import { RTS_CONFIG } from '../shared/rts.ts';
import type { Drone } from '../shared/types.ts';

const target = { x: 55.20000076293945, y: 12, z: 21.5 };
const results = [1 / 120, 0.0078].map(dt => {
  const drone: Drone = {
    id: 'drone-4', x: 51.599998474121094, y: 8, z: 21.899999618530273,
    yaw: 270, pitch: -20, alive: true, online: true, observations: 0, status: 'Flying',
    action: { id: 'recorded-ram', kind: 'fly_to', target },
  };
  const peer: Drone = { ...drone, ...target, id: 'drone-6', action: undefined };
  const motion = new DroneMotion(), sensors = new LocalSensors();
  let blocked: MotionBlockReason | null = null, contactSimTime: number | null = null, arrived = false;
  let measuredRadius = 0, elapsed = 0;
  for (let step = 0; step < 2400; step++) {
    const time = step * dt, before = { x: drone.x, y: drone.y, z: drone.z };
    const ranges = sensors.acquire(drone, [], [drone, peer], time, time * 1000);
    const result = motion.step(drone, dt, { ranges, nowMs: time * 1000, profile: 'precision' });
    blocked = result.blocked ?? blocked;
    measuredRadius = ranges.proximity[0].coverage.radius;
    const contact = sphereContact(before, result.next, peer, peer, RTS_CONFIG.droneRadius * 2);
    Object.assign(drone, result.next);
    elapsed = time + dt;
    arrived = result.arrived;
    if (contact !== undefined) { contactSimTime = time + contact * dt; break; }
    if (arrived) break;
  }
  return { dt, contact: contactSimTime !== null, contactSimTime, elapsed, blocked, arrived,
    separation: Math.hypot(drone.x - peer.x, drone.y - peer.y, drone.z - peer.z),
    requiredSeparation: RTS_CONFIG.droneRadius * 2, measuredRadius, velocity: motion.velocity(drone) };
});
console.log(JSON.stringify({ sourceBattle: 'a005bff66d672ca214a2da5e8cf913faf93d96d9',
  fixture: 'Recorded precision approach to a stationary peer; no buildings, model inference or actor input', results }, null, 2));
