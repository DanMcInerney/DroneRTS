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
  game.state.match!.teams.blue.credits = 30; // Earlier-delivery fixture funds the gun.
  await game.tool('drone-1', 'buy', { mission: 1, item: 'gun' });
  await game.tool('drone-1', 'fire', { mission: 1 });
  game.state.match!.teams.blue.credits = 100;
  return game;
}
function assertPrivate(result: any) {
  assert.equal(result.protocol, 'fleet-observation/2');
  assert.ok(result.sensors.ranges); assert.ok(result.currentTelemetry); assert.ok(result.sensors.cameraOrientation);
  for (const secret of ['private-pad', 'servicePads', 'padId', 'cameraFov', 'serviceRange', 'bulletSpeed', 'resources', 'projectiles']) {
    assert.equal(JSON.stringify(result).includes(secret), false, secret);
  }
}

test('zero opening wallet rejects purchases; one delivered grip funds one atomic module purchase', async t => {
  const game = await ready(); t.after(() => game.stop());
  for (const item of ['gun', 'cargo', 'armor', 'optics']) {
    const result = body(await game.tool('drone-1', 'buy', { mission: 1, item }));
    assert.equal(result.rejected, true); assertPrivate(result);
  }
  assert.equal(game.state.match!.teams.blue.credits, 0);
  const drone = game.state.drones[0];
  game.state.match!.resources = [{ id: 'test-stock', x: drone.x, y: 0, z: drone.z, capacity: 30, remaining: 30, zoneSize: 2.5 }];
  game.state.match!.servicePads = game.state.match!.servicePads!.filter(p => p.team === 'red');
  advance(game, 3.1); assert.equal(drone.cargo!.amount, 30); assert.equal(game.state.match!.teams.blue.credits, 0);
  game.state.match!.servicePads!.push({ id: 'test-base', team: 'blue', x: drone.x, y: 0, z: drone.z, zoneSize: 6 });
  advance(game, 2.1); assert.equal(game.state.match!.teams.blue.credits, 30);
  // Bring a teammate into the same base without collision; no simulation tick needed.
  Object.assign(game.state.drones[1], { x: drone.x + 2, y: drone.y, z: drone.z });
  const purchases = await Promise.all(['gun', 'cargo'].map((item, index) => game.tool(MATCH_DRONE_IDS[index], 'buy', { mission: 1, item })));
  assert.equal(purchases.map(body).filter(result => result.equipped).length, 1);
  assert.equal(game.state.match!.teams.blue.credits, 0); assert.equal(game.state.match!.teams.blue.earned, 30);
  assert.equal(game.state.match!.teams.red.credits, RTS_CONFIG.startingCredits);
  for (const result of purchases.map(body)) assertPrivate(result);
});

test('refitting revokes removed gun tools and rejects optics without spending or hidden world data', async t => {
  const game = await ready(), drone = game.state.drones[0]; t.after(() => game.stop());
  game.state.match!.teams.blue.credits = 300;
  await game.tool('drone-1', 'buy', { mission: 1, item: 'gun' });
  const denied = body(await game.tool('drone-1', 'buy', { mission: 1, item: 'optics' }));
  assert.equal(denied.rejected, true); assert.equal(game.state.match!.teams.blue.credits, 270);
  const cargo = body(await game.tool('drone-1', 'buy', { mission: 1, item: 'cargo', replace: 'gun' }));
  assert.equal(cargo.ammo, 0); assert.equal(cargo.cameraMode, 'wide');
  for (const tool of ['fire', 'rearm', 'camera']) {
    assert.equal(cargo.availableTools.includes(tool), false);
    const rejected = await game.tool('drone-1', tool, { mission: 1, mode: 'zoom' });
    assert.equal(rejected.isError, true); assertPrivate(body(rejected));
  }
  const gun = body(await game.tool('drone-1', 'buy', { mission: 1, item: 'gun', replace: 'cargo' }));
  assert.equal(gun.ammo, 0, 'Refitting a previously purchased gun creates no ammunition');
  assert.equal(drone.cameraMode, 'wide'); assertPrivate(gun);
});

test('rearming enforces per-drone mission versions without spending', async t => {
  const game = await armed(), drone = game.state.drones[0]; t.after(() => game.stop());
  const balance = game.state.match!.teams.blue.credits;
  const rejected = await game.tool('drone-1', 'rearm', { mission: 2 });
  assert.equal(rejected.isError, true); assert.match(body(rejected).error, /mission/); assertPrivate(body(rejected));
  assert.equal(drone.servicing, undefined); assert.equal(game.state.match!.teams.blue.credits, balance);
});

test('rearming stops residual flight, permits looking and radio, and completion wakes wait with fresh sensors', async () => {
  const game = await armed(), drone = game.state.drones[0];
  await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 0, y: 2, z: 18 });
  game.tick(0.1);
  const receipt = body(await game.tool('drone-1', 'rearm', { mission: 1 }));
  assert.deepEqual(receipt.currentAction, { id: 'servicing', kind: 'rearm' });
  assert.equal(receipt.job?.state, 'cancelled', 'Rearming must retire the flight writer, not leave a running job with no movement');
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

test('unavailable legacy mining and recharge calls cannot replace an in-progress rearm', async () => {
  const game = await armed(), drone = game.state.drones[0];
  await game.tool('drone-1', 'rearm', { mission: 1 }); const service = drone.servicing;
  const charging = await game.tool('drone-1', 'recharge', { mission: 1 });
  assert.equal(charging.isError, true); assert.equal(body(charging).charging, undefined); assert.equal(drone.servicing, service);
  assert.equal((await game.tool('drone-1', 'mine', { mission: 1 })).isError, true); assert.equal(drone.servicing, service);
  advance(game, 1); assert.equal(drone.battery, undefined);
  assert.ok(drone.servicing); assert.equal(drone.servicing.kind, 'rearm'); game.stop();
});

test('recorder projection uses capture-time optics while historical cube mining is independent of camera mode', async () => {
  for (const mode of ['wide', 'zoom'] as const) {
    const game = await ready(), drone = game.state.drones[0];
    game.state.match!.rulesVersion = 'cube-v1';
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
