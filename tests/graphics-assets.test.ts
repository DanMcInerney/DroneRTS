import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { loadGraphicsAssets, graphicsAsset, graphicsCity } from '../client/graphics-assets.ts';
import { makeDrone, positionDrone } from '../client/drone-model.ts';
import { disposeGroup } from '../client/city-scene.ts';
import { CITY } from '../shared/city.ts';
import manifest from '../client/assets/manifest.json';
import type { Drone } from '../client/types.ts';

before(async () => {
  // Node has no raster surface. Decode PNG dimensions for structural GLB tests;
  // actual texture pixels and PBR rendering are covered by the browser fixture.
  Object.assign(globalThis, { self: globalThis, createImageBitmap: async (blob: Blob) => {
    const bytes = new DataView(await blob.arrayBuffer());
    assert.equal(bytes.getUint32(0), 0x89504e47);
    return { width: bytes.getUint32(16), height: bytes.getUint32(20), close() {} };
  } });
  await loadGraphicsAssets(async url => {
    const bytes = await readFile(url);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  });
});

test('Blender exports match their source geography and checked-in checksums', async () => {
  assert.equal(createHash('sha256').update(await readFile('shared/city-data.json')).digest('hex'), manifest.sourceCitySha256);
  for (const [file, asset] of Object.entries(manifest.assets)) {
    const bytes = await readFile(`client/assets/${file}`);
    assert.equal(bytes.length, asset.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  }
  const city = graphicsCity(CITY.buildings)!; assert.ok(city);
  assert.equal(graphicsCity([{ ...CITY.buildings[0], height: 1 }]), undefined, 'custom/replay geometry cannot receive a mismatching baked city');
  const bounds = new THREE.Box3().setFromObject(city);
  assert.ok(bounds.min.y >= -.001 && bounds.max.y <= 20.28);
  let triangles = 0, meshes = 0;
  city.traverse(object => { if (object instanceof THREE.Mesh) { meshes++; triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3; } });
  assert.ok(meshes <= 26 && triangles < 30_000, 'city remains batched for six camera views');
  disposeGroup(city);
});

test('building roofs cover the sourced footprints once at their true height and still cast shadows', () => {
  const city = graphicsCity(CITY.buildings)!;
  city.updateMatrixWorld(true);
  let roofArea = 0;
  city.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const material = object.material as THREE.MeshStandardMaterial;
    const roof = material.name.startsWith('Roof ');
    if (roof) {
      assert.equal(material.polygonOffset, false, 'roof geometry must not be pulled through cargo markings');
      assert.equal(object.castShadow, true, 'replacing a building cap must retain its solid roof shadow');
    }
    const positions = object.geometry.attributes.position, indices = object.geometry.index;
    const count = indices?.count ?? positions.count;
    const point = (index: number) => new THREE.Vector3().fromBufferAttribute(positions, indices ? indices.getX(index) : index).applyMatrix4(object.matrixWorld);
    for (let i = 0; i < count; i += 3) {
      const a = point(i), b = point(i + 1), c = point(i + 2);
      const cross = b.clone().sub(a).cross(c.clone().sub(a));
      if (cross.y <= 0 || Math.abs(cross.x) + Math.abs(cross.z) > 1e-6) continue;
      assert.equal(roof, true, 'no wall cap or architectural overlay may duplicate the upward roof surface');
      const center = a.clone().add(b).add(c).multiplyScalar(1 / 3);
      assert.ok(CITY.buildings.some(building => {
        if (Math.abs(center.y - (building.baseY ?? 0) - building.height) > 1e-5) return false;
        const angle = THREE.MathUtils.degToRad(building.rotation ?? 0), dx = center.x - building.x, dz = center.z - building.z;
        return Math.abs(Math.cos(angle) * dx - Math.sin(angle) * dz) <= building.width / 2 + 1e-5
          && Math.abs(Math.sin(angle) * dx + Math.cos(angle) * dz) <= building.depth / 2 + 1e-5;
      }), 'each visible roof triangle must lie at a sourced roof height and within its footprint');
      roofArea += cross.y / 2;
    }
  });
  const expectedArea = CITY.buildings.reduce((area, building) => area + building.width * building.depth, 0);
  // Three adjacent source rectangles share small equal-height slivers. Their
  // visible union loses only that duplicate area, never a second roof layer.
  assert.ok(roofArea <= expectedArea + 1e-4 && roofArea >= expectedArea * .9999,
    'roof area must exclude duplicate caps/patches while preserving the sourced footprints');
  disposeGroup(city);
});

