/** Player-side capture of readable app-server fields, never an actor tool. */
export const REASONING_CONFIG = { model_reasoning_summary: 'auto', show_raw_agent_reasoning: true, hide_agent_reasoning: false } as const;
export const REASONING_CONFIG_TOML = Object.entries(REASONING_CONFIG).map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`).join('');
export const REASONING_LIMITS = { items: 64, parts: 32, text: 24_000 } as const;
type Parts = Map<number, string>;
type Draft = { threadId: string; itemId: string; summary: Parts; content: Parts; truncated: boolean };
export type ReasoningEvent = {
  type: 'reasoning-text-delta' | 'reasoning-summary-delta' | 'recorded-reasoning' | 'recorded-reasoning-summary' | 'reasoning-availability';
  threadId: string; itemId: string; text: string; delta: false; streaming: boolean;
  availability?: 'waiting' | 'native' | 'summary' | 'both' | 'unavailable'; incomplete?: boolean;
};
const joined = (parts: Parts) => [...parts].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n');
const plainText = (value: unknown): string => typeof value === 'string' ? value : value && typeof value === 'object' && 'text' in value && typeof value.text === 'string' ? value.text : '';

/** Coalesces multipart deltas; completion replaces text instead of appending it twice. */
export class RuntimeReasoning {
  private drafts = new Map<string, Draft>();
  constructor(private emit: (event: ReasoningEvent) => void) {}
  private publish(draft: Draft, type: ReasoningEvent['type'], text: string, streaming: boolean, extra: Partial<ReasoningEvent> = {}) {
    this.emit({ type, threadId: draft.threadId, itemId: draft.itemId, text, delta: false, streaming, ...extra });
  }
  private put(draft: Draft, parts: Parts, index: number, text: string, append: boolean) {
    if (!Number.isInteger(index) || index < 0 || index >= REASONING_LIMITS.parts) { draft.truncated = true; return; }
    const previous = parts.get(index) ?? '';
    const available = Math.max(0, REASONING_LIMITS.text - joined(parts).length + previous.length - (parts.has(index) || !parts.size ? 0 : 1));
    const next = (append ? previous : '') + text;
    if (next.length > available) draft.truncated = true;
    parts.set(index, next.slice(0, available));
  }
  private finish(draft: Draft, incomplete = false) {
    const content = joined(draft.content), summary = joined(draft.summary);
    const suffix = draft.truncated ? '\n[reasoning capture truncated]' : '';
    if (content) this.publish(draft, 'recorded-reasoning', content + suffix, false, { incomplete });
    if (summary) this.publish(draft, 'recorded-reasoning-summary', summary + suffix, false, { incomplete });
    const availability = content ? summary ? 'both' : 'native' : summary ? 'summary' : 'unavailable';
    const label = { native: 'Native reasoning was emitted.', summary: 'A reasoning summary was emitted; no native reasoning text was returned.', both: 'Native reasoning and a summary were emitted.', unavailable: 'No readable reasoning was returned for this item.' }[availability];
    this.publish(draft, 'reasoning-availability', (incomplete ? 'Capture ended before item completion. ' : '') + label, false, { availability, incomplete });
    this.drafts.delete(JSON.stringify([draft.threadId, draft.itemId]));
  }
  accept(method: string, params: any) {
    const started = method === 'item/started' && params.item?.type === 'reasoning';
    const completed = method === 'item/completed' && params.item?.type === 'reasoning';
    const contentDelta = method === 'item/reasoning/textDelta';
    const summaryDelta = method === 'item/reasoning/summaryTextDelta';
    if (!started && !completed && !contentDelta && !summaryDelta) return;
    const threadId = params.threadId, itemId = started || completed ? params.item.id : params.itemId;
    if (typeof threadId !== 'string' || typeof itemId !== 'string') return;
    const key = JSON.stringify([threadId, itemId]);
    let draft = this.drafts.get(key);
    if (!draft) {
      if (this.drafts.size >= REASONING_LIMITS.items) this.finish(this.drafts.values().next().value!, true);
      draft = { threadId, itemId, summary: new Map(), content: new Map(), truncated: false };
      this.drafts.set(key, draft);
    }
    if (started) this.publish(draft, 'reasoning-availability', 'Waiting for readable reasoning from the runtime…', true, { availability: 'waiting' });
    if (contentDelta || summaryDelta) {
      if (typeof params.delta !== 'string' || !params.delta) return;
      const parts = contentDelta ? draft.content : draft.summary;
      const firstText = !joined(parts);
      this.put(draft, parts, (contentDelta ? params.contentIndex : params.summaryIndex) ?? 0, params.delta, true);
      this.publish(draft, contentDelta ? 'reasoning-text-delta' : 'reasoning-summary-delta', joined(parts) + (draft.truncated ? '\n[reasoning capture truncated]' : ''), true);
      if (firstText && joined(parts)) {
        const availability = joined(draft.content) ? joined(draft.summary) ? 'both' : 'native' : 'summary';
        this.publish(draft, 'reasoning-availability', availability === 'both' ? 'Native reasoning and a summary are streaming.' : availability === 'native' ? 'Native reasoning is streaming.' : 'A reasoning summary is streaming.', true, { availability });
      }
    }
    if (completed) {
      for (const field of ['content', 'summary'] as const) {
        const values: unknown = params.item[field];
        if (!Array.isArray(values)) continue;
        if (values.length > REASONING_LIMITS.parts) draft.truncated = true;
        // Some runtimes omit completed text after streaming it. Retain those deltas.
        const text = values.slice(0, REASONING_LIMITS.parts).map(plainText);
        if (text.some(Boolean)) {
          draft[field].clear();
          text.forEach((part, index) => this.put(draft!, draft![field], index, part, false));
        }
      }
      this.finish(draft);
    }
  }
  flush(threadId?: string) {
    for (const draft of [...this.drafts.values()]) if (threadId === undefined || draft.threadId === threadId) this.finish(draft, true);
  }
}
