import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraChannel } from '../server/camera-channel.ts';

const jpeg = 'data:image/jpeg;base64,/9j/AA==';
class Socket { readyState = 1; sent: any[] = []; send(value: string) { this.sent.push(JSON.parse(value)); } }
const pose = { x: 0, y: 2, z: 0, yaw: 0, pitch: -90 };

test('only a matching renderer can supply camera pixels, including after a stale client reconnects first', async () => {
  const readiness: boolean[] = [], evidence: any[] = [];
  const camera = new CameraChannel('current', ready => readiness.push(ready), record => evidence.push(record));
  const old = new Socket(), current = new Socket(), unrelated = new Socket();
  camera.attach(old); camera.receive(old, { type: 'camera-ready', rendererId: 'old' });
  assert.equal(camera.ready, false); assert.equal(old.sent[0].type, 'camera-rejected');
  await assert.rejects(camera.capture('drone-1', pose, 0, []), /matching camera/);
  camera.attach(current); camera.attach(unrelated);
  camera.receive(current, { type: 'camera-ready', rendererId: 'current' });
  const pending = camera.capture('drone-1', pose, 5, []);
  const request = current.sent.at(-1);
  camera.receive(old, { type: 'capture-result', requestId: request.requestId, rendererId: 'current', image: jpeg });
  camera.receive(current, { type: 'capture-result', requestId: request.requestId, rendererId: 'current', image: jpeg });
  assert.equal(await pending, jpeg); assert.equal(request.rendererId, 'current');
  assert.equal(evidence.at(-1).rendererId, 'current'); assert.equal(evidence.at(-1).simTime, 5);
  const cancelled = camera.capture('drone-1', pose, 6, []);
  const rejection = assert.rejects(cancelled, /disconnected/);
  camera.detach(current); await rejection;
  assert.equal(camera.ready, false, 'An unverified open socket must not keep simulation connected');
  assert.equal(readiness.at(-1), false);
});

test('a renderer cannot change identity after admission or complete a cancelled acquisition', async () => {
  const camera = new CameraChannel('current', () => {}), socket = new Socket();
  camera.attach(socket); camera.receive(socket, { type: 'camera-ready', rendererId: 'current' });
  const changed = camera.capture('drone-1', pose, 0, []);
  camera.receive(socket, { type: 'capture-result', requestId: socket.sent.at(-1).requestId, rendererId: 'old', image: jpeg });
  await assert.rejects(changed, /identity changed/);
  const cancelled = camera.capture('drone-1', pose, 1, []), rejected = assert.rejects(cancelled, /Match stopped/);
  camera.cancel(); await rejected;
  camera.receive(socket, { type: 'capture-result', requestId: socket.sent.at(-1).requestId, rendererId: 'current', image: jpeg });
});
