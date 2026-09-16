import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeContent, extractErrors } from '../scripts/audit/decode.ts';
import { hash, loadRun, readJsonLines, safePath } from '../scripts/audit/load-run.ts';
import { correlate } from '../scripts/audit/correlate.ts';
import { evaluate } from '../scripts/audit/checks.ts';
import { auditRun, canonical, exitCode, writeReport } from '../scripts/audit/report.ts';
import { finalizeFocusedTrial } from '../scripts/finalize-focused-trial.ts';
import type { Issue, Run } from '../scripts/audit/types.ts';

const execute = promisify(execFile), session = 'session-fixture.jsonl', replayDirectory = 'replays/session-fixture';
const time = (n: number) => new Date(Date.UTC(2026, 8, 16) + n).toISOString();
const content = (value: any) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const roster = [{ id: 'drone-1', team: 'blue' }, { id: 'drone-2', team: 'blue' }, { id: 'drone-3', team: 'red' }];
function frame(simTime: number, stock = 50, aboard = 10, earned = 20, lost = 5): any {
  return { type: 'frame', simTime, drones: roster.map((r, i) => ({ ...r, alive: true, cargo: { amount: i === 0 ? aboard : 0 } })),
    match: { rulesVersion: 'cargo-v3', resources: [{ id: 'cache', remaining: stock, reserved: 8 }], salvageLost: lost, winner: null,
      teams: { blue: { earned, credits: 0 }, red: { earned: 0, credits: 0 } } } };
}
function fixture(): Run {
  const run: Run = { directory: '', sessionFile: session, replayDirectory,
    result: { scenario: 'match', sessionId: session, cleanup: 'complete', stopped: true, seconds: 60, failures: [] },
    manifest: { 'historical/source.ts': 'old-code-hash' }, replayStatus: {}, cleanup: {}, audit: [], replay: [], inputs: [], issues: [] };
  run.result.manifestSha256 = hash(JSON.stringify(run.manifest));
  const audit: any[] = [], replay: any[] = [{ type: 'header', protocol: 'fleet-replay/1', rulesVersion: 'cargo-v3',
    roster: roster.map(({ id }) => ({ id })), sampleInterval: .5 }, frame(0)];
  const add = (type: string, value: any) => audit.push({ type, value, wallTime: time(audit.length * 10) });
  for (const n of [1, 2]) for (const actor of roster) {
    const metadata = { id: `b${n}`, loopRef: `${actor.id}:epoch`, generation: 1, schemaVersion: 2 };
    const capturedAt = time((n - 1) * 100), acquiredAtMs = (n - 1) * 100;
    add('agent', { type: 'tool', role: actor.id, team: actor.team, name: 'observe', arguments: n === 1 ? {} : { seen: 'b1' } });
    if (n === 2) add('nervelet-trace', { type: 'acknowledgement', drone: actor.id, ...metadata, id: 'b1' });
    add('nervelet-trace', { type: 'assembly', drone: actor.id, ...metadata });
    const body = { protocol: 'fleet-observation/5', sessionId: 'radio-session', mission: 1, nervelet: metadata,
      launchReady: n === 2, deliverySimTime: n - 1, deliveredAtMs: acquiredAtMs + 20,
      sensors: { camera: { available: true, acquiredAt: capturedAt, acquiredAtMs, simTime: n - 1, ageMs: 20, fresh: true } },
      events: n === 1 ? [{ type: 'player', mission: 1 }] : [] };
    add('agent', { type: 'tool-result', role: actor.id, team: actor.team, name: 'observe', result: { content: [...content(body).content, { type: 'image', data: '[camera image omitted]' }] } });
    add('nervelet-trace', { type: 'submission', drone: actor.id, ...metadata });
    add('agent', { type: 'mcp-result', role: actor.id, team: actor.team, tool: 'observe', status: 'completed' });
    replay.push({ type: 'observation', drone: actor.id, capturedAt, simTime: n - 1, mission: 1, imageAvailable: true, imageId: `${actor.id}-${n}.jpg` });
    run.inputs.push({ file: `${replayDirectory}/${actor.id}-${n}.jpg`, bytes: 4, sha256: 'synthetic', state: 'read' });
  }
  replay.push(frame(.5), frame(1), { type: 'end', simTime: 1, reason: 'stopped', omittedImages: 0 });
  run.replayStatus = { state: 'stopped', summary: { simTime: 1, coveredThrough: 1, stock: 50, aboard: 10, lost: 5,
    survivors: roster.map(r => r.id), winner: null, blueDelivered: 20, redDelivered: 0, blueCredits: 0, redCredits: 0, shots: 0 } };
  run.audit = audit.map((data, i) => ({ data, ref: { file: session, line: i + 1 }, order: i + 1 }));
  run.replay = replay.map((data, i) => ({ data, ref: { file: `${replayDirectory}/frames.jsonl`, line: i + 1 }, order: i + 1 }));
  return run;
}
const check = (run: Run, id: string) => evaluate(run, correlate(run)).checks.find(c => c.id === id)!;
function bodyAt(run: Run, actor: string, id = 'b2') {
  return run.audit.find(r => r.data.type === 'agent' && r.data.value?.type === 'tool-result' && r.data.value.role === actor
    && decodeContent(r.data.value.result).body?.nervelet.id === id)!;
}
function editBody(row: Run['audit'][number], edit: (body: any) => void) {
  const body = decodeContent(row.data.value.result).body; edit(body); row.data.value.result.content[0].text = JSON.stringify(body);
}
function addAudit(run: Run, type: string, value: any) {
  const order = run.audit.length + 1; run.audit.push({ data: { type, value, wallTime: time(order * 10) }, ref: { file: session, line: order }, order });
}
async function saved(t: import('node:test').TestContext, run = fixture()) {
  const artifacts = resolve('artifacts'); await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(resolve(artifacts, '.offline-audit-fixture-'));
  t.after(async () => { await safePath(artifacts, directory.slice(artifacts.length + 1)); await rm(directory, { recursive: true, force: true }); });
  await mkdir(resolve(directory, replayDirectory), { recursive: true });
  const files: Record<string, any> = { 'result.json': run.result, 'source-manifest.json': run.manifest, [`${replayDirectory}/status.json`]: run.replayStatus };
  for (const [file, data] of Object.entries(files)) await writeFile(resolve(directory, file), JSON.stringify(data));
  for (const [file, rows] of [[session, run.audit], [`${replayDirectory}/frames.jsonl`, run.replay]] as const)
    await writeFile(resolve(directory, file), rows.map(r => JSON.stringify(r.data)).join('\n') + '\n');
  for (const input of run.inputs) await writeFile(resolve(directory, input.file), Buffer.from([255, 216, 255, 217]));
  return directory;
}

