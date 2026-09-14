import type { Obstacle, Pose, Treasure } from '../shared/types.ts';

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

// Private scoring calibration matches the optical camera; it is never a sensor/tool field.
export function visibleTreasures(pose: Pose, treasures: Treasure[], buildings: Obstacle[]): string[] {
  const yaw = radians(pose.yaw), pitch = radians(pose.pitch);
  const forward = { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
  const right = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
  const up = { x: Math.sin(yaw) * Math.sin(pitch), y: Math.cos(pitch), z: Math.cos(yaw) * Math.sin(pitch) };
  const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y + a.z * b.z;
  return treasures.filter(chest => {
    const target = { x: chest.x, y: chest.y + 0.55, z: chest.z };
    const delta = { x: target.x - pose.x, y: target.y - pose.y, z: target.z - pose.z };
    const depth = dot(delta, forward), vertical = Math.tan(radians(76 / 2));
    return !chest.found && Math.hypot(delta.x, delta.y, delta.z) <= 5.5 && depth > 0.1
      && Math.abs(dot(delta, up)) < depth * vertical * 0.92
      && Math.abs(dot(delta, right)) < depth * vertical * (512 / 288) * 0.92
      && !buildings.some(building => intersectsBuilding(pose, target, building));
  }).sort((a, b) => Math.hypot(a.x - pose.x, a.y + 0.55 - pose.y, a.z - pose.z)
    - Math.hypot(b.x - pose.x, b.y + 0.55 - pose.y, b.z - pose.z)).map(chest => chest.id);
}
