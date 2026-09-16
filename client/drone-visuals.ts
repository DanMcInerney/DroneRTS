import * as THREE from 'three';
import type { Drone } from './types';
import { disposeGroup } from './city-scene';
import { makeDrone, positionDrone as position } from './drone-model';
import { updateNavigationLights } from './navigation-lights';

const visibleTo = (drone: Drone, observer?: string) => drone.alive !== false && drone.id !== observer;

/** Owns drone mesh identity, lifetime and temporary sensor-snapshot overrides. */
export class DroneVisuals {
  private meshes = new Map<string, THREE.Group>();
  private lightTime = 0;
  private flashing = true;
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

  pose(drones: readonly Drone[], time = this.lightTime, flashing = this.flashing) {
    this.lightTime = time; this.flashing = flashing;
    for (const drone of drones) {
      const mesh = this.meshes.get(drone.id);
      if (mesh) { position(mesh, drone); mesh.visible = visibleTo(drone); updateNavigationLights(mesh, time, flashing); }
    }
  }

  hideObserver(id?: string) {
    this.meshes.forEach(mesh => { mesh.visible = visibleTo(mesh.userData.drone as Drone, id); });
  }

  withSnapshot<T>(observer: string, drones: readonly Drone[], render: () => T, time = this.lightTime, flashing = this.flashing): T {
    const saved = [...this.meshes.values()].map(mesh => ({ mesh, drone: mesh.userData.drone as Drone, visible: mesh.visible }));
    const temporary: THREE.Group[] = [];
    this.meshes.forEach(mesh => { mesh.visible = false; });
    try {
      for (const drone of drones) {
        let mesh = this.meshes.get(drone.id);
        if (!mesh) { mesh = makeDrone(drone.id); temporary.push(mesh); this.scene.add(mesh); }
        position(mesh, drone); mesh.visible = visibleTo(drone, observer); updateNavigationLights(mesh, time, flashing);
      }
      return render();
    } finally {
      for (const mesh of temporary) { this.scene.remove(mesh); disposeGroup(mesh); }
      for (const item of saved) {
        position(item.mesh, item.drone); item.mesh.visible = item.visible; updateNavigationLights(item.mesh, this.lightTime, this.flashing);
      }
    }
  }

  dispose() { this.reconcile([]); }
}
