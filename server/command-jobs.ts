import { randomUUID } from 'node:crypto';
import type { DroneId, Drone } from '../shared/types.ts';
import type { Point } from '../shared/rts.ts';
import { ONBOARD_PROFILE, type DroneJob, type MovementProfile, type ObservationOrigin } from '../shared/onboard.ts';

interface ActiveRoute { job: DroneJob; points: Point[]; profile: MovementProfile; pending: boolean; leaseUntil: number; owner: string }
interface JobHost {
  drone(id: DroneId): Drone;
  validate(id: DroneId, mission: number): void;
  waypoint(id: DroneId, target: Point, profile: MovementProfile, owner: string, valid: () => boolean): Promise<void>;
  hold(id: DroneId): void;
  event(id: DroneId, job: DroneJob): void;
}

/** One vehicle writer. The live local controller renews leases; inference does not. */
export class CommandJobs {
  private routes = new Map<DroneId, ActiveRoute>();
  private last = new Map<DroneId, DroneJob>();
  constructor(private readonly host: JobHost) {}

  validateWaypoints(waypoints: unknown, profile?: MovementProfile): Point[] {
    if (!Array.isArray(waypoints) || !waypoints.length || waypoints.length > ONBOARD_PROFILE.maxRouteSteps) throw new Error('Route requires 1–32 waypoints');
    const points = waypoints.map(point => {
      if (!point || typeof point !== 'object' || !['x', 'y', 'z'].every(axis => typeof point[axis] === 'number' && Number.isFinite(point[axis]))) throw new Error('Each waypoint requires finite x/y/z');
      return { x: point.x, y: point.y, z: point.z } as Point;
    });
    if (profile && !['travel', 'precision'].includes(profile)) throw new Error('Unknown movement profile');
    return points;
  }

  start(id: DroneId, mission: number, waypoints: unknown, options: {
    replace?: boolean; profile?: MovementProfile; origin?: ObservationOrigin; owner?: string; kind?: 'movement' | 'route';
  } = {}) {
    this.host.validate(id, mission);
    const points = this.validateWaypoints(waypoints, options.profile);
    const current = this.routes.get(id);
    if (current && !options.replace) throw new Error('Movement writer is occupied; explicitly replace or cancel it');
    if (current) this.cancel(id, 'replaced');
    const job: DroneJob = { id: randomUUID(), kind: options.kind ?? 'route', state: 'accepted', mission,
      step: 0, totalSteps: points.length, origin: options.origin, startedAt: performance.now(), updatedAt: performance.now() };
    const route: ActiveRoute = { job, points, profile: options.profile ?? 'travel', pending: false,
      leaseUntil: 0, owner: options.owner ?? job.id };
    this.routes.set(id, route); this.publish(id, route);
    // Admission is independent of a MAVLink round trip or camera capture.
    queueMicrotask(() => { void this.advance(id, route); });
    return structuredClone(job);
  }

  status(id: DroneId, jobId?: string) {
    const job = this.last.get(id);
    if (jobId && job?.id !== jobId) throw new Error('Job is no longer retained');
    return job ? structuredClone(job) : null;
  }
  owner(id: DroneId) { return this.routes.get(id)?.owner; }
  active(id: DroneId) { return this.routes.has(id); }
  valid(id: DroneId, owner: string) { return this.routes.get(id)?.owner === owner; }

  cancel(id: DroneId, reason: string, state: 'cancelled' | 'blocked' | 'failed' = 'cancelled') {
    const route = this.routes.get(id);
    if (!route) return this.status(id);
    this.routes.delete(id); this.host.hold(id);
    route.job.state = state; route.job.reason = reason; this.publish(id, route);
    return structuredClone(route.job);
  }
  cancelAll(reason: string) { for (const id of [...this.routes.keys()]) this.cancel(id, reason); }
  reset() { this.cancelAll('new-match'); this.last.clear(); }

  arrived(id: DroneId) {
    const route = this.routes.get(id);
    if (!route || route.pending || route.job.state !== 'running') return;
    route.job.step = (route.job.step ?? 0) + 1;
    if (route.job.step >= route.points.length) {
      this.routes.delete(id); route.job.state = 'completed'; this.publish(id, route);
    } else { route.job.state = 'accepted'; void this.advance(id, route); }
  }

  tick(id: DroneId, now = performance.now()) {
    const route = this.routes.get(id);
    if (!route) return;
    try { this.host.validate(id, route.job.mission); }
    catch (error) { this.cancel(id, String(error)); return; }
    if (route.pending || route.job.state !== 'running') return;
    if (now > route.leaseUntil) { this.cancel(id, 'controller-lease-expired', 'blocked'); return; }
    route.leaseUntil = now + ONBOARD_PROFILE.velocityLeaseMs;
  }

  private async advance(id: DroneId, route: ActiveRoute) {
    if (this.routes.get(id) !== route || route.pending) return;
    const valid = () => this.routes.get(id) === route;
    route.pending = true;
    try {
      this.host.validate(id, route.job.mission);
      await this.host.waypoint(id, route.points[route.job.step ?? 0], route.profile, route.owner, valid);
      if (!valid()) return;
      this.host.validate(id, route.job.mission);
      route.job.state = 'running'; route.leaseUntil = performance.now() + ONBOARD_PROFILE.velocityLeaseMs;
      this.publish(id, route);
    } catch (error) { if (valid()) this.cancel(id, error instanceof Error ? error.message : String(error), 'failed'); }
    finally { route.pending = false; }
  }

  private publish(id: DroneId, route: ActiveRoute) {
    route.job.updatedAt = performance.now();
    this.host.drone(id).job = structuredClone(route.job);
    this.last.set(id, structuredClone(route.job));
    this.host.event(id, structuredClone(route.job));
  }
}
