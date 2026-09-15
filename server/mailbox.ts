import type { GameEvent } from '../shared/types.ts';

/** Each actor has one inbox. The server owns delivery; client cursors are hints. */
export class Mailbox {
  events: GameEvent[] = [];
  cursor = 0;
  delivered = 0;
  listeners = new Set<() => void>();
  onPush?: (event: GameEvent) => void;
  onOverflow?: (partition: 'radio' | 'events') => void;
  private overflowed = false;
  get localBytes() { return this.events.filter(item => item.cursor > this.delivered && item.type !== 'radio' && item.type !== 'player')
    .reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0); }

  push(event: Omit<GameEvent, 'cursor'>) {
    // Actor history cannot grow outside the onboard mail/event budgets. Existing
    // unread data stays intact; an exhausted local event buffer stops its host.
    this.events = this.events.filter(item => item.cursor > this.delivered);
    const radio = event.type === 'radio' || event.type === 'player';
    const budget = radio ? 4 * 1024 ** 2 : 512 * 1024;
    const used = this.events.filter(item => (item.type === 'radio' || item.type === 'player') === radio)
      .reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
    if (used + Buffer.byteLength(JSON.stringify(event)) + 64 > budget) {
      if (!this.overflowed) { this.overflowed = true; this.onOverflow?.(radio ? 'radio' : 'events'); }
      return false;
    }
    this.events.push({ ...event, cursor: ++this.cursor } as GameEvent);
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
    const cursorRecovered = after !== this.delivered;
    const pending = this.events.filter(event => event.cursor > this.delivered);
    const events: GameEvent[] = []; let bytes = 0;
    for (const event of pending) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (events.length && bytes + size > 128 * 1024) break;
      events.push(event); bytes += size;
    }
    if (events.length) this.delivered = events.at(-1)!.cursor;
    return { events, cursor: this.delivered, timedOut: events.length === 0, cursorRecovered, hasMore: pending.length > events.length };
  }

  async read(after = this.delivered, timeout = 30_000) {
    await this.waitForMail(timeout);
    return this.drain(after);
  }
}
