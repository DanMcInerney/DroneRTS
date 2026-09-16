import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { commandDigest, resultBytes, type Receipt } from 'nervelet';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FleetGame } from '../server/game.ts';
import { DroneNervelet, NERVELET_CACHE_RESERVE } from '../server/nervelet.ts';
import { cacheAccounting, NERVELET_RESULT_LIMITS } from '../server/nervelet-results.ts';
import { resultSubmission, verifyFleetResult, type SubmittedResult } from '../server/observation-format.ts';
import { FleetMcpServer } from '../server/runtime-mcp.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';
import type { ToolResult } from '../shared/types.ts';

const KiB = 1024;
const body = (result: ToolResult): any => JSON.parse(result.content.find(item => item.type === 'text')!.text);
const receipt = (value: any, id = 'c1'): Receipt & { data: { result: any; isError: boolean } } => {
  const found = value.nervelet.results?.find((result: Receipt) => result.id === id);
  assert.ok(found, `Missing receipt ${id}: ${JSON.stringify(value).slice(0, 1500)}`);
  return found;
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t: TestContext, options: { six?: boolean; acoustic?: boolean; host?: boolean } = {}) {
  const game = new FleetGame({ acoustic: options.acoustic });
  game.setConnected(true); game.start(); game.state.obstacles = [];
  game.state.drones.forEach((drone, index) => Object.assign(drone, { x: -20 + index * 10, y: 30, z: 0 }));
  let frames = 0;
  game.capture = async id => `data:image/jpeg;base64,${Buffer.from(`${id}:${++frames}`).toString('base64')}`;
  for (const id of MATCH_DRONE_IDS) game.markActorOnline(id);
  await game.forwardTeam('blue'); await game.forwardTeam('red');
  const pilots = (options.six ? MATCH_DRONE_IDS : [MATCH_DRONE_IDS[0]]).map(id =>
    new DroneNervelet(game, id, options.host ? { submission: 'host' } : {}));
  t.after(async () => { game.stop(); await Promise.all(pilots.map(pilot => pilot.close())); });
  const initial = await Promise.all(pilots.map(async pilot => {
    const first = await pilot.call('observe') as SubmittedResult;
    first[resultSubmission]?.submitted();
    const ready = await pilot.call('observe', { seen: body(first).nervelet.id }) as SubmittedResult;
    ready[resultSubmission]?.submitted();
    assert.equal(body(ready).nervelet.loop, 'active');
    return body(ready);
  }));
  return { game, pilots, pilot: pilots[0], initial, ready: initial[0], frames: () => frames };
}
const argsFor = (prior: any, args: Record<string, unknown> = {}) => ({
  mission: prior.nervelet.goal.version, seen: prior.nervelet.id,
  command_id: prior.nervelet.nextCommandId, generation: prior.nervelet.generation, ...args,
});
function executionCounter(game: FleetGame) {
  const original = game.executeOnboard.bind(game);
  let count = 0;
  game.executeOnboard = (...args) => { count++; return original(...args); };
  return () => count;
}

test('lost workspace reads redeliver their original content after overwrite/delete without repeating execution', async t => {
  const { game, pilot, ready } = await fixture(t);
  const workspace = game.onboardWorkspace(pilot.id), original = 'Original \u0000 Unicode \u{1f680} content.';
  workspace.write('note.txt', original);
  const executions = executionCounter(game), args = argsFor(ready, { op: 'read', path: 'note.txt' });
  const lost = body(await pilot.call('workspace', args));
  assert.equal(receipt(lost).data.result.workspace.content, original);
  assert.equal(lost.workspace, undefined, 'historical output must not be merged into current observation state');
  workspace.write('note.txt', 'New content'); workspace.delete('note.txt');
  const observed = body(await pilot.call('observe'));
  const duplicate = body(await pilot.call('workspace', args));
  assert.deepEqual(receipt(observed), receipt(lost)); assert.deepEqual(receipt(duplicate), receipt(lost));
  assert.equal(executions(), 1);
  assert.ok(observed.sensors.sequence > lost.sensors.sequence);
  assert.ok(observed.sensors.camera.acquiredAtMs >= lost.sensors.camera.acquiredAtMs);
  assert.equal(observed.sensors.camera.available, true);
  const identity = { id: 'c1', kind: 'workspace', digest: commandDigest({ id: 'c1', kind: 'workspace', args: { mission: 1, op: 'read', path: 'note.txt' } }) };
  const authoritative = await pilot.reconcileReceipt(identity, new AbortController().signal);
  const assembled = await pilot.bridge.step({ schemaVersion: 2 });
  assert.equal(assembled.results?.[0].data, authoritative.data, 'adapter and Bridge share one retained payload representation');
  assert.equal(Object.isFrozen(authoritative.data), true);
  assert.equal(Object.isFrozen((authoritative.data as any).result), true);
  await pilot.call('observe', { seen: duplicate.nervelet.id });
  assert.equal(pilot.bridge.stats().retainedResultBytes, 0);
  const released = await pilot.reconcileReceipt(identity, new AbortController().signal);
  assert.equal(released.status, 'unknown', 'acknowledgement also releases adapter execution payloads');
});

