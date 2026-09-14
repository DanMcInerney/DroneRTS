import * as THREE from 'three';
import type { MatchState, ResourceNode } from '../shared/rts';
import { disposeGroup } from './city-scene';

function resourceProp(node: ResourceNode) {
  const group = new THREE.Group(); group.position.set(node.x, node.y, node.z);
  const steel = new THREE.MeshLambertMaterial({ color: '#34474a' });
  const gold = new THREE.MeshLambertMaterial({ color: '#eac257', emissive: '#664412', emissiveIntensity: 0.25 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.12, 1.22, 0.24, 8), steel); base.position.y = -0.27; group.add(base);
  const stock = new THREE.Group(); stock.name = 'stock';
  // Salvage is physical scene geometry. No floating labels or through-wall markers.
  for (let i = 0; i < 7; i++) {
    const angle = i * Math.PI * 2 / 7, radius = i ? 0.56 : 0;
    const ingot = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.7 + (i % 3) * 0.14, 0.38), gold);
    ingot.position.set(Math.sin(angle) * radius, 0.4, Math.cos(angle) * radius); ingot.rotation.set(i * 0.11, angle, (i % 2 ? -1 : 1) * 0.25); stock.add(ingot);
  }
  group.add(stock);
  const braces = new THREE.Mesh(new THREE.TorusGeometry(0.96, 0.055, 5, 8), gold); braces.rotation.x = Math.PI / 2; braces.position.y = -0.08; group.add(braces);
  return group;
}

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
    const signature = JSON.stringify(match?.resources.map(({ id, x, y, z }) => [id, x, y, z]) ?? []);
    if (signature !== this.signature) {
      this.signature = signature; disposeGroup(this.resources); this.resourceMeshes.clear();
      for (const node of match?.resources ?? []) { const mesh = resourceProp(node); this.resourceMeshes.set(node.id, mesh); this.resources.add(mesh); }
    }
    for (const node of match?.resources ?? []) {
      const stock = this.resourceMeshes.get(node.id)?.getObjectByName('stock');
      if (stock) { stock.visible = node.remaining > 0; stock.scale.y = 0.3 + 0.7 * node.remaining / Math.max(1, node.capacity); }
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
