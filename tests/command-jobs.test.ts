import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandJobs } from '../server/command-jobs.ts';
import type { Drone, DroneId } from '../shared/types.ts';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const drone: Drone = { id: 'drone-1', x: 0, y: 3, z: 0, yaw: 0, pitch: 0, status: '', online: true, observations: 0, alive: true };
  let mission = 1, running = true;
  const accepted: number[] = [], events: string[] = [];
  let transit: Promise<void> = Promise.resolve();
  const jobs = new CommandJobs({ drone: () => drone,
    validate: (_id, version) => { if (!running || version !== mission) throw new Error('lifecycle-changed'); },
    hold: () => { drone.action = undefined; },
    waypoint: async (_id, target, profile, owner, valid) => { await transit; if (valid()) { accepted.push(target.x); drone.action = { id: String(target.x), kind: 'fly_to', target, profile, owner }; } },
    event: (_id, job) => events.push(job.state),
  });
  return { drone, jobs, accepted, events, objective: () => { mission++; }, stop: () => { running = false; }, transit: (value: Promise<void>) => { transit = value; } };
}
const id: DroneId = 'drone-1';
test('routes admit immediately and advance only after completed physical steps', async () => {
  const f = fixture(), result = f.jobs.start(id, 1, [{ x: 1, y: 3, z: 0 }, { x: 2, y: 3, z: 0 }]);
  assert.equal(result.state, 'accepted'); assert.deepEqual(f.accepted, []);
  await flush(); assert.deepEqual(f.accepted, [1]);
  assert.equal(f.jobs.status(id)?.state, 'running');
  f.jobs.arrived(id); await flush(); assert.deepEqual(f.accepted, [1, 2]);
  f.jobs.arrived(id); assert.equal(f.jobs.status(id)?.state, 'completed');
});
test('one writer requires explicit replacement and stale in-transit setpoints never execute', async () => {
  const f = fixture(); let release!: () => void;
  f.transit(new Promise<void>(resolve => { release = resolve; }));
  f.jobs.start(id, 1, [{ x: 1, y: 3, z: 0 }]); await flush();
  assert.throws(() => f.jobs.start(id, 1, [{ x: 2, y: 3, z: 0 }]), /writer/);
  f.jobs.start(id, 1, [{ x: 2, y: 3, z: 0 }], { replace: true });
  release(); await flush(); assert.deepEqual(f.accepted, [2]); assert.ok(f.events.includes('cancelled'));
});
test('objective, death/stop and lease loss cancel old jobs without auto routing', async () => {
  for (const change of ['objective', 'stop', 'lease'] as const) {
    const f = fixture(); f.jobs.start(id, 1, [{ x: 1, y: 3, z: 0 }]); await flush();
    if (change === 'objective') f.objective(); else if (change === 'stop') f.stop();
    f.jobs.tick(id, change === 'lease' ? performance.now() + 1000 : performance.now());
    assert.equal(f.jobs.status(id)?.state, change === 'lease' ? 'blocked' : 'cancelled');
    assert.equal(f.drone.action, undefined); f.jobs.arrived(id); assert.deepEqual(f.accepted, [1]);
  }
});
test('invalid route admission has no side effects on current writer', async () => {
  const f = fixture(); const old = f.jobs.start(id, 1, [{ x: 1, y: 3, z: 0 }]); await flush();
  assert.throws(() => f.jobs.start(id, 1, [{ x: NaN, y: 3, z: 0 }], { replace: true }), /finite/);
  assert.equal(f.jobs.status(id)?.id, old.id);
});
