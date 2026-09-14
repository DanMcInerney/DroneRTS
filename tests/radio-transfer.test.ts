import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_FLEET, type DroneId } from '../shared/fleet.ts';
import { FleetNetwork } from '../server/network.ts';
import { RadioTransfers } from '../server/radio-transfer.ts';
import { OnboardWorkspace, ONBOARD_LIMITS, onboardHash } from '../server/onboard-workspace.ts';

async function eventually(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (predicate()) return; await delay(30); }
  assert.fail(`Timed out: ${label}`);
}

test('native chunk transfers stay inert, hash verify, preserve Unicode and require recipient import choice', { timeout: 45_000 }, async t => {
  const sessionId = randomUUID(), projectDir = resolve(import.meta.dirname, '..');
  const workspaces = new Map(DEFAULT_FLEET.map(({ id }) => [id, new OnboardWorkspace()]));
  const failures: string[] = [], events: any[] = [];
  let transfers!: RadioTransfers;
  const network = new FleetNetwork({ projectDir, sessionId, roster: DEFAULT_FLEET, playerChat: true,
    onReceive: () => assert.fail('Internal source chunks reached the actor inbox'),
    onTransferReceive: (id, message) => transfers.receive(id, message),
    onState: () => {}, onEvent: event => events.push(event), onFailure: error => failures.push(error) });
  transfers = new RadioTransfers({ sessionId, roster: DEFAULT_FLEET, workspace: id => workspaces.get(id)!, active: () => true,
    mission: () => 1, simTime: () => 1, send: (message, ttlMs) => network.send(message, { ttlMs }), consume: (id, ids) => network.consume(id, ids) });
  t.after(async () => { transfers.stop(); await network.stop(); await rm(resolve(projectDir, 'artifacts/network', sessionId), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await network.start();
  await eventually(() => network.state.peers.every(peer => peer.online && peer.peers === 3), 'four native blue peers connected');
  const source = 'export const neutralNote = ' + JSON.stringify('🚀'.repeat(5000) + '🛰️ café 漢字\n'.repeat(500)) + ';';
  workspaces.get('drone-1')!.write('neutral.js', source);
  workspaces.get('drone-2')!.write('neutral.js', 'Existing private file must survive reception.');
  await network.link('drone-2', false);
  const offer: any = await transfers.tool('drone-1', { operation: 'offer', to: 'drone-2', path: 'neutral.js' });
  assert.ok(offer.bytes > 4096);
  await delay(150);
  assert.deepEqual((await transfers.tool('drone-2', { operation: 'list' }) as any).transfers, []);
  await network.link('drone-2', true);
  let incoming: any;
  await eventually(() => { incoming = (transfers as any).records.get('drone-2')?.get(offer.id); return incoming?.state === 'complete'; }, 'recipient verifies actual native chunks');
  await eventually(() => (transfers as any).records.get('drone-1')?.get(offer.id)?.state === 'complete', 'native completion receipt returns to sender');
  assert.equal(workspaces.get('drone-2')!.read('neutral.js'), 'Existing private file must survive reception.');
  assert.equal(workspaces.get('drone-3')!.list().length, 0);
  assert.equal(incoming.content, undefined, 'only charged inert workspace staging stores incoming code');
  await assert.rejects(transfers.tool('drone-2', { operation: 'import', transferId: offer.id }), /chosen private workspace/);
  const imported: any = await transfers.tool('drone-2', { operation: 'import', transferId: offer.id, path: 'chosen/neutral.js' });
  assert.equal(imported.executed, false); assert.equal(imported.file.sha256, offer.sha256);
  assert.equal(workspaces.get('drone-2')!.read('chosen/neutral.js'), source);
  assert.equal(workspaces.get('drone-2')!.status().staging.usedBytes, ONBOARD_LIMITS.networkTransaction + 1024, 'bounded import tombstone prevents late chunks recreating staging');
  const traffic = events.filter(event => event.event === 'payload' && event.payload?.message?.kind === 'transfer');
  assert.ok(traffic.length > 0); assert.ok(traffic.every(event => event.bytes <= 12288));
  assert.deepEqual(failures, []);
});

test('transfer admission accounts for source peak and cancelling releases only its own staging', async () => {
  const workspaces = new Map(DEFAULT_FLEET.map(({ id }) => [id, new OnboardWorkspace()]));
  const queued: any[] = [];
  const transfer = new RadioTransfers({ sessionId: randomUUID(), roster: DEFAULT_FLEET, workspace: id => workspaces.get(id)!, active: () => true,
    mission: () => 1, simTime: () => 1, send: async message => { queued.push(message); }, consume: () => {} });
  try {
    const source = workspaces.get('drone-1')!; source.write('note.md', 'x'.repeat(65536));
    source.reserveStaging('unrelated', 700 * 1024);
    await assert.rejects(transfer.tool('drone-1', { operation: 'offer', to: 'drone-2', path: 'note.md' }), /Staging partition full/);
    assert.equal(queued.length, 0); source.releaseStaging('unrelated');
    const offer: any = await transfer.tool('drone-1', { operation: 'offer', to: 'drone-2', path: 'note.md' });
    await transfer.tool('drone-1', { operation: 'cancel', transferId: offer.id });
    await delay(0);
    assert.equal(source.status().staging.usedBytes, ONBOARD_LIMITS.networkTransaction + 1024);
    assert.equal(source.read('note.md').length, 65536);
    await assert.rejects(transfer.tool('drone-1', { operation: 'offer', to: 'drone-4', path: 'note.md' }), /another teammate/);
  } finally { transfer.stop(); }
});

test('malformed or incomplete incoming source never becomes imported executable content', async () => {
  const workspaces = new Map(DEFAULT_FLEET.map(({ id }) => [id, new OnboardWorkspace()]));
  const consumed: string[] = [], errors: any[] = [];
  const sessionId = randomUUID();
  const transfer = new RadioTransfers({ sessionId, roster: DEFAULT_FLEET, workspace: id => workspaces.get(id)!, active: () => true,
    mission: () => 1, simTime: () => 1, send: async () => {}, consume: (_id, ids) => consumed.push(...ids), onEvent: event => errors.push(event) });
  try {
    const id = randomUUID();
    transfer.receive('drone-2', { protocol: 'fleet-radio/1', sessionId, id: 'bad-chunk', sequence: 1, from: 'drone-1', to: 'drone-2', kind: 'transfer', text: 'Transfer', sentAt: new Date().toISOString(), mission: 1, simTime: 1,
      data: { operation: 'chunk', transferId: id, path: 'untrusted.js', bytes: 3, sha256: '0'.repeat(64), deadlineMs: performance.now() + 10_000, index: 0, content: 'bad' } });
    assert.deepEqual(consumed, ['bad-chunk']); assert.equal(workspaces.get('drone-2')!.list().length, 0);
    await assert.rejects(transfer.tool('drone-2', { operation: 'import', transferId: id, path: 'chosen.js' }), /complete verified/);
    assert.equal(workspaces.get('drone-2')!.status().staging.usedBytes, ONBOARD_LIMITS.networkTransaction + 1024);
    assert.ok(errors.some(event => event.event === 'transfer-rejected'));
  } finally { transfer.stop(); }
});

test('cancelled transfers retain source and RPC accounting until slow submissions settle', async () => {
  const workspaces = new Map(DEFAULT_FLEET.map(({ id }) => [id, new OnboardWorkspace()]));
  const pending: Array<() => void> = [];
  const transfer = new RadioTransfers({ sessionId: randomUUID(), roster: DEFAULT_FLEET, workspace: id => workspaces.get(id)!, active: () => true,
    mission: () => 1, simTime: () => 1, send: () => new Promise<void>(done => pending.push(done)), consume: () => {} });
  try {
    const source = workspaces.get('drone-1')!; source.write('large.js', 'x'.repeat(65536));
    let admitted = 0;
    for (let index = 0; index < 40; index++) {
      try {
        const offer: any = await transfer.tool('drone-1', { operation: 'offer', to: 'drone-2', path: 'large.js' });
        admitted++; await transfer.tool('drone-1', { operation: 'cancel', transferId: offer.id });
      } catch (error) { assert.match(String(error), /[Ss]taging.*full/); break; }
    }
    assert.ok(admitted > 0 && admitted < 4, 'bounded staging rejects further retained source copies');
    assert.ok(source.status().staging.usedBytes >= ONBOARD_LIMITS.networkTransaction + admitted * 3 * 65536);
    assert.ok(pending.length <= admitted * 2);
    pending.forEach(done => done()); await delay(0);
    assert.equal(source.status().staging.usedBytes, ONBOARD_LIMITS.networkTransaction + admitted * 1024);
  } finally { transfer.stop(); pending.forEach(done => done()); }
});

test('cancel arriving before reordered chunks retains a bounded tombstone and cannot recreate staging', async () => {
  const workspaces = new Map(DEFAULT_FLEET.map(({ id }) => [id, new OnboardWorkspace()]));
  const sessionId = randomUUID(), transferId = randomUUID();
  const transfer = new RadioTransfers({ sessionId, roster: DEFAULT_FLEET, workspace: id => workspaces.get(id)!, active: () => true,
    mission: () => 1, simTime: () => 1, send: async () => {}, consume: () => {} });
  try {
    const announcement = { transferId, path: 'neutral.js', bytes: 3, sha256: onboardHash('abc'), deadlineMs: performance.now() + 10_000 };
    const base = { protocol: 'fleet-radio/1' as const, sessionId, sequence: 1, from: 'drone-1', to: 'drone-2', kind: 'transfer', text: 'Transfer', sentAt: new Date().toISOString(), mission: 1, simTime: 1 };
    transfer.receive('drone-2', { ...base, id: 'cancel-first', data: { ...announcement, operation: 'cancel' } });
    transfer.receive('drone-2', { ...base, id: 'chunk-after-cancel', data: { ...announcement, operation: 'chunk', index: 0, content: 'abc' } });
    assert.equal(workspaces.get('drone-2')!.list().length, 0);
    assert.throws(() => workspaces.get('drone-2')!.getTransfer(transferId), /does not exist/);
    assert.equal(workspaces.get('drone-2')!.status().staging.usedBytes, ONBOARD_LIMITS.networkTransaction + 1024);
    const status: any = await transfer.tool('drone-2', { operation: 'status', transferId });
    assert.equal(status.state, 'cancelled');
  } finally { transfer.stop(); }
});
