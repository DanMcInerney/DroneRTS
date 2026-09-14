import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplayTimeline, auditReplayTime } from '../client/replay-model.ts';
import type { ReplayCombatEvent, ReplayFrame, ReplayObservation } from '../shared/replay.ts';
import type { Drone, DroneId } from '../shared/types.ts';

const drone = (id: DroneId, x = 0): Drone => ({ id, x, y: 3, z: 0, yaw: 0, pitch: 0, status: 'flying', online: true, observations: 0, alive: true, equipment: { gun: false, armor: false, miner: false } });
const frame = (simTime: number, drones: Drone[]): ReplayFrame => ({ type: 'frame', simTime, drones });
const observation = (simTime: number, id = 'early'): ReplayObservation => ({ type: 'observation', simTime, drone: 'drone-1', pose: drone('drone-1'), capturedAt: '2026-09-14T10:00:00.000Z', mission: 1, imageId: id, imageAvailable: true });
const event = (simTime: number, type: string, extra = {}): ReplayCombatEvent => ({ type: 'event', simTime, event: { id: `${type}-${simTime}`, simTime, type, message: '', ...extra } });

test('replay keeps inventory, deaths and identity at their recorded time, including roster reorder and removal', () => {
  const model = new ReplayTimeline(), a = drone('drone-1', 10), b = drone('drone-2', 100);
  model.append([frame(1, [a, b]), frame(1.1, [{ ...b, x: 102 }, { ...a, x: 12, alive: false, equipment: { gun: true, armor: false, miner: false } }]), frame(1.2, [{ ...b, x: 104 }])]);
  assert.equal(model.sample(0.9).frame, undefined, 'no future frame before recording begins');
  assert.deepEqual(model.sample(1.05).frame!.drones.map(({ id, x, alive, equipment }) => [id, x, alive, equipment!.gun]), [['drone-1', 10, true, false], ['drone-2', 100, true, false]]);
  assert.deepEqual(model.sample(1.1).frame!.drones.map(({ id, x }) => [id, x]), [['drone-2', 102], ['drone-1', 12]]);
  assert.equal(model.sample(1.1).frame!.drones[1].alive, false);
  assert.deepEqual(model.sample(1.2).frame!.drones.map(({ id }) => id), ['drone-2']);
  assert.equal(a.alive, true, 'sampling never mutates a recorded snapshot');
});

test('late-written camera records are selected by acquisition time and missing images stay explicit', () => {
  const model = new ReplayTimeline();
  model.append([frame(0, [drone('drone-1')]), observation(8, 'future'), observation(3, 'first')]);
  assert.equal(model.sample(2, 'drone-1').observation, undefined);
  assert.equal(model.sample(7, 'drone-1').observation!.imageId, 'first');
  model.append([{ ...observation(5), imageId: undefined, imageAvailable: false, omission: 'Image cap reached' }]);
  assert.equal(model.sample(7, 'drone-1').observation!.simTime, 5);
  assert.equal(model.sample(7, 'drone-1').observation!.imageAvailable, false, 'do not silently substitute an older or later image');
  assert.equal(model.sample(8, 'drone-1').observation!.imageId, 'future');
  assert.equal(model.sample(10, 'drone-2').observation, undefined, 'camera evidence belongs to the selected identity');
});

test('sparse recordings hold their last sampled state without inventing a trajectory across gaps', () => {
  const model = new ReplayTimeline();
  model.append([frame(2, [drone('drone-1', 10)]), frame(20, [drone('drone-1', 80)])]);
  assert.equal(model.sample(12).frame!.simTime, 2);
  assert.equal(model.sample(12).frame!.drones[0].x, 10);
  assert.deepEqual(model.window(12, 8), []);
  assert.equal(model.sample(50).frame!.drones[0].x, 80, 'never extrapolate beyond the final sample');
});

test('replay totals use only recorded events and earned balance up to the cursor', () => {
  const model = new ReplayTimeline(), baseline = frame(0, [drone('drone-1')]);
  baseline.match = { phase: 'active', winner: null, resources: [], projectiles: [], teams: { blue: { credits: 2, earned: 22, shopUnlocked: true }, red: { credits: 8, earned: 8, shopUnlocked: true } } };
  model.append([baseline, event(1, 'fired'), event(1.1, 'impact', { target: 'drone-2' }), event(1.2, 'impact'), event(2, 'destroyed', { cause: 'bullet', message: 'Custom wording.' }), event(3, 'destroyed', { message: 'drone-3 was destroyed by ram.' }), event(4, 'destroyed', { cause: 'terrain' })]);
  assert.deepEqual(model.sample(0.5).metrics, { shots: 0, hits: 0, deaths: 0, terrain: 0, ram: 0, bullet: 0, unknown: 0, salvage: 30 });
  assert.deepEqual(model.sample(2.5).metrics, { shots: 1, hits: 1, deaths: 1, terrain: 0, ram: 0, bullet: 1, unknown: 0, salvage: 30 });
  assert.deepEqual(model.sample(4).metrics, { shots: 1, hits: 1, deaths: 3, terrain: 1, ram: 1, bullet: 1, unknown: 0, salvage: 30 });
});

test('appended records preserve equal-time ordering and seek to the next distinct recorded event', () => {
  const model = new ReplayTimeline();
  model.append([event(4, 'fired'), event(2, 'purchased'), event(4, 'impact')]);
  model.append([{ type: 'command', simTime: 4, drone: 'drone-2', name: 'observe', args: {} }, event(8, 'destroyed')]);
  assert.deepEqual(model.sample(4).moments.map(moment => moment.type === 'event' ? moment.event.type : moment.type === 'command' ? moment.name : moment.type), ['purchased', 'fired', 'impact', 'observe']);
  assert.equal(model.adjacent(4, 1), 8); assert.equal(model.adjacent(4, -1), 2);
  assert.equal(model.adjacent(8, 1), undefined); assert.equal(model.adjacent(1, -1), undefined);
});

test('audit seeking requires an explicit finite simulation timestamp', () => {
  assert.equal(auditReplayTime({ simTime: 12 }), 12);
  assert.equal(auditReplayTime({ event: { simTime: 1.2 } }), 1.2);
  assert.equal(auditReplayTime({ wallTime: '2026-09-14T10:00:00Z', text: 'simTime 14' }), undefined);
  assert.equal(auditReplayTime({ arguments: { simTime: 5 } }), undefined, 'a requested tool argument is not an observed simulator timestamp');
  assert.equal(auditReplayTime({ simTime: Infinity }), undefined);
});
