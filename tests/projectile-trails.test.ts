import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RtsRules } from '../server/rts.ts';
import { CombatView } from '../client/combat-view.ts';
import { FleetScene } from '../client/scene.ts';
import { PROJECTILE_SMOKE, projectileSmoke, projectileTrails } from '../client/projectile-trail-model.ts';
import { emptyEquipment, RTS_CONFIG, type MatchEvent, type MatchState, type Point } from '../shared/rts.ts';
import type { Drone, GameState } from '../shared/types.ts';

const origin: Point = { x: 1, y: 10, z: 3 }, velocity: Point = { x: 32, y: 0, z: 0 };
const position = (age: number): Point => ({ x: origin.x + velocity.x * age, y: origin.y - RTS_CONFIG.bulletGravity * age * age / 2, z: origin.z });
const fired: MatchEvent = { id: 'fire', type: 'fired', projectileId: 'shot', simTime: 10, ...origin, message: '' };
const match = (age = 1): MatchState => ({
  rulesVersion: 'cargo-v3', phase: 'active', winner: null,
  teams: { blue: { credits: 0, earned: 0, shopUnlocked: true }, red: { credits: 0, earned: 0, shopUnlocked: true } },
  resources: [], servicePads: [], events: [fired],
  projectiles: [{ id: 'shot', owner: 'drone-1', team: 'blue', ...position(age), vx: velocity.x, vy: -RTS_CONFIG.bulletGravity * age, vz: velocity.z, age }],
});
const endedMatch = (age = .53) => {
  const current = match(age); current.projectiles = [];
  current.events.push({ id: 'impact', type: 'impact', projectileId: 'shot', simTime: 10 + Math.ceil(age / .05) * .05, ...position(age), message: '' });
  return current;
};
const smoke = (scene: THREE.Scene) => scene.getObjectByName('projectile-white-smoke') as THREE.InstancedMesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('white smoke follows only the travelled ballistic path and reconstructs deterministically without mutating a snapshot', () => {
  const current = match(), copy = structuredClone(current), trail = projectileTrails(current, 11)[0];
  assert.deepEqual(trail.origin, origin); assert.deepEqual(trail.velocity, velocity);
  assert.equal(trail.startedAt, 10); assert.equal(trail.endedAt, 11);
  const early = projectileSmoke(trail, 11), later = projectileSmoke(trail, 13);
  assert.ok(early.length > 10); assert.equal(early.length, later.length);
  assert.ok(early[0].start.x < early.at(-1)!.end.x); close(early.at(-1)!.end.x, position(1).x);
  close(early.at(-1)!.end.y, position(1).y);
  assert.ok(later[0].radius > early[0].radius); assert.ok(later[0].opacity < early[0].opacity);
  assert.ok(later[0].start.y > early[0].start.y, 'spent smoke drifts upward');
  assert.deepEqual(projectileSmoke(trail, 11), early); assert.deepEqual(projectileSmoke(trail, 9), []);
  assert.deepEqual(projectileSmoke(trail, 11 + PROJECTILE_SMOKE.lifetime + .01), []);
  assert.deepEqual(current, copy);
});

test('recorded impacts preserve a lingering trail ending at actual contact, including shots between broadcasts', () => {
  const current = endedMatch(), trail = projectileTrails(current, 11)[0];
  close(trail.endedAt, 10.53); close(trail.velocity.x, 32); close(trail.velocity.y, 0);
  const end = projectileSmoke(trail, trail.endedAt).at(-1)!.end;
  close(end.x, position(.53).x); close(end.y, position(.53).y); close(end.z, position(.53).z);
  assert.ok(projectileSmoke(trail, 12).length > 0);
  assert.deepEqual(projectileTrails(current, 10.54), [], 'an impact not present at acquisition time cannot supply a trajectory');
  current.events = current.events.filter(event => event.type !== 'fired');
  assert.deepEqual(projectileTrails(current, 11), [], 'missing launch history cannot invent a route');
});

