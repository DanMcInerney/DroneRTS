import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReplayRecorder, REPLAY_SOURCE_BYTES } from '../server/replay-recorder.ts';
import { ReplayStore } from '../server/replay-store.ts';
import { ReplayTimeline } from '../client/replay-model.ts';
import { recordedOperations } from '../client/equipment-presentation.ts';
import { onboardPresentation } from '../client/onboard-presentation.ts';
import { radioDeliveryPresentation, visibleRadioMessages } from '../client/drone-radio.ts';
import { DEFAULT_FLEET } from '../shared/fleet.ts';
import type { ReplayHeader, ReplayRecord } from '../shared/replay.ts';
import type { Drone, RadioMessage } from '../shared/types.ts';

const header: ReplayHeader = { type: 'header', protocol: 'fleet-replay/1', rulesVersion: 'cargo-v1', startedAt: '2026-09-14T12:00:00Z', sampleInterval: 0.2, roster: DEFAULT_FLEET, scene: { name: 'Test', bounds: { x: [-1, 1], z: [-1, 1] }, focus: { x: [-1, 1], z: [-1, 1] }, obstacles: [], roads: [], river: [] }, camera: { width: 512, height: 288 } };
const actor: Drone = { id: 'drone-1', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, status: 'Hovering', online: true, observations: 0 };
const radio: RadioMessage = { protocol: 'fleet-radio/1', id: 'm1', sessionId: 's', sequence: 1, sentAt: '2026-09-14T12:00:00Z', from: 'drone-1', to: 'operator', kind: 'chat', text: 'My actual plan.', simTime: 2, mission: 1 };

test('replay stores immutable exact UTF-8 source hashes, SDK outcomes and cancellation without executing source', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'replay-onboard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionId = 'session-onboard.jsonl', recorder = await ReplayRecorder.create({ directory, sessionId, header });
  const source = 'globalThis.archivedRoutineRan = true; // λ';
  const hash = recorder.recordScriptSource({ drone: 'drone-1', path: 'note.js', version: 1, source, simTime: 1 });
  const args = { x: 1, token: 'secret-record-token' };
  recorder.recordExecution({ drone: 'drone-1', jobId: 'j1', sourceHash: hash, operation: 'move', args, outcome: { accepted: true }, simTime: 2 });
  args.x = 99;
  const message = { ...radio, delivery: { queuedAt: radio.sentAt, storedBy: ['operator'], bundledBy: [] as string[] } };
  recorder.recordRadio(message, 2.5); message.delivery.storedBy.push('drone-2');
  recorder.recordCancellation({ drone: 'drone-1', jobId: 'j1', sourceHash: hash, reason: 'objective received', simTime: 3 });
  recorder.recordScriptSource({ drone: 'drone-1', path: 'note.js', version: 2, source: 'throw new Error("never run")', simTime: 4 });
  await recorder.stop(5);
  const store = new ReplayStore(directory), records: ReplayRecord[] = []; let after = 0;
  for (;;) { const page = await store.page(sessionId, after); records.push(...page.records); if (!page.hasMore) break; after = page.next; }
  const first = records.find(record => record.type === 'script-source')!;
  assert.equal(hash, createHash('sha256').update(source).digest('hex'));
  assert.equal(first.sourceHash, hash); assert.equal(first.sourceBytes, Buffer.byteLength(source)); assert.equal(first.source, source);
  assert.equal(records.find(record => record.type === 'execution')!.args.x, 1);
  assert.ok(!JSON.stringify(records).includes('secret-record-token'));
  assert.deepEqual(records.find(record => record.type === 'radio')!.message.delivery!.storedBy, ['operator']);
  const model = new ReplayTimeline(); model.append(records);
  assert.equal(model.header!.rulesVersion, 'cargo-v1');
  assert.equal(model.sample(0.5, 'drone-1').sources.length, 0);
  assert.equal(model.sample(3, 'drone-1').sources.length, 1);
  assert.equal(model.sample(3, 'drone-1').cancellations[0].reason, 'objective received');
  assert.equal(model.sample(4, 'drone-1').sources.length, 2);
  assert.equal(model.sample(4, 'drone-2').sources.length, 0);
  assert.equal((globalThis as Record<string, unknown>).archivedRoutineRan, undefined);
});