test('mixed MCP text, scalars, ambiguous observations and truncation never choose a convenient object', () => {
  const body = { protocol: 'fleet-observation/5' };
  const mixed = { content: [{ type: 'text', text: 'ordinary text' }, ...[null, 3, [], body].map(v => ({ type: 'text', text: JSON.stringify(v) })), { type: 'image' }] };
  assert.deepEqual(decodeContent(mixed).body, body); assert.equal(decodeContent(mixed).imageCount, 1);
  assert.equal(decodeContent({ content: [...mixed.content, ...content(body).content] }).body, undefined);
  assert.equal(decodeContent({ content: [...mixed.content, { type: 'text', text: '[long text truncated]' }] }).body, undefined);
  assert.deepEqual(decodeContent(content({ protocol: 'fleet-observation/99' })).diagnostics, ['unknown-observation-version']);
});

test('all nested native and structured result errors are extracted without scanning archived text', () => {
  assert.equal(extractErrors({ type: 'agent', value: { type: 'mcp-result', status: 'failed', error: { message: 'nested native failure' } } })[0].message, 'nested native failure');
  assert.equal(extractErrors({ type: 'agent', value: { type: 'tool-result', result: { ...content({ nervelet: { results: [{ id: 'c1', data: { result: { rejected: true, reason: 'no credits' }, isError: true } }] } }), isError: true } } }).some(e => e.domain && e.receiptId === 'c1'), true);
  assert.deepEqual(extractErrors({ type: 'script-source', value: { source: 'throw new Error("archived")' } }), []);
  const ordinaryFirst = { type: 'agent', value: { type: 'tool-result', result: { content: [{ type: 'text', text: 'not JSON' }, ...content({ error: 'actual failure' }).content] } } };
  assert.equal(extractErrors(ordinaryFirst)[0].path, '/value/result/content/1/text');
  assert.equal(extractErrors({ type: 'agent', value: { type: 'runtime-error', message: 'retryable error' } })[0].message, 'retryable error');
  assert.equal(extractErrors({ type: 'tool-error', value: { message: JSON.stringify({ rejected: true, reason: 'invalid waypoint' }) } })[0].domain, true);
  const duplicateEnvelope = { type: 'agent', value: { type: 'tool-result', result: content({ nervelet: { results: [
    { id: 'c1', status: 'rejected', reason: 'no credits', data: { isError: true, result: { rejected: true, reason: 'no credits' } } },
  ] } }) } };
  assert.equal(extractErrors(duplicateEnvelope).length, 1);
});

