import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetGame } from '../server/game.ts';
import { MATCH_DRONE_IDS, teamRoster } from '../shared/fleet.ts';
import type { ToolResult } from '../shared/types.ts';

const body = (result: ToolResult) => JSON.parse((result.content[0] as { text: string }).text);
async function ready() {
  const game = new FleetGame(); game.setConnected(true); game.start();
  game.state.obstacles = [];
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  game.state.drones.forEach((drone, i) => Object.assign(drone, { x: i * 10, y: 2, z: 20, yaw: 0, pitch: 0 }));
  for (const id of MATCH_DRONE_IDS) await game.tool(id, 'observe');
  await game.forwardTeam('blue'); await game.forwardTeam('red');
  for (const id of MATCH_DRONE_IDS) await game.tool(id, 'observe');
  return game;
}

test('each relay delivers the unmodified objective only to its three teammates; replacement is team local', async () => {
  const game = await ready();
  assert.equal(game.state.radio.filter(message => message.kind === 'mission').length, 2);
  const original = '  Keep our team together.  ';
  game.queueMission(original); await game.forwardTeam('blue');
  assert.equal(game.state.radio.at(-1)!.text, original);
  for (const member of teamRoster('blue')) assert.equal(body(await game.tool(member.id, 'observe')).mission, 2);
  for (const member of teamRoster('red')) assert.equal(body(await game.tool(member.id, 'observe')).mission, 1);
  game.stop();
});

test('cross-team direct mail is rejected and group broadcasts cannot cross teams', async () => {
  const game = await ready();
  const rejected = body(await game.tool('drone-1', 'send', { mission: 1, to: 'drone-4', kind: 'chat', text: 'Forbidden' }));
  assert.match(rejected.error, /recipient/); assert.ok(rejected.sensors);
  await game.tool('drone-1', 'send', { mission: 1, to: 'all', kind: 'chat', text: 'Blue only' });
  assert.ok(body(await game.tool('drone-2', 'observe')).events.some((event: any) => event.message?.text === 'Blue only'));
  const red = body(await game.tool('drone-4', 'observe'));
  assert.equal(red.events.some((event: any) => event.message?.text === 'Blue only'), false);
  const injected = { ...game.state.radio.at(-1)!, id: 'cross-domain-forgery', to: 'drone-4' };
  game.receiveRadio('drone-4', injected);
  assert.equal(body(await game.tool('drone-4', 'observe')).events.length, 0);
  game.stop();
});

test('actual image evidence gates mining; shared income unlocks tools without resource or enemy telemetry', async () => {
  const game = await ready(), drone = game.state.drones[0];
  Object.assign(drone, { x: 0, y: 1.4, z: 2, yaw: 0, pitch: 0 });
  game.state.match!.resources = [{ id: 'private-node', x: 0, y: 0.45, z: 0, remaining: 80, capacity: 80 }];
  assert.deepEqual(game.toolCapabilities('drone-1'), { shop: false, gun: false, alive: true });
  const unobserved = body(await game.tool('drone-1', 'mine', { mission: 1, resourceId: 'private-node' }));
  assert.equal(unobserved.accepted, false);
  assert.equal(body(await game.tool('drone-1', 'mine', { mission: 1 })).accepted, true);
  for (let i = 0; i < 88; i++) game.tick(0.25);
  assert.ok(game.state.match!.teams.blue.credits >= 20);
  assert.equal(game.toolCapabilities('drone-2').shop, true);
  assert.equal(game.toolCapabilities('drone-4').shop, false);
  const result = body(await game.tool('drone-2', 'buy', { mission: 1, item: 'gun' }));
  assert.equal(result.equipped, 'gun'); assert.equal(game.toolCapabilities('drone-2').gun, true);
  assert.equal(game.toolCapabilities('drone-1').gun, false);
  assert.equal(game.state.match!.teams.red.credits, 0);
  assert.deepEqual(Object.keys(result.sensors).sort(), ['camera', 'heading', 'position', 'timestamp']);
  for (const secret of ['private-node', 'resources', 'projectiles', 'winner', 'miningRange', 'bulletSpeed', 'enemyPositions']) {
    assert.equal(JSON.stringify(result).includes(secret), false, secret);
  }
  game.stop();
});

