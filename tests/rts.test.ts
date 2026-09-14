import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RtsRules } from '../server/rts.ts';
import { boxContact, sphereContact } from '../server/rts-geometry.ts';
import { emptyEquipment, RTS_CONFIG, type Point } from '../shared/rts.ts';
import type { Drone, DroneId, GameState } from '../shared/types.ts';

const pose = (x = 0, y = 5, z = 0) => ({ x, y, z, yaw: 0, pitch: 0 });
function fixture() {
  const rules = new RtsRules();
  const drones: Drone[] = Array.from({ length: 6 }, (_, i) => ({
    id: `drone-${i + 1}`, ...pose(i * 15), team: i < 3 ? 'blue' : 'red', alive: true,
    equipment: emptyEquipment(), status: 'Ready', observations: 0, online: true,
  }));
  const state: GameState = {
    simTime: 0, mission: 1, running: true, speed: 1, completed: false,
    drones, obstacles: [], radio: [], treasures: [], runtime: { status: 'idle', message: '', model: '', effort: '' },
    match: rules.newMatch([{ id: 'salvage-1', x: 0, y: 0, z: 0, capacity: 100, remaining: 100 }]),
  };
  rules.begin(state);
  const tick = (dt = 0.05, previous?: Map<DroneId, Point>) => { state.simTime += dt; return rules.step(state, dt, previous); };
  return { rules, state, drones, tick, match: state.match! };
}

test('teams start with no income and a locked shop; first recovery unlocks the whole team', () => {
  const { state, rules, drones, tick, match } = fixture();
  assert.equal(match.teams.blue.credits, 0);
  assert.throws(() => rules.buy(state, drones[1], 'armor'), /not recovered/);
  Object.assign(drones[0], pose(0, 1.5, 0));
  assert.deepEqual(rules.mine(state, drones[0], 'salvage-1'), { accepted: true, action: 'mine' });
  tick(12);
  assert.equal(match.teams.blue.credits, 12);
  assert.equal(match.teams.blue.shopUnlocked, true);
  assert.equal(match.teams.red.shopUnlocked, false);
  rules.buy(state, drones[1], 'armor');
  assert.equal(drones[1].equipment?.armor, true);
  assert.equal(match.teams.blue.credits, 0);
});

