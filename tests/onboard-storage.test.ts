import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ONBOARD_LIMITS, OnboardWorkspace, onboardHash } from '../server/onboard-workspace.ts';
import { deployOnboardRuntime, measureOnboardManifest } from '../server/onboard-manifest.ts';

test('workspace counts UTF-8, metadata, per-file limits and rejects traversal atomically', () => {
  const workspace = new OnboardWorkspace();
  const stat = workspace.write('notes.md', 'é🙂');
  assert.equal(stat.bytes, 6); assert.ok(stat.metadataBytes > 64);
  assert.equal(workspace.status().workspace.usedBytes, stat.bytes + stat.metadataBytes);
  assert.throws(() => workspace.write('notes.md', '🙂'.repeat(16385)), /65536/);
  assert.equal(workspace.read('notes.md'), 'é🙂');
  for (const path of ['../outside.md', '/absolute.js', 'a/../../escape.js', 'C:/host.js', 'x\\y.js', 'https://host.js', 'a//b.js']) assert.throws(() => workspace.write(path, 'x'), /relative workspace/);
  workspace.write('max.json', 'x'.repeat(65536));
  assert.equal(workspace.stat('max.json').bytes, 65536);
});

test('many tiny files, total allocation and staging peak reject without replacing old content', () => {
  const tiny = new OnboardWorkspace();
  for (let index = 0; index < 256; index++) tiny.write(`${index}.md`, '');
  assert.throws(() => tiny.write('overflow.md', ''), /256 files/);
  const workspace = new OnboardWorkspace(); workspace.write('keep.md', 'old');
  workspace.reserveStaging('external', ONBOARD_LIMITS.staging - ONBOARD_LIMITS.networkTransaction);
  assert.throws(() => workspace.write('keep.md', 'new'), /Staging partition full/);
  assert.equal(workspace.read('keep.md'), 'old'); workspace.releaseStaging('external');
  for (let index = 0; index < 31; index++) workspace.write(`${index}.md`, 'x'.repeat(65536));
  assert.throws(() => workspace.write('overflow.md', 'x'.repeat(65536)), /Workspace partition full/);
  assert.ok(workspace.status().workspace.usedBytes <= ONBOARD_LIMITS.workspace);
});

test('running snapshot retains immutable deleted/replaced source and releases charges exactly once', () => {
  const workspace = new OnboardWorkspace();
  workspace.write('entry.js', 'export const value = 1;'); const first = workspace.stat('entry.js');
  const snapshot = workspace.pin('entry.js');
  workspace.write('entry.js', 'export const value = 2;');
  assert.equal(snapshot.files['entry.js'].source, 'export const value = 1;');
  assert.equal(workspace.status().retainedVersions, 1);
  const before = workspace.status().workspace.usedBytes;
  snapshot.release(); snapshot.release();
  assert.equal(before - workspace.status().workspace.usedBytes, first.bytes + first.metadataBytes);
  assert.equal(workspace.status().retainedVersions, 0);
});

test('transfers remain inert, duplicate chunks are idempotent and explicit imports choose their path', () => {
  const workspace = new OnboardWorkspace({ now: () => 100 });
  const source = 'export const x = 7;';
  workspace.beginTransfer({ id: 'a', path: 'sender.js', size: Buffer.byteLength(source), sha256: onboardHash(source), expiresAt: 1000 });
  workspace.transferChunk('a', 0, source); workspace.transferChunk('a', 0, source);
  assert.equal(workspace.list().length, 0);
  assert.throws(() => workspace.importTransfer('a', 'chosen.js'), /Verify all chunks/);
  workspace.completeTransfer('a'); workspace.importTransfer('a', 'chosen.js');
  assert.equal(workspace.read('chosen.js'), source); assert.throws(() => workspace.stat('sender.js'));
  assert.equal(workspace.status().staging.usedBytes, ONBOARD_LIMITS.networkTransaction);
});

test('bad hashes, partial chunks, expired transfers and failed imports preserve workspace and staging', () => {
  let now = 100;
  const workspace = new OnboardWorkspace({ now: () => now });
  workspace.write('keep.md', 'keep');
  workspace.beginTransfer({ id: 'bad', path: 'keep.md', size: 3, sha256: onboardHash('abc'), expiresAt: 1000 });
  workspace.transferChunk('bad', 0, 'bad'); assert.throws(() => workspace.completeTransfer('bad'), /SHA-256/);
  workspace.beginTransfer({ id: 'missing', path: 'keep.md', size: 3, sha256: onboardHash('abc'), expiresAt: 1000 });
  workspace.transferChunk('missing', 1, 'abc'); assert.throws(() => workspace.completeTransfer('missing'), /missing chunks/);
  assert.equal(workspace.read('keep.md'), 'keep'); now = 1001;
  assert.equal(workspace.status().staging.usedBytes, ONBOARD_LIMITS.networkTransaction);
  assert.throws(() => workspace.getTransfer('bad'), /expired/);
});

test('revoke and new-match reset erase access without sharing another drone files', () => {
  const first = new OnboardWorkspace(), second = new OnboardWorkspace();
  first.write('private.md', 'first'); assert.throws(() => second.read('private.md'));
  first.revoke(); assert.throws(() => first.read('private.md'), /revoked/);
  first.reset(); assert.deepEqual(first.list(), []); assert.equal(first.status().workspace.usedBytes, 0);
});

test('diagnostics rotate within their half of the log/event partition without evicting unread events', () => {
  let events = ONBOARD_LIMITS.localEvents;
  const workspace = new OnboardWorkspace({ eventBytes: () => events });
  for (let index = 0; index < 1000; index++) workspace.appendLog({ index, text: 'x'.repeat(4000) });
  const total = workspace.status().logs.usedBytes;
  assert.ok(total <= ONBOARD_LIMITS.logs); assert.ok(total > ONBOARD_LIMITS.localEvents);
  events = 0; assert.ok(workspace.status().logs.usedBytes <= ONBOARD_LIMITS.diagnosticLogs);
});

test('actual Windows deployment includes measured pinned runtime transitives, notices and SDK inside 8 MiB', () => {
  const manifest = measureOnboardManifest();
  assert.equal(manifest.fits, true); assert.ok(manifest.installedBytes > 1_000_000); assert.ok(manifest.installedBytes < ONBOARD_LIMITS.runtime);
  for (const pkg of ['quickjs-emscripten-core', '@jitl/quickjs-ffi-types', '@jitl/quickjs-wasmfile-release-sync']) {
    assert.ok(manifest.artifacts.some(item => item.package === pkg && item.path.endsWith('/LICENSE') && item.version === '0.32.0' && item.license === 'MIT'));
  }
  assert.ok(manifest.artifacts.some(item => item.package === 'nervelet' && item.path.endsWith('/LICENSE') && item.version === '0.2.0' && item.license === 'MIT'));
  const worker = deployOnboardRuntime(); assert.ok(existsSync(worker));
  const deployment = resolve(dirname(worker), '..');
  const deployed = JSON.parse(readFileSync(resolve(deployment, 'manifest.json'), 'utf8'));
  for (const item of deployed.artifacts) { const bytes = readFileSync(resolve(deployment, item.path)); assert.equal(bytes.length, item.bytes); assert.equal(onboardHash(bytes), item.sha256); }
  assert.equal(Buffer.byteLength(JSON.stringify(deployed, null, 2) + '\n'), deployed.manifestBytes);
});
