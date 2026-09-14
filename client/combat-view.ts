import * as THREE from 'three';
import { resourceZoneSize, serviceZoneSize, type MatchState, type ResourceNode, type ServicePad } from '../shared/rts';
import { disposeGroup } from './city-scene';

/** Visible interaction volume, grounded at the bottom-face center. */
function zoneCube(id: string, x: number, y: number, z: number, size: number, color: string) {
  const group = new THREE.Group(); group.name = id; group.position.set(x, y, z);
  const geometry = new THREE.BoxGeometry(size, size, size);
  const surface = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthTest: true, depthWrite: false }));
  surface.name = 'zone-volume'; surface.position.y = size / 2; group.add(surface);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.65, depthTest: true, depthWrite: false }));
  edges.name = 'zone-edges'; edges.position.y = size / 2; group.add(edges);
  return group;
}

function resourceProp(node: ResourceNode) {
  return node.zoneSize === undefined ? legacyResourceProp(node) : zoneCube(node.id, node.x, node.y, node.z, resourceZoneSize(node), '#ffe05c');
}

function legacyResourceProp(node: ResourceNode) {
  const group = new THREE.Group(); group.name = node.id; group.position.set(node.x, node.y, node.z);
  const rich = (node.extractionMultiplier ?? 1) > 1;
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
  if (rich) {
    // More stock and reinforced feet distinguish the contested deposit through
    // camera pixels without enlarging its footprint beyond mining reach.
    for (const x of [-0.86, 0.86]) for (const z of [-0.86, 0.86]) {
      const stack = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.62, 0.38), gold); stack.position.set(x, 0.27, z); stock.add(stack);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.16, 0.44), steel); foot.position.set(x, -0.22, z); group.add(foot);
    }
    const rim = new THREE.Mesh(new THREE.TorusGeometry(1.13, 0.075, 5, 8), gold); rim.rotation.x = Math.PI / 2; rim.position.y = -0.09; group.add(rim);
  }
  return group;
}

function servicePadProp(pad: ServicePad) {
  if (pad.zoneSize !== undefined) return zoneCube(pad.id, pad.x, pad.y, pad.z, serviceZoneSize(pad), pad.team === 'blue' ? '#69d9ef' : '#fa846e');
  const group = new THREE.Group(); group.name = pad.id; group.position.set(pad.x, pad.y, pad.z);
  const surface = new THREE.MeshLambertMaterial({ color: '#263943' });
  const marking = new THREE.MeshLambertMaterial({ color: pad.team === 'blue' ? '#69d9ef' : '#fa846e', emissive: pad.team === 'blue' ? '#165568' : '#682b23', emissiveIntensity: 0.3 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(2.35, 2.4, 0.08, 24), surface); base.position.y = -0.04; group.add(base);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(2.16, 0.07, 5, 24), marking); rim.rotation.x = Math.PI / 2; rim.position.y = 0.02; group.add(rim);
  // Painted H and perimeter are ordinary geometry below the hovering drones;
  // there is no floating location, radius or refit-progress label in sensors.
  for (const x of [-0.48, 0.48]) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.02, 1.5), marking); stripe.position.set(x, 0.015, 0); group.add(stripe);
  }
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.02, 0.18), marking); bridge.position.y = 0.015; group.add(bridge);
  return group;
}

/** Physical resource and bullet geometry shared by spectator and optical render passes. */
export class CombatView {
  private resources = new THREE.Group();
  private projectiles = new THREE.Group();
  private servicePads = new THREE.Group();
  private resourceMeshes = new Map<string, THREE.Group>();
  private signature = '';
  private padSignature = '';
  private current?: MatchState;

  constructor(private scene: THREE.Scene) { scene.add(this.resources, this.projectiles, this.servicePads); }

  update(match?: MatchState) {
    this.current = match;
    const signature = JSON.stringify(match?.resources.map(({ id, x, y, z, extractionMultiplier, zoneSize }) => [id, x, y, z, extractionMultiplier, zoneSize]) ?? []);
    if (signature !== this.signature) {
      this.signature = signature; disposeGroup(this.resources); this.resourceMeshes.clear();
      for (const node of match?.resources ?? []) { const mesh = resourceProp(node); this.resourceMeshes.set(node.id, mesh); this.resources.add(mesh); }
    }
    const padSignature = JSON.stringify(match?.servicePads ?? []);
    if (padSignature !== this.padSignature) {
      this.padSignature = padSignature; disposeGroup(this.servicePads);
      for (const pad of match?.servicePads ?? []) this.servicePads.add(servicePadProp(pad));
    }
    for (const node of match?.resources ?? []) {
      const mesh = this.resourceMeshes.get(node.id);
      if (mesh) mesh.visible = node.zoneSize === undefined || node.remaining > 0;
      const stock = mesh?.getObjectByName('stock');
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

  dispose() { disposeGroup(this.resources); disposeGroup(this.projectiles); disposeGroup(this.servicePads); this.scene.remove(this.resources, this.projectiles, this.servicePads); this.resourceMeshes.clear(); }
}
