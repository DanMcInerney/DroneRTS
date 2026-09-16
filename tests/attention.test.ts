import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { FleetGame } from '../server/game.ts';
import { DroneNervelet } from '../server/nervelet.ts';
import { CodexFleetRuntime } from '../server/runtime.ts';
import { ATTENTION_LIMITS, OnboardAttentionPolicy } from '../server/onboard-attention.ts';
import { resultSubmission, verifyFleetResult, type SubmittedResult } from '../server/observation-format.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';

const body = (result: SubmittedResult) => JSON.parse(result.content.find(item => item.type === 'text')!.text);
const submit = (result: SubmittedResult) => { verifyFleetResult(result); result[resultSubmission]?.submitted(); return body(result); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test('actual submitted objective events open launch even if concurrent acquisition returned no image', async t => {
  const game = new FleetGame(); game.setConnected(true); game.start(); game.awaitFleetLaunch();
  game.capture = async () => { throw new Error('Acquisition cancelled by concurrent objective receipt'); };
  const pilots = MATCH_DRONE_IDS.map(id => new DroneNervelet(game, id, { submission: 'host' }));
  t.after(async () => { game.stop(); await Promise.all(pilots.map(p => p.close())); });
  for (const pilot of pilots) submit(await pilot.call('observe'));
  game.queueMission('Exact blue launch goal.'); game.queueMission('Exact red launch goal.', 'red');
  await game.forwardTeam('blue'); await game.forwardTeam('red');
  const outputs = await Promise.all(pilots.map(p => p.call('observe')));
  assert.equal(game.launchReady, false, 'assembly never opens launch');
  for (const output of outputs.slice(0, 5)) submit(output);
  assert.equal(game.launchReady, false);
  assert.equal(outputs[5].content.some(c => c.type === 'image'), false);
  assert.equal(body(outputs[5]).nervelet.goal.text, 'Exact red launch goal.');
  submit(outputs[5]); assert.equal(game.launchReady, true);
  assert.equal(game.inboxes['drone-6'].delivered, 0, 'submission remains distinct from acknowledgement');
});
async function fixture(t: TestContext, terminationMs = 2000) {
  const game = new FleetGame(); game.setConnected(true); game.start();
  game.state.obstacles = [];
  game.state.drones.forEach((drone, i) => Object.assign(drone, { x: -20 + i * 10, y: 30, z: 0 }));
  game.capture = async id => `data:image/jpeg;base64,${Buffer.from(id).toString('base64')}`;
  const pilots = MATCH_DRONE_IDS.map(id => new DroneNervelet(game, id, { submission: 'host', attention: { ...ATTENTION_LIMITS, terminationMs } }));
  for (const pilot of pilots) submit(await pilot.call('observe'));
  game.queueMission('Exact original blue objective.'); game.queueMission('Exact original red objective.', 'red');
  await game.forwardTeam('blue'); await game.forwardTeam('red');
  const pilot = pilots[0]; const initial = submit(await pilot.call('observe'));
  const ready = submit(await pilot.call('observe', { seen: initial.nervelet.id }));
  const requests: Array<{ method: string; params: any }> = [], events: any[] = [];
  const runtime = new CodexFleetRuntime({ projectDir: process.cwd(), onStatus: e => events.push(e), onEvent: e => events.push(e), toolHandler: (role, name, args, signal) => pilots.find(p => p.id === role)!.call(name, args, signal) });
  const internal = runtime as any; internal.stopped = false;
  internal.roles.set('child', pilot.id); internal.roles.set('peer', 'drone-2');
  internal.ownTurn('child', 'old'); internal.ownTurn('peer', 'peer-turn');
  internal.rpc = { request: async (method: string, params: any) => { requests.push({ method, params }); return method === 'turn/start' ? { turn: { id: 'fresh' } } : {}; }, stop: async () => {} };
  t.after(async () => { game.stop(); await Promise.all(pilots.map(p => p.close())); await runtime.stop(); });
  const terminal = (id = 'old') => internal.onMessage({ method: 'turn/completed', params: { threadId: 'child', turn: { id, status: 'interrupted' } } });
  const evidence = () => ({ episode: 'synthetic-local-event', receivedMs: performance.now(), acquired: { clock: 'simulation-seconds', ms: 0 }, data: { type: 'local-test', uncertain: true } });
  return { game, pilot, pilots, runtime, internal, requests, events, terminal, evidence, ready };
}

test('reasoning interruption joins exact terminal and both tool layers, sends real image and rejects old generations', async t => {
  const { game, pilot, runtime, internal, requests, terminal, evidence, ready } = await fixture(t);
  const d = game.state.drones[0];
  submit(await pilot.call('route', { mission: 1, seen: ready.nervelet.id, generation: ready.nervelet.generation, command_id: ready.nervelet.nextCommandId,
    op: 'start', waypoints: [{ x: d.x, y: d.y + 5, z: d.z }] }));
  const jobId = game.onboardTelemetry(pilot.id).job!.id;
  internal.onMessage({ method: 'item/started', params: { threadId: 'child', turnId: 'old', item: { id: 'native-tool', type: 'mcpToolCall' } } });
  const ticket = internal.beginTool(pilot.id);
  const pending = runtime.requestAttention(pilot.id, pilot, evidence());
  await delay(10);
  assert.deepEqual(requests.map(r => r.method), ['turn/interrupt']);
  terminal('unrelated'); await delay(5); assert.equal(requests.length, 1);
  terminal(); await delay(5); assert.equal(requests.length, 1);
  ticket.settled(); await delay(5); assert.equal(requests.length, 1);
  internal.onMessage({ method: 'item/completed', params: { threadId: 'child', turnId: 'old', item: { id: 'native-tool', type: 'mcpToolCall' } } });
  await pending;
  assert.deepEqual(requests.map(r => r.method), ['turn/interrupt', 'turn/start']);
  const input = requests[1].params.input;
  assert.equal(input[1].url, `data:image/jpeg;base64,${Buffer.from(pilot.id).toString('base64')}`);
  const fresh = JSON.parse(input[0].text);
  assert.equal(fresh.nervelet.goal.text, 'Exact original blue objective.');
  assert.equal(internal.activeTurns.get('peer').id, 'peer-turn');
  assert.equal(game.onboardTelemetry(pilot.id).job!.id, jobId);
  assert.equal(game.onboardTelemetry(pilot.id).job!.state, 'running');
  assert.equal(internal.resumptions.size, 0);
  submit(await pilot.call('observe', { seen: fresh.nervelet.id }));
  const rejected = submit(await pilot.call('workspace', { mission: 1, seen: fresh.nervelet.id, generation: ready.nervelet.generation,
    command_id: fresh.nervelet.nextCommandId, op: 'write', path: 'stale.txt', content: 'must not exist' }));
  assert.equal(rejected.nervelet.results.at(-1).reason, 'stale_generation');
  assert.throws(() => game.onboardWorkspace(pilot.id).read('stale.txt'));
  terminal(); internal.onMessage({ method: 'turn/started', params: { threadId: 'child', turn: { id: 'old' } } });
  assert.equal(internal.activeTurns.get('child').id, 'fresh');
});

test('held waits use confirmed final output without interruption or automatic acknowledgement', async t => {
  const { pilot, runtime, requests, evidence, ready } = await fixture(t);
  const waiting = pilot.call('wait', { seen: ready.nervelet.id, timeout_ms: 30000 });
  await delay(10);
  let settled = false;
  const work = runtime.requestAttention(pilot.id, pilot, evidence()).then(() => { settled = true; });
  const result = await waiting;
  assert.ok(body(result).nervelet.attention);
  await delay(10); assert.equal(settled, false);
  submit(result); await work;
  assert.equal(requests.length, 0); assert.equal(pilot.bridge.attention()!.status, 'ready');
  submit(await pilot.call('observe', { seen: body(result).nervelet.id }));
  assert.equal(pilot.bridge.attention()!.status, 'acknowledged');
});

test('failed final formatting after assembly retains unread mail and explicitly faults attention', async t => {
  const { game, pilot, runtime, requests, evidence, ready, events } = await fixture(t);
  const waiting = pilot.call('wait', { seen: ready.nervelet.id, timeout_ms: 30000 }); await delay(10);
  const work = runtime.requestAttention(pilot.id, pilot, evidence());
  game.inboxes[pilot.id].push({ type: 'local_notice', mission: 1, text: 'retain' });
  const result = await waiting as SubmittedResult;
  result.content.push({ type: 'text', text: 'x'.repeat(640 * 1024) });
  assert.throws(() => verifyFleetResult(result), /capacity/);
  result[resultSubmission]!.failed(new Error('Final MCP formatting failed'));
  await work;
  assert.equal(requests.some(r => r.method === 'turn/start'), false);
  assert.ok(game.inboxes[pilot.id].events.some(e => e.text === 'retain'));
  assert.ok(events.some(e => e.status === 'error' && /formatting failed/.test(e.message)));
});

test('coalesced burst advances generation once and cannot schedule overlapping replacement turns', async t => {
  const { pilot, runtime, requests, terminal, evidence, ready } = await fixture(t);
  const works = Array.from({ length: 12 }, () => runtime.requestAttention(pilot.id, pilot, evidence()));
  await delay(10); terminal(); await Promise.all(works);
  assert.equal(requests.filter(r => r.method === 'turn/start').length, 1);
  assert.equal(requests.filter(r => r.method === 'turn/interrupt').length, 1);
  assert.equal(pilot.bridge.status().generation, ready.nervelet.generation + 1);
  assert.equal(pilot.bridge.attention()!.coalesced, 11);
});

for (const override of ['stop', 'reset', 'death'] as const) test(`${override} wins over an emergency waiting for native termination`, async t => {
  const { game, pilot, runtime, requests, terminal, evidence } = await fixture(t);
  const work = runtime.requestAttention(pilot.id, pilot, evidence()); await delay(5);
  if (override === 'reset') { game.stop(); game.reset(); await runtime.stop(); }
  else if (override === 'death') { game.state.drones[0].alive = false; game.emit('change'); await pilot.close(); await runtime.retireDrone(pilot.id); }
  else { game.stop(); await runtime.stop(); }
  terminal(); await work;
  assert.equal(requests.some(r => r.method === 'turn/start'), false);
});

test('local policy ignores chat and normal samples; rearm requires acknowledged cooldown and a new episode', async t => {
  const { pilot, evidence } = await fixture(t); const policy = new OnboardAttentionPolicy();
  assert.equal(policy.select({ type: 'radio', cursor: 1, mission: 1, text: 'URGENT SHOT', simTime: 1 }, performance.now(), pilot.bridge), undefined);
  assert.equal(policy.select({ type: 'telemetry', cursor: 1, mission: 1, simTime: 1 }, performance.now(), pilot.bridge), undefined);
  const selected = policy.select({ type: 'armor_lost', cursor: 2, mission: 1, cause: 'hit', simTime: 2 }, performance.now(), pilot.bridge)!;
  assert.deepEqual(selected.eventIds, [`${pilot.bridge.epoch}:e2`]);
  assert.equal('shooter' in (selected.data as object), false);
  pilot.bridge.requestAttention(evidence()); await pilot.bridge.settleAttention(pilot.bridge.attention()!.id);
  const result = submit(await pilot.call('observe')); submit(await pilot.call('observe', { seen: result.nervelet.id }));
  assert.equal(policy.select({ type: 'armor_lost', cursor: 3, mission: 1, simTime: 3 }, performance.now(), pilot.bridge), undefined);
});

test('emergency cancellation during admission reconciles original execution without replay or stopping local work', async t => {
  const { game, pilot, runtime, requests, terminal, evidence, ready, events } = await fixture(t);
  const gate = deferred(), entered = deferred(); let executions = 0;
  const original = game.executeOnboard.bind(game);
  game.executeOnboard = async (...args) => { executions++; entered.resolve(); await gate.promise; return original(...args); };
  const call = pilot.call('workspace', { seen: ready.nervelet.id, generation: ready.nervelet.generation, mission: 1, command_id: ready.nervelet.nextCommandId,
    op: 'write', path: 'uncertain.txt', content: 'never replay' });
  await entered.promise;
  const work = runtime.requestAttention(pilot.id, pilot, evidence());
  gate.resolve(); const result = await call; submit(result);
  await delay(20); if (requests.some(r => r.method === 'turn/interrupt')) terminal();
  await work;
  assert.equal(executions, 1);
  assert.equal(game.state.running, true);
  assert.equal(pilot.bridge.stats().unresolved, 0);
  assert.equal(events.some(e => e.status === 'error'), false);
  assert.ok(requests.some(r => r.method === 'turn/start') || pilot.bridge.attention()!.delivered, 'Reconciliation must leave current-generation evidence submitted');
});

test('held capture cancels its old acquisition and submits newly acquired pixels at the same boundary', async t => {
  const { game, pilot, runtime, requests, evidence, ready } = await fixture(t);
  const entered = deferred(); let captures = 0, aborted = 0;
  game.capture = async (_id, _pose, _time, _drones, _match, signal) => {
    if (++captures > 1) return 'data:image/jpeg;base64,bmV3';
    entered.resolve(); return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => { aborted++; reject(signal!.reason); }, { once: true }));
  };
  const call = pilot.call('observe', { seen: ready.nervelet.id }); await entered.promise;
  const work = runtime.requestAttention(pilot.id, pilot, evidence());
  const result = await call; submit(result); await work;
  assert.equal(aborted, 1); assert.equal(captures, 2); assert.equal(requests.length, 0);
  assert.equal(result.content.find(item => item.type === 'image')!.data, 'bmV3');
  assert.equal(pilot.bridge.attention()!.delivered, true);
});

