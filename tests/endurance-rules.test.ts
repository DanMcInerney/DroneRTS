import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RtsRules } from '../server/rts.ts';
import { batteryCapacityFor, emptyEquipment, RTS_CONFIG, type EquipmentItem, type MatchEvent, type Point } from '../shared/rts.ts';
import type { Drone, DroneId, GameState } from '../shared/types.ts';

function fixture(onEvent?: (event: MatchEvent) => void) {
  const rules = new RtsRules(onEvent);
  const drones: Drone[] = Array.from({ length: 6 }, (_, i) => ({
    id: `drone-${i + 1}`, x: i * 30, y: 5, z: 0, yaw: 0, pitch: 0, team: i < 3 ? 'blue' : 'red',
    alive: true, equipment: emptyEquipment(), status: 'Ready', observations: 0, online: true,
  }));
  const state: GameState = {
    simTime: 0, mission: 1, running: true, speed: 1, completed: false, drones, obstacles: [], radio: [], treasures: [],
    runtime: { status: 'idle', message: '', model: '', effort: '' },
    match: rules.newMatch([{ id: 'salvage', x: 10, y: 0, z: 0, capacity: 1000, remaining: 1000 }],
      drones.map(drone => ({ id: `pad-${drone.id}`, x: drone.x, y: drone.y, z: drone.z, team: drone.team! }))),
  };
  rules.begin(state); state.match!.rulesVersion = 'cube-v1';
  const drone = drones[0], wallet = state.match!.teams.blue;
  const tick = (dt: number, previous?: Map<DroneId, Point>) => { state.simTime += dt; return rules.step(state, dt, previous); };
  const buy = (...items: EquipmentItem[]) => {
    state.match!.teams.blue.credits = 500;
    for (const item of items) rules.buy(state, drone, item);
  };
  return { rules, state, drones, drone, wallet, tick, buy };
}
const near = (actual: number | undefined, expected: number) => assert.ok(Math.abs(actual! - expected) < 1e-8, `${actual} != ${expected}`);

test('opening and optional legacy batteries use 300 base charge; a pack provides capacity without a refill', () => {
  const { drone, drones, tick } = fixture();
  assert.ok(drones.every(value => value.battery === 300 && !value.jamming && !value.radioJammed));
  delete drone.battery; delete drone.jamming; delete drone.radioJammed;
  drone.equipment!.battery = true; drone.z = 10;
  tick(10); near(drone.battery, 291); assert.equal(batteryCapacityFor(drone), 600);
});

test('hover, actual translation, automatic mining and jammer drain combine outside friendly cubes', () => {
  const { rules, state, drone, tick, buy } = fixture(); buy('jammer'); drone.z = 10;
  tick(10); near(drone.battery, 291);
  const previous = new Map([[drone.id, { x: drone.x, y: drone.y, z: drone.z }]]);
  drone.x += 1; tick(10, previous); near(drone.battery, 281);
  drone.action = { id: 'stalled', kind: 'move' }; tick(10); near(drone.battery, 272);
  drone.action = undefined; drone.x = 10; drone.z = 0;
  tick(10); near(drone.battery, 261.5); assert.equal(drone.mining, 'salvage');
  rules.jam(state, drone, true); tick(10); near(drone.battery, 243);
  drone.z = 10; tick(10); near(drone.battery, 226); assert.equal(drone.mining, undefined);
});

test('depleted zones do not incur mining drain and outside-pad depletion still produces power death', () => {
  const { drone, state, tick } = fixture(); drone.x = 10;
  state.match!.resources[0].remaining = 0; drone.mining = 'salvage'; tick(10);
  near(drone.battery, 291); assert.equal(drone.mining, undefined);
  drone.battery = 0.1; drone.equipment!.armor = true; tick(1);
  assert.equal(drone.alive, false); assert.equal(drone.battery, 0); assert.equal(drone.charging, false);
  assert.equal(state.match!.events.filter(event => event.type === 'armor_consumed').length, 0);
  assert.ok(state.match!.events.some(event => event.type === 'destroyed' && event.cause === 'power'));
});

test('Stop and inactive matches refund rearming once; invalid durations do not advance an active service', () => {
  const { rules, state, drone, tick, buy } = fixture(); buy('gun'); drone.ammo = 1; drone.battery = 50;
  rules.rearm(state, drone); state.running = false; tick(20);
  near(drone.battery, 50); assert.equal(drone.servicing, undefined); assert.equal(drone.charging, false);
  assert.equal(state.match!.teams.blue.credits, 470);
  state.running = true; state.match!.phase = 'ready'; tick(20);
  near(drone.battery, 50); assert.equal(drone.servicing, undefined); assert.equal(state.match!.teams.blue.credits, 470);
  state.match!.phase = 'active';
  rules.rearm(state, drone);
  for (const duration of [0, -1, NaN, Infinity]) rules.step(state, duration);
  near(drone.battery, 50); assert.equal(drone.servicing!.remaining, 8);
});

