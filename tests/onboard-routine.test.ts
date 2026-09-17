import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { OnboardWorkspace } from '../server/onboard-workspace.ts';
import { RoutineRunner, type RoutineHost, type RoutineStatus } from '../server/routine-runner.ts';

function harness(source: string, host: Partial<RoutineHost> = {}, limits: ConstructorParameters<typeof RoutineRunner>[2] = {}) {
  const workspace = new OnboardWorkspace(); workspace.write('entry.js', source);
  const traces: unknown[] = [], statuses: RoutineStatus[] = [];
  const runner = new RoutineRunner(workspace, { validate: () => {}, call: async (method) => ({ method, position: { x: 1, y: 2, z: 3 }, sequence: 7 }), onTrace: entry => traces.push(entry), onState: value => statuses.push(value), ...host }, limits);
  return { runner, workspace, traces, statuses };
}
async function ended(runner: RoutineRunner, timeout = 7000): Promise<RoutineStatus> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { const status = runner.status(); if (status && !status.cleanupPending && !['accepted', 'running'].includes(status.state)) return status; await delay(10); }
  runner.cancel('test_timeout'); throw new Error('Routine failed to finish within the test deadline');
}

test('real QuickJS worker runs neutral own-sensor code and relative immutable JS module import', async t => {
  const { runner, workspace, traces } = harness("import { copy } from './helper.js'; const sample = await drone.telemetry(); await drone.files.write('sample.json', JSON.stringify(copy(sample))); ");
  t.after(() => runner.cancel('test_cleanup')); workspace.write('helper.js', 'export const copy = x => ({ sequence: x.sequence, supplied: input.label });');
  const accepted = runner.start({ path: 'entry.js', mission: 1, input: { label: 'caller' } });
  assert.equal(accepted.state, 'accepted');
  const result = await ended(runner); assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.deepEqual(JSON.parse(workspace.read('sample.json')), { sequence: 7, supplied: 'caller' }); assert.equal(traces.length, 2);
});

test('guest has no Node, host filesystem, sockets, repository imports or environment access', async t => {
  const { runner, workspace } = harness("await drone.files.write('access.json', JSON.stringify({process:typeof process,require:typeof require,fetch:typeof fetch,Buffer:typeof Buffer,WebSocket:typeof WebSocket,bridge:typeof __hostCall}));");
  t.after(() => runner.cancel('test_cleanup')); runner.start({ path: 'entry.js', mission: 1 });
  assert.equal((await ended(runner)).state, 'completed');
  assert.deepEqual(Object.values(JSON.parse(workspace.read('access.json'))), Array(6).fill('undefined'));
  workspace.write('entry.js', "import fs from 'node:fs';"); runner.start({ path: 'entry.js', mission: 1 });
  assert.equal((await ended(runner)).state, 'failed');
});

test('runaway guest terminates under its slice deadline while main loop remains responsive', async t => {
  const { runner } = harness('while (true) {}'); t.after(() => runner.cancel('test_cleanup'));
  let ticks = 0; const timer = setInterval(() => ticks++, 5); t.after(() => clearInterval(timer));
  runner.start({ path: 'entry.js', mission: 1 }); const result = await ended(runner);
  assert.equal(result.state, 'failed'); assert.match(result.error!, /guest_slice_deadline|guest_cpu_budget/); assert.ok(ticks > 0);
});

test('an async microtask runaway fails inside a bounded worker', async t => {
  const { runner } = harness('while (true) await Promise.resolve();');
  t.after(() => runner.cancel('test_cleanup'));
  runner.start({ path: 'entry.js', mission: 1 });
  const result = await ended(runner); assert.equal(result.state, 'failed'); assert.match(result.error!, /guest_cpu_budget|guest_slice_deadline/);
});

test('hostile error getters cannot escape the guest interruption budget', async t => {
  const { runner } = harness('throw { get message() { while(true) {} } };'); t.after(() => runner.cancel('test_cleanup'));
  runner.start({ path: 'entry.js', mission: 1 }); const result = await ended(runner);
  assert.equal(result.state, 'failed'); assert.match(result.error!, /guest_slice_deadline|guest_cpu_budget/);
});

test('future edits do not change running source, explicit replacement and cancellation release retained versions', async t => {
  const { runner, workspace } = harness("await drone.sleep(200); await drone.files.write('result.md', 'old');"); t.after(() => runner.cancel('test_cleanup'));
  const first = runner.start({ path: 'entry.js', mission: 1 }); workspace.write('entry.js', "await drone.files.write('result.md', 'new');");
  assert.throws(() => runner.start({ path: 'entry.js', mission: 1 }), /routine_busy/);
  assert.equal((await ended(runner)).state, 'completed'); assert.equal(workspace.read('result.md'), 'old');
  const second = runner.start({ path: 'entry.js', mission: 1 }); assert.notEqual(second.sourceHash, first.sourceHash);
  assert.equal((await ended(runner)).state, 'completed'); assert.equal(workspace.read('result.md'), 'new'); assert.equal(workspace.status().retainedVersions, 0);
  workspace.write('entry.js', 'await drone.sleep(1000);'); runner.start({ path: 'entry.js', mission: 1 });
  assert.equal(runner.cancel('new_objective')?.state, 'cancelled');
});

test('pending host operations abort promptly and cannot complete late side effects', async t => {
  let effects = 0, started!: () => void; const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const { runner } = harness('await drone.act({kind:"hover"});', { call: async (_method, _args, context) => { started(); await delay(150); if (!context.signal.aborted) effects++; return {}; } });
  t.after(() => runner.cancel('test_cleanup')); runner.start({ path: 'entry.js', mission: 1 });
  const callStarted = await Promise.race([startedPromise.then(() => true), delay(4000, undefined, { ref: false }).then(() => false)]);
  assert.equal(callStarted, true, JSON.stringify(runner.status()));
  const before = performance.now(); runner.cancel('destroyed'); assert.ok(performance.now() - before < 100);
  await delay(200); assert.equal(effects, 0); assert.equal(runner.status()?.reason, 'destroyed');
});

