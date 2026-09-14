import type { DroneId, Obstacle, Pose } from '../shared/types.ts';
import type { ResourceNode } from '../shared/rts.ts';
import { DRONE_CAMERA } from '../shared/camera-profile.ts';
import { intersectsBuilding } from './world-geometry.ts';

/** Private evidence of an actually delivered image; never a locator tool. */
export class ResourceVision {
  private sightings = new Map<DroneId, { ids: string[]; mission: number; simTime: number }>();
  clear() { this.sightings.clear(); }
  forget(id: DroneId) { this.sightings.delete(id); }
  record(id: DroneId, pose: Pose, mission: number, simTime: number, image: boolean, resources: readonly ResourceNode[], buildings: readonly Obstacle[]) {
    const yaw = pose.yaw * Math.PI / 180, pitch = pose.pitch * Math.PI / 180;
    const forward = { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
    const right = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
    const up = { x: Math.sin(yaw) * Math.sin(pitch), y: Math.cos(pitch), z: Math.cos(yaw) * Math.sin(pitch) };
    const distance = (node: ResourceNode) => Math.hypot(node.x - pose.x, node.y + 0.65 - pose.y, node.z - pose.z);
    const visible = resources.filter(node => {
      if (!image || node.remaining <= 0 || distance(node) > 20) return false;
      const focus = { x: node.x, y: node.y + 0.65, z: node.z };
      const delta = { x: focus.x - pose.x, y: focus.y - pose.y, z: focus.z - pose.z };
      const dot = (v: typeof delta) => v.x * delta.x + v.y * delta.y + v.z * delta.z;
      const depth = dot(forward), vertical = Math.tan(DRONE_CAMERA.fov * Math.PI / 360) * 0.92;
      return depth > 0.1 && Math.abs(dot(up)) < depth * vertical
        && Math.abs(dot(right)) < depth * vertical * DRONE_CAMERA.width / DRONE_CAMERA.height
        && !buildings.some(building => intersectsBuilding(pose, focus, building));
    }).sort((a, b) => distance(a) - distance(b));
    this.sightings.set(id, { ids: visible.map(node => node.id), mission, simTime });
  }
  select(id: DroneId, mission: number, simTime: number): string | undefined {
    const evidence = this.sightings.get(id);
    return evidence && evidence.mission === mission && simTime - evidence.simTime <= 15 ? evidence.ids[0] : undefined;
  }
}
