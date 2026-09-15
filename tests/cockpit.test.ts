import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CockpitStore, cockpitRouter, COCKPIT_LIMITS } from '../server/cockpit.ts';
import { FleetMcpServer } from '../server/runtime-mcp.ts';
import { CodexFleetRuntime } from '../server/runtime.ts';
import { FleetGame } from '../server/game.ts';
import { compactObservation } from '../server/observation-format.ts';
import { OnboardWorkspace, onboardHash } from '../server/onboard-workspace.ts';
import type { ToolResult } from '../shared/types.ts';

const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
function delivery(events: unknown[] = [], image = true): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ protocol: 'fleet-observation/1', sessionId: 'session-one', mission: 7,
    deliveredAt: '2026-09-14T12:00:01Z', deliverySimTime: 12, cursor: events.length, events,
    sensors: { position: { frame: 'local', x: 3, y: 4, z: 5 }, heading: { degrees: 90 }, timestamp: { capturedAt: '2026-09-14T12:00:00Z', simTime: 11 }, camera: { available: image } } }) },
    ...(image ? [{ type: 'image' as const, mimeType: 'image/png', data: imageData }] : [])] };
}
function fixture() { const store = new CockpitStore(); store.reset('session-one'); return store; }

test('cockpit retains the complete final delivered sensor/unread bundle and exact image without draining mail', () => {
  const store = fixture();
  const unread = Array.from({ length: 400 }, (_, cursor) => ({ type: cursor % 2 ? 'player' : 'radio', cursor: cursor + 1, text: `message ${cursor}` }));
  const result = delivery(unread);
  result.content.push({ type: 'text', text: JSON.stringify({ controller: { type: 'tool_catalog_changed' } }) });
  store.recordTool('session-one', { type: 'call', role: 'drone-1', name: 'wait', arguments: { after: 0 } });
  store.recordTool('session-one', { type: 'delivery', role: 'drone-1', name: 'wait', result });
  const snapshot = store.snapshot('drone-1', { session: 'session-one', running: true, tools: ['observe', 'wait'] });
  assert.equal(snapshot.reset, false);
  assert.deepEqual(snapshot.lastDelivery!.bundle, JSON.parse((result.content[0] as { text: string }).text));
  assert.deepEqual(snapshot.lastDelivery!.bundle!.events, unread);
  assert.deepEqual(snapshot.lastDelivery!.result.content[0], result.content[0]);
  assert.deepEqual(snapshot.lastDelivery!.result.content[2], result.content[2]);
  assert.deepEqual(snapshot.lastDelivery!.omissions, []);
  assert.equal(snapshot.lastImage!.capturedAt, '2026-09-14T12:00:00Z');
  assert.deepEqual(store.image('drone-1', 'session-one', snapshot.lastImage!.sequence)!.bytes, Buffer.from(imageData, 'base64'));
  assert.ok(!JSON.stringify(snapshot).includes(imageData));
  assert.equal(snapshot.workspace.available, false); assert.deepEqual(snapshot.workspace.entries, []);
  assert.equal(snapshot.workspace.compute.shell, false); assert.equal(snapshot.workspace.compute.filesystem, true);
  assert.equal(snapshot.workspace.compute.hostFilesystem, false); assert.equal(snapshot.workspace.compute.codeExecution, true);
  assert.equal(snapshot.workspace.compute.executionEngine, 'QuickJS'); assert.deepEqual(snapshot.workspace.optionalGuestLibraries, []);
  assert.deepEqual(snapshot.workspace.tools, ['observe', 'wait']);
  assert.ok(snapshot.workspace.libraries.some(library => /zenoh/.test(library.name) && library.access === 'host only'));
  // Snapshots and source objects do not provide mutable access to retained evidence.
  (snapshot.lastDelivery!.bundle!.events as unknown[]).pop(); result.content.length = 0;
  assert.equal((store.snapshot('drone-1').lastDelivery!.bundle!.events as unknown[]).length, 400);
});