test('positive fixture passes required checks with recorded roster and historical manifest', () => {
  const run = fixture(), result = evaluate(run, correlate(run));
  assert.equal(result.supported, true);
  assert.deepEqual(result.checks.filter(c => c.required && !['pass', 'not-applicable'].includes(c.status)).map(c => [c.id, c.status]), []);
  assert.equal(check(run, 'cleanup.processes').status, 'inconclusive');
});

test('actor-scoped compact IDs, recovery redelivery and revisions do not fabricate repeated execution', () => {
  const run = fixture();
  for (const actor of roster) for (const id of ['b1', 'b2']) editBody(bodyAt(run, actor.id, id), b => b.nervelet.results = [{ id: 'c1', revision: 1, status: 'completed', data: { result: { accepted: true } } }]);
  const r = evaluate(run, correlate(run));
  assert.equal(r.metrics.receipts.repeatedAppearances, 3);
  assert.equal(check(run, 'receipts.execution').status, 'inconclusive');
  assert.equal(check(run, 'receipts.revisions').status, 'inconclusive'); // consumed revisions are absent
  addAudit(run, 'nervelet-trace', { type: 'admission', drone: 'drone-1', loopRef: 'one', generation: 1, id: 'c1', reason: 'completed' });
  addAudit(run, 'nervelet-trace', { type: 'admission', drone: 'drone-2', loopRef: 'two', generation: 1, id: 'c1', reason: 'completed' });
  assert.equal(check(run, 'receipts.execution').status, 'inconclusive');
  addAudit(run, 'nervelet-trace', { type: 'admission', drone: 'drone-1', loopRef: 'one', generation: 1, id: 'c1', reason: 'completed' });
  assert.equal(check(run, 'receipts.execution').status, 'fail');
});

test('missing submission is inconclusive; acknowledged-before-submitted is a violation', () => {
  const run = fixture(); run.audit = run.audit.filter(r => !(r.data.type === 'nervelet-trace' && r.data.value.type === 'submission' && r.data.value.drone === 'drone-1'));
  assert.equal(check(run, 'observations.submission').status, 'inconclusive');
  assert.equal(check(run, 'receipts.acknowledgement').status, 'inconclusive');
  const other = fixture(); other.audit.find(r => r.data.value?.type === 'acknowledgement')!.order = 0;
  assert.equal(check(other, 'receipts.acknowledgement').status, 'fail');
});

test('missing or overlapping native completions cannot shift onto the next observation', () => {
  const run = fixture(); run.audit = run.audit.filter(r => !(r.data.value?.type === 'mcp-result' && r.data.value.role === 'drone-1' && r.order < 20));
  const joined = correlate(run);
  assert.ok(joined.bundles.filter(b => b.role === 'drone-1').every(b => b.completedMs === undefined));
  assert.equal(check(run, 'observations.submission').status, 'inconclusive');
});

