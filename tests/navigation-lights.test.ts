import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CombatView } from '../client/combat-view.ts';
import { DroneVisuals } from '../client/drone-visuals.ts';
import { navigationIntensity, navigationPhase } from '../client/navigation-lights.ts';
import { CARGO_CONFIG, RTS_CONFIG, type MatchState } from '../shared/rts.ts';
import type { Drone } from '../shared/types.ts';

const lens = (object: THREE.Object3D) => (object.getObjectByName('navigation-lens') as THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>).material;
const atPhase = (cycle: number, id: string) => (cycle * 2.4 + 2.4 - navigationPhase(id)) % 2.4;
const drone: Drone = { id: 'drone-1', x: 0, y: 8, z: 0, yaw: 0, pitch: 0, alive: true, online: true, observations: 0, status: '', cargo: { amount: 0 } };
const match = (): MatchState => ({
  rulesVersion: 'cargo-v3', phase: 'ready', winner: null,
  teams: { blue: { credits: 0, earned: 0, shopUnlocked: true }, red: { credits: 0, earned: 0, shopUnlocked: true } },
  resources: [{ id: 'roof-cache', x: 0, y: 7, z: 0, zoneSize: 4, capacity: 120, remaining: 120 },
    { id: 'crash-drop', x: 10, y: 0, z: 10, zoneSize: 1.2, capacity: 30, remaining: 30, kind: 'dropped' }],
  servicePads: [{ id: 'blue-roof', x: 5, y: 8, z: 0, zoneSize: 5.6, team: 'blue' }], projectiles: [], events: [],
});

test('navigation cadence is deterministic, slow and separates the two airframe flashes', () => {
  for (const pattern of ['cargo', 'base', 'drone'] as const) {
    for (let step = 0; step < 24; step++) {
      const time = step / 10;
      assert.ok(Math.abs(navigationIntensity(pattern, time) - navigationIntensity(pattern, time + 2.4)) < 1e-12);
      assert.ok(navigationIntensity(pattern, time) >= 0 && navigationIntensity(pattern, time) <= 1);
    }
  }
  assert.equal(navigationIntensity('drone', 2.4 * 0.09), 1);
  assert.equal(navigationIntensity('drone', 2.4 * 0.29), 1);
  assert.equal(navigationIntensity('drone', 2.4 * 0.19), 0);
  assert.notEqual(navigationPhase('drone-1'), navigationPhase('drone-2'));
});

test('rooftop lights remain local occluded fixtures below the usable hover envelope; crash drops get no fixtures', () => {
  const scene = new THREE.Scene(), view = new CombatView(scene), state = match(); view.update(state);
  for (const node of [state.resources[0], state.servicePads![0]]) {
    const beacons = scene.getObjectByName(node.id)!.getObjectByName('apron-beacons')!;
    const lamps = beacons.children.filter(object => object.name === 'navigation-lens') as THREE.InstancedMesh[];
    assert.equal(lamps.reduce((count, lamp) => count + lamp.count, 0), 8);
    scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(beacons);
    assert.ok(bounds.max.y - node.y < CARGO_CONFIG.hoverMin - RTS_CONFIG.droneRadius);
    assert.ok(bounds.min.x >= node.x - node.zoneSize! / 2 && bounds.max.x <= node.x + node.zoneSize! / 2);
    beacons.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const material of [object.material].flat()) {
        assert.equal(material.depthTest, true);
        assert.equal(material.transparent, object.name === 'navigation-halo');
      }
    });
  }
  assert.equal(lens(scene.getObjectByName('roof-cache')!).emissive.getHexString(), 'ffbc47');
  assert.equal(lens(scene.getObjectByName('blue-roof')!).emissive.getHexString(), '2799ba');
  assert.equal(scene.getObjectByName('crash-drop')!.getObjectByName('apron-beacons'), undefined);
  state.resources[0].remaining = 0; view.update(state);
  assert.equal(scene.getObjectByName('roof-cache')!.getObjectByName('apron-beacons')!.visible, true, 'beacons mark the apron, not a hidden stock sensor');
  view.dispose();
});

test('a delayed acquisition uses its own light phase and restores live lights even when rendering fails', () => {
  const scene = new THREE.Scene(), drones = new DroneVisuals(scene), view = new CombatView(scene), state = match();
  drones.reconcile([drone]);
  const liveTime = atPhase(0.75, drone.id), capturedTime = atPhase(0.09, drone.id);
  drones.pose([drone], liveTime); view.update(state, liveTime);
  const droneMesh = scene.getObjectByName(drone.id)!;
  const liveDroneLight = lens(droneMesh).emissiveIntensity, liveRoofLight = lens(scene.getObjectByName('roof-cache')!).emissiveIntensity;
  assert.throws(() => view.withSnapshot(state, () => drones.withSnapshot('drone-2', [drone], () => {
    assert.ok(lens(droneMesh).emissiveIntensity > liveDroneLight + 3);
    assert.equal(lens(scene.getObjectByName('roof-cache')!).emissiveIntensity,
      0.6 + navigationIntensity('cargo', capturedTime, navigationPhase('roof-cache')) * 3.2);
    throw new Error('capture failed');
  }, capturedTime), capturedTime), /capture failed/);
  assert.equal(lens(droneMesh).emissiveIntensity, liveDroneLight);
  assert.equal(lens(scene.getObjectByName('roof-cache')!).emissiveIntensity, liveRoofLight);
  drones.pose([{ ...drone, alive: false }], capturedTime); drones.hideObserver(); assert.equal(droneMesh.visible, false);
  drones.withSnapshot('drone-2', [drone], () => assert.equal(droneMesh.visible, true), liveTime);
  assert.equal(droneMesh.visible, false);
  const legacy = { ...state, rulesVersion: 'cargo-v2' as const };
  view.withSnapshot(legacy, () => assert.equal(scene.getObjectByName('roof-cache')!.getObjectByName('apron-beacons'), undefined), 0);
  assert.ok(scene.getObjectByName('roof-cache')!.getObjectByName('apron-beacons'));
  assert.equal(lens(scene.getObjectByName('roof-cache')!).emissiveIntensity, liveRoofLight);
  drones.dispose(); view.dispose();
});
