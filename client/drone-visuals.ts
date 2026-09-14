import * as THREE from 'three';
import type { Drone } from './types';
import { disposeGroup } from './city-scene';
import { makeDrone, positionDrone as position } from './drone-model';

/** Owns drone mesh identity, lifetime and temporary sensor-snapshot overrides. */
export class DroneVisuals {
  private meshes = new Map<string, THREE.Group>();
  constructor(private scene: THREE.Scene) {}

  reconcile(drones: readonly Drone[]) {
    const ids = new Set<string>(drones.map(drone => drone.id));
    for (const [id, mesh] of this.meshes) if (!ids.has(id)) {
      this.scene.remove(mesh); disposeGroup(mesh); this.meshes.delete(id);
    }
    for (const drone of drones) if (!this.meshes.has(drone.id)) {
      const mesh = makeDrone(drone.id); this.meshes.set(drone.id, mesh); this.scene.add(mesh);
    }
    this.pose(drones);
  }

  pose(drones: readonly Drone[]) {
    for (const drone of drones) {
      const mesh = this.meshes.get(drone.id);
      if (mesh) position(mesh, drone);
    }
  }

  hideObserver(id?: string) { this.meshes.forEach((mesh, droneId) => { mesh.visible = droneId !== id; }); }

  withSnapshot<T>(observer: string, drones: readonly Drone[], render: () => T): T {
    const saved = [...this.meshes.values()].map(mesh => ({ mesh, drone: mesh.userData.drone as Drone, visible: mesh.visible }));
    const temporary: THREE.Group[] = [];
    this.meshes.forEach(mesh => { mesh.visible = false; });
    try {
      for (const drone of drones) {
        let mesh = this.meshes.get(drone.id);
        if (!mesh) { mesh = makeDrone(drone.id); temporary.push(mesh); this.scene.add(mesh); }
        position(mesh, drone); mesh.visible = drone.id !== observer;
      }
      return render();
    } finally {
      for (const mesh of temporary) { this.scene.remove(mesh); disposeGroup(mesh); }
      for (const item of saved) {
        position(item.mesh, item.drone); item.mesh.visible = item.visible;
      }
    }
  }

  dispose() { this.reconcile([]); }
}
