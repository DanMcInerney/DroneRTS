import type { GameEvent } from '../shared/types.ts';

/** Each actor has one inbox. The server owns delivery; client cursors are hints. */
export class Mailbox {
  events: GameEvent[] = [];
  cursor = 0;
  delivered = 0;
  listeners = new Set<() => void>();

  push(event: Omit<GameEvent, 'cursor'>) {
    this.events.push({ ...event, cursor: ++this.cursor } as GameEvent);
    // Retain every unread event. Only delivered history may be discarded.
    this.events = this.events.filter(item => item.cursor > this.delivered);
    for (const wake of [...this.listeners]) wake();
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
    const events = this.events.filter(event => event.cursor > this.delivered);
    if (events.length) this.delivered = events.at(-1)!.cursor;
    return { events, cursor: this.delivered, timedOut: events.length === 0, cursorRecovered };
  }

  async read(after = this.delivered, timeout = 30_000) {
    await this.waitForMail(timeout);
    return this.drain(after);
  }
}