test('SDK fanout and slow host callbacks fail explicitly instead of growing queues indefinitely', async t => {
  const { runner, workspace } = harness('await Promise.all(Array.from({length:30}, () => drone.sleep(1000)));'); t.after(() => runner.cancel('test_cleanup'));
  runner.start({ path: 'entry.js', mission: 1 }); assert.match((await ended(runner)).error!, /sdk_pending_limit/);
  workspace.write('entry.js', 'await drone.telemetry();');
  const slow = new RoutineRunner(workspace, { validate: () => {}, call: async () => new Promise(() => {}) }, { hostDeadlineMs: 100 });
  t.after(() => slow.cancel('test_cleanup')); slow.start({ path: 'entry.js', mission: 1 });
  assert.match((await ended(slow)).error!, /host_call_deadline|host_call_cancelled/);
});

test('mission invalidation cancels a routine but independent radio loss leaves local execution working', async t => {
  let valid = true;
  const { runner, workspace } = harness('await drone.sleep(1000); await drone.files.write("late.md","late");', { validate: () => { if (!valid) throw new Error('mission_replaced'); } });
  t.after(() => runner.cancel('test_cleanup')); runner.start({ path: 'entry.js', mission: 1 }); valid = false;
  const result = await ended(runner); assert.equal(result.state, 'cancelled'); assert.equal(result.reason, 'mission_replaced'); assert.throws(() => workspace.read('late.md'));
  valid = true; workspace.write('entry.js', 'try { await drone.send({to:"all",text:"hello"}); } catch {} await drone.files.write("local.md","continued");');
  const offline = new RoutineRunner(workspace, { validate: () => {}, call: async () => { throw new Error('radio_disconnected'); } }); t.after(() => offline.cancel('test_cleanup'));
  offline.start({ path: 'entry.js', mission: 1 }); assert.equal((await ended(offline)).state, 'completed'); assert.equal(workspace.read('local.md'), 'continued');
});

test('six separate workers keep their files private while asynchronous sensor work yields', async t => {
  const owned: RoutineRunner[] = []; t.after(() => { for (const runner of owned) runner.cancel('test_cleanup'); });
  let ticks = 0; const timer = setInterval(() => ticks++, 10); t.after(() => clearInterval(timer));
  let release!: () => void;
  const sensors = new Promise<void>(resolve => { release = resolve; }), calls = Array(6).fill(0);
  const participants = Array.from({ length: 6 }, (_, index) => harness('for (let n=0;n<2;n++) { const own = await drone.telemetry(); await drone.files.write("own.json", JSON.stringify(own)); await drone.sleep(10); }', {
    call: async () => { calls[index]++; await sensors; return { owner: index }; },
  }));
  try {
    // This fixture checks isolation and async overlap, not simultaneous cold WASM startup.
    // Hold each worker's first sensor call until all six are alive, without enlarging any limit.
    for (const [index, item] of participants.entries()) {
      owned.push(item.runner); item.runner.start({ path: 'entry.js', mission: 1 });
      const deadline = performance.now() + 5000;
      while (!calls[index] && performance.now() < deadline && ['accepted', 'running'].includes(item.runner.status()!.state)) await delay(5);
      assert.equal(calls[index], 1, JSON.stringify(item.runner.status()));
    }
    assert.ok(participants.every(item => item.runner.status()?.state === 'running'), JSON.stringify(participants.map(item => item.runner.status())));
  } finally { release(); }
  const results = await Promise.all(participants.map(item => ended(item.runner)));
  assert.ok(results.every(result => result.state === 'completed'), JSON.stringify(results));
  assert.deepEqual(calls, Array(6).fill(2));
  for (const [index, item] of participants.entries()) assert.deepEqual(JSON.parse(item.workspace.read('own.json')), { owner: index });
  assert.ok(ticks > 5);
});

test('cancellation retains snapshot bytes until worker retirement and bounds rapid replacement', async t => {
  const { runner, workspace } = harness('while(true) {}'); t.after(() => runner.cancel('test_cleanup'));
  runner.start({ path: 'entry.js', mission: 1 });
  workspace.write('entry.js', 'export const edited = true;');
  runner.cancel('explicit_cancel'); assert.equal(runner.status()?.cleanupPending, true);
  assert.equal(workspace.status().retainedVersions, 1);
  assert.throws(() => runner.start({ path: 'entry.js', mission: 1 }), /cleanup_pending/);
  await ended(runner); assert.equal(workspace.status().retainedVersions, 0);
});

test('SDK rate admission caps sequential host side effects even if the guest catches rejections', async t => {
  let calls = 0;
  const { runner } = harness('for(let n=0;n<100;n++) { try { await drone.telemetry(); } catch {} }', { call: async () => { calls++; return {}; } });
  t.after(() => runner.cancel('test_cleanup')); runner.start({ path: 'entry.js', mission: 1 });
  const result = await ended(runner); assert.equal(result.state, 'failed'); assert.equal(result.error, 'sdk_rate_exceeded'); assert.equal(calls, 64);
});

test('routine wall deadline terminates inert promises without requiring a guest callback', async t => {
  const { runner } = harness('await new Promise(() => {});', {}, { wallTimeMs: 250 });
  t.after(() => runner.cancel('test_cleanup')); runner.start({ path: 'entry.js', mission: 1 });
  const result = await ended(runner); assert.equal(result.state, 'failed'); assert.equal(result.error, 'routine_wall_deadline');
});
