import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetGame } from '../server/game.ts';
import { createDroneTools } from '../server/runtime-tools.ts';
import { MATCH_DRONE_IDS, teamRoster } from '../shared/fleet.ts';
import { RTS_CONFIG } from '../shared/rts.ts';
import type { ToolResult } from '../shared/types.ts';

const body = (result: ToolResult) => JSON.parse((result.content[0] as { text: string }).text);
async function ready() {
  const game = new FleetGame(); game.setConnected(true); game.start();
  game.state.obstacles = []; game.capture = async () => 'data:image/jpeg;base64,AQID';
  game.state.drones.forEach((drone, i) => Object.assign(drone, { x: i * 10, y: 2, z: 20, yaw: 0, pitch: 0 }));
  game.state.match!.servicePads = game.state.drones.map(drone => ({ id: `private-pad-${drone.id}`, team: drone.team!, x: drone.x, y: 0, z: drone.z }));
  for (const id of MATCH_DRONE_IDS) await game.tool(id, 'observe');
  await game.forwardTeam('blue'); await game.forwardTeam('red');
  for (const id of MATCH_DRONE_IDS) await game.tool(id, 'observe');
  return game;
}
function advance(game: FleetGame, seconds: number) {
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += 0.25) game.tick(Math.min(0.25, seconds - elapsed));
}
function assertPrivate(value: any) {
  assert.equal(value.protocol, 'fleet-observation/2');
  assert.ok(value.sensors.ranges); assert.ok(value.currentTelemetry);
  for (const secret of ['private-pad', 'padId', 'servicePads', 'jammerRange', 'idleDrain', 'movingDrain', 'jammerDrain', 'lowBatteryFraction', 'affected', 'enemyPositions']) {
    assert.equal(JSON.stringify(value).includes(secret), false, secret);
  }
}

// Historical interference can still be replayed/tested as state without exposing
// the deferred jammer equipment or tool in the current actor interface.
function legacyInterference(game: FleetGame, enabled: boolean) {
  game.state.match!.rulesVersion = 'cube-v1';
  game.state.drones[0].equipment!.jammer = true;
  game.state.drones[0].jamming = enabled;
  game.tick(1 / 120);
}

test('current drones expose calibrated telemetry without battery fields, equipment or recharge tools', async t => {
  const game = await ready(); t.after(() => game.stop());
  assert.equal(game.state.match!.rulesVersion, 'cargo-v3');
  for (const id of MATCH_DRONE_IDS) {
    const observed = body(await game.tool(id, 'observe'));
    assert.equal(observed.battery, undefined); assert.equal(observed.charging, undefined);
    assert.equal(observed.currentTelemetry.battery, undefined); assert.equal(observed.currentTelemetry.charging, undefined);
    assert.equal(observed.equipment.battery, undefined);
    for (const name of ['jam', 'mine', 'recharge']) assert.equal(observed.availableTools.includes(name), false);
    assertPrivate(observed);
  }
  for (const name of ['jam', 'mine', 'recharge']) assert.equal((await game.tool('drone-1', name, { mission: 1, enabled: true })).isError, true);
  for (const item of ['miner', 'miner_upgrade', 'jammer', 'battery', 'optics']) {
    const rejected = body(await game.tool('drone-1', 'buy', { mission: 1, item }));
    assert.equal(rejected.accepted, false); assertPrivate(rejected);
  }
  const exchange = body(await game.tool('drone-1', 'exchange', { mission: 1, operations: [{ id: 'removed', tool: 'recharge', args: {} }] }));
  assert.equal(exchange.accepted, false);
  assert.equal(game.state.match!.teams.blue.credits, RTS_CONFIG.startingCredits);
});

test('current drones ignore stale legacy battery state and can move without energy gating', async t => {
  const game = await ready(), drone = game.state.drones[0]; t.after(() => game.stop());
  game.state.match!.servicePads = [];
  drone.equipment!.armor = false;
  game.tick(0.25);
  assert.ok(game.state.drones.every(unit => unit.alive && unit.battery === undefined && unit.charging === undefined));
  assert.equal(game.state.completed, false);
  assert.ok(!game.state.match!.events.some(event => event.type.startsWith('battery_') || event.cause === 'power'));
  // A stale legacy field cannot restore energy gating in the current rules.
  drone.battery = 0;
  const moved = body(await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 0, y: 2, z: 15 }));
  assert.equal(moved.accepted, true);
  await new Promise(resolve => setImmediate(resolve)); advance(game, 4);
  assert.equal(drone.job?.state, 'completed'); assert.equal(drone.z, 15); assert.equal(drone.alive, true);
  const current = body(await game.tool('drone-1', 'observe'));
  assert.equal(current.battery, undefined); assert.equal(current.currentTelemetry.battery, undefined);
  game.stop(); game.start();
  assert.ok(game.state.drones.every(unit => unit.battery === undefined && unit.charging === undefined && unit.equipment?.battery === undefined));
});