test('closing-turn attention wins over generic continuation without spending unexpected-final allowance', async t => {
  const { pilot, runtime, internal, requests, terminal, evidence } = await fixture(t);
  terminal();
  await runtime.requestAttention(pilot.id, pilot, evidence());
  assert.deepEqual(requests.map(r => r.method), ['turn/start']);
  assert.equal(requests[0].params.input[1].type, 'image');
  assert.equal(internal.resumptions.size, 0);
});

test('backlogged urgent evidence is referenced in recovery while ordinary unread events keep FIFO order', async t => {
  const { game, pilot, runtime, requests, terminal, evidence, ready } = await fixture(t);
  submit(await pilot.call('observe', { seen: ready.nervelet.id }));
  for (let i = 0; i < 40; i++) game.inboxes[pilot.id].push({ type: 'local_notice', mission: 1, text: `${i}:` + 'x'.repeat(4096) });
  game.inboxes[pilot.id].push({ type: 'armor_lost', cause: 'hit', mission: 1, simTime: 0 });
  const urgent = game.inboxes[pilot.id].events.at(-1)!;
  const work = runtime.requestAttention(pilot.id, pilot, { ...evidence(), eventIds: [`${pilot.bridge.epoch}:e${urgent.cursor}`] });
  await delay(10); terminal(); await work;
  const result = JSON.parse(requests.find(r => r.method === 'turn/start')!.params.input[0].text);
  assert.equal(result.hasMore, true); assert.equal(result.events[0].text.startsWith('0:'), true);
  assert.ok(JSON.stringify(result.nervelet.attention).includes(`${pilot.bridge.epoch}:e${urgent.cursor}`));
  assert.equal(result.events.some((e: any) => e.cursor === urgent.cursor), false);
  assert.ok(game.inboxes[pilot.id].events.some(e => e.cursor === urgent.cursor));
});

