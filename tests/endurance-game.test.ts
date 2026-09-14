import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetGame } from '../server/game.ts';
import { createDroneTools } from '../server/runtime-tools.ts';
import { MATCH_DRONE_IDS, teamRoster } from '../shared/fleet.ts';
import { RTS_CONFIG } from '../shared/rts.ts';
import type { ToolResult } from '../shared/types.ts';

const body = (result: ToolResult) => JSON.parse((result.content[0] as { text: string }).text);
const image = async () => 'data:image/jpeg;base64,AQID';
async function ready() {
  const game = new FleetGame(); game.setConnected(true); game.start();
  game.state.obstacles = []; game.capture = image;
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
  assert.deepEqual(Object.keys(value.sensors).sort(), ['camera', 'heading', 'position', 'timestamp']);
  for (const secret of ['private-pad', 'padId', 'servicePads', 'cameraFov', 'jammerRange', 'idleDrain', 'movingDrain', 'jammerDrain', 'lowBatteryFraction', 'source', 'affected', 'enemy']) {
    assert.equal(JSON.stringify(value).includes(secret), false, secret);
  }
}
async function jammer() {
  const game = await ready(); game.state.match!.teams.blue.credits = 200;
  await game.tool('drone-1', 'buy', { mission: 1, item: 'jammer' });
  return game;
}

test('every live drone can recharge and own battery feedback stays outside the four sensors', async () => {
  const game = await ready();
  for (const id of MATCH_DRONE_IDS) {
    const observed = body(await game.tool(id, 'observe'));
    assert.deepEqual(observed.battery, { charge: RTS_CONFIG.batteryCapacity, capacity: RTS_CONFIG.batteryCapacity, low: false });
    assert.equal(observed.jamming, false); assert.equal(observed.radioJammed, false);
    assert.ok(observed.availableTools.includes('recharge')); assert.equal(observed.availableTools.includes('jam'), false);
    assertPrivate(observed);
  }
  const guessed = await game.tool('drone-1', 'jam', { mission: 1, enabled: true });
  assert.equal(guessed.isError, true); assertPrivate(body(guessed)); game.stop();
});

test('battery attachments expand capacity without charge and module replacement updates jam capability', async () => {
  const game = await ready(), drone = game.state.drones[0];
  const bought = body(await game.tool('drone-1', 'buy', { mission: 1, item: 'battery' }));
  assert.deepEqual(bought.battery, { charge: RTS_CONFIG.batteryCapacity, capacity: RTS_CONFIG.extendedBatteryCapacity, low: false });
  assert.equal(bought.account.credits, 0);
  assert.equal(body(await game.tool('drone-2', 'buy', { mission: 1, item: 'armor' })).accepted, false);
  game.state.match!.teams.blue.credits = 200; drone.battery = RTS_CONFIG.extendedBatteryCapacity - 10;
  const replaced = body(await game.tool('drone-1', 'buy', { mission: 1, item: 'jammer', replace: 'battery' }));
  assert.deepEqual(replaced.battery, { charge: RTS_CONFIG.batteryCapacity, capacity: RTS_CONFIG.batteryCapacity, low: false });
  assert.ok(replaced.availableTools.includes('jam')); assertPrivate(replaced);
  await game.tool('drone-1', 'jam', { mission: 1, enabled: true });
  const removed = body(await game.tool('drone-1', 'buy', { mission: 1, item: 'optics', replace: 'jammer' }));
  assert.equal(removed.jamming, false); assert.equal(removed.radioJammed, false);
  assert.equal(removed.availableTools.includes('jam'), false); assert.ok(removed.availableTools.includes('camera'));
  assert.equal((await game.tool('drone-1', 'jam', { mission: 1, enabled: true })).isError, true); game.stop();
});

