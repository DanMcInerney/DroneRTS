import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { ReplayRecorder } from '../server/replay-recorder.ts';
import { ReplayStore, replayRouter } from '../server/replay-store.ts';
import { ReplayError, replayFile, ReplayFileReplacedError } from '../server/replay-paths.ts';
import { DEFAULT_FLEET, MATCH_FLEET } from '../shared/fleet.ts';
import type { GameState } from '../shared/types.ts';
import type { RecordedObservation, ReplayHeader, ReplayRecord } from '../shared/replay.ts';

const id = 'session-2026-09-14T10-00-00-000Z.jsonl';
const header: ReplayHeader = { type: 'header', protocol: 'fleet-replay/1', startedAt: '2026-09-14T10:00:00Z', sampleInterval: 0.2, roster: DEFAULT_FLEET, scene: { name: 'Replay test', bounds: { x: [-10, 10], z: [-10, 10] }, focus: { x: [-2, 2], z: [-2, 2] }, obstacles: [], roads: [], river: [] }, camera: { width: 512, height: 288 } };
const state = (simTime: number): GameState => ({ simTime, mission: 1, running: true, speed: 1, completed: false, treasures: [], obstacles: [], radio: [], runtime: { status: 'test', message: '', model: '', effort: '' }, drones: [{ id: 'drone-1', x: simTime, y: 3, z: 1, yaw: 0, pitch: 0, status: 'hover', online: true, observations: 0 }] });
// A real tiny PNG; recorders preserve the bytes delivered by the camera.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const observation = (simTime = 0): RecordedObservation => ({ drone: 'drone-1', simTime, pose: { x: 3, y: 4, z: 5, yaw: 73, pitch: -9 }, capturedAt: '2026-09-14T10:00:01.200Z', mission: 7, image: { mimeType: 'image/png', data: png } });
const line = (record: unknown) => JSON.stringify(record) + '\n';
async function fixture(t: import('node:test').TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-replay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const session = join(directory, 'replays', id.slice(0, -6));
  return { directory, session, path: join(session, 'frames.jsonl'), store: new ReplayStore(directory) };
}
async function records(store: ReplayStore) {
  const result: ReplayRecord[] = []; let after = 0;
  for (;;) {
    const page = await store.page(id, after); result.push(...page.records);
    if (!page.hasMore) return result;
    assert.ok(page.next > after); after = page.next;
  }
}

test('recorder samples immutable frames and preserves command, camera and event evidence in call order', async t => {
  const { directory, session, store } = await fixture(t);
  const recorder = await ReplayRecorder.create({ directory, sessionId: id, header });
  const first = state(0); recorder.recordFrame(first); first.drones[0].x = 900;
  recorder.recordFrame(state(0.1)); recorder.recordFrame(state(0.2));
  recorder.recordCommand('drone-1', 'act', { yaw: 73, token: 'private-token' }, 0.21);
  const camera = { ...observation(0.23), cameraFov: 32 }; recorder.recordObservation(camera); camera.pose.x = 1000; camera.cameraFov = 76;
  recorder.recordEvent({ id: 'hit-1', type: 'impact', simTime: 0.241, drone: 'drone-1', x: 1, y: 2, z: 3, message: 'Impact' });
  const closing = recorder.stop(0.3); assert.equal(recorder.stop(0.4), closing); await closing;
  recorder.recordFrame(state(1), true);
  const saved = await records(store);
  assert.deepEqual(saved.map(value => value.type), ['header', 'frame', 'frame', 'command', 'observation', 'event', 'end']);
  const frames = saved.filter(value => value.type === 'frame'); assert.equal(frames[0].drones[0].x, 0); assert.equal(frames[1].simTime, 0.2);
  const image = saved.find(value => value.type === 'observation')!;
  assert.equal(image.imageAvailable, true); assert.equal(image.pose.x, 3); assert.equal(image.simTime, 0.23); assert.equal(image.mission, 7); assert.equal(image.capturedAt, camera.capturedAt);
  assert.equal(image.cameraFov, 32, 'Replay retains the projection of the delivered image');
  assert.deepEqual(await readFile(join(session, image.imageId!)), Buffer.from(png, 'base64'));
  assert.equal(saved.find(value => value.type === 'event')!.simTime, 0.241);
  assert.ok(!JSON.stringify(saved).includes('private-token')); assert.ok(!JSON.stringify(saved).includes(png));
  assert.equal((saved.at(-1) as { reason: string }).reason, 'stopped');
});

