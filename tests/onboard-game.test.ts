import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { FleetGame } from '../server/game.ts';
import type { ToolResult } from '../shared/types.ts';

const body = (result: ToolResult) => JSON.parse(result.content.find(item => item.type === 'text')!.text);
async function ready() {
  const game = new FleetGame(); let captures = 0;
  game.setConnected(true); game.start();
  // Deterministic camera fixture only. Authored source still executes in the production WASM worker.
  game.capture = async () => { captures++; return 'data:image/jpeg;base64,AQID'; };
  for (const id of ['drone-1', 'drone-2', 'drone-3'] as const) await game.tool(id, 'observe');
  await game.forwardTeam('blue');
  return { game, captures: () => captures };
}
async function until(check: () => boolean, timeout = 5000): Promise<void> {
  const expires = performance.now() + timeout;
  while (performance.now() < expires) { if (check()) return; await delay(10); }
  assert.fail('Onboard fixture did not reach the expected state before its bounded deadline.');
}
async function source(game: FleetGame, content: string) {
  const written = await game.tool('drone-1', 'workspace', { mission: 1, op: 'write', path: 'entry.js', content });
  assert.notEqual(written.isError, true, JSON.stringify(body(written)));
}

test('game workspace and real routine tools save only own telemetry with one camera per model boundary', async t => {
  const { game, captures } = await ready(); t.after(() => game.stop());
  await source(game, 'const own = await drone.telemetry(); const camera = await drone.camera(); await drone.files.write("sample.json", JSON.stringify({own, camera}));');
  const before = captures();
  const result = await game.tool('drone-1', 'routine', { mission: 1, op: 'start', path: 'entry.js' });
  assert.equal(body(result).routine.state, 'accepted'); assert.equal(captures() - before, 1);
  await until(() => game.state.drones[0].job?.state === 'completed');
  assert.equal(captures() - before, 1, 'internal sensor/file/camera SDK calls must not encode additional model images');
  const saved = JSON.parse(game.onboardWorkspace('drone-1').read('sample.json'));
  assert.equal(saved.own.position.x, game.state.drones[0].x);
  for (const key of ['drones', 'resources', 'obstacles', 'match', 'enemy', 'deposits']) assert.equal(saved.own[key], undefined);
  assert.throws(() => game.onboardWorkspace('drone-2').read('sample.json'), /does not exist/);
  const observed = body(await game.tool('drone-1', 'workspace', { mission: 1, op: 'read', path: 'sample.json' }));
  assert.equal(typeof observed.workspace.content, 'string'); assert.ok(observed.storage.runtime.usedBytes > 1_000_000);
});

test('a routine owns movement until explicit direct replacement and cancelled code never resumes', async t => {
  const { game } = await ready(); t.after(() => game.stop());
  const drone = game.state.drones[0];
  drone.x = 0; // This ownership fixture needs room for both opposing targets.
  await source(game, 'await drone.act({kind:"fly_to",...input.target}); await drone.files.write("started.md","yes"); await drone.sleep(700); await drone.files.write("late.md","invalid");');
  await game.tool(drone.id, 'routine', { mission: 1, op: 'start', path: 'entry.js', input: { target: { x: drone.x + 8, y: drone.y, z: drone.z } } });
  await until(() => game.onboardWorkspace(drone.id).list().some(file => file.path === 'started.md'));
  const originalAction = drone.action?.id;
  const rejected = body(await game.tool(drone.id, 'act', { mission: 1, kind: 'fly_to', x: drone.x - 8, y: drone.y, z: drone.z }));
  assert.equal(rejected.rejected, true); assert.equal(drone.action?.id, originalAction);
  const replaced = body(await game.tool(drone.id, 'act', { mission: 1, kind: 'fly_to', x: drone.x - 8, y: drone.y, z: drone.z, replace: true }));
  assert.equal(replaced.accepted, true); await delay(800);
  assert.equal(drone.action?.target?.x, drone.x - 8);
  assert.throws(() => game.onboardWorkspace(drone.id).read('late.md'), /does not exist/);
  const status = body(await game.tool(drone.id, 'routine', { mission: 1, op: 'status' }));
  assert.equal(status.routine.state, 'cancelled');
});

