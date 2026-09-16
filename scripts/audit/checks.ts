import { hash } from './load-run.ts';
import { object, knownObservation, extractErrors, decodeContent } from './decode.ts';
import { bundleKey, indexBy, type Correlated } from './correlate.ts';
import type { Check, Finding, RecordAt, Ref, Run, Status } from './types.ts';

const refs = (rows: RecordAt[]) => rows.map(r => r.ref);
const finite = (v: any): v is number => typeof v === 'number' && Number.isFinite(v);
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const list = (value: any): any[] => Array.isArray(value) ? value : [];
const status = (violations: unknown[], complete: boolean): Status => violations.length ? 'fail' : complete ? 'pass' : 'inconclusive';

/** Explicit current recording profile. Historical analyzers remain independent. */
export function evaluate(run: Run, c: Correlated) {
  const checks: Check[] = [], metrics: Record<string, any> = {};
  const headers = run.replay.filter(r => r.data.type === 'header'), header = headers[0]?.data;
  const rules = typeof header?.rulesVersion === 'string' ? header.rulesVersion : 'unrecorded';
  const cargo = ['cargo-v1', 'cargo-v2', 'cargo-v3'].includes(rules);
  const frames = run.replay.filter(r => r.data.type === 'frame'), end = run.replay.findLast(r => r.data.type === 'end');
  const roster: { id: string; team: string }[] = list(header?.roster).filter(r => typeof r?.id === 'string').map(r => ({ ...r,
    team: r.team ?? list(frames[0]?.data.drones).find(d => d?.id === r.id)?.team })).filter(r => typeof r.team === 'string');
  const rosterValid = roster.length > 0 && roster.length === header?.roster?.length && new Set(roster.map(r => r.id)).size === roster.length;
  const supported = header?.protocol === 'fleet-replay/1' && cargo && rosterValid && typeof run.result.scenario === 'string'
    && ['match', 'haul-single', 'haul-team', 'attention', 'flight', 'aim-stationary', 'aim-moving', 'encounter', 'encounter-reversed'].includes(run.result.scenario);
  const auditClean = Boolean(run.audit.length) && !run.issues.some(i => i.ref.file === run.sessionFile);
  const sampleInterval = header?.sampleInterval;
  const frameGaps = finite(sampleInterval) && sampleInterval > 0 ? frames.filter((r, i) => i > 0 && r.data.simTime - frames[i - 1].data.simTime >= 2 * sampleInterval - 1e-6) : [];
  const incompleteRosters = rosterValid ? frames.filter(r => !same(list(r.data.drones).map(d => d?.id).sort(), roster.map(d => d.id).sort())) : [];
  const replayClean = Boolean(frames.length) && !run.issues.some(i => i.ref.file.endsWith('/frames.jsonl')) && end?.data.reason === 'stopped'
    && finite(sampleInterval) && sampleInterval > 0 && !frameGaps.length && !incompleteRosters.length;
  const knownBodies = c.bundles.length > 0 && c.bundles.every(b => knownObservation(b.body) && b.body.nervelet?.schemaVersion === 2 && Array.isArray(b.body.events));
  const terminal = run.result.cleanup === 'complete' && run.result.stopped === true && end?.data.reason === 'stopped';
  function add(id: string, verdict: Status, summary: string, measurements: Record<string, unknown>, evidence: Ref[],
    prerequisites: string[], limitations: string[] = [], required = true) {
    if (header?.protocol !== 'fleet-replay/1' && /^(opening|camera|cargo|radio|lifecycle|recording)\./.test(id)) verdict = 'inconclusive';
    checks.push({ id, status: verdict, required, severity: verdict === 'fail' ? 'error' : verdict === 'inconclusive' ? 'warning' : 'info',
      rules: [rules], summary, measurements, prerequisites, evidence: evidence.slice(0, 8), evidenceTotal: evidence.length,
      examplesOmitted: Math.max(0, evidence.length - 8), limitations });
  }
  add('profile', supported ? 'pass' : 'inconclusive', supported ? 'Supported saved cargo trial profile' : 'Unsupported or incomplete recording profile',
    { scenario: run.result.scenario ?? null, replay: header?.protocol ?? null, roster: roster.length }, refs(headers), ['Known replay, rules, scenario and recorded roster']);
  const digest = Object.keys(run.manifest).length ? hash(JSON.stringify(run.manifest)) : null;
  add('provenance.manifest', digest && run.result.manifestSha256 ? digest === run.result.manifestSha256 ? 'pass' : 'fail' : 'inconclusive',
    'Verify the recorded manifest using the writer’s JSON.stringify serialization', { recorded: run.result.manifestSha256 ?? null, computed: digest },
    [{ file: 'source-manifest.json' }, { file: 'result.json', pointer: '/manifestSha256' }], ['Recorded manifest and digest'],
    ['Historical source identity is separate from the auditor; no current-checkout equality is required. Manifest paths are never opened.']);
  const corrupt = run.issues.filter(i => i.kind === 'corrupt-record');
  const unknownReplay = run.replay.filter(r => !['header', 'frame', 'command', 'observation', 'event', 'script-source', 'execution', 'cancellation', 'radio', 'end'].includes(r.data.type));
  const unknownAudit = run.audit.filter(r => !['camera', 'combat', 'trial-fixture', 'attention-config', 'mavlink', 'network', 'agent', 'runtime', 'nervelet-trace', 'observation', 'radio', 'tool', 'drone-destroyed', 'match-ended', 'tool-error', 'transport-error', 'trial-error', 'replay-warning', 'routine', 'acoustic-metrics', 'player-radio', 'radio-delivery', 'network-link'].includes(r.data.type));
  const redacted = run.audit.filter(r => /\[(?:long text truncated|nested content omitted)\]/.test(JSON.stringify(r.data)));
  const malformedEnvelopes = run.audit.filter(r => !object(r.data.value));
  add('evidence.coverage', status(corrupt, auditClean && replayClean && run.issues.length === 0 && !unknownReplay.length && !unknownAudit.length && !redacted.length && !malformedEnvelopes.length && terminal),
    'Readable, bounded, stopped evidence with explicit gaps', { auditRecords: run.audit.length, replayRecords: run.replay.length,
      issues: run.issues.length, unknownAudit: unknownAudit.length, unknownReplay: unknownReplay.length, redactedRecords: redacted.length,
      malformedEnvelopes: malformedEnvelopes.length, frameGaps: frameGaps.length, incompleteRosters: incompleteRosters.length,
      largestFrameInterval: Math.max(0, ...frames.slice(1).map((r, i) => r.data.simTime - frames[i].data.simTime)) },
    [...run.issues.map(i => i.ref), ...refs(unknownAudit), ...refs(unknownReplay), ...refs(redacted), ...refs(malformedEnvelopes), ...refs(frameGaps), ...refs(incompleteRosters)], ['Complete audit and replay, terminal writer evidence'],
    ['A gap of at least two nominal sample intervals is incomplete sampled coverage, not proof of a recorder defect. Diagnostic arrays/objects can be silently bounded by the writer; absence of an event is not proof of absence of its effect.']);
  const clockAnomalies: RecordAt[] = [];
  for (const rows of [run.audit, run.replay]) {
    let previous: number | undefined;
    for (const r of rows) {
      const time = rows === run.audit ? Date.parse(r.data.wallTime) : r.data.simTime;
      // Acquisitions carry capture time and can be persisted after newer frames;
      // order of asynchronous evidence is not a simulation-clock regression.
      if (rows === run.replay && r.data.type !== 'frame') continue;
      if (!finite(time) || previous !== undefined && time < previous) clockAnomalies.push(r);
      if (finite(time)) previous = time;
    }
  }
  for (const b of c.bundles) if (Date.parse(b.body.deliveredAt) < Date.parse(b.body.sensors?.camera?.acquiredAt)) clockAnomalies.push(b.record);
  metrics.clockAnomalies = clockAnomalies.length;
  add('evidence.clocks', clockAnomalies.length ? 'inconclusive' : auditClean && replayClean ? 'pass' : 'inconclusive',
    'Wall-clock and simulation order checked separately', { anomalies: clockAnomalies.length }, refs(clockAnomalies), ['Timestamped records'],
    ['Negative intervals are not clamped. Host monotonic values are compared only within one recorded bundle/loop. Cross-file equal times do not imply order.']);

  const submitted = c.bundles.filter(b => b.submission);
  metrics.protocol = { assembled: c.traces.filter(r => r.data.value.type === 'assembly').length,
    submitted: c.traces.filter(r => r.data.value.type === 'submission').length, decodedBodies: c.bundles.length,
    nativeCompletions: run.audit.filter(r => r.data.type === 'agent' && r.data.value?.type === 'mcp-result').length,
    acknowledgements: c.traces.filter(r => r.data.value.type === 'acknowledgement').length,
    ambiguousNativeJoins: c.bundles.filter(b => b.join === 'ambiguous').length, unmatchedNativeJoins: c.bundles.filter(b => b.join === 'unmatched').length };
  add('observations.submission', status([], auditClean && knownBodies && !c.issues.length && submitted.length === c.bundles.length && c.bundles.every(b => b.assembly && b.join === 'actor-tool-fifo')),
    'Assembly, host submission and native completion remain distinct', metrics.protocol, c.issues.map(i => i.ref), ['Known observation schema, unique bundle traces, unambiguous per-actor/tool FIFO'],
    ['No end-to-end native call ID is recorded. Missing/overlapping calls stay ambiguous; terminal unsubmitted work is not treated as delivered.']);

  // Opening is about actual submitted mission events, not an assembled goal string.
  const opening = roster.map(actor => ({ actor: actor.id, bundle: submitted.find(b => b.role === actor.id
    && list(b.body.events).some((e: any) => e?.type === 'player' && e.mission > 0)) }));
  const gateEnd = Math.max(-1, ...opening.map(o => o.bundle?.submission?.order ?? -1));
  const openingViolation = opening.filter(o => o.bundle && o.bundle.body.deliverySimTime !== 0).map(o => o.bundle!.record);
  const earlyEffects = c.traces.filter(r => r.order < gateEnd && r.data.value.type === 'admission' && r.data.value.reason === 'accepted'
    && ['act', 'route', 'buy', 'fire', 'rearm', 'routine'].includes(run.audit.findLast(call => call.order < r.order && call.data.type === 'agent'
      && call.data.value?.type === 'tool' && call.data.value.role === r.data.value.drone)?.data.value.name));
  // Game 'tool' logs precede its launch guard: rejected attempts are not effects.
  const gateReady = submitted.filter(b => b.body.launchReady === true);
  const prematureReady = gateReady.filter(b => b.record.order < gateEnd).map(b => b.record);
  const openingComplete = auditClean && knownBodies && rosterValid && opening.every(o => o.bundle) && gateReady.length > 0 && frames[0]?.data.simTime === 0;
  add('opening.objective', run.result.scenario !== 'match' ? 'not-applicable' : status([...openingViolation, ...earlyEffects, ...prematureReady], openingComplete),
    run.result.scenario === 'match' ? 'Opening objectives submitted at simulation zero before observed flight/spending gate release' : 'Normal-match opening gate is not asserted for arranged scenarios',
    { pilots: roster.length, openingSubmissions: opening.filter(o => o.bundle).length, readyBundles: gateReady.length, earlyEffects: earlyEffects.length },
    refs([...openingViolation, ...earlyEffects, ...prematureReady, ...opening.flatMap(o => o.bundle?.submission ? [o.bundle.submission] : [])]),
    ['Recorded roster, submitted player objectives, initial zero-time frame and ready bundle'], [], run.result.scenario === 'match');

  const cameraViolations: RecordAt[] = [], ageMissing: RecordAt[] = [];
  let cameraCount = 0, honestOld = 0;
  for (const b of submitted) {
    const camera = b.body.sensors?.camera ?? b.body.camera;
    if (!knownObservation(b.body)) { ageMissing.push(b.record); continue; }
    if (typeof camera?.available !== 'boolean') { ageMissing.push(b.record); continue; }
    if (camera.available) {
      cameraCount++;
      if (b.imageCount !== 1) cameraViolations.push(b.record);
      if (!finite(camera.ageMs) || !finite(camera.acquiredAtMs) || !finite(b.body.deliveredAtMs) || typeof camera.fresh !== 'boolean') ageMissing.push(b.record);
      else {
        const expected = b.body.deliveredAtMs - camera.acquiredAtMs;
        if (expected < 0 || Math.abs(expected - camera.ageMs) > .01 || camera.ageMs > 2000 && camera.fresh) cameraViolations.push(b.record);
        if (camera.ageMs > 2000 && camera.fresh === false) honestOld++;
      }
    } else if (b.imageCount) cameraViolations.push(b.record);
  }
  const missingFiles = c.acquisitions.filter(a => a.data.imageAvailable && (!a.data.imageId || run.inputs.find(i => i.file === `${run.replayDirectory}/${a.data.imageId}`)?.state === 'missing'));
  const imageIds = indexBy(c.acquisitions.filter(a => a.data.imageId), a => a.data.imageId);
  const repeatedFiles = [...imageIds.values()].filter(a => a.length > 1).flat();
  const orphanAcquisitions = c.acquisitions.filter(a => !submitted.some(b => b.acquisition === a));
  metrics.cameras = { submittedWithImage: cameraCount, replayAcquisitions: c.acquisitions.length, hashedFiles: run.inputs.filter(i => /\.(jpg|jpeg|png)$/.test(i.file) && i.sha256).length,
    missingFiles: missingFiles.length, repeatedImageIdentities: repeatedFiles.length, unmatchedAcquisitions: orphanAcquisitions.length, honestImagesOverTwoSeconds: honestOld,
    omissions: c.acquisitions.filter(a => a.data.omission || !a.data.imageAvailable).length };
  add('camera.delivery', status([...cameraViolations, ...missingFiles, ...repeatedFiles], auditClean && replayClean && knownBodies && cameraCount > 0 && !ageMissing.length
    && !c.issues.some(i => i.kind.includes('camera')) && !orphanAcquisitions.length && submitted.every(b => !b.body.sensors?.camera?.available || b.acquisition)
    && c.acquisitions.every(a => !a.data.imageAvailable || run.inputs.some(i => i.file === `${run.replayDirectory}/${a.data.imageId}` && i.state === 'read' && i.sha256))),
    'Reconcile submitted MCP images, honest age and recorded acquisitions/files', metrics.cameras,
    refs([...cameraViolations, ...missingFiles, ...repeatedFiles, ...ageMissing, ...orphanAcquisitions]), ['Known camera fields, unique acquisition tuples and hashed image files'],
    ['Current recordings join by unique actor/acquisition-time/simulation-time tuple; multiplicity is preserved. Unmatched acquisitions may be aborted or terminal work.',
      'Image files are hashed, but redacted MCP pixels cannot establish byte-for-byte delivery fidelity. Camera freshness is descriptive; range expiry is a separate physical policy.']);

  const ackTraces = c.traces.filter(t => t.data.value.type === 'acknowledgement'), badAcks: RecordAt[] = [], absentAcks: RecordAt[] = [];
  let revisions = 0, missingRevisions = 0, receiptAppearances = 0, receiptRepeats = 0;
  const receipts = new Set<string>();
  for (const b of submitted) for (const receipt of Array.isArray(b.body.nervelet?.results) ? b.body.nervelet.results : []) {
    receiptAppearances++;
    if (!object(receipt)) { missingRevisions++; continue; }
    const key = JSON.stringify([b.body.sessionId, b.role, b.body.nervelet.loopRef, receipt.id, receipt.revision ?? null, receipt.status, receipt.data]);
    if (receipts.has(key)) receiptRepeats++; receipts.add(key);
    if (receipt.revision === undefined) missingRevisions++; else revisions++;
  }
  for (const ack of ackTraces) {
    const b = submitted.find(b => bundleKey(b.role, b.body.nervelet) === bundleKey(ack.data.value.drone, ack.data.value));
    if (!b) absentAcks.push(ack);
    else if (ack.order <= b.submission!.order) badAcks.push(ack);
    else if (!run.audit.some(r => r.order > b.submission!.order && r.order < ack.order && r.data.type === 'agent' && r.data.value?.type === 'tool'
      && r.data.value.role === b.role && r.data.value.arguments?.seen === b.body.nervelet.id)) absentAcks.push(ack);
  }
  const seenCalls = run.audit.filter(r => r.data.type === 'agent' && r.data.value?.type === 'tool' && r.data.value.arguments?.seen);
  let rejectedOrMissingSeen = 0;
  for (const r of seenCalls) {
    const v = r.data.value;
    if (!submitted.some(b => b.role === v.role && b.body.nervelet?.id === v.arguments.seen && b.submission!.order < r.order)) rejectedOrMissingSeen++;
  }
  metrics.receipts = { appearances: receiptAppearances, repeatedAppearances: receiptRepeats, explicitRevisions: revisions,
    missingRevisions, echoedSeenCalls: seenCalls.length, rejectedOrUnmatchedSeen: rejectedOrMissingSeen,
    unacknowledgedBundles: submitted.filter(b => !b.acknowledgements.length).length,
    terminalUnacknowledgedBundles: submitted.filter(b => !b.acknowledgements.length && !submitted.some(later => later.role === b.role && later.record.order > b.record.order)).length };
  add('receipts.acknowledgement', status(badAcks, auditClean && knownBodies && ackTraces.length > 0 && !absentAcks.length),
    'Recorded acknowledgements refer to previously submitted actor-scoped bundles', { traces: ackTraces.length, ...metrics.receipts }, refs([...badAcks, ...absentAcks]),
    ['Submitted bundle identity, actor/loop/generation and acknowledgement traces'], ['Unacknowledged terminal bundles are censored; a rejected seen request is not an acknowledgement.']);
  add('receipts.revisions', receiptAppearances === 0 && auditClean && knownBodies ? 'not-applicable' : 'inconclusive',
    'Exact acknowledged result revisions require revision-bearing acknowledgement evidence', { receiptAppearances, revisions, missingRevisions },
    submitted.filter(b => b.body.nervelet?.results?.length).slice(0, 8).map(b => b.record.ref), ['Included result revisions and matching consumed revisions'],
    ['Current traces omit consumed revision lists. Repeated recovery payloads are appearances, not duplicate effects.'], false);
  const executions = run.replay.filter(r => r.data.type === 'execution');
  // The pinned core emits admission only for a new command, never for a retry.
  // Duplicate successful admissions in one loop therefore violate deduplication.
  const admissions = c.traces.filter(r => r.data.value.type === 'admission' && ['accepted', 'completed'].includes(r.data.value.reason));
  const executionKeys = indexBy(admissions, r => JSON.stringify([r.data.value.drone, r.data.value.loopRef, r.data.value.id]));
  const duplicates = [...executionKeys.values()].filter(rows => rows.length > 1).flat();
  add('receipts.execution', duplicates.length ? 'fail' : 'inconclusive', 'Exactly-once effects need execution identities, not deduplicated receipts',
    { executionRecords: executions.length, duplicateExecutions: duplicates.length }, refs(duplicates), ['Authoritative command/effect identities'],
    ['Current replay commands omit native command IDs; aggregate receipt uniqueness cannot prove exactly-once execution.'], false);

  // Reservations remain in remaining stock; drops are resource nodes already.
  function totals(frame: any) {
    if (!Array.isArray(frame?.drones) || !Array.isArray(frame.match?.resources) || !object(frame.match?.teams) || !finite(frame.match.salvageLost)) return;
    const stock = frame.match.resources.map((r: any) => r?.remaining), aboard = frame.drones.map((d: any) => d?.cargo?.amount);
    const earned = Object.values(frame.match.teams).map((t: any) => t?.earned);
    if (![...stock, ...aboard, ...earned].every(finite) || !earned.length) return;
    return { stock: sum(stock), aboard: sum(aboard), earned: sum(earned), lost: frame.match.salvageLost,
      total: sum([...stock, ...aboard, ...earned, frame.match.salvageLost]), negative: [...stock, ...aboard, ...earned, frame.match.salvageLost].some(v => v < 0) };
  }
  const initial = totals(frames[0]?.data), checked = frames.map(r => ({ record: r, totals: totals(r.data) }));
  const deviating = initial ? checked.filter(r => r.totals && (r.totals.negative || Math.abs(r.totals.total - initial.total) > 1e-6)) : [];
  metrics.conservation = { frames: frames.length, checked: checked.filter(r => r.totals).length, initial: initial ?? null, final: checked.at(-1)?.totals ?? null,
    firstDeviation: deviating[0] ? { simTime: deviating[0].record.data.simTime, delta: deviating[0].totals!.total - initial!.total } : null,
    maxDeviation: initial ? Math.max(0, ...checked.map(r => r.totals ? Math.abs(r.totals.total - initial.total) : 0)) : null };
  add('cargo.conservation', !cargo ? 'not-applicable' : status(deviating, replayClean && !!initial && checked.every(r => r.totals) && frames[0]?.data.simTime === 0),
    cargo ? 'Stock + aboard + cumulative earned + cumulative lost in every available frame' : 'Historical non-cargo rules are not interpreted as cargo',
    metrics.conservation, refs(deviating.map(r => r.record)), ['Cargo rules, initial frame and all four finite counters'],
    ['Initial earned/lost are included. Spending does not subtract from earned. Reservations/drops are not counted twice. Unsampled intervals are not a continuous proof.'], cargo);

  const deaths = run.audit.filter(r => r.data.type === 'drone-destroyed' && object(r.data.value)), postDeath: RecordAt[] = [], retirementMissing: RecordAt[] = [];
  const replayDeaths = run.replay.filter(r => r.data.type === 'event' && r.data.event?.type === 'destroyed');
  for (const d of deaths) {
    const actor = d.data.value?.droneId;
    postDeath.push(...run.audit.filter(r => r.order > d.order && (r.data.type === 'tool' && r.data.value?.drone === actor
      || r.data.type === 'agent' && r.data.value?.type === 'tool' && r.data.value.role === actor
      || r.data.type === 'nervelet-trace' && r.data.value?.type === 'admission' && r.data.value.drone === actor)));
    if (!run.audit.some(r => r.order > d.order && r.data.type === 'agent' && r.data.value?.type === 'actor-retired' && r.data.value.role === actor)) retirementMissing.push(d);
  }
  for (const d of replayDeaths) postDeath.push(...executions.filter(e => e.order > d.order && e.data.drone === d.data.event.drone && !e.data.error && e.data.outcome?.rejected !== true));
  const lifecycleComplete = auditClean && replayClean && terminal
    && same(replayDeaths.map(d => d.data.event.drone).sort(), deaths.map(d => d.data.value?.droneId).sort());
  add('lifecycle.authority', deaths.length === 0 && lifecycleComplete ? 'not-applicable' : status(postDeath, lifecycleComplete && deaths.length > 0),
    'New invocations/admissions and recorded effects after death are separate from late completions', { deaths: deaths.length, postDeathEffectsOrCalls: postDeath.length },
    refs(postDeath.length ? postDeath : deaths), ['Authoritative death order and complete tool/execution coverage'],
    ['Native completion logs of calls already in flight do not constitute new effects. Immediate revocation is observed only at recorded boundaries.']);
  add('lifecycle.retirement', deaths.length === 0 && lifecycleComplete ? 'not-applicable' : retirementMissing.length ? 'inconclusive' : lifecycleComplete ? 'pass' : 'inconclusive',
    'Each recorded death has a later actor-retired event', { deaths: deaths.length, missingRetirement: retirementMissing.length }, refs(retirementMissing.length ? retirementMissing : deaths), ['Death and terminal retirement evidence']);

  // Team membership comes from the saved roster; actor liveness from ordered death events.
  const sends = run.audit.filter(r => r.data.type === 'radio' && object(r.data.value) && r.data.value.from !== 'player');
  const radioMetrics = { sends: sends.length, nominalCopies: 0, includedCopies: 0, acknowledgedCopies: 0, storedCopies: 0,
    alreadyDead: 0, diedBeforeInclusion: 0, expiredOrRejected: 0, censoredAtEnd: 0, unknownRecipient: 0, playerCopies: 0, repeatedAppearances: 0 };
  const radioEvidence: RecordAt[] = [], radioViolations: RecordAt[] = [];
  for (const send of sends) {
    const m = send.data.value, team = roster.find(a => a.id === m.from)?.team;
    if (m.to === 'player') { radioMetrics.playerCopies++; continue; }
    const recipients = m.to === 'all' ? roster.filter(a => a.team === team && a.id !== m.from) : roster.filter(a => a.id === m.to && a.team === team);
    if (!team || !recipients.length || !m.id) { radioMetrics.unknownRecipient++; radioEvidence.push(send); continue; }
    for (const recipient of recipients) {
      radioMetrics.nominalCopies++;
      const death = deaths.find(d => d.data.value.droneId === recipient.id);
      const inclusions = submitted.filter(b => b.role === recipient.id && list(b.body.events).some((e: any) => e?.type === 'radio' && e.message?.id === m.id && e.message?.sessionId === m.sessionId));
      const stages = run.replay.filter(r => r.data.type === 'radio' && r.data.message?.id === m.id && r.data.message?.sessionId === m.sessionId);
      if (stages.some(r => list(r.data.message.delivery?.storedBy).includes(recipient.id))) radioMetrics.storedCopies++;
      if (death && death.order < send.order) radioMetrics.alreadyDead++;
      if (inclusions.length) {
        radioMetrics.includedCopies++; radioMetrics.repeatedAppearances += inclusions.length - 1;
        if (inclusions.some(b => b.acknowledgements.length)) radioMetrics.acknowledgedCopies++;
        if (inclusions.some(b => b.submission!.order < send.order)) radioViolations.push(send);
      } else if (death && death.order > send.order) radioMetrics.diedBeforeInclusion++;
      else if (stages.some(r => r.data.message.delivery?.error && m.to === recipient.id)) radioMetrics.expiredOrRejected++;
      else if (!death || death.order > send.order) { radioMetrics.censoredAtEnd++; radioEvidence.push(send); }
    }
  }
  metrics.radio = radioMetrics;
  add('radio.copies', sends.length === 0 && auditClean && replayClean ? 'not-applicable' : status(radioViolations, auditClean && knownBodies && rosterValid && sends.length > 0 && radioMetrics.unknownRecipient === 0 && radioMetrics.censoredAtEnd === 0),
    'Recipient copies distinguish inclusion, acknowledgement, death and cutoff censoring', radioMetrics, refs([...radioViolations, ...radioEvidence]),
    ['Accepted sends, recorded roster, submitted inboxes and authoritative lifecycle order'],
    ['Alive at send does not guarantee delivery before cutoff. Censored/delayed copies are not integrity failures. Player copies are excluded. Storage is never inferred from inclusion.']);

  const findings: Finding[] = [], groups = new Map<string, Finding>();
  for (const [rowIndex, row] of run.audit.entries()) for (const error of extractErrors(row.data)) {
    const v = row.data.value, actor = v?.role ?? v?.drone ?? v?.droneId ?? 'system', operation = v?.name ?? v?.tool;
    const native = c.boundary.calls.find(call => !call.ambiguous && (call.resultIndex === rowIndex || call.completionIndex === rowIndex));
    const b = native?.delivery;
    const call = native?.callIndex === undefined ? undefined : run.audit[native.callIndex];
    let boundary = call && run.audit.find(r => r.order > call.order && r.order < row.order
      && (r.data.type === 'drone-destroyed' && r.data.value?.droneId === actor || r.data.type === 'nervelet-trace' && r.data.value?.drone === actor && r.data.value.type === 'control' && r.data.value.reason === 'confirmed'));
    const output = native?.resultIndex === undefined ? undefined : run.audit[native.resultIndex];
    if (!boundary && call && output && output.order < row.order && decodeContent(output.data.value?.result).values.some(v => object(v) && v.stopped === true)) boundary = output;
    const cancellationMessage = /session ended|cancelled|canceled|aborted|transport send error/i.test(error.message);
    const category: Finding['category'] = error.domain ? 'domain-rejection' : boundary && cancellationMessage ? 'lifecycle-cancellation'
      : /^(trial-error|transport-error|tool-error)$/.test(row.data.type) ? 'unexpected-failure' : 'unclassified-error';
    const reference = { ...row.ref, pointer: error.path };
    // Payload redelivery can group only with actor/loop/receipt identity, or a
    // positively paired native call. Message similarity/time proximity is not a join.
    const group = error.receiptId && b ? JSON.stringify([actor, b.body.sessionId, b.body.nervelet.loopRef, error.receiptId, error.revision ?? null, error.message])
      : call ? JSON.stringify([actor, v?.team, call.order, boundary?.order, category === 'lifecycle-cancellation' ? category : error.message]) : `${row.order}:${error.path}`;
    const existing = groups.get(group);
    if (existing) existing.appearances.push(reference);
    else { const f: Finding = { category, actor, operation, message: error.message, appearances: [reference], ...(boundary ? { boundary: boundary.ref } : {}) }; groups.set(group, f); findings.push(f); }
  }
  for (const [i, message] of (Array.isArray(run.result.failures) ? run.result.failures : []).entries()) findings.push({ category: 'unexpected-failure', actor: 'host', message: String(message), appearances: [{ file: 'result.json', pointer: `/failures/${i}` }] });
  const unexpected = findings.filter(f => f.category === 'unexpected-failure'), unclassified = findings.filter(f => f.category === 'unclassified-error');
  metrics.errors = { incidents: findings.length, rawAppearances: sum(findings.map(f => f.appearances.length)),
    nativeFailedCompletions: run.audit.filter(r => r.data.type === 'agent' && r.data.value?.type === 'mcp-result' && (r.data.value.error || r.data.value.status === 'failed')).length,
    categories: Object.fromEntries(['domain-rejection', 'lifecycle-cancellation', 'unexpected-failure', 'unclassified-error'].map(k => [k, findings.filter(f => f.category === k).length])) };
  add('errors.lifecycle', unexpected.length ? 'fail' : unclassified.length || !auditClean || !terminal ? 'inconclusive' : 'pass',
    'Nested errors and lifecycle evidence classified without excusing EOF-adjacent failures', metrics.errors, findings.flatMap(f => f.appearances), ['Complete error envelopes and matching operation/control boundaries'],
    ['Ordinary input rejection is a metric. Unclassified failures remain visible; neither message text nor proximity to shutdown proves cancellation.']);

  const events = run.replay.filter(r => r.data.type === 'event');
  const summary = run.replayStatus.summary, last = frames.at(-1), lastTotals = totals(last?.data), recordingViolations: Ref[] = [], missingSummaryFields: string[] = [];
  if (summary && last && end?.data.reason === 'stopped' && summary.coveredThrough === last.data.simTime) {
    const expected: Record<string, any> = { simTime: end.data.simTime, stock: lastTotals?.stock, aboard: lastTotals?.aboard, lost: lastTotals?.lost,
      survivors: list(last.data.drones).filter((d: any) => d?.alive !== false).map((d: any) => d?.id), winner: last.data.match?.winner,
      blueDelivered: last.data.match?.teams?.blue?.earned, redDelivered: last.data.match?.teams?.red?.earned,
      blueCredits: last.data.match?.teams?.blue?.credits, redCredits: last.data.match?.teams?.red?.credits, shots: events.filter(r => r.data.event?.type === 'fired').length };
    for (const [key, value] of Object.entries(expected)) {
      if (value === undefined || summary[key] === undefined) missingSummaryFields.push(key);
      else if (!same(summary[key], value)) recordingViolations.push({ file: `${run.replayDirectory}/status.json`, pointer: `/summary/${key}` });
    }
  }
  metrics.battle = { shots: events.filter(r => r.data.event?.type === 'fired').length, deaths: replayDeaths.length,
    bulletKills: replayDeaths.filter(r => r.data.event.cause === 'bullet').length, finalSummary: summary ?? null };
  metrics.jobs = Object.fromEntries(['completed', 'blocked', 'failed', 'cancelled'].map(state => [state,
    c.traces.filter(r => r.data.value.type === 'completion' && r.data.value.reason === state).length]));
  add('recording.final', status(recordingViolations, replayClean && headers.length === 1 && run.replay.at(-1) === end && summary
    && !missingSummaryFields.length && summary.coveredThrough === end?.data.simTime && end?.data.omittedImages === 0 && run.replayStatus.state === 'stopped'),
    'Replay end, omission counters and final summary consistency', { end: end?.data ?? null, status: run.replayStatus, missingSummaryFields, coveredInterval: [frames[0]?.data.simTime ?? null, last?.data.simTime ?? null] },
    recordingViolations.length ? recordingViolations : [end?.ref, { file: `${run.replayDirectory}/status.json` }].filter((r): r is Ref => !!r),
    ['Replay header/end, stopped status, reserved final summary and covered terminal frame'], ['The runner finalState is captured before stop and may precede the final replay frame.']);
  add('cleanup.host', run.result.cleanup === 'failed' ? 'fail' : run.result.cleanup === 'complete' && run.result.stopped === true ? 'pass' : 'inconclusive',
    'Saved host reports writer/runtime cleanup', { cleanup: run.result.cleanup ?? null, stopped: run.result.stopped ?? null }, [{ file: 'result.json', pointer: '/cleanup' }], ['Host cleanup result'],
    ['Host-reported cleanup is not an independent historical process-exit check.']);
  const processProof = finite(run.cleanup.capturedOwnedProcesses) && run.cleanup.capturedOwnedProcesses > 0 && Array.isArray(run.cleanup.stillAlive) && typeof run.cleanup.checkedAt === 'string';
  add('cleanup.processes', processProof ? run.cleanup.stillAlive.length ? 'fail' : 'pass' : 'inconclusive', 'Optional saved owned-process snapshot',
    processProof ? run.cleanup : { available: false }, [{ file: 'cleanup-check.json' }], ['Saved owned-process check'],
    ['This is a recorded snapshot only; the auditor neither inspects today’s ports/PIDs nor contacts a browser.'], false);
  return { checks, metrics, findings, supported, roster, header, clockAnomalies: refs(clockAnomalies), unknownAudit: unknownAudit.length, unknownReplay: unknownReplay.length };
}