test('oversized source keeps its hash and explicit omission within bounded recording', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'replay-source-limit-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const recorder = await ReplayRecorder.create({ directory, sessionId: 'session-source.jsonl', header });
  const source = 'λ'.repeat(REPLAY_SOURCE_BYTES / 2 + 1);
  recorder.recordScriptSource({ drone: 'drone-1', path: 'large.js', version: 1, source, simTime: 1 }); await recorder.stop(2);
  const page = await new ReplayStore(directory).page('session-source.jsonl');
  const saved = page.records.find(record => record.type === 'script-source')!;
  assert.equal(saved.source, undefined); assert.match(saved.omission!, /limit/);
  assert.equal(saved.sourceBytes, Buffer.byteLength(source)); assert.equal(saved.sourceHash, createHash('sha256').update(source).digest('hex'));
  assert.ok(page.bytes < 4096);
});

test('cargo, controller and storage presentation retain actual feedback without inventing missing history', () => {
  const own = onboardPresentation({ ...actor, cargo: { amount: 30 }, logistics: { state: 'unloading', progress: 0.5, remaining: 1, duration: 2 }, job: { id: 'j', kind: 'route', state: 'blocked', mission: 1, reason: 'obstruction' }, storage: { workspace: { usedBytes: 80, limitBytes: 8192, freeBytes: 8112 } } });
  assert.equal(own.cargo, 'CARGO 30 / 30'); assert.match(own.logistics!, /UNLOADING · 50% · 1.0s/);
  assert.match(own.job!, /BLOCKED · obstruction/); assert.match(own.storage!, /workspace: 80 B \/ 8.0 KiB/);
  assert.equal(onboardPresentation(actor).cargo, undefined); assert.equal(onboardPresentation(actor).job, undefined);
  assert.match(onboardPresentation({ ...actor, job: { id: 'completed', kind: 'route', state: 'completed', mission: 1, step: 1, totalSteps: 1 } }).job!, /1\/1$/);
  const modern = recordedOperations({ ...actor, battery: 300 }, { rulesVersion: 'cargo-v1', resources: [], servicePads: [] });
  assert.ok(modern.includes('Battery 100%'));
  const current = recordedOperations({ ...actor, cargo: { amount: 30 } }, { rulesVersion: 'cargo-v2', resources: [], servicePads: [] });
  assert.ok(current.includes('CARGO 30 / 30'));
  assert.ok(!current.some(line => /battery|charg/i.test(line)));
  const legacy = recordedOperations({ ...actor, battery: 50, jamming: true }, { resources: [] });
  assert.ok(legacy.includes('Battery 50%')); assert.ok(legacy.includes('Jammer on')); assert.ok(!legacy.some(line => line.includes('CARGO')));
});

test('radio display distinguishes stored and input stages from actual replies and excludes red player chat', () => {
  assert.equal(radioDeliveryPresentation(radio), 'Delivery status unavailable');
  const stored = radioDeliveryPresentation({ ...radio, delivery: { storedBy: ['drone-2'], bundledBy: [] } });
  assert.match(stored, /Stored:/); assert.ok(!stored.includes('reply')); assert.ok(!stored.includes('complete'));
  const bundled = radioDeliveryPresentation({ ...radio, delivery: { storedBy: ['drone-2'], bundledBy: ['drone-2'], answeredBy: ['drone-2'] } });
  assert.match(bundled, /In input:/); assert.match(bundled, /Actual reply:/);
  assert.deepEqual(visibleRadioMessages([radio, { ...radio, id: 'red', from: 'drone-4' }, { ...radio, id: 'private', to: 'drone-2' }, { ...radio, id: 'blue-all', to: 'all' }], 'operator', 'team').map(message => message.id), ['m1', 'blue-all']);
});

test('replay hides residual jammer fields in cargo rules and preserves historical on/off state', () => {
  for (const jamming of [false, true]) {
    const drone = { ...actor, jamming };
    for (const rulesVersion of ['cargo-v1', 'cargo-v2', 'cargo-v3'] as const) {
      assert.ok(!recordedOperations(drone, { resources: [], rulesVersion }).some(line => line.startsWith('Jammer')));
      assert.ok(!recordedOperations(drone, { resources: [] }, rulesVersion).some(line => line.startsWith('Jammer')));
    }
    const label = `Jammer ${jamming ? 'on' : 'off'}`;
    assert.ok(recordedOperations(drone).includes(label));
    assert.ok(recordedOperations(drone, { resources: [], rulesVersion: 'cube-v1' }).includes(label));
    assert.ok(recordedOperations(drone, { resources: [], rulesVersion: 'cargo-v3' }, 'cube-v1').includes(label));
    assert.ok(!recordedOperations(drone, { resources: [], rulesVersion: 'cube-v1' }, 'cargo-v3').includes(label));
  }
  assert.ok(!recordedOperations(actor).some(line => line.startsWith('Jammer')));
});
