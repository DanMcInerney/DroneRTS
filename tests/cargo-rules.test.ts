import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RtsRules } from '../server/rts.ts';
import { cargoCapacityFor, CARGO_CONFIG, EQUIPMENT_MODULES, RTS_CONFIG, type Point } from '../shared/rts.ts';
import type { Drone, DroneId, GameState } from '../shared/types.ts';

function fixture(stock = 60) {
  const rules = new RtsRules();
  const drones: Drone[] = Array.from({ length: 6 }, (_, i) => ({
    id: `drone-${i + 1}`, x: i === 0 ? 0 : i === 3 ? 60 : 100 + i * 10, y: 1.5, z: 0,
    yaw: 0, pitch: 0, team: i < 3 ? 'blue' : 'red', alive: true,
    status: 'Ready', observations: 0, online: true,
  }));
  const state: GameState = {
    simTime: 0, mission: 1, running: true, speed: 1, completed: false, drones, obstacles: [], radio: [], treasures: [],
    runtime: { status: 'idle', message: '', model: '', effort: '' },
    match: rules.newMatch([{ id: 'fixture-stock', x: 20, y: 0, z: 0, capacity: stock, remaining: stock, zoneSize: 6 }], [
      { id: 'blue-base', team: 'blue', x: 0, y: 0, z: 0, zoneSize: 6 },
      { id: 'red-base', team: 'red', x: 60, y: 0, z: 0, zoneSize: 6 },
    ]),
  };
  rules.begin(state);
  const tick = (dt: number, previous?: Map<DroneId, Point>) => { state.simTime += dt; rules.step(state, dt, previous); };
  const at = (drone: Drone, x: number, y = 1.5, z = 0) => { Object.assign(drone, { x, y, z, velocity: { x: 0, y: 0, z: 0 } }); };
  const load = (drone = drones[0]) => { at(drone, 20); tick(CARGO_CONFIG.pickupDuration); };
  const conserved = () => state.match!.resources.reduce((sum, node) => sum + node.remaining, 0)
    + drones.reduce((sum, drone) => sum + (drone.cargo?.amount ?? 0), 0)
    + state.match!.teams.blue.earned + state.match!.teams.red.earned + (state.match!.salvageLost ?? 0);
  return { rules, state, drones, drone: drones[0], enemy: drones[3], tick, at, load, conserved,
    match: state.match!, stock: state.match!.resources[0], wallet: state.match!.teams.blue };
}

test('cargo-v1 opens with 30 shared credits, armor, free grips and only four module choices', () => {
  const { state, drones, wallet } = fixture();
  assert.equal(state.match!.rulesVersion, 'cargo-v1');
  assert.deepEqual(wallet, { credits: 30, earned: 0, shopUnlocked: true });
  assert.deepEqual(EQUIPMENT_MODULES, ['gun', 'cargo', 'optics', 'battery']);
  for (const drone of drones) {
    assert.equal(drone.equipment!.armor, true);
    assert.ok(EQUIPMENT_MODULES.every(item => !drone.equipment![item]));
    assert.equal(cargoCapacityFor(drone), 30); assert.equal(drone.cargo!.amount, 0);
  }
});

test('pickup reserves stock atomically for three seconds and creates cargo without income', () => {
  const { drone, tick, at, wallet, stock, conserved, match } = fixture();
  at(drone, 20); tick(2.9);
  assert.equal(drone.logistics!.state, 'loading'); assert.ok(drone.logistics!.progress > 0.96);
  assert.equal(stock.remaining, 60); assert.equal(stock.reserved, 30);
  assert.equal(drone.cargo!.amount, 0); assert.equal(wallet.credits, 30); assert.equal(conserved(), 60);
  tick(0.1);
  assert.equal(drone.logistics!.state, 'carrying'); assert.equal(drone.cargo!.amount, 30);
  assert.equal(stock.remaining, 30); assert.equal(stock.reserved, 0); assert.equal(wallet.earned, 0);
  tick(20);
  assert.equal(drone.logistics!.reason, 'cargo_full'); assert.equal(stock.remaining, 30);
  assert.equal(match.events.filter(event => event.type === 'cargo_loading').length, 1);
  assert.equal(conserved(), 60);
});

test('a cargo module fills two crates in one interval and partial stock fills a partial load', () => {
  const { rules, state, drone, load, stock, wallet, conserved } = fixture(45);
  rules.buy(state, drone, 'cargo'); assert.equal(wallet.credits, 0);
  assert.equal(cargoCapacityFor(drone), 60); load();
  assert.equal(drone.cargo!.amount, 45); assert.equal(stock.remaining, 0);
  assert.equal(wallet.earned, 0); assert.equal(conserved(), 45);
});

