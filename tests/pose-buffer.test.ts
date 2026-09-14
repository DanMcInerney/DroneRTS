import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PoseBuffer } from '../client/pose-buffer.ts';
import type { Drone, WorldState } from '../client/types.ts';

function state(simTime: number, x: number, yaw = 0, running = true): WorldState {
  return { simTime, running, drones: [{ id: 'drone-1', x, y: 2, z: 0, yaw, pitch: 0, online: true, status: '', observations: 0 }] } as unknown as WorldState;
}

test('display interpolates between snapshots and turns across heading wrap by the shortest arc', () => {
  const buffer = new PoseBuffer(100);
  buffer.push(state(1, 0, 179), 0); buffer.push(state(1.1, 1, -179), 100);
  const pose = buffer.sample(150)[0];
  assert.equal(pose.x, 0.5); assert.equal(pose.yaw, 180);
  assert.equal(buffer.pending(150), true);
  assert.equal(buffer.sample(500)[0].x, 1, 'stalled network never extrapolates past known state');
});

function fleet(simTime: number, members: Array<[Drone['id'], number]>): WorldState {
  return { ...state(simTime, 0), drones: members.map(([id, x]) => ({ ...state(simTime, x).drones[0], id })) };
}

test('reordered snapshots interpolate each drone by identity and keep the latest roster order', () => {
  const buffer = new PoseBuffer();
  buffer.push(fleet(1, [['drone-1', 10], ['drone-2', 100]]), 0);
  buffer.push(fleet(1.1, [['drone-2', 102], ['drone-1', 12]]), 100);
  assert.deepEqual(buffer.sample(150).map(({ id, x }) => [id, x]), [['drone-2', 101], ['drone-1', 11]]);
});

test('spawning and removing units never borrows another unit pose or retains a ghost', () => {
  const buffer = new PoseBuffer();
  buffer.push(fleet(1, [['drone-1', 10], ['drone-2', 100], ['drone-3', 200]]), 0);
  buffer.push(fleet(1.1, [['drone-1', 12], ['drone-2', 102], ['drone-3', 202], ['drone-4', 500]]), 100);
  assert.equal(buffer.sample(150).find(drone => drone.id === 'drone-4')!.x, 500);
  // Removal has no simulation-time increment, as with an administrative despawn.
  buffer.push(fleet(1.1, [['drone-1', 12], ['drone-4', 500]]), 110);
  assert.deepEqual(buffer.sample(150).map(({ id, x }) => [id, x]), [['drone-1', 11], ['drone-4', 500]]);
  buffer.push(fleet(1.2, []), 200);
  assert.deepEqual(buffer.sample(150), []);
});

test('display resets immediately at lifecycle boundaries and does not mutate sensor snapshots', () => {
  const buffer = new PoseBuffer(); const first = state(10, 30);
  buffer.push(first, 100); buffer.push(state(10.1, 31), 200); buffer.sample(250);
  assert.equal(first.drones[0].x, 30);
  buffer.push(state(0, -50, 0, false), 300);
  assert.equal(buffer.sample(300)[0].x, -50);
  buffer.push(state(0, -45, 0, false), 310);
  assert.equal(buffer.sample(310)[0].x, -45);
});
