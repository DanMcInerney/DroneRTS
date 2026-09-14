import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { DiagnosticsStore, diagnosticsRouter, redactDiagnostic } from '../server/diagnostics.ts';
import { FleetGame } from '../server/game.ts';
import { validateRoster } from '../shared/fleet.ts';

const id = 'session-2026-09-14T10-00-00-000Z.jsonl';
const record = (type: string, value: unknown) => JSON.stringify({ wallTime: '2026-09-14T10:00:00Z', type, value }) + '\n';
async function fixture(t: import('node:test').TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, id), store: new DiagnosticsStore(directory) };
}

test('diagnostics redact credentials, nested JSON camera payloads and runtime secrets', () => {
  const clean = redactDiagnostic({ apiKey: 'secret-value', access_token: 'secret-value', cookie: 'secret-value', nested: { type: 'image', data: 'camera-base64' }, content: [{ type: 'text', text: JSON.stringify({ authorization: 'secret-value', camera: 'data:image/png;base64,YWJj' }) }], text: 'Bearer secret-value /mcp/012345678901234567890123456789012345 sk-testingabcdefghijklmnop', encrypted_content: 'private-reasoning', summary: ['Recorded summary'] });
  const text = JSON.stringify(clean);
  assert.ok(!text.includes('secret-value')); assert.ok(!text.includes('camera-base64')); assert.ok(!text.includes('YWJj')); assert.ok(!text.includes('private-reasoning'));
  assert.ok(text.includes('Recorded summary')); assert.ok(text.includes('[redacted]'));
});

test('sessions are limited to owned JSONL files and reject traversal or symlinks', async t => {
  const { directory, path, store } = await fixture(t);
  await writeFile(path, record('runtime', { status: 'stopped' }));
  await writeFile(join(directory, 'auth.json'), 'private');
  assert.deepEqual((await store.list()).map(session => session.id), [id]);
  for (const name of ['../auth.json', 'auth.json', '..\\auth.json', '/absolute/path', 'session-file.jsonl/../auth.json']) await assert.rejects(store.page(name), /valid session/);
  await assert.rejects(store.page('session-missing.jsonl'), /unavailable/);
  try {
    await symlink(path, join(directory, 'session-link.jsonl'));
    await assert.rejects(store.page('session-link.jsonl'), /unavailable/);
    assert.equal((await store.list()).some(session => session.id === 'session-link.jsonl'), false);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }
});

test('byte cursors preserve Unicode, paginate without duplicates, and wait for partial records', async t => {
  const { path, store } = await fixture(t);
  const first = record('radio', { from: 'drone-1', text: 'Heading north → café' });
  const second = record('tool', { role: 'drone-2', name: 'act' });
  const partial = record('runtime', { status: 'stopped' });
  await writeFile(path, first + second + partial.slice(0, -3));
  const page = await store.page(id, { after: 0, limit: 1 });
  assert.equal(page.events.length, 1); assert.equal(page.next, Buffer.byteLength(first));
  const next = await store.page(id, { after: page.next });
  assert.equal(next.events.length, 1); assert.equal(next.events[0].offset, page.next);
  const waiting = await store.page(id, { after: next.next });
  assert.equal(waiting.events.length, 0); assert.equal(waiting.next, next.next);
  await appendFile(path, partial.slice(-3));
  assert.equal((await store.page(id, { after: waiting.next })).events[0].type, 'runtime');
  const latest = await store.page(id, { limit: 1 });
  assert.equal(latest.events[0].type, 'runtime');
  const older = await store.page(id, { before: latest.before, limit: 1 });
  assert.equal(older.events[0].type, 'tool');
});

test('category, actor and text filters use redacted evidence and validate bounds', async t => {
  const { path, store } = await fixture(t);
  await writeFile(path, record('network', { drone: 'drone-1', event: 'payload', payload: { text: 'found chest', to: 'drone-2' } }) + record('agent', { type: 'recorded-reasoning-summary', role: 'drone-2', summary: ['Scan the street'] }) + record('tool-error', { role: 'drone-1', message: 'Rejected old mission', password: 'do-not-search-this' }));
  assert.equal((await store.page(id, { category: 'network', role: 'drone-2', query: 'chest' })).events.length, 1);
  assert.equal((await store.page(id, { category: 'agents', role: 'drone-2', query: 'street' })).events.length, 1);
  assert.equal((await store.page(id, { category: 'errors' })).events.length, 1);
  assert.equal((await store.page(id, { query: 'do-not-search-this' })).events.length, 0);
  for (const options of [{ limit: 201 }, { limit: 0 }, { after: -1 }, { after: 1.5 }, { after: 0, before: 1 }, { category: 'unknown' }, { role: 'invalid' }, { query: 'a'.repeat(201) }]) await assert.rejects(store.page(id, options));
  await assert.rejects(store.page(id, { after: 9999999 }), /Log changed/);
});