test('historical low battery wakes wait; power loss retires an armored drone and revokes tools', async t => {
  const game = await ready(), drone = game.state.drones[0]; t.after(() => game.stop());
  game.state.match!.servicePads = [];
  game.state.match!.rulesVersion = 'cargo-v1';
  drone.battery = RTS_CONFIG.batteryCapacity * RTS_CONFIG.lowBatteryFraction + 0.01;
  const waiting = game.tool('drone-1', 'wait', { timeout_ms: 1000 }); game.tick(0.1);
  const low = body(await waiting);
  assert.equal(low.battery.low, true); assert.equal(low.events.filter((event: any) => event.type === 'battery_low').length, 1); assertPrivate(low);
  drone.equipment!.armor = true; drone.battery = 0.01;
  const retired: string[] = []; game.on('drone-destroyed', event => retired.push(event.droneId)); game.tick(0.1);
  assert.deepEqual(retired, ['drone-1']); assert.equal(drone.alive, false);
  assert.deepEqual(createDroneTools(teamRoster('blue'), game.toolCapabilities('drone-1')), []);
  const destroyed = body(await game.tool('drone-1', 'recharge', { mission: 1 }));
  assert.equal(destroyed.destroyed, true); assert.equal(destroyed.sensors, undefined);
});

test('historical interference updates complete transport flags while local camera and flight continue', async t => {
  const game = await ready(), drone = game.state.drones[0]; t.after(() => game.stop());
  Object.assign(game.state.drones[3], { x: 0, y: 2, z: 10 });
  const flags: boolean[][] = []; game.radioInterferenceChanged = () => flags.push(game.state.drones.map(peer => Boolean(peer.radioJammed)));
  legacyInterference(game, true);
  const observed = body(await game.tool('drone-1', 'observe'));
  assert.equal(observed.radioJammed, true); assert.equal(observed.sensors.camera.available, true); assertPrivate(observed);
  assert.ok(flags.length > 0); for (const value of flags) assert.deepEqual(value, [true, true, false, true, false, false]);
  const sent = body(await game.tool('drone-1', 'send', { mission: 1, to: 'all', kind: 'chat', text: 'Must not deliver' }));
  assert.equal(sent.accepted, false); assert.equal(sent.sent, undefined);
  assert.equal(body(await game.tool('drone-2', 'observe')).events.some((event: any) => event.message?.text === 'Must not deliver'), false);
  await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 0, y: 2, z: 15 });
  await new Promise(resolve => setImmediate(resolve)); game.tick(0.1);
  assert.ok(drone.z < 20); assert.equal(drone.jamming, true);
  advance(game, 4);
  assert.equal(drone.job?.state, 'completed'); assert.equal(drone.z, 15);
  legacyInterference(game, false);
  assert.equal(drone.radioJammed, false);
  assert.ok(body(await game.tool('drone-1', 'send', { mission: 1, to: 'drone-2', kind: 'chat', text: 'Restored' })).sent);
});

test('objective delivery and Stop disable historical interference, and browser pause preserves charge', async t => {
  const game = await ready(), drone = game.state.drones[0]; t.after(() => game.stop());
  legacyInterference(game, true);
  game.radioTransport = { send: async message => { for (const peer of teamRoster('blue')) game.receiveRadio(peer.id, message); }, consume: () => {} };
  game.queueMission('Replacement mission'); await game.forwardTeam('blue');
  assert.equal(drone.jamming, false); assert.equal(drone.radioJammed, false);
  assert.equal(body(await game.tool('drone-1', 'observe')).mission, 2);
  legacyInterference(game, true);
  const charge = drone.battery; game.setConnected(false); advance(game, 1); assert.equal(drone.battery, charge);
  game.setConnected(true); game.stop(); advance(game, 1); assert.equal(drone.battery, charge);
  assert.ok(game.state.drones.every(peer => !peer.jamming && !peer.radioJammed));
  game.start(); assert.ok(game.state.drones.every(peer => peer.battery === undefined && !peer.jamming && !peer.radioJammed));
});

test('historical interference keeps queued objectives pending until its actual radio state clears', async t => {
  const game = await ready(); t.after(() => game.stop());
  legacyInterference(game, true);
  game.queueMission('Pending original instruction');
  const pending = game.forwardTeam('blue');
  assert.equal(game.state.radio.filter(message => message.kind === 'mission').length, 2);
  assert.equal(body(await game.tool('drone-2', 'observe')).mission, 1);
  legacyInterference(game, false);
  assert.equal(body(await pending).mission, 2);
  const delivered = body(await game.tool('drone-2', 'observe'));
  assert.equal(delivered.mission, 2);
  assert.ok(delivered.events.some((event: any) => event.type === 'player' && event.text === 'Pending original instruction'));
});
