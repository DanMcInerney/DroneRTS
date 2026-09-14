import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetGame } from '../server/game.ts';
import { Mailbox } from '../server/mailbox.ts';
import { DRONE_IDS, type ToolResult } from '../shared/types.ts';

const json = (result: ToolResult) => JSON.parse((result.content.find(c => c.type === 'text') as { text: string }).text);
async function ready() {
  const game = new FleetGame(); game.setConnected(true); game.start();
  game.state.obstacles = [];
  game.state.drones.forEach((d, i) => Object.assign(d, { x: (i - 1) * 5, y: 7, z: 23, yaw: 0, pitch: -23 }));
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  for (const id of DRONE_IDS) await game.tool(id, 'observe', { camera: false });
  game.queueMission('Find treasure chests.'); await game.tool('parent', 'forward_next_instruction');
  return game;
}
test('mail arriving before wait remains visible, and independent inbox waits wake separately', async () => {
  const a = new Mailbox(), b = new Mailbox();
  a.push({ type: 'radio', mission: 1 });
  assert.equal((await a.read(0, 0)).events.length, 1);
  const future = b.read(0, 1000);
  a.push({ type: 'arrived', mission: 1 });
  b.push({ type: 'radio', mission: 1 });
  assert.equal((await future).events[0].type, 'radio');
});
test('parent relays exact text and cannot access drone tools; peer identity is bound by caller', async () => {
  const game = await ready();
  const instruction = '  Fly north, then WAIT.  ';
  game.queueMission(instruction); await game.tool('parent', 'forward_next_instruction');
  assert.equal(game.state.radio.at(-1)?.text, instruction);
  assert.equal((await game.tool('parent', 'observe')).isError, true);
  const message = await game.tool('drone-2', 'send', { mission: 2, to: 'all', kind: 'chat', text: 'East is mine', droneId: 'drone-1' });
  assert.equal(message.isError, undefined);
  assert.equal(game.state.radio.at(-1)?.from, 'drone-2');
  assert.equal((await game.tool('drone-1', 'forward_next_instruction')).isError, true);
  game.stop();
});
test('a new instruction hovers drones and rejects delayed commands carrying the old mission', async () => {
  const game = await ready();
  await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 4, y: 7, z: 0 });
  assert.ok(game.state.drones[0].action);
  game.queueMission('Hold position'); await game.tool('parent', 'forward_next_instruction');
  assert.equal(game.state.drones[0].action, undefined);
  assert.equal((await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 9, y: 7, z: 0 })).isError, true);
  assert.equal((await game.tool('drone-1', 'send', { mission: 1, to: 'all', kind: 'claim', text: 'Old task' })).isError, true);
  game.stop();
});
test('movement is continuous, collision emits event, and browser loss pauses simulation', async () => {
  const game = await ready(), drone = game.state.drones[0];
  game.state.obstacles = [{ x: -7, z: 3, width: 4, depth: 5, height: 3 }];
  Object.assign(drone, { x: -7, y: 2, z: 9 });
  await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: -7, y: 2, z: -5 });
  for (let i = 0; i < 30; i++) game.tick(0.2);
  assert.match(drone.status, /Obstacle/);
  assert.equal(game.inboxes['drone-1'].events.at(-1)?.type, 'blocked');
  const simTime = game.state.simTime; game.setConnected(false); game.tick(0.2);
  assert.equal(game.state.simTime, simTime);
  game.stop();
});
test('camera result pairs requested pose with image and does not disclose target locations', async () => {
  const game = await ready();
  const observations = game.state.drones[0].observations;
  game.capture = async (_id, pose) => { assert.equal(pose.x, -5); return 'data:image/jpeg;base64,AQID'; };
  const result = await game.tool('drone-1', 'observe', { camera: true });
  assert.equal(result.content[1].type, 'image'); assert.equal(json(result).pads, undefined);
  assert.equal(json(result).sensors.position.x, -5); assert.equal(game.state.drones[0].observations, observations + 1);
  game.stop();
});
test('Stop resolves event waits and prevents motion', async () => {
  const game = await ready();
  const inbox = game.inboxes['drone-1'];
  const waiting = game.tool('drone-1', 'wait', { after: inbox.cursor, timeout_ms: 1000 });
  game.stop();
  assert.equal(json(await waiting).stopped, true);
  assert.equal(json(await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 0, y: 4, z: 0 })).stopped, true);
});
test('a restarted fleet gets clean inboxes and cannot replay a stopped mission', async () => {
  const game = await ready(); game.queueMission('Old queued instruction'); game.stop(); game.start();
  assert.equal(game.state.mission, 0);
  const events = json(await game.tool('drone-1', 'wait', { after: 0, timeout_ms: 0 }));
  assert.deepEqual(events.events, []);
  assert.equal(events.stopped, false);
  assert.equal(game.state.radio.length, 0);
  game.stop();
});
test('future and stale cursor hints cannot skip unread mail or replay delivered messages', async () => {
  const inbox = new Mailbox();
  inbox.push({ type: 'player', mission: 1 });
  const first = await inbox.read(999, 0);
  assert.equal(first.events[0].type, 'player');
  assert.equal(first.cursorRecovered, true);
  assert.equal((await inbox.read(0, 0)).events.length, 0);
  const waiting = inbox.read(999, 1000);
  inbox.push({ type: 'radio', mission: 1 });
  assert.equal((await waiting).events[0].type, 'radio');
});
test('a guessed future drone cursor waits for real mail instead of returning a retry error', async () => {
  const game = await ready();
  await game.tool('drone-1', 'wait', { after: 999, timeout_ms: 1000 });
  let returned = false;
  const waiting = game.tool('drone-1', 'wait', { after: 999, timeout_ms: 30_000 }).then(result => { returned = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(returned, false);
  await game.tool('drone-2', 'send', { mission: 1, to: 'drone-1', kind: 'chat', text: 'New real message' });
  const result = await waiting;
  assert.equal(result.isError, undefined);
  assert.equal(json(result).events[0].message.text, 'New real message');
  game.stop();
});
test('tool failures emit inspectable error events and success resets the consecutive count', async () => {
  const game = await ready(); const errors: Array<{ consecutive: number; message: string }> = [];
  game.on('tool-error', error => errors.push(error));
  await game.tool('drone-1', 'act', { mission: 0, kind: 'hover' });
  await game.tool('drone-1', 'act', { mission: 0, kind: 'hover' });
  assert.equal(errors.at(-1)?.consecutive, 2);
  assert.match(errors.at(-1)!.message, /Stale/);
  await game.tool('drone-1', 'observe', { camera: false });
  await game.tool('drone-1', 'act', { mission: 0, kind: 'hover' });
  assert.equal(errors.at(-1)?.consecutive, 1);
  game.stop();
});