test('actual gravity integration, lethal hits and immediate victory retain a fading visual without changing combat', () => {
  const rules = new RtsRules();
  const drones: Drone[] = ['drone-1', 'drone-4'].map((id, index) => ({
    id: id as Drone['id'], team: index ? 'red' : 'blue', x: 0, y: 5, z: index ? 0 : 5,
    yaw: 0, pitch: 0, alive: true, online: true, observations: 0, status: '', equipment: emptyEquipment(), cargo: { amount: 0 }, ammo: 0,
  }));
  const state: GameState = { simTime: 0, mission: 1, running: true, speed: 1, completed: false, drones, obstacles: [], treasures: [], radio: [],
    runtime: { status: 'idle', message: '', model: '', effort: '' }, match: rules.newMatch([]) };
  rules.begin(state); drones[0].equipment!.gun = true; drones[0].ammo = 12; rules.fire(state, drones[0]);
  for (let n = 0; n < 4; n++) { state.simTime += .05; rules.step(state, .05); }
  assert.equal(state.completed, true); assert.equal(drones[1].alive, false); assert.equal(drones[0].ammo, 11); assert.equal(state.match!.projectiles.length, 0);
  const trail = projectileTrails(state.match, state.simTime)[0]; assert.ok(trail);
  const impact = state.match!.events.find(event => event.type === 'impact')!, last = projectileSmoke(trail, trail.endedAt).at(-1)!.end;
  close(last.x, impact.x!); close(last.y, impact.y!); close(last.z, impact.z!);
  assert.ok(projectileSmoke(trail, state.simTime + 2).length > 0);
  rules.begin(state); assert.deepEqual(projectileTrails(state.match, state.simTime), []);
});

test('recovered impact arcs agree with actual server integration across upward, level and downward shots', context => {
  let maxError = 0, maxEndpointError = 0;
  for (const pitch of [-65, -20, 0, 20, 65]) {
    const rules = new RtsRules();
    const drones: Drone[] = ['drone-1', 'drone-4'].map((id, index) => ({
      id: id as Drone['id'], team: index ? 'red' : 'blue', x: index ? 50 : 0, y: 12, z: index ? 50 : 5,
      yaw: 0, pitch, alive: true, online: true, observations: 0, status: '', equipment: emptyEquipment(), cargo: { amount: 0 }, ammo: 0,
    }));
    const state: GameState = { simTime: 10, mission: 1, running: true, speed: 1, completed: false, drones,
      obstacles: [{ x: 0, z: 0, width: 30, depth: 1, height: 30 }], treasures: [], radio: [],
      runtime: { status: 'idle', message: '', model: '', effort: '' }, match: rules.newMatch([]) };
    rules.begin(state); drones[0].equipment!.gun = true; drones[0].ammo = 12; rules.fire(state, drones[0]);
    const samples: { point: Point; age: number }[] = [];
    for (let index = 0; index < 20 && state.match!.projectiles.length; index++) {
      state.simTime += .05; rules.step(state, .05);
      const shot = state.match!.projectiles[0]; if (shot) samples.push({ point: { x: shot.x, y: shot.y, z: shot.z }, age: shot.age });
    }
    assert.equal(state.match!.projectiles.length, 0);
    const trail = projectileTrails(state.match, state.simTime)[0]; assert.ok(trail);
    for (const sample of samples) {
      const t = sample.age;
      const reconstructed = { x: trail.origin.x + trail.velocity.x * t,
        y: trail.origin.y + trail.velocity.y * t - RTS_CONFIG.bulletGravity * t * t / 2, z: trail.origin.z + trail.velocity.z * t };
      maxError = Math.max(maxError, Math.hypot(reconstructed.x - sample.point.x, reconstructed.y - sample.point.y, reconstructed.z - sample.point.z));
    }
    const contact = state.match!.events.find(event => event.type === 'impact')!, last = projectileSmoke(trail, trail.endedAt).at(-1)!.end;
    maxEndpointError = Math.max(maxEndpointError, Math.hypot(last.x - contact.x!, last.y - contact.y!, last.z - contact.z!));
  }
  assert.ok(maxError < .000021, 'only the server microstep contact-chord sag approximation may differ');
  assert.ok(maxEndpointError < 1e-8, 'the smoke must terminate at the recorded contact');
  context.diagnostic(`Maximum reconstructed arc error ${maxError} world units; contact endpoint error ${maxEndpointError}.`);
});

test('fixed history and draw bounds apply under heavy fire; absent, future and historical matches emit no smoke', () => {
  const current = match(4), original = current.projectiles[0];
  current.projectiles = Array.from({ length: 200 }, (_, index) => ({ ...original, id: `shot-${index}` })); current.events = [];
  const trails = projectileTrails(current, 14);
  assert.equal(trails.length, PROJECTILE_SMOKE.maxTrails);
  assert.ok(trails.flatMap(trail => projectileSmoke(trail, 14)).length <= PROJECTILE_SMOKE.maxTrails * PROJECTILE_SMOKE.segmentsPerTrail);
  assert.deepEqual(projectileTrails(undefined, 11), []);
  assert.deepEqual(projectileTrails(match(), 9), [], 'a known future launch cannot be mistaken for missing history');
  assert.deepEqual(projectileTrails({ ...current, rulesVersion: 'cargo-v2' }, 14), []);
  assert.deepEqual(projectileTrails(endedMatch(), 9), []);
  assert.deepEqual(projectileTrails(endedMatch(), 17), []);
});

