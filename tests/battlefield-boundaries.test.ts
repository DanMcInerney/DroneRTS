import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BATTLEFIELD_BOUNDARIES } from '../shared/battlefield.ts';
import { CITY } from '../shared/city.ts';
import { emptyEquipment, RTS_CONFIG, type Point } from '../shared/rts.ts';
import type { Drone } from '../shared/types.ts';
import { FleetGame } from '../server/game.ts';
import { LocalSensors, LOCAL_SENSOR_CONFIG } from '../server/local-sensors.ts';
import { terrainContact } from '../server/rts-geometry.ts';
import { RtsRules } from '../server/rts.ts';

const middle = { x: (CITY.bounds.x[0] + CITY.bounds.x[1]) / 2, y: 50, z: (CITY.bounds.z[0] + CITY.bounds.z[1]) / 2 };
const surfaces: Array<{ axis: 'x' | 'y' | 'z'; face: number; outward: number }> = [
  { axis: 'x', face: CITY.bounds.x[0], outward: -1 },
  { axis: 'x', face: CITY.bounds.x[1], outward: 1 },
  { axis: 'z', face: CITY.bounds.z[0], outward: -1 },
  { axis: 'z', face: CITY.bounds.z[1], outward: 1 },
  { axis: 'y', face: CITY.bounds.y[1], outward: 1 },
];
const aircraft = (position: Point): Drone => ({ id: 'drone-1', ...position, yaw: 0, pitch: 0,
  online: true, observations: 0, status: 'Ready', alive: true, team: 'blue', equipment: emptyEquipment() });

test('new matches and resets include the enclosure while explicit custom scenes stay authoritative', () => {
  const game = new FleetGame();
  assert.deepEqual(game.state.obstacles.filter(box => box.id?.startsWith('arena-')), BATTLEFIELD_BOUNDARIES);
  game.state.obstacles = [];
  assert.equal(terrainContact({ ...middle, x: CITY.bounds.x[1] - 1 }, { ...middle, x: CITY.bounds.x[1] + 1 },
    game.state.obstacles, RTS_CONFIG.droneRadius), undefined);
  game.reset();
  assert.equal(game.state.obstacles.length, CITY.buildings.length + 5);
});

test('all four walls and the ceiling stop swept bodies at the inner map face without tunnelling', () => {
  for (const { axis, face, outward } of surfaces) {
    const from = { ...middle, [axis]: face - outward * 3 }, to = { ...middle, [axis]: face + outward * 10 };
    const hit = terrainContact(from, to, BATTLEFIELD_BOUNDARIES, RTS_CONFIG.droneRadius);
    assert.ok(hit, `${axis}=${face}`);
    assert.ok(Math.abs(hit.contact[axis] - (face - outward * RTS_CONFIG.droneRadius)) < 1e-9);
    assert.equal(hit.normal[axis], -outward);
    assert.ok(hit.t > 0 && hit.t < 1);
    assert.equal(terrainContact(from, from, BATTLEFIELD_BOUNDARIES, RTS_CONFIG.droneRadius), undefined);
  }
  const corner = terrainContact({ x: 0, y: 40, z: 0 }, { x: -64, y: 120, z: -40 }, BATTLEFIELD_BOUNDARIES, 0);
  assert.ok(corner && corner.normal.x > 0 && corner.normal.y < 0 && corner.normal.z > 0);
});

test('enclosure surfaces use finite anonymous range sensing including the upward ceiling beam', () => {
  for (const { axis, face, outward } of surfaces) {
    const drone = aircraft({ ...middle, [axis]: face - outward * 3 });
    const sample = new LocalSensors().acquire(drone, BATTLEFIELD_BOUNDARIES, [drone], 0, 1);
    const direction = { x: 0, y: 0, z: 0, [axis]: outward };
    const reading = sample.proximity.find(beam => ['x', 'y', 'z'].every(key => beam.direction[key as keyof Point] === direction[key as keyof Point]));
    assert.equal(reading?.validity, 'valid');
    assert.ok(Math.abs(reading!.distance! - (3 - LOCAL_SENSOR_CONFIG.proximityRadius)) < 1e-9);
    assert.equal(JSON.stringify(sample).includes('arena-'), false);
    const distant = aircraft({ ...middle, [axis]: face - outward * 6 });
    const far = new LocalSensors().acquire(distant, BATTLEFIELD_BOUNDARIES, [distant], 0, 1);
    const farReading = far.proximity.find(beam => ['x', 'y', 'z'].every(key => beam.direction[key as keyof Point] === direction[key as keyof Point]));
    assert.equal(farReading?.validity, 'out-of-range');
    assert.equal(farReading?.distance, null);
  }
});

test('wall and ceiling contact retain lethal unarmored impacts and inward armor deflection', () => {
  for (const { axis, face, outward } of surfaces) for (const armored of [false, true]) {
    const game = new FleetGame(), rules = new RtsRules(), state = game.state, drone = state.drones[0];
    state.match!.phase = 'active';
    const from = { ...middle, [axis]: face - outward * 3 }, to = { ...middle, [axis]: face + outward * 3 };
    Object.assign(drone, from); drone.equipment!.armor = armored;
    const impact = rules.terrainCollision(state, drone, from, to);
    assert.equal(impact.collided, true); assert.equal(drone.alive, armored);
    assert.equal(drone.equipment!.armor, false);
    assert.equal(state.match!.events.at(-1)?.cause, 'terrain');
    if (armored) assert.equal(terrainContact(impact.position, impact.position, BATTLEFIELD_BOUNDARIES, RTS_CONFIG.droneRadius), undefined);
  }
});

test('shots terminate against the enclosure and never pass into scenery beyond the flight volume', () => {
  const game = new FleetGame(), rules = new RtsRules(), state = game.state, drone = state.drones[0];
  state.match!.phase = 'active'; state.running = true;
  Object.assign(drone, middle, { x: CITY.bounds.x[0] + 1, yaw: 90 });
  drone.equipment!.gun = true; drone.ammo = 1;
  rules.fire(state, drone); state.simTime += .1; rules.step(state, .1);
  assert.equal(state.match!.projectiles.length, 0);
  assert.ok(state.match!.events.some(event => event.type === 'impact' && event.cause === 'terrain'));
});