test('error deliveries replace the latest batch while retaining a clearly older last actual image', () => {
  const store = fixture();
  store.recordTool('session-one', { type: 'delivery', role: 'drone-1', name: 'observe', result: delivery([{ type: 'player', text: 'first' }]) });
  const originalImage = store.snapshot('drone-1').lastImage;
  const failed = delivery([], false); failed.isError = true;
  failed.content.unshift({ type: 'text', text: '{"error":"Tool unavailable"}' });
  store.recordTool('session-one', { type: 'delivery', role: 'drone-1', name: 'buy', result: failed });
  const snapshot = store.snapshot('drone-1');
  assert.equal(snapshot.lastDelivery!.isError, true); assert.equal(snapshot.lastDelivery!.tool, 'buy');
  assert.deepEqual(snapshot.lastDelivery!.bundle!.events, []);
  assert.deepEqual(snapshot.lastImage, originalImage);
  assert.notEqual(snapshot.lastImage!.deliverySequence, snapshot.lastDelivery!.sequence);
  store.recordTool('session-one', { type: 'delivery', role: 'drone-1', name: 'observe', result: { isError: true, content: [{ type: 'text', text: '{"error":"Sensor transport failed"}' }] } });
  assert.equal(store.snapshot('drone-1').lastDelivery!.bundle, null);
});

test('sessions and drone identities isolate all evidence and reset invalid cursors', () => {
  const store = fixture();
  store.recordTool('session-one', { type: 'delivery', role: 'drone-1', name: 'observe', result: delivery() });
  assert.equal(store.snapshot('drone-2').lastDelivery, null);
  assert.equal(store.snapshot('drone-1', { session: 'session-one', after: 99 }).reset, true);
  store.reset('session-two');
  store.recordTool('session-one', { type: 'delivery', role: 'drone-1', name: 'observe', result: delivery() });
  store.recordTool('session-two', { type: 'call', role: 'parent', name: 'relay', arguments: {} });
  store.recordRuntime('session-one', { type: 'actor-message', role: 'drone-1', text: 'old actor' });
  const snapshot = store.snapshot('drone-1', { session: 'session-one', after: 1 });
  assert.equal(snapshot.sessionId, 'session-two'); assert.equal(snapshot.reset, true); assert.equal(snapshot.cursor, 0);
  assert.equal(snapshot.lastDelivery, null); assert.equal(snapshot.lastImage, null); assert.equal(snapshot.events.length, 0);
  assert.equal(store.image('drone-1', 'session-one', 1), null);
  store.reset(null); assert.equal(store.snapshot('drone-1').sessionId, null);
});

test('two bounded image slots tolerate an in-flight snapshot URL while exposing only the latest image', () => {
  const store = fixture();
  for (let i = 0; i < 2; i++) store.recordTool('session-one', { type: 'delivery', role: 'drone-1', name: 'observe', result: delivery() });
  assert.equal(store.snapshot('drone-1').lastImage!.sequence, 2);
  assert.ok(store.image('drone-1', 'session-one', 1));
  store.recordTool('session-one', { type: 'delivery', role: 'drone-1', name: 'observe', result: delivery() });
  assert.equal(store.image('drone-1', 'session-one', 1), null);
  assert.ok(store.image('drone-1', 'session-one', 2));
  assert.ok(store.image('drone-1', 'session-one', 3));
});

test('credentials are redacted with explicit notices, and over-budget evidence is explicitly omitted', () => {
  const store = fixture();
  const result = delivery([{ type: 'radio', message: { text: 'Bearer abc-secret', data: { apiKey: 'secret-key', nested: '{"password":"secret-password"}' } } }]);
  store.recordTool('session-one', { type: 'delivery', role: 'drone-1', name: 'observe', result });
  const snapshot = store.snapshot('drone-1');
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes('abc-secret')); assert.ok(!serialized.includes('secret-key')); assert.ok(!serialized.includes('secret-password'));
  assert.match(serialized, /redacted/); assert.ok(snapshot.lastDelivery!.omissions.length > 0);
  store.recordTool('session-one', { type: 'delivery', role: 'drone-1', name: 'wait', result: { content: [{ type: 'text', text: 'x'.repeat(COCKPIT_LIMITS.deliveryBytes + 1) }] } });
  assert.equal(store.snapshot('drone-1').lastDelivery!.bundle, null);
  assert.match(store.snapshot('drone-1').lastDelivery!.omissions.join(' '), /size limit/);
});

