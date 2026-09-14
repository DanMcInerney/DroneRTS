/** Launch waits for actual opening-objective bundles, not actor creation. */
export class LaunchGate {
  private pending: Set<string>;
  constructor(ids: readonly string[]) { this.pending = new Set(ids); }
  get ready() { return this.pending.size === 0; }
  delivered(id: string, hasOpening: boolean) {
    const before = this.ready;
    if (hasOpening) this.pending.delete(id);
    return !before && this.ready;
  }
}
