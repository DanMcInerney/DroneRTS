import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { GunWreck, MatchState } from '../shared/rts.ts';
import type { Obstacle } from '../shared/types.ts';
import { WRECK_VISUALS, wreckDisplayTime, wreckPose, wreckSmoke, wreckTrajectory } from '../client/wreck-model.ts';
import { WreckView } from '../client/wreck-view.ts';
import { FleetScene } from '../client/scene.ts';

const seed = (extra: Partial<GunWreck> = {}): GunWreck => ({ drone: 'drone-4', x: 0, y: 12, z: 0, yaw: 27, startedAt: 10, ...extra });
const match = (wrecks = [seed()]): MatchState => ({
  rulesVersion: 'cargo-v3', phase: 'active', winner: null,
  teams: { blue: { credits: 0, earned: 0, shopUnlocked: true }, red: { credits: 0, earned: 0, shopUnlocked: true } },
  resources: [], servicePads: [], projectiles: [], events: [], wrecks,
});
const roof: Obstacle = { x: 0, z: 0, width: 6, depth: 6, height: 4 };

test('gun wreck starts at the acquired death pose, tumbles, falls and stops on the first roof', () => {
  const trajectory = wreckTrajectory(seed(), [roof]);
  assert.equal(wreckPose(trajectory, 9), undefined);
  assert.equal(wreckPose(trajectory, 10)!.y, 12);
  const first = wreckPose(trajectory, 11)!, next = wreckPose(trajectory, 12)!;
  assert.ok(first.y > next.y && next.y > roof.height);
  assert.notEqual(first.pitch, next.pitch); assert.notEqual(first.roll, next.roll);
  assert.equal(first.x, 0); assert.equal(first.z, 0);
  const landed = wreckPose(trajectory, 30)!;
  assert.equal(landed.landed, true); assert.equal(landed.y, roof.height + WRECK_VISUALS.clearance);
  assert.deepEqual(wreckPose(trajectory, 1000), landed);
});

test('fall intersects rotated roof tiers and ground without landing on a roof above or outside the footprint', () => {
  const tier: Obstacle = { x: 0, z: 0, width: 2, depth: 2, baseY: 4, height: 3 };
  assert.equal(wreckTrajectory(seed(), [roof, tier]).floor, 7 + WRECK_VISUALS.clearance);
  assert.equal(wreckTrajectory(seed({ x: 2 }), [roof, tier]).floor, 4 + WRECK_VISUALS.clearance);
  assert.equal(wreckTrajectory(seed({ x: 9 }), [roof, tier]).floor, WRECK_VISUALS.clearance);
  assert.equal(wreckTrajectory(seed({ y: 5 }), [roof, tier]).floor, 4 + WRECK_VISUALS.clearance);
  const rotated: Obstacle = { x: 0, z: 0, width: 6, depth: 1, height: 4, rotation: 45 };
  assert.equal(wreckTrajectory(seed({ x: 1.5, z: -1.5 }), [rotated]).floor, 4 + WRECK_VISUALS.clearance);
  assert.equal(wreckTrajectory(seed({ x: 1.5, z: 1.5 }), [rotated]).floor, WRECK_VISUALS.clearance);
});

test('smoke follows past falling positions, expands and fades with finite post-impact emission', () => {
  const trajectory = wreckTrajectory(seed(), []);
  assert.deepEqual(wreckSmoke(trajectory, 9), []);
  const early = wreckSmoke(trajectory, 12), later = wreckSmoke(trajectory, 15);
  assert.ok(early.length > 1);
  const emittedAt = early[2].emittedAt, first = early.find(puff => puff.emittedAt === emittedAt)!, aged = later.find(puff => puff.emittedAt === emittedAt)!;
  assert.ok(aged.radius > first.radius); assert.ok(aged.opacity < first.opacity);
  assert.ok(early[0].y > early.at(-1)!.y, 'trail is distributed along the prior descent');
  assert.ok(early.every(puff => puff.emittedAt <= 12 && puff.opacity >= 0));
  const end = trajectory.seed.startedAt + trajectory.duration + WRECK_VISUALS.smolderDuration;
  assert.ok(wreckSmoke(trajectory, end + 1).length > 0);
  assert.deepEqual(wreckSmoke(trajectory, end + WRECK_VISUALS.smokeLifetime + .1), []);
  for (let at = 10; at < 40; at += .1) assert.ok(wreckSmoke(trajectory, at).length <= WRECK_VISUALS.particlesPerDrone);
  assert.deepEqual(wreckSmoke(trajectory, 12), early, 'rewinding acquisitions is deterministic');
});

test('spectator wrecks finish after victory while stopped/paused wrecks freeze and snapshot time stays independent', () => {
  const current = { simTime: 20, running: true, speed: 2, match: match() };
  assert.equal(wreckDisplayTime(current, .025), 20.05);
  assert.equal(wreckDisplayTime(current, 3), 20.2);
  assert.equal(wreckDisplayTime(current, 100), 20.2, 'stalled simulation cannot extrapolate a whole fall');
  current.running = false;
  assert.equal(wreckDisplayTime(current, 3), 20); assert.equal(wreckDisplayTime(current, 100), 20);
  current.match.phase = 'finished';
  assert.equal(wreckDisplayTime(current, 3), 23); assert.equal(wreckDisplayTime(current, 100), 52);
  const trajectory = wreckTrajectory(seed(), []);
  assert.notEqual(wreckPose(trajectory, wreckDisplayTime(current, 3))!.y, wreckPose(trajectory, 12)!.y);
});

