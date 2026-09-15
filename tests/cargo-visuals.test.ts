import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CombatView } from '../client/combat-view.ts';
import { DroneVisuals } from '../client/drone-visuals.ts';
import { apronServicePositions, CARGO_CONFIG, RTS_CONFIG, type MatchState } from '../shared/rts.ts';
import type { Drone } from '../shared/types.ts';

const match = (): MatchState => ({
  rulesVersion: 'cargo-v2', phase: 'active', winner: null,
  teams: { blue: { credits: 30, earned: 0, shopUnlocked: true }, red: { credits: 30, earned: 0, shopUnlocked: true } },
  resources: [{ id: 'depot', x: 1, y: 0, z: 2, zoneSize: 2.4, capacity: 600, remaining: 600 }],
  servicePads: [{ id: 'blue', team: 'blue', x: 10, y: 0, z: 20, zoneSize: 6 }, { id: 'red', team: 'red', x: -10, y: 0, z: 20, zoneSize: 6 }],
  projectiles: [], events: [],
});

test('cargo stock remains until pickup completion, shrinks from authority, and leaves empty pallets', () => {
  const scene = new THREE.Scene(), view = new CombatView(scene), state = match(); view.update(state);
  const depot = scene.getObjectByName('depot')!, stock = depot.getObjectByName('stock')!, pallets = depot.getObjectByName('pallets')!;
  assert.equal(stock.children.filter(item => item.visible).length, 20); assert.equal(pallets.children.length, 20);
  state.resources[0].reserved = 60; view.update(state);
  assert.equal(stock.children.filter(item => item.visible).length, 20, 'an incomplete reservation has not picked up visible crates');
  state.resources[0].remaining = 45; state.resources[0].reserved = 0; view.update(state);
  assert.equal(stock.children.filter(item => item.visible).length, 2); assert.equal(stock.children[1].scale.y, 0.5);
  state.resources[0].remaining = 0; view.update(state);
  assert.equal(depot.visible, true); assert.equal(stock.visible, false); assert.equal(pallets.visible, true);
  assert.equal(pallets.children.length, 20); view.dispose();
});

test('marked apron bounds and three service marks agree with shared usable footprints', () => {
  const scene = new THREE.Scene(), view = new CombatView(scene), state = match(); view.update(state);
  for (const node of [...state.resources, ...state.servicePads!]) {
    const mesh = scene.getObjectByName(node.id)!, size = node.zoneSize!;
    scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(mesh.getObjectByName('apron-surface')!);
    assert.ok(Math.abs(bounds.min.x - (node.x - size / 2)) < 1e-6);
    assert.ok(Math.abs(bounds.max.x - (node.x + size / 2)) < 1e-6);
    assert.ok(Math.abs(bounds.min.z - (node.z - size / 2)) < 1e-6);
    assert.ok(Math.abs(bounds.max.z - (node.z + size / 2)) < 1e-6);
    const marks = mesh.getObjectByName('service-positions')!.children;
    assert.equal(marks.length, 3);
    apronServicePositions(node, size).forEach((point, index) => {
      const position = marks[index].getWorldPosition(new THREE.Vector3());
      assert.ok(Math.abs(position.x - point.x) < 1e-10); assert.ok(Math.abs(position.z - point.z) < 1e-10);
      for (let other = index + 1; other < marks.length; other++) {
        const next = marks[other].getWorldPosition(new THREE.Vector3());
        assert.ok(position.distanceTo(next) > RTS_CONFIG.droneRadius * 2);
      }
    });
    mesh.traverse(object => {
      if (object instanceof THREE.Mesh) for (const material of [object.material].flat()) {
        assert.equal(material.depthTest, true); assert.equal(material.transparent, false);
        if (material instanceof THREE.MeshLambertMaterial) assert.equal(material.emissive.getHex(), 0);
      }
    });
  }
  for (const pad of state.servicePads!) {
    const cabinet = scene.getObjectByName(pad.id)!.getObjectByName('service-cabinet')!;
    assert.ok(new THREE.Box3().setFromObject(cabinet).max.y < CARGO_CONFIG.hoverMin - RTS_CONFIG.droneRadius);
  }
  const stock = scene.getObjectByName('depot')!.getObjectByName('stock')!;
  assert.ok(new THREE.Box3().setFromObject(stock).max.y < CARGO_CONFIG.hoverMin - RTS_CONFIG.droneRadius);
  view.dispose();
});

