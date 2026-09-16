import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import manifest from './assets/manifest.json';
import type { Obstacle } from '../shared/types';

const templates = new Map<string, THREE.Object3D>();
let loading: Promise<void> | undefined;

/** Resolve before accepting camera ownership: no placeholder acquisition during loading. */
export function loadGraphicsAssets(read: (url: URL) => Promise<ArrayBuffer> = async url => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Asset download failed (${response.status}): ${url.pathname}`);
  return response.arrayBuffer();
}) {
  return loading ??= (async () => {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const [city, kit] = await Promise.all([
      read(new URL('./assets/cincinnati.glb', import.meta.url)).then(bytes => loader.parseAsync(bytes, '')),
      read(new URL('./assets/drone-kit.glb', import.meta.url)).then(bytes => loader.parseAsync(bytes, '')),
    ]);
    const pending = new Map<string, THREE.Object3D>();
    for (const name of ['airframe', 'gun', 'optics', 'armor-plates', 'cargo-grip', 'cargo-module', 'crate', 'pallet', 'service-cabinet']) {
      const object = kit.scene.getObjectByName(name);
      if (!object) throw new Error(`Blender asset missing: ${name}`);
      pending.set(name, object);
    }
    pending.set('cincinnati-buildings', city.scene);
    pending.forEach((object, name) => templates.set(name, object));
  })();
}

/** Instances own disposable GPU resources; removing one never invalidates the templates. */
export function graphicsAsset(name: string, teamColor?: string): THREE.Group | undefined {
  const template = templates.get(name);
  if (!template) return undefined;
  const group = new THREE.Group(); group.name = name; group.userData.blender = true;
  const object = template.clone(true);
  const materials = new Map<THREE.Material, THREE.Material>();
  const textures = new Map<THREE.Texture, THREE.Texture>();
  object.traverse(child => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry = child.geometry.clone();
    const copy = (original: THREE.Material) => {
      let result = materials.get(original);
      if (!result) {
        result = original.clone(); materials.set(original, result);
        const standard = result as THREE.MeshStandardMaterial;
        for (const key of ['map', 'metalnessMap', 'roughnessMap'] as const) {
          const source = standard[key];
          if (source) {
            if (!textures.has(source)) { const texture = source.clone(); texture.anisotropy = 4; textures.set(source, texture); }
            standard[key] = textures.get(source)!;
          }
        }
        if (teamColor && original.name === 'Team paint') standard.color.set(teamColor);
        if (teamColor && original.name === 'Team light') {
          standard.color.set(teamColor).multiplyScalar(0.15);
          standard.emissive.set(teamColor); standard.emissiveIntensity = 2;
          standard.toneMapped = false;
        }
        // Facade overlays need bias; roofs are a single tessellated surface at
        // the true building height and must not be biased through roof props.
        if (name === 'cincinnati-buildings' && /Facade|mullions|trim|Recess/.test(original.name)) {
          const layer = /Facade|trim/.test(original.name) ? 2 : /mullions/.test(original.name) ? 3 : 1;
          standard.polygonOffset = true; standard.polygonOffsetFactor = -layer; standard.polygonOffsetUnits = -layer;
        }
      }
      return result;
    };
    child.material = Array.isArray(child.material) ? child.material.map(copy) : copy(child.material);
    child.receiveShadow = true;
    const surfaces = Array.isArray(child.material) ? child.material : [child.material];
    child.castShadow = name === 'cincinnati-buildings' && surfaces.some(material => /^(Masonry|Carew buff|Curtain wall|Roof)/.test(material.name));
  });
  group.add(object); return group;
}

export function graphicsCity(buildings: Obstacle[]) {
  const signature = buildings.map(b => [b.id, b.x, b.baseY ?? 0, b.z, b.width, b.height, b.depth, b.rotation ?? 0]);
  // Historical/custom maps must use their own geometry, never the current baked city.
  return JSON.stringify(signature) === JSON.stringify(manifest.buildings) ? graphicsAsset('cincinnati-buildings') : undefined;
}
