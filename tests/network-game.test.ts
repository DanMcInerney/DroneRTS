import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetGame } from '../server/game.ts';
import { FleetNetwork } from '../server/network.ts';
import { MavlinkAdapter } from '../server/mavlink.ts';
import { DRONE_IDS, type ToolResult } from '../shared/types.ts';

const body = (result: ToolResult) => JSON.parse((result.content[0] as { text: string }).text);
async function until(check: () => boolean, timeout = 7000) {
  const end = Date.now() + timeout;
  while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(check(), 'Network condition did not arrive');
}

test('game uses Zenoh for missions and peer mail, MAVLink for movement/sensing, and no mission shortcut across a partition', { timeout: 30_000 }, async () => {
  const game = new FleetGame(); game.setConnected(true); game.start();
  game.state.obstacles = [];
  game.state.drones.forEach((d, i) => Object.assign(d, { x: (i - 1) * 5, y: 7, z: 23, yaw: 0, pitch: -23 }));
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  const errors: string[] = [];
  const network = new FleetNetwork({ projectDir: process.cwd(), sessionId: game.sessionIdentity,
    onReceive: (id, message) => game.receiveRadio(id, message), onState: () => {}, onFailure: error => errors.push(error) });
  const vehicle = new MavlinkAdapter({ projectDir: process.cwd() });
  try {
    await Promise.all([network.start(), vehicle.start()]);
    game.radioTransport = network; game.vehicleTransport = vehicle;
    await until(() => network.state.peers.every(peer => peer.peers === 3));
    for (const id of DRONE_IDS) await game.tool(id, 'observe');
    game.queueMission('Explore'); await game.tool('parent', 'forward_next_instruction');
    await until(() => DRONE_IDS.every(id => game.inboxes[id].events.some(e => e.type === 'player' && e.mission === 1)));
    for (const id of DRONE_IDS) assert.equal(body(await game.tool(id, 'observe')).mission, 1);
    const queued = body(await game.tool('drone-1', 'send', { mission: 1, to: 'drone-2', kind: 'chat', text: 'A measured finding' }));
    assert.ok(queued.queued);
    const radio = body(await game.tool('drone-2', 'wait', { timeout_ms: 3000 }));
    assert.ok(radio.events.some((e: any) => e.message?.text === 'A measured finding'));
    assert.equal(game.inboxes['drone-3'].events.some(e => e.type === 'radio'), false);
    const command = await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: -4, y: 7, z: 23 });
    assert.equal(body(command).accepted, true); game.tick(0.25); game.tick(0.25);
    assert.equal(body(await game.tool('drone-1', 'observe')).sensors.position.x, -4);

    await network.link('drone-3', false);
    game.queueMission('Hold and report'); await game.tool('parent', 'forward_next_instruction');
    await until(() => game.inboxes['drone-1'].events.some(e => e.type === 'player' && e.mission === 2));
    assert.equal(body(await game.tool('drone-3', 'observe')).mission, 1);
    assert.equal((await game.tool('drone-3', 'act', { mission: 1, kind: 'hover' })).isError, undefined);
    assert.equal((await game.tool('drone-1', 'act', { mission: 1, kind: 'hover' })).isError, true);
    await network.link('drone-3', true);
    await until(() => game.inboxes['drone-3'].events.some(e => e.type === 'player' && e.mission === 2));
    assert.equal(body(await game.tool('drone-3', 'observe')).mission, 2);
    assert.equal((await game.tool('drone-3', 'act', { mission: 1, kind: 'hover' })).isError, true);
    assert.deepEqual(errors, []);
  } finally { game.stop(); await Promise.all([network.stop(), vehicle.stop()]); }
});

test('mission replacement during MAVLink transit rejects decoded obsolete command', async () => {
  const game = new FleetGame(); game.setConnected(true); game.start();
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  for (const id of DRONE_IDS) await game.tool(id, 'observe');
  game.queueMission('First'); await game.tool('parent', 'forward_next_instruction');
  game.vehicleTransport = {
    command: async (_id, args) => { game.queueMission('Next'); await game.tool('parent', 'forward_next_instruction'); return args; },
    sample: async (_id, pose, simTime) => ({ position: pose, heading: { degrees: 0 }, simTime }),
  };
  const result = await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: -3, y: 7, z: 23 });
  assert.equal(result.isError, true); assert.equal(game.state.drones[0].action, undefined);
  assert.equal(body(result).mission, 2); game.stop();
});

test('expiry at the model boundary removes stale text and consumes queued or deferred mail', async () => {
  const game = new FleetGame(); game.setConnected(true); game.start();
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  for (const id of DRONE_IDS) await game.tool(id, 'observe');
  game.queueMission('First'); await game.tool('parent', 'forward_next_instruction');
  const consumed: string[] = [];
  game.radioTransport = { send: async () => {}, consume: (_id, ids) => consumed.push(...ids) };
  const message = { ...game.state.radio[0], from: 'drone-2', to: 'drone-1', kind: 'chat', text: 'Stale finding' };
  const deadline = new Date(Date.now() + 60).toISOString();
  game.receiveRadio('drone-1', { ...message, id: 'current', expiresAt: deadline });
  game.receiveRadio('drone-1', { ...message, id: 'future', mission: 2, expiresAt: deadline });
  await new Promise(resolve => setTimeout(resolve, 90));
  const response = body(await game.tool('drone-1', 'observe'));
  assert.equal(JSON.stringify(response).includes('Stale finding'), false);
  assert.deepEqual(response.events.filter((e: any) => e.type === 'message_expired').map((e: any) => e.id).sort(), ['current', 'future']);
  assert.ok(consumed.includes('current') && consumed.includes('future')); game.stop();
});

test('MAVLink observation timeout stops the fleet on the first failure rather than retrying without sensors', async () => {
  const game = new FleetGame(); game.setConnected(true); game.start();
  let attempts = 0; const failures: string[] = [];
  game.on('transport-error', error => failures.push(error.message));
  game.vehicleTransport = {
    command: async (_id, args) => args,
    sample: async () => { attempts++; throw new Error('MAVLink receive deadline exceeded'); },
  };
  const first = await game.tool('drone-1', 'observe');
  assert.equal(first.isError, true); assert.equal(body(first).stopped, true);
  assert.equal(game.state.running, false); assert.equal(failures.length, 1);
  assert.match(failures[0], /MAVLink receive deadline/);
  for (const id of DRONE_IDS) assert.equal(body(await game.tool(id, 'observe')).stopped, true);
  assert.equal(attempts, 1);
});