test('default recording retains one simultaneous camera observation from every match drone', async t => {
  const { directory, session, store } = await fixture(t), warnings: string[] = [];
  const recorder = await ReplayRecorder.create({ directory, sessionId: id, header: { ...header, roster: MATCH_FLEET }, onWarning: message => warnings.push(message) });
  recorder.recordFrame(state(0));
  for (const member of MATCH_FLEET) recorder.recordObservation({ ...observation(), drone: member.id });
  await recorder.stop(0);
  const saved = await records(store), cameras = saved.filter(record => record.type === 'observation');
  assert.deepEqual(cameras.map(camera => camera.drone), MATCH_FLEET.map(member => member.id));
  assert.ok(cameras.every(camera => camera.imageAvailable));
  for (const camera of cameras) assert.deepEqual(await readFile(join(session, camera.imageId!)), Buffer.from(png, 'base64'));
  assert.equal(saved.find(record => record.type === 'end')?.reason, 'stopped');
  assert.deepEqual(warnings, []);
});

test('transient status replacement contention preserves a completed readable replay and camera', async t => {
  const { directory, session, store } = await fixture(t), warnings: string[] = [];
  let blocked = 0;
  const recorder = await ReplayRecorder.create({ directory, sessionId: id, header, onWarning: message => warnings.push(message) }, {
    replaceStatus: async (from, to) => {
      if (JSON.parse(await readFile(from, 'utf8')).state === 'stopped' && blocked++ < 2) {
        assert.equal(JSON.parse(await readFile(to, 'utf8')).state, 'recording');
        assert.ok((await store.page(id)).available);
        throw Object.assign(new Error('Destination is temporarily shared'), { code: 'EPERM' });
      }
      await rename(from, to);
    },
  });
  recorder.recordObservation(observation()); await recorder.stop(1);
  const saved = await records(store), camera = saved.find(r => r.type === 'observation')!;
  assert.equal(saved.at(-1)?.type, 'end');
  assert.equal(JSON.parse(await readFile(join(session, 'status.json'), 'utf8')).state, 'stopped');
  assert.deepEqual(await readFile(join(session, camera.imageId!)), Buffer.from(png, 'base64'));
  assert.deepEqual(warnings, []); assert.equal(blocked, 3);
  assert.equal((await readdir(session)).some(name => name.endsWith('.tmp')), false);
});

for (const code of ['EACCES', 'ENOSPC']) test(`persistent ${code} status failure remains explicit and bounded`, async t => {
  const { directory, session, store } = await fixture(t), warnings: string[] = [];
  let attempts = 0;
  const recorder = await ReplayRecorder.create({ directory, sessionId: id, header, onWarning: message => warnings.push(message) }, {
    replaceStatus: async (from, to) => {
      if (JSON.parse(await readFile(from, 'utf8')).state === 'stopped') {
        attempts++; throw Object.assign(new Error('Status replacement denied'), { code });
      }
      await rename(from, to);
    },
  });
  recorder.recordFrame(state(0)); await recorder.stop(1);
  assert.equal(attempts, code === 'EACCES' ? 6 : 1);
  assert.equal(warnings.length, 1);
  assert.equal(JSON.parse(await readFile(join(session, 'status.json'), 'utf8')).state, 'error');
  await assert.rejects(store.page(id), /recording failed/);
  assert.equal((await readdir(session)).some(name => name.endsWith('.tmp')), false);
});

test('concurrent real replay reads and final status replacement stay readable', async t => {
  const { directory, store } = await fixture(t), warnings: string[] = [];
  const recorder = await ReplayRecorder.create({ directory, sessionId: id, header, onWarning: message => warnings.push(message) });
  recorder.recordFrame(state(0)); recorder.recordObservation(observation());
  await Promise.all([recorder.stop(1), ...Array.from({ length: 8 }, async () => {
    for (let i = 0; i < 12; i++) assert.ok((await store.page(id)).available);
  })]);
  assert.equal((await records(store)).at(-1)?.type, 'end');
  assert.deepEqual(warnings, []);
});

