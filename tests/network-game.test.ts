import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetGame } from '../server/game.ts';
import { FleetNetwork } from '../server/network.ts';
import { MavlinkAdapter } from '../server/mavlink.ts';
import { DRONE_IDS, type ToolResult } from '../shared/types.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';
import { RTS_MISSION } from '../shared/mission.ts';
import { TeamSession } from '../server/team-session.ts';
import type { RuntimeOptions } from '../server/runtime.ts';

const body = (result: ToolResult) => JSON.parse((result.content[0] as { text: string }).text);
async function until(check: () => boolean, timeout = 7000) {
  const end = Date.now() + timeout;
  while (!check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(check(), 'Network condition did not arrive');
}

test('the complete production opening reaches all six actors through native team radio', { timeout: 30_000 }, async t => {
  const game = new FleetGame(); game.setConnected(true); game.start();
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  const runtimes: RuntimeOptions[] = [], failures: string[] = [];
  const session = new TeamSession({ projectDir: process.cwd(), game, onStatus: () => {}, onNetwork: () => {},
    onEvent: () => {}, onFailure: error => failures.push(error) }, {
    // Only inference is stubbed; the normal startup/relay, Zenoh and MAVLink run.
    runtime: options => { runtimes.push(options); return { start: async () => {}, stop: async () => {}, retireDrone: async () => {}, refreshTools: async () => {} }; },
  });
  t.after(async () => { game.stop(); await session.stop(); });
  await session.start();
  for (const id of MATCH_DRONE_IDS) await game.tool(id, 'observe');
  for (const runtime of runtimes) await runtime.toolHandler('parent', 'forward_next_instruction', {});
  await until(() => MATCH_DRONE_IDS.every(id => game.receivedMission(id) === 1));
  for (const id of MATCH_DRONE_IDS) {
    const bundle = body(await game.tool(id, 'observe'));
    assert.equal(bundle.mission, 1);
    assert.deepEqual(bundle.events.filter((event: any) => event.type === 'player').map((event: any) => event.text), [RTS_MISSION]);
  }
  const opening = game.state.radio.find(message => message.kind === 'mission' && message.data?.team === 'blue')!;
  assert.ok(RTS_MISSION.length < 700, 'production opening is a terse order, with calibration in pilot instructions');
  await assert.rejects(session.radio.sendTeam('blue', { ...opening, id: 'oversize-objective', text: 'x'.repeat(6001) }), /Invalid message text/);
  await assert.rejects(session.radio.sendTeam('blue', { ...opening, id: 'oversize-utf8', text: '🙂'.repeat(3000) }), /8192 UTF-8 bytes/);
  await assert.rejects(session.radio.sendTeam('blue', { ...opening, id: 'oversize-chat', kind: 'chat', text: 'x'.repeat(1201) }), /Invalid message text/);
  assert.deepEqual(failures, []);
});

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
    assert.equal(body(command).accepted, true);
    await until(() => game.state.drones[0].job?.state === 'running');
    for (let step = 0; game.state.drones[0].action && step < 40; step++) game.tick(0.25);
    assert.equal(body(await game.tool('drone-1', 'observe')).sensors.position.x, -4);
    assert.equal(game.state.drones[0].job?.state, 'completed');

    await network.link('drone-3', false);
    game.queueMission('Hold and report'); await game.tool('parent', 'forward_next_instruction');
    await until(() => game.inboxes['drone-1'].events.some(e => e.type === 'player' && e.mission === 2));
    assert.equal(body(await game.tool('drone-3', 'observe')).mission, 1);
    assert.equal((await game.tool('drone-3', 'act', { mission: 1, kind: 'hover' })).isError, undefined);
    assert.equal((await game.tool('drone-1', 'act', { mission: 1, kind: 'hover' })).isError, true);
    const isolated = game.state.drones.find(drone => drone.id === 'drone-3')!;
    assert.equal(body(await game.tool('drone-3', 'act', { mission: 1, kind: 'fly_to', x: 6, y: 7, z: 23 })).accepted, true);
    await until(() => isolated.job?.state === 'running');
    for (let step = 0; isolated.action && step < 40; step++) game.tick(0.25);
    assert.equal(isolated.job?.state, 'completed'); assert.equal(isolated.x, 6, 'A native radio partition must not freeze local flight');
    await network.link('drone-3', true);
    await until(() => game.inboxes['drone-3'].events.some(e => e.type === 'player' && e.mission === 2));
    assert.equal(body(await game.tool('drone-3', 'observe')).mission, 2);
    assert.equal((await game.tool('drone-3', 'act', { mission: 1, kind: 'hover' })).isError, true);
    assert.deepEqual(errors, []);
  } finally { game.stop(); await Promise.all([network.stop(), vehicle.stop()]); }
});

test('mission replacement during MAVLink transit cancels the accepted job before decoded motion can execute', async () => {
  const game = new FleetGame(); game.setConnected(true); game.start();
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  for (const id of DRONE_IDS) await game.tool(id, 'observe');
  game.queueMission('First'); await game.tool('parent', 'forward_next_instruction');
  game.vehicleTransport = {
    command: async (_id, args) => { game.queueMission('Next'); await game.tool('parent', 'forward_next_instruction'); return args; },
    sample: async (_id, pose, simTime) => ({ position: pose, heading: { degrees: 0 }, simTime }),
  };
  const result = await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: -3, y: 7, z: 23 });
  assert.equal(result.isError, undefined); assert.equal(body(result).accepted, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(game.state.drones[0].action, undefined); assert.equal(game.state.drones[0].job?.state, 'cancelled');
  assert.equal(body(result).commandMission, 1);
  assert.equal(body(await game.tool('drone-1', 'observe')).mission, 2); game.stop();
});

test('received peer text survives its delivery deadline while expired future-objective mail is consumed', async () => {
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
  assert.equal(JSON.stringify(response).includes('Stale finding'), true);
  assert.deepEqual(response.events.filter((e: any) => e.type === 'message_expired').map((e: any) => e.id).sort(), ['future']);
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