test('compaction during closing-turn settlement precedes fresh acquisition without invalidating the replacement later', async t => {
  const { pilot, runtime, internal, requests, terminal, evidence, events } = await fixture(t);
  const ticket = internal.beginTool(pilot.id);
  const work = runtime.requestAttention(pilot.id, pilot, evidence()); await delay(5);
  internal.onMessage({ method: 'item/completed', params: { threadId: 'child', turnId: 'old', item: { type: 'contextCompaction', id: 'current' } } });
  pilot.refresh('fixture-compaction');
  terminal(); await delay(5);
  assert.equal(requests.some(r => r.method === 'turn/start'), false, 'replacement must join outstanding tool work');
  ticket.settled(); await work;
  const input = JSON.parse(requests.find(r => r.method === 'turn/start')!.params.input[0].text);
  assert.equal(input.nervelet.generation, pilot.bridge.status().generation);
  internal.onMessage({ method: 'item/completed', params: { threadId: 'child', turnId: 'old', item: { type: 'contextCompaction', id: 'late' } } });
  assert.equal(events.filter(e => e.type === 'actor-context-compacted').length, 1, 'only current-turn compaction reaches recovery coordination');
  assert.equal(input.nervelet.generation, pilot.bridge.status().generation);
  assert.equal(requests.filter(r => r.method === 'turn/start').length, 1);
  assert.ok(requests.every(r => ['turn/interrupt', 'turn/start'].includes(r.method)), 'attention needs no catalog discovery or reload');
});

