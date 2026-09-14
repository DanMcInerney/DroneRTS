import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CombatView } from '../client/combat-view.ts';
import { DroneVisuals } from '../client/drone-visuals.ts';
import { ReplayTimeline } from '../client/replay-model.ts';
import { FleetScene } from '../client/scene.ts';
import { DRONE_CAMERA } from '../shared/camera-profile.ts';
import { batteryPresentation, chargingPresentation, equippedModuleCount, recordedOperations, servicePresentation } from '../client/equipment-presentation.ts';
import type { MatchState } from '../shared/rts.ts';
import type { Drone } from '../shared/types.ts';

const match = (): MatchState => ({
  phase: 'active', winner: null,
  teams: { blue: { credits: 30, earned: 0, shopUnlocked: true }, red: { credits: 30, earned: 0, shopUnlocked: true } },
  resources: [{ id: 'salvage-test', x: 1, y: 0.45, z: 2, remaining: 150, capacity: 150 }],
  servicePads: [{ id: 'service-blue', team: 'blue', x: 10, y: 0.05, z: 20 }], projectiles: [], events: [],
});
const drone = (): Drone => ({ id: 'drone-1', x: 0, y: 2, z: 0, yaw: 0, pitch: 0, online: true, status: '', observations: 0,
  equipment: { gun: false, armor: false, miner: true, minerUpgrade: true, optics: true }, cameraMode: 'zoom', ammo: 0 });

test('capture applies saved pad membership and resource richness, then restores current geometry after failure', () => {
  const scene = new THREE.Scene(), view = new CombatView(scene), current = match();
  view.update(current);
  assert.equal(scene.getObjectByName('service-blue')!.position.x, 10);
  const ordinaryPieces = scene.getObjectByName('salvage-test')!.getObjectByName('stock')!.children.length;
  const captured = structuredClone(current);
  captured.servicePads = [{ id: 'service-red', team: 'red', x: -10, y: 0.05, z: -20 }];
  captured.resources[0].extractionMultiplier = 1.5; captured.resources[0].capacity = 900; captured.resources[0].remaining = 0;
  assert.throws(() => view.withSnapshot(captured, () => {
    assert.equal(scene.getObjectByName('service-blue'), undefined);
    assert.equal(scene.getObjectByName('service-red')!.position.x, -10);
    const stock = scene.getObjectByName('salvage-test')!.getObjectByName('stock')!;
    assert.ok(stock.children.length > ordinaryPieces); assert.equal(stock.visible, false);
    throw new Error('capture failure');
  }), /capture failure/);
  assert.equal(scene.getObjectByName('service-red'), undefined);
  assert.equal(scene.getObjectByName('service-blue')!.position.x, 10);
  const stock = scene.getObjectByName('salvage-test')!.getObjectByName('stock')!;
  assert.equal(stock.children.length, ordinaryPieces); assert.equal(stock.visible, true); assert.equal(stock.scale.y, 1);
  view.withSnapshot(undefined, () => {
    assert.equal(scene.getObjectByName('service-blue'), undefined); assert.equal(scene.getObjectByName('salvage-test'), undefined);
  });
  assert.ok(scene.getObjectByName('service-blue')); view.dispose(); assert.equal(scene.children.length, 0);
});

test('capture uses saved optics and drill upgrade attachments and restores current equipment', () => {
  const scene = new THREE.Scene(), visuals = new DroneVisuals(scene), current = drone();
  visuals.reconcile([current]);
  const mesh = scene.getObjectByName(current.id)!;
  assert.equal(mesh.getObjectByName('optics')!.visible, true); assert.equal(mesh.getObjectByName('miner-upgrade')!.visible, true);
  const captured = structuredClone(current); captured.equipment!.optics = false; captured.equipment!.minerUpgrade = false;
  assert.throws(() => visuals.withSnapshot('drone-2', [captured], () => {
    assert.equal(mesh.getObjectByName('optics')!.visible, false);
    assert.equal(mesh.getObjectByName('miner')!.visible, true); assert.equal(mesh.getObjectByName('miner-upgrade')!.visible, false);
    throw new Error('capture failure');
  }), /capture failure/);
  assert.equal(mesh.getObjectByName('optics')!.visible, true); assert.equal(mesh.getObjectByName('miner-upgrade')!.visible, true);
  visuals.dispose();
});

