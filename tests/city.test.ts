import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CITY } from '../shared/city.ts';
import { intersectsBuilding } from '../server/world-geometry.ts';

test('square world contains every Cincinnati boundary vertex and keeps the southern riverfront inside', () => {
  const width = CITY.bounds.x[1] - CITY.bounds.x[0], depth = CITY.bounds.z[1] - CITY.bounds.z[0];
  assert.equal(width, depth); assert.ok(width > 2900);
  assert.ok(CITY.cityBoundary[0].length > 100);
  for (const p of CITY.cityBoundary.flat()) {
    assert.ok(p.x > CITY.bounds.x[0] && p.x < CITY.bounds.x[1]);
    assert.ok(p.z > CITY.bounds.z[0] && p.z < CITY.bounds.z[1] - 99);
  }
  assert.ok(CITY.river.length > 500, 'retain the actual winding river');
  for (const p of CITY.river) {
    assert.ok(p.x >= CITY.bounds.x[0] - 0.001 && p.x <= CITY.bounds.x[1] + 0.001);
    assert.ok(p.z >= CITY.bounds.z[0] - 0.001 && p.z <= CITY.bounds.z[1] + 0.001);
  }
});

test('Cincinnati scene retains mapped massing and skyline heights, with clear spawns and street intersections', () => {
  assert.ok(CITY.buildings.length > 200); assert.ok(CITY.roads.length > 500);
  assert.ok(CITY.intersections.length >= 12);
  const top = (prefix: string) => Math.max(...CITY.buildings.filter(b => b.id?.startsWith(prefix)).map(b => b.height + (b.baseY ?? 0)));
  assert.ok(Math.abs(top('great-american-tower') - 20.27) < 0.002);
  assert.ok(Math.abs(top('carew-tower') - 17.5) < 0.002);
  for (const spawn of CITY.spawns) assert.equal(CITY.buildings.some(b => intersectsBuilding(spawn, spawn, b, 0.3)), false);
  for (const junction of CITY.intersections) {
    const centre = { x: junction.x, y: 0.55, z: junction.z };
    assert.equal(CITY.buildings.some(b => intersectsBuilding(centre, centre, b, 0.9)), false, junction.id);
    for (const axis of ['x', 'y', 'z'] as const) assert.ok(centre[axis] >= (axis === 'y' ? 0 : CITY.bounds[axis][0]) && centre[axis] < CITY.bounds[axis][1]);
    assert.ok(junction.streets.length >= 2);
    for (const name of junction.streets) assert.ok(CITY.roads.some(road => road.name === name
      && road.points.some(point => Math.hypot(point.x - junction.x, point.z - junction.z) < 0.002)), `${junction.id}: ${name}`);
  }
});

test('rotated collision volumes block crossing segments, allow rooftops, and respect elevated tiers', () => {
  const tower = { x: 0, z: 0, width: 1, depth: 5, height: 10, rotation: 45 };
  assert.equal(intersectsBuilding({ x: -9, y: 2, z: 0 }, { x: 9, y: 2, z: 0 }, tower, 0.3), true);
  assert.equal(intersectsBuilding({ x: -9, y: 11, z: 0 }, { x: 9, y: 11, z: 0 }, tower, 0.3), false);
  assert.equal(intersectsBuilding({ x: -9, y: 2, z: 0 }, { x: 9, y: 2, z: 0 }, { ...tower, baseY: 5 }), false);
});
