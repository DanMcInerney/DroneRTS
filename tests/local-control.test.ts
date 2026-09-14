import test from 'node:test';
import assert from 'node:assert/strict';
import { DroneMotion, FLIGHT_PROFILES, CAMERA_PITCH_LIMITS, type MotionBlockReason } from '../server/drone-motion.ts';
import { LocalSensors, LOCAL_SENSOR_CONFIG, type LocalRangeSample } from '../server/local-sensors.ts';
import { terrainContact, sphereContact } from '../server/rts-geometry.ts';
import { RTS_CONFIG } from '../shared/rts.ts';
import { CITY } from '../shared/city.ts';
import type { Drone, Obstacle } from '../shared/types.ts';

const aircraft = (override: Partial<Drone> = {}): Drone => ({ id: 'drone-1', x: 0, y: 5, z: 0,
  yaw: 0, pitch: 0, online: true, observations: 0, status: 'Flying', alive: true,
  action: { id: 'move-1', kind: 'fly_to', target: { x: 12, y: 5, z: 0 } }, ...override });
const wall: Obstacle = { id: 'SECRET_BUILDING', name: 'SECRET_NAME', x: 5, z: 0, width: 2, depth: 5, height: 10 };
const beam = (sample: LocalRangeSample, x: number, y: number, z: number) => sample.proximity.find(reading =>
  reading.direction.x === x && reading.direction.y === y && reading.direction.z === z)!;

test('finite anonymous sensors describe acquired coverage, downward surfaces and out-of-range space', () => {
  const sensors = new LocalSensors(), drone = aircraft();
  const sample = sensors.acquire(drone, [wall], [drone], 7, 1000);
  assert.equal(sample.sequence, 1); assert.equal(sample.simTime, 7); assert.equal(sample.acquiredAtMs, 1000);
  assert.equal(sample.frame, 'local'); assert.equal(sample.units, 'world_units');
  assert.equal(sample.proximity.length, 26);
  assert.equal(beam(sample, 1, 0, 0).distance, 3.5);
  assert.equal(beam(sample, -1, 0, 0).validity, 'out-of-range');
  assert.equal(beam(sample, -1, 0, 0).distance, null);
  assert.deepEqual(sample.downward, { direction: { x: 0, y: -1, z: 0 }, distance: 5, validity: 'valid',
    coverage: { shape: 'ray', radius: 0, maxDistance: 20 } });
  assert.equal(sensors.acquire(drone, [], [drone], 8, 1050).sequence, 2);
  assert.ok(!JSON.stringify(sample).includes('SECRET'));
  assert.ok(!JSON.stringify(sample).includes('contact'));
  sample.origin.x = 500; sample.proximity[0].direction.x = 500;
  assert.equal(sensors.acquire(drone, [], [drone], 9, 1100).origin.x, 0);
  assert.ok(sensors.acquire(drone, [], [drone], 9, 1100).proximity[0].direction.x < 1);
  sensors.clear(); assert.equal(sensors.acquire(drone, [], [drone], 0).sequence, 1);
});

function fly(obstacles: Obstacle[], others: Drone[], drone = aircraft(), moving = false) {
  const sensors = new LocalSensors(), motion = new DroneMotion();
  let blocked: MotionBlockReason | undefined, firstBlockedX = Infinity;
  for (let index = 0; index < 1400; index++) {
    if (moving && drone.x >= 1.8) Object.assign(others[0], { x: 3.7, z: 0 });
    const from = { x: drone.x, y: drone.y, z: drone.z };
    const ranges = sensors.acquire(drone, obstacles, [drone, ...others], index / 120, index * 1000 / 120);
    const result = motion.step(drone, 1 / 120, { ranges, nowMs: index * 1000 / 120 });
    assert.equal(terrainContact(from, result.next, obstacles, RTS_CONFIG.droneRadius), undefined, 'local brake avoids physical contact');
    for (const other of others) assert.equal(sphereContact(from, result.next, other, other, RTS_CONFIG.droneRadius * 2), undefined);
    Object.assign(drone, result.next);
    if (result.blocked) { blocked = result.blocked; firstBlockedX = Math.min(firstBlockedX, drone.x); }
  }
  assert.equal(blocked, 'obstruction');
  assert.ok(Math.hypot(...Object.values(motion.velocity(drone))) < 0.001, 'stopped job does not restart itself');
  return { drone, firstBlockedX };
}