test('honest old images pass, false freshness fails, duplicate acquisition tuples stay ambiguous', () => {
  const run = fixture(); editBody(bodyAt(run, 'drone-1'), b => { b.sensors.camera.ageMs = 3000; b.sensors.camera.fresh = false; b.deliveredAtMs = b.sensors.camera.acquiredAtMs + 3000; });
  assert.equal(check(run, 'camera.delivery').status, 'pass');
  editBody(bodyAt(run, 'drone-1'), b => b.sensors.camera.fresh = true);
  assert.equal(check(run, 'camera.delivery').status, 'fail');
  const another = fixture(), acquisition = another.replay.find(r => r.data.type === 'observation')!;
  another.replay.push({ ...acquisition, data: { ...acquisition.data, imageId: 'different.jpg' } });
  another.inputs.push({ file: `${replayDirectory}/different.jpg`, state: 'read', sha256: 'test' });
  assert.equal(check(another, 'camera.delivery').status, 'inconclusive');
});

test('cancelled or terminal unsubmitted captures are unmatched, not silently discarded', () => {
  const run = fixture(); run.replay.push({ data: { type: 'observation', drone: 'drone-1', simTime: 2, capturedAt: time(999), imageAvailable: false, omission: 'cancelled capture' }, order: 99, ref: { file: `${replayDirectory}/frames.jsonl`, line: 99 } });
  const r = evaluate(run, correlate(run)); assert.equal(r.metrics.cameras.unmatchedAcquisitions, 1); assert.equal(check(run, 'camera.delivery').status, 'inconclusive');
});

test('radio separates living copies, death, player copies, acknowledgement and terminal censoring', () => {
  const run = fixture();
  const m = { protocol: 'fleet-radio/1', id: 'mail', sessionId: 'radio-session', from: 'drone-1', to: 'all' };
  run.audit.unshift({ data: { type: 'radio', wallTime: time(0), value: m }, order: 0, ref: { file: session, line: 1 } });
  editBody(bodyAt(run, 'drone-2'), b => b.events = [{ type: 'radio', message: m }]);
  let r = evaluate(run, correlate(run)); assert.equal(r.metrics.radio.includedCopies, 1); assert.equal(r.metrics.radio.acknowledgedCopies, 0);
  assert.equal(check(run, 'radio.copies').status, 'pass');
  editBody(bodyAt(run, 'drone-2'), b => b.events = []);
  r = evaluate(run, correlate(run)); assert.equal(r.metrics.radio.censoredAtEnd, 1); assert.equal(check(run, 'radio.copies').status, 'inconclusive');
  addAudit(run, 'drone-destroyed', { droneId: 'drone-2' });
  assert.equal(evaluate(run, correlate(run)).metrics.radio.diedBeforeInclusion, 1);
  run.audit.at(-1)!.order = -1;
  assert.equal(evaluate(run, correlate(run)).metrics.radio.alreadyDead, 1);
  addAudit(run, 'radio', { ...m, id: 'player-mail', to: 'player' });
  assert.equal(evaluate(run, correlate(run)).metrics.radio.playerCopies, 1);
});

test('all-frame conservation includes initial earned/lost, reservations, partial loads, spending and crash drops', () => {
  const run = fixture();
  const sequence = [frame(0), frame(.1, 45, 15), frame(.2, 45, 0, 35), frame(.3, 60, 0, 20), frame(.4, 45, 0, 20, 20)];
  // Recoverable drop is already a stock node. Credits/reservations do not enter the equation.
  sequence[3].match.resources = [{ remaining: 45, reserved: 0 }, { remaining: 15, dropped: true }];
  sequence[2].match.teams.blue.credits = 1;
  const header = run.replay[0], end = run.replay.at(-1)!;
  run.replay = [header, ...sequence.map((data, i) => ({ data, order: i + 2, ref: { file: 'frames.jsonl', line: i + 2 } })), end];
  assert.equal(check(run, 'cargo.conservation').status, 'pass');
  sequence[2].match.resources[0].remaining++;
  assert.equal(check(run, 'cargo.conservation').status, 'fail');
  assert.equal((check(run, 'cargo.conservation').measurements.firstDeviation as any).simTime, .2);
  run.replay[0].data.rulesVersion = 'cube-v1'; assert.equal(check(run, 'cargo.conservation').status, 'not-applicable');
});

test('missing conservation fields cannot become zero', () => {
  const run = fixture(); delete run.replay.find(r => r.data.type === 'frame')!.data.match.salvageLost;
  assert.equal(check(run, 'cargo.conservation').status, 'inconclusive');
});