test('failed camera cannot authorize resource extraction and own death revokes all action access', async () => {
  const game = await ready(), drone = game.state.drones[0];
  Object.assign(drone, { x: 0, y: 1.4, z: 2 });
  game.state.match!.resources = [{ id: 'private-node', x: 0, y: 0.45, z: 0, remaining: 80, capacity: 80 }];
  game.capture = async () => { throw new Error('No camera'); };
  await game.tool('drone-1', 'observe');
  assert.equal(body(await game.tool('drone-1', 'mine', { mission: 1 })).accepted, false);
  const deaths: string[] = []; game.on('drone-destroyed', event => deaths.push(event.droneId));
  await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 0, y: -1, z: 2 });
  for (let i = 0; i < 20; i++) game.tick(0.25);
  assert.deepEqual(deaths, ['drone-1']);
  const stopped = body(await game.tool('drone-1', 'fire', { mission: 1 }));
  assert.equal(stopped.stopped, true); assert.equal(stopped.destroyed, true); assert.equal(stopped.sensors, undefined);
  assert.equal(game.state.running, true); game.stop();
});

test('death during camera capture never returns a posthumous sensor bundle', async () => {
  const game = await ready();
  game.capture = async () => { game.state.drones[0].alive = false; return 'data:image/jpeg;base64,AQID'; };
  const result = body(await game.tool('drone-1', 'observe'));
  assert.equal(result.stopped, true); assert.equal(result.sensors, undefined); game.stop();
});

test('camera capture receives an immutable simultaneous match snapshot', async () => {
  const game = await ready();
  game.state.drones[0].equipment!.armor = true;
  game.capture = async (_id, _pose, _sim, drones, match) => {
    const reserve = match!.resources[0].remaining;
    game.state.match!.resources[0].remaining = 0;
    game.state.drones[0].equipment!.armor = false;
    assert.equal(match!.resources[0].remaining, reserve);
    assert.equal(drones[0].equipment!.armor, true);
    return 'data:image/jpeg;base64,AQID';
  };
  await game.tool('drone-1', 'observe'); game.stop();
});

test('ongoing mining is own controller state and exhaustion wakes wait without revealing deposit identity', async () => {
  const game = await ready(), drone = game.state.drones[0];
  Object.assign(drone, { x: 0, y: 1.4, z: 2 });
  game.state.match!.resources = [{ id: 'secret-node', x: 0, y: 0.45, z: 0, remaining: 0.5, capacity: 0.5 }];
  await game.tool('drone-1', 'observe');
  const mining = body(await game.tool('drone-1', 'mine', { mission: 1 }));
  assert.deepEqual(mining.currentAction, { id: 'mining', kind: 'mine' });
  assert.equal(JSON.stringify(mining).includes('secret-node'), false);
  game.tick(0.1); await game.tool('drone-1', 'observe'); // Drain first-income notification.
  const waiting = game.tool('drone-1', 'wait', { timeout_ms: 30_000 });
  game.tick(0.25); game.tick(0.25);
  const stopped = body(await waiting);
  assert.equal(stopped.currentAction, null);
  assert.ok(stopped.events.some((event: any) => event.type === 'mining_stopped'));
  assert.equal(JSON.stringify(stopped).includes('secret-node'), false); game.stop();
});

test('an opponent shop unlock cannot produce a duplicate notification in an already unlocked team', async () => {
  const game = await ready();
  game.state.match!.teams.blue.shopUnlocked = true;
  const drone = game.state.drones[3]; Object.assign(drone, { x: 50, y: 1.4, z: 2 });
  game.state.match!.resources = [{ id: 'red-node', x: 50, y: 0.45, z: 0, remaining: 10, capacity: 10 }];
  await game.tool('drone-4', 'observe'); await game.tool('drone-4', 'mine', { mission: 1 });
  game.tick(0.1);
  assert.equal(body(await game.tool('drone-1', 'observe')).events.length, 0);
  assert.ok(body(await game.tool('drone-5', 'observe')).events.some((event: any) => event.type === 'equipment_available'));
  game.stop();
});