test('occupied waypoints brake and remain stopped without choosing a route', () => {
  const { drone } = fly([], [aircraft({ id: 'drone-2', x: 4, action: undefined })]);
  assert.ok(drone.x < 4 - RTS_CONFIG.droneRadius * 2);
  assert.equal(drone.y, 5); assert.equal(drone.z, 0);
});

test('corners, rotated geometry and roof edges use measured local clearances', () => {
  fly([wall, { ...wall, x: 5, z: 2, rotation: 35 }], []);
  const drone = aircraft({ x: -6, y: 3, action: { id: 'roof-edge', kind: 'fly_to', target: { x: 6, y: 3, z: 0 } } });
  fly([{ x: 0, z: 0, width: 6, depth: 6, height: 4 }], [], drone);
  const descending = aircraft({ y: 8, action: { id: 'roof-down', kind: 'fly_to', target: { x: 0, y: 3, z: 0 } } });
  const roof = fly([{ x: 0, z: 0, width: 6, depth: 6, height: 4 }], [], descending).drone;
  assert.ok(roof.y > 4 + RTS_CONFIG.droneRadius);
});

test('newly sensed moving obstructions stop motion while the model issues no further calls', () => {
  const other = aircraft({ id: 'drone-2', x: 3.7, z: 8, action: undefined });
  const { drone } = fly([], [other], aircraft(), true);
  assert.ok(drone.x < 3.7 - RTS_CONFIG.droneRadius * 2);
});

test('arbitrary direction travel stays within finite beam coverage and completes in open space', () => {
  const sensors = new LocalSensors(), motion = new DroneMotion();
  const drone = aircraft({ action: { id: 'arbitrary', kind: 'fly_to', target: { x: 6, y: 6.1, z: 2.3 } } });
  let arrived = false;
  for (let i = 0; i < 2400 && !arrived; i++) {
    const ranges = sensors.acquire(drone, [], [drone], i / 120, i * 1000 / 120);
    const next = motion.step(drone, 1 / 120, { ranges, nowMs: i * 1000 / 120 });
    assert.equal(next.blocked, undefined);
    Object.assign(drone, next.next); arrived = next.arrived;
  }
  assert.equal(arrived, true);
  assert.deepEqual({ x: drone.x, y: drone.y, z: drone.z }, drone.action!.target);
});

