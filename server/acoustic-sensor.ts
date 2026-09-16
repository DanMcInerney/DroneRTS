import type { Drone, DroneId, Obstacle } from '../shared/types.ts';
import type { Point } from '../shared/rts.ts';
import { ACOUSTIC_PROFILE as P } from '../shared/acoustic-profile.ts';
import { boxContact, distance } from './rts-geometry.ts';

export type AcousticMeasurement = { type: 'acoustic_impulse'; sensorProfile: 'acoustic/1'; simTime: number;
  acquiredAtMs: number; occurredAt: string; possibleShot: boolean; uncertain: true };
type Stimulus = { position: Point; emitted: number; tested: Set<DroneId> };

/** Private world stimuli become local measurements only after finite propagation,
 * attenuation, obstruction and noise. No source identity/position crosses emit. */
export class AcousticSensor {
  private stimuli: Stimulus[] = [];
  private lastTime?: number;
  readonly metrics = { evaluations: 0, detections: 0, ambientDetections: 0, saturated: 0, cpuMs: 0, highWaterStimuli: 0 };
  constructor(private readonly emit: (id: DroneId, measurement: AcousticMeasurement) => void, private readonly random: () => number = Math.random) {}
  impulse(position: Point, simTime: number) {
    if (this.stimuli.length >= P.maxStimuli) { this.metrics.saturated++; return; }
    this.stimuli.push({ position: { ...position }, emitted: simTime, tested: new Set() });
    this.metrics.highWaterStimuli = Math.max(this.metrics.highWaterStimuli, this.stimuli.length);
  }
  clear() { this.stimuli = []; this.lastTime = undefined; for (const key of Object.keys(this.metrics) as Array<keyof typeof this.metrics>) this.metrics[key] = 0; }
  tick(simTime: number, drones: readonly Drone[], obstacles: readonly Obstacle[]) {
    const started = performance.now(), dt = this.lastTime === undefined ? 0 : Math.max(0, simTime - this.lastTime); this.lastTime = simTime;
    for (const drone of drones) {
      if (drone.alive === false) continue;
      for (const stimulus of this.stimuli) {
        if (stimulus.tested.has(drone.id)) continue;
        const meters = distance(stimulus.position, drone) * 10;
        const radius = (simTime - stimulus.emitted) * P.propagationMetersPerSecond;
        if (meters > P.maxDistanceMeters || meters > radius) continue;
        stimulus.tested.add(drone.id); this.metrics.evaluations++;
        // Simplified straight-path absorption; no echoes, diffraction or bearing estimator.
        const blocked = obstacles.some(box => boxContact(stimulus.position, drone, box, 0) !== undefined);
        const level = (blocked ? P.obstructionTransmission : 1) / (1 + (meters / 40) ** 2)
          + (this.random() - 0.5) * 2 * P.noiseAmplitude;
        if (this.random() < P.missProbability || level < P.sensitivity) continue;
        this.measure(drone.id, simTime, level >= P.possibleShotThreshold);
      }
      // Local urban/mechanical impulse noise can also produce possible-shot measurements.
      if (dt > 0 && this.random() < -Math.expm1(-P.ambientImpulsesPerSecond * dt)) {
        this.metrics.ambientDetections++; this.measure(drone.id, simTime, this.random() < 0.25);
      }
    }
    this.stimuli = this.stimuli.filter(stimulus => simTime - stimulus.emitted <= P.maxDistanceMeters / P.propagationMetersPerSecond);
    this.metrics.cpuMs += performance.now() - started;
  }
  private measure(id: DroneId, simTime: number, possibleShot: boolean) {
    this.metrics.detections++;
    this.emit(id, { type: 'acoustic_impulse', sensorProfile: P.version, simTime, acquiredAtMs: performance.now(), occurredAt: new Date().toISOString(), possibleShot, uncertain: true });
  }
}
