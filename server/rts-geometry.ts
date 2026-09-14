import type { Obstacle } from '../shared/types.ts';
import type { Point } from '../shared/rts.ts';

export const at = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
});
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const subtract = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const unit = (p: Point): Point => {
  const length = Math.hypot(p.x, p.y, p.z);
  return length > 1e-9 ? { x: p.x / length, y: p.y / length, z: p.z / length } : { x: 1, y: 0, z: 0 };
};
export const offset = (p: Point, normal: Point, amount: number): Point => ({
  x: p.x + normal.x * amount, y: p.y + normal.y * amount, z: p.z + normal.z * amount,
});

/** First contact of two linearly moving spheres, including tangential/high-speed contacts. */
export function sphereContact(a0: Point, a1: Point, b0: Point, b1: Point, radius: number): number | undefined {
  const p = subtract(a0, b0), v = subtract(subtract(a1, a0), subtract(b1, b0));
  const c = p.x * p.x + p.y * p.y + p.z * p.z - radius * radius;
  if (c <= 1e-10) return 0;
  const a = v.x * v.x + v.y * v.y + v.z * v.z;
  if (a < 1e-14) return;
  const b = 2 * (p.x * v.x + p.y * v.y + p.z * v.z), discriminant = b * b - 4 * a * c;
  if (discriminant < -1e-10) return;
  const t = (-b - Math.sqrt(Math.max(0, discriminant))) / (2 * a);
  if (t >= -1e-9 && t <= 1 + 1e-9) return Math.max(0, Math.min(1, t));
}

export interface SurfaceHit { t: number; normal: Point; contact: Point }

/** Swept padded OBB contact, with a world-space surface normal for armor deflection. */
export function boxContact(from: Point, to: Point, box: Obstacle, margin: number): SurfaceHit | undefined {
  const angle = (box.rotation ?? 0) * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  const local = (p: Point): Point => ({ x: c * (p.x - box.x) - s * (p.z - box.z),
    y: p.y - (box.baseY ?? 0) - box.height / 2, z: s * (p.x - box.x) + c * (p.z - box.z) });
  const worldNormal = (p: Point): Point => ({ x: c * p.x + s * p.z, y: p.y, z: -s * p.x + c * p.z });
  const a = local(from), b = local(to), half = { x: box.width / 2 + margin, y: box.height / 2 + margin, z: box.depth / 2 + margin };
  let enter = 0, leave = 1, normal: Point = { x: 0, y: 0, z: 0 };
  for (const axis of ['x', 'y', 'z'] as const) {
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < 1e-12) { if (Math.abs(a[axis]) > half[axis]) return; continue; }
    const first = (-half[axis] - a[axis]) / delta, second = (half[axis] - a[axis]) / delta;
    const near = Math.min(first, second), far = Math.max(first, second);
    if (near > enter) { enter = near; normal = { x: 0, y: 0, z: 0 }; normal[axis] = delta > 0 ? -1 : 1; }
    leave = Math.min(leave, far);
    if (enter > leave) return;
  }
  if (leave < 0 || enter > 1) return;
  if (enter === 0) {
    // A restored/overlapping pose exits through its closest face, never deeper into a building.
    const axis = (['x', 'y', 'z'] as const).reduce((best, key) => half[key] - Math.abs(a[key]) < half[best] - Math.abs(a[best]) ? key : best, 'x');
    normal = { x: 0, y: 0, z: 0 }; normal[axis] = a[axis] >= 0 ? 1 : -1;
    const direction = worldNormal(normal);
    return { t: 0, normal: direction, contact: offset(from, direction, Math.max(0, half[axis] - Math.abs(a[axis]))) };
  }
  return { t: enter, normal: worldNormal(normal), contact: at(from, to, enter) };
}

export function terrainContact(from: Point, to: Point, obstacles: readonly Obstacle[], radius: number): SurfaceHit | undefined {
  let hit: SurfaceHit | undefined;
  if (from.y <= radius || to.y <= radius) {
    const t = from.y <= radius ? 0 : (from.y - radius) / (from.y - to.y);
    hit = { t, normal: { x: 0, y: 1, z: 0 }, contact: { ...at(from, to, t), y: radius } };
  }
  for (const building of obstacles) {
    const candidate = boxContact(from, to, building, radius);
    if (candidate && (!hit || candidate.t < hit.t - 1e-9)) hit = candidate;
    else if (candidate && hit && Math.abs(candidate.t - hit.t) <= 1e-9) {
      // A corner can contact two walls (or wall and ground) at once. Its escape
      // normal must clear both surfaces so consumed armor does not immediately re-hit.
      const normal = unit(offset(hit.normal, candidate.normal, 1));
      const delta = subtract(candidate.contact, hit.contact);
      const penetration = delta.x * candidate.normal.x + delta.y * candidate.normal.y + delta.z * candidate.normal.z;
      hit = { ...hit, normal, contact: offset(hit.contact, candidate.normal, Math.max(0, penetration)) };
    }
  }
  return hit;
}