test('the recorded peer guard-shell overlap permits vertical and arbitrary retreat without losing physical clearance', () => {
  const blue1 = { x: -43.6442865, y: 8, z: 40.5 }, blue3 = { x: -42.9000015, y: 7.989617, z: 40.0999985 };
  const initialDistance = Math.hypot(blue1.x - blue3.x, blue1.y - blue3.y, blue1.z - blue3.z);
  assert.ok(initialDistance > 2 * RTS_CONFIG.droneRadius && initialDistance < RTS_CONFIG.droneRadius + LOCAL_SENSOR_CONFIG.proximityRadius);
  for (const target of [{ ...blue3, y: blue3.y + 4 }, { x: blue3.x + 4, y: blue3.y + 1.1, z: blue3.z - 1.7 }]) {
    const drone = aircraft({ ...blue3, action: { id: 'retreat', kind: 'fly_to', target } });
    const peer = aircraft({ id: 'drone-2', ...blue1, action: undefined });
    const sensors = new LocalSensors(), motion = new DroneMotion();
    const initial = sensors.acquire(drone, [], [drone, peer], 0, 0);
    assert.ok(initial.proximity.every(reading => reading.coverage.radius >= RTS_CONFIG.droneRadius
      && reading.coverage.radius < LOCAL_SENSOR_CONFIG.proximityRadius));
    assert.ok(initial.proximity.some(reading => reading.distance !== 0));
    let arrived = false;
    for (let i = 0; i < 2400 && !arrived; i++) {
      const from = { x: drone.x, y: drone.y, z: drone.z };
      const ranges = sensors.acquire(drone, [], [drone, peer], i / 120, i * 1000 / 120);
      const result = motion.step(drone, 1 / 120, { ranges, nowMs: i * 1000 / 120 });
      assert.equal(result.blocked, undefined, 'a clear retreat must not become an all-direction deadlock');
      assert.equal(sphereContact(from, result.next, peer, peer, RTS_CONFIG.droneRadius * 2), undefined);
      Object.assign(drone, result.next); arrived = result.arrived;
    }
    assert.equal(arrived, true);
    assert.ok(Math.hypot(drone.x - peer.x, drone.y - peer.y, drone.z - peer.z) > initialDistance + 2);
  }
  // Narrower sensing is not permission to accelerate toward the occupied pose.
  const approaching = aircraft({ ...blue3, action: { id: 'approach', kind: 'fly_to', target: blue1 } });
  const peer = aircraft({ id: 'drone-2', ...blue1, action: undefined });
  const stopped = fly([], [peer], approaching).drone;
  assert.ok(Math.hypot(stopped.x - peer.x, stopped.y - peer.y, stopped.z - peer.z) > RTS_CONFIG.droneRadius * 2,
    'approach stops before physical contact despite the narrower guard');
});

test('terrain and roof guard-shell overlaps retain between-beam escape coverage even near the physical radius', () => {
  const fixtures: Array<{ drone: Drone; obstacles: Obstacle[] }> = [
    { drone: aircraft({ x: 1.45, action: { id: 'wall-retreat', kind: 'fly_to', target: { x: 5, y: 6.1, z: 1.7 } } }),
      obstacles: [{ x: 0, z: 0, width: 2, depth: 4, height: 10 }] },
    { drone: aircraft({ y: 4.45, action: { id: 'roof-retreat', kind: 'fly_to', target: { x: 3, y: 7, z: 1.1 } } }),
      obstacles: [{ x: 0, z: 0, width: 8, depth: 8, height: 4 }] },
    { drone: aircraft({ y: RTS_CONFIG.droneRadius + 0.001,
      action: { id: 'ground-retreat', kind: 'fly_to', target: { x: 2, y: 2, z: 1 } } }), obstacles: [] },
  ];
  for (const { drone, obstacles } of fixtures) {
    const sensors = new LocalSensors(), motion = new DroneMotion(); let arrived = false;
    for (let i = 0; i < 2400 && !arrived; i++) {
      const from = { x: drone.x, y: drone.y, z: drone.z };
      const ranges = sensors.acquire(drone, obstacles, [drone], i / 120, i * 1000 / 120);
      const result = motion.step(drone, 1 / 120, { ranges, nowMs: i * 1000 / 120 });
      assert.equal(result.blocked, undefined);
      assert.equal(terrainContact(from, result.next, obstacles, RTS_CONFIG.droneRadius), undefined);
      Object.assign(drone, result.next); arrived = result.arrived;
    }
    assert.equal(arrived, true);
  }
});