test('valid JSON with missing/wrong-shaped fields produces incomplete checks rather than crashing', async t => {
  const run = fixture();
  run.replay.find(r => r.data.type === 'frame')!.data.drones = [null];
  editBody(bodyAt(run, 'drone-1'), b => { b.events = {}; b.nervelet.results = [null]; });
  addAudit(run, 'radio', null); addAudit(run, 'nervelet-trace', {});
  const directory = await saved(t, run), report = await auditRun(directory);
  assert.equal(report.verdict, 'inconclusive');
});

test('unknown records, capped replay and missing retirement retain coverage gaps', () => {
  const run = fixture(); addAudit(run, 'future-event', {});
  assert.equal(check(run, 'evidence.coverage').status, 'inconclusive');
  run.replay.at(-1)!.data.reason = 'limit'; run.replay.at(-1)!.data.omittedImages = 2;
  assert.equal(check(run, 'recording.final').status, 'inconclusive');
  addAudit(run, 'drone-destroyed', { droneId: 'drone-1' });
  assert.equal(check(run, 'lifecycle.retirement').status, 'inconclusive');
});

test('missing frames or summary fields are inconclusive, contradictory summaries fail', () => {
  const run = fixture(); run.replay = run.replay.filter(r => r.data.type !== 'frame' || r.data.simTime !== .5);
  assert.equal(check(run, 'evidence.coverage').status, 'inconclusive');
  assert.equal(check(run, 'cargo.conservation').status, 'inconclusive');
  const other = fixture(); delete other.replayStatus.summary.shots;
  assert.equal(check(other, 'recording.final').status, 'inconclusive');
  other.replayStatus.summary.shots = 10;
  assert.equal(check(other, 'recording.final').status, 'fail');
});

test('late completion is distinct from a post-death new call or execution', () => {
  const run = fixture();
  addAudit(run, 'agent', { type: 'tool', role: 'drone-1', name: 'wait', arguments: {} });
  addAudit(run, 'drone-destroyed', { droneId: 'drone-1' });
  addAudit(run, 'agent', { type: 'actor-retired', role: 'drone-1' });
  addAudit(run, 'agent', { type: 'mcp-result', role: 'drone-1', tool: 'wait', status: 'failed', error: { message: 'session ended' } });
  assert.notEqual(check(run, 'lifecycle.authority').status, 'fail');
  assert.equal(evaluate(run, correlate(run)).findings.at(-1)?.category, 'lifecycle-cancellation');
  addAudit(run, 'agent', { type: 'tool', role: 'drone-1', name: 'fire', arguments: {} });
  assert.equal(check(run, 'lifecycle.authority').status, 'fail');
});

test('same shutdown-looking error without matching actor/control remains unclassified', () => {
  const run = fixture();
  addAudit(run, 'agent', { type: 'tool', role: 'drone-1', name: 'wait', arguments: {} });
  addAudit(run, 'nervelet-trace', { type: 'control', drone: 'drone-2', reason: 'confirmed' });
  addAudit(run, 'agent', { type: 'mcp-result', role: 'drone-1', tool: 'wait', status: 'failed', error: { message: 'Drone session ended' } });
  assert.equal(evaluate(run, correlate(run)).findings.at(-1)?.category, 'unclassified-error');
  assert.equal(check(run, 'errors.lifecycle').status, 'inconclusive');
});

test('parent stop results classify their own late failures, with team isolation', () => {
  const run = fixture();
  for (const team of ['blue', 'red']) addAudit(run, 'agent', { type: 'tool', role: 'parent', team, name: 'forward_next_instruction' });
  addAudit(run, 'agent', { type: 'tool-result', role: 'parent', team: 'blue', name: 'forward_next_instruction', result: content({ stopped: true }) });
  for (const team of ['red', 'blue']) addAudit(run, 'agent', { type: 'mcp-result', role: 'parent', team, tool: 'forward_next_instruction', status: 'failed', error: { message: 'Transport send error' } });
  assert.deepEqual(evaluate(run, correlate(run)).findings.map(f => f.category), ['unclassified-error', 'lifecycle-cancellation']);
});