test('battery refits enforce module slots and clamp charge without creating energy', () => {
  const { rules, state, drone, wallet, buy } = fixture(); drone.battery = 40;
  buy('battery', 'miner');
  assert.equal(wallet.credits, 440); assert.equal(batteryCapacityFor(drone), 600); near(drone.battery, 40);
  const before = structuredClone(drone.equipment);
  assert.throws(() => rules.buy(state, drone, 'jammer'), /module slots/);
  assert.deepEqual(drone.equipment, before); assert.equal(wallet.credits, 440); near(drone.battery, 40);
  rules.buy(state, drone, 'optics', 'battery'); near(drone.battery, 40); assert.equal(batteryCapacityFor(drone), 300);
  rules.buy(state, drone, 'battery', 'optics'); drone.battery = 550;
  rules.buy(state, drone, 'optics', 'battery'); near(drone.battery, 300); assert.equal(wallet.credits, 350);
});

test('insufficient refits preserve charge and an active jammer', () => {
  const { rules, state, drone, wallet, buy } = fixture(); buy('jammer', 'battery');
  drone.battery = 550; rules.jam(state, drone, true); wallet.credits = 29;
  assert.throws(() => rules.buy(state, drone, 'optics', 'battery'), /Insufficient/);
  assert.equal(batteryCapacityFor(drone), 600); near(drone.battery, 550);
  assert.equal(drone.jamming, true); assert.equal(drone.radioJammed, true); assert.equal(wallet.credits, 29);
});

test('friendly cube charges continuously, preserves partial gains on exit and powers full batteries', () => {
  const { drone, wallet, tick, buy } = fixture(); buy('battery'); drone.battery = 1;
  const credits = wallet.credits; tick(1); near(drone.battery, 26); assert.equal(drone.charging, true);
  drone.z = 10; tick(1); near(drone.battery, 25.1); assert.equal(drone.charging, false);
  drone.z = 0; tick(23); near(drone.battery, 600); tick(10); near(drone.battery, 600);
  assert.equal(wallet.credits, credits); assert.equal(drone.servicing, undefined);
});

test('25 charge per second yields twelve seconds for base and twenty-four for the expanded capacity', () => {
  for (const packed of [false, true]) {
    const { drone, tick, buy } = fixture(); if (packed) buy('battery');
    drone.battery = 1; tick(11.96); near(drone.battery, 300);
    if (packed) { tick(12); near(drone.battery, 600); }
  }
});

test('recharge acknowledgement neither stops movement nor competes with rearming or changes funds', () => {
  const { rules, state, drone, wallet, tick, buy } = fixture(); buy('gun'); drone.ammo = 1; drone.battery = 50;
  const action = { id: 'route', kind: 'fly_to' }; drone.action = action;
  const initial = wallet.credits;
  assert.deepEqual(rules.recharge(state, drone), { accepted: true, action: 'recharge', credits: initial });
  assert.equal(drone.action, action); assert.equal(drone.servicing, undefined);
  rules.rearm(state, drone); delete drone.servicing!.kind;
  rules.recharge(state, drone); tick(8);
  assert.equal(drone.ammo, 12); near(drone.battery, 250); assert.equal(wallet.credits, initial - 10);
  tick(2); assert.equal(drone.battery, 300); rules.recharge(state, drone);
});

test('enemy pads cannot charge; zero-power and dead actors cannot use compatibility recharge', () => {
  const { rules, state, drone, wallet, tick } = fixture(); drone.battery = 50; drone.x = 90; drone.y = 6;
  assert.throws(() => rules.recharge(state, drone), /friendly service pad/); tick(1); near(drone.battery, 49.1);
  drone.x = 0; drone.battery = 0;
  assert.throws(() => rules.recharge(state, drone), /No battery charge/);
  tick(1); assert.equal(drone.alive, false); assert.equal(drone.battery, 0);
  assert.throws(() => rules.recharge(state, drone), /destroyed/); assert.equal(wallet.credits, 30);
});

test('battery warnings occur once per drain crossing and adapt after pad charging and capacity removal', () => {
  const { rules, state, drone, buy, tick } = fixture(); drone.z = 10; drone.battery = 61;
  const count = () => state.match!.events.filter(event => event.type === 'battery_low').length;
  tick(5); assert.equal(count(), 1); tick(1); assert.equal(count(), 1);
  drone.z = 0; tick(1); drone.z = 10; drone.battery = 61; tick(5); assert.equal(count(), 2);
  drone.z = 0; buy('battery'); drone.z = 10; drone.battery = 121; tick(5); assert.equal(count(), 3);
  drone.z = 0; drone.battery = 100; rules.buy(state, drone, 'optics', 'battery');
  drone.z = 10; tick(50); assert.equal(count(), 4);
});

test('simultaneous final power failures remain a draw and destroyed miners earn nothing', () => {
  for (const both of [false, true]) {
    const { state, drones, drone, tick, wallet } = fixture();
    for (const unit of drones) unit.alive = false;
    drone.alive = true; drones[3].alive = true; drone.x = 10; drones[3].z = 10;
    drones[3].battery = 0.1; drone.battery = both ? 0.1 : 300;
    tick(1); assert.equal(state.match!.phase, 'finished'); assert.equal(state.match!.winner, both ? 'draw' : 'blue');
    if (both) assert.equal(wallet.earned, 0);
  }
});