test('two peers can simultaneously leave overlapping sensing guards without either airframe contacting', () => {
  const drones = [aircraft({ x: -0.4, action: { id: 'left', kind: 'fly_to', target: { x: -3, y: 6.2, z: 0.7 } } }),
    aircraft({ id: 'drone-2', x: 0.4, action: { id: 'right', kind: 'fly_to', target: { x: 3, y: 5.6, z: -0.9 } } })];
  const motion = new DroneMotion(), sensors = new LocalSensors();
  for (let i = 0; i < 1200; i++) {
    const before = drones.map(drone => ({ x: drone.x, y: drone.y, z: drone.z }));
    const updates = drones.map(drone => {
      const ranges = sensors.acquire(drone, [], drones, i / 120, i * 1000 / 120);
      const result = motion.step(drone, 1 / 120, { ranges, nowMs: i * 1000 / 120 });
      assert.equal(result.blocked, undefined); return result.next;
    });
    assert.equal(sphereContact(before[0], updates[0], before[1], updates[1], RTS_CONFIG.droneRadius * 2), undefined);
    drones.forEach((drone, index) => Object.assign(drone, updates[index]));
  }
  assert.ok(Math.abs(drones[0].x - drones[1].x) > 5.9);
});

test('stale and absent required coverage physically brake and report distinct failures', () => {
  for (const reason of ['sensor-stale', 'sensor-unavailable', 'coverage-unavailable'] as const) {
    const drone = aircraft(), motion = new DroneMotion(), sensors = new LocalSensors();
    for (let i = 0; i < 20; i++) Object.assign(drone, motion.step(drone, 1 / 120).next);
    const before = motion.velocity(drone).x, x = drone.x;
    const ranges = sensors.acquire(drone, [], [drone], 1, 1000);
    if (reason === 'coverage-unavailable') ranges.proximity = [beam(ranges, 0, 1, 0)];
    const result = motion.step(drone, 1 / 120, { ranges: reason === 'sensor-unavailable' ? undefined : ranges,
      nowMs: reason === 'sensor-stale' ? 1000 + LOCAL_SENSOR_CONFIG.maxAgeMs + 1 : 1000 });
    assert.equal(result.blocked, reason); assert.ok(result.next.x > x, 'braking retains continuous inertia');
    assert.ok(motion.velocity(drone).x > 0 && motion.velocity(drone).x < before);
  }
});

test('travel, precision and loaded speed are actuator limits; true downward aim settles', () => {
  for (const profile of ['travel', 'precision'] as const) for (const loaded of [false, true]) {
    const drone = aircraft(), motion = new DroneMotion(), sensors = new LocalSensors();
    drone.action!.target!.x = 100;
    let maximum = 0;
    for (let i = 0; i < 360; i++) {
      const ranges = sensors.acquire(drone, [], [drone], i / 120, i * 1000 / 120);
      Object.assign(drone, motion.step(drone, 1 / 120, { ranges, nowMs: i * 1000 / 120, profile, loaded }).next);
      maximum = Math.max(maximum, Math.hypot(...Object.values(motion.velocity(drone))));
    }
    assert.ok(Math.abs(maximum - FLIGHT_PROFILES[profile].maxSpeed * (loaded ? 0.8 : 1)) < 1e-8);
    motion.look(drone, undefined, -90);
    for (let i = 0; i < 1200; i++) motion.step(drone, 1 / 120);
    assert.equal(CAMERA_PITCH_LIMITS.min, -90); assert.equal(drone.pitch, -90);
  }
});

test('six-drone city sensor/controller acquisition remains bounded without camera or inference work', t => {
  const sensors = new LocalSensors(), motion = new DroneMotion(), timings: number[] = [];
  const drones = Array.from({ length: 6 }, (_, index) => aircraft({ id: `drone-${index + 1}`, ...CITY.spawns[index] }));
  for (let i = 0; i < 300; i++) {
    const start = performance.now();
    for (const drone of drones) {
      const ranges = sensors.acquire(drone, CITY.buildings, drones, i / 120);
      motion.step(drone, 1 / 120, { ranges });
    }
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  t.diagnostic(JSON.stringify({ profile: 'six-drone sensing/control only; no camera, transport or inference',
    iterations: timings.length, buildings: CITY.buildings.length, p50Ms: timings[150], p95Ms: timings[285], p99Ms: timings[297] }));
  assert.ok(timings[285] < 50, 'p95 sensing-only work should stay below one nominal host tick');
});
