import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RtsRules } from '../server/rts.ts';
import { emptyEquipment, startingEquipment, RTS_CONFIG, type EquipmentItem, type Point } from '../shared/rts.ts';
import type { Drone, DroneId, GameState } from '../shared/types.ts';

function fixture(historical = false) {
  const rules = new RtsRules();
  const drones: Drone[] = Array.from({ length: 6 }, (_, i) => ({
    id: `drone-${i + 1}`, x: i * 15, y: 5, z: 0, yaw: 0, pitch: 0, team: i < 3 ? 'blue' : 'red',
    alive: true, equipment: emptyEquipment(), status: 'Ready', observations: 0, online: true,
  }));
  const pads = drones.map(drone => ({ id: `pad-${drone.id}`, x: drone.x, y: drone.y, z: drone.z, team: drone.team! }));
  const state: GameState = {
    simTime: 0, mission: 1, running: true, speed: 1, completed: false, drones, obstacles: [], radio: [], treasures: [],
    runtime: { status: 'idle', message: '', model: '', effort: '' },
    match: rules.newMatch([{ id: 'salvage', x: 0, y: 0, z: 0, capacity: 1000, remaining: 1000, zoneSize: 3 }], pads),
  };
  rules.begin(state);
  // Seed a funded purchase fixture; new-match/reset assertions below still require zero.
  for (const wallet of Object.values(state.match!.teams)) wallet.credits = 30;
  if (historical) state.match!.rulesVersion = 'cube-v1';
  // Equipment purchase fixtures exercise replacement after starting armor is lost.
  for (const drone of drones) drone.equipment = emptyEquipment();
  const match = state.match!, drone = drones[0], wallet = match.teams.blue;
  const tick = (dt: number, previous?: Map<DroneId, Point>) => { state.simTime += dt; rules.step(state, dt, previous); };
  const buy = (item: EquipmentItem) => rules.buy(state, drone, item);
  const readyToRearm = (ammo = 3) => {
    buy('gun'); drone.ammo = ammo; wallet.credits = 100;
    return rules.rearm(state, drone);
  };
  return { rules, state, drones, drone, match, wallet, tick, buy, readyToRearm };
}

test('historical cube-v1: replacement discards drill upgrade without a refund', () => {
  const { rules, state, drone, wallet, buy } = fixture(true); wallet.credits = 300;
  buy('miner'); buy('miner_upgrade'); buy('optics'); buy('armor');
  drone.cameraMode = 'zoom';
  assert.equal(wallet.credits, 160);
  const before = structuredClone(drone.equipment);
  assert.throws(() => buy('gun'), /Both module slots/);
  assert.deepEqual(drone.equipment, before); assert.equal(wallet.credits, 160);
  rules.buy(state, drone, 'gun', 'miner');
  assert.equal(wallet.credits, 130); assert.equal(drone.ammo, 12);
  assert.deepEqual(drone.equipment, { ...emptyEquipment(), gun: true, armor: true, optics: true });
  assert.equal(drone.cameraMode, 'zoom');
  rules.buy(state, drone, 'miner', 'optics');
  assert.equal(drone.cameraMode, 'wide'); assert.equal(wallet.credits, 100);
  rules.buy(state, drone, 'optics', 'gun');
  assert.equal(drone.ammo, 0); assert.equal(drone.equipment!.gun, false); assert.equal(wallet.credits, 70);
});

test('historical cube-v1: invalid replacement and drill upgrades preserve equipment and salvage', () => {
  const { rules, state, drone, wallet, buy } = fixture(true); wallet.credits = 100;
  assert.throws(() => buy('miner_upgrade'), /drill is required/);
  buy('gun');
  const before = structuredClone(drone.equipment);
  for (const replace of ['miner', 'optics', '__proto__']) {
    assert.throws(() => rules.buy(state, drone, 'miner', replace as 'miner'), /Replacement/);
  }
  assert.throws(() => rules.buy(state, drone, 'gun', 'gun'), /Replacement/);
  assert.throws(() => rules.buy(state, drone, 'armor', 'gun'), /Replacement/);
  assert.deepEqual(drone.equipment, before); assert.equal(wallet.credits, 70); assert.equal(drone.ammo, 12);
  wallet.credits = 29;
  assert.throws(() => rules.buy(state, drone, 'optics', 'gun'), /Insufficient/);
  assert.deepEqual(drone.equipment, before); assert.equal(wallet.credits, 29); assert.equal(drone.ammo, 12);
  wallet.credits = 100; buy('miner'); buy('miner_upgrade');
  assert.throws(() => buy('miner_upgrade'), /already equipped/);
  assert.equal(wallet.credits, 10);
});

test('buying needs friendly cube occupancy with no extra sight gate or pad locator', () => {
  const { rules, state, drone, drones, wallet, buy } = fixture();
  Object.assign(drone, { x: 6 });
  assert.throws(() => buy('gun'), /friendly service pad/);
  Object.assign(drone, { x: drones[3].x, y: 6 });
  assert.throws(() => buy('gun'), /friendly service pad/);
  Object.assign(drone, { x: 0, y: 5, z: 2 });
  state.obstacles = [{ x: 0, z: 1, width: 1, depth: 0.2, height: 7 }];
  assert.deepEqual(rules.buy(state, drone, 'gun'), { equipped: 'gun', credits: 0 });
});