test('contending teams never reserve or pick up the same last crate', () => {
  const { drones, drone, enemy, tick, at, stock, match, conserved } = fixture(45);
  at(drone, 19); at(enemy, 21); at(drones[1], 20, 1.5, 2);
  tick(1);
  assert.equal(stock.reserved, 45); assert.equal(stock.remaining, 45);
  assert.equal(drone.logistics!.reserved, 30);
  // Roster order governs admission, but no participant can duplicate reserved value.
  assert.equal(drones[1].logistics!.reserved, 15); assert.equal(enemy.logistics!.reason, 'stock_reserved');
  tick(2);
  assert.equal(stock.remaining, 0); assert.equal(stock.reserved, 0);
  assert.equal(drone.cargo!.amount + drones[1].cargo!.amount + enemy.cargo!.amount, 45);
  assert.equal(match.teams.blue.earned + match.teams.red.earned, 0); assert.equal(conserved(), 45);
});

for (const interruption of ['leave', 'high', 'low', 'speed', 'swept_speed', 'cancel', 'death', 'stop'] as const) {
  test(`unfinished pickup interrupted by ${interruption} conserves and releases all reserved stock`, () => {
    const { rules, state, drone, tick, at, stock, wallet, conserved } = fixture();
    at(drone, 20); tick(2);
    let previous: Map<DroneId, Point> | undefined;
    switch (interruption) {
      case 'leave': at(drone, 30); break;
      case 'high': drone.y = CARGO_CONFIG.hoverMax + 0.01; break;
      case 'low': drone.y = CARGO_CONFIG.hoverMin - 0.01; break;
      case 'speed': drone.velocity = { x: CARGO_CONFIG.maxServiceSpeed + 0.01, y: 0, z: 0 }; break;
      case 'swept_speed': previous = new Map([[drone.id, { x: 19, y: 1.5, z: 0 }]]); break;
      case 'cancel': rules.cancelLogistics(state, drone, 'objective-replaced'); at(drone, 30); break;
      case 'death': drone.equipment!.armor = false; rules.terrainCollision(state, drone, drone, { x: 20, y: -1, z: 0 }); break;
      case 'stop': state.running = false; break;
    }
    tick(1, previous);
    assert.equal(stock.remaining, 60); assert.equal(stock.reserved, 0); assert.equal(drone.cargo!.amount, 0);
    assert.equal(wallet.credits, 30); assert.equal(conserved(), 60);
    rules.cancelLogistics(state, drone); rules.cancelLogistics(state, drone);
    assert.equal(stock.reserved, 0); assert.equal(conserved(), 60);
  });
}

test('stationary high occupancy charges continuously while cargo service explains the hover-band requirement', () => {
  const { drone, tick, at, load, wallet } = fixture(); load();
  at(drone, 0, 4); drone.battery = 100; tick(1);
  assert.equal(drone.charging, true); assert.equal(drone.battery, 125);
  assert.equal(drone.logistics!.state, 'carrying'); assert.equal(drone.logistics!.reason, 'above_hover_band');
  assert.equal(wallet.credits, 30); assert.equal(drone.cargo!.amount, 30);
  at(drone, 0, 1.5); tick(1); assert.equal(drone.logistics!.state, 'unloading');
  tick(1); assert.equal(wallet.credits, 60); assert.equal(drone.cargo!.amount, 0);
});

test('distant overhead passes and compatibility mining calls cannot locate hidden resources', () => {
  const { rules, state, drone, at, tick } = fixture();
  at(drone, 20, 30); tick(1);
  assert.equal(drone.logistics!.reason, 'outside_apron');
  const overhead = rules.mine(state, drone, 'fixture-stock');
  at(drone, 40, 30); tick(1);
  assert.equal(drone.logistics!.reason, 'outside_apron');
  assert.deepEqual(rules.mine(state, drone, 'arbitrary-id'), overhead);
});

test('only an uninterrupted friendly delivery banks cargo, and repeated occupancy cannot pay twice', () => {
  const { drone, tick, at, load, wallet, conserved, match } = fixture(); load();
  at(drone, 60, 1.5, 2); tick(3); assert.equal(wallet.credits, 30); assert.equal(drone.cargo!.amount, 30);
  at(drone, 0); tick(1.9); assert.equal(drone.logistics!.state, 'unloading');
  at(drone, 10); tick(0.1); assert.equal(drone.cargo!.amount, 30); assert.equal(wallet.earned, 0);
  at(drone, 0); tick(1.9); assert.equal(wallet.credits, 30);
  tick(0.1); assert.equal(wallet.credits, 60); assert.equal(wallet.earned, 30); assert.equal(drone.cargo!.amount, 0);
  tick(30); assert.equal(wallet.credits, 60);
  assert.equal(match.events.filter(event => event.type === 'cargo_delivered').length, 1); assert.equal(conserved(), 60);
});

test('charging, cargo unloading and paid rearming can overlap without giving ammunition early', () => {
  const { rules, state, drone, load, at, tick, wallet } = fixture();
  rules.buy(state, drone, 'gun'); drone.ammo = 0; wallet.credits = 10;
  load(); at(drone, 0); drone.battery = 100; rules.rearm(state, drone);
  tick(2);
  assert.equal(wallet.credits, 30); assert.equal(wallet.earned, 30); assert.equal(drone.ammo, 0);
  assert.equal(drone.servicing!.remaining, 6); assert.equal(drone.battery, 150);
  tick(6); assert.equal(drone.ammo, 12); assert.equal(drone.servicing, undefined); assert.equal(wallet.credits, 30);
});