test('sensor capture uses snapshot optics projection despite newer live modes and restores projection after failure', () => {
  for (const [mode, equipped, expected] of [['zoom', true, 32], ['wide', true, DRONE_CAMERA.fov], ['zoom', false, DRONE_CAMERA.fov]] as const) {
    const saved = drone(); saved.cameraMode = mode; saved.equipment!.optics = equipped;
    const newer = drone(); newer.cameraMode = mode === 'zoom' ? 'wide' : 'zoom';
    const camera = new THREE.PerspectiveCamera(53, DRONE_CAMERA.width / DRONE_CAMERA.height);
    const projection = camera.projectionMatrix.clone();
    // Run the real capture method against a renderer that fails after inspecting
    // its projection. No WebGL or DOM is needed to test acquisition consistency.
    const scene = Object.create(FleetScene.prototype) as FleetScene;
    Object.assign(scene, {
      captureCamera: camera, state: { drones: [newer] },
      combat: { withSnapshot: (_match: unknown, render: () => void) => render() },
      drones: { withSnapshot: (_id: unknown, _drones: unknown, render: () => void) => render() },
      renderer: {
        getRenderTarget: () => null, getViewport: (value: THREE.Vector4) => value, getScissor: (value: THREE.Vector4) => value, getScissorTest: () => false,
        setRenderTarget() {}, setViewport() {}, setScissor() {}, setScissorTest() {},
        render: (_world: unknown, renderedCamera: THREE.PerspectiveCamera) => {
          assert.equal(renderedCamera.fov, expected);
          assert.ok(Math.abs(renderedCamera.projectionMatrix.elements[5] - 1 / Math.tan(expected * Math.PI / 360)) < 1e-10);
          throw new Error('renderer unavailable');
        },
      },
    });
    assert.throws(() => scene.capture(saved.id, saved, [saved]), /renderer unavailable/);
    assert.equal(camera.fov, 53); assert.deepEqual(camera.projectionMatrix.elements, projection.elements);
  }
});

test('replay samples saved ammo, optics, rearming and pads without filling absent historical fields', () => {
  const timeline = new ReplayTimeline(), older = drone(); delete older.ammo; delete older.cameraMode;
  older.equipment = { gun: true, armor: false, miner: false };
  const current = drone(); current.servicing = { padId: 'service-blue', remaining: 3, paid: 10 };
  timeline.append([{ type: 'frame', simTime: 0, drones: [older] }, { type: 'frame', simTime: 1, drones: [current], match: match() }]);
  const before = timeline.sample(0.5).frame!.drones[0];
  assert.equal(before.ammo, undefined); assert.equal(before.cameraMode, undefined); assert.equal(before.servicing, undefined);
  const after = timeline.sample(1).frame!;
  assert.equal(after.drones[0].ammo, 0); assert.equal(after.drones[0].cameraMode, 'zoom');
  assert.equal(after.drones[0].servicing!.remaining, 3); assert.equal(after.match!.servicePads![0].id, 'service-blue');
  assert.equal(before.equipment!.optics, undefined);
});

test('battery presentation uses equipped capacity, identifies low charge and preserves unknown historical battery', () => {
  const sample = drone();
  assert.equal(batteryPresentation(sample), undefined);
  sample.battery = 300;
  assert.deepEqual(batteryPresentation(sample), { charge: 300, capacity: 300, percent: 100, low: false });
  sample.equipment!.battery = true;
  assert.deepEqual(batteryPresentation(sample), { charge: 300, capacity: 600, percent: 50, low: false });
  sample.battery = 120;
  assert.deepEqual(batteryPresentation(sample), { charge: 120, capacity: 600, percent: 20, low: true });
  sample.battery = 0;
  assert.equal(batteryPresentation(sample)!.percent, 0);
  sample.battery = undefined;
  assert.equal(batteryPresentation(sample), undefined);
});

