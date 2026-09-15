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
