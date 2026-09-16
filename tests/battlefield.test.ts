import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix3, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { OBB } from 'three/examples/jsm/math/OBB.js';
import { BATTLEFIELD } from '../shared/battlefield.ts';
import { DRONE_CAMERA } from '../shared/camera-profile.ts';
import { CITY, type CityPoint } from '../shared/city.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';
import { apronPoint, apronServicePositions, CARGO_CONFIG, insideZone, resourceZoneSize, RTS_CONFIG, serviceZoneSize, type Point } from '../shared/rts.ts';
import { intersectsBuilding } from '../server/world-geometry.ts';
import { FleetGame } from '../server/game.ts';
import { RtsRules } from '../server/rts.ts';

const clear = (from: Point, to = from, margin: number = RTS_CONFIG.droneRadius) =>
  !CITY.buildings.some(building => intersectsBuilding(from, to, building, margin));
function inPolygon(point: CityPoint, ring: CityPoint[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > point.z) !== (b.z > point.z)
      && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
const water = (point: CityPoint) => inPolygon(point, CITY.river)
  && !CITY.riverHoles.some(ring => inPolygon(point, ring));

const zoneSamples = (zone: Point & { rotation?: number }, size: number) => {
  const fractions = [-0.5, -0.25, 0, 0.25, 0.5];
  return fractions.flatMap(x => fractions.flatMap(z => fractions.map(y => ({
    ...apronPoint(zone, x * size, z * size, (y + 0.5) * size),
  }))));
};
const containsBody = (zone: Point & { rotation?: number }, size: number, point: Point) => {
  const radius = RTS_CONFIG.droneRadius;
  return [-radius, radius].every(x => [-radius, radius].every(z =>
    insideZone(apronPoint({ ...point, rotation: zone.rotation }, x, z), zone, size)))
    && point.y - radius > zone.y && point.y + radius < zone.y + size;
};

test('six starting positions are distinct, dry and safely clear of terrain', () => {
  assert.deepEqual(Object.keys(BATTLEFIELD.spawns), MATCH_DRONE_IDS);
  const spawns = Object.values(BATTLEFIELD.spawns);
  for (const [index, spawn] of spawns.entries()) {
    assert.ok(clear(spawn, spawn, 0.8), `spawn ${index + 1} needs collision clearance`);
    assert.equal(water(spawn), false, `spawn ${index + 1} is over water`);
    assert.ok(spawn.y > RTS_CONFIG.droneRadius);
    for (const other of spawns.slice(index + 1)) {
      assert.ok(Math.hypot(other.x - spawn.x, other.y - spawn.y, other.z - spawn.z) > RTS_CONFIG.droneRadius * 2 + 0.8);
    }
    for (const axis of ['x', 'y', 'z'] as const) {
      assert.ok(spawn[axis] > CITY.bounds[axis][0] && spawn[axis] < CITY.bounds[axis][1]);
    }
  }
});

test('each launch contains three complete drone bodies and its initial camera sees the base apron without resources', () => {
  assert.equal(BATTLEFIELD.servicePads.length, 2);
  assert.equal(new Set(BATTLEFIELD.servicePads.map(pad => pad.id)).size, 2);
  assert.deepEqual(BATTLEFIELD.servicePads.map(pad => pad.team).sort(), ['blue', 'red']);
  Object.values(BATTLEFIELD.spawns).forEach((spawn, index) => {
    const pad = BATTLEFIELD.servicePads.find(pad => pad.team === (index < 3 ? 'blue' : 'red'))!;
    const focus = { ...pad, y: pad.y + 0.15 }, size = serviceZoneSize(pad);
    assert.ok(containsBody(pad, size, spawn), `spawn ${index + 1} must fit entirely inside its service cube`);
    assert.ok(insideZone(spawn, pad, size));
    assert.equal(water(pad), false);
    assert.ok(clear(spawn, focus, 0), `initial pad view ${index + 1} is occluded`);
    assert.ok(clear(spawn, { ...pad, y: spawn.y }), `initial service approach ${index + 1} is blocked`);

    const camera = new PerspectiveCamera(DRONE_CAMERA.fov, DRONE_CAMERA.width / DRONE_CAMERA.height, DRONE_CAMERA.near, DRONE_CAMERA.far);
    camera.position.set(spawn.x, spawn.y, spawn.z);
    camera.rotation.set(spawn.pitch * Math.PI / 180, spawn.yaw * Math.PI / 180, 0, 'YXZ');
    camera.updateMatrixWorld();
    const inFrame = (point: Point) => {
      const projected = new Vector3(point.x, point.y, point.z).project(camera);
      return Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 && Math.abs(projected.z) < 1;
    };
    assert.ok(inFrame(focus), `initial pad ${index + 1} must be visible in the actual camera projection`);
    for (const node of BATTLEFIELD.resources) {
      const resourceSize = resourceZoneSize(node);
      assert.equal(insideZone(spawn, node, resourceSize), false, 'no spawn starts automatically mining');
      for (const sample of zoneSamples(node, resourceSize)) {
        assert.ok(Math.hypot(sample.x - spawn.x, sample.y - spawn.y, sample.z - spawn.z) > 8, 'the core map retains at least 80m of separation from every deposit surface');
        assert.equal(inFrame(sample) && clear(spawn, sample, 0), false, `${node.id} has a visible initial cube surface for drone ${index + 1}`);
      }
    }
  });
});

const distance = (a: CityPoint, b: CityPoint) => Math.hypot(a.x - b.x, a.z - b.z);
const middle = { x: (CITY.bounds.x[0] + CITY.bounds.x[1]) / 2, z: (CITY.bounds.z[0] + CITY.bounds.z[1]) / 2 };
const rotation = (r = 0) => new Matrix3().setFromMatrix4(new Matrix4().makeRotationY(r * Math.PI / 180));

test('opposite rooftop bases are balanced around the geographic center', () => {
  const [blue, red] = BATTLEFIELD.servicePads;
  assert.ok(blue.x < CITY.bounds.x[0] + 10 && red.x > CITY.bounds.x[1] - 10);
  assert.ok(distance({ x: (blue.x + red.x) / 2, z: (blue.z + red.z) / 2 }, middle) < 1.5);
  assert.ok(Math.abs(distance(blue, middle) - distance(red, middle)) < 3);
  for (const pad of [...BATTLEFIELD.servicePads, ...BATTLEFIELD.resources]) {
    assert.ok(pad.y > 0);
    const roof = CITY.buildings.find(b => Math.abs((b.baseY ?? 0) + b.height - pad.y) < 1e-6
      && [-.5, .5].every(x => [-.5, .5].every(z => {
        const point = apronPoint(pad, x * pad.zoneSize!, z * pad.zoneSize!, -.0001);
        return intersectsBuilding(point, point, b);
      })));
    assert.ok(roof, `${pad.id}: entire painted apron must be supported by one real roof`);
  }
});

test('three finite rooftop caches bracket the map center and preserve 840 total stock', () => {
  const [west, east, central] = BATTLEFIELD.resources;
  assert.equal(BATTLEFIELD.resources.length, 3);
  assert.deepEqual(BATTLEFIELD.resources.map(n => n.capacity), [120, 120, 600]);
  assert.equal(BATTLEFIELD.resources.reduce((sum, n) => sum + n.remaining, 0), 840);
  assert.ok(distance(central, middle) < 8, 'central roof stays within 80m of the geographic center');
  for (const [index, node] of [west, east].entries()) {
    const base = BATTLEFIELD.servicePads[index];
    const halfway = { x: (base.x + middle.x) / 2, z: (base.z + middle.z) / 2 };
    assert.ok(distance(node, halfway) < 7, 'side roof is near the base-to-center halfway point');
    assert.ok(distance(node, base) < distance(node, BATTLEFIELD.servicePads[1 - index]));
  }
  for (const node of BATTLEFIELD.resources) {
    assert.ok(node.y > 0); assert.equal(node.remaining, node.capacity);
    assert.ok(node.zoneSize! >= 3 && node.zoneSize! <= 4, 'roof aprons provide space for three loading airframes');
  }
});

test('painted footprints and service airspace clear all buildings; three bodies fit every apron', () => {
  for (const zone of [...BATTLEFIELD.resources, ...BATTLEFIELD.servicePads]) {
    const size = zone.zoneSize!, height = 'serviceHeight' in zone ? zone.serviceHeight! : size;
    const cube = new OBB(new Vector3(zone.x, zone.y + height / 2 + .001, zone.z),
      new Vector3(size / 2, height / 2, size / 2), rotation(zone.rotation));
    for (const building of CITY.buildings) {
      const obstacle = new OBB(new Vector3(building.x, (building.baseY ?? 0) + building.height / 2, building.z),
        new Vector3(building.width / 2, building.height / 2, building.depth / 2), rotation(building.rotation));
      assert.equal(cube.intersectsOBB(obstacle), false, `${zone.id} overlaps ${building.id}`);
    }
    for (const point of zoneSamples(zone, size)) {
      assert.equal(water(point), false);
      for (const axis of ['x', 'z'] as const) assert.ok(point[axis] > CITY.bounds[axis][0] && point[axis] < CITY.bounds[axis][1]);
    }
    const positions = apronServicePositions(zone, size);
    for (const [index, point] of positions.entries()) {
      assert.ok(containsBody(zone, size, point), `${zone.id}: whole body fits mark ${index}`);
      assert.ok(clear(point), `${zone.id}: clear hover position`);
      assert.ok(clear({ ...point, y: zone.y + size + 2 }, point), `${zone.id}: clear vertical arrival`);
      for (const other of positions.slice(index + 1)) assert.ok(distance(point, other) > RTS_CONFIG.droneRadius * 2 + .3);
    }
    // Rotation is shared by the service authority and renderer, not paint only.
    assert.ok(insideZone(apronPoint(zone, size / 2 - .01, 0, 1), zone, size));
    assert.equal(insideZone(apronPoint(zone, size / 2 + .01, 0, 1), zone, size), false);
  }
});

test('each roof supports three simultaneous low/slow loads and rooftop banking without changing total salvage', () => {
  for (const resource of BATTLEFIELD.resources) {
    const game = new FleetGame(), rules = new RtsRules(), state = game.state, match = state.match!;
    state.running = true; match.phase = 'active';
    const drones = state.drones.slice(0, 3), marks = apronServicePositions(resource, resource.zoneSize!);
    drones.forEach((drone, index) => Object.assign(drone, marks[index]));
    state.simTime += CARGO_CONFIG.pickupDuration; rules.step(state, CARGO_CONFIG.pickupDuration);
    assert.deepEqual(drones.map(drone => drone.cargo!.amount), [30, 30, 30]);
    assert.equal(match.resources.find(node => node.id === resource.id)!.remaining, resource.capacity - 90);
    const pad = BATTLEFIELD.servicePads[0], returnMarks = apronServicePositions(pad, pad.zoneSize!);
    drones.forEach((drone, index) => Object.assign(drone, returnMarks[index]));
    state.simTime += CARGO_CONFIG.deliveryDuration; rules.step(state, CARGO_CONFIG.deliveryDuration);
    assert.deepEqual(drones.map(drone => drone.cargo!.amount), [0, 0, 0]);
    assert.equal(match.teams.blue.earned, 90); assert.equal(match.teams.blue.credits, 90);
    assert.equal(match.resources.reduce((sum, node) => sum + node.remaining, 0) + match.teams.blue.earned, 840);
    assert.equal(state.drones.filter(drone => drone.alive !== false).length, 6);
  }
});
