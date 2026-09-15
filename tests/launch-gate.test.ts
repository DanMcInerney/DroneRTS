import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetGame } from '../server/game.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';
import type { ToolResult } from '../shared/types.ts';

const body = (result: ToolResult) => JSON.parse(result.content.find(item => item.type === 'text')!.text);

test('launch waits for six actual objective bundles and prevents time, movement and spending advantages', async t => {
  const game = new FleetGame(); game.setConnected(true); game.start(); game.awaitFleetLaunch();
  t.after(() => game.stop()); game.capture = async () => 'data:image/jpeg;base64,AQID';
  for (const id of MATCH_DRONE_IDS) assert.equal(body(await game.tool(id, 'observe')).launchReady, false);
  await game.forwardTeam('blue'); await game.forwardTeam('red');
  for (const id of MATCH_DRONE_IDS.slice(0, 5)) assert.equal(body(await game.tool(id, 'observe')).launchReady, false);
  const drone = game.state.drones[0];
  assert.equal(body(await game.tool(drone.id, 'act', { mission: 1, kind: 'fly_to', x: drone.x, y: 8, z: drone.z })).launchPending, true);
  assert.equal(body(await game.tool(drone.id, 'buy', { mission: 1, item: 'gun' })).launchPending, true);
  assert.equal(drone.action, undefined); assert.equal(game.state.match!.teams.blue.credits, 0);
  game.tick(0.25); assert.equal(game.state.simTime, 0);
  assert.equal(body(await game.tool('drone-6', 'observe')).launchReady, true);
  const released = body(await game.tool(drone.id, 'observe'));
  assert.equal(released.launchReady, true); assert.ok(released.events.some((event: any) => event.type === 'launch_ready'));
  assert.equal(body(await game.tool(drone.id, 'act', { mission: 1, kind: 'fly_to', x: drone.x, y: 8, z: drone.z })).accepted, true);
  game.tick(0.25); assert.ok(game.state.simTime > 0);
});

test('an opening objective replaced before bundle delivery can still release launch', async t => {
  const game = new FleetGame(); game.setConnected(true); game.start(); game.awaitFleetLaunch();
  t.after(() => game.stop()); game.capture = async () => 'data:image/jpeg;base64,AQID';
  for (const id of MATCH_DRONE_IDS) await game.tool(id, 'observe');
  await game.forwardTeam('blue'); await game.forwardTeam('red');
  game.queueMission('Updated blue opening'); await game.forwardTeam('blue');
  for (const id of MATCH_DRONE_IDS) await game.tool(id, 'observe');
  assert.equal(body(await game.tool('drone-1', 'observe')).launchReady, true);
  game.tick(0.25); assert.ok(game.state.simTime > 0);
});