test('consumer airframe retains the flight envelope, team colors and independent disposable instances', () => {
  const blue = graphicsAsset('airframe', '#2799ba')!, red = graphicsAsset('airframe', '#bc5147')!;
  const size = new THREE.Box3().setFromObject(blue).getSize(new THREE.Vector3());
  assert.ok(size.x <= .535 && size.z <= .50 && size.y <= .18, `airframe extent: ${size.toArray()}`);
  const panels = (group: THREE.Group) => {
    const result: THREE.Mesh[] = [];
    group.traverse(object => { if (object instanceof THREE.Mesh && !Array.isArray(object.material) && object.material.name === 'Team paint') result.push(object); });
    return result;
  };
  assert.ok(panels(blue).length > 0);
  const b = panels(blue)[0], r = panels(red)[0];
  assert.equal((b.material as THREE.MeshStandardMaterial).color.getHexString(), '2799ba');
  assert.equal((r.material as THREE.MeshStandardMaterial).color.getHexString(), 'bc5147');
  assert.notEqual(b.geometry, r.geometry); assert.notEqual(b.material, r.material);
  let disposed = 0; r.geometry.addEventListener('dispose', () => disposed++);
  disposeGroup(blue); assert.equal(disposed, 0); disposeGroup(red); assert.equal(disposed, 1);
});

test('Blender equipment, partial cargo and armor loss follow authoritative presentation state', () => {
  const mesh = makeDrone('drone-4');
  const drone = { id: 'drone-4', x: 1, y: 2, z: 3, yaw: 0, pitch: -20, alive: true, cargo: { amount: 45 },
    equipment: { armor: true, cargo: true, gun: true, optics: false, miner: false }, online: true, status: '', observations: 0 } as Drone;
  positionDrone(mesh, drone);
  assert.equal(mesh.userData.blender, true);
  assert.equal(mesh.getObjectByName('gun')!.visible, true);
  assert.equal(mesh.getObjectByName('optics')!.visible, false);
  const cargo = mesh.getObjectByName('carried-cargo')!;
  assert.equal(cargo.children[1].scale.y, .5);
  positionDrone(mesh, { ...drone, equipment: { ...drone.equipment!, armor: false }, cargo: { amount: 0 } });
  assert.equal(mesh.getObjectByName('armor-plates')!.visible, false); assert.equal(cargo.visible, false);
  assert.equal(mesh.getObjectByName('airframe')!.visible, true);
  disposeGroup(mesh);
});

test('Blender navigation lights emit each team color, keep depth occlusion and need no equipped module', () => {
  for (const color of ['#2799ba', '#bc5147']) {
    const airframe = graphicsAsset('airframe', color)!;
    const lights: THREE.Mesh[] = [];
    airframe.traverse(o => { if (o instanceof THREE.Mesh && !Array.isArray(o.material) && o.material.name === 'Team light') lights.push(o); });
    assert.ok(lights.length > 0);
    for (const light of lights) {
      const material = light.material as THREE.MeshStandardMaterial;
      assert.equal(material.emissive.getHexString(), color.slice(1)); assert.ok(material.emissiveIntensity >= 2);
      assert.equal(material.depthTest, true); assert.equal(material.transparent, false);
      const bounds = new THREE.Box3().setFromObject(light);
      assert.ok(bounds.min.y < .005 && bounds.max.y > .05, 'lights cover both upper and lower guard surfaces');
    }
    disposeGroup(airframe);
  }
});
