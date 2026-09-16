import test from 'node:test';
import assert from 'node:assert/strict';
import { AcousticSensor, type AcousticMeasurement } from '../server/acoustic-sensor.ts';
import { ACOUSTIC_PROFILE as P } from '../shared/acoustic-profile.ts';
import { FleetGame } from '../server/game.ts';
import { DroneNervelet } from '../server/nervelet.ts';
import type { Drone } from '../shared/types.ts';

const drone = (x: number): Drone => ({ id: 'drone-1', x, y: 3, z: 0, yaw: 0, pitch: 0, status: '', online: true, observations: 0, alive: true });
const source = { x: 0, y: 3, z: 0 };
test('acoustics propagate to finite local receivers, preserve uncertainty and reveal no hidden source', () => {
  const events: AcousticMeasurement[] = [];
  const sensor = new AcousticSensor((_id, event) => events.push(event), () => .5);
  sensor.impulse(source, 10);
  sensor.tick(10.05, [drone(4)], []); assert.equal(events.length, 0);
  sensor.tick(10.12, [drone(4)], []); assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(), ['type', 'sensorProfile', 'simTime', 'acquiredAtMs', 'occurredAt', 'possibleShot', 'uncertain'].sort());
  assert.equal(events[0].simTime, 10.12); assert.equal(events[0].possibleShot, true); assert.equal(events[0].uncertain, true);
  sensor.tick(10.3, [drone(4)], []); assert.equal(events.length, 1, 'one local measurement per source');
  sensor.impulse(source, 11); sensor.tick(11.5, [drone(16)], []); assert.equal(events.length, 1, 'outside sensitivity radius');
  sensor.impulse(source, 12); sensor.tick(12.12, [{ ...drone(4), alive: false }], []); assert.equal(events.length, 1);
});

test('obstruction, miss probability and ambient false positives are distinct sensor mechanisms', () => {
  const events: AcousticMeasurement[] = [];
  const sensor = new AcousticSensor((_id, event) => events.push(event), () => .5);
  sensor.impulse(source, 0);
  sensor.tick(.12, [drone(4)], [{ x: 2, z: 0, width: 1, depth: 2, height: 10 }]);
  assert.equal(events.length, 0, 'absorbed below sensitivity');
  const missed = new AcousticSensor((_id, event) => events.push(event), () => 0);
  missed.impulse(source, 0); missed.tick(.12, [drone(4)], []);
  assert.equal(events.length, 0, 'stochastic miss even with an audible source');
  missed.clear(); missed.tick(0, [drone(4)], []); missed.tick(.1, [drone(4)], []);
  assert.equal(events.length, 1); assert.equal(events[0].possibleShot, true, 'ambient noise can look like a shot without any world source');
});

test('acoustic processing is bounded and reset clears pending stimuli and measurement counters', () => {
  const sensor = new AcousticSensor(() => {}, () => .5);
  for (let i = 0; i < P.maxStimuli + 10; i++) sensor.impulse(source, 0);
  assert.equal(sensor.metrics.saturated, 10);
  sensor.tick(.12, [drone(4)], []);
  assert.equal(sensor.metrics.evaluations, P.maxStimuli);
  assert.equal(sensor.metrics.highWaterStimuli, P.maxStimuli);
  sensor.clear(); assert.equal(sensor.metrics.detections, 0);
  sensor.tick(1, [drone(4)], []); assert.equal(sensor.metrics.evaluations, 0);
});

test('acoustic and attention switches are independent and optional sensor cost is charged', async () => {
  let baseBytes = 0;
  for (const enabled of [false, true]) {
    const game = new FleetGame({ acoustic: enabled }); game.setConnected(true); game.start();
    const pilot = new DroneNervelet(game, 'drone-1');
    try {
      assert.equal(game.acousticEnabled, enabled);
      assert.equal(pilot.bridge.attentionOptions, undefined);
      assert.equal(pilot.profile.instructions!.includes('acoustic/1'), enabled);
      const bytes = game.onboardWorkspace('drone-1').status().logs.usedBytes;
      if (!enabled) baseBytes = bytes;
      else assert.equal(bytes - baseBytes, P.cacheBytes);
    } finally { game.stop(); await pilot.close(); }
  }
});
