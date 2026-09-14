import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RtsRules } from '../server/rts.ts';
import { emptyEquipment, RTS_CONFIG, type Point } from '../shared/rts.ts';
import type { Drone, DroneId, GameState } from '../shared/types.ts';

function fixture() {
  const rules = new RtsRules();
  const drones: Drone[] = Array.from({ length: 6 }, (_, i) => ({
    id: `drone-${i + 1}`, x: i * 20, y: 8, z: 0, yaw: 0, pitch: 0, team: i < 3 ? 'blue' : 'red',
    alive: true, equipment: emptyEquipment(), status: 'Ready', observations: 0, online: true,
  }));
  const state: GameState = {
    simTime: 0, mission: 1, running: true, speed: 1, completed: false, drones, obstacles: [], radio: [], treasures: [],
    runtime: { status: 'idle', message: '', model: '', effort: '' },
    match: rules.newMatch([{ id: 'salvage', x: 0, y: 0, z: 0, capacity: 100, remaining: 100 }],
      [{ id: 'pad', team: 'blue', x: 0, y: 0, z: 0 }]),
  };
  rules.begin(state); state.match!.rulesVersion = 'cube-v1';
  const drone = drones[0], wallet = state.match!.teams.blue;
  const tick = (dt: number, previous?: Map<DroneId, Point>) => { state.simTime += dt; rules.step(state, dt, previous); };
  return { rules, state, drones, drone, wallet, tick };
}

test('new matches persist default and explicit cube sizes and reset without losing them', () => {
  const { rules, state } = fixture();
  assert.equal(state.match!.resources[0].zoneSize, 6); assert.equal(state.match!.servicePads![0].zoneSize, 6);
  state.match!.resources[0].zoneSize = 12; state.match!.servicePads![0].zoneSize = 4;
  rules.begin(state);
  assert.equal(state.match!.resources[0].zoneSize, 12); assert.equal(state.match!.servicePads![0].zoneSize, 4);
});

test('entering a resource cube mines automatically without camera observations, commands or line of sight', () => {
  const { drone, state, wallet, tick } = fixture(); drone.y = 2;
  state.obstacles = [{ x: 0, z: 1, width: 1, depth: 0.2, height: 6 }]; drone.z = 2;
  tick(2);
  assert.equal(drone.mining, 'salvage'); assert.equal(drone.observations, 0); assert.equal(wallet.earned, 1);
  assert.equal(state.match!.resources[0].remaining, 99);
});

test('all cube faces and corners count, while centers just outside any face do not mine or charge', () => {
  const inside: Point[] = [
    { x: -3, y: 3, z: 0 }, { x: 3, y: 3, z: 0 }, { x: 0, y: 3, z: -3 }, { x: 0, y: 3, z: 3 },
    { x: 0, y: 0, z: 0 }, { x: 0, y: 6, z: 0 }, { x: 3, y: 6, z: -3 },
  ];
  const outside: Point[] = [
    { x: -3.001, y: 3, z: 0 }, { x: 3.001, y: 3, z: 0 }, { x: 0, y: 3, z: -3.001 }, { x: 0, y: 3, z: 3.001 },
    { x: 0, y: -0.001, z: 0 }, { x: 0, y: 6.001, z: 0 },
  ];
  for (const [points, expected] of [[inside, true], [outside, false]] as const) for (const point of points) {
    const { drone, wallet, tick } = fixture(); Object.assign(drone, point); drone.battery = 50;
    tick(1); assert.equal(!!drone.mining, expected); assert.equal(drone.charging, expected);
    assert.equal(wallet.earned, expected ? 0.5 : 0);
    assert.ok(expected ? drone.battery > 50 : drone.battery < 50);
  }
});

test('mine compatibility ignores target guesses and acknowledges only current occupancy without interrupting movement', () => {
  const { rules, state, drone } = fixture(); drone.y = 2;
  const action = { id: 'route', kind: 'fly_to', target: { x: 2, y: 2, z: 2 } }; drone.action = action;
  assert.deepEqual(rules.mine(state, drone, 'nonexistent-target'), { accepted: true, action: 'mine' });
  assert.equal(drone.action, action); assert.equal(drone.mining, 'salvage');
  drone.x = 4; assert.throws(() => rules.mine(state, drone, 'salvage'), /No accessible salvage/);
  assert.equal(drone.mining, undefined); assert.equal(drone.action, action);
});