test('depth-tested white smoke is bounded, stops emitting at impact, freezes independently of lights and disposes once', () => {
  const scene = new THREE.Scene(), view = new CombatView(scene); view.update(endedMatch(), 11);
  const mesh = smoke(scene); assert.ok(mesh.count > 0);
  assert.equal(mesh.material.depthTest, true); assert.equal(mesh.material.depthWrite, false); assert.equal(mesh.material.fog, true);
  assert.equal(mesh.material.uniforms.tint.value.getHexString(), 'f3f5f4');
  assert.equal(mesh.instanceMatrix.count, PROJECTILE_SMOKE.maxTrails * PROJECTILE_SMOKE.segmentsPerTrail);
  const positions = mesh.geometry.getAttribute('trailStart').array.slice(), style = mesh.geometry.getAttribute('trailStyle').array.slice();
  view.animate(100, 11);
  assert.deepEqual(mesh.geometry.getAttribute('trailStart').array, positions); assert.deepEqual(mesh.geometry.getAttribute('trailStyle').array, style);
  view.animate(101, 13); assert.ok(mesh.geometry.getAttribute('trailStyle').getX(0) > style[0]);
  view.update({ ...match(0), projectiles: [], events: [] }, 0); assert.equal(mesh.count, 0); assert.equal(mesh.visible, false);
  let geometryDisposals = 0, materialDisposals = 0;
  mesh.geometry.addEventListener('dispose', () => geometryDisposals++); mesh.material.addEventListener('dispose', () => materialDisposals++);
  view.dispose(); assert.equal(scene.children.length, 0); assert.equal(geometryDisposals, 1); assert.equal(materialDisposals, 1);
});

test('past or absent acquisitions never inherit later smoke and exactly restore a live extrapolated frame on failure', () => {
  const scene = new THREE.Scene(), view = new CombatView(scene), current = match(); current.events = [];
  view.update(current, 11); view.animate(30, 11.1);
  const mesh = smoke(scene), count = mesh.count;
  const starts = mesh.geometry.getAttribute('trailStart').array.slice(0, count * 3), styles = mesh.geometry.getAttribute('trailStyle').array.slice(0, count * 3);
  assert.throws(() => view.withSnapshot(undefined, () => { assert.equal(mesh.count, 0); throw new Error('capture failed'); }, 9), /capture failed/);
  assert.equal(mesh.count, count); assert.deepEqual(mesh.geometry.getAttribute('trailStart').array.slice(0, count * 3), starts);
  assert.deepEqual(mesh.geometry.getAttribute('trailStyle').array.slice(0, count * 3), styles);
  view.dispose();
});

test('production camera boundary uses its supplied shot snapshot/time and restores smoke after renderer failure', () => {
  const scene = new THREE.Scene(), view = new CombatView(scene), current = endedMatch(); view.update(current, 12);
  const mesh = smoke(scene), live = mesh.geometry.getAttribute('trailStyle').array.slice(0, mesh.count * 3);
  const fleet = Object.create(FleetScene.prototype) as FleetScene;
  Object.assign(fleet, {
    captureCamera: new THREE.PerspectiveCamera(53), state: { drones: [], obstacles: [], match: current, simTime: 12 }, combat: view,
    wrecks: { withSnapshot: (_match: unknown, _obstacles: unknown, _time: number, render: () => void) => render() },
    drones: { withSnapshot: (_id: unknown, _drones: unknown, render: () => void) => render() },
    renderer: {
      getRenderTarget: () => null, getViewport: (value: THREE.Vector4) => value, getScissor: (value: THREE.Vector4) => value, getScissorTest: () => false,
      setRenderTarget() {}, setViewport() {}, setScissor() {}, setScissorTest() {},
      render: () => { assert.equal(mesh.count, 0); throw new Error('renderer unavailable'); },
    },
  });
  assert.throws(() => fleet.capture('drone-1', { x: 0, y: 10, z: 0, yaw: 0, pitch: 0 }, [], { ...current, events: [] }, 9), /renderer unavailable/);
  assert.deepEqual(mesh.geometry.getAttribute('trailStyle').array.slice(0, mesh.count * 3), live); view.dispose();
});