test('jammer includes its own, allied and enemy radios and ignores walls but respects three-dimensional range', () => {
  const { rules, state, drone, drones, buy } = fixture(); buy('jammer');
  Object.assign(drones[1], { x: 5 }); Object.assign(drones[3], { x: 18 });
  Object.assign(drones[2], { x: 18.01 }); Object.assign(drones[4], { x: 0, y: 23.01 });
  state.obstacles = [{ x: 3, z: 0, width: 1, depth: 10, height: 50 }];
  const receipt = rules.jam(state, drone, true);
  assert.deepEqual(receipt, { jamming: true });
  assert.deepEqual(drones.map(value => value.radioJammed), [true, true, false, true, false, false]);
  assert.ok(state.match!.events.filter(event => event.type === 'radio_changed').every(event => !event.target && event.x === undefined));
});

test('radio change callbacks observe all updated flags and toggling the same state does not emit duplicates', () => {
  const snapshots: boolean[][] = [];
  let fleet: Drone[] = [];
  const { rules, state, drone, drones, buy } = fixture(event => {
    if (event.type === 'radio_changed') snapshots.push(fleet.map(unit => !!unit.radioJammed));
  }); fleet = drones;
  buy('jammer'); drones[1].x = 5; drones[3].x = 10;
  rules.jam(state, drone, true);
  assert.equal(snapshots.length, 3); assert.ok(snapshots.every(snapshot => JSON.stringify(snapshot) === JSON.stringify([true, true, false, true, false, false])));
  rules.jam(state, drone, true); assert.equal(snapshots.length, 3);
  rules.jam(state, drone, false); assert.equal(snapshots.length, 6);
  assert.ok(snapshots.slice(3).every(snapshot => snapshot.every(value => !value)));
});

test('overlapping sources combine; moving out of all coverage restores radio', () => {
  const { rules, state, drone, drones, buy, tick } = fixture(); buy('jammer');
  drones[3].equipment!.jammer = true; drones[3].x = 30; drones[1].x = 15;
  rules.jam(state, drone, true); rules.jam(state, drones[3], true);
  rules.jam(state, drone, false); assert.equal(drones[1].radioJammed, true);
  const before = { x: drones[1].x, y: drones[1].y, z: drones[1].z };
  drones[1].z = 20; tick(0.1, new Map([[drones[1].id, before]]));
  assert.equal(drones[1].radioJammed, false); assert.equal(drones[3].radioJammed, true);
});

test('passive charging permits a jammer; timed rearming and refits disable it', () => {
  const { rules, state, drone, buy, tick } = fixture();
  assert.throws(() => rules.jam(state, drone, true), /No jammer/);
  buy('jammer', 'gun'); drone.battery = 50; drone.ammo = 1;
  rules.jam(state, drone, true); rules.recharge(state, drone); tick(1);
  assert.equal(drone.jamming, true); assert.equal(drone.radioJammed, true); near(drone.battery, 75);
  rules.rearm(state, drone);
  assert.equal(drone.jamming, false); assert.throws(() => rules.jam(state, drone, true), /during servicing/);
  assert.deepEqual(rules.jam(state, drone, false), { jamming: false });
  rules.cancelService(state, drone); rules.jam(state, drone, true); rules.buy(state, drone, 'optics', 'jammer');
  assert.equal(drone.jamming, false); assert.equal(drone.radioJammed, false);
});

test('damage, source death and stale removed modules stop interference immediately', () => {
  for (const armor of [false, true]) {
    const { rules, state, drone, drones, buy } = fixture(); buy('jammer'); drone.equipment!.armor = armor;
    drones[1].x = 5; rules.jam(state, drone, true);
    rules.terrainCollision(state, drone, drone, { ...drone, y: -2 });
    assert.equal(drone.alive, armor); assert.equal(drone.jamming, false); assert.equal(drones[1].radioJammed, false);
  }
  const { rules, state, drone, buy } = fixture(); buy('jammer'); rules.jam(state, drone, true);
  drone.equipment!.jammer = false; rules.syncInterference(state);
  assert.equal(drone.jamming, false); assert.equal(drone.radioJammed, false);
});

test('begin resets charge and interference while victory shuts off all surviving emitters', () => {
  const { rules, state, drone, drones, buy, tick } = fixture(); buy('jammer', 'battery');
  drone.battery = 25; rules.jam(state, drone, true); rules.begin(state); state.match!.rulesVersion = 'cube-v1';
  assert.equal(drone.battery, 300); assert.equal(batteryCapacityFor(drone), 300);
  assert.ok(drones.every(unit => unit.jamming === false && unit.radioJammed === false));
  buy('jammer'); rules.jam(state, drone, true);
  for (const enemy of drones.filter(unit => unit.team === 'red')) enemy.alive = false;
  tick(0.1); assert.equal(state.match!.phase, 'finished');
  assert.ok(drones.every(unit => unit.jamming === false && unit.radioJammed === false));
});