test('diagnostics actor filtering uses its configured roster', async t => {
  const { directory, path } = await fixture(t);
  const roster = validateRoster([{ id: 'drone-17', label: 'Scout', color: '#aaccee', systemId: 42 }]);
  const store = new DiagnosticsStore(directory, roster);
  await writeFile(path, record('tool', { role: 'drone-17', name: 'observe' }));
  assert.equal((await store.page(id, { role: 'drone-17' })).events.length, 1);
  await assert.rejects(store.page(id, { role: 'drone-1' }), /filters/);
});

test('bounded scans skip giant records, report malformed JSON, and preserve the newest event', async t => {
  const { path, store } = await fixture(t);
  await writeFile(path, record('runtime', { text: 'a'.repeat(800_000) }) + 'not-json\n' + record('runtime', { status: 'finished' }));
  const first = await store.page(id, { after: 0 });
  assert.ok(first.scannedBytes <= 512 * 1024 + 1); assert.equal(first.events.length, 0); assert.ok(first.next > 0);
  const next = await store.page(id, { after: first.next });
  assert.equal(next.events[0].type, 'invalid-record'); assert.equal(next.events.at(-1)?.title, 'runtime · finished');
  const tail = await store.page(id, { limit: 1 });
  assert.equal(tail.events[0].title, 'runtime · finished'); assert.ok(tail.hasOlder);
});

test('HTTP diagnostics expose bounded sanitized logs and export without connecting a camera', async t => {
  const { directory, path } = await fixture(t);
  await writeFile(path, record('agent', { type: 'actor-message', text: 'Visible log', token: 'private-token' }) + record('mavlink', { event: 'packet', hex: 'fd1234' }));
  const game = new FleetGame(), app = express();
  app.use('/api/diagnostics', diagnosticsRouter({ directory, state: () => game.state, activeSession: () => id }));
  const server = app.listen(0, '127.0.0.1'); t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/diagnostics`;
  const status = await (await fetch(`${base}/status`)).json();
  assert.equal(status.activeSession, id); assert.equal(status.running, false); assert.equal(status.treasures, undefined); assert.equal(status.obstacles, undefined);
  assert.equal((await fetch(`${base}/sessions/${id}/events?limit=99999`)).status, 400);
  assert.equal((await fetch(`${base}/sessions/${id}/events?q=first&q=second`)).status, 400);
  assert.equal((await fetch(`${base}/sessions/${id}/events?after=NaN`)).status, 400);
  const response = await fetch(`${base}/sessions/${id}/download`), exported = await response.text();
  assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition')!, /attachment/);
  assert.equal(exported.trim().split('\n').length, 2); assert.ok(!exported.includes('private-token')); assert.ok(exported.includes('fd1234'));
  assert.equal(game.state.running, false); assert.equal(game.state.drones.some(drone => drone.online), false);
});

test('filtered backward paging retains a valid record crossing the scan boundary', async t => {
  const { path, store } = await fixture(t);
  const sized = (type: string, bytes: number) => {
    const base = record(type, { text: '' });
    return record(type, { text: 'x'.repeat(bytes - Buffer.byteLength(base)) });
  };
  const suffix = sized('network', 1000).repeat(524) + sized('network', 188);
  await writeFile(path, sized('network', 1000) + sized('agent', 500) + suffix);
  const latest = await store.page(id, { category: 'agents' });
  assert.equal(latest.events.length, 0); assert.equal(latest.hasOlder, true);
  const older = await store.page(id, { category: 'agents', before: latest.before });
  assert.equal(older.events.length, 1); assert.equal(older.events[0].offset, 1000);
  assert.equal(older.events[0].type, 'agent');
  // Still terminate if no newline exists anywhere in the current large block.
  await writeFile(path, sized('network', 1000) + sized('network', 800_000));
  const giantTail = await store.page(id, { category: 'agents' });
  const giantOlder = await store.page(id, { category: 'agents', before: giantTail.before });
  assert.ok(giantOlder.before < giantTail.before);
});