test('wreck visuals are unlit debris with bounded depth-tested smoke, and reset/dispose release their resources', () => {
  const scene = new THREE.Scene(), view = new WreckView(scene);
  view.update(match(), [], 12);
  const body = scene.getObjectByName('gun-wreck-drone-4')!;
  assert.equal(body.visible, true); assert.equal(body.getObjectByName('carried-cargo'), undefined); assert.equal(body.getObjectByName('drone-beacons'), undefined);
  let disposed = 0;
  body.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of [object.material].flat() as THREE.MeshStandardMaterial[]) assert.equal(material.emissiveIntensity, 0);
  });
  (body.children[0] as THREE.Mesh).geometry.addEventListener('dispose', () => { disposed++; });
  const smoke = scene.getObjectByName('gun-wreck-smoke') as THREE.InstancedMesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  assert.ok(smoke.count > 0 && smoke.count <= WRECK_VISUALS.particlesPerDrone);
  assert.equal(smoke.material.depthTest, true); assert.equal(smoke.material.depthWrite, false); assert.equal(smoke.material.transparent, true);
  assert.equal(smoke.instanceMatrix.count, WRECK_VISUALS.maxWrecks * WRECK_VISUALS.particlesPerDrone);
  view.update(match([]), [], 0); assert.equal(scene.getObjectByName('gun-wreck-drone-4'), undefined); assert.equal(smoke.count, 0); assert.equal(disposed, 1);
  view.dispose(); assert.equal(scene.children.length, 0); assert.equal(disposed, 1);
});

test('older/absent wreck snapshots never inherit newer smoke and restore the exact display state after failure', () => {
  const scene = new THREE.Scene(), view = new WreckView(scene), current = match();
  view.update(current, [roof], 13);
  const position = scene.getObjectByName('gun-wreck-drone-4')!.position.clone();
  const smoke = scene.getObjectByName('gun-wreck-smoke') as THREE.InstancedMesh;
  const count = smoke.count, matrices = smoke.instanceMatrix.array.slice(0, count * 16);
  view.withSnapshot(match([]), [], 9, () => {
    assert.equal(scene.getObjectByName('gun-wreck-drone-4'), undefined); assert.equal(smoke.count, 0);
  });
  assert.deepEqual(scene.getObjectByName('gun-wreck-drone-4')!.position, position);
  assert.throws(() => view.withSnapshot(current, [], 11, () => {
    assert.ok(scene.getObjectByName('gun-wreck-drone-4')!.position.y > position.y);
    throw new Error('capture failed');
  }), /capture failed/);
  assert.deepEqual(scene.getObjectByName('gun-wreck-drone-4')!.position, position);
  assert.equal(smoke.count, count); assert.deepEqual(smoke.instanceMatrix.array.slice(0, count * 16), matrices);
  view.withSnapshot(current, [], 9, () => { assert.equal(scene.getObjectByName('gun-wreck-drone-4')!.visible, false); assert.equal(smoke.count, 0); });
  const legacy = { ...current, rulesVersion: 'cargo-v2' as const };
  view.withSnapshot(legacy, [], 12, () => { assert.equal(scene.getObjectByName('gun-wreck-drone-4'), undefined); assert.equal(smoke.count, 0); });
  view.dispose();
});

test('the production capture boundary uses its supplied death metadata and time, restoring live wrecks on renderer failure', () => {
  const world = new THREE.Scene(), view = new WreckView(world), current = match();
  view.update(current, [roof], 13);
  const original = world.getObjectByName('gun-wreck-drone-4')!.position.clone();
  const camera = new THREE.PerspectiveCamera(53), fleet = Object.create(FleetScene.prototype) as FleetScene;
  Object.assign(fleet, {
    captureCamera: camera, state: { drones: [], obstacles: [roof], match: current, simTime: 13 }, wrecks: view,
    combat: { withSnapshot: (_match: unknown, render: () => void) => render() },
    drones: { withSnapshot: (_id: unknown, _drones: unknown, render: () => void) => render() },
    renderer: {
      getRenderTarget: () => null, getViewport: (value: THREE.Vector4) => value, getScissor: (value: THREE.Vector4) => value, getScissorTest: () => false,
      setRenderTarget() {}, setViewport() {}, setScissor() {}, setScissorTest() {},
      render: () => { assert.equal(world.getObjectByName('gun-wreck-drone-4')!.position.y, wreckPose(wreckTrajectory(seed(), [roof]), 11)!.y); throw new Error('renderer unavailable'); },
    },
  });
  assert.throws(() => fleet.capture('drone-1', { x: 0, y: 14, z: 4, yaw: 0, pitch: 0 }, [], current, 11), /renderer unavailable/);
  assert.deepEqual(world.getObjectByName('gun-wreck-drone-4')!.position, original); view.dispose();
});