test('historical cube-v1: drill payback follows actual extraction time', () => {
  const income = (items: EquipmentItem[]) => {
    const { rules, state, drone, wallet, buy, tick } = fixture(true); wallet.credits = 100;
    for (const item of items) buy(item);
    drone.y = 1.5;
    rules.mine(state, drone, 'salvage'); tick(60);
    return wallet.earned;
  };
  const bare = income([]), drill = income(['miner']), upgraded = income(['miner', 'miner_upgrade']);
  assert.equal(bare, 30); assert.equal(drill, 60); assert.equal(upgraded, 90);
  assert.equal(drill - bare, RTS_CONFIG.prices.miner);
  assert.equal((upgraded - drill) * 2, RTS_CONFIG.prices.miner_upgrade);
});

test('historical cube-v1: richness multiplies extraction and finite stock is split proportionally', () => {
  const { rules, state, drones, match, tick } = fixture(true);
  Object.assign(drones[0], { x: -1, y: 1.5 }); Object.assign(drones[3], { x: 1, y: 1.5 });
  drones[0].equipment!.miner = true;
  match.resources[0].extractionMultiplier = 1.5;
  rules.mine(state, drones[0], 'salvage'); rules.mine(state, drones[3], 'salvage'); tick(4);
  assert.equal(match.teams.blue.earned, 6); assert.equal(match.teams.red.earned, 3);
  match.resources[0].remaining = 0.75;
  tick(1);
  assert.equal(match.teams.blue.earned, 6.5); assert.equal(match.teams.red.earned, 3.25);
  assert.equal(match.resources[0].remaining, 0);
  assert.equal(drones[0].mining, undefined); assert.equal(drones[3].mining, undefined);
  tick(20); assert.equal(match.teams.blue.earned + match.teams.red.earned, 9.75);
});

test('each actual shot spends one round and rejected empty or cycling shots create no projectile', () => {
  const { rules, state, drone, match, buy } = fixture(); buy('gun');
  for (let round = 0; round < RTS_CONFIG.magazineSize; round++) {
    state.simTime = round * RTS_CONFIG.fireCooldown;
    rules.fire(state, drone);
    assert.equal(drone.ammo, 11 - round);
    if (drone.ammo) assert.throws(() => rules.fire(state, drone), /cycling/);
    assert.equal(match.projectiles.length, round + 1);
  }
  state.simTime += 1;
  assert.throws(() => rules.fire(state, drone), /magazine is empty/);
  assert.equal(match.projectiles.length, 12); assert.equal(drone.ammo, 0);
});

test('rearm reserves one payment, completes only after eight seconds, and fills instead of adding ammunition', () => {
  const { drone, wallet, tick, readyToRearm, match, rules, state } = fixture();
  assert.deepEqual(readyToRearm(3), { accepted: true, action: 'rearm', credits: 90 });
  assert.throws(() => rules.rearm(state, drone), /already in progress/);
  tick(7.9);
  assert.equal(drone.ammo, 3); assert.ok(drone.servicing!.remaining > 0); assert.equal(wallet.credits, 90);
  tick(0.1);
  assert.equal(drone.ammo, 12); assert.equal(drone.servicing, undefined); assert.equal(wallet.credits, 90);
  assert.equal(match.events.filter(event => event.type === 'service_completed').length, 1);
  rules.cancelService(state, drone); tick(20);
  assert.equal(wallet.credits, 90); assert.equal(drone.ammo, 12);
});

test('rearm rejects missing guns, full magazines, insufficient funds, enemy pads and dead drones without spending', () => {
  const { rules, state, drone, drones, wallet, buy } = fixture();
  assert.throws(() => rules.rearm(state, drone), /No gun/);
  buy('gun'); wallet.credits = 100;
  assert.throws(() => rules.rearm(state, drone), /already full/);
  drone.ammo = 0; wallet.credits = 9;
  assert.throws(() => rules.rearm(state, drone), /Insufficient/);
  wallet.credits = 100; drone.x = drones[3].x; drone.y = 6;
  assert.throws(() => rules.rearm(state, drone), /friendly service pad/);
  drone.x = 0; drone.alive = false;
  assert.throws(() => rules.rearm(state, drone), /destroyed/);
  assert.equal(wallet.credits, 100); assert.equal(drone.ammo, 0); assert.equal(drone.servicing, undefined);
});

