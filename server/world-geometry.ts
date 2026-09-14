import type { Obstacle } from '../shared/types.ts';


type Point = { x: number; y: number; z: number };
const radians = (degrees: number) => degrees * Math.PI / 180;

/** Segment/slab intersection in each building's local frame; also prevents tunnelling. */
export function intersectsBuilding(from: Point, to: Point, box: Obstacle, margin = 0): boolean {
  const angle = radians(box.rotation ?? 0), c = Math.cos(angle), s = Math.sin(angle);
  const local = (p: Point) => ({ x: c * (p.x - box.x) - s * (p.z - box.z),
    y: p.y - (box.baseY ?? 0) - box.height / 2,
    z: s * (p.x - box.x) + c * (p.z - box.z) });
  const a = local(from), b = local(to);
  const half = { x: box.width / 2 + margin, y: box.height / 2 + margin, z: box.depth / 2 + margin };
  let enter = 0, leave = 1;
  for (const axis of ['x', 'y', 'z'] as const) {
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < 1e-9) { if (Math.abs(a[axis]) > half[axis]) return false; continue; }
    const first = (-half[axis] - a[axis]) / delta, last = (half[axis] - a[axis]) / delta;
    enter = Math.max(enter, Math.min(first, last)); leave = Math.min(leave, Math.max(first, last));
    if (enter > leave) return false;
  }
  return leave >= 0 && enter <= 1;
}