test('friendly cubes charge automatically during flight without changing commands, jammer or salvage', async () => {
  const game = await jammer(), drone = game.state.drones[0];
  await game.tool('drone-1', 'buy', { mission: 1, item: 'battery' }); drone.battery = 60;
  await game.tool('drone-1', 'jam', { mission: 1, enabled: true });
  await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 0, y: 2, z: 18 }); game.tick(0.1);
  const balance = game.state.match!.teams.blue.credits;
  const action = drone.action!.id;
  const charging = body(await game.tool('drone-1', 'recharge', { mission: 1 }));
  assert.equal(charging.currentAction.id, action); assert.equal(charging.service, null); assert.equal(charging.charging, true);
  assert.equal(charging.jamming, true); assert.equal(charging.radioJammed, true); assertPrivate(charging);
  const charge = drone.battery, z = drone.z;
  await game.tool('drone-1', 'act', { mission: 1, kind: 'look', heading: 45 });
  advance(game, RTS_CONFIG.rechargeDuration / 2);
  assert.ok(drone.battery! > charge!); assert.ok(drone.z < z);
  await game.tool('drone-1', 'observe');
  const waiting = game.tool('drone-1', 'wait', { timeout_ms: 30_000 });
  advance(game, 2 * RTS_CONFIG.rechargeDuration);
  const complete = body(await waiting);
  assert.equal(complete.battery.charge, RTS_CONFIG.extendedBatteryCapacity); assert.equal(complete.charging, true);
  assert.equal(complete.service, null); assert.equal(complete.currentAction, null); assert.equal(complete.account.credits, balance);
  assert.ok(complete.events.some((event: any) => event.type === 'battery_full')); assertPrivate(complete); game.stop();
});

test('hover preserves automatic charging and leaving a friendly cube retains accumulated charge', async () => {
  const game = await ready(), drone = game.state.drones[0]; drone.battery = 25;
  advance(game, 2);
  const hovering = body(await game.tool('drone-1', 'act', { mission: 1, kind: 'hover' }));
  assert.equal(hovering.service, null); assert.ok(hovering.battery.charge > 25); assert.equal(hovering.charging, true);
  assert.equal(hovering.account.credits, 30);
  await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 0, y: 2, z: 15.5 });
  advance(game, 4);
  const outside = body(await game.tool('drone-1', 'observe'));
  assert.equal(outside.charging, false); assert.ok(outside.battery.charge > hovering.battery.charge);
  assert.ok(outside.events.some((event: any) => event.type === 'charging_stopped'));
  const retained = drone.battery!; advance(game, 1); assert.ok(drone.battery! < retained); game.stop();
});

test('low battery wakes wait; power loss retires even an armored drone and revokes tools', async () => {
  const game = await jammer(), drone = game.state.drones[0];
  game.state.match!.servicePads = [];
  drone.battery = RTS_CONFIG.batteryCapacity * RTS_CONFIG.lowBatteryFraction + 0.01;
  const waiting = game.tool('drone-1', 'wait', { timeout_ms: 30_000 }); game.tick(0.1);
  const low = body(await waiting);
  assert.equal(low.battery.low, true); assert.equal(low.events.filter((event: any) => event.type === 'battery_low').length, 1);
  assertPrivate(low);
  await game.tool('drone-1', 'jam', { mission: 1, enabled: true }); drone.equipment!.armor = true; drone.battery = 0.01;
  const retired: string[] = []; game.on('drone-destroyed', event => retired.push(event.droneId)); game.tick(0.1);
  assert.deepEqual(retired, ['drone-1']); assert.equal(drone.alive, false); assert.equal(drone.jamming, false);
  assert.equal(drone.radioJammed, false); assert.equal(game.state.drones[1].radioJammed, false);
  assert.deepEqual(createDroneTools(teamRoster('blue'), game.toolCapabilities('drone-1')), []);
  const destroyed = body(await game.tool('drone-1', 'recharge', { mission: 1 }));
  assert.equal(destroyed.destroyed, true); assert.equal(destroyed.sensors, undefined); game.stop();
});

test('jam toggles require a boolean and the received mission while preserving motion and mining', async () => {
  const game = await jammer(), drone = game.state.drones[0];
  for (const enabled of ['true', 1, null, undefined]) {
    const rejected = body(await game.tool('drone-1', 'jam', { mission: 1, enabled }));
    assert.equal(rejected.accepted, false); assert.equal(drone.jamming, false); assertPrivate(rejected);
  }
  assert.equal((await game.tool('drone-1', 'jam', { mission: 2, enabled: true })).isError, true);
  assert.equal((await game.tool('drone-1', 'recharge', { mission: 2 })).isError, true);
  await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 0, y: 2, z: 15 });
  const action = drone.action!.id;
  await game.tool('drone-1', 'jam', { mission: 1, enabled: true }); assert.equal(drone.action?.id, action);
  await game.tool('drone-1', 'jam', { mission: 1, enabled: false });
  await game.tool('drone-1', 'act', { mission: 1, kind: 'hover' });
  Object.assign(drone, { x: 0, y: 1.4, z: 2, yaw: 0, pitch: 0 });
  game.state.match!.resources = [{ id: 'private-node', x: 0, y: 0.45, z: 0, remaining: 100, capacity: 100 }];
  await game.tool('drone-1', 'observe'); await game.tool('drone-1', 'mine', { mission: 1 });
  const mining = drone.mining; await game.tool('drone-1', 'jam', { mission: 1, enabled: true });
  assert.equal(drone.mining, mining); assert.ok(drone.mining); game.stop();
});

