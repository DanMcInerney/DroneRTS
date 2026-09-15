import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BATTLEFIELD } from '../shared/battlefield.ts';
import { CITY, type CityPoint } from '../shared/city.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';
import { RTS_CONFIG, type Point } from '../shared/rts.ts';
import { intersectsBuilding } from '../server/world-geometry.ts';

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

test('each initial camera faces its halfway cargo along a clear approach', () => {
  Object.values(BATTLEFIELD.spawns).forEach((spawn, index) => {
    const node = BATTLEFIELD.resources[index < 3 ? 0 : 2];
    const dx = node.x - spawn.x, dy = node.y + 0.65 - spawn.y, dz = node.z - spawn.z;
    const distance = Math.hypot(dx, dy, dz);
    const yaw = spawn.yaw * Math.PI / 180, pitch = spawn.pitch * Math.PI / 180;
    const forward = { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
    assert.ok((dx * forward.x + dy * forward.y + dz * forward.z) / distance > 0.9999);
    assert.ok(distance > RTS_CONFIG.miningRange, 'halfway cargo requires travel from the base');
    assert.ok(clear(spawn, node, 0), `initial view ${index + 1} is occluded`);
    const approach = { x: node.x - dx / distance * 1.8, y: spawn.y, z: node.z - dz / distance * 1.8 };
    assert.ok(clear(spawn, approach), `initial mining approach ${index + 1} is blocked`);
    assert.ok(Math.hypot(approach.x - node.x, approach.y - node.y, approach.z - node.z) < RTS_CONFIG.miningRange);
  });
});

test('finite deposits sit on dry, reachable intersections with multiple mining positions', () => {
  assert.equal(BATTLEFIELD.resources.length, 3);
  assert.equal(new Set(BATTLEFIELD.resources.map(node => node.id)).size, BATTLEFIELD.resources.length);
  assert.equal(BATTLEFIELD.resources[0].capacity, BATTLEFIELD.resources[2].capacity);
  assert.ok(BATTLEFIELD.resources[1].capacity >= BATTLEFIELD.resources[0].capacity * 3);
  for (const node of BATTLEFIELD.resources) {
    assert.ok(Number.isSafeInteger(node.capacity) && node.capacity > 0);
    assert.equal(node.remaining, node.capacity);
    assert.equal(water(node), false, node.id);
    assert.ok(clear(node, node, node.id === 'salvage-center' ? 2.4 : 1.6), `${node.id} cargo footprint intersects a building`);
    const positions = Array.from({ length: 12 }, (_, index) => ({
      x: node.x + Math.cos(index * Math.PI / 6) * 1.6,
      y: 1.8,
      z: node.z + Math.sin(index * Math.PI / 6) * 1.6,
    })).filter(point => clear(point) && clear({ ...point, y: 26 }, point));
    assert.ok(positions.length >= 3, `${node.id} needs several unobstructed mining approaches`);
  }
});

test('cargo lies at the battlefield center and exactly halfway from each base', () => {
  const [west, center, east] = BATTLEFIELD.resources;
  assert.deepEqual({ x: center.x, z: center.z }, BATTLEFIELD.center);
  for (const [index, node] of [west, east].entries()) {
    const base = BATTLEFIELD.bases[index];
    assert.equal(node.x, (base.x + center.x) / 2);
    assert.equal(node.z, (base.z + center.z) / 2);
  }
  const distances = BATTLEFIELD.bases.map(base => Math.hypot(base.x - center.x, base.z - center.z));
  assert.ok(Math.abs(distances[0] - distances[1]) < 1, 'central cargo is comparably accessible from both bases');
  for (const axis of ['x', 'z'] as const) {
    assert.ok(Math.abs((BATTLEFIELD.focus[axis][0] + BATTLEFIELD.focus[axis][1]) / 2 - center[axis]) < 1e-9);
  }
});

test('the wider city has no forced square dimensions or artificial altitude floor', () => {
  assert.notEqual(CITY.bounds.x[1] - CITY.bounds.x[0], CITY.bounds.z[1] - CITY.bounds.z[0]);
  assert.ok(CITY.bounds.y[0] < 0, 'downward calibration can result in a real terrain collision');
});