test('empty/unsupported evidence cannot pass; current checkout is not the historical manifest', () => {
  const run = fixture(); run.audit = []; run.replay = [];
  assert.equal(check(run, 'profile').status, 'inconclusive');
  const other = fixture(); other.replay[0].data.protocol = 'fleet-replay/99';
  assert.equal(check(other, 'profile').status, 'inconclusive');
  assert.equal(check(other, 'provenance.manifest').status, 'pass');
  other.result.manifestSha256 = 'wrong'; assert.equal(check(other, 'provenance.manifest').status, 'fail');
});

test('same timestamps preserve per-file order; negative wall durations remain visible', () => {
  const run = fixture(); run.audit.forEach(r => r.data.wallTime = time(10));
  assert.equal(check(run, 'observations.submission').status, 'pass');
  run.audit[2].data.wallTime = time(-1); assert.equal(check(run, 'evidence.clocks').status, 'inconclusive');
});

test('reports are deterministic, input-derived and atomic; all CLI exit statuses', async t => {
  const directory = await saved(t), a = await auditRun(directory), b = await auditRun(directory);
  assert.equal(a.verdict, 'pass'); assert.equal(a.reportId, b.reportId); assert.equal(canonical(a), canonical(b));
  await writeReport(directory, a);
  assert.ok((await readFile(resolve(directory, 'audit-report.md'), 'utf8')).includes(a.reportId));
  assert.equal(exitCode(a), 0);
  await execute(process.execPath, ['--import', 'tsx', 'scripts/audit-run.ts', directory]);
  const result = JSON.parse(await readFile(resolve(directory, 'result.json'), 'utf8')); result.manifestSha256 = 'bad';
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(result));
  await assert.rejects(execute(process.execPath, ['--import', 'tsx', 'scripts/audit-run.ts', directory]), (e: any) => e.code === 1);
  result.manifestSha256 = a.run.manifestSha256; result.scenario = 'future-profile';
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(result));
  await assert.rejects(execute(process.execPath, ['--import', 'tsx', 'scripts/audit-run.ts', directory]), (e: any) => e.code === 2);
  await assert.rejects(execute(process.execPath, ['--import', 'tsx', 'scripts/audit-run.ts']), (e: any) => e.code === 2);
});

test('interior corruption fails, truncated tail stays inconclusive and retains locations', async t => {
  const directory = await saved(t);
  await appendFile(resolve(directory, session), '{broken');
  const partial = await auditRun(directory);
  assert.equal(partial.verdict, 'inconclusive'); assert.equal((partial.coverage.issues as Issue[]).at(-1)?.kind, 'truncated-tail');
  await appendFile(resolve(directory, session), '\n');
  const corrupt = await auditRun(directory); assert.equal(corrupt.verdict, 'fail');
  assert.ok((corrupt.coverage.issues as Issue[]).at(-1)?.ref.line);
});

test('record/index limits are explicit and missing images fail without reading pixel payloads', async t => {
  const directory = await saved(t), issues: Issue[] = [];
  await readJsonLines(resolve(directory, session), session, issues, 1);
  assert.ok(issues.some(i => i.kind === 'index-limit'));
  await rm(resolve(directory, replayDirectory, 'drone-1-1.jpg'));
  const report = await auditRun(directory); assert.equal(report.checks.find(c => c.id === 'camera.delivery')?.status, 'fail');
  await writeFile(resolve(directory, replayDirectory, 'drone-1-1.jpg'), Buffer.alloc(512 * 1024 + 1));
  const limited = await auditRun(directory); assert.equal(limited.checks.find(c => c.id === 'camera.delivery')?.status, 'inconclusive');
});

test('changing input is detected and output publication refuses linked destinations', async t => {
  const directory = await saved(t);
  await assert.rejects(loadRun(directory, { validateMetadata: async () => {
    await appendFile(resolve(directory, 'result.json'), ' ');
  } }), /Input changed/);
  const report = await auditRun(directory);
  await writeFile(resolve(directory, 'audit-report.json'), 'prior output');
  await symlink(resolve(directory, replayDirectory), resolve(directory, 'audit-report.md'), 'junction');
  await assert.rejects(writeReport(directory, report), /Linked/);
  assert.equal(await readFile(resolve(directory, 'audit-report.json'), 'utf8'), 'prior output');
  await rm(resolve(directory, 'audit-report.md'));
});