test('charging and rearming use their own durations and legacy service remains rearming', () => {
  const service = { padId: 'service-blue', remaining: 6, paid: 0 };
  assert.deepEqual(servicePresentation({ ...service, kind: 'recharge' }), { label: 'Charging', remaining: 6, progress: 0.5 });
  assert.deepEqual(servicePresentation({ ...service, kind: 'rearm', remaining: 4 }), { label: 'Rearming', remaining: 4, progress: 0.5 });
  assert.deepEqual(servicePresentation({ ...service, remaining: 4 }), { label: 'Rearming', remaining: 4, progress: 0.5 });
  assert.equal(servicePresentation(), undefined);
});

test('battery and jammer consume displayed module slots while armor and drill upgrade do not', () => {
  const sample = drone(); sample.equipment = { gun: false, armor: true, miner: false, minerUpgrade: true, battery: true, jammer: true };
  assert.equal(equippedModuleCount(sample), 2);
});

test('snapshot battery and jammer geometry restores without any modeled interference volume', () => {
  const scene = new THREE.Scene(), visuals = new DroneVisuals(scene), current = drone();
  current.equipment!.battery = true; current.equipment!.jammer = true; current.jamming = true;
  visuals.reconcile([current]);
  const mesh = scene.getObjectByName(current.id)!;
  assert.equal(mesh.getObjectByName('battery')!.visible, true); assert.equal(mesh.getObjectByName('jammer')!.visible, true);
  const bounds = new THREE.Box3().setFromObject(mesh.getObjectByName('jammer')!);
  assert.ok(bounds.getSize(new THREE.Vector3()).length() < 0.4, 'jammer is a physical onboard attachment only');
  const captured = structuredClone(current); captured.equipment!.battery = false; captured.equipment!.jammer = false; captured.jamming = false;
  assert.throws(() => visuals.withSnapshot('drone-2', [captured], () => {
    assert.equal(mesh.getObjectByName('battery')!.visible, false); assert.equal(mesh.getObjectByName('jammer')!.visible, false);
    throw new Error('capture failure');
  }), /capture failure/);
  assert.equal(mesh.getObjectByName('battery')!.visible, true); assert.equal(mesh.getObjectByName('jammer')!.visible, true);
  visuals.dispose();
});

test('recorded operations preserve unknown old state and report sampled charging and interference', () => {
  const old = drone(); delete old.ammo; delete old.cameraMode;
  assert.deepEqual(recordedOperations(old), []);
  const sample = drone(); sample.battery = 15; sample.jamming = false; sample.radioJammed = true;
  sample.servicing = { kind: 'recharge', padId: 'service-blue', remaining: 6, paid: 0 };
  const timeline = new ReplayTimeline();
  timeline.append([{ type: 'frame', simTime: 0, drones: [old] }, { type: 'frame', simTime: 1, drones: [sample] }]);
  assert.deepEqual(recordedOperations(timeline.sample(0.5).frame!.drones[0]), []);
  assert.deepEqual(recordedOperations(timeline.sample(1).frame!.drones[0]), ['0 rounds', 'Camera zoom', 'Battery 15% · LOW', 'Charging · 6.0s remaining', 'Jammer off', 'Radio jammed']);
});

test('replay identifies power loss without creating invalid counters or rewriting old causes', () => {
  const timeline = new ReplayTimeline();
  timeline.append([{ type: 'event', simTime: 2, event: { id: 'power-loss', simTime: 2, type: 'destroyed', cause: 'power', message: 'Power exhausted.' } }]);
  assert.equal(timeline.sample(1).metrics.power, undefined);
  const { metrics } = timeline.sample(2);
  assert.equal(metrics.deaths, 1); assert.equal(metrics.power, 1); assert.equal(metrics.unknown, 0);
  assert.ok(Object.values(metrics).every(Number.isFinite));
});