test('lost partial exchanges retain each original success/failure outcome and execute admitted operations once', async t => {
  const { game, pilot, ready } = await fixture(t), executions = executionCounter(game);
  const args = argsFor(ready, { operations: [
    { id: 'mail', tool: 'send', args: { to: 'drone-2', kind: 'chat', text: 'Original partial exchange' } },
    { id: 'purchase', tool: 'buy', args: { item: 'gun' } },
    { id: 'bad-mail', tool: 'send', args: { to: 'drone-2', kind: 'chat', text: '' } },
  ] });
  const lost = body(await pilot.call('exchange', args));
  const original = receipt(lost).data;
  assert.equal(original.result.atomic, false);
  assert.equal(typeof original.result.outcomes[0].result.sent, 'string');
  assert.equal(original.result.outcomes[1].result.rejected, true);
  assert.equal(original.result.outcomes[1].isError, false);
  assert.equal(original.result.outcomes[2].isError, true);
  assert.match(original.result.outcomes[2].result.error, /Radio message/);
  assert.equal(lost.outcomes, undefined);
  assert.deepEqual(receipt(body(await pilot.call('observe'))).data, original);
  assert.deepEqual(receipt(body(await pilot.call('exchange', args))).data, original);
  assert.equal(executions(), 1);
  assert.equal(game.state.radio.filter(message => message.text === 'Original partial exchange').length, 1);
});

test('late execution reconciliation preserves original output when an older unknown bundle is acknowledged', async t => {
  const { game, pilot, ready } = await fixture(t), workspace = game.onboardWorkspace(pilot.id);
  workspace.write('late.txt', 'original late read');
  const entered = deferred(), release = deferred(), original = game.executeOnboard.bind(game);
  let executions = 0;
  game.executeOnboard = async (...args) => {
    executions++;
    const result = await original(...args);
    entered.resolve(); await release.promise;
    return result;
  };
  const controller = new AbortController();
  const pending = pilot.call('workspace', argsFor(ready, { op: 'read', path: 'late.txt' }), controller.signal);
  await entered.promise; controller.abort(new Error('Fixture lost transport after execution'));
  assert.equal(body(await pending).cancelled, true);
  assert.equal(pilot.bridge.stats().unresolved, 1);
  // The public Bridge seam assembles revision 1 without the adapter's automatic reconciliation.
  const unknown = await pilot.bridge.step({ schemaVersion: 2 });
  assert.equal(unknown.results?.[0].status, 'unknown');
  workspace.write('late.txt', 'replacement after original execution');
  release.resolve();
  const reconciled = body(await pilot.call('observe', { seen: unknown.id }));
  assert.equal(receipt(reconciled).data.result.workspace.content, 'original late read');
  assert.equal(pilot.bridge.stats().unresolved, 0); assert.equal(executions, 1);
  assert.ok(pilot.bridge.stats().retainedResultBytes > 0, 'old acknowledgement cannot release the reconciled revision');
  const again = body(await pilot.call('observe'));
  assert.deepEqual(receipt(again), receipt(reconciled));
  await pilot.call('observe', { seen: again.nervelet.id });
  assert.equal(pilot.bridge.stats().retainedResultBytes, 0);
});