for (const boundary of ['reasoning', 'held-wait'] as const) test(`delayed acquired camera reaches ${boundary} emergency once with its true age`, async t => {
  const { game, pilot, runtime, requests, terminal, evidence, ready } = await fixture(t, 6000);
  let captures = 0;
  const acquisitionStarted = performance.now();
  game.capture = async () => { captures++; await delay(2100); return 'data:image/jpeg;base64,ZGVsYXllZA=='; };
  const capture = pilot.capture.bind(pilot), images: any[] = [];
  pilot.capture = async signal => { const result = await capture(signal); images.push(...result); return result; };
  const waiting = boundary === 'held-wait' ? pilot.call('wait', { seen: ready.nervelet.id, timeout_ms: 30000 }) : undefined;
  if (waiting) await delay(10);
  const work = runtime.requestAttention(pilot.id, pilot, evidence());
  let observation: any;
  if (waiting) {
    const result = await waiting;
    assert.equal(result.content.find(item => item.type === 'image')!.data, 'ZGVsYXllZA==');
    observation = submit(result);
  } else {
    await delay(10); terminal();
  }
  await work;
  if (!waiting) {
    const input = requests.find(r => r.method === 'turn/start')!.params.input;
    assert.equal(input[1].url, 'data:image/jpeg;base64,ZGVsYXllZA==');
    observation = JSON.parse(input[0].text);
  } else assert.equal(requests.length, 0, 'held output needs no extra native turn');
  assert.equal(captures, 1, 'delivery delay must not cause another capture');
  assert.equal(observation.sensors.camera.available, true);
  assert.equal(observation.sensors.camera.fresh, false, 'retain the descriptive age flag');
  assert.ok(observation.sensors.camera.acquiredAtMs >= acquisitionStarted);
  assert.ok(observation.sensors.camera.ageMs >= 2000, 'do not reset acquisition time on receipt');
  assert.equal(observation.sensors.camera.ageMs, observation.deliveredAtMs - observation.sensors.camera.acquiredAtMs);
  assert.equal(images.length, 1); assert.equal(images[0].valid, true); assert.equal(images[0].reused, false);
  assert.equal(pilot.bridge.attention()!.delivered, true);
  assert.equal(pilot.bridge.attention()!.status, 'ready');
});

