import test from 'node:test';
import assert from 'node:assert/strict';
import { StateChannel } from '../server/state-channel.ts';
import { CameraChannel } from '../server/camera-channel.ts';

class Socket {
  readyState = 1; bufferedAmount = 0; sent: any[] = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
}
const ack = (sequence: number) => ({ type: 'state-ack', sequence });

test('slow spectators retain one pending snapshot and receive the latest state after acknowledgement', () => {
  const state = { tick: 0 }, channel = new StateChannel(() => state), socket = new Socket();
  channel.attach(socket); channel.broadcast();
  for (let i = 1; i <= 1000; i++) { state.tick = i; channel.broadcast(); }
  assert.equal(socket.sent.length, 1, 'An empty server socket buffer does not imply browser consumption');
  assert.equal(socket.sent[0].state.tick, 0);
  channel.receive(socket, ack(socket.sent[0].sequence));
  assert.equal(socket.sent.length, 2); assert.equal(socket.sent[1].state.tick, 1000);
  channel.receive(socket, ack(socket.sent[1].sequence));
  assert.equal(socket.sent.length, 2, 'Acknowledgements do not create a continuous resend loop');
});

test('acknowledgements are connection-bound and duplicate or malformed acknowledgements cannot release another snapshot', () => {
  const channel = new StateChannel(() => ({})), slow = new Socket(), fast = new Socket();
  channel.attach(slow); channel.attach(fast); channel.broadcast();
  const slowId = slow.sent[0].sequence, fastId = fast.sent[0].sequence;
  channel.broadcast();
  for (const packet of [null, {}, ack(fastId), ack(slowId + 100), { type: 'state-ack', sequence: String(slowId) }]) channel.receive(slow, packet);
  assert.equal(slow.sent.length, 1);
  channel.receive(fast, ack(fastId)); assert.equal(fast.sent.length, 2);
  channel.broadcast(); channel.receive(fast, ack(fastId)); assert.equal(fast.sent.length, 2);
  channel.receive(fast, ack(fast.sent[1].sequence)); assert.equal(fast.sent.length, 3);
  assert.equal(slow.sent.length, 1, 'One slow browser does not hold up another');
  channel.detach(slow); channel.receive(slow, ack(slowId)); channel.broadcast();
  assert.equal(slow.sent.length, 1);
});

test('disconnected and transport-congested spectators cannot accumulate snapshots', () => {
  const channel = new StateChannel(() => ({})), socket = new Socket();
  channel.attach(socket); socket.bufferedAmount = 2_000_000; channel.broadcast();
  assert.equal(socket.sent.length, 0);
  socket.bufferedAmount = 0; socket.readyState = 3; channel.broadcast(); assert.equal(socket.sent.length, 0);
  socket.readyState = 1; channel.broadcast(); assert.equal(socket.sent.length, 1);
});

test('camera requests and cancellation bypass spectator backpressure without replaying old snapshots', async () => {
  const socket = new Socket(), states = new StateChannel(() => ({})), camera = new CameraChannel('current', () => {});
  states.attach(socket); camera.attach(socket); camera.receive(socket, { type: 'camera-ready', rendererId: 'current' });
  for (let i = 0; i < 1000; i++) states.broadcast();
  const controller = new AbortController();
  const capture = camera.capture('drone-1', { x: 0, y: 2, z: 0, yaw: 0, pitch: 0 }, 1, [], undefined, controller.signal);
  const rejected = assert.rejects(capture, /cancelled/);
  assert.equal(socket.sent.at(-1).type, 'capture');
  controller.abort(); await rejected;
  assert.deepEqual(socket.sent.map(packet => packet.type), ['camera-accepted', 'state', 'capture', 'capture-cancel']);
});