test('status reads retry identity replacement with fresh validated opens', async t => {
  const { directory, session, path } = await fixture(t);
  await mkdir(session, { recursive: true }); await writeFile(path, line(header));
  await writeFile(join(session, 'status.json'), JSON.stringify({ state: 'stopped' }));
  let attempts = 0;
  const store = new ReplayStore(directory, { openStatus: async markerDirectory => {
    if (++attempts < 3) throw new ReplayFileReplacedError();
    return replayFile(markerDirectory, 'status.json');
  } });
  const page = await store.page(id);
  assert.equal(page.available, true); assert.equal(page.records[0].type, 'header'); assert.equal(attempts, 3);
});

test('persistent status replacement fails explicitly after three opens and releases frames', async t => {
  const { directory, session, path } = await fixture(t);
  await mkdir(session, { recursive: true }); await writeFile(path, line(header));
  let attempts = 0;
  const store = new ReplayStore(directory, { openStatus: async () => { attempts++; throw new ReplayFileReplacedError(); } });
  await assert.rejects(store.page(id), error => error instanceof ReplayFileReplacedError && error.status === 409);
  assert.equal(attempts, 3); await unlink(path);
});

test('status opening does not retry unavailable paths, permission errors or untyped conflicts', async t => {
  const { directory, session, path } = await fixture(t);
  await mkdir(session, { recursive: true }); await writeFile(path, line(header));
  for (const failure of [new ReplayError('Replay file unavailable.', 404), Object.assign(new Error('Denied'), { code: 'EACCES' }), new ReplayError('Replay file changed; retry.', 409)]) {
    let attempts = 0;
    const store = new ReplayStore(directory, { openStatus: async () => { attempts++; throw failure; } });
    await assert.rejects(store.page(id), error => error === failure); assert.equal(attempts, 1);
  }
});

test('malformed, oversized and failed status contents are never retried', async t => {
  const { directory, session, path } = await fixture(t);
  await mkdir(session, { recursive: true }); await writeFile(path, line(header));
  for (const [contents, expected] of [['{ malformed }', /JSON|Unexpected/], ['x'.repeat(2049), /oversized/], [JSON.stringify({ state: 'error' }), /recording failed/]] as const) {
    await writeFile(join(session, 'status.json'), contents);
    let attempts = 0;
    const store = new ReplayStore(directory, { openStatus: async markerDirectory => { attempts++; return replayFile(markerDirectory, 'status.json'); } });
    await assert.rejects(store.page(id), expected); assert.equal(attempts, 1);
  }
});

