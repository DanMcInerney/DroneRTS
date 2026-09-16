import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { FleetGame } from '../server/game.ts';
import { DroneNervelet } from '../server/nervelet.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';
import type { DroneId, ToolResult } from '../shared/types.ts';

const body = (result: ToolResult) => JSON.parse(result.content.find(item => item.type === 'text')!.text);
async function fixture(t: TestContext) {
  const game = new FleetGame();
  game.setConnected(true); game.start();
  game.state.obstacles = [];
  game.state.drones.forEach((drone, index) => Object.assign(drone, { x: -20 + index * 10, y: 30, z: 0 }));
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  for (const id of MATCH_DRONE_IDS) game.markActorOnline(id);
  await game.forwardTeam('blue'); await game.forwardTeam('red');
  t.after(() => game.stop());
  return game;
}
function calls(game: FleetGame) {
  const changes: DroneId[] = [];
  const lifecycle: { reason: string; drone?: DroneId }[] = [];
  let ticks = 0;
  game.on('onboard-change', event => changes.push(event.drone));
  game.on('onboard-lifecycle', event => lifecycle.push(event));
  game.on('onboard-tick', () => ticks++);
  return { changes, lifecycle, ticks: () => ticks };
}
const execute = (game: FleetGame, id: DroneId, name: string, args: Record<string, unknown> = {}) =>
  game.executeOnboard(id, name, { mission: game.receivedMission(id), ...args }, () => {});

test('movement, look, workspace and mailbox notifications belong to each affected pilot', async t => {
  const game = await fixture(t), events = calls(game);
  for (const id of MATCH_DRONE_IDS.slice(1)) {
    const drone = game.state.drones.find(drone => drone.id === id)!;
    assert.equal(body(await execute(game, id, 'act', { kind: 'fly_to', x: drone.x + 1, y: 30, z: 0 })).accepted, true);
    assert.equal(body(await execute(game, id, 'act', { kind: 'look', heading: 12 })).accepted, true);
    await execute(game, id, 'workspace', { op: 'write', path: 'private.txt', content: id });
    game.inboxes[id].push({ type: 'local-notice', mission: 1 });
  }
  assert.equal(events.changes.includes('drone-1'), false);
  assert.deepEqual(new Set(events.changes), new Set(MATCH_DRONE_IDS.slice(1)));
  assert.deepEqual(events.lifecycle, []);

  events.changes.length = 0;
  game.emit('change'); game.tick(0);
  assert.deepEqual(events.changes, [], 'ordinary UI refresh and idle ticks add no pilot event wakeups');
  assert.equal(events.ticks(), 1, 'numeric waits retain their independent continuous signal');
  game.inboxes['drone-1'].push({ type: 'local-notice', mission: 1 });
  assert.deepEqual(events.changes, ['drone-1']);
});

test('shared spending and refunds notify teammates with visible accounts, independently of the initiator', async t => {
  const game = await fixture(t), buyer = game.state.drones[1];
  const pad = game.state.match!.servicePads!.find(pad => pad.team === 'blue')!;
  Object.assign(buyer, { x: pad.x, y: pad.y + 1, z: pad.z });
  game.state.match!.teams.blue.credits = 100; game.tick(0);
  const events = calls(game);
  assert.equal(body(await execute(game, buyer.id, 'buy', { item: 'gun' })).equipped, 'gun');
  assert.deepEqual(new Set(events.changes), new Set(MATCH_DRONE_IDS.slice(0, 3)));
  events.changes.length = 0;
  await execute(game, buyer.id, 'fire');
  assert.deepEqual(new Set(events.changes), new Set([buyer.id]), 'firing reveals only the firing pilot\'s state');
  events.changes.length = 0;
  await execute(game, buyer.id, 'rearm');
  assert.deepEqual(new Set(events.changes), new Set(MATCH_DRONE_IDS.slice(0, 3)));
  assert.equal(game.state.match!.teams.blue.credits, 60);
  events.changes.length = 0;
  game.stopOnboard(buyer.id);
  assert.equal(game.state.match!.teams.blue.credits, 70);
  assert.deepEqual(new Set(events.changes), new Set(MATCH_DRONE_IDS.slice(0, 3)));
  events.changes.length = 0;
  game.stopOnboard(buyer.id);
  assert.equal(game.state.match!.teams.blue.credits, 70);
  assert.deepEqual(events.changes, [], 'an already cancelled reservation neither refunds nor notifies again');
});

test('connection validity and global lifecycle transitions have explicit signals; destruction is targeted', async t => {
  const game = await fixture(t), events = calls(game);
  game.setConnected(false); game.setConnected(false); game.setConnected(true);
  assert.deepEqual(events.lifecycle, [{ reason: 'connection-changed' }, { reason: 'connection-changed' }]);
  const drone = game.state.drones[0], peer = game.state.drones[1];
  Object.assign(peer, { x: drone.x, y: drone.y, z: drone.z }); peer.equipment!.armor = true;
  game.tick(0.01);
  assert.equal(drone.alive, false);
  assert.deepEqual(events.lifecycle.at(-1), { reason: 'destroyed', drone: drone.id });
  game.stop(); assert.deepEqual(events.lifecycle.at(-1), { reason: 'stopped' });
  game.reset(); assert.deepEqual(events.lifecycle.at(-1), { reason: 'reset' });
  game.start(); assert.deepEqual(events.lifecycle.at(-1), { reason: 'session-replaced' });
});

test('actual goal receipt cancels immediately and the subsequent Bridge stop refunds a service only once', async t => {
  const game = await fixture(t), drone = game.state.drones[0];
  const pad = game.state.match!.servicePads!.find(pad => pad.team === 'blue')!;
  Object.assign(drone, { x: pad.x, y: pad.y + 1, z: pad.z });
  game.state.match!.teams.blue.credits = 100;
  await execute(game, drone.id, 'buy', { item: 'gun' });
  await execute(game, drone.id, 'fire');
  const pilot = new DroneNervelet(game, drone.id);
  t.after(() => pilot.close());
  await pilot.call('observe');
  await execute(game, drone.id, 'rearm');
  assert.equal(game.state.match!.teams.blue.credits, 60);
  game.receiveRadio(drone.id, {
    protocol: 'fleet-radio/1', sessionId: game.sessionIdentity, sequence: 999, id: 'new-goal', from: 'player', to: drone.id,
    kind: 'mission', mission: 2, text: 'Exact replacement objective.', simTime: game.state.simTime, sentAt: new Date().toISOString(),
  });
  assert.equal(drone.servicing, undefined, 'domain cancellation precedes asynchronous Bridge delivery');
  assert.equal(game.state.match!.teams.blue.credits, 70);
  const observation = body(await pilot.call('observe'));
  assert.equal(observation.nervelet.goal.version, 2);
  game.stopOnboard(drone.id); game.stop();
  assert.equal(game.state.match!.teams.blue.credits, 70);
  assert.equal(game.state.match!.events.filter(event => event.type === 'service_cancelled' && event.drone === drone.id).length, 1);
});
