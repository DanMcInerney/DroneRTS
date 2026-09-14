import type { Drone, WorldState } from './types';

type Sample = { at: number; drones: Drone[] };

/** Display-only delay absorbs network jitter. Sensor captures never use this buffer. */
export class PoseBuffer {
  private samples: Sample[] = [];
  private simTime = -1;
  private running = false;
  constructor(private delay = 100) {}

  push(state: WorldState, at: number) {
    const reset = state.simTime < this.simTime || state.running !== this.running || !state.running;
    if (reset) this.samples = [];
    if (!reset && state.simTime === this.simTime && this.samples.length) {
      this.samples[this.samples.length - 1].drones = state.drones.map(drone => ({ ...drone }));
      return;
    }
    this.simTime = state.simTime; this.running = state.running;
    this.samples.push({ at, drones: state.drones.map(drone => ({ ...drone })) });
    if (this.samples.length > 20) this.samples.shift();
  }

  pending(at: number) { return this.samples.length > 1 && at - this.delay < this.samples.at(-1)!.at; }

  sample(at: number): Drone[] {
    const time = at - this.delay;
    while (this.samples.length > 2 && this.samples[1].at <= time) this.samples.shift();
    const a = this.samples[0], b = this.samples[1];
    if (!a) return [];
    if (!b) return a.drones;
    const t = Math.max(0, Math.min(1, (time - a.at) / Math.max(1, b.at - a.at)));
    const latest = this.samples.at(-1)!.drones;
    const fromById = new Map(a.drones.map(drone => [drone.id, drone]));
    const toById = new Map(b.drones.map(drone => [drone.id, drone]));
    // Membership and labels always follow the newest state. Only a surviving
    // entity's pose is delayed; array order never identifies a drone.
    return latest.map(drone => {
      const to = toById.get(drone.id) ?? drone;
      const from = fromById.get(drone.id) ?? to;
      const yawDelta = ((to.yaw - from.yaw + 540) % 360) - 180;
      return { ...drone, x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t,
        z: from.z + (to.z - from.z) * t, yaw: from.yaw + yawDelta * t, pitch: from.pitch + (to.pitch - from.pitch) * t };
    });
  }
}
