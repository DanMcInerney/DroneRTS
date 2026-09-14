import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetGame } from '../server/game.ts';
import type { Pose } from '../shared/types.ts';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
};

async function ready() {
  const game = new FleetGame();
  game.setConnected(true); game.start();
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  for (const id of ['drone-1', 'drone-2', 'drone-3'] as const) await game.tool(id, 'observe');
  await game.forwardTeam('blue');
  return game;
}

const sample = async (_id: unknown, pose: Pose, simTime: number) => ({
  position: { x: pose.x, y: pose.y, z: pose.z }, heading: { degrees: (360 - pose.yaw) % 360 }, simTime,
});

test('a late hover acknowledgement cannot erase a newer route or leave its job running without motion', async t => {
  const game = await ready(), held = deferred();
  t.after(() => { held.resolve(); game.stop(); });
  game.vehicleTransport = {
    command: async (_id, args) => { if (args.kind === 'hover') await held.promise; return args; }, sample,
  };
  const hover = game.tool('drone-1', 'act', { mission: 1, kind: 'hover' });
  await flush();
  const drone = game.state.drones[0], target = { x: drone.x + 8, y: drone.y, z: drone.z };
  await game.tool(drone.id, 'route', { mission: 1, op: 'start', waypoints: [target] });
  await flush();
  const jobId = drone.job!.id;
  assert.deepEqual(drone.action?.target, target);
  held.resolve(); await hover;
  assert.equal(drone.job?.id, jobId);
  assert.equal(drone.job?.state, 'running');
  assert.deepEqual(drone.action?.target, target);
});

test('accepted rearming explicitly retires a route whose movement it stops', async t => {
  const game = await ready(); t.after(() => game.stop());
  const drone = game.state.drones[0];
  drone.equipment!.gun = true; drone.ammo = 0;
  await game.tool(drone.id, 'route', { mission: 1, op: 'start', waypoints: [{ x: drone.x + 8, y: drone.y, z: drone.z }] });
  await flush();
  assert.equal(drone.job?.state, 'running');
  const response = await game.tool(drone.id, 'rearm', { mission: 1 });
  assert.notEqual(response.isError, true);
  assert.equal(drone.servicing?.kind, 'rearm');
  assert.equal(drone.action, undefined);
  assert.equal(drone.job?.state, 'cancelled');
});

test('a delayed setpoint from a replaced objective cannot overwrite the new objective route', async t => {
  const game = await ready(), held = deferred();
  t.after(() => { held.resolve(); game.stop(); });
  let commands = 0;
  game.vehicleTransport = {
    command: async (_id, args) => { if (++commands === 1) await held.promise; return args; }, sample,
  };
  const drone = game.state.drones[0];
  drone.x = 0; // Keep both replacement targets inside any downtown launch layout.
  await game.tool(drone.id, 'route', { mission: 1, op: 'start', waypoints: [{ x: drone.x + 8, y: drone.y, z: drone.z }] });
  await flush();
  game.queueMission('New objective supplied by the player.'); await game.forwardTeam('blue');
  assert.equal(game.receivedMission(drone.id), 2);
  const target = { x: drone.x - 8, y: drone.y, z: drone.z };
  await game.tool(drone.id, 'route', { mission: 2, op: 'start', waypoints: [target] });
  await flush();
  const jobId = drone.job!.id;
  held.resolve(); await flush();
  assert.equal(drone.job?.id, jobId);
  assert.equal(drone.job?.mission, 2);
  assert.equal(drone.job?.state, 'running');
  assert.deepEqual(drone.action?.target, target);
});

test('a rejected routine replacement preserves the admitted movement writer', async t => {
  const game = await ready(); t.after(() => game.stop());
  const drone = game.state.drones[0], target = { x: drone.x + 8, y: drone.y, z: drone.z };
  game.onboardWorkspace(drone.id).write('notes.md', 'This is a note, not executable source.');
  await game.tool(drone.id, 'route', { mission: 1, op: 'start', waypoints: [target] });
  await flush();
  const jobId = drone.job!.id;
  const response = await game.tool(drone.id, 'routine', { mission: 1, op: 'start', path: 'notes.md', replace: true });
  const text = response.content.find(block => block.type === 'text');
  assert.ok(text && text.type === 'text');
  assert.ok(response.isError || JSON.parse(text.text).rejected);
  assert.equal(drone.job?.id, jobId);
  assert.equal(drone.job?.state, 'running');
  assert.deepEqual(drone.action?.target, target);
});