for (const failure of ['snapshot', 'capture', 'formatting', 'submission'] as const) {
  test(`${failure} failure after execution preserves original results and unread mail`, async t => {
    const { game, pilot, ready } = await fixture(t, { host: failure === 'submission' });
    const workspace = game.onboardWorkspace(pilot.id);
    workspace.write('retained.txt', `Original ${failure}`);
    game.inboxes[pilot.id].push({ type: 'retained_notice', mission: 1, text: `Unread ${failure}` });
    const through = game.inboxes[pilot.id].delivered;
    const execute = game.executeOnboard.bind(game), telemetry = game.onboardTelemetry.bind(game), capture = game.capture;
    const internal = pilot as any, output = internal.output.bind(pilot);
    let executed = false;
    game.executeOnboard = async (...args) => { const result = await execute(...args); executed = true; return result; };
    if (failure === 'snapshot') game.onboardTelemetry = id => { if (executed) throw new Error('Fixture snapshot failure'); return telemetry(id); };
    if (failure === 'capture') game.capture = async () => { throw new Error('Fixture capture failure'); };
    if (failure === 'formatting') internal.output = (...args: any[]) => {
      const result = output(...args);
      result.content.push({ type: 'text', text: 'x'.repeat(640 * KiB) });
      return result;
    };
    const attempted = await pilot.call('workspace', argsFor(ready, { op: 'read', path: 'retained.txt' })) as SubmittedResult;
    if (failure === 'submission') attempted[resultSubmission]!.failed(new Error('Fixture disconnected final host output'));
    else if (failure === 'capture') {
      assert.equal(attempted.content.some(item => item.type === 'image'), false);
      assert.equal(body(attempted).camera?.available ?? body(attempted).sensors?.camera?.available, false);
    } else assert.equal(attempted.isError, true);
    assert.equal(executed, true);
    assert.equal(game.inboxes[pilot.id].delivered, through);
    assert.ok(pilot.bridge.stats().retainedResultBytes > 0);
    workspace.delete('retained.txt');
    game.onboardTelemetry = telemetry; game.capture = capture; internal.output = output;
    const recovered = body(await pilot.call('observe'));
    assert.equal(receipt(recovered).data.result.workspace.content, `Original ${failure}`);
    assert.ok(recovered.events.some((event: any) => event.type === 'retained_notice'));
    assert.equal(recovered.sensors.camera.available, true);
    assert.ok(recovered.currentTelemetry.acquiredAtMs >= recovered.sensors.camera.acquiredAtMs);
  });
}

