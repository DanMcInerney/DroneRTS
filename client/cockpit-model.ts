import type { CockpitEvent } from '../shared/cockpit';

export const COCKPIT_EVENT_LIMIT = 240;
export const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const json = (value: unknown) => JSON.stringify(value, null, 2) ?? String(value);
export function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
}

/** Sequence identity makes retries harmless; the server cursor remains separate. */
export function mergeCockpitEvents(previous: CockpitEvent[], next: CockpitEvent[]) {
  const bySequence = new Map(previous.map(event => [event.sequence, event]));
  next.forEach(event => bySequence.set(event.sequence, event));
  const all = [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
  return { events: all.slice(-COCKPIT_EVENT_LIMIT), trimmed: all.length > COCKPIT_EVENT_LIMIT };
}

export interface CockpitSendAttempt {
  sequence: number; at: string; arguments: Record<string, unknown>;
  source: { tool: 'send' | 'exchange'; commandId?: string; operationIndex?: number; operationId?: string };
}

/** Recorded attempts only: batch admission and recipient delivery live in results. */
export function outgoingSendAttempts(events: CockpitEvent[]): CockpitSendAttempt[] {
  const sends: CockpitSendAttempt[] = [];
  for (const event of events) {
    if (event.kind !== 'call' || (event.name !== 'send' && event.name !== 'exchange')) continue;
    const value = record(event.data), args = record(value.arguments ?? value.args ?? value);
    const source: CockpitSendAttempt['source'] = { tool: event.name, ...(typeof args.command_id === 'string' ? { commandId: args.command_id } : {}) };
    if (event.name === 'send') {
      sends.push({ sequence: event.sequence, at: event.at, arguments: args, source });
    } else if (Array.isArray(args.operations)) {
      args.operations.forEach((entry, index) => {
        const operation = record(entry);
        if (operation.tool !== 'send') return;
        sends.push({ sequence: event.sequence, at: event.at, arguments: record(operation.args),
          source: { ...source, operationIndex: index + 1, ...(typeof operation.id === 'string' ? { operationId: operation.id } : {}) } });
      });
    }
  }
  return sends;
}

/** Runtime completion is the full emitted text, not another text delta. */
export function outputRows(events: CockpitEvent[]): CockpitEvent[] {
  const rows: CockpitEvent[] = [], items = new Map<string, CockpitEvent>();
  for (const event of events) {
    if (!event.itemId || !['output', 'summary', 'reasoning', 'reasoning-status'].includes(event.kind)) { rows.push({ ...event }); continue; }
    const key = `${event.kind}:${event.itemId}`, prior = items.get(key);
    if (!prior) { const row = { ...event }; items.set(key, row); rows.push(row); continue; }
    prior.text = event.delta ? `${prior.text ?? ''}${event.text ?? ''}` : event.text;
    prior.delta = event.delta;
    prior.streaming = event.streaming;
    prior.data = event.data;
  }
  return rows;
}
