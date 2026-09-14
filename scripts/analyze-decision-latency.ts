/** Offline model-boundary volume and timing evidence; never imported by actors. */
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { ReplayFrame, ReplayObservation, ReplayRecord } from '../shared/replay.ts';

if (!process.argv[2]) throw new Error('Usage: node --import tsx scripts/analyze-decision-latency.ts <saved-trial-directory> [first-wall-seconds]');
const directory = resolve(process.argv[2]);
const result = JSON.parse(await readFile(resolve(directory, 'result.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(directory, 'source-manifest.json'), 'utf8'));
if (createHash('sha256').update(JSON.stringify(manifest)).digest('hex') !== result.manifestSha256) throw new Error('Source manifest identity mismatch');
const lines = async (path: string): Promise<any[]> => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const allAudit = await lines(resolve(directory, result.sessionId));
const windowSeconds = process.argv[3] === undefined ? null : Number(process.argv[3]);
if (windowSeconds !== null && (!Number.isFinite(windowSeconds) || windowSeconds <= 0 || windowSeconds > result.seconds)) throw new Error('Window must fit within the recorded trial budget');
const trialStart = allAudit.find(r => r.type === 'combat' && r.value.type === 'match_started')?.wallTime;
if (!trialStart) throw new Error('Missing trial-start timestamp');
const cutoff = windowSeconds === null ? Infinity : Date.parse(trialStart) + windowSeconds * 1000;
const audit = allAudit.filter(r => Date.parse(r.wallTime) <= cutoff);
const replayDirectory = resolve(directory, 'replays', result.sessionId.slice(0, -6));
const replay: ReplayRecord[] = await lines(resolve(replayDirectory, 'frames.jsonl'));
const frames = replay.filter((r): r is ReplayFrame => r.type === 'frame').sort((a, b) => a.simTime - b.simTime);
const images = replay.filter((r): r is ReplayObservation => r.type === 'observation' && Date.parse(r.capturedAt) <= cutoff);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '');
const round = (value: number) => Math.round(value * 1000) / 1000;
const stats = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const quantile = (p: number) => {
    const index = (sorted.length - 1) * p, low = Math.floor(index);
    return round(sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low));
  };
  return sorted.length ? { n: sorted.length, min: sorted[0], p50: quantile(.5), p90: quantile(.9), p95: quantile(.95), max: sorted.at(-1) } : { n: 0 };
};
type Delivery = { role: string; name: string; wallMs: number; completedMs?: number; body: any; textBytes: number; imageCount: number };
const deliveries: Delivery[] = [], last = new Map<string, Delivery>();
const pending = new Map<string, Delivery[]>();
const gaps: Array<{ role: string; from: Delivery; callMs: number; nextTool: string }> = [];
const usage = new Map<string, any[]>(), compactions: any[] = [], started = new Map<string, any>();
for (const record of audit) {
  const v = record.value, role = v?.role, wallMs = Date.parse(record.wallTime);
  if (record.type !== 'agent' || !role?.startsWith('drone-')) continue;
  if (v.type === 'tool') {
    const previous = last.get(role);
    if (previous) { gaps.push({ role, from: previous, callMs: wallMs, nextTool: v.name }); last.delete(role); }
  }
  if (v.type === 'tool-result') {
    const texts = v.result.content.filter((c: any) => c.type === 'text');
    const body = texts.flatMap((c: any) => { try { return [JSON.parse(c.text)]; } catch { return []; } })
      .find((b: any) => /^fleet-observation\//.test(b.protocol));
    if (!body) continue;
    const delivery = { role, name: v.name, wallMs, body,
      textBytes: texts.reduce((sum: number, c: any) => sum + Buffer.byteLength(c.text), 0),
      imageCount: v.result.content.filter((c: any) => c.type === 'image').length };
    deliveries.push(delivery); last.set(role, delivery);
    const key = `${role}:${v.name}`, queue = pending.get(key) ?? [];
    queue.push(delivery); pending.set(key, queue);
  }
  if (v.type === 'mcp-result') {
    const delivery = pending.get(`${role}:${v.tool}`)?.shift();
    if (delivery) delivery.completedMs = wallMs;
  }
  if (v.type === 'actor-usage') { const list = usage.get(role) ?? []; list.push(v); usage.set(role, list); }
  if (v.type === 'actor-activity' && v.activity === 'contextCompaction') {
    const key = `${role}:${v.itemId}`;
    if (v.phase === 'started') started.set(key, { role, itemId: v.itemId, wallMs, observedAtMs: v.observedAtMs });
    if (v.phase === 'completed') {
      const start = started.get(key); started.delete(key);
      compactions.push({ role, itemId: v.itemId, startedAt: start ? new Date(start.wallMs).toISOString() : null,
        completedAt: record.wallTime, durationMs: start ? round(v.observedAtMs - start.observedAtMs) : null });
    }
  }
}
const fields: Record<string, number> = {};
let duplicatedRangeTables = 0, referenceRangeTables = 0, potentialRangeBytesSaved = 0, sharedRangeBytesSaved = 0;
for (const { body } of deliveries) {
  for (const [key, value] of Object.entries(body)) fields[key] = (fields[key] ?? 0) + bytes(value);
  const captured = body.sensors?.ranges?.proximity, current = body.currentTelemetry?.ranges?.proximity;
  if (current?.sameAs === 'sensors.ranges.proximity') {
    referenceRangeTables++; sharedRangeBytesSaved += bytes(captured) - bytes(current);
  }
  if (captured && current && JSON.stringify(captured) === JSON.stringify(current)) {
    duplicatedRangeTables++;
    potentialRangeBytesSaved += bytes(current) - bytes({ sameAs: 'sensors.ranges.proximity' });
  }
}
// Interpolate the recorded delivery wall/simulation anchors only for sampled
// local-work classification. Gap lengths themselves use native wall timestamps.
const anchors = deliveries.map(d => ({ wall: Date.parse(d.body.deliveredAt), sim: d.body.deliverySimTime }))
  .filter(a => Number.isFinite(a.wall) && Number.isFinite(a.sim)).sort((a, b) => a.wall - b.wall);
const simAt = (wall: number) => {
  const index = anchors.findIndex(a => a.wall >= wall);
  if (index <= 0) return index === 0 ? anchors[0].sim : anchors.at(-1)?.sim;
  const a = anchors[index - 1], b = anchors[index];
  return a.sim + (b.sim - a.sim) * (wall - a.wall) / Math.max(1, b.wall - a.wall);
};
const gapDetail = (g: typeof gaps[number]) => {
  const start = g.from.completedMs ?? g.from.wallMs, lo = simAt(start), hi = simAt(g.callMs);
  let localWorkSeconds = 0, idleSeconds = 0, coveredSeconds = 0;
  if (lo !== undefined && hi !== undefined) for (let i = 0; i + 1 < frames.length; i++) {
    const dt = Math.max(0, Math.min(hi, frames[i + 1].simTime) - Math.max(lo, frames[i].simTime));
    if (!dt) continue;
    const d = frames[i].drones.find(d => d.id === g.role);
    if (!d || d.alive === false) continue;
    const working = Math.hypot(d.velocity?.x ?? 0, d.velocity?.y ?? 0, d.velocity?.z ?? 0) > .001
      || ['accepted', 'running'].includes(d.job?.state ?? '')
      || ['loading', 'unloading'].includes(d.logistics?.state ?? '') || Boolean(d.servicing);
    coveredSeconds += dt;
    if (working) localWorkSeconds += dt; else idleSeconds += dt;
  }
  return { role: g.role, previousTool: g.from.name, nextTool: g.nextTool,
    from: new Date(start).toISOString(), to: new Date(g.callMs).toISOString(),
    nativeCompletionGapMs: g.from.completedMs === undefined ? null : g.callMs - g.from.completedMs,
    deliveryGapMs: g.callMs - Date.parse(g.from.body.deliveredAt),
    sampledLocalWorkSeconds: round(localWorkSeconds), sampledIdleSeconds: round(idleSeconds), sampledCoveredSeconds: round(coveredSeconds),
    compactions: compactions.filter(c => c.role === g.role && c.startedAt && Date.parse(c.startedAt) <= g.callMs && Date.parse(c.completedAt) >= start) };
};
const imageFiles = await Promise.all([...new Set(images.flatMap(r => r.imageId ? [r.imageId] : []))].map(async id => {
  try { return { id, bytes: (await stat(resolve(replayDirectory, id))).size }; }
  catch { return { id, bytes: null }; }
}));
const roles = [...new Set(deliveries.map(d => d.role))];
const byRole = Object.fromEntries(roles.map(role => {
  const ds = deliveries.filter(d => d.role === role), gs = gaps.filter(g => g.role === role);
  const us = usage.get(role) ?? [];
  return [role, { bundles: ds.length, textBytes: ds.reduce((sum, d) => sum + d.textBytes, 0),
    textBytesPerBundle: stats(ds.map(d => d.textBytes)), deliveredImages: ds.reduce((sum, d) => sum + d.imageCount, 0),
    acquisitionToDeliveryMs: stats(ds.map(d => Date.parse(d.body.deliveredAt) - Date.parse(d.body.sensors?.timestamp?.capturedAt))),
    nativeCompletionToNextCallMs: stats(gs.flatMap(g => g.from.completedMs === undefined ? [] : [g.callMs - g.from.completedMs])),
    deliveryToNextCallMs: stats(gs.map(g => g.callMs - Date.parse(g.from.body.deliveredAt))),
    nativeUsage: { reports: us.length, maxLastInputTokens: us.length ? Math.max(...us.map(u => u.lastInputTokens ?? 0)) : null,
      maxReportedTotalTokens: us.length ? Math.max(...us.map(u => u.totalTokens ?? 0)) : null,
      lastReported: us.at(-1) ?? null },
    longGaps: gs.filter(g => g.callMs - (g.from.completedMs ?? g.from.wallMs) >= 20_000).map(gapDetail) }];
}));
const summary = { scenario: result.scenario, seconds: result.seconds, model: result.model, effort: result.effort,
  windowSeconds, trialStart,
  sourceManifestSha256: result.manifestSha256, analyzerSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
  volume: { bundles: deliveries.length, schemas: [...new Set(deliveries.map(d => d.body.protocol))],
    textBytes: deliveries.reduce((sum, d) => sum + d.textBytes, 0), fieldValueJsonBytes: fields,
    duplicatedRangeTables, referenceRangeTables, potentialRangeBytesSaved, sharedRangeBytesSaved,
    deliveredImages: deliveries.reduce((sum, d) => sum + d.imageCount, 0), recordedAcquisitions: images.length,
    imageFileBytes: imageFiles.reduce((sum, f) => sum + (f.bytes ?? 0), 0), missingImageFiles: imageFiles.filter(f => f.bytes === null).length },
  byRole, compactions, incompleteCompactions: [...started.values()],
  limitations: [
    'UTF-8 text bytes measure retained redacted model tool-result text, not tokenizer counts. Native usage is backend-reported and includes growing/cached context; per-field or image token attribution is unavailable.',
    'Images are actual acquired replay files; JPEG bytes do not measure image tokens. Historical audit limits can truncate evidence.',
    'Gap durations include backend processing, transport and dispatch, not private reasoning alone. Terminal gaps without a next call are excluded; unfinished compactions are separate.',
    'Motion/job/service work is classified from preceding replay samples and interpolated wall/simulation delivery anchors; orientation-only work and routines without movement are not represented. Idle holding can be intentional, especially in haul fixtures.',
    'Volume savings and single-run timing differences do not establish latency causality. No current physics or renderer code is imported to reinterpret historical evidence.',
  ] };
await writeFile(resolve(directory, windowSeconds === null ? 'decision-latency.json' : `decision-latency-${windowSeconds}s.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, volume: { ...summary.volume, fieldValueJsonBytes: undefined },
  byRole: Object.fromEntries(Object.entries(byRole).map(([role, value]) => [role, { ...value, longGaps: value.longGaps.length,
    nativeUsage: { ...value.nativeUsage, lastReported: undefined } }])) }, null, 2));