test('actual MCP disconnect after execution retains original output and mail for the next connection', async t => {
  const { game, pilot } = await fixture(t, { host: true });
  const server = new FleetMcpServer({ roles: [pilot.id], active: () => game.state.running,
    tools: () => pilot.tools(), call: (_role, name, args, signal) => pilot.call(name, args, signal), policy: () => ({}), onEvent: () => {} });
  const endpoint = await server.start();
  const client = new Client({ name: 'retained-results-disconnect', version: '1' });
  t.after(async () => { await client.close(); await server.stop(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp/${endpoint.tokens[pilot.id]}`)));
  const ready = body(await client.callTool({ name: 'observe', arguments: {} }) as ToolResult);
  game.onboardWorkspace(pilot.id).write('transport.txt', 'Original before disconnect');
  game.inboxes[pilot.id].push({ type: 'unread_transport', mission: 1 });
  const entered = deferred(), release = deferred(), capture = game.capture;
  game.capture = async (...args) => { entered.resolve(); await release.promise; return capture(...args); };
  const pending = client.callTool({ name: 'workspace', arguments: argsFor(ready, { op: 'read', path: 'transport.txt' }) }).catch(error => error);
  await entered.promise;
  assert.ok(pilot.bridge.stats().retainedResultBytes > 0, 'the command finished before output disconnected');
  await client.close(); release.resolve(); await pending; await pilot.bridge.whenIdle(); await delay(0);
  game.capture = capture; game.onboardWorkspace(pilot.id).delete('transport.txt');
  const recovered = body(await pilot.call('observe'));
  assert.equal(receipt(recovered).data.result.workspace.content, 'Original before disconnect');
  assert.ok(recovered.events.some((event: any) => event.type === 'unread_transport'));
});

test('escaped maximum files fit retained/wire budgets and byte pressure rejects before effects or ID consumption', async t => {
  const { game, pilot, ready } = await fixture(t), content = '\u0000'.repeat(65536);
  const written = body(await pilot.call('workspace', argsFor(ready, { op: 'write', path: 'maximum.txt', content })));
  assert.equal(receipt(written).status, 'completed');
  const executions = executionCounter(game);
  const readArgs = argsFor(written, { op: 'read', path: 'maximum.txt' });
  const raw = await pilot.call('workspace', readArgs), first = body(raw);
  const maximum = receipt(first, readArgs.command_id);
  assert.equal(maximum.data.result.workspace.content, content);
  const retained = pilot.bridge.stats().retainedResultBytes, wire = verifyFleetResult(raw);
  assert.equal(retained, resultBytes(maximum.data));
  assert.ok(retained <= 144 * KiB); assert.ok(wire.wireBytes <= 640 * KiB);
  const nextId = first.nervelet.nextCommandId;
  const blockedRead = body(await pilot.call('workspace', { ...readArgs, seen: undefined, command_id: nextId }));
  assert.equal(receipt(blockedRead, nextId).status, 'not_executed');
  assert.match(receipt(blockedRead, nextId).reason!, /backpressure/);
  assert.equal(blockedRead.nervelet.nextCommandId, nextId);
  const blockedMutation = body(await pilot.call('exchange', {
    mission: 1, command_id: nextId, operations: [{ id: 'mail', tool: 'send', args: { to: 'all', kind: 'chat', text: 'Must wait for retention capacity' } }],
  }));
  assert.equal(receipt(blockedMutation, nextId).status, 'not_executed');
  assert.equal(blockedMutation.nervelet.nextCommandId, nextId); assert.equal(executions(), 1);
  assert.equal(game.state.radio.some(message => message.text === 'Must wait for retention capacity'), false);
  const again = body(await pilot.call('observe'));
  assert.equal(receipt(again, readArgs.command_id).data.result.workspace.content, content);
  const released = body(await pilot.call('observe', { seen: again.nervelet.id }));
  assert.equal(pilot.bridge.stats().retainedResultBytes, 0);
  const second = body(await pilot.call('workspace', argsFor(released, { op: 'read', path: 'maximum.txt' })));
  assert.equal(receipt(second, nextId).data.result.workspace.content, content);
  assert.equal(executions(), 2);
  t.diagnostic(JSON.stringify({ maximumFileBytes: 65536, retainedResultBytes: retained, poolBytes: NERVELET_RESULT_LIMITS.maxRetainedResultBytes, ...wire }));
});

test('a full 256-file listing with maximum-length paths fits its reservation and releases on acknowledgement', async t => {
  const { game, pilot, ready } = await fixture(t), workspace = game.onboardWorkspace(pilot.id);
  for (let index = 0; index < 256; index++) workspace.write(`f${String(index).padStart(3, '0')}${'x'.repeat(120)}.txt`, '');
  const raw = await pilot.call('workspace', argsFor(ready, { op: 'list' })), listed = body(raw);
  assert.equal(receipt(listed).data.result.workspace.length, 256);
  const retained = pilot.bridge.stats().retainedResultBytes;
  assert.ok(retained <= 180 * KiB); assert.ok(verifyFleetResult(raw).textBytes <= 640 * KiB);
  const again = body(await pilot.call('observe'));
  assert.deepEqual(receipt(again).data, receipt(listed).data);
  await pilot.call('observe', { seen: again.nervelet.id });
  assert.equal(pilot.bridge.stats().retainedResultBytes, 0);
  t.diagnostic(JSON.stringify({ files: 256, maximumPathBytes: 128, retainedResultBytes: retained, ...verifyFleetResult(raw) }));
});

test('several outstanding results apply record backpressure before mutations and acknowledgement reclaims capacity', async t => {
  const { game, pilot } = await fixture(t), workspace = game.onboardWorkspace(pilot.id);
  workspace.write('small.txt', 'retained original');
  const executions = executionCounter(game);
  for (let index = 1; index <= NERVELET_RESULT_LIMITS.receiptHistory; index++) {
    const result = body(await pilot.call('workspace', { mission: 1, command_id: `c${index}`, op: 'read', path: 'small.txt' }));
    assert.equal(receipt(result, `c${index}`).data.result.workspace.content, 'retained original');
  }
  assert.equal(pilot.bridge.stats().receipts, 16);
  assert.ok(pilot.bridge.stats().retainedResultBytes < NERVELET_RESULT_LIMITS.maxRetainedResultBytes);
  const args = { mission: 1, command_id: 'c17', op: 'write', path: 'after-capacity.txt', content: 'admit once' };
  const blocked = body(await pilot.call('workspace', args));
  assert.equal(receipt(blocked, 'c17').reason, 'receipt_backpressure');
  assert.equal(blocked.nervelet.nextCommandId, 'c17');
  assert.equal(executions(), 16); assert.throws(() => workspace.read('after-capacity.txt'), /does not exist/);
  for (let index = 1; index <= 16; index++) assert.equal(receipt(blocked, `c${index}`).data.result.workspace.content, 'retained original');
  await pilot.call('observe', { seen: blocked.nervelet.id });
  assert.equal(pilot.bridge.stats().retainedResultBytes, 0);
  const admitted = body(await pilot.call('workspace', args));
  assert.equal(receipt(admitted, 'c17').status, 'completed');
  assert.equal(workspace.read('after-capacity.txt'), 'admit once'); assert.equal(executions(), 17);
  assert.ok(pilot.bridge.stats().receipts <= 16);
});

test('all six pilots retain isolated results through repeated recoveries with bounded receipts and deliveries', async t => {
  const { game, pilots, initial } = await fixture(t, { six: true });
  let current = await Promise.all(pilots.map(async (pilot, index) => {
    game.onboardWorkspace(pilot.id).write('private.txt', `Private result for ${pilot.id}`);
    return body(await pilot.call('workspace', argsFor(initial[index], { op: 'read', path: 'private.txt' })));
  }));
  const charges = pilots.map(pilot => pilot.bridge.stats().retainedResultBytes);
  for (let iteration = 0; iteration < 12; iteration++) {
    current = await Promise.all(pilots.map(async (pilot, index) => {
      pilot.refresh('deterministic-compaction-fixture');
      const value = body(await pilot.call('observe'));
      assert.equal(receipt(value).data.result.workspace.content, `Private result for ${pilot.id}`);
      const stats = pilot.bridge.stats();
      assert.equal(stats.retainedResultBytes, charges[index]);
      assert.ok(stats.deliveries <= NERVELET_RESULT_LIMITS.bundleHistory);
      assert.ok(stats.receipts <= NERVELET_RESULT_LIMITS.receiptHistory);
      return value;
    }));
  }
  const foreign = body(await pilots[0].call('observe', { seen: current[1].nervelet.id }));
  assert.equal(foreign.rejected, true); assert.equal(pilots[0].bridge.stats().retainedResultBytes, charges[0]);
  await pilots[0].call('observe', { seen: current[0].nervelet.id });
  assert.equal(pilots[0].bridge.stats().retainedResultBytes, 0);
  pilots.slice(1).forEach((pilot, index) => assert.equal(pilot.bridge.stats().retainedResultBytes, charges[index + 1]));
});

for (const acoustic of [false, true]) test(`cache accounting fits the unchanged reservation with acoustic=${acoustic}`, async t => {
  const { game, pilot } = await fixture(t, { acoustic });
  const accounting = cacheAccounting(pilot.profile, pilot.bridge.profileText);
  assert.ok(accounting.metadataBytes <= 192 * KiB);
  assert.equal(accounting.resultBytes, 192 * KiB);
  assert.equal(accounting.reservedBytes, NERVELET_CACHE_RESERVE);
  assert.equal(accounting.reservedBytes, 384 * KiB);
  assert.ok(accounting.metadataBytes + accounting.resultBytes <= accounting.reservedBytes);
  assert.equal(game.onboardWorkspace(pilot.id).status().logs.usedBytes, NERVELET_CACHE_RESERVE + (acoustic ? 8 * KiB : 0));
  t.diagnostic(JSON.stringify({ acoustic, ...accounting }));
});

test('immutable application profile avoids repeated traversal at real observation and operation boundaries', async t => {
  const { pilot, ready } = await fixture(t);
  const original = Object.keys;
  let traversals = 0;
  const counts: Record<string, number> = {};
  Object.keys = ((value: object) => {
    if (value === pilot.profile) traversals++;
    return original(value);
  }) as typeof Object.keys;
  try {
    let prior = ready;
    for (const [name, args, label] of [
      ['observe', {}, 'observe'],
      ['workspace', { op: 'write', path: 'profile.txt', content: 'profile fixture' }, 'workspace'],
      ['act', { kind: 'look', heading: 10 }, 'look'],
      ['exchange', { operations: [
        { id: 'one', tool: 'act', args: { kind: 'look', heading: 20 } },
        { id: 'two', tool: 'act', args: { kind: 'look', heading: 30 } },
      ] }, 'two-look-exchange'],
    ] as const) {
      traversals = 0;
      const next = body(await pilot.call(name, argsFor(prior, args)));
      assert.notEqual(next.rejected, true, JSON.stringify(next));
      if (name !== 'observe') assert.notEqual(receipt(next, prior.nervelet.nextCommandId).status, 'unknown');
      counts[label] = traversals; prior = next;
    }
  } finally { Object.keys = original; }
  assert.deepEqual(counts, { observe: 0, workspace: 0, look: 0, 'two-look-exchange': 0 });
  t.diagnostic(JSON.stringify({ profileTraversals: counts, auditedBaseline: { observe: 1, workspace: 3, look: 4, 'two-look-exchange': 7 } }));
});
