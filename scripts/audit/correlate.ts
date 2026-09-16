import { extractObservationBoundaries, type ObservationDelivery } from '../analysis-boundaries.ts';
import { knownObservation, object } from './decode.ts';
import type { Issue, RecordAt, Run } from './types.ts';

export type Bundle = ObservationDelivery & { record: RecordAt; assembly?: RecordAt; submission?: RecordAt; acknowledgements: RecordAt[]; acquisition?: RecordAt };
export function indexBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const value of values) { const id = key(value), list = index.get(id) ?? []; list.push(value); index.set(id, list); }
  return index;
}
export const cameraKey = (actor: string, camera: any) => JSON.stringify([actor, camera?.acquiredAt ?? camera?.capturedAt, camera?.simTime]);
export const bundleKey = (actor: string, metadata: any) => JSON.stringify([actor, metadata?.loopRef, metadata?.generation, metadata?.id]);

/** File order is authoritative within each log; cross-file joins use identities. */
export function correlate(run: Run) {
  const boundary = extractObservationBoundaries(run.audit.map(r => r.data), true);
  const issues: Issue[] = boundary.diagnostics.map(d => ({ kind: 'native-join', ref: run.audit[d.index].ref, detail: d.reason }));
  const traces = run.audit.filter(r => r.data.type === 'nervelet-trace' && object(r.data.value));
  const traceIndex = indexBy(traces, r => `${r.data.value?.type}:${bundleKey(r.data.value?.drone, r.data.value)}`);
  const acquisitions = run.replay.filter(r => r.data.type === 'observation');
  const cameras = indexBy(acquisitions, r => cameraKey(r.data.drone, r.data));
  const bundles: Bundle[] = boundary.deliveries.map(d => ({ ...d, record: run.audit[d.index], acknowledgements: [] }));
  const bodies = indexBy(bundles, b => bundleKey(b.role, b.body.nervelet));
  const deliveredCameras = indexBy(bundles.filter(b => b.body.sensors?.camera?.available), b => cameraKey(b.role, b.body.sensors.camera));
  for (const b of bundles) {
    if (!knownObservation(b.body)) issues.push({ kind: 'unknown-observation', ref: b.record.ref, detail: String(b.body.protocol) });
    if (!Array.isArray(b.body.events) || typeof b.body.sessionId !== 'string' || !object(b.body.nervelet))
      issues.push({ kind: 'observation-fields', ref: b.record.ref, detail: 'Missing/invalid events, session or Nervelet metadata' });
    if (b.body.nervelet?.results !== undefined && (!Array.isArray(b.body.nervelet.results) || b.body.nervelet.results.some((r: any) => !object(r))))
      issues.push({ kind: 'receipt-fields', ref: b.record.ref, detail: 'Invalid result receipt collection' });
    const key = bundleKey(b.role, b.body.nervelet);
    if (typeof b.body.nervelet?.id !== 'string' || typeof b.body.nervelet?.loopRef !== 'string' || !Number.isInteger(b.body.nervelet?.generation) || bodies.get(key)?.length !== 1) {
      issues.push({ kind: 'bundle-join', ref: b.record.ref, detail: 'Missing or ambiguous scoped bundle ID' }); continue;
    }
    for (const stage of ['assembly', 'submission'] as const) {
      const rows = traceIndex.get(`${stage}:${key}`) ?? [];
      if (rows.length === 1) b[stage] = rows[0];
      else issues.push({ kind: 'bundle-join', ref: b.record.ref, detail: `${stage}: ${rows.length} matching traces` });
    }
    b.acknowledgements = traceIndex.get(`acknowledgement:${key}`) ?? [];
    if (b.body.sensors?.camera?.available) {
      const key = cameraKey(b.role, b.body.sensors.camera), rows = cameras.get(key) ?? [];
      if (rows.length === 1 && deliveredCameras.get(key)?.length === 1) b.acquisition = rows[0];
      else issues.push({ kind: 'camera-join', ref: b.record.ref, detail: `Ambiguous/unmatched actor/acquisition/simulation tuple (${rows.length} acquisitions, ${deliveredCameras.get(key)?.length} bodies)` });
    }
  }
  for (const t of traces.filter(t => ['assembly', 'submission', 'acknowledgement'].includes(t.data.value?.type))) {
    const matches = bodies.get(bundleKey(t.data.value.drone, t.data.value)) ?? [];
    if (matches.length !== 1) issues.push({ kind: 'trace-join', ref: t.ref, detail: `${t.data.value.type} has ${matches.length} matching bodies` });
  }
  return { bundles, traces, acquisitions, issues, boundary };
}
export type Correlated = ReturnType<typeof correlate>;
