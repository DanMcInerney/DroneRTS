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
    for (const name of ['cincinnati-buildings', 'cincinnati-street-details']) {
      const object = city.scene.getObjectByName(name);
      if (!object) throw new Error(`Blender asset missing: ${name}`);
      pending.set(name, object);
    }
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
        if (teamColor && original.name === 'Team paint') {
          standard.color.set(teamColor);
          // Bright painted polymer retains its team hue on the shaded belly.
          // A small fill is steady; the separate navigation lenses still flash.
          standard.emissive.set(teamColor); standard.emissiveIntensity = .32;
          standard.roughness = .52; standard.metalness = 0;
        }
        if (teamColor && original.name === 'Team light') {
          standard.color.set(teamColor).multiplyScalar(0.15);
          standard.emissive.set(teamColor); standard.emissiveIntensity = 2;
          standard.toneMapped = false;
        }
        // Use the same bias on every wall material: authored skin offsets must
        // determine whether stone, recessed windows or their edging is in front.
        // Roofs retain their exact depth so they cannot cover rooftop props.
        if (name === 'cincinnati-buildings' && !/^Roof/.test(original.name)) {
          standard.polygonOffset = true; standard.polygonOffsetFactor = -1; standard.polygonOffsetUnits = -1;
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