test('shared spending is atomic, self-equipped, and rejects duplicate or unknown attachments', async () => {
  const { state, rules, drones, match } = fixture();
  Object.assign(match.teams.blue, { credits: 20, earned: 20, shopUnlocked: true });
  const results = await Promise.allSettled([0, 1].map(i => Promise.resolve().then(() => rules.buy(state, drones[i], 'gun'))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(match.teams.blue.credits, 0);
  assert.equal(drones.filter(drone => drone.equipment?.gun).length, 1);
  match.teams.blue.credits = 30;
  assert.throws(() => rules.buy(state, drones[0], 'gun'), /already equipped/);
  assert.throws(() => rules.buy(state, drones[0], '__proto__' as 'gun'), /Unknown/);
  assert.equal(match.teams.blue.credits, 30);
});

test('mining tool triples income and a contested last deposit tick is split proportionally', () => {
  const { state, rules, drones, tick, match } = fixture();
  const a = drones[0], b = drones[3];
  Object.assign(a, pose(-1, 1.2)); Object.assign(b, pose(1, 1.2));
  a.equipment!.miner = true; match.resources[0].remaining = 2;
  rules.mine(state, a, 'salvage-1'); rules.mine(state, b, 'salvage-1'); tick(1);
  assert.equal(match.teams.blue.credits, 1.5);
  assert.equal(match.teams.red.credits, 0.5);
  assert.equal(match.resources[0].remaining, 0);
  assert.equal(a.mining, undefined); assert.equal(b.mining, undefined);
  tick(10);
  assert.equal(match.teams.blue.credits + match.teams.red.credits, 2);
  assert.throws(() => rules.mine(state, a, 'salvage-1'), /No accessible/);
});

test('mining requires reach and clear sight, stops when displaced, and reveals no location', () => {
  const { state, rules, drones, tick, match } = fixture();
  assert.throws(() => rules.mine(state, drones[0], 'salvage-1'), /No accessible/);
  Object.assign(drones[0], pose(0, 1.2, 2));
  state.obstacles.push({ x: 0, z: 1, width: 1, depth: 0.2, height: 3 });
  assert.throws(() => rules.mine(state, drones[0], 'salvage-1'), /No accessible/);
  state.obstacles = [];
  const receipt = rules.mine(state, drones[0], 'salvage-1');
  assert.ok(!JSON.stringify(receipt).includes('salvage-1'));
  drones[0].z = 20; tick(1);
  assert.equal(match.teams.blue.earned, 0); assert.equal(drones[0].mining, undefined);
});

for (const armorA of [false, true]) for (const armorB of [false, true]) {
  test(`swept head-on crash with armor ${armorA}/${armorB} consumes armor and resolves both participants`, () => {
    const { drones, tick } = fixture();
    const a = drones[0], b = drones[3];
    Object.assign(a, pose(2)); Object.assign(b, pose(-2));
    a.equipment!.armor = armorA; b.equipment!.armor = armorB;
    const previous = new Map<DroneId, Point>([[a.id, pose(-2)], [b.id, pose(2)]]);
    const affected = tick(0.1, previous);
    assert.equal(a.alive, armorA); assert.equal(b.alive, armorB);
    assert.equal(a.equipment!.armor, false); assert.equal(b.equipment!.armor, false);
    assert.ok(affected.includes(a.id) && affected.includes(b.id));
    if (armorA && armorB) {
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > 2 * RTS_CONFIG.droneRadius);
      tick(); assert.equal(a.alive, true); assert.equal(b.alive, true);
    }
  });
}

test('friendly contact is lethal and simultaneous three-way contact does not grant extra armor', () => {
  const { drones, tick } = fixture();
  for (const drone of drones.slice(0, 3)) Object.assign(drone, pose());
  drones[0].equipment!.armor = true; tick();
  assert.deepEqual(drones.slice(0, 3).map(drone => drone.alive), [false, false, false]);
});

test('an armored ram cancels the old flight path before it can hit a second distant drone', () => {
  const { drones, tick } = fixture();
  const a = drones[0], b = drones[3], c = drones[4];
  Object.assign(a, pose(5)); Object.assign(b, pose(0)); Object.assign(c, pose(3)); a.equipment!.armor = true;
  tick(0.1, new Map([[a.id, pose(-5)]]));
  assert.equal(a.alive, true); assert.equal(b.alive, false); assert.equal(c.alive, true);
  assert.ok(a.x < 0);
});

test('armored drones touching beside a wall deflect along a clear path and do not collide again', () => {
  const { state, drones, tick } = fixture();
  const a = drones[0], b = drones[3];
  Object.assign(a, pose()); Object.assign(b, pose(2 * RTS_CONFIG.droneRadius));
  a.equipment!.armor = true; b.equipment!.armor = true;
  state.obstacles = [{ x: -0.9, z: 0, width: 1, depth: 10, height: 10 }];
  tick(); tick();
  assert.equal(a.alive, true); assert.equal(b.alive, true);
  assert.equal(boxContact(a, a, state.obstacles[0], RTS_CONFIG.droneRadius), undefined);
  assert.equal(boxContact(b, b, state.obstacles[0], RTS_CONFIG.droneRadius), undefined);
});

test('a simultaneous corner impact bounces armor clear of both buildings', () => {
  const { state, rules, drones } = fixture();
  const drone = drones[0]; drone.equipment!.armor = true;
  state.obstacles = [
    { x: 0, z: 0, width: 2, depth: 20, height: 10 },
    { x: 0, z: 0, width: 20, depth: 2, height: 10 },
  ];
  const from = pose(-5, 5, -5), next = pose(5, 5, 5);
  const hit = rules.terrainCollision(state, drone, from, next);
  assert.equal(drone.alive, true); assert.equal(drone.equipment!.armor, false);
  for (const wall of state.obstacles) assert.equal(boxContact(hit.position, hit.position, wall, RTS_CONFIG.droneRadius), undefined);
});

test('unarmored drones crash through swept building and ground contact, armored drones escape safely', () => {
  for (const armored of [false, true]) for (const terrain of ['building', 'ground']) {
    const { state, rules, drones } = fixture();
    const drone = drones[0]; drone.equipment!.armor = armored;
    state.obstacles = [{ x: 0, z: 0, width: 2, depth: 2, height: 10, rotation: 35 }];
    const from = terrain === 'building' ? pose(-5) : pose(-5, 2);
    const next = terrain === 'building' ? pose(5) : pose(-5, -10);
    Object.assign(drone, from);
    const hit = rules.terrainCollision(state, drone, from, next);
    assert.equal(hit.collided, true); assert.equal(drone.alive, armored); assert.equal(drone.equipment!.armor, false);
    if (armored) {
      assert.ok(hit.position.y > RTS_CONFIG.droneRadius);
      assert.equal(boxContact(hit.position, hit.position, state.obstacles[0], RTS_CONFIG.droneRadius), undefined);
      Object.assign(drone, hit.position);
      assert.equal(rules.terrainCollision(state, drone, hit.position, hit.position).collided, false);
    }
  }
});

test('armor ejects a restored overlapping pose through its nearest building face', () => {
  const { state, rules, drones } = fixture();
  state.obstacles = [{ x: 0, z: 0, width: 4, depth: 4, height: 10 }];
  const drone = drones[0]; Object.assign(drone, pose(1.9)); drone.equipment!.armor = true;
  const result = rules.terrainCollision(state, drone, drone, drone);
  assert.equal(drone.alive, true);
  assert.ok(result.position.x > 2 + RTS_CONFIG.droneRadius);
});

test('gun uses actual heading and pitch, gravity, a cooldown, and a finite flight lifetime', () => {
  const { state, rules, drones, tick, match } = fixture();
  const drone = drones[0]; drone.equipment!.gun = true; drone.y = 50;
  assert.deepEqual(rules.fire(state, drone), { fired: true });
  assert.throws(() => rules.fire(state, drone), /cycling/);
  tick(1);
  assert.ok(Math.abs(match.projectiles[0].z + RTS_CONFIG.bulletSpeed) < 1e-8);
  assert.ok(Math.abs(match.projectiles[0].y - (50 - RTS_CONFIG.bulletGravity / 2)) < 1e-8);
  drone.yaw = -90; drone.pitch = 30; rules.fire(state, drone);
  const bullet = match.projectiles.at(-1)!;
  assert.ok(bullet.vx > 27); assert.ok(bullet.vy > 15.9); assert.ok(Math.abs(bullet.vz) < 1e-8);
  tick(5); assert.equal(match.projectiles.length, 0);
});

test('a direct physical hit kills, while a shot aimed away misses', () => {
  for (const heading of [0, 90]) {
    const { state, rules, drones, tick } = fixture();
    const shooter = drones[0], target = drones[3];
    Object.assign(target, pose(0, 5, -6)); shooter.equipment!.gun = true; shooter.yaw = heading;
    rules.fire(state, shooter); tick(0.3);
    assert.equal(target.alive, heading !== 0);
  }
});

test('one armor charge blocks one bullet, the next bullet destroys the drone', () => {
  const { state, rules, drones, tick } = fixture();
  const shooter = drones[0], target = drones[3];
  Object.assign(target, pose(0, 5, -6)); shooter.equipment!.gun = true; target.equipment!.armor = true;
  rules.fire(state, shooter); tick(0.2);
  assert.equal(target.alive, true); assert.equal(target.equipment!.armor, false);
  tick(0.6); rules.fire(state, shooter); tick(0.2);
  assert.equal(target.alive, false);
});

test('the nearest drone blocks bullets, including friendly fire', () => {
  const { state, rules, drones, tick } = fixture();
  drones[0].equipment!.gun = true;
  Object.assign(drones[1], pose(0, 5, -3)); Object.assign(drones[3], pose(0, 5, -6));
  rules.fire(state, drones[0]); tick(0.3);
  assert.equal(drones[1].alive, false); assert.equal(drones[3].alive, true);
});

test('a thin rotated building obstructs a bullet even across a large timestep', () => {
  const { state, rules, drones, tick, match } = fixture();
  drones[0].equipment!.gun = true; Object.assign(drones[3], pose(0, 5, -7));
  state.obstacles = [{ x: 0, z: -3, width: 4, depth: 0.02, height: 10, rotation: 35 }];
  rules.fire(state, drones[0]); tick(1);
  assert.equal(drones[3].alive, true); assert.equal(match.projectiles.length, 0);
  assert.ok(match.events.some(event => event.type === 'impact' && !event.target));
});

test('a moving drone is hit where its path crosses the projectile, with no endpoint overlap', () => {
  const { state, rules, drones, tick } = fixture();
  const shooter = drones[0], target = drones[3]; shooter.equipment!.gun = true;
  Object.assign(target, pose(4, 5, -3.2));
  const previous = new Map<DroneId, Point>([[target.id, pose(-4, 5, -3.2)]]);
  rules.fire(state, shooter); tick(0.2, previous);
  assert.equal(target.alive, false);
});

test('swept sphere intersections include grazing hits but reject a true near miss', () => {
  const radius = RTS_CONFIG.droneRadius + RTS_CONFIG.bulletRadius;
  assert.ok(sphereContact(pose(-10, radius), pose(10, radius), pose(0, 0), pose(0, 0), radius) !== undefined);
  assert.equal(sphereContact(pose(-10, radius + 0.001), pose(10, radius + 0.001), pose(0, 0), pose(0, 0), radius), undefined);
});

test('the last survivor wins; simultaneous mutual projectile kills produce a draw', () => {
  for (const mutual of [false, true]) {
    const { state, rules, drones, tick, match } = fixture();
    for (const drone of drones) drone.alive = false;
    const a = drones[0], b = drones[3]; a.alive = true; b.alive = true;
    Object.assign(a, pose(0, 5, 3)); Object.assign(b, pose(0, 5, -3)); b.yaw = 180;
    a.equipment!.gun = true; b.equipment!.gun = true;
    rules.fire(state, a); if (mutual) rules.fire(state, b);
    tick(0.3);
    assert.equal(match.phase, 'finished'); assert.equal(match.winner, mutual ? 'draw' : 'blue');
    assert.equal(state.completed, true); assert.equal(match.projectiles.length, 0);
    assert.throws(() => rules.fire(state, a), mutual ? /destroyed/ : /not active/);
  }
});

test('terrain deaths are resolved as one tick, including an all-team draw', () => {
  const { state, rules, drones, tick, match } = fixture();
  for (const drone of drones) rules.terrainCollision(state, drone, drone, { ...drone, y: -2 });
  assert.equal(match.phase, 'active'); tick();
  assert.equal(match.winner, 'draw');
});

test('a new match clears equipment, resource depletion, cooldown and victory', () => {
  const { state, rules, drones, match } = fixture();
  const drone = drones[0]; drone.alive = false; drone.equipment!.gun = true; drone.lastFiredAt = 99; drone.mining = 'salvage-1';
  match.resources[0].remaining = 0; match.teams.blue.credits = 100; match.phase = 'finished'; match.winner = 'blue';
  rules.begin(state);
  assert.equal(drone.alive, true); assert.deepEqual(drone.equipment, emptyEquipment());
  assert.equal(drone.lastFiredAt, undefined); assert.equal(drone.mining, undefined);
  assert.equal(state.match?.resources[0].remaining, 100); assert.equal(state.match?.teams.blue.credits, 0);
  assert.equal(state.match?.phase, 'active'); assert.equal(state.match?.winner, null);
});

test('player match events remain bounded through long sessions', () => {
  const { state, rules, drones, tick, match } = fixture(); drones[0].equipment!.gun = true;
  for (let i = 0; i < 180; i++) { rules.fire(state, drones[0]); tick(0.8); }
  assert.equal(match.events.length, 160);
  assert.ok(match.events.every(event => event.id && Number.isFinite(event.simTime)));
});