test('byte paging retains Unicode and retries incomplete records without skipping evidence', async t => {
  const { session, path, store } = await fixture(t); await mkdir(session, { recursive: true });
  const complete = line(header), pending = line({ type: 'command', simTime: 1, drone: 'drone-1', name: 'send', args: { text: 'Café → river' } });
  await writeFile(path, complete + pending.slice(0, -4));
  const page = await store.page(id); assert.equal(page.records.length, 1); assert.equal(page.next, Buffer.byteLength(complete)); assert.equal(page.hasMore, true);
  const partial = await store.page(id, page.next); assert.equal(partial.records.length, 0); assert.equal(partial.next, page.next);
  await appendFile(path, pending.slice(-4));
  const completed = await store.page(id, partial.next); assert.equal(completed.records.length, 1); assert.equal(completed.hasMore, false);
  assert.equal(completed.next, Buffer.byteLength(complete + pending));
  await assert.rejects(store.page(id, page.next + 1), /complete record/);
  for (const cursor of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(store.page(id, cursor), /cursor/);
  await assert.rejects(store.page(id, completed.next + 1), /changed/);
});

test('pages bound record count and encoded bytes while retaining a large header', async t => {
  const { session, path, store } = await fixture(t); await mkdir(session, { recursive: true });
  const largeHeader = { ...header, scene: { ...header.scene, name: 'h'.repeat(1_900_000) } };
  const command = { type: 'command', simTime: 1, drone: 'drone-1', name: 'send', args: { text: 'x'.repeat(12_000) } };
  await writeFile(path, line(largeHeader) + line(command).repeat(600));
  const first = await store.page(id); assert.ok(first.records.length <= 256); assert.ok(Buffer.byteLength(JSON.stringify(first)) < 4 * 1024 * 1024); assert.equal(first.records[0].type, 'header');
  const all = await records(store); assert.equal(all.length, 601);
  await writeFile(path, '{ broken }\n'); await assert.rejects(store.page(id), /malformed/);
  await writeFile(path, line({ type: 'unknown' })); await assert.rejects(store.page(id), /unknown/);
  await writeFile(path, 'x'.repeat(2 * 1024 * 1024 + 1)); await assert.rejects(store.page(id), /oversized/);
});

test('storage and write-queue limits stop at a bounded prefix with an explicit terminal record', async t => {
  const { directory, path, store } = await fixture(t), warnings: string[] = [];
  const recorder = await ReplayRecorder.create({ directory, sessionId: id, header, onWarning: message => warnings.push(message), limits: { dataBytes: 4000, queueRecords: 2 } });
  for (let i = 0; i < 2000; i++) recorder.recordFrame(state(i), true);
  await recorder.stop(2000);
  const saved = await records(store); assert.ok(saved.length <= 4); assert.ok((await lstat(path)).size <= 4000);
  assert.equal(saved.at(-1)?.type, 'end'); assert.equal((saved.at(-1) as { reason: string }).reason, 'limit');
  assert.equal(warnings.length, 1); assert.match(warnings[0], /limit/);
});

test('data byte limit reserves its terminal record instead of silently truncating JSONL', async t => {
  const { directory, path, store } = await fixture(t);
  const recorder = await ReplayRecorder.create({ directory, sessionId: id, header, limits: { dataBytes: 2500 } });
  recorder.recordCommand('drone-1', 'send', { text: 'x'.repeat(2000) }, 1);
  await recorder.stop(1);
  const saved = await records(store); assert.deepEqual(saved.map(value => value.type), ['header', 'end']);
  assert.ok((await lstat(path)).size <= 2500); assert.equal((saved.at(-1) as { reason: string }).reason, 'limit');
});

test('camera backpressure and storage caps omit images explicitly while keeping sensor metadata', async t => {
  const { directory, session, store } = await fixture(t);
  const recorder = await ReplayRecorder.create({ directory, sessionId: id, header, limits: { queuedImages: 1, imageBytes: 100 } });
  for (let i = 0; i < 5; i++) recorder.recordObservation(observation(i));
  recorder.recordObservation({ ...observation(6), image: undefined });
  await recorder.stop(7);
  const saved = await records(store), cameras = saved.filter(value => value.type === 'observation');
  assert.equal(cameras.length, 6); assert.equal(cameras.filter(value => value.imageAvailable).length, 1);
  assert.match(cameras[1].omission!, /queue/); assert.match(cameras[5].omission!, /No camera/);
  assert.equal((saved.at(-1) as { omittedImages: number }).omittedImages, 5);
  assert.equal((saved.at(-1) as { reason: string }).reason, 'limit');
  const images = (await readdir(session)).filter(name => name.endsWith('.png')); assert.equal(images.length, 1);
  assert.ok((await lstat(join(session, images[0]))).size <= 100);
});

test('per-image bounds reject oversized or malformed camera bytes without saving them', async t => {
  const { directory, session, store } = await fixture(t);
  const recorder = await ReplayRecorder.create({ directory, sessionId: id, header, limits: { imageSizeBytes: 80 } });
  recorder.recordObservation({ ...observation(), image: { mimeType: 'image/png', data: 'A'.repeat(200) } });
  recorder.recordObservation({ ...observation(), image: { mimeType: 'image/png', data: 'YWJj' } });
  await recorder.stop(1);
  const cameras = (await records(store)).filter(value => value.type === 'observation');
  assert.match(cameras[0].omission!, /per-image/); assert.match(cameras[1].omission!, /Invalid/);
  assert.equal((await readdir(session)).some(name => name.endsWith('.png')), false);
});

test('the total image budget persists after a camera write drains', async t => {
  const { directory, session, store } = await fixture(t);
  const recorder = await ReplayRecorder.create({ directory, sessionId: id, header, limits: { imageBytes: Buffer.from(png, 'base64').length } });
  t.after(() => recorder.stop(2));
  recorder.recordObservation(observation(0));
  // Wait on public persisted evidence, not an internal writer implementation.
  for (let attempts = 0; ; attempts++) {
    if ((await store.page(id)).records.some(record => record.type === 'observation')) break;
    assert.ok(attempts < 100, 'First camera evidence should finish writing');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  recorder.recordObservation(observation(1)); await recorder.stop(2);
  const cameras = (await records(store)).filter(record => record.type === 'observation');
  assert.equal(cameras[0].imageAvailable, true); assert.equal(cameras[1].imageAvailable, false); assert.match(cameras[1].omission!, /storage limit/);
  assert.equal((await readdir(session)).filter(name => name.endsWith('.png')).length, 1);
});

test('unavailable storage never throws into gameplay and failed finalization closes its writer', async t => {
  const { directory, session, path } = await fixture(t), warnings: string[] = [];
  const badRoot = join(directory, 'not-a-directory'); await writeFile(badRoot, 'occupied');
  const disabled = await ReplayRecorder.create({ directory: badRoot, sessionId: id, header, onWarning: message => warnings.push(message) });
  disabled.recordFrame(state(1)); disabled.recordObservation(observation()); await disabled.stop(1);
  assert.equal(warnings.length, 1); assert.match(warnings[0], /failed/);
  const recorder = await ReplayRecorder.create({ directory, sessionId: id, header, onWarning: message => warnings.push(message) });
  await unlink(join(session, 'status.json')); await mkdir(join(session, 'status.json'));
  recorder.recordFrame(state(1)); await recorder.stop(1); await recorder.stop(2);
  assert.equal(warnings.length, 2); assert.equal((await readFile(path, 'utf8')).trim().split('\n').length, 3);
  assert.equal((await readdir(session)).some(name => name.endsWith('.tmp')), false);
  // Windows also allows the completed file to be removed, proving no writer is retained.
  await unlink(path);
});

test('existing replay sessions cannot be overwritten and failures remain explicit to readers', async t => {
  const { directory, session, path, store } = await fixture(t);
  const recorder = await ReplayRecorder.create({ directory, sessionId: id, header }); await recorder.stop(0);
  const before = await readFile(path, 'utf8'), warnings: string[] = [];
  const duplicate = await ReplayRecorder.create({ directory, sessionId: id, header, onWarning: message => warnings.push(message) }); await duplicate.stop(0);
  assert.equal(warnings.length, 1); assert.equal(await readFile(path, 'utf8'), before);
  await writeFile(join(session, 'status.json'), JSON.stringify({ state: 'error', message: 'Disk failure' }));
  await assert.rejects(store.page(id), /recording failed/);
});

test('replay routes validate paths, reject symlinks and serve only bounded local camera images', async t => {
  const { directory, session, store } = await fixture(t);
  assert.deepEqual(await store.page(id), { available: false, records: [], next: 0, hasMore: false, bytes: 0 });
  for (const value of ['../session-a.jsonl', '..\\session-a.jsonl', 'auth.json', 'session-a.jsonl/other', '/session-a.jsonl']) await assert.rejects(store.page(value), /valid replay/);
  const recorder = await ReplayRecorder.create({ directory, sessionId: id, header }); recorder.recordObservation(observation()); await recorder.stop(0);
  const image = (await records(store)).find(value => value.type === 'observation')!;
  for (const value of ['../frames.jsonl', '..\\frames.jsonl', 'frames.jsonl', '%2e%2e', 'not-a-uuid.png']) await assert.rejects(store.image(id, value), /valid replay image/);
  const app = express(); app.use('/api/diagnostics', replayRouter({ directory }));
  const server = app.listen(0, '127.0.0.1'); t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/diagnostics/sessions/${id}/replay`;
  const response = await fetch(base); assert.equal(response.status, 200); assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.equal((await response.json()).available, true);
  const camera = await fetch(`${base}/images/${image.imageId}`); assert.equal(camera.status, 200); assert.equal(camera.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await camera.arrayBuffer()), Buffer.from(png, 'base64'));
  for (const query of ['after=-1', 'after=NaN', 'after=1&after=2']) assert.equal((await fetch(`${base}?${query}`)).status, 400);
  const linkedId = '00000000-0000-4000-8000-000000000000.png';
  try {
    await symlink(session, join(directory, 'replays', 'session-link'), 'junction');
    await assert.rejects(store.page('session-link.jsonl'), /unavailable/);
    const alias = join(directory, 'alias'); await mkdir(alias);
    await symlink(join(directory, 'replays'), join(alias, 'replays'), 'junction');
    await assert.rejects(new ReplayStore(alias).page(id), /unavailable/);
    const warnings: string[] = [];
    const blocked = await ReplayRecorder.create({ directory: alias, sessionId: 'session-new.jsonl', header, onWarning: message => warnings.push(message) }); await blocked.stop(0);
    assert.equal(warnings.length, 1); assert.match(warnings[0], /directory unavailable/);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }
  try {
    await symlink(join(session, image.imageId!), join(session, linkedId));
    await assert.rejects(store.image(id, linkedId), /unavailable/);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }
});
