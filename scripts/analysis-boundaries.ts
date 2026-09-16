/** Offline audit joins only; never imported by the runtime or actors. */
import { decodeContent } from './audit/decode.ts';
export type ObservationDelivery = {
  role: string;
  name: string;
  wallMs: number;
  completedMs?: number;
  body: any;
  textBytes: number;
  imageCount: number;
  index: number;
  completionIndex?: number;
  callIndex?: number;
  join: 'actor-tool-fifo' | 'legacy-fifo' | 'ambiguous' | 'unmatched';
};

export type DecisionBoundary = {
  role: string;
  from: ObservationDelivery;
  callMs: number;
  nextTool: string;
};
export type NativeCall = { role: string; team?: string; name: string; callIndex?: number; resultIndex?: number;
  completionIndex?: number; delivery?: ObservationDelivery; output: boolean; ambiguous: boolean };

/** Each delivered observation contributes at most its first following tool call.
 * Joins follow per-pilot audit order; error-only results are not observations.
 * Native completions are associated by role/tool FIFO, as recorded by the host.
 */
export function extractObservationBoundaries(audit: readonly { type: string; wallTime: string; value: any }[], strict = false) {
  const deliveries: ObservationDelivery[] = [], gaps: DecisionBoundary[] = [];
  const diagnostics: { index: number; reason: string }[] = [];
  const last = new Map<string, ObservationDelivery>();
  const calls: NativeCall[] = [];
  const pending = new Map<string, NativeCall[]>();
  for (const [index, record] of audit.entries()) {
    const value = record.value, role = value?.role, wallMs = Date.parse(record.wallTime);
    if (record.type !== 'agent' || typeof role !== 'string') continue;
    const actor = `${value.team ?? ''}:${role}`, key = `${actor}:${value.name ?? value.tool}`;
    const queue = pending.get(key) ?? []; pending.set(key, queue);
    if (value.type === 'tool') {
      const previous = last.get(actor);
      if (previous) {
        gaps.push({ role, from: previous, callMs: wallMs, nextTool: value.name });
        last.delete(actor);
      }
      const overlapping = queue.some(slot => slot.callIndex !== undefined);
      if (overlapping) {
        for (const slot of queue) { slot.ambiguous = true; if (slot.delivery) slot.delivery.join = 'ambiguous'; }
        diagnostics.push({ index, reason: 'Overlapping call or missing native completion; FIFO pairing is ambiguous' });
      }
      const call = { role, team: value.team, name: value.name, callIndex: index, output: false, ambiguous: overlapping };
      queue.push(call); calls.push(call);
    }
    if (value.type === 'tool-result') {
      const decoded = decodeContent(value.result);
      diagnostics.push(...decoded.diagnostics.map(reason => ({ index, reason })));
      let slot = queue.find(slot => !slot.output);
      if (!slot) { slot = { role, team: value.team, name: value.name, output: false, ambiguous: strict }; queue.push(slot); calls.push(slot); }
      slot.output = true; slot.resultIndex = index;
      const delivery: ObservationDelivery | undefined = decoded.body ? { role, name: value.name, wallMs, body: decoded.body,
        textBytes: decoded.textBytes, imageCount: decoded.imageCount, index, callIndex: slot.callIndex,
        join: slot.ambiguous ? 'ambiguous' : 'unmatched' } : undefined;
      slot.delivery = delivery;
      if (delivery) { deliveries.push(delivery); last.set(actor, delivery); }
    }
    if (value.type === 'mcp-result') {
      const slot = queue.shift();
      if (!slot) diagnostics.push({ index, reason: 'Unmatched native completion' });
      if (slot && !slot.ambiguous) slot.completionIndex = index;
      if (slot?.delivery && !slot.ambiguous) {
        slot.delivery.completedMs = wallMs; slot.delivery.completionIndex = index;
        slot.delivery.join = slot.callIndex === undefined ? 'legacy-fifo' : 'actor-tool-fifo';
      }
    }
  }
  return { deliveries, gaps, diagnostics, calls };
}