test('simultaneous teammates cannot reserve the same rearm funds', async () => {
  const { rules, state, drones, wallet } = fixture(); wallet.credits = 70;
  rules.buy(state, drones[0], 'gun'); rules.buy(state, drones[1], 'gun');
  drones[0].ammo = 0; drones[1].ammo = 0;
  const results = await Promise.allSettled([0, 1].map(i => Promise.resolve().then(() => rules.rearm(state, drones[i]))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(drones.filter(drone => drone.servicing).length, 1); assert.equal(wallet.credits, 0);
});

for (const interruption of ['fire', 'buy', 'move', 'action', 'leave', 'pad_removed', 'gun_removed', 'death'] as const) {
  test(`rearm interruption by ${interruption} refunds exactly once and grants no ammunition`, () => {
    const { rules, state, drone, match, wallet, tick, readyToRearm, buy } = fixture();
    readyToRearm(3); tick(4);
    const before = { x: drone.x, y: drone.y, z: drone.z };
    let expectedCredits = 100, expectedAmmo = 3;
    switch (interruption) {
      case 'fire': rules.fire(state, drone); expectedAmmo = 2; break;
      case 'buy': buy('armor'); expectedCredits -= 20; break;
      case 'move': drone.x += 0.01; break;
      case 'action': drone.action = { id: 'moving', kind: 'move' }; break;
      case 'leave': drone.z = 10; break;
      case 'pad_removed': match.servicePads = []; break;
      case 'gun_removed': drone.equipment!.gun = false; break;
      case 'death': drone.alive = false; break;
    }
    tick(4, new Map([[drone.id, before]]));
    assert.equal(drone.servicing, undefined); assert.equal(wallet.credits, expectedCredits); assert.equal(drone.ammo, expectedAmmo);
    rules.cancelService(state, drone); rules.cancelService(state, drone); tick(10);
    assert.equal(wallet.credits, expectedCredits); assert.equal(drone.ammo, expectedAmmo);
    assert.equal(match.events.filter(event => event.type === 'service_cancelled').length, 1);
    assert.equal(match.events.filter(event => event.type === 'service_completed').length, 0);
  });
}

test('damage cancels and refunds service before armor consumption or death', () => {
  for (const armor of [false, true]) {
    const { rules, state, drone, wallet, readyToRearm, tick } = fixture(); readyToRearm();
    drone.equipment!.armor = armor;
    rules.terrainCollision(state, drone, drone, { x: drone.x, y: -2, z: drone.z });
    assert.equal(drone.alive, armor); assert.equal(wallet.credits, 100); assert.equal(drone.servicing, undefined);
    rules.cancelService(state, drone); tick(20); assert.equal(wallet.credits, 100);
    if (!armor) {
      assert.equal(drone.ammo, 0);
      assert.throws(() => rules.mine(state, drone, 'salvage'), /destroyed/);
      assert.throws(() => rules.rearm(state, drone), /destroyed/);
    }
  }
});

test('successful refit can spend its own reserved refund, while invalid transactions leave service untouched', () => {
  const { rules, state, drone, wallet, readyToRearm, buy } = fixture(); readyToRearm();
  wallet.credits = 19;
  const reservation = structuredClone(drone.servicing), gear = structuredClone(drone.equipment);
  assert.throws(() => rules.buy(state, drone, 'cargo', 'gun'), /Insufficient/);
  assert.deepEqual(drone.equipment, gear); assert.deepEqual(drone.servicing, reservation); assert.equal(wallet.credits, 19);
  buy('armor');
  assert.equal(wallet.credits, 9); assert.equal(drone.equipment!.armor, true); assert.equal(drone.servicing, undefined);
  assert.equal(drone.ammo, 3);
});

test('removing a gun during refit cancels rearm and discards ammunition', () => {
  const { rules, state, drone, wallet, readyToRearm, tick } = fixture(); readyToRearm();
  rules.buy(state, drone, 'cargo', 'gun');
  assert.equal(drone.equipment!.gun, false); assert.equal(drone.ammo, 0); assert.equal(wallet.credits, 70);
  assert.equal(drone.servicing, undefined); tick(20); assert.equal(drone.ammo, 0);
});

test('begin refunds the old wallet once, preserves pads and installs a clean opening without inherited refunds', () => {
  const { rules, state, drone, wallet, readyToRearm, match } = fixture(); readyToRearm();
  drone.cameraMode = 'zoom'; drone.equipment!.optics = true; drone.equipment!.minerUpgrade = true;
  const pads = structuredClone(match.servicePads);
  rules.begin(state);
  assert.equal(wallet.credits, 100);
  assert.deepEqual(state.match!.teams.blue, { credits: 0, earned: 0, shopUnlocked: true });
  assert.deepEqual(state.match!.servicePads, pads);
  assert.deepEqual(drone.equipment, startingEquipment()); assert.equal(drone.servicing, undefined);
  assert.equal(drone.ammo, 0); assert.equal(drone.cameraMode, 'wide');
  rules.cancelService(state, drone); assert.equal(state.match!.teams.blue.credits, 0);
});

test('match victory cancels survivor servicing and refunds the unfinished magazine', () => {
  const { drones, drone, wallet, readyToRearm, tick, match } = fixture(); readyToRearm();
  for (const opponent of drones.filter(value => value.team === 'red')) opponent.alive = false;
  tick(1);
  assert.equal(match.phase, 'finished'); assert.equal(drone.servicing, undefined);
  assert.equal(wallet.credits, 100); assert.equal(drone.ammo, 3);
});