test('haul analyzer retains output contract and corrects nonzero initial earned/lost', async t => {
  const directory = await saved(t);
  await execute(process.execPath, ['--import', 'tsx', 'scripts/analyze-haul.ts', directory]);
  const result = JSON.parse(await readFile(resolve(directory, 'haul-analysis.json'), 'utf8'));
  assert.equal(result.conservationDelta, 0); assert.equal(result.initialStock, 50); assert.equal(result.deliveredSalvage, 20);
  assert.deepEqual(result.errors, []); assert.deepEqual(result.recordedErrors, []);
});

test('active markers and recording state block standalone auditing; runner exception is process-scoped', async t => {
  const directory = await saved(t);
  await writeFile(resolve(directory, '.run.json'), JSON.stringify({ schema: 'fleet-test-artifacts/1', pid: process.pid, completed: false }));
  await assert.rejects(auditRun(directory), /active managed run/);
  assert.equal((await auditRun(directory, { closedByRunner: true })).verdict, 'pass');
  await writeFile(resolve(directory, replayDirectory, 'status.json'), JSON.stringify({ state: 'recording' }));
  await assert.rejects(auditRun(directory, { closedByRunner: true }), /still recording/);
});

test('path escapes and junctions reject safely and preserve existing output', async t => {
  const directory = await saved(t);
  await writeFile(resolve(directory, 'audit-report.json'), 'preserve');
  const metadata = { ...fixture().result, sessionId: '../session-escape.jsonl', directory: 'C:/untrusted' };
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(metadata));
  await assert.rejects(auditRun(directory), /Invalid session/);
  assert.equal(await readFile(resolve(directory, 'audit-report.json'), 'utf8'), 'preserve');
  await assert.rejects(safePath(directory, '../outside'), /Unsafe/);
  const linked = resolve(directory, 'linked'); await symlink(resolve(directory, replayDirectory), linked, 'junction');
  await assert.rejects(safePath(directory, 'linked/status.json'), /Linked/);
  // Remove the owned junction itself before recursive fixture cleanup.
  await rm(linked);
});

test('host finalization closes writers, collects, saves final result, audits; primary failures win', async t => {
  const directory = await saved(t), order: string[] = [], result: any = { ...fixture().result, failures: ['primary trial failure'] };
  const host = { failures: [], warnings: [], game: { state: { running: true }, sessionIdentity: 'owned' }, async close() { order.push('close'); this.game.state.running = false; } };
  const code = await finalizeFocusedTrial(directory, result, host, { collectNetwork() { order.push('collect'); } }, async () => {
    order.push('audit'); const stored = JSON.parse(await readFile(resolve(directory, 'result.json'), 'utf8'));
    assert.equal(stored.cleanup, 'complete'); assert.equal(stored.stopped, true); return 2;
  });
  assert.deepEqual(order, ['close', 'collect', 'audit']); assert.equal(code, 1);
  result.failures = [];
  assert.equal(await finalizeFocusedTrial(directory, result, host, { collectNetwork() {} }, async () => { throw new Error('audit failure'); }), 2);
  assert.equal(result.cleanup, 'complete');
});

test('failed cleanup skips reading; failing initial evidence writes cannot prevent close', async t => {
  const directory = await saved(t), result: any = { failures: [] }; let closed = 0, audited = 0;
  const host = { failures: [], warnings: [], game: { state: { running: false }, sessionIdentity: 'owned' }, async close() { closed++; throw new Error('writer open'); } };
  assert.equal(await finalizeFocusedTrial(directory, result, host, { collectNetwork() { assert.fail('collect before close'); } }, async () => { audited++; return 0; }), 1);
  assert.equal(audited, 0); assert.equal(closed, 1);
  const missing = resolve(directory, 'missing');
  assert.equal(await finalizeFocusedTrial(missing, { failures: [] }, { ...host, async close() { closed++; } }, { collectNetwork() {} }), 1);
  assert.equal(closed, 2);
});
