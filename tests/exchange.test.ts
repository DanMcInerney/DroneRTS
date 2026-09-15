import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetGame } from '../server/game.ts';
import type { ToolResult } from '../shared/types.ts';
const value = (result: ToolResult) => JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
async function fresh(t: { after(fn: () => void): void }) {
  const game = new FleetGame(); let captures = 0;
  game.capture = async () => { captures++; return 'data:image/png;base64,AQID'; };
  game.setConnected(true); game.start(); t.after(() => game.stop());
  for (const drone of game.state.drones) await game.tool(drone.id, 'observe');
  await game.forwardTeam('blue'); await game.forwardTeam('red');
  return { game, captures: () => captures };
}
test('compatible submissions return individual outcomes and one fresh aggregate camera bundle', async t => {
  const { game, captures } = await fresh(t); const drone = game.state.drones[0], before = captures();
  const result = value(await game.tool(drone.id, 'exchange', { mission: 1, operations: [
    { id: 'move', tool: 'route', args: { op: 'start', waypoints: [{ x: drone.x, y: drone.y + 3, z: drone.z }] } },
    { id: 'camera', tool: 'act', args: { kind: 'look', pitch: -40 } },
    { id: 'mail', tool: 'send', args: { to: 'drone-2', kind: 'chat', text: 'Submitted a caller-chosen route.' } },
  ] }));
  assert.equal(captures() - before, 1);
  assert.deepEqual(result.outcomes.map((outcome: { id: string }) => outcome.id), ['move', 'camera', 'mail']);
  assert.equal(result.outcomes[0].result.accepted, true);
  assert.equal(result.atomic, false); assert.equal(result.sensors.camera.available, true);
  assert.ok(game.inboxes['drone-2'].events.some(event => event.type === 'radio'));
});
test('a later rejected side effect does not roll back earlier accepted movement', async t => {
  const { game } = await fresh(t); const drone = game.state.drones[0];
  const result = value(await game.tool(drone.id, 'exchange', { mission: 1, operations: [
    { id: 'move', tool: 'act', args: { kind: 'fly_to', x: drone.x, y: drone.y + 2, z: drone.z } },
    { id: 'invalid', tool: 'buy', args: { item: 'miner' } },
  ] }));
  assert.equal(result.outcomes[0].result.accepted, true);
  assert.equal(result.outcomes[1].result.rejected, true);
  assert.equal(drone.job?.state, 'running'); assert.ok(drone.action);
  assert.equal(game.state.match!.teams.blue.credits, 0);
});
test('oversize batches and competing movement writers are rejected before admission', async t => {
  const { game } = await fresh(t);
  const entry = (id: string) => ({ id, tool: 'act', args: { kind: 'hover' } });
  for (const operations of [[entry('a'), entry('b')], Array.from({ length: 9 }, (_, i) => entry(String(i)))]) {
    const result = value(await game.tool('drone-1', 'exchange', { mission: 1, operations }));
    assert.equal(result.rejected, true); assert.equal(game.state.drones[0].job, undefined);
  }
});
test('batch admission does not grant a later operation a capability acquired inside that batch', async t => {
  const { game } = await fresh(t);
  game.state.match!.teams.blue.credits = 30; // Fund this purchase fixture.
  const result = value(await game.tool('drone-1', 'exchange', { mission: 1, operations: [
    { id: 'fit', tool: 'buy', args: { item: 'gun' } }, { id: 'shot', tool: 'fire', args: {} },
  ] }));
  assert.equal(result.outcomes[0].result.equipped, 'gun');
  assert.equal(result.outcomes[1].result.rejected, true);
  assert.equal(game.state.drones[0].ammo, 12); assert.equal(game.state.match!.projectiles.length, 0);
});
test('objective replacement during a batch preserves prior receipts and rejects remaining stale operations', async t => {
  const { game } = await fresh(t);
  game.radioTransport = { consume() {}, send: async () => {
    game.receiveRadio('drone-1', { protocol: 'fleet-radio/1', sessionId: game.sessionIdentity, sequence: 900, sentAt: new Date().toISOString(),
      id: 'new-objective', from: 'player', to: 'drone-1', kind: 'mission', text: 'New objective', simTime: game.state.simTime, mission: 2 });
  } };
  const result = value(await game.tool('drone-1', 'exchange', { mission: 1, operations: [
    { id: 'mail', tool: 'send', args: { to: 'drone-2', kind: 'chat', text: 'First committed effect.' } },
    { id: 'fit', tool: 'buy', args: { item: 'gun' } },
  ] }));
  assert.ok(result.outcomes[0].result.queued); assert.equal(result.outcomes[1].result.rejected, true);
  assert.equal(result.mission, 2); assert.equal(game.state.drones[0].equipment!.gun, false);
});
