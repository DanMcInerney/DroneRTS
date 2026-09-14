import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetGame } from '../server/game.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';
import { cameraFovFor } from '../shared/camera-profile.ts';
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
async function armed() {
  const game = await ready();
  await game.tool('drone-1', 'buy', { mission: 1, item: 'gun' });
  await game.tool('drone-1', 'fire', { mission: 1 });
  game.state.match!.teams.blue.credits = 100;
  return game;
}
function assertPrivate(result: any) {
  assert.deepEqual(Object.keys(result.sensors).sort(), ['camera', 'heading', 'position', 'timestamp']);
  for (const secret of ['private-pad', 'servicePads', 'padId', 'cameraFov', 'serviceRange', 'bulletSpeed', 'resources', 'projectiles']) {
    assert.equal(JSON.stringify(result).includes(secret), false, secret);
  }
}

test('the shared opening wallet funds exactly one of three simultaneous module choices', async () => {
  const game = await ready();
  const purchases = await Promise.all(['gun', 'miner', 'optics'].map((item, index) => game.tool(MATCH_DRONE_IDS[index], 'buy', { mission: 1, item })));
  assert.equal(purchases.map(body).filter(result => result.equipped).length, 1);
  assert.equal(game.state.match!.teams.blue.credits, 0);
  assert.equal(game.state.match!.teams.blue.earned, 0);
  assert.equal(game.state.match!.teams.red.credits, RTS_CONFIG.startingCredits);
  for (const result of purchases.map(body)) assertPrivate(result);
  game.stop();
});

test('refitting revokes removed equipment tools and returns fresh own status without hidden world data', async () => {
  const game = await ready(), drone = game.state.drones[0];
  game.state.match!.teams.blue.credits = 300;
  await game.tool('drone-1', 'buy', { mission: 1, item: 'gun' });
  const optics = body(await game.tool('drone-1', 'buy', { mission: 1, item: 'optics' }));
  assert.ok(optics.availableTools.includes('fire')); assert.ok(optics.availableTools.includes('rearm')); assert.ok(optics.availableTools.includes('camera'));
  await game.tool('drone-1', 'camera', { mission: 1, mode: 'zoom' });
  const miner = body(await game.tool('drone-1', 'buy', { mission: 1, item: 'miner', replace: 'gun' }));
  assert.equal(miner.ammo, 0); assert.equal(miner.cameraMode, 'zoom');
  assert.equal(miner.availableTools.includes('fire'), false); assert.equal(miner.availableTools.includes('rearm'), false);
  for (const tool of ['fire', 'rearm']) {
    const rejected = await game.tool('drone-1', tool, { mission: 1 });
    assert.equal(rejected.isError, true); assertPrivate(body(rejected));
  }
  const gun = body(await game.tool('drone-1', 'buy', { mission: 1, item: 'gun', replace: 'optics' }));
  assert.equal(gun.cameraMode, 'wide'); assert.equal(gun.ammo, RTS_CONFIG.magazineSize);
  assert.equal(gun.availableTools.includes('camera'), false);
  const denied = await game.tool('drone-1', 'camera', { mission: 1, mode: 'zoom' });
  assert.equal(denied.isError, true); assert.equal(drone.cameraMode, 'wide');
  assertPrivate(gun); assertPrivate(body(denied)); game.stop();
});

test('camera and rearming enforce per-drone mission versions without spending or changing camera mode', async () => {
  const game = await armed(), drone = game.state.drones[0];
  await game.tool('drone-1', 'buy', { mission: 1, item: 'optics' });
  const balance = game.state.match!.teams.blue.credits;
  for (const [name, args] of [['camera', { mode: 'zoom' }], ['rearm', {}]] as const) {
    const rejected = await game.tool('drone-1', name, { ...args, mission: 2 });
    assert.equal(rejected.isError, true); assert.match(body(rejected).error, /mission/); assertPrivate(body(rejected));
  }
  assert.equal(drone.cameraMode, 'wide'); assert.equal(drone.servicing, undefined);
  assert.equal(game.state.match!.teams.blue.credits, balance); game.stop();
});

