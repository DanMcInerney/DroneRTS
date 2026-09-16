import type { GameEvent } from '../shared/types.ts';

// Each retained receipt timestamp has a numeric cursor key and timestamp value.
const RECEIPT_METADATA_BYTES = 16;

/** Each actor has one inbox. The server owns delivery; client cursors are hints. */
export class Mailbox {
  events: GameEvent[] = [];
  cursor = 0;
  delivered = 0;
  listeners = new Set<() => void>();
  onPush?: (event: GameEvent) => void;
  onOverflow?: (partition: 'radio' | 'events') => void;
  private overflowed = false;
  private receivedTimes = new Map<number, number>();
  receivedAt(cursor: number) { return this.receivedTimes.get(cursor) ?? 0; }
  get localBytes() { return this.events.filter(item => item.cursor > this.delivered && item.type !== 'radio' && item.type !== 'player')
    .reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)) + RECEIPT_METADATA_BYTES, 0); }

  push(event: Omit<GameEvent, 'cursor'>) {
    // Actor history cannot grow outside the onboard mail/event budgets. Existing
    // unread data stays intact; an exhausted local event buffer stops its host.
    this.events = this.events.filter(item => item.cursor > this.delivered);
    const radio = event.type === 'radio' || event.type === 'player';
    const budget = radio ? 4 * 1024 ** 2 : 512 * 1024;
    const used = this.events.filter(item => (item.type === 'radio' || item.type === 'player') === radio)
      .reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)) + RECEIPT_METADATA_BYTES, 0);
    if (used + Buffer.byteLength(JSON.stringify(event)) + 64 + RECEIPT_METADATA_BYTES > budget) {
      if (!this.overflowed) { this.overflowed = true; this.onOverflow?.(radio ? 'radio' : 'events'); }
      return false;
    }
    const item = { ...event, cursor: ++this.cursor } as GameEvent;
    this.receivedTimes.set(item.cursor, performance.now());
    this.events.push(item);
    this.onPush?.(this.events.at(-1)!);
    // Retain every unread event. Only delivered history may be discarded.
    this.events = this.events.filter(item => item.cursor > this.delivered);
    for (const wake of [...this.listeners]) wake();
    return true;
  }

  async waitForMail(timeout = 30_000) {
    const pending = () => this.events.some(event => event.cursor > this.delivered);
    if (!pending() && timeout > 0) {
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); this.listeners.delete(wake); resolve(); };
        const timer = setTimeout(wake, timeout);
        this.listeners.add(wake);
        // Guard against a future caller making inbox registration asynchronous.
        if (pending()) wake();
      });
    }
  }

  drain(after = this.delivered) {
    const previous = this.delivered;
    const slice = this.peek();
    this.acknowledge(slice.cursor);
    return { ...slice, cursorRecovered: after !== previous };
  }

  /** Nervelet peeks without consuming; only an echoed delivered bundle commits. */
  peek(after = this.delivered) {
    const pending = this.events.filter(event => event.cursor > Math.max(after, this.delivered));
    const events: GameEvent[] = []; let bytes = 0;
    for (const event of pending) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (events.length && bytes + size > 128 * 1024) break;
      events.push(event); bytes += size;
    }
    return { events, cursor: events.at(-1)?.cursor ?? this.delivered,
      timedOut: events.length === 0, cursorRecovered: false, hasMore: pending.length > events.length };
  }

  acknowledge(through: number) {
    if (!Number.isInteger(through) || through < this.delivered || through > this.cursor) throw new Error('Invalid inbox acknowledgement');
    this.delivered = through;
    this.events = this.events.filter(event => event.cursor > through);
    for (const cursor of this.receivedTimes.keys()) if (cursor <= through) this.receivedTimes.delete(cursor);
  }

  async read(after = this.delivered, timeout = 30_000) {
    await this.waitForMail(timeout);
    return this.drain(after);
  }
}