test('movement and firing within a resource cube preserve extraction; leaving stops it in the same tick', () => {
  const { rules, state, drone, wallet, tick } = fixture(); drone.y = 2;
  rules.buy(state, drone, 'gun'); tick(1); assert.equal(wallet.earned, 0.5);
  const previous = new Map([[drone.id, { x: drone.x, y: drone.y, z: drone.z }]]);
  drone.x = 1; drone.action = { id: 'route', kind: 'fly_to' }; rules.fire(state, drone);
  assert.equal(drone.mining, 'salvage'); tick(1, previous); assert.equal(wallet.earned, 1);
  drone.x = 4; tick(1); assert.equal(wallet.earned, 1); assert.equal(drone.mining, undefined);
  assert.equal(drone.action?.id, 'route'); assert.equal(drone.charging, false);
});

test('competing automatic miners share a rich finite remainder proportionally', () => {
  const { state, drones, wallet, tick } = fixture();
  Object.assign(drones[0], { x: -1, y: 2 }); Object.assign(drones[3], { x: 1, y: 2 });
  drones[0].equipment!.miner = true; drones[0].equipment!.minerUpgrade = true;
  state.match!.resources[0].extractionMultiplier = 1.5; state.match!.resources[0].remaining = 2;
  tick(1);
  assert.equal(wallet.earned, 1.5); assert.equal(state.match!.teams.red.earned, 0.5);
  assert.equal(state.match!.resources[0].remaining, 0);
  assert.equal(drones[0].mining, undefined); assert.equal(drones[3].mining, undefined);
  tick(10); assert.equal(wallet.earned, 1.5);
});

test('overlapping cubes allow rearming, charging and mining together without creating an extra service', () => {
  const { rules, state, drone, wallet, tick } = fixture(); drone.y = 2; wallet.credits = 100;
  rules.buy(state, drone, 'gun'); drone.ammo = 1; drone.battery = 50;
  rules.rearm(state, drone); const service = drone.servicing;
  rules.mine(state, drone); rules.recharge(state, drone);
  assert.equal(drone.servicing, service); tick(4);
  assert.equal(drone.servicing!.remaining, 4); assert.equal(drone.battery, 150); assert.equal(wallet.earned, 2);
  tick(4); assert.equal(drone.ammo, RTS_CONFIG.magazineSize); assert.equal(drone.servicing, undefined);
  assert.equal(drone.battery, 250); assert.equal(wallet.credits, 64);
});

test('a full-charge wakeup occurs exactly once on reaching capacity, including after partial charging', () => {
  const { drone, state, tick } = fixture(); drone.y = 2; drone.battery = 290;
  tick(0.2); assert.equal(drone.battery, 295);
  assert.equal(state.match!.events.filter(event => event.type === 'battery_full').length, 0);
  tick(0.2); tick(1);
  assert.equal(state.match!.events.filter(event => event.type === 'battery_full').length, 1);
  assert.equal(drone.charging, true);
  drone.z = 4; tick(1); drone.z = 0; tick(1);
  assert.equal(state.match!.events.filter(event => event.type === 'battery_full').length, 2);
  const event = state.match!.events.find(event => event.type === 'battery_full')!;
  assert.equal(event.drone, drone.id); assert.equal(event.target, undefined); assert.equal(event.x, undefined);
});

test('Stop, finished matches and death clear zone activity and prevent further income or charge', () => {
  for (const end of ['stop', 'finished', 'death'] as const) {
    const { drone, state, wallet, tick } = fixture(); drone.y = 2; drone.battery = 50; tick(1);
    const credits = wallet.credits, battery = drone.battery;
    if (end === 'stop') state.running = false;
    if (end === 'finished') state.match!.phase = 'finished';
    if (end === 'death') drone.alive = false;
    tick(1); assert.equal(drone.mining, undefined); assert.equal(drone.charging, false);
    assert.equal(wallet.credits, credits); assert.equal(drone.battery, battery);
  }
});
