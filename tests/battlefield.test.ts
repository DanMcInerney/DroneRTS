import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix3, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { OBB } from 'three/examples/jsm/math/OBB.js';
import { BATTLEFIELD } from '../shared/battlefield.ts';
import { DRONE_CAMERA } from '../shared/camera-profile.ts';
import { CITY, type CityPoint } from '../shared/city.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';
import { apronServicePositions, CARGO_CONFIG, insideZone, resourceZoneSize, RTS_CONFIG, serviceZoneSize, type Point } from '../shared/rts.ts';
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

const zoneSamples = (zone: Point, size: number) => {
  const fractions = [-0.5, -0.25, 0, 0.25, 0.5];
  return fractions.flatMap(x => fractions.flatMap(z => fractions.map(y => ({
    x: zone.x + x * size, y: zone.y + (y + 0.5) * size, z: zone.z + z * size,
  }))));
};
const containsBody = (zone: Point, size: number, point: Point) => {
  const radius = RTS_CONFIG.droneRadius;
  return Math.abs(point.x - zone.x) + radius < size / 2
    && Math.abs(point.z - zone.z) + radius < size / 2
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

test('the four finite outer deposits and rich downtown mega deposit preserve their supplies', () => {
  assert.equal(new Set(BATTLEFIELD.resources.map(node => node.id)).size, BATTLEFIELD.resources.length);
  assert.equal(BATTLEFIELD.resources.length, 5);
  const outer = BATTLEFIELD.resources.filter(node => node.capacity === 60);
  const rich = BATTLEFIELD.resources.filter(node => node.capacity === 600);
  assert.equal(outer.length, 4);
  assert.ok(outer.every(node => node.capacity === 60));
  assert.equal(rich.length, 1);
  assert.equal(rich[0].capacity, 600);
  assert.equal(BATTLEFIELD.resources.reduce((total, node) => total + node.capacity, 0), 840);
  assert.ok(outer.reduce((total, node) => total + node.capacity, 0) < rich[0].capacity);
  for (const node of BATTLEFIELD.resources) {
    assert.ok(Number.isSafeInteger(node.capacity) && node.capacity > 0);
    assert.equal(node.remaining, node.capacity);
    if (node.capacity === 600) {
      const crossing = CITY.intersections.find(point => point.streets.includes('Vine Street') && point.streets.includes('East 3rd Street'))!;
      assert.ok(Math.hypot(crossing.x - node.x, crossing.z - node.z) < 4, 'central forecourt must connect directly to its mapped crossing');
      assert.ok(clear({ ...crossing, y: 1.5 }, { ...node, y: 1.5 }), 'central forecourt has an unobstructed intersection approach');
      continue;
    }
    const crossing = CITY.intersections.find(point => Math.hypot(point.x - node.x, point.z - node.z) < 0.002);
    assert.ok(crossing, `${node.id} must be centered on a mapped street intersection`);
    const roads = CITY.roads.filter(road => crossing.streets.includes(road.name)
      && road.points.some(point => Math.hypot(point.x - node.x, point.z - node.z) < 0.002));
    const width = Math.max(...roads.map(road => road.width));
    assert.ok(resourceZoneSize(node) >= width && resourceZoneSize(node) <= width * 1.5,
      `${node.id} should fill the crossing, including its angled corners`);
  }
});

test('all grounded aprons have clear airspace and three shared, separated service marks', () => {
  const zones = [...BATTLEFIELD.resources.map(zone => ({ zone, size: resourceZoneSize(zone) })),
    ...BATTLEFIELD.servicePads.map(zone => ({ zone, size: serviceZoneSize(zone) }))];
  for (const { zone, size } of zones) {
    assert.equal(zone.y, 0, `${zone.id} must be grounded`);
    assert.equal(zone.zoneSize, size, `${zone.id} explicitly records its visible interaction bounds`);
    for (const axis of ['x', 'z'] as const) {
      assert.ok(zone[axis] - size / 2 - RTS_CONFIG.droneRadius > CITY.bounds[axis][0]
        && zone[axis] + size / 2 + RTS_CONFIG.droneRadius < CITY.bounds[axis][1], `${zone.id} needs its whole apron and airframe inside the map`);
    }
    assert.ok(zoneSamples(zone, size).every(point => !water(point)), `${zone.id} must be dry across its footprint`);
    const cube = new OBB(new Vector3(zone.x, zone.y + size / 2, zone.z), new Vector3(size / 2, size / 2, size / 2));
    for (const building of CITY.buildings) {
      const obstacle = new OBB(
        new Vector3(building.x, (building.baseY ?? 0) + building.height / 2, building.z),
        new Vector3(building.width / 2, building.height / 2, building.depth / 2),
        new Matrix3().setFromMatrix4(new Matrix4().makeRotationY((building.rotation ?? 0) * Math.PI / 180)),
      );
      assert.equal(cube.intersectsOBB(obstacle), false, `${zone.id} overlaps ${building.id}`);
    }
    const positions = apronServicePositions(zone, size);
    for (const [index, position] of positions.entries()) {
      assert.ok(containsBody(zone, size, position), `${zone.id} needs space for a whole drone`);
      assert.ok(insideZone(position, zone, size));
      assert.ok(position.y >= zone.y + CARGO_CONFIG.hoverMin && position.y <= zone.y + CARGO_CONFIG.hoverMax);
      assert.ok(clear(position), `${zone.id} occupancy ${index + 1} must be collision-free`);
      assert.ok(clear({ ...position, y: zone.y + size + 2 }, position), `${zone.id} needs a clear entry for each occupant`);
      for (const other of positions.slice(index + 1)) {
        assert.ok(Math.hypot(other.x - position.x, other.z - position.z) > RTS_CONFIG.droneRadius * 2 + 0.7);
      }
    }
  }
});

test('both teams have paired opening routes and clear low-altitude access to the downtown mega deposit', () => {
  const [west, east] = BATTLEFIELD.servicePads;
  assert.ok(Math.hypot(east.x - west.x, east.z - west.z) < 70);
  // A sparse visibility graph verifies actual safe street routes, rather than
  // treating straight lines through downtown buildings as available travel.
  const points = [...BATTLEFIELD.servicePads, ...BATTLEFIELD.resources, ...CITY.intersections]
    .map(point => ({ ...point, y: 1.8 }));
  const edges: { to: number; distance: number }[][] = points.map(() => []);
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const distance = Math.hypot(points[j].x - points[i].x, points[j].z - points[i].z);
    if (distance > 25 || !clear(points[i], points[j])) continue;
    if (Array.from({ length: 6 }, (_, step) => step / 5).some(t => water({
      x: points[i].x + (points[j].x - points[i].x) * t,
      z: points[i].z + (points[j].z - points[i].z) * t,
    }))) continue;
    edges[i].push({ to: j, distance }); edges[j].push({ to: i, distance });
  }
  const shortestRoutes = (start: number) => {
    const distances = points.map(() => Infinity), pending = new Set(points.map((_, index) => index));
    distances[start] = 0;
    while (pending.size) {
      let closest = -1;
      for (const index of pending) if (closest < 0 || distances[index] < distances[closest]) closest = index;
      pending.delete(closest);
      for (const edge of edges[closest]) distances[edge.to] = Math.min(distances[edge.to], distances[closest] + edge.distance);
    }
    return distances.slice(2, 2 + BATTLEFIELD.resources.length);
  };
  const westRoutes = shortestRoutes(0), eastRoutes = shortestRoutes(1);
  const outerRoutes = (routes: number[]) => routes.filter((_, i) => BATTLEFIELD.resources[i].capacity === 60).sort((a, b) => a - b);
  const westOpenings = outerRoutes(westRoutes), eastOpenings = outerRoutes(eastRoutes);
  for (let index = 0; index < 2; index++) {
    assert.ok(Math.max(westOpenings[index], eastOpenings[index]) < 50, 'each team needs two reasonably close opening routes');
    assert.ok(Math.abs(westOpenings[index] - eastOpenings[index]) < 8, 'paired opening route lengths should be comparable');
  }
  assert.ok([...westRoutes, ...eastRoutes].every(distance => distance < 125), 'all deposits must have clear routes from both bases');
  const megaIndex = BATTLEFIELD.resources.findIndex(node => node.capacity === 600);
  // The forecourt connected to Vine/Third retains actual geographic detours.
  assert.ok(Math.abs(westRoutes[megaIndex] - eastRoutes[megaIndex]) < 20, 'central street detours must remain bounded');
  assert.ok(Math.max(westRoutes[megaIndex], eastRoutes[megaIndex]) < 100);
  const mega = BATTLEFIELD.resources[megaIndex];
  assert.ok(Math.abs(mega.x) < 10 && mega.z > 25 && mega.z < 40, 'mega depot should remain in the central downtown approach between bases');
});

test('central loading apron has more exposed low-altitude approach directions than every outer cache', () => {
  const visibleDirections = (node: Point) => Array.from({ length: 72 }, (_, index) => index * Math.PI / 36)
    .filter(angle => clear({ x: node.x + Math.cos(angle) * 8, y: 1.8, z: node.z + Math.sin(angle) * 8 }, { ...node, y: node.y + 0.2 }, 0)).length;
  const central = BATTLEFIELD.resources.find(node => node.capacity === 600)!;
  const exposed = visibleDirections(central);
  assert.ok(exposed > 54, 'central stock should be visible from at least three quarters of sampled nearby azimuths');
  for (const node of BATTLEFIELD.resources.filter(node => node.capacity === 60)) {
    assert.ok(exposed > visibleDirections(node), `${node.id} should retain more cover than the central loading apron`);
  }
});

test('the downtown core has no forced square dimensions and permits terrain contact', () => {
  assert.notEqual(CITY.bounds.x[1] - CITY.bounds.x[0], CITY.bounds.z[1] - CITY.bounds.z[0]);
  assert.ok(CITY.bounds.y[0] < 0, 'downward calibration can result in a real terrain collision');
});
