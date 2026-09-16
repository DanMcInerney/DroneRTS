import { RTS_CONFIG, type MatchEvent, type MatchState, type Point } from '../shared/rts';

/** Scene-only smoke; flight, impacts, ammunition and actor telemetry are unchanged. */
export const PROJECTILE_SMOKE = Object.freeze({ lifetime: 5.6, interval: .04, maxTrails: 72, segmentsPerTrail: 100 });
export interface ProjectileTrail { id: string; origin: Point; velocity: Point; startedAt: number; endedAt: number }
export interface TrailSegment { start: Point; end: Point; radius: number; opacity: number; seed: number }
const point = (value: Partial<Point>): value is Point => [value.x, value.y, value.z].every(Number.isFinite);

/** Recover the short ballistic arc between recorded endpoints, never beyond contact.
 * The other mathematical solution takes over twenty seconds and cannot be a
 * four-second simulator projectile. The stable root also handles very close hits.
 */
function completedTrail(fired: MatchEvent, ended: MatchEvent): ProjectileTrail | undefined {
  if (!point(fired) || !point(ended) || !fired.projectileId) return;
  const x = ended.x - fired.x, y = ended.y - fired.y, z = ended.z - fired.z;
  const distanceSquared = x * x + y * y + z * z, gravity = RTS_CONFIG.bulletGravity;
  const a = RTS_CONFIG.bulletSpeed ** 2 - gravity * y;
  const discriminant = a * a - gravity * gravity * distanceSquared;
  if (distanceSquared <= 1e-12 || discriminant < 0) return;
  const duration = Math.sqrt(2 * distanceSquared / (a + Math.sqrt(discriminant)));
  if (!Number.isFinite(duration) || duration > RTS_CONFIG.bulletLifetime + 1e-6 || fired.simTime + duration > ended.simTime + 1e-4) return;
  return {
    id: fired.projectileId, origin: { x: fired.x, y: fired.y, z: fired.z },
    velocity: { x: x / duration, y: y / duration + gravity * duration / 2, z: z / duration },
    startedAt: fired.simTime, endedAt: fired.simTime + duration,
  };
}

/** A pure function of this acquisition's bounded event slice and active bullets.
 * Missing history produces no invented path; no live cache can leak newer shots
 * into delayed camera captures. Impact chord error remains below 0.000021 units.
 */
export function projectileTrails(match: MatchState | undefined, snapshotTime: number): ProjectileTrail[] {
  if (match?.rulesVersion !== 'cargo-v3' || !Number.isFinite(snapshotTime)) return [];
  const fired = new Map<string, MatchEvent>(), ended = new Map<string, MatchEvent>();
  for (const event of match.events) {
    if (!event.projectileId) continue;
    if (event.type === 'fired') fired.set(event.projectileId, event);
    if (event.simTime <= snapshotTime && (event.type === 'impact' || event.type === 'projectile_expired')) ended.set(event.projectileId, event);
  }
  const trails = new Map<string, ProjectileTrail>();
  for (const bullet of match.projectiles) {
    if (![bullet.x, bullet.y, bullet.z, bullet.vx, bullet.vy, bullet.vz, bullet.age].every(Number.isFinite)
      || bullet.age < 0 || bullet.age > RTS_CONFIG.bulletLifetime + 1e-6) continue;
    const launch = fired.get(bullet.id), age = bullet.age, gravity = RTS_CONFIG.bulletGravity;
    if (launch && launch.simTime > snapshotTime) continue;
    const startedAt = launch?.simTime ?? snapshotTime - age;
    const origin = launch && point(launch) ? { x: launch.x, y: launch.y, z: launch.z } : {
      x: bullet.x - bullet.vx * age, y: bullet.y - bullet.vy * age - gravity * age * age / 2, z: bullet.z - bullet.vz * age,
    };
    trails.set(bullet.id, {
      id: bullet.id, origin, velocity: { x: bullet.vx, y: bullet.vy + gravity * age, z: bullet.vz },
      startedAt, endedAt: Math.min(snapshotTime, startedAt + age),
    });
  }
  for (const [id, end] of ended) {
    const start = fired.get(id), trail = start && completedTrail(start, end);
    if (trail) trails.set(id, trail);
  }
  return [...trails.values()].filter(trail => trail.startedAt <= snapshotTime && trail.endedAt + PROJECTILE_SMOKE.lifetime > snapshotTime)
    .sort((a, b) => b.endedAt - a.endedAt || a.id.localeCompare(b.id)).slice(0, PROJECTILE_SMOKE.maxTrails);
}

function hash(id: string) {
  let value = 2166136261;
  for (const letter of id) value = Math.imul(value ^ letter.charCodeAt(0), 16777619);
  return (value >>> 0) / 4294967296;
}

/** Soft connected segments follow only the travelled arc, then spread and rise. */
export function projectileSmoke(trail: ProjectileTrail, time: number): TrailSegment[] {
  const { interval, lifetime, segmentsPerTrail } = PROJECTILE_SMOKE;
  const end = Math.min(time, trail.endedAt), first = Math.max(0, Math.floor((time - lifetime - trail.startedAt) / interval));
  const last = Math.min(segmentsPerTrail, Math.ceil((end - trail.startedAt) / interval));
  const seed = hash(trail.id), segments: TrailSegment[] = [];
  const at = (emittedAt: number): Point => {
    const t = emittedAt - trail.startedAt, age = Math.max(0, time - emittedAt);
    const curl = Math.sin(t * 13 + seed * 17) * age * .014;
    return {
      x: trail.origin.x + trail.velocity.x * t + age * .026 + curl,
      y: trail.origin.y + trail.velocity.y * t - RTS_CONFIG.bulletGravity * t * t / 2 + age * .033,
      z: trail.origin.z + trail.velocity.z * t + age * .013 - curl,
    };
  };
  for (let index = first; index < last; index++) {
    const start = trail.startedAt + index * interval, finish = Math.min(end, start + interval);
    const age = Math.max(0, time - (start + finish) / 2);
    if (finish <= start || age >= lifetime) continue;
    segments.push({ start: at(start), end: at(finish), radius: .045 + age * .057,
      opacity: .46 * (1 - age / lifetime) ** 1.5, seed: seed * 20 + index * .73 });
  }
  return segments;
}
