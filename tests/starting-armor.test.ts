import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetGame } from '../server/game.ts';
import { terrainContact } from '../server/rts-geometry.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';
import { RTS_CONFIG } from '../shared/rts.ts';
import type { ToolResult } from '../shared/types.ts';

const body = (result: ToolResult) => JSON.parse((result.content[0] as { text: string }).text);
const position = (drone: { x: number; y: number; z: number }) => ({ x: drone.x, y: drone.y, z: drone.z });
async function ready() {
  const game = new FleetGame(); game.setConnected(true); game.start();
  // Synthetic images are only the unit-test transport seam, not visual evidence.
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  for (const id of MATCH_DRONE_IDS) await game.tool(id, 'observe');
  await game.forwardTeam('blue'); await game.forwardTeam('red');
  for (const id of MATCH_DRONE_IDS) await game.tool(id, 'observe');
  return game;
}

test('ready, launch, relaunch and reset start unarmored with empty independent equipment and zero credits', () => {
  const game = new FleetGame(); game.setConnected(true);
  const check = () => {
    assert.equal(game.state.drones.length, 6);
    for (const drone of game.state.drones) {
      assert.equal(drone.equipment?.armor, false);
      assert.equal(drone.equipment?.gun, false);
      assert.equal(drone.equipment?.miner, false);
    }
    assert.notEqual(game.state.drones[0].equipment, game.state.drones[1].equipment);
    for (const wallet of Object.values(game.state.match!.teams)) {
      assert.equal(wallet.credits, RTS_CONFIG.startingCredits); assert.equal(wallet.earned, 0);
    }
    assert.equal(game.state.match!.events.filter(event => event.type === 'purchased').length, 0);
  };
  check(); game.start(); check();
  game.state.drones[0].equipment!.armor = true;
  game.state.drones[0].equipment!.gun = true;
  game.state.match!.teams.blue.credits = 0;
  game.stop(); game.start(); check();
  game.state.drones[0].equipment!.armor = true;
  game.stop(); game.reset(); check();
});

// Actual last waypoints before the three building deaths in the 16:28 UTC trial.
// These are developer-only counterfactual fixtures, never actor instructions.
const collisions = [
  { id: 'drone-6' as const, from: { x: 45.20000076293945, y: 4, z: 21.5 }, target: { x: 38, y: 4, z: 18 } },
  { id: 'drone-4' as const, from: { x: 51.599998474121094, y: 20, z: 21.899999618530273 }, target: { x: 39, y: 20, z: 20 } },
  { id: 'drone-5' as const, from: { x: 35, y: 10, z: 22.799999237060547 }, target: { x: 24, y: 10, z: 12 } },
];
for (const collision of collisions) test(`${collision.id}'s recorded route brakes; actual contact consumes armor with private feedback and stops flight`, async t => {
  const game = await ready(); t.after(() => game.stop());
  const drone = game.state.drones.find(drone => drone.id === collision.id)!;
  drone.equipment!.armor = true; // Explicit purchased-armor damage fixture.
  Object.assign(drone, collision.from);
  const command = { mission: 1, kind: 'fly_to', ...collision.target };
  assert.equal(body(await game.tool(drone.id, 'act', command)).accepted, true);
  await new Promise(resolve => setImmediate(resolve));
  for (let step = 0; step < 1200 && drone.action; step++) game.tick(1 / 120);
  assert.equal(drone.alive, true); assert.equal(drone.equipment!.armor, true);
  assert.equal(drone.job?.state, 'blocked', 'The modeled local ranges prevent this controllable contact');
  const hit = terrainContact(collision.from, collision.target, game.state.obstacles, RTS_CONFIG.droneRadius);
  assert.ok(hit, 'The historical path still intersects authoritative city geometry');
  const overlap = { x: hit.contact.x - hit.normal.x * 0.001,
    y: hit.contact.y - hit.normal.y * 0.001, z: hit.contact.z - hit.normal.z * 0.001 };
  await game.tool(drone.id, 'observe');
  const waiting = game.tool(drone.id, 'wait', { timeout_ms: 1000 });
  Object.assign(drone, overlap); game.tick(1 / 120);
  const feedback = body(await waiting);
  assert.equal(drone.alive, true); assert.equal(drone.equipment!.armor, false);
  assert.equal(drone.action, undefined);
  const alerts = feedback.events.filter((event: any) => event.type === 'armor_lost');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].cause, 'collision');
  assert.equal(alerts[0].message, 'Collision detected. Armor lost.');
  assert.ok(Number.isFinite(Date.parse(alerts[0].occurredAt)));
  assert.deepEqual(Object.keys(alerts[0]).sort(), ['cause', 'cursor', 'message', 'mission', 'occurredAt', 'simTime', 'type']);
  assert.equal(feedback.equipment.armor, false);
  assert.equal(feedback.protocol, 'fleet-observation/2'); assert.ok(feedback.sensors.ranges); assert.ok(feedback.currentTelemetry);
  const stopped = position(drone);
  for (let step = 0; step < 120; step++) game.tick(1 / 120);
  assert.equal(drone.alive, true); assert.deepEqual(position(drone), stopped, 'impact clears residual velocity');
  assert.equal(body(await game.tool(drone.id, 'observe')).events.some((event: any) => event.type === 'armor_lost'), false);
  const peer = game.state.drones.find(other => other.team === drone.team && other.id !== drone.id)!;
  assert.equal(body(await game.tool(peer.id, 'observe')).events.some((event: any) => event.type === 'armor_lost'), false);

  Object.assign(drone, overlap); game.tick(1 / 120);
  assert.equal(drone.alive, false, 'a second unprotected collision remains lethal');
});

test('purchased armor absorbs a bullet with hit feedback, without reporting a collision or attacker', async t => {
  const game = await ready(); t.after(() => game.stop()); game.state.obstacles = [];
  game.state.drones.forEach((drone, i) => Object.assign(drone, { x: i * 30, y: 5, z: 30 }));
  const target = game.state.drones[0], shooter = game.state.drones[3];
  Object.assign(target, { x: 0, y: 5, z: 0 });
  Object.assign(shooter, { x: 0, y: 5, z: 8, yaw: 0, pitch: 0 });
  target.equipment!.armor = true;
  shooter.equipment!.gun = true; shooter.ammo = 1;
  await game.tool(shooter.id, 'fire', { mission: 1 });
  for (let step = 0; step < 120 && target.equipment!.armor; step++) game.tick(1 / 120);
  const feedback = body(await game.tool(target.id, 'observe'));
  const alert = feedback.events.find((event: any) => event.type === 'armor_lost');
  assert.equal(target.alive, true); assert.equal(target.equipment!.armor, false);
  assert.equal(alert.cause, 'hit'); assert.equal(alert.message, 'Hit detected. Armor lost.');
  assert.deepEqual(Object.keys(alert).sort(), ['cause', 'cursor', 'message', 'mission', 'occurredAt', 'simTime', 'type']);
});
