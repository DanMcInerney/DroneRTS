import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FleetGame } from '../server/game.ts';
import { RtsRules } from '../server/rts.ts';
import { TeamSession } from '../server/team-session.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';
import type { RadioMessage, ToolResult } from '../shared/types.ts';

const projectDir = resolve(import.meta.dirname, '..');
const body = (result: ToolResult) => JSON.parse((result.content[0] as { text: string }).text);

async function eventually(predicate: () => boolean, label: string, details?: () => unknown) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(40);
  }
  assert.fail(`Timed out: ${label}${details ? `; ${JSON.stringify(details())}` : ''}`);
}

test('historical interference partitions native Zenoh while cameras and flight continue and queued team traffic resumes exactly once', { timeout: 45_000 }, async t => {
  const game = new FleetGame(); game.setConnected(true); game.start(); game.state.obstacles = [];
  game.state.match!.rulesVersion = 'cube-v1';
  const historicalRules = new RtsRules();
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  const xs = [0, 3, 100, 6, 200, 230];
  game.state.drones.forEach((drone, index) => Object.assign(drone, { x: xs[index], y: 2, z: 0 }));
  // Bootstrap only the deterministic fixture; no native runtime actor performs inference.
  for (const id of MATCH_DRONE_IDS) await game.tool(id, 'observe');
  await game.forwardTeam('blue'); await game.forwardTeam('red');
  for (const id of MATCH_DRONE_IDS) await game.tool(id, 'observe');
  const failures: string[] = [], events: any[] = [], states: any[] = [];
  const session = new TeamSession({ projectDir, game, onStatus: () => {}, onNetwork: state => states.push(state),
    onEvent: (_type, event) => events.push(event), onFailure: message => failures.push(message) }, {
    runtime: () => ({ start: async () => {}, stop: async () => {}, retireDrone: async () => {}, refreshTools: async () => {} }),
    vehicle: () => ({ start: async () => {}, stop: async () => {}, command: async (_id, args) => args,
      sample: async (_id, pose, simTime) => ({ position: { x: pose.x, y: pose.y, z: pose.z },
        velocity: { x: 0, y: 0, z: 0 }, cameraOrientation: { heading: (360 - pose.yaw) % 360, pitch: pose.pitch },
        heading: { degrees: (360 - pose.yaw) % 360 }, simTime }) }),
  });
  t.after(async () => {
    await session.stop(); game.stop();
    const root = resolve(projectDir, 'artifacts', 'network'), directory = resolve(root, game.sessionIdentity);
    assert.ok(directory.startsWith(root + sep), 'cleanup remains within this fixture network directory');
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await session.start();
  await eventually(() => states.at(-1)?.peers.every((peer: any) => peer.online && peer.peers === 3), 'both native team domains connect');
  game.state.drones[0].equipment!.jammer = true;
  // Exercise the retained historical rule directly; cargo actors have no jam tool.
  historicalRules.jam(game.state, game.state.drones[0], true);
  const jam = body(await game.tool('drone-1', 'observe'));
  assert.equal(jam.jamming, true); assert.equal(jam.radioJammed, true); assert.equal(jam.sensors.camera.available, true);
  assert.equal(jam.availableTools.includes('jam'), false);
  await session.reconcileRadio();
  await eventually(() => states.at(-1)?.peers.filter((peer: any) => !peer.online).map((peer: any) => peer.id).sort().join(',') === 'drone-1,drone-2,drone-4', 'self, friendly and enemy native radios partition');
  assert.ok(game.state.drones.every(drone => drone.alive !== false));

  const outgoing = body(await game.tool('drone-1', 'send', { mission: 1, to: 'all', kind: 'chat', text: 'Queued from an isolated sender' }));
  const incoming = body(await game.tool('drone-3', 'send', { mission: 1, to: 'drone-1', kind: 'chat', text: 'Queued to an isolated receiver' }));
  const red = body(await game.tool('drone-5', 'send', { mission: 1, to: 'all', kind: 'chat', text: 'Independent red team message' }));
  assert.ok(outgoing.queued); assert.ok(incoming.queued); assert.ok(red.queued);
  const operator: RadioMessage = { protocol: 'fleet-radio/1', sessionId: game.sessionIdentity, id: `${game.sessionIdentity}:jammed-operator`,
    sequence: 999, sentAt: new Date().toISOString(), from: 'player', to: 'all', kind: 'mission', mission: 1, simTime: game.state.simTime, text: 'Queued original instruction' };
  await session.radio.sendTeam('blue', operator);
  const delivered = (id: string) => events.filter(event => event.event === 'received' && event.message?.id === id);
  await eventually(() => delivered(red.queued).length === 1 && delivered(operator.id).length === 1, 'unaffected peers receive within their own teams');
  await delay(350);
  assert.equal(delivered(outgoing.queued).length, 0); assert.equal(delivered(incoming.queued).length, 0);
  assert.deepEqual(delivered(red.queued).map(event => event.drone), ['drone-6']);
  assert.deepEqual(delivered(operator.id).map(event => event.drone), ['drone-3']);
  const observed = body(await game.tool('drone-1', 'observe'));
  assert.equal(observed.sensors.camera.available, true); assert.equal(observed.radioJammed, true);
  const drone = game.state.drones[0];
  const moving = body(await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 0, y: 2, z: -1 }));
  assert.equal(moving.accepted, true);
  await eventually(() => drone.job?.state === 'running', 'isolated local flight is admitted');
  for (let step = 0; drone.action && step < 40; step++) game.tick(0.1);
  assert.equal(drone.job?.state, 'completed'); assert.equal(drone.z, -1); assert.equal(drone.radioJammed, true);

  historicalRules.jam(game.state, drone, false);
  assert.equal(body(await game.tool('drone-1', 'observe')).jamming, false);
  await session.reconcileRadio();
  await eventually(() => delivered(outgoing.queued).length === 3 && delivered(incoming.queued).length === 1
    && delivered(red.queued).length === 2 && delivered(operator.id).length === 3, 'clearing automatic interference drains native durable outboxes',
    () => ({ outgoing: delivered(outgoing.queued).map(event => event.drone), incoming: delivered(incoming.queued).map(event => event.drone),
      red: delivered(red.queued).map(event => event.drone), operator: delivered(operator.id).map(event => event.drone), failures }));
  await delay(400);
  assert.deepEqual(delivered(outgoing.queued).map(event => event.drone).sort(), ['drone-2', 'drone-3', 'operator']);
  assert.deepEqual(delivered(incoming.queued).map(event => event.drone), ['drone-1']);
  assert.deepEqual(delivered(red.queued).map(event => event.drone).sort(), ['drone-4', 'drone-6']);
  assert.deepEqual(delivered(operator.id).map(event => event.drone).sort(), ['drone-1', 'drone-2', 'drone-3']);
  assert.deepEqual(failures, []);
});