test('captured rules and stock restore correctly across historical and cargo rules', () => {
  const scene = new THREE.Scene(), view = new CombatView(scene), state = match(); view.update(state);
  const batteryEra = structuredClone(state); batteryEra.rulesVersion = 'cargo-v1';
  view.withSnapshot(batteryEra, () => assert.ok(scene.getObjectByName('depot')!.getObjectByName('stock')));
  const legacy = structuredClone(state); legacy.rulesVersion = 'cube-v1'; legacy.resources[0].remaining = 0;
  assert.throws(() => view.withSnapshot(legacy, () => {
    assert.ok(scene.getObjectByName('depot')!.getObjectByName('zone-volume'));
    assert.equal(scene.getObjectByName('depot')!.visible, false); throw new Error('camera failure');
  }), /camera failure/);
  assert.ok(scene.getObjectByName('depot')!.getObjectByName('apron-surface'));
  assert.equal(scene.getObjectByName('depot')!.getObjectByName('stock')!.children.filter(item => item.visible).length, 20);
  const partial = structuredClone(state); partial.resources[0].remaining = 15;
  view.withSnapshot(partial, () => assert.equal(scene.getObjectByName('depot')!.getObjectByName('stock')!.children[0].scale.y, 0.5));
  assert.equal(scene.getObjectByName('depot')!.getObjectByName('stock')!.children[0].scale.y, 1); view.dispose();
});

test('attached one/two-crate cargo is bounded by the collision sphere and follows captured authoritative cargo', () => {
  const scene = new THREE.Scene(), visuals = new DroneVisuals(scene);
  const drone: Drone = { id: 'drone-1', x: 5, y: 2, z: 9, yaw: 37, pitch: 0, alive: true, online: true, observations: 0, status: '',
    cargo: { amount: 60 }, equipment: { gun: true, armor: true, miner: false, cargo: true } };
  visuals.reconcile([drone]); const mesh = scene.getObjectByName(drone.id)!;
  const cargo = mesh.getObjectByName('carried-cargo')!; assert.equal(cargo.children.filter(item => item.visible).length, 2);
  scene.updateMatrixWorld(true);
  cargo.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const vertices = object.geometry.getAttribute('position');
    for (let index = 0; index < vertices.count; index++) {
      const vertex = new THREE.Vector3().fromBufferAttribute(vertices, index).applyMatrix4(object.matrixWorld);
      assert.ok(vertex.distanceTo(new THREE.Vector3(drone.x, drone.y, drone.z)) <= RTS_CONFIG.droneRadius);
    }
  });
  assert.equal(mesh.getObjectByName('armor')!.visible, false); assert.equal(mesh.getObjectByName('armor-plates')!.visible, true);
  const unloaded = structuredClone(drone); unloaded.cargo!.amount = 0;
  visuals.withSnapshot('drone-2', [unloaded], () => assert.equal(cargo.visible, false));
  assert.equal(cargo.visible, true);
  drone.cargo!.amount = 15; visuals.pose([drone]); assert.equal(cargo.children[0].scale.y, 0.5); assert.equal(cargo.children[1].visible, false);
  drone.alive = false; visuals.pose([drone]); assert.equal(cargo.visible, false); visuals.dispose();
});

test('rotated rooftop and compact intersection marks follow authority across snapshot restoration', () => {
  const scene = new THREE.Scene(), view = new CombatView(scene), state = match();
  state.rulesVersion = 'cargo-v3';
  Object.assign(state.resources[0], { zoneSize: 2, rotation: 11 });
  Object.assign(state.servicePads![0], { y: 8, zoneSize: 5.6, rotation: 22, serviceHeight: 6 });
  view.update(state); scene.updateMatrixWorld(true);
  for (const node of [state.resources[0], state.servicePads![0]]) {
    const mesh = scene.getObjectByName(node.id)!;
    assert.equal(mesh.rotation.y, node.rotation! * Math.PI / 180);
    apronServicePositions(node, node.zoneSize!).forEach((point, index) => {
      const mark = mesh.getObjectByName('service-positions')!.children[index].getWorldPosition(new THREE.Vector3());
      assert.ok(Math.hypot(point.x - mark.x, point.z - mark.z) < 1e-8);
    });
  }
  const depot = scene.getObjectByName('depot')!, stock = depot.getObjectByName('stock')!;
  assert.equal(depot.getObjectByName('pallets')!.children.length, 10);
  assert.ok(stock.children[1].position.y > stock.children[0].position.y);
  state.resources[0].remaining = 570; view.update(state);
  assert.equal(stock.children[19].visible, false); assert.equal(stock.children[18].visible, true);
  const prior = structuredClone(state); prior.resources[0].rotation = 0;
  view.withSnapshot(prior, () => assert.equal(scene.getObjectByName('depot')!.rotation.y, 0));
  assert.equal(scene.getObjectByName('depot')!.rotation.y, 11 * Math.PI / 180);
  view.dispose();
});
