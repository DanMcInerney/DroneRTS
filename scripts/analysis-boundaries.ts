/** Offline audit joins only; never imported by the runtime or actors. */
export type ObservationDelivery = {
  role: string;
  name: string;
  wallMs: number;
  completedMs?: number;
  body: any;
  textBytes: number;
  imageCount: number;
};

export type DecisionBoundary = {
  role: string;
  from: ObservationDelivery;
  callMs: number;
  nextTool: string;
};

/** Each delivered observation contributes at most its first following tool call.
 * Joins follow per-pilot audit order; error-only results are not observations.
 * Native completions are associated by role/tool FIFO, as recorded by the host.
 */
export function extractObservationBoundaries(audit: readonly { type: string; wallTime: string; value: any }[]) {
  const deliveries: ObservationDelivery[] = [], gaps: DecisionBoundary[] = [];
  const last = new Map<string, ObservationDelivery>();
  const pending = new Map<string, Array<ObservationDelivery | undefined>>();
  for (const record of audit) {
    const value = record.value, role = value?.role, wallMs = Date.parse(record.wallTime);
    if (record.type !== 'agent' || !role?.startsWith('drone-')) continue;
    if (value.type === 'tool') {
      const previous = last.get(role);
      if (previous) {
        gaps.push({ role, from: previous, callMs: wallMs, nextTool: value.name });
        last.delete(role);
      }
    }
    if (value.type === 'tool-result') {
      const content: any[] = value.result?.content ?? [];
      const texts = content.filter(item => item.type === 'text');
      const body = texts.flatMap(item => { try { return [JSON.parse(item.text)]; } catch { return []; } })
        .find(item => typeof item?.protocol === 'string' && item.protocol.startsWith('fleet-observation/'));
      const delivery: ObservationDelivery | undefined = body ? { role, name: value.name, wallMs, body,
        textBytes: texts.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0),
        imageCount: content.filter(item => item.type === 'image').length } : undefined;
      if (delivery) { deliveries.push(delivery); last.set(role, delivery); }
      // Non-observation completions must not be attached to a later observation.
      const key = `${role}:${value.name}`, queue = pending.get(key) ?? [];
      queue.push(delivery); pending.set(key, queue);
    }
    if (value.type === 'mcp-result') {
      const delivery = pending.get(`${role}:${value.tool}`)?.shift();
      if (delivery) delivery.completedMs = wallMs;
    }
  }
  return { deliveries, gaps };
}
