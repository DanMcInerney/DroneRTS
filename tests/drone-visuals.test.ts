import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DroneVisuals } from '../client/drone-visuals.ts';
import type { Drone } from '../client/types.ts';

const drone = (id: Drone['id'], x: number): Drone => ({ id, x, y: 10, z: 0, yaw: 0, pitch: 0, online: true, status: '', observations: 0 });

test('elimination removes the visible target while older acquisitions and reset retain their own alive state', () => {
  const scene = new THREE.Scene(), visuals = new DroneVisuals(scene);
  const alive = { ...drone('drone-4', 4), alive: true, cargo: { amount: 0 }, equipment: { gun: true, armor: true, miner: false } };
  visuals.reconcile([alive]);
  const mesh = scene.getObjectByName(alive.id)!;
  const color = (mesh.children[0] as THREE.Mesh<THREE.BoxGeometry, THREE.MeshLambertMaterial>).material.color.getHex();
  const unarmored = { ...alive, equipment: { ...alive.equipment, armor: false } };
  visuals.pose([unarmored]);
  assert.equal(mesh.visible, true);
  assert.equal(mesh.getObjectByName('armor-plates')!.visible, false);
  assert.equal((mesh.children[0] as THREE.Mesh<THREE.BoxGeometry, THREE.MeshLambertMaterial>).material.color.getHex(), color);
  const dead = { ...unarmored, alive: false };
  visuals.pose([dead]);
  for (const observer of [undefined, 'drone-1', 'drone-4']) {
    visuals.hideObserver(observer); assert.equal(mesh.visible, false);
  }
  visuals.withSnapshot('drone-1', [alive], () => assert.equal(mesh.visible, true));
  assert.equal(mesh.visible, false);
  visuals.reconcile([alive]); assert.equal(mesh.visible, true);
  assert.throws(() => visuals.withSnapshot('drone-1', [dead, { ...drone('drone-6', 6), alive: false }], () => {
    assert.equal(mesh.visible, false);
    assert.equal(scene.getObjectByName('drone-6')!.visible, false);
    throw new Error('capture failed');
  }), /capture failed/);
  assert.equal(mesh.visible, true); assert.equal(scene.getObjectByName('drone-6'), undefined);
  visuals.dispose();
});

test('visual identity survives reordering and removed mesh resources are disposed once', () => {
  const scene = new THREE.Scene(), visuals = new DroneVisuals(scene);
  visuals.reconcile([drone('drone-1', 1), drone('drone-2', 2), drone('drone-3', 3), drone('drone-4', 4)]);
  const first = scene.getObjectByName('drone-1')!, fourth = scene.getObjectByName('drone-4')!;
  assert.equal(fourth.position.x, 4);
  assert.equal((fourth.children[0] as THREE.Mesh).material instanceof THREE.Material, true);
  visuals.reconcile([drone('drone-4', 40), drone('drone-1', 10)]);
  assert.equal(scene.getObjectByName('drone-4'), fourth); assert.equal(scene.getObjectByName('drone-1'), first);
  assert.equal(scene.getObjectByName('drone-2'), undefined); assert.equal(first.position.x, 10);
  let disposed = 0;
  (fourth.children[0] as THREE.Mesh).geometry.addEventListener('dispose', () => { disposed++; });
  visuals.reconcile([drone('drone-1', 11)]); visuals.reconcile([drone('drone-1', 12)]);
  assert.equal(disposed, 1); assert.equal(scene.getObjectByName('drone-4'), undefined);
  visuals.dispose(); assert.equal(scene.children.length, 0);
});

test('sensor snapshots show only their actual roster and restore display poses and visibility on failure', () => {
  const scene = new THREE.Scene(), visuals = new DroneVisuals(scene);
  visuals.reconcile([drone('drone-1', 1), drone('drone-2', 2), drone('drone-4', 4)]);
  visuals.hideObserver('drone-2');
  const one = scene.getObjectByName('drone-1')!, two = scene.getObjectByName('drone-2')!, four = scene.getObjectByName('drone-4')!;
  assert.throws(() => visuals.withSnapshot('drone-1', [drone('drone-1', 100), drone('drone-3', 300)], () => {
    assert.equal(one.position.x, 100); assert.equal(one.visible, false);
    assert.equal(two.visible, false); assert.equal(four.visible, false);
    assert.equal(scene.getObjectByName('drone-3')!.position.x, 300);
    assert.equal(scene.getObjectByName('drone-3')!.visible, true);
    throw new Error('camera failed');
  }), /camera failed/);
  assert.equal(one.position.x, 1); assert.equal(one.visible, true); assert.equal(two.visible, false); assert.equal(four.visible, true);
  assert.equal(scene.getObjectByName('drone-3'), undefined); assert.equal(scene.children.length, 3);
  visuals.dispose();
});
