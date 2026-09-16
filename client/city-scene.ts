import * as THREE from 'three';
import { CITY } from '../shared/city';
import type { Obstacle, Treasure } from '../shared/types';
import { graphicsAsset, graphicsCity } from './graphics-assets';
import { createArenaBoundary, isArenaBoundary } from './arena-boundary';
import { createUrbanGround } from './urban-ground';

const radians = THREE.MathUtils.degToRad;
const material = (color: THREE.ColorRepresentation) => new THREE.MeshStandardMaterial({ color, roughness: 0.88 });

function sign(text: string, width: number, color = '#143e43') {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 112;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color; ctx.fillRect(0, 0, 512, 112);
  ctx.strokeStyle = '#b8d6ca'; ctx.lineWidth = 4; ctx.strokeRect(8, 8, 496, 96);
  ctx.fillStyle = '#f6f2dc'; ctx.font = '600 32px Arial';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text.toUpperCase(), 256, 57, 466);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(width, width * 112 / 512), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
}

/** Static city geometry. Building surfaces share exactly the simulator's oriented boxes. */
export function createCity(buildings: Obstacle[]) {
  const group = new THREE.Group();
  group.add(createArenaBoundary(buildings));
  buildings = buildings.filter(building => !isArenaBoundary(building));
  group.add(createUrbanGround(buildings));

  const baked = graphicsCity(buildings);
  if (baked) group.add(baked, graphicsAsset('cincinnati-street-details')!);
  else {
  const windowMatrices: THREE.Matrix4[] = [];
  const windowDummy = new THREE.Object3D();
  const transform = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const palettes = ['#bcb7a7', '#b6c5c6', '#c5b18f', '#a3b3bb', '#b9a7a0', '#d0c9b5'];
  const bodies = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material('#ffffff'), buildings.length);
  const roofs = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material('#626b6e'), buildings.length);
  bodies.name = 'collision-building-walls'; roofs.name = 'collision-building-roofs';
  const buildingDummy = new THREE.Object3D();
  buildings.forEach((building, index) => {
    const block = new THREE.Group();
    block.position.set(building.x, building.baseY ?? 0, building.z);
    block.rotation.y = radians(building.rotation ?? 0);
    buildingDummy.position.set(building.x, (building.baseY ?? 0) + building.height / 2, building.z);
    buildingDummy.rotation.set(0, block.rotation.y, 0);
    buildingDummy.scale.set(building.width, building.height, building.depth); buildingDummy.updateMatrix();
    bodies.setMatrixAt(index, buildingDummy.matrix); bodies.setColorAt(index, new THREE.Color(building.color ?? palettes[index % palettes.length]));
    // A roof plane sits on the collision box, never above its modeled height.
    buildingDummy.position.set(building.x, (building.baseY ?? 0) + building.height + 0.002, building.z);
    buildingDummy.rotation.set(-Math.PI / 2, 0, block.rotation.y);
    buildingDummy.scale.set(building.width * 0.96, building.depth * 0.96, 1); buildingDummy.updateMatrix(); roofs.setMatrixAt(index, buildingDummy.matrix);
    quaternion.setFromAxisAngle(up, block.rotation.y);
    transform.compose(block.position, quaternion, new THREE.Vector3(1, 1, 1));
    if (building.height > 1.2 && building.width > 0.8 && building.depth > 0.8) {
      const rows = Math.min(6, Math.max(1, Math.floor((building.height - 0.5) / 1.8)));
      for (let row = 0; row < rows; row++) {
        const y = 0.55 + row * ((building.height - 0.8) / Math.max(rows, 1));
        for (let face = 0; face < 4; face++) {
          const across = face % 2 ? building.depth : building.width;
          const count = Math.min(3, Math.max(1, Math.floor(across / 2)));
          for (let column = 0; column < count; column++) {
            const offset = (column + 0.5) / count * across - across / 2;
            const front = face === 0 || face === 1 ? 1 : -1;
            windowDummy.position.set(face % 2 ? front * (building.width / 2 + 0.002) : offset, y, face % 2 ? offset : front * (building.depth / 2 + 0.002));
            windowDummy.rotation.set(0, face % 2 ? front * Math.PI / 2 : face === 2 ? Math.PI : 0, 0);
            windowDummy.scale.set(Math.min(1.1, across / count * 0.55), Math.min(0.22, building.height / rows * 0.3), 1);
            windowDummy.updateMatrix();
            windowMatrices.push(new THREE.Matrix4().multiplyMatrices(transform, windowDummy.matrix));
          }
        }
      }
    }
  });
  bodies.instanceMatrix.needsUpdate = true; roofs.instanceMatrix.needsUpdate = true;
  bodies.castShadow = true; bodies.receiveShadow = true; roofs.receiveShadow = true;
  group.add(bodies, roofs);
  const windows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material('#718088'), windowMatrices.length);
  windows.name = 'sparse-facade-detail';
  windowMatrices.forEach((matrix, index) => windows.setMatrixAt(index, matrix));
  windows.instanceMatrix.needsUpdate = true;
  group.add(windows);
  }
  // Physical street signs are visible through the same cameras as every other prop.
  const signs = new Set<string>();
  if (!baked) CITY.roads.forEach(road => {
    if (!road.name || signs.has(road.name) || road.points.length < 2 || signs.size >= 18) return;
    const a = road.points[Math.floor(road.points.length / 2)];
    const text = sign(road.name, Math.min(3.0, Math.max(1.8, road.name.length * 0.11)));
    text.position.set(a.x, 1.3, a.z + road.width / 2 + 0.35);
    group.add(text); signs.add(road.name);
  });
  return group;
}

export function createTreasure(treasure: Treasure) {
  const group = new THREE.Group();
  group.position.set(treasure.x, treasure.y, treasure.z);
  const wood = material(treasure.found ? '#83693d' : '#864820');
  const brass = new THREE.MeshLambertMaterial({ color: treasure.found ? '#dfcf87' : '#ffd266' });
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, surface: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), surface);
    mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh);
    return mesh;
  };
  box(1.4, 0.68, 1, 0, 0.34, 0, wood);
  // Found chests expose the interior while staying inside the same prop envelope.
  const lid = box(1.4, 0.3, treasure.found ? 0.18 : 1, 0, treasure.found ? 0.88 : 0.83, treasure.found ? -0.39 : 0, wood);
  for (const x of [-0.43, 0.43]) {
    box(0.14, 0.68, 1.01, x, 0.34, 0, brass);
    box(0.14, 0.3, treasure.found ? 0.19 : 1.01, x, lid.position.y, lid.position.z, brass);
  }
  box(1.41, 0.07, 1.01, 0, 0.055, 0, brass);
  box(0.23, 0.23, 0.05, 0, 0.6, 0.525, brass);
  if (treasure.found) box(1.1, 0.045, 0.65, 0, 0.695, 0.04, brass);
  return group;
}

export function disposeGroup(group: THREE.Group) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  group.traverse(object => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
      if (object instanceof THREE.InstancedMesh) object.dispose();
      geometries.add(object.geometry);
      (Array.isArray(object.material) ? object.material : [object.material]).forEach(item => materials.add(item));
    }
  });
  geometries.forEach(item => item.dispose());
  materials.forEach(item => {
    const surface = item as THREE.MeshStandardMaterial;
    for (const texture of [surface.map, surface.roughnessMap, surface.metalnessMap]) if (texture) textures.add(texture);
    item.dispose();
  });
  textures.forEach(texture => texture.dispose());
  group.clear();
}