test('queued objectives preserve current execution until received; receipt cancels before later effects', async t => {
  const { game } = await ready(); t.after(() => game.stop());
  await source(game, 'await drone.files.write("started.md","yes"); await drone.sleep(700); await drone.files.write("late.md","invalid");');
  await game.tool('drone-1', 'routine', { mission: 1, op: 'start', path: 'entry.js' });
  await until(() => game.onboardWorkspace('drone-1').list().some(file => file.path === 'started.md'));
  game.queueMission('A fresh player objective.');
  assert.equal(game.receivedMission('drone-1'), 1); assert.equal(game.state.drones[0].job?.state, 'running');
  await game.forwardTeam('blue'); assert.equal(game.receivedMission('drone-1'), 2);
  assert.equal(game.state.drones[0].job?.state, 'cancelled'); await delay(800);
  assert.throws(() => game.onboardWorkspace('drone-1').read('late.md'), /does not exist/);
});

test('Stop revokes execution and a fresh match starts an empty private workspace', async t => {
  const { game } = await ready(); t.after(() => game.stop());
  await source(game, 'await drone.sleep(700); await drone.files.write("late.md","invalid");');
  const previous = game.onboardWorkspace('drone-1');
  await game.tool('drone-1', 'routine', { mission: 1, op: 'start', path: 'entry.js' });
  game.stop(); assert.equal(game.state.drones[0].job?.state, 'cancelled');
  const stopped = body(await game.tool('drone-1', 'workspace', { mission: 1, op: 'write', path: 'forbidden.md', content: 'x' }));
  assert.equal(stopped.stopped, true);
  game.start(); assert.deepEqual(game.onboardWorkspace('drone-1').list(), []);
  assert.throws(() => previous.read('entry.js'), /revoked/);
  await delay(800); assert.deepEqual(game.onboardWorkspace('drone-1').list(), []);
});

test('destruction terminates the worker and revokes its workspace while other drones remain independent', async t => {
  const { game } = await ready(); t.after(() => game.stop());
  await source(game, 'await drone.sleep(700); await drone.files.write("late.md","invalid");');
  const workspace = game.onboardWorkspace('drone-1');
  await game.tool('drone-1', 'routine', { mission: 1, op: 'start', path: 'entry.js' });
  const drone = game.state.drones[0]; drone.equipment!.armor = false;
  Object.assign(game.state.drones[1], { x: drone.x, y: drone.y, z: drone.z });
  game.tick(0.05); assert.equal(drone.alive, false); assert.equal(drone.job?.state, 'cancelled');
  assert.equal(workspace.status().revoked, true); assert.throws(() => workspace.read('entry.js'), /revoked/);
  assert.equal(game.onboardWorkspace('drone-2').status().revoked, false);
  await delay(800); assert.equal(workspace.status().workspace.usedBytes, 0);
});

test('routine event reads preserve independently unread actual peer messages for the next model bundle', async t => {
  const { game } = await ready(); t.after(() => game.stop());
  await source(game, 'await drone.files.write("started.md","yes"); await drone.sleep(200); const result=await drone.events(); await drone.files.write("events.json",JSON.stringify(result));');
  await game.tool('drone-1', 'routine', { mission: 1, op: 'start', path: 'entry.js' });
  await until(() => game.onboardWorkspace('drone-1').list().some(file => file.path === 'started.md'));
  await game.tool('drone-2', 'send', { mission: 1, to: 'drone-1', kind: 'chat', text: 'A peer-authored observation.' });
  await until(() => game.state.drones[0].job?.state === 'completed');
  const saved = game.onboardWorkspace('drone-1').read('events.json'); assert.match(saved, /A peer-authored observation/);
  const model = await game.tool('drone-1', 'observe'); assert.match(JSON.stringify(body(model)), /A peer-authored observation/);
});