test('resource cube is grounded, visible from within, occluded normally and stable until completely depleted', () => {
  const scene = new THREE.Scene(), view = new CombatView(scene), state = match();
  state.resources[0].zoneSize = 6; state.resources[0].y = 0;
  view.update(state);
  const cube = scene.getObjectByName('salvage-test')!;
  assert.equal(cube.children.length, 2, 'only a translucent cube and its edges');
  assert.equal(cube.getObjectByName('stock'), undefined);
  const volume = cube.getObjectByName('zone-volume') as THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  const edges = cube.getObjectByName('zone-edges') as THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
  assert.equal(volume.material.side, THREE.DoubleSide); assert.equal(volume.material.transparent, true);
  assert.ok(volume.material.opacity > 0 && volume.material.opacity < 0.3);
  assert.equal(volume.material.depthTest, true); assert.equal(volume.material.depthWrite, false); assert.equal(edges.material.depthTest, true);
  const bounds = new THREE.Box3().setFromObject(cube);
  assert.deepEqual(bounds.min.toArray(), [-2, 0, -1]); assert.deepEqual(bounds.max.toArray(), [4, 6, 5]);
  assert.ok(new THREE.Raycaster(new THREE.Vector3(1, 3, 2), new THREE.Vector3(0, 0, 1)).intersectObject(volume).length, 'inside view can see a boundary face');
  state.resources[0].remaining = 1; view.update(state);
  assert.equal(scene.getObjectByName('salvage-test'), cube); assert.equal(cube.visible, true);
  assert.deepEqual(new THREE.Box3().setFromObject(cube), bounds);
  state.resources[0].remaining = 0; view.update(state); assert.equal(cube.visible, false);
  view.dispose();
});

test('snapshot zone size changes restore current resource and service cube geometry', () => {
  const scene = new THREE.Scene(), view = new CombatView(scene), current = match();
  current.resources[0].zoneSize = 6; current.servicePads![0].zoneSize = 6;
  view.update(current);
  const pad = scene.getObjectByName('service-blue')!;
  assert.equal(pad.children.length, 2); assert.deepEqual(new THREE.Box3().setFromObject(pad).getSize(new THREE.Vector3()).toArray(), [6, 6, 6]);
  const snapshot = structuredClone(current); snapshot.resources[0].zoneSize = 8; snapshot.servicePads![0].zoneSize = 4;
  assert.throws(() => view.withSnapshot(snapshot, () => {
    assert.equal(new THREE.Box3().setFromObject(scene.getObjectByName('salvage-test')!).getSize(new THREE.Vector3()).x, 8);
    assert.equal(new THREE.Box3().setFromObject(scene.getObjectByName('service-blue')!).getSize(new THREE.Vector3()).x, 4);
    throw new Error('capture failure');
  }), /capture failure/);
  assert.equal(new THREE.Box3().setFromObject(scene.getObjectByName('salvage-test')!).getSize(new THREE.Vector3()).x, 6);
  assert.equal(new THREE.Box3().setFromObject(scene.getObjectByName('service-blue')!).getSize(new THREE.Vector3()).x, 6);
  view.dispose();
});

test('automatic charging reports battery progress independently of timed rearming', () => {
  const sample = drone(); sample.charging = true; sample.battery = 150;
  sample.servicing = { kind: 'rearm', padId: 'service-blue', remaining: 3, paid: 10 };
  assert.deepEqual(chargingPresentation(sample), { label: 'AUTOCHARGING · 50%', progress: 50 });
  assert.equal(servicePresentation(sample.servicing)!.label, 'Rearming');
  sample.battery = 300;
  assert.deepEqual(chargingPresentation(sample), { label: 'CHARGED', progress: 100 });
  sample.charging = false; assert.equal(chargingPresentation(sample), undefined);
  delete sample.charging; assert.equal(chargingPresentation(sample), undefined);
});

test('recorded cube sizes distinguish current battery capacity from historical charge values', () => {
  const sample = drone(); sample.battery = 100;
  const legacy = match(), modern = match(); modern.resources[0].zoneSize = 6;
  assert.ok(recordedOperations(sample, legacy).includes('Battery 100%'));
  assert.ok(recordedOperations(sample, modern).includes('Battery 33%'));
  sample.equipment!.battery = true;
  assert.ok(recordedOperations(sample, legacy).includes('Battery 67%'));
  assert.ok(recordedOperations(sample, modern).includes('Battery 17% · LOW'));
  sample.charging = true;
  assert.ok(recordedOperations(sample, modern).includes('AUTOCHARGING · 17%'));
});