test('interference notifies transport with complete flags, blocks test radio, and preserves local camera and flight', async () => {
  const game = await jammer(), drone = game.state.drones[0];
  Object.assign(game.state.drones[3], { x: 0, y: 2, z: 10 });
  const flags: boolean[][] = []; game.radioInterferenceChanged = () => flags.push(game.state.drones.map(peer => Boolean(peer.radioJammed)));
  const enabled = body(await game.tool('drone-1', 'jam', { mission: 1, enabled: true }));
  assert.equal(enabled.radioJammed, true); assert.equal(enabled.sensors.camera.available, true); assertPrivate(enabled);
  assert.ok(flags.length > 0); for (const value of flags) assert.deepEqual(value, [true, true, false, true, false, false]);
  const sent = body(await game.tool('drone-1', 'send', { mission: 1, to: 'all', kind: 'chat', text: 'Must not deliver' }));
  assert.equal(sent.accepted, false); assert.equal(sent.sent, undefined);
  const peer = body(await game.tool('drone-2', 'observe'));
  assert.equal(peer.events.some((event: any) => event.message?.text === 'Must not deliver'), false); assertPrivate(peer);
  await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 0, y: 2, z: 15 }); game.tick(0.1);
  assert.ok(drone.z < 20); assert.equal(drone.jamming, true);
  const restored = body(await game.tool('drone-1', 'jam', { mission: 1, enabled: false }));
  assert.equal(restored.radioJammed, false);
  const delivered = body(await game.tool('drone-1', 'send', { mission: 1, to: 'drone-2', kind: 'chat', text: 'Restored' }));
  assert.ok(delivered.sent); game.stop();
});

test('mission delivery and Stop disable jammers, and paused simulation preserves charge', async () => {
  const game = await jammer(), drone = game.state.drones[0];
  await game.tool('drone-1', 'jam', { mission: 1, enabled: true });
  game.radioTransport = { send: async message => { for (const peer of teamRoster('blue')) game.receiveRadio(peer.id, message); }, consume: () => {} };
  game.queueMission('Replacement mission'); await game.forwardTeam('blue');
  assert.equal(drone.jamming, false); assert.equal(drone.radioJammed, false);
  const mission = body(await game.tool('drone-1', 'observe')); assert.equal(mission.mission, 2);
  await game.tool('drone-1', 'jam', { mission: 2, enabled: true });
  const charge = drone.battery; game.setConnected(false); advance(game, 1); assert.equal(drone.battery, charge);
  game.setConnected(true); game.stop(); advance(game, 1); assert.equal(drone.battery, charge);
  assert.ok(game.state.drones.every(peer => !peer.jamming && !peer.radioJammed));
  game.start(); assert.ok(game.state.drones.every(peer => peer.battery === RTS_CONFIG.batteryCapacity && !peer.jamming && !peer.radioJammed)); game.stop();
});

test('the isolated radio seam keeps missions pending until interference clears', async () => {
  const game = await jammer();
  await game.tool('drone-1', 'jam', { mission: 1, enabled: true });
  game.queueMission('Pending original instruction');
  const pending = game.forwardTeam('blue');
  assert.equal(game.state.radio.filter(message => message.kind === 'mission').length, 2);
  assert.equal(body(await game.tool('drone-2', 'observe')).mission, 1);
  await game.tool('drone-1', 'jam', { mission: 1, enabled: false });
  assert.equal(body(await pending).mission, 2);
  const delivered = body(await game.tool('drone-2', 'observe'));
  assert.equal(delivered.mission, 2);
  assert.ok(delivered.events.some((event: any) => event.type === 'player' && event.text === 'Pending original instruction'));
  game.stop();
});
