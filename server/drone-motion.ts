import type { Drone, DroneId, Pose } from '../shared/types.ts';
import { CARGO_CONFIG } from '../shared/rts.ts';
import { LOCAL_SENSOR_CONFIG, rangeSampleFresh, type LocalRangeSample } from './local-sensors.ts';

type Vector = Pick<Pose, 'x' | 'y' | 'z'>;
interface Motion {
  velocity: Vector;
  yawTarget?: number; pitchTarget?: number;
  yawRate: number; pitchRate: number;
  blockedAction?: string;
  blockedReason?: MotionBlockReason;
}

export type MovementProfile = 'travel' | 'precision';
export type MotionBlockReason = 'obstruction' | 'sensor-stale' | 'sensor-unavailable' | 'coverage-unavailable';
export const FLIGHT_PROFILES = Object.freeze({
  travel: Object.freeze({ maxSpeed: 3, acceleration: 6 }),
  precision: Object.freeze({ maxSpeed: 0.8, acceleration: 3 }),
});
export interface MotionObservation {
  ranges?: LocalRangeSample; nowMs?: number;
  profile?: MovementProfile; loaded?: boolean;
}
const POSITION_RESPONSE = 4;
const YAW_RATE = 180, PITCH_RATE = 120, ANGULAR_RESPONSE = 4;
const YAW_ACCELERATION = 720, PITCH_ACCELERATION = 540;
export const CAMERA_PITCH_LIMITS = Object.freeze({ min: -90, max: 70 });
const zero = (): Vector => ({ x: 0, y: 0, z: 0 });
const length = (v: Vector) => Math.hypot(v.x, v.y, v.z);
const wrap = (angle: number) => ((angle + 180) % 360 + 360) % 360 - 180;
const approach = (value: number, target: number, step: number) => value + Math.max(-step, Math.min(step, target - value));

