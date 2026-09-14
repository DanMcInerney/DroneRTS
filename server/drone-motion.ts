import type { Drone, DroneId, Pose } from '../shared/types.ts';

type Vector = Pick<Pose, 'x' | 'y' | 'z'>;
interface Motion {
  velocity: Vector;
  yawTarget?: number; pitchTarget?: number;
  yawRate: number; pitchRate: number;
}

// Simulator-private actuator calibration, never part of an agent observation.
const MAX_SPEED = 3, ACCELERATION = 6, POSITION_RESPONSE = 4;
const YAW_RATE = 180, PITCH_RATE = 120, ANGULAR_RESPONSE = 4;
const YAW_ACCELERATION = 720, PITCH_ACCELERATION = 540;
export const CAMERA_PITCH_LIMITS = Object.freeze({ min: -85, max: 70 });
const zero = (): Vector => ({ x: 0, y: 0, z: 0 });
const length = (v: Vector) => Math.hypot(v.x, v.y, v.z);
const wrap = (angle: number) => ((angle + 180) % 360 + 360) % 360 - 180;
const approach = (value: number, target: number, step: number) => value + Math.max(-step, Math.min(step, target - value));

/** Inertial state stays outside both the public drone pose and its sensor bundle. */
export class DroneMotion {
  private motions = new Map<DroneId, Motion>();

  private of(drone: Drone) {
    let motion = this.motions.get(drone.id);
    if (!motion) {
      motion = { velocity: zero(), yawRate: 0, pitchRate: 0 };
      this.motions.set(drone.id, motion);
    }
    return motion;
  }

  clear(drone?: Drone) { if (drone) this.motions.delete(drone.id); else this.motions.clear(); }

  hover(drone: Drone) {
    const motion = this.of(drone);
    // A zero-velocity command brakes the current flight without teleporting.
    motion.yawTarget = undefined; motion.pitchTarget = undefined;
  }

  look(drone: Drone, yaw?: number, pitch?: number) {
    const motion = this.of(drone);
    if (yaw !== undefined) motion.yawTarget = wrap(yaw);
    if (pitch !== undefined) motion.pitchTarget = pitch;
  }

  faceWaypoint(drone: Drone, target: Vector) {
    const dx = target.x - drone.x, dz = target.z - drone.z;
    if (Math.hypot(dx, dz) > 0.1) this.look(drone, Math.atan2(-dx, -dz) * 180 / Math.PI);
  }

  step(drone: Drone, dt: number): { next: Vector; arrived: boolean } {
    const motion = this.of(drone);
    this.rotate(drone, motion, 'yaw', dt);
    this.rotate(drone, motion, 'pitch', dt);
    const target = drone.action?.target;
    const delta = target ? { x: target.x - drone.x, y: target.y - drone.y, z: target.z - drone.z } : zero();
    const distance = length(delta), multiplier = distance > 0 ? Math.min(POSITION_RESPONSE, MAX_SPEED / distance) : 0;
    const desired = { x: delta.x * multiplier, y: delta.y * multiplier, z: delta.z * multiplier };
    const change = { x: desired.x - motion.velocity.x, y: desired.y - motion.velocity.y, z: desired.z - motion.velocity.z };
    const magnitude = length(change), fraction = magnitude > 0 ? Math.min(1, ACCELERATION * dt / magnitude) : 0;
    const next = zero();
    for (const axis of ['x', 'y', 'z'] as const) {
      const before = motion.velocity[axis];
      motion.velocity[axis] += change[axis] * fraction;
      next[axis] = drone[axis] + (before + motion.velocity[axis]) * dt / 2;
    }
    const remaining = target ? Math.hypot(target.x - next.x, target.y - next.y, target.z - next.z) : Infinity;
    const arrived = remaining < 0.004 && length(motion.velocity) < 0.04;
    if (arrived) { Object.assign(next, target); motion.velocity = zero(); }
    return { next, arrived };
  }

  private rotate(drone: Drone, motion: Motion, axis: 'yaw' | 'pitch', dt: number) {
    const target = motion[`${axis}Target`];
    const delta = target === undefined ? 0 : axis === 'yaw' ? wrap(target - drone[axis]) : target - drone[axis];
    const maxRate = axis === 'yaw' ? YAW_RATE : PITCH_RATE;
    const acceleration = axis === 'yaw' ? YAW_ACCELERATION : PITCH_ACCELERATION;
    const desiredRate = Math.max(-maxRate, Math.min(maxRate, delta * ANGULAR_RESPONSE));
    const before = motion[`${axis}Rate`];
    const rate = approach(before, desiredRate, acceleration * dt);
    motion[`${axis}Rate`] = rate;
    drone[axis] += (before + rate) * dt / 2;
    if (axis === 'yaw') drone.yaw = wrap(drone.yaw);
    else if (drone.pitch < CAMERA_PITCH_LIMITS.min || drone.pitch > CAMERA_PITCH_LIMITS.max) {
      drone.pitch = Math.max(CAMERA_PITCH_LIMITS.min, Math.min(CAMERA_PITCH_LIMITS.max, drone.pitch)); motion.pitchRate = 0;
    }
    if (target !== undefined && Math.abs(delta) < 0.001 && Math.abs(rate) < 0.03) {
      drone[axis] = target; motion[`${axis}Rate`] = 0; motion[`${axis}Target`] = undefined;
    }
  }
}
