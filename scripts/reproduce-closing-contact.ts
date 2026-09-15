/** Offline reduction of the September 15 team-haul collision; never actor input.
 * The vertical leg, load and profiles match the recording; horizontal arrival is
 * replaced by a deterministic ascent warmup. This is not an exact replay.
 * Prints contact evidence instead of asserting that the known defect persists.
 * Run: node --import tsx scripts/reproduce-closing-contact.ts
 */
import { DroneMotion } from '../server/drone-motion.ts';
import { LocalSensors } from '../server/local-sensors.ts';
import { sphereContact } from '../server/rts-geometry.ts';
import { RTS_CONFIG } from '../shared/rts.ts';
import type { Drone } from '../shared/types.ts';

const results = [1 / 120, 0.0078].map(dt => {
  const lower: Drone = { id: 'drone-1', x: -3, y: 1.8, z: 35.6,
    yaw: 0, pitch: 0, alive: true, online: true, observations: 0, status: 'Flying',
    action: { id: 'ascent', kind: 'fly_to', profile: 'precision', target: { x: -3, y: 10, z: 35.6 } } };
  const upper: Drone = { ...lower, id: 'drone-2', y: 10, action: undefined };
  const drones = [lower, upper], motion = new DroneMotion(), sensors = new LocalSensors();
  const blocked: unknown[] = [];
  let descending = false, contactTime: number | null = null, elapsed = 0;
  for (let step = 0; step < 2400; step++) {
    const time = step * dt;
    if (!descending && lower.y >= 3.7) {
      upper.action = { id: 'descent', kind: 'fly_to', profile: 'travel', target: { x: -3, y: 1.5, z: 35.6 } };
      descending = true;
    }
    const before = drones.map(d => ({ x: d.x, y: d.y, z: d.z }));
    // Match FleetGame's sequential fresh acquisition/integration order.
    for (const drone of drones) {
      const ranges = sensors.acquire(drone, [], drones, time, time * 1000);
      const result = motion.step(drone, dt, { ranges, nowMs: time * 1000,
        profile: drone.action?.profile, loaded: drone === lower });
      if (result.blocked) {
        blocked.push({ drone: drone.id, time, reason: result.blocked,
          gap: upper.y - lower.y - RTS_CONFIG.droneRadius * 2,
          lowerVelocity: motion.velocity(lower).y, upperVelocity: motion.velocity(upper).y });
        drone.action = undefined;
      }
      Object.assign(drone, result.next);
    }
    const contact = sphereContact(before[0], lower, before[1], upper, RTS_CONFIG.droneRadius * 2);
    elapsed = time + dt;
    if (contact !== undefined) { contactTime = time + contact * dt; break; }
    if (descending && drones.every(d => !d.action && Math.abs(motion.velocity(d).y) < 1e-9)) break;
  }
  return { dt, contact: contactTime !== null, contactTime, elapsed, blocked,
    separation: upper.y - lower.y, requiredSeparation: RTS_CONFIG.droneRadius * 2,
    velocities: drones.map(d => ({ drone: d.id, y: motion.velocity(d).y })) };
});
console.log(JSON.stringify({ fixture: 'Loaded precision ascent and empty travel descent in one column; no buildings, inference or actor input', results }, null, 2));
