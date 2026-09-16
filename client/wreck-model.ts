import type { GunWreck, MatchState, Point } from '../shared/rts';
import type { Obstacle } from '../shared/types';

/** Presentation only. One world unit is ten metres; no live vehicle dynamics change. */
export const WRECK_VISUALS = Object.freeze({ gravity: .981, clearance: .18, smokeInterval: .14, smokeLifetime: 9.5, smolderDuration: 1.4, particlesPerDrone: 72, maxWrecks: 6 });
export interface WreckTrajectory { seed: GunWreck; floor: number; duration: number }
export interface SmokePuff extends Point { radius: number; opacity: number; angle: number; emittedAt: number }

/** Vertical intersection with the actual oriented/tiered obstacle boxes, never their AABBs. */
export function wreckTrajectory(seed: GunWreck, obstacles: readonly Obstacle[]): WreckTrajectory {
  let surface = 0;
  for (const obstacle of obstacles) {
    const top = (obstacle.baseY ?? 0) + obstacle.height;
    if (top > seed.y || top <= surface) continue;
    const angle = (obstacle.rotation ?? 0) * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    const dx = seed.x - obstacle.x, dz = seed.z - obstacle.z;
    if (Math.abs(c * dx - s * dz) <= obstacle.width / 2 && Math.abs(s * dx + c * dz) <= obstacle.depth / 2) surface = top;
  }
  const floor = Math.min(seed.y, surface + WRECK_VISUALS.clearance);
  return { seed, floor, duration: Math.sqrt(2 * Math.max(0, seed.y - floor) / WRECK_VISUALS.gravity) };
}

export function wreckPose(trajectory: WreckTrajectory, time: number) {
  const { seed, floor, duration } = trajectory, age = time - seed.startedAt;
  if (age < 0) return undefined;
  const falling = Math.min(age, duration), settle = Math.min(1, Math.max(0, age - duration) / .35);
  const settleAngle = (angle: number, rest: number) => angle + Math.atan2(Math.sin(rest - angle), Math.cos(rest - angle)) * settle;
  return {
    x: seed.x, y: Math.max(floor, seed.y - .5 * WRECK_VISUALS.gravity * falling * falling), z: seed.z,
    yaw: seed.yaw * Math.PI / 180 + falling * .7,
    pitch: settleAngle(falling * 2.3, .15),
    roll: settleAngle(falling * 1.7, -.12),
    landed: age >= duration,
  };
}

const random = (value: number) => { const x = Math.sin(value * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

/** Reconstruct the same bounded trail at any timestamp, including a past camera acquisition. */
export function wreckSmoke(trajectory: WreckTrajectory, time: number): SmokePuff[] {
  const { seed, duration } = trajectory, age = time - seed.startedAt;
  if (age < 0) return [];
  const { smokeInterval: interval, smokeLifetime: life, particlesPerDrone, smolderDuration } = WRECK_VISUALS;
  const last = Math.floor(Math.min(age, duration + smolderDuration) / interval);
  const first = Math.max(0, Math.floor((age - life) / interval) + 1, last - particlesPerDrone + 1);
  const salt = Number(seed.drone.split('-')[1]) * 123;
  const puffs: SmokePuff[] = [];
  for (let i = first; i <= last; i++) {
    const emittedAt = seed.startedAt + i * interval, elapsed = time - emittedAt;
    const position = wreckPose(trajectory, emittedAt)!;
    puffs.push({
      x: position.x + (.065 + (random(i + salt) - .5) * .045) * elapsed,
      y: position.y + .12 * elapsed,
      z: position.z + (.025 + (random(i + salt + 11) - .5) * .045) * elapsed,
      radius: (.15 + .10 * elapsed) * (.85 + random(i + salt + 29) * .3),
      opacity: .6 * Math.min(1, elapsed / .16) * (1 - elapsed / life) ** 1.8,
      angle: random(i + salt + 41) * Math.PI * 2, emittedAt,
    });
  }
  return puffs;
}

/** Victory has a bounded visual tail; Stop/paused simulation freezes wreck motion. */
export function wreckDisplayTime(state: { simTime: number; running: boolean; speed: number; match?: MatchState }, elapsedSeconds: number) {
  const elapsed = Math.max(0, elapsedSeconds);
  if (state.match?.phase === 'finished') return state.simTime + Math.min(32, elapsed);
  // Sim ticks may stall during camera/network loss without changing running.
  return state.simTime + (state.running ? Math.min(.1, elapsed) * state.speed : 0);
}
