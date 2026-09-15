import * as THREE from 'three';
import type { MatchState } from '../shared/rts';
import { disposeGroup } from './city-scene';
import { createCargoProp, updateCargoProp } from './cargo-prop';

/** Physical resource and bullet geometry shared by spectator and optical render passes. */
export class CombatView {
  private resources = new THREE.Group();
  private projectiles = new THREE.Group();
  private resourceMeshes = new Map<string, THREE.Group>();
  private signature = '';
  private current?: MatchState;

  constructor(private scene: THREE.Scene) { scene.add(this.resources, this.projectiles); }

  update(match?: MatchState) {
    this.current = match;
    const signature = JSON.stringify(match?.resources.map(({ id, x, y, z, capacity }) => [id, x, y, z, capacity]) ?? []);
    if (signature !== this.signature) {
      this.signature = signature; disposeGroup(this.resources); this.resourceMeshes.clear();
      for (const node of match?.resources ?? []) { const mesh = createCargoProp(node); this.resourceMeshes.set(node.id, mesh); this.resources.add(mesh); }
    }
    for (const node of match?.resources ?? []) {
      const mesh = this.resourceMeshes.get(node.id);
      if (mesh) updateCargoProp(mesh, node);
    }
    disposeGroup(this.projectiles);
    for (const shot of match?.projectiles ?? []) {
      const material = new THREE.MeshBasicMaterial({ color: shot.team === 'blue' ? '#c1f7ff' : '#ffbb8e' });
      const bullet = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 4), material); bullet.position.set(shot.x, shot.y, shot.z);
      const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.006, 0.7, 5), material);
      const direction = new THREE.Vector3(shot.vx, shot.vy, shot.vz).normalize(); tail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
      tail.position.copy(bullet.position).addScaledVector(direction, -0.35); this.projectiles.add(bullet, tail);
    }
  }

  withSnapshot<T>(match: MatchState | undefined, render: () => T): T {
    const previous = this.current;
    try { this.update(match); return render(); }
    finally { this.update(previous); }
  }

  dispose() { disposeGroup(this.resources); disposeGroup(this.projectiles); this.scene.remove(this.resources, this.projectiles); this.resourceMeshes.clear(); }
}