test('rearming stops residual flight, permits looking and radio, and completion wakes wait with fresh sensors', async () => {
  const game = await armed(), drone = game.state.drones[0];
  await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 0, y: 2, z: 18 });
  game.tick(0.1);
  const receipt = body(await game.tool('drone-1', 'rearm', { mission: 1 }));
  assert.deepEqual(receipt.currentAction, { id: 'servicing', kind: 'rearm' });
  assert.equal(receipt.ammo, RTS_CONFIG.magazineSize - 1); assert.equal(receipt.account.credits, 90);
  const position = { x: drone.x, y: drone.y, z: drone.z };
  await game.tool('drone-1', 'act', { mission: 1, kind: 'look', heading: 30, pitch: -20 });
  await game.tool('drone-1', 'send', { mission: 1, to: 'all', kind: 'chat', text: 'Servicing' });
  assert.ok(drone.servicing); advance(game, RTS_CONFIG.serviceDuration / 2);
  assert.deepEqual({ x: drone.x, y: drone.y, z: drone.z }, position);
  const waiting = game.tool('drone-1', 'wait', { timeout_ms: 30_000 });
  advance(game, RTS_CONFIG.serviceDuration / 2 + 0.1);
  const completed = body(await waiting);
  assert.equal(completed.ammo, RTS_CONFIG.magazineSize); assert.equal(completed.service, null); assert.equal(completed.currentAction, null);
  assert.equal(completed.events.filter((event: any) => event.type === 'service_completed').length, 1);
  assertPrivate(completed); game.stop();
});

test('movement, hover, replacement missions and Stop refund a cancelled service exactly once', async () => {
  for (const cause of ['fly_to', 'hover', 'mission', 'stop']) {
    const game = await armed(), drone = game.state.drones[0];
    await game.tool('drone-1', 'rearm', { mission: 1 }); advance(game, 1);
    assert.equal(game.state.match!.teams.blue.credits, 90);
    if (cause === 'mission') { game.queueMission('New order'); await game.forwardTeam('blue'); }
    else if (cause === 'stop') game.stop();
    else await game.tool('drone-1', 'act', { mission: 1, kind: cause, x: 0, y: 2, z: 19 });
    assert.equal(drone.servicing, undefined, cause); assert.equal(drone.ammo, RTS_CONFIG.magazineSize - 1, cause);
    assert.equal(game.state.match!.teams.blue.credits, 100, cause);
    game.stop(); game.stop(); assert.equal(game.state.match!.teams.blue.credits, 100, cause);
  }
});

test('service completion during capture refreshes the delivered sample once', async () => {
  const game = await armed(); let captures = 0;
  await game.tool('drone-1', 'rearm', { mission: 1 });
  game.capture = async () => { if (++captures === 1) advance(game, RTS_CONFIG.serviceDuration + 0.1); return image(); };
  const result = body(await game.tool('drone-1', 'observe'));
  assert.equal(captures, 2); assert.equal(result.service, null); assert.equal(result.currentAction, null);
  const completed = result.events.find((event: any) => event.type === 'service_completed');
  assert.ok(completed); assert.ok(result.sensors.timestamp.simTime >= completed.simTime); game.stop();
});

test('optional mining and charging status calls cannot replace an in-progress rearm', async () => {
  const game = await armed(), drone = game.state.drones[0]; drone.battery = RTS_CONFIG.batteryCapacity / 2;
  await game.tool('drone-1', 'rearm', { mission: 1 }); const service = drone.servicing;
  const charging = body(await game.tool('drone-1', 'recharge', { mission: 1 }));
  assert.equal(charging.accepted, true); assert.equal(charging.charging, true); assert.equal(drone.servicing, service);
  await game.tool('drone-1', 'mine', { mission: 1 }); assert.equal(drone.servicing, service);
  advance(game, 1); assert.ok(drone.battery! > RTS_CONFIG.batteryCapacity / 2);
  assert.ok(drone.servicing); assert.equal(drone.servicing.kind, 'rearm'); game.stop();
});

test('recorder projection uses capture-time optics while automatic mining is independent of camera mode', async () => {
  for (const mode of ['wide', 'zoom'] as const) {
    const game = await ready(), drone = game.state.drones[0];
    Object.assign(drone, { x: 0, y: 1.4, z: 2, cameraMode: mode }); drone.equipment!.optics = true;
    game.state.match!.resources = [{ id: 'private-node', x: 1.5, y: 0.45, z: 0, remaining: 50, capacity: 50 }];
    const expectedFov = cameraFovFor(drone), records: any[] = [];
    game.on('recorded-observation', record => records.push(record));
    game.capture = async (_id, _pose, _time, drones) => {
      assert.equal(drones[0].cameraMode, mode); assert.equal(cameraFovFor(drones[0]), expectedFov);
      drone.cameraMode = mode === 'wide' ? 'zoom' : 'wide';
      return image();
    };
    const observation = body(await game.tool('drone-1', 'observe'));
    assertPrivate(observation); assert.equal(records.at(-1).cameraFov, expectedFov);
    game.capture = image;
    game.tick(0.1);
    const mined = body(await game.tool('drone-1', 'observe'));
    assert.equal(mined.mining, true); assert.ok(game.state.match!.teams.blue.earned > 0);
    game.stop();
  }
});
