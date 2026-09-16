import * as THREE from 'three';

export type NavigationPattern = 'cargo' | 'base' | 'drone';
type Emitter = { pattern: NavigationPattern; phase: number; halo?: boolean };

/** Deterministic optical animation: acquisition uses its own simulation time. */
export function navigationIntensity(pattern: NavigationPattern, time: number, phase = 0) {
  const cycle = ((Math.max(0, Number.isFinite(time) ? time : 0) + phase) % 2.4) / 2.4;
  const pulse = (center: number, width: number) => Math.max(0, 1 - Math.abs(cycle - center) / width);
  // Slow roof pulses and two separated airframe flashes; never a full-screen strobe.
  return pattern === 'drone' ? Math.max(pulse(0.09, 0.045), pulse(0.29, 0.045))
    : pattern === 'cargo' ? pulse(0.22, 0.12) : pulse(0.25, 0.2);
}

export function navigationPhase(id: string) {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return ((Math.imul(hash, 0x9e3779b1) >>> 0) % 240) / 100;
}

export function bindNavigationMaterial(material: THREE.Material, pattern: NavigationPattern, phase = 0, halo = false) {
  material.userData.navigationEmitter = { pattern, phase, halo } satisfies Emitter;
}

/** Small physical lens, housing and local halo. Ordinary depth/fog apply to all. */
export function navigationBeacon(color: THREE.ColorRepresentation, radius: number, pattern: NavigationPattern, phase = 0) {
  const group = new THREE.Group(); group.name = 'navigation-beacon';
  const housing = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.18, radius * 1.32, radius * 0.3, 12),
    new THREE.MeshStandardMaterial({ color: '#343c40', roughness: 0.62, metalness: 0.5 }));
  housing.position.y = radius * 0.15; group.add(housing);
  const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.3),
    emissive: color, emissiveIntensity: 0.65, roughness: 0.25, metalness: 0.1, toneMapped: false });
  bindNavigationMaterial(material, pattern, phase);
  const lens = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), material);
  lens.name = 'navigation-lens'; lens.scale.y = 0.5; lens.position.y = radius * 0.6; group.add(lens);
  const glowMaterial = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.025,
    depthTest: true, depthWrite: false, toneMapped: false, fog: true });
  bindNavigationMaterial(glowMaterial, pattern, phase, true);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.8, 10, 6), glowMaterial);
  halo.name = 'navigation-halo'; halo.position.copy(lens.position); halo.scale.y = 0.7; group.add(halo);
  return group;
}

/** Two alternating circuits share six draw calls for the entire apron perimeter. */
export function navigationBeaconBank(color: THREE.ColorRepresentation, radius: number, pattern: NavigationPattern,
  phase: number, points: Array<{ x: number; y: number; z: number }>) {
  const group = new THREE.Group(); group.name = 'apron-beacons';
  for (const circuit of [0, 1]) {
    const positions = points.filter((_, index) => index % 2 === circuit);
    const template = navigationBeacon(color, radius, pattern, phase + circuit * 1.2);
    template.updateMatrixWorld(true);
    for (const child of template.children as THREE.Mesh[]) {
      const instances = new THREE.InstancedMesh(child.geometry, child.material, positions.length); instances.name = child.name;
      positions.forEach((point, index) => instances.setMatrixAt(index,
        new THREE.Matrix4().makeTranslation(point.x, point.y, point.z).multiply(child.matrix)));
      group.add(instances);
    }
  }
  return group;
}

/** A capture temporarily overrides time, then each owner restores its display time. */
export function updateNavigationLights(root: THREE.Object3D, time: number, animated = true) {
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of [object.material].flat()) {
      const emitter = material.userData.navigationEmitter as Emitter | undefined;
      if (!emitter) continue;
      const intensity = animated ? navigationIntensity(emitter.pattern, time, emitter.phase) : 0.5;
      if (emitter.halo) material.opacity = 0.018 + intensity * 0.15;
      else if (material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshLambertMaterial) material.emissiveIntensity = 0.6 + intensity * 3.2;
    }
  });
}