test('missing replacement pixels get one bounded reacquisition then fault without native restart', async t => {
  const { game, pilot, runtime, requests, terminal, evidence, events } = await fixture(t);
  let captures = 0;
  game.capture = async () => { captures++; throw new Error('Renderer unavailable'); };
  const work = runtime.requestAttention(pilot.id, pilot, evidence()); await delay(5); terminal(); await work;
  assert.equal(captures, 2);
  assert.equal(requests.some(r => r.method === 'turn/start'), false);
  assert.equal(pilot.bridge.attention()!.status, 'fault');
  assert.ok(events.some(e => e.status === 'error' && /camera content/.test(e.message)));
});

test('received objective change wins while native emergency termination is pending', async t => {
  const { game, pilot, runtime, requests, terminal, evidence } = await fixture(t);
  const work = runtime.requestAttention(pilot.id, pilot, evidence()); await delay(5);
  game.queueMission('Replacement objective with exact text.'); await game.forwardTeam('blue');
  terminal(); await work; await delay(10);
  assert.equal(pilot.bridge.status().goal.text, 'Replacement objective with exact text.');
  // An ordinary continuation may resume the new goal; old emergency input cannot.
  for (const start of requests.filter(r => r.method === 'turn/start')) {
    assert.equal(start.params.input.some((item: any) => item.type === 'image'), false);
    assert.doesNotMatch(JSON.stringify(start.params.input), /Exact original blue objective/);
  }
  const recovery = submit(await pilot.call('observe'));
  assert.equal(recovery.nervelet.goal.text, 'Replacement objective with exact text.');
  assert.equal(recovery.nervelet.goal.version, 2);
});
