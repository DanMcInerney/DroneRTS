import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { FleetGame } from '../server/game.ts';
import { TeamSession } from '../server/team-session.ts';
import type { RadioMessage, ToolResult } from '../shared/types.ts';

const body = (result: ToolResult) => JSON.parse(result.content.find(item => item.type === 'text')!.text);
const deferred = () => { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; };
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!predicate() && performance.now() < deadline) await delay(10);
  assert.ok(predicate(), 'Bounded fixture did not reach the requested state');
}

async function fixture(t: TestContext) {
  const game = new FleetGame(), sent: RadioMessage[] = [], gate = deferred(), entered = deferred();
  let hold = false;
  game.capture = async () => 'data:image/png;base64,AQID'; game.setConnected(true); game.start();
  for (const drone of game.state.drones) await game.tool(drone.id, 'observe');
  await game.forwardTeam('blue'); await game.forwardTeam('red');
  const session = new TeamSession({ projectDir: process.cwd(), game, onStatus() {}, onNetwork() {}, onEvent() {}, onFailure(message) { assert.fail(message); } }, {
    runtime: () => ({ async start() {}, async stop() {}, async retireDrone() {}, async refreshTools() {} }),
    network: options => ({
      state: { status: 'online', transport: 'zenoh-tcp', vehicle: 'mavlink2-udp', message: '', peers: options.roster!.map(({ id }) => ({ id, online: true, peers: 3, pending: 0, inbox: 0 })) },
      async start() {}, async stop() {}, async send(message) { sent.push(message); }, consume() {},
      async link() { if (hold) { entered.resolve(); await gate.promise; } },
    }),
    vehicle: () => ({ async start() {}, async stop() {}, async command(_id, args) { return args; },
      async sample(_id, pose, simTime) { return { position: { x: pose.x, y: pose.y, z: pose.z }, heading: { degrees: 0 },
        velocity: { x: 0, y: 0, z: 0 }, cameraOrientation: { heading: 0, pitch: pose.pitch }, simTime }; } }),
  });
  await session.start();
  t.after(async () => { gate.resolve(); game.stop(); await session.stop(); });
  hold = true; const changingLink = session.link('drone-3', false); await entered.promise;
  return { game, session, sent, release: async () => { gate.resolve(); await changingLink; } };
}

test('received objective replacement cancels a send held before native queue admission', async t => {
  const f = await fixture(t), text = 'Must not reach the native outbox';
  const pending = f.game.tool('drone-1', 'send', { mission: 1, to: 'drone-2', kind: 'chat', text });
  await until(() => f.game.state.radio.some(message => message.text === text));
  assert.equal(f.sent.length, 0);
  f.game.receiveRadio('drone-1', { ...f.game.state.radio[0], id: 'replacement-objective', from: 'player', to: 'drone-1', kind: 'mission', mission: 2, text: 'New objective' });
  await f.release(); const result = body(await pending);
  assert.match(result.error ?? result.reason, /objective changed/i); assert.equal(f.sent.length, 0);
  assert.match(f.game.state.radio.find(message => message.text === text)!.delivery!.error!, /objective changed/i);
});

test('a send from a retired match cannot enqueue or publish delivery into the new match', async t => {
  const f = await fixture(t), text = 'Old match send';
  const pending = f.game.tool('drone-1', 'send', { mission: 1, to: 'drone-2', kind: 'chat', text });
  await until(() => f.game.state.radio.some(message => message.text === text));
  f.game.stop(); f.game.reset(); f.game.start();
  const deliveries: unknown[] = []; f.game.on('radio-delivery', message => deliveries.push(message));
  await f.release(); assert.equal(body(await pending).stopped, true);
  assert.equal(f.sent.length, 0); assert.equal(deliveries.length, 0);
});

for (const cause of ['cancel', 'host-deadline'] as const) test(`routine ${cause} prevents a held SDK radio call from sending later`, async t => {
  const f = await fixture(t), text = `Cancelled SDK send: ${cause}`;
  f.game.onboardWorkspace('drone-1').write('send.js', 'await drone.send({to:"drone-2",kind:"chat",text:input.text});');
  await f.game.tool('drone-1', 'routine', { mission: 1, op: 'start', path: 'send.js', input: { text } });
  await until(() => f.game.state.radio.some(message => message.text === text));
  if (cause === 'cancel') await f.game.tool('drone-1', 'routine', { mission: 1, op: 'cancel' });
  else await until(() => ['failed', 'cancelled'].includes(f.game.state.drones[0].job?.state ?? ''));
  assert.equal(f.sent.length, 0); await f.release(); await delay(30);
  assert.equal(f.sent.length, 0, 'A cancelled worker cannot later enqueue its pending send');
});

for (const cause of ['cancel', 'death', 'expire'] as const) test(`transfer ${cause} prevents held source chunks while preserving cancellation control`, async t => {
  const f = await fixture(t); f.game.onboardWorkspace('drone-1').write('note.md', 'Private source must remain unsent');
  const offer = body(await f.game.tool('drone-1', 'transfer', { mission: 1, operation: 'offer', to: 'drone-2', path: 'note.md' })).transfer;
  assert.equal(f.sent.length, 0);
  if (cause === 'cancel') await f.game.tool('drone-1', 'transfer', { mission: 1, operation: 'cancel', transferId: offer.id });
  if (cause === 'death') f.game.state.drones[0].alive = false;
  if (cause === 'expire') { const now = performance.now.bind(performance); t.mock.method(performance, 'now', () => now() + 121_000); }
  await f.release(); await delay(30);
  assert.equal(f.sent.filter(message => message.data?.operation === 'chunk').length, 0);
  if (cause === 'cancel') assert.equal(f.sent.filter(message => message.data?.operation === 'cancel').length, 1);
});