test('runtime output is bounded, cumulative per item, and distinguishes readable reasoning from opaque payloads', () => {
  const store = fixture();
  const runtime = new CodexFleetRuntime({ projectDir: process.cwd(), onStatus: () => {}, onEvent: event => store.recordRuntime('session-one', event), toolHandler: async () => ({ content: [] }) });
  const internal = runtime as any;
  internal.roles.set('thread-one', 'drone-1');
  internal.onMessage({ method: 'item/agentMessage/delta', params: { threadId: 'thread-one', itemId: 'message', delta: 'Moving ' } });
  internal.onMessage({ method: 'item/agentMessage/delta', params: { threadId: 'thread-one', itemId: 'message', delta: 'now.' } });
  internal.onMessage({ method: 'item/reasoning/textDelta', params: { threadId: 'thread-one', itemId: 'summary', delta: 'Readable native ' } });
  internal.onMessage({ method: 'item/reasoning/textDelta', params: { threadId: 'thread-one', itemId: 'summary', delta: 'reasoning.' } });
  internal.onMessage({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thread-one', itemId: 'summary', delta: 'Checking view.' } });
  internal.onMessage({ method: 'item/completed', params: { threadId: 'thread-one', item: { type: 'reasoning', id: 'summary', summary: ['Checking view.'], content: ['Readable native reasoning.'], encryptedContent: 'opaque ciphertext' } } });
  const first = store.snapshot('drone-1', { session: 'session-one' });
  assert.equal(first.events[1].text, 'Moving now.'); assert.equal(first.events[1].delta, false);
  assert.ok(!JSON.stringify(first).includes('ciphertext'));
  assert.equal(first.events.filter(event => event.kind === 'reasoning').at(-1)!.text, 'Readable native reasoning.');
  assert.equal(first.events.filter(event => event.kind === 'reasoning').at(-1)!.streaming, false);
  assert.equal(first.events.filter(event => event.kind === 'reasoning' && event.streaming).at(-1)!.text, 'Readable native reasoning.');
  assert.equal(first.events.at(-1)!.kind, 'reasoning-status');
  assert.deepEqual(first.events.at(-1)!.data, { availability: 'both', incomplete: false });
  assert.equal(store.snapshot('drone-1', { session: 'session-one', after: first.cursor }).events.length, 0);
  for (let i = 0; i < 400; i++) store.recordRuntime('session-one', { type: 'actor-message', role: 'drone-1', itemId: `m-${i}`, text: 'x'.repeat(1000) });
  const recent = store.snapshot('drone-1', { session: 'session-one', after: first.cursor });
  assert.ok(recent.events.length <= COCKPIT_LIMITS.events); assert.ok(Buffer.byteLength(JSON.stringify(recent.events)) <= COCKPIT_LIMITS.eventBytes + 300);
  assert.equal(recent.truncated, true);
});

test('the real MCP boundary records final unavailable-tool and thrown-error results', async () => {
  const store = fixture(); let throws = false;
  const server = new FleetMcpServer({ roles: ['drone-1'], active: () => true,
    tools: () => [{ name: 'observe', inputSchema: { type: 'object' } }],
    call: async () => { if (throws) throw new Error('Sensor failed'); return delivery([{ type: 'player', text: 'original mission' }]); },
    policy: () => ({}), onEvent: () => {}, onToolEvidence: event => store.recordTool('session-one', event),
  });
  const endpoint = await server.start(), client = new Client({ name: 'cockpit-boundary-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp/${endpoint.tokens['drone-1']}`)));
    const result = await client.callTool({ name: 'buy', arguments: { item: 'gun' } });
    const snapshot = store.snapshot('drone-1');
    assert.equal(snapshot.lastCall!.name, 'buy'); assert.deepEqual(snapshot.lastCall!.arguments, { item: 'gun' });
    assert.equal(snapshot.lastDelivery!.tool, 'buy'); assert.equal(snapshot.lastDelivery!.isError, true);
    assert.deepEqual(snapshot.lastDelivery!.result.content.filter(part => part.type === 'text'), (result.content as ToolResult['content']).filter(part => part.type === 'text'));
    assert.deepEqual(snapshot.lastDelivery!.bundle!.events, [{ type: 'player', text: 'original mission' }]);
    throws = true;
    const error = await client.callTool({ name: 'observe', arguments: {} });
    assert.equal(error.isError, true); assert.deepEqual(store.snapshot('drone-1').lastDelivery!.result.content, error.content);
    assert.equal(store.snapshot('drone-1').lastDelivery!.bundle, null);
  } finally { await client.close(); await server.stop(); }
});

test('the final MCP boundary preserves current compact sensor columns, freshness and complete unread slice exactly', async () => {
  const store = new CockpitStore(), game = new FleetGame(); game.setConnected(true); game.start();
  store.reset(game.sessionIdentity); game.capture = async () => `data:image/png;base64,${imageData}`;
  let returned: ToolResult | undefined;
  const server = new FleetMcpServer({ roles: ['drone-1'], active: () => true,
    tools: () => [{ name: 'observe', inputSchema: { type: 'object' } }],
    call: async () => { returned = compactObservation(await game.tool('drone-1', 'observe')); return returned; },
    policy: () => ({}), onEvent: () => {}, onToolEvidence: event => store.recordTool(game.sessionIdentity, event),
  });
  const endpoint = await server.start(), client = new Client({ name: 'compact-cockpit-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp/${endpoint.tokens['drone-1']}`)));
    const result = await client.callTool({ name: 'observe' });
    const wire = JSON.parse((result.content as ToolResult['content']).find(part => part.type === 'text')!.text);
    const snapshot = store.snapshot('drone-1', { session: game.sessionIdentity });
    assert.equal(wire.protocol, 'fleet-observation/5');
    assert.equal(wire.sensors.ranges.proximity.directions, 'xyz26');
    assert.deepEqual(wire.currentTelemetry.ranges.proximity, { sameAs: 'sensors.ranges.proximity' });
    assert.deepEqual(snapshot.lastDelivery!.bundle, wire);
    assert.deepEqual(snapshot.lastDelivery!.result.content.filter(part => part.type === 'text'), returned!.content.filter(part => part.type === 'text'));
    assert.equal(snapshot.lastImage!.capturedAt, wire.sensors.timestamp.capturedAt);
    assert.equal(game.inboxes['drone-1'].delivered, wire.cursor);
    store.snapshot('drone-1'); assert.equal(game.inboxes['drone-1'].delivered, wire.cursor);
  } finally { await client.close(); await server.stop(); game.stop(); }
});

test('workspace inspection does not expire transfers, alter files, or expose revoked source', () => {
  let now = 100;
  const board = new OnboardWorkspace({ runtimeBytes: 1, now: () => now });
  const entry = board.write('scripts/record.mjs', 'await drone.files.write("sample.txt", "sample");');
  board.beginTransfer({ id: 'pending', path: 'message.txt', size: 10, sha256: onboardHash('0123456789'), expiresAt: 200 });
  const before = board.inspect(); now = 300;
  assert.deepEqual(board.inspect(), before);
  assert.deepEqual(board.inspectFile(entry.path).entry, entry);
  assert.ok(board.inspect().status.staging.usedBytes > board.status().staging.usedBytes, 'only normal actor status performs expiry');
  assert.throws(() => board.inspectFile('../auth.json'), /relative workspace/);
  board.revoke(); assert.equal(board.inspect().status.revoked, true); assert.deepEqual(board.inspect().entries, []);
  assert.throws(() => board.inspectFile(entry.path), /revoked/);
});

test('player workspace API returns actual bounded files and updates without actor boundaries, with session/version/death gates', async () => {
  const store = fixture(), game = new FleetGame(), app = express();
  const board = new OnboardWorkspace({ runtimeBytes: 1 });
  const first = board.write('scripts/sample.mjs', 'await drone.files.write("sample.json", JSON.stringify(await drone.telemetry()));');
  const secret = board.write('notes/settings.json', '{"apiKey":"credential-must-not-appear"}');
  app.use('/api/cockpit', cockpitRouter({ store, state: () => game.state, tools: () => ['workspace', 'routine'], onboard: id => id === 'drone-1' ? board : undefined }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/cockpit`;
  const fileUrl = (path: string, version: number) => `${base}/drone-1/workspace?session=session-one&path=${encodeURIComponent(path)}&version=${version}`;
  try {
    const response = await fetch(`${base}/drone-1?session=session-one&after=0`), snapshot = await response.json();
    assert.equal(snapshot.workspace.available, true); assert.equal(snapshot.workspace.compute.filesystem, true);
    assert.deepEqual(snapshot.workspace.entries, [secret, first]); assert.equal(snapshot.workspace.limits.fileBytes, 65536);
    assert.equal(snapshot.workspace.storage.workspace.usedBytes, board.inspect().status.workspace.usedBytes);
    const file = await (await fetch(fileUrl(first.path, first.version))).json();
    assert.deepEqual(file, { ...first, droneId: 'drone-1', sessionId: 'session-one', content: board.inspectFile(first.path).content, omissions: [] });
    const redacted = await (await fetch(fileUrl(secret.path, secret.version))).json();
    assert.ok(!JSON.stringify(redacted).includes('credential-must-not-appear')); assert.ok(redacted.omissions.length);
    assert.equal((await fetch(`${fileUrl(first.path, first.version)}&sha256=${'0'.repeat(64)}`)).status, 409);
    assert.equal((await fetch(fileUrl('../auth.json', 1))).status, 400);
    assert.equal((await fetch(fileUrl('C:/Users/auth.json', 1))).status, 400);
    assert.equal((await fetch(fileUrl(first.path, first.version), { method: 'POST' })).status, 404);
    const changed = board.write(first.path, '// new version');
    const updated = await fetch(`${base}/drone-1?session=session-one&after=0`, { headers: { 'if-none-match': response.headers.get('etag')! } });
    assert.equal(updated.status, 200); assert.notEqual(updated.headers.get('etag'), response.headers.get('etag'));
    assert.equal((await updated.json()).cursor, snapshot.cursor, 'guest file writes require no fabricated actor event');
    assert.equal((await fetch(fileUrl(first.path, first.version))).status, 409);
    assert.equal((await fetch(fileUrl(changed.path, changed.version))).status, 200);
    assert.equal((await (await fetch(`${base}/drone-2`)).json()).workspace.available, false);
    game.state.drones.find(drone => drone.id === 'drone-1')!.alive = false;
    assert.equal((await (await fetch(`${base}/drone-1`)).json()).workspace.available, false);
    assert.equal((await fetch(fileUrl(changed.path, changed.version))).status, 404);
    store.reset('session-two');
    assert.equal((await fetch(fileUrl(changed.path, changed.version))).status, 409);
    store.reset(null);
    assert.equal((await (await fetch(`${base}/drone-1`)).json()).workspace.available, false);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('HTTP cockpit snapshots and images validate cursors, isolate session bytes, and expose no controls', async () => {
  const store = fixture(), game = new FleetGame(), app = express();
  app.use('/api/cockpit', cockpitRouter({ store, state: () => game.state, tools: () => ['observe', 'wait'] }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/cockpit`;
  try {
    store.recordTool('session-one', { type: 'delivery', role: 'drone-1', name: 'observe', result: delivery() });
    const response = await fetch(`${base}/drone-1?session=session-one&after=0`), snapshot = await response.json();
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const pixels = await fetch(`http://127.0.0.1:${address.port}${snapshot.lastImage.url}`);
    assert.equal(pixels.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await pixels.arrayBuffer()), Buffer.from(imageData, 'base64'));
    assert.equal((await fetch(`${base}/drone-1/image/1?session=wrong`)).status, 404);
    assert.equal((await fetch(`${base}/drone-1?after=-1`)).status, 400);
    assert.equal((await fetch(`${base}/drone-1?after=1&after=2`)).status, 400);
    assert.equal((await fetch(`${base}/drone-99`)).status, 404);
    assert.equal((await fetch(`${base}/drone-1`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${base}/drone-1?session=session-one&after=1`, { headers: { 'if-none-match': response.headers.get('etag')! } })).status, 304);
    store.reset('session-two');
    const reset = await (await fetch(`${base}/drone-1?session=session-one&after=1`)).json();
    assert.equal(reset.reset, true); assert.equal(reset.lastImage, null);
    store.reset(null);
    const idle = await fetch(`${base}/drone-1?after=0`);
    assert.equal((await idle.json()).reset, false, 'Idle polling must preserve expanded cards');
    assert.equal((await fetch(`${base}/drone-1?after=0`, { headers: { 'if-none-match': idle.headers.get('etag')! } })).status, 304);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