/** Continuous own-state controller. World geometry is unavailable in this module. */
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

  velocity(drone: Drone): Vector { return { ...this.of(drone).velocity }; }

  hover(drone: Drone) {
    const motion = this.of(drone);
    // A zero-velocity command brakes the current flight without teleporting.
    motion.yawTarget = undefined; motion.pitchTarget = undefined;
  }

  look(drone: Drone, yaw?: number, pitch?: number) {
    const motion = this.of(drone);
    if (yaw !== undefined) motion.yawTarget = wrap(yaw);
    if (pitch !== undefined) motion.pitchTarget = Math.max(CAMERA_PITCH_LIMITS.min, Math.min(CAMERA_PITCH_LIMITS.max, pitch));
  }

  faceWaypoint(drone: Drone, target: Vector) {
    const dx = target.x - drone.x, dz = target.z - drone.z;
    if (Math.hypot(dx, dz) > 0.1) this.look(drone, Math.atan2(-dx, -dz) * 180 / Math.PI);
  }

  step(drone: Drone, dt: number, observation?: MotionObservation): { next: Vector; arrived: boolean; blocked?: MotionBlockReason } {
    const motion = this.of(drone);
    this.rotate(drone, motion, 'yaw', dt);
    this.rotate(drone, motion, 'pitch', dt);
    const target = drone.action?.target;
    const delta = target ? { x: target.x - drone.x, y: target.y - drone.y, z: target.z - drone.z } : zero();
    const profile = FLIGHT_PROFILES[observation?.profile ?? 'travel'];
    const acceleration = profile.acceleration;
    let maxSpeed = profile.maxSpeed * (observation?.loaded ? CARGO_CONFIG.loadedSpeedMultiplier : 1);
    const distance = length(delta);
    let blocked: MotionBlockReason | undefined;
    if (observation && target && distance > 0.004) {
      const direction = { x: delta.x / distance, y: delta.y / distance, z: delta.z / distance };
      if (motion.blockedAction === drone.action?.id) blocked = motion.blockedReason;
      else {
        const coverage = this.clearance(drone, direction, observation);
        blocked = coverage.reason;
        if (!blocked) {
          const speed = length(motion.velocity), stopping = speed * speed / (2 * acceleration) + speed * dt;
          // Replacing a target cannot erase existing momentum. Also inspect
          // the sensed stopping corridor along actual own velocity.
          if (speed > 0.03) {
            const current = this.clearance(drone, { x: motion.velocity.x / speed,
              y: motion.velocity.y / speed, z: motion.velocity.z / speed }, observation);
            blocked = current.reason;
            if (!blocked && current.obstructed && current.distance <= stopping + LOCAL_SENSOR_CONFIG.clearanceMargin) blocked = 'obstruction';
          }
          if (coverage.obstructed && coverage.distance <= stopping + LOCAL_SENSOR_CONFIG.clearanceMargin) blocked = 'obstruction';
          // A direction between fixed beams has less certified swept coverage.
          // Reduce speed to that horizon rather than treating unsampled space as clear.
          // A reduced but positive measured footprint must permit progress out
          // of a narrow initial guard-shell overlap, including between beams.
          // Keep the full obstruction stopping margin above; reserve at most
          // ten percent of a coverage-only horizon for this speed calculation.
          const horizon = Math.max(0, coverage.distance - Math.min(LOCAL_SENSOR_CONFIG.clearanceMargin, coverage.distance * 0.1));
          maxSpeed = Math.min(maxSpeed, Math.sqrt((acceleration * dt) ** 2 + 2 * acceleration * horizon) - acceleration * dt);
        }
      }
      if (blocked) {
        motion.blockedAction = drone.action?.id; motion.blockedReason = blocked;
        maxSpeed = 0;
      }
    }
    const multiplier = distance > 0 ? Math.min(POSITION_RESPONSE, Math.max(0, maxSpeed) / distance) : 0;
    const desired = { x: delta.x * multiplier, y: delta.y * multiplier, z: delta.z * multiplier };
    const change = { x: desired.x - motion.velocity.x, y: desired.y - motion.velocity.y, z: desired.z - motion.velocity.z };
    const magnitude = length(change), fraction = magnitude > 0 ? Math.min(1, acceleration * dt / magnitude) : 0;
    const next = zero();
    for (const axis of ['x', 'y', 'z'] as const) {
      const before = motion.velocity[axis];
      motion.velocity[axis] += change[axis] * fraction;
      next[axis] = drone[axis] + (before + motion.velocity[axis]) * dt / 2;
    }
    const remaining = target ? Math.hypot(target.x - next.x, target.y - next.y, target.z - next.z) : Infinity;
    // The entire final displacement must fit the low-speed arrival allowance,
    // including any correction to the exact target. A fixed-distance snap can
    // exceed the service speed at small physics timesteps.
    const arrived = !blocked && remaining < 0.004 && length(motion.velocity) < 0.04 && distance <= 0.04 * dt;
    if (arrived) { Object.assign(next, target); motion.velocity = zero(); }
    return { next, arrived, ...(blocked ? { blocked } : {}) };
  }

  private clearance(drone: Drone, direction: Vector, observation: MotionObservation):
    { distance: number; obstructed: boolean; reason?: MotionBlockReason } {
    const sample = observation.ranges;
    const failure = (reason: MotionBlockReason) => ({ distance: 0, obstructed: false, reason });
    if (!sample) return failure('sensor-unavailable');
    if (!rangeSampleFresh(sample, observation.nowMs)) return failure('sensor-stale');
    const offset = { x: drone.x - sample.origin.x, y: drone.y - sample.origin.y, z: drone.z - sample.origin.z };
    let best = -1, obstructed = false, usable = false;
    for (const reading of sample.proximity) {
      if (reading.validity === 'unavailable') continue;
      if (reading.coverage.shape !== 'swept-sphere' || !Number.isFinite(reading.coverage.radius)
        || reading.coverage.radius < LOCAL_SENSOR_CONFIG.vehicleRadius
        || !Number.isFinite(reading.coverage.maxDistance) || reading.coverage.maxDistance <= 0) continue;
      if (reading.validity === 'valid' && (reading.distance === null || !Number.isFinite(reading.distance) || reading.distance < 0)) continue;
      usable = true;
      const beam = reading.direction;
      if (Math.abs(length(beam) - 1) > 1e-6) continue;
      const cosine = direction.x * beam.x + direction.y * beam.y + direction.z * beam.z;
      if (cosine <= 0) continue;
      const axial = offset.x * beam.x + offset.y * beam.y + offset.z * beam.z;
      if (axial < -1e-6) continue;
      const offAxis = Math.hypot(offset.x - axial * beam.x, offset.y - axial * beam.y, offset.z - axial * beam.z);
      const radius = reading.coverage.radius - LOCAL_SENSOR_CONFIG.vehicleRadius - offAxis;
      if (radius < 0) continue;
      const sine = Math.sqrt(Math.max(0, 1 - Math.min(1, cosine) ** 2));
      const radialLimit = sine > 1e-6 ? radius / sine : Infinity;
      const measured = reading.validity === 'valid' ? Math.min(reading.distance!, reading.coverage.maxDistance) : reading.coverage.maxDistance;
      const axialLimit = Math.max(0, measured - axial) / cosine;
      const available = Math.min(radialLimit, axialLimit);
      if (available > best) { best = available; obstructed = reading.validity === 'valid' && axialLimit <= radialLimit + 1e-6; }
    }
    return best < 0 ? failure(usable ? 'coverage-unavailable' : 'sensor-unavailable') : { distance: best, obstructed };
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
