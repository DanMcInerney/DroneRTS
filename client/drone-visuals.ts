import * as THREE from 'three';
import type { Drone } from './types';
import { disposeGroup } from './city-scene';
import { dronePresentation } from './drone-presentation';

function makeDrone(id: string) {
  const group = new THREE.Group();
  group.name = id;
  const material = new THREE.MeshLambertMaterial({ color: dronePresentation(id).color });
  group.add(new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.15, 0.48), material));
  for (const x of [-0.32, 0.32]) for (const z of [-0.28, 0.28]) {
    const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.025, 8), new THREE.MeshLambertMaterial({ color: 0x333e42 }));
    rotor.position.set(x, 0.1, z); group.add(rotor);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.43, 0.055, 0.06), material);
    arm.position.set(x / 2, 0, z / 2); arm.rotation.y = x * z > 0 ? -Math.PI / 4 : Math.PI / 4; group.add(arm);
  }
  return group;
}

function position(mesh: THREE.Group, drone: Drone) {
  mesh.position.set(drone.x, drone.y - 0.14, drone.z);
  mesh.rotation.y = THREE.MathUtils.degToRad(drone.yaw);
}

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
    const saved = [...this.meshes.values()].map(mesh => ({ mesh, position: mesh.position.clone(), rotation: mesh.rotation.clone(), visible: mesh.visible }));
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
        item.mesh.position.copy(item.position); item.mesh.rotation.copy(item.rotation); item.mesh.visible = item.visible;
      }
    }
  }

  dispose() { this.reconcile([]); }
}