test('Stop retains existing cargo and refunds rearm exactly once, while reset restores only original resources', () => {
  const { rules, state, drone, load, at, tick, stock, wallet } = fixture();
  rules.buy(state, drone, 'gun'); load(); at(drone, 0); drone.ammo = 0; wallet.credits = 10;
  rules.rearm(state, drone); tick(1); state.running = false; tick(10); tick(10);
  assert.equal(wallet.credits, 10); assert.equal(drone.cargo!.amount, 30);
  assert.equal(stock.remaining, 30); assert.equal(drone.servicing, undefined); assert.equal(drone.ammo, 0);
  state.match!.resources.push({ id: 'old-drop', kind: 'dropped', x: 40, y: 0, z: 0, capacity: 5, remaining: 5 });
  rules.begin(state);
  assert.equal(state.match!.resources.length, 1); assert.equal(state.match!.resources[0].remaining, 60);
  assert.equal(drone.cargo!.amount, 0); assert.equal(state.match!.teams.blue.credits, 30);
  assert.equal(drone.gunPurchased, false);
});

test('actual ground crash drops conserve cargo and the opposing team can recover and deliver it', () => {
  const { rules, state, drone, enemy, load, at, tick, match, conserved } = fixture();
  load(); at(drone, 40, 10); drone.equipment!.armor = false;
  rules.terrainCollision(state, drone, drone, { x: 40, y: -1, z: 0 });
  assert.equal(drone.alive, false); assert.equal(drone.cargo!.amount, 0);
  const drop = match.resources.find(node => node.kind === 'dropped')!;
  assert.ok(drop); assert.equal(drop.x, 40); assert.equal(drop.z, 0); assert.equal(drop.y, 0);
  assert.equal(drop.remaining, 30); assert.equal(conserved(), 60);
  at(enemy, 40); tick(3); assert.equal(enemy.cargo!.amount, 30); assert.equal(drop.remaining, 0);
  at(enemy, 60); tick(2); assert.equal(match.teams.red.earned, 30); assert.equal(match.teams.blue.earned, 0);
  assert.equal(conserved(), 60);
});

test('inaccessible wall crashes lose cargo without creating a relocated recovery cache', () => {
  const { rules, state, drone, load, at, match, conserved } = fixture(); load();
  at(drone, 39, 4); drone.equipment!.armor = false;
  state.obstacles = [{ x: 40, z: 0, width: 1, depth: 10, height: 10 }];
  rules.terrainCollision(state, drone, drone, { x: 41, y: 4, z: 0 });
  assert.equal(drone.alive, false); assert.equal(drone.cargo!.amount, 0);
  assert.equal(match.resources.filter(node => node.kind === 'dropped').length, 0);
  assert.equal(match.salvageLost, 30); assert.equal(conserved(), 60);
});

test('armor interruption releases loading reservation but retains already carried cargo', () => {
  const { rules, state, drone, load, at, stock, conserved } = fixture(); load(); at(drone, 40, 4);
  rules.terrainCollision(state, drone, drone, { x: 40, y: -1, z: 0 });
  assert.equal(drone.alive, true); assert.equal(drone.equipment!.armor, false); assert.equal(drone.cargo!.amount, 30);
  assert.equal(stock.reserved, 0); assert.equal(conserved(), 60);
});

test('cargo refits preserve two-slot ownership, reject legacy shop items and cannot discard excess cargo', () => {
  const { rules, state, drone, wallet, load, at } = fixture(); wallet.credits = 200;
  rules.buy(state, drone, 'cargo'); rules.buy(state, drone, 'optics');
  assert.throws(() => rules.buy(state, drone, 'gun'), /Both module slots/);
  for (const item of ['miner', 'miner_upgrade', 'jammer'] as const) assert.throws(() => rules.buy(state, drone, item), /unavailable/);
  load(); at(drone, 0); const before = wallet.credits;
  assert.throws(() => rules.buy(state, drone, 'gun', 'cargo'), /Deliver excess cargo/);
  assert.equal(drone.cargo!.amount, 60); assert.equal(wallet.credits, before); assert.equal(drone.equipment!.cargo, true);
});

test('gun and battery refitting cannot manufacture ammunition or charge', () => {
  const { rules, state, drone, wallet } = fixture(); wallet.credits = 300;
  rules.buy(state, drone, 'gun'); rules.fire(state, drone); assert.equal(drone.ammo, 11);
  rules.buy(state, drone, 'optics', 'gun'); assert.equal(drone.ammo, 0);
  rules.buy(state, drone, 'gun', 'optics'); assert.equal(drone.ammo, 0);
  drone.battery = 40; rules.buy(state, drone, 'battery'); assert.equal(drone.battery, 40);
  rules.buy(state, drone, 'cargo', 'battery'); assert.equal(drone.battery, 40);
  rules.buy(state, drone, 'battery', 'cargo'); assert.equal(drone.battery, 40);
  const before = wallet.credits; rules.rearm(state, drone); assert.equal(wallet.credits, before - RTS_CONFIG.rearmCost);
});
