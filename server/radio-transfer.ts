import { randomUUID } from 'node:crypto';
import type { DroneId, RadioMessage } from '../shared/types.ts';
import { isDroneId, type FleetRoster } from '../shared/fleet.ts';
import { ONBOARD_LIMITS, OnboardWorkspace, workspacePath } from './onboard-workspace.ts';

const LIFETIME_MS = 120_000;
const MAX_TRANSFERS = 32;
const METADATA_BYTES = 1024;
type TransferState = 'queued' | 'sending' | 'complete' | 'failed' | 'cancelled';
interface RecordEntry {
  id: string; from: DroneId; to: DroneId; path: string; bytes: number; sha256: string;
  expiresAt: number; direction: 'incoming' | 'outgoing'; state: TransferState; reason?: string;
  mission: number; content?: string;
  pumping?: boolean; cancelled?: boolean;
}
export interface TransferRequest { operation: 'offer' | 'list' | 'status' | 'import' | 'cancel'; to?: string; path?: string; transferId?: string }

/** Transfer payloads travel exclusively in native mail. Receipt means stored mail;
 * a separate native completion message reports verified, inert recipient staging.
 * Neither receiving nor verifying source calls the routine runtime. */
export class RadioTransfers {
  private records = new Map<DroneId, Map<string, RecordEntry>>();
  private pumps = new Map<string, RecordEntry>();
  private pendingSends = new Map<DroneId, number>();
  private serial = 0;
  private stopped = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(private options: {
    sessionId: string; roster: FleetRoster; workspace: (id: DroneId) => OnboardWorkspace;
    send: (message: RadioMessage, ttlMs: number, beforeSend: () => void) => Promise<unknown>;
    consume: (id: DroneId, ids: string[]) => void;
    mission: (id: DroneId) => number; simTime: () => number;
    active: (id: DroneId) => boolean;
    onEvent?: (event: unknown) => void;
  }) { this.timer = setInterval(() => this.expire(), 500); this.timer.unref(); }

  private entries(id: DroneId): Map<string, RecordEntry> { let rows = this.records.get(id); if (!rows) this.records.set(id, rows = new Map()); return rows; }
  private check(id: DroneId): void { if (this.stopped || !isDroneId(id, this.options.roster) || !this.options.active(id)) throw new Error('Drone transfer access is unavailable'); }
  private describe(row: RecordEntry) { const { content: _content, pumping: _pumping, cancelled: _cancelled, expiresAt, ...metadata } = row; return { ...metadata, expiresInMs: Math.max(0, Math.round(expiresAt - performance.now())), inert: true }; }
  private reserve(id: DroneId, entry: RecordEntry, bytes: number): void {
    const entries = this.entries(id);
    const retiring = [...this.pumps.values()].filter(row => row.from === id && row.cancelled && !entries.has(row.id)).length;
    if (entries.size + retiring >= MAX_TRANSFERS) throw new Error('staging_full: at most 32 active or retiring transfers; await cancellation or import existing transfers');
    this.options.workspace(id).reserveStaging(`radio:${entry.id}`, bytes + METADATA_BYTES);
    entries.set(entry.id, entry);
  }
  private remove(id: DroneId, entry: RecordEntry, forget = false): void {
    entry.cancelled = true;
    // An outstanding host submission still retains its source and closure. Its
    // reservation/admission slot belongs to the pump until that promise settles.
    if (!entry.pumping) {
      if (forget) this.options.workspace(id).releaseStaging(`radio:${entry.id}`);
      else this.options.workspace(id).reserveStaging(`radio:${entry.id}`, METADATA_BYTES);
    }
    if (entry.direction === 'incoming') this.options.workspace(id).cancelTransfer(entry.id);
    delete entry.content; entry.state = 'cancelled';
    // A late, distinct chunk is not a duplicate native message. Retain a bounded
    // transfer tombstone until its original deadline so cancel/import cannot be
    // undone by reordered data. Its metadata remains explicitly charged.
    if (forget) this.entries(id).delete(entry.id);
  }
  private expire(): void {
    for (const [id, entries] of this.records) for (const entry of entries.values()) {
      if (entry.expiresAt <= performance.now() || !this.options.active(id)) this.remove(id, entry, true);
    }
  }
  async tool(id: DroneId, args: TransferRequest): Promise<unknown> {
    this.check(id); this.expire();
    if (args.operation === 'list') return { transfers: [...this.entries(id).values()].map(row => this.describe(row)) };
    if (args.operation === 'offer') {
      if (!args.to || !isDroneId(args.to, this.options.roster) || args.to === id) throw new Error('Transfer recipient must be another teammate');
      if (!args.path) throw new Error('Offer requires an existing private workspace path');
      const source = this.options.workspace(id).stat(args.path);
      if (!/\.(md|json|m?js|txt)$/i.test(source.path)) throw new Error('Transfers support plain UTF-8 notes and JavaScript only; no archives or image encodings');
      const entry: RecordEntry = { id: randomUUID(), from: id, to: args.to, path: source.path, bytes: source.bytes, sha256: source.sha256,
        expiresAt: performance.now() + LIFETIME_MS, direction: 'outgoing', state: 'queued', mission: this.options.mission(id) };
      // Announced outgoing payload plus string/encoding peak and metadata are
      // reserved before copying the source. Native copies consume radio quota too.
      this.reserve(id, entry, source.bytes * 3 + 4096);
      try { entry.content = this.options.workspace(id).read(source.path); }
      catch (error) { this.remove(id, entry, true); throw error; }
      entry.pumping = true; this.pumps.set(entry.id, entry);
      void this.pump(entry).catch(error => this.fail(id, entry, String(error))).finally(() => {
        entry.pumping = false; this.pumps.delete(entry.id); delete entry.content;
        if (entry.cancelled && !this.entries(id).has(entry.id)) this.options.workspace(id).releaseStaging(`radio:${entry.id}`);
        else this.options.workspace(id).reserveStaging(`radio:${entry.id}`, METADATA_BYTES);
      });
      return this.describe(entry);
    }
    const entry = args.transferId && this.entries(id).get(args.transferId);
    if (!entry) throw new Error('Transfer does not exist or expired');
    if (args.operation === 'status') return this.describe(entry);
    if (args.operation === 'cancel') {
      const recipient = entry.direction === 'outgoing' ? entry.to : entry.from;
      this.remove(id, entry);
      void this.send(id, recipient, entry, { operation: 'cancel' }).catch(() => {});
      return { id: entry.id, cancelled: true };
    }
    if (args.operation === 'import') {
      if (entry.direction !== 'incoming' || entry.state !== 'complete') throw new Error('Only a complete verified incoming transfer can be imported');
      if (!args.path) throw new Error('Import requires your chosen private workspace destination path');
      workspacePath(args.path);
      const file = this.options.workspace(id).importTransfer(entry.id, args.path);
      this.remove(id, entry);
      this.options.onEvent?.({ event: 'transfer-imported', drone: id, transferId: entry.id, file });
      return { imported: true, file, executed: false };
    }
    throw new Error('Unknown transfer operation');
  }
  private fail(id: DroneId, entry: RecordEntry, reason: string): void {
    if (!this.entries(id).has(entry.id) || entry.cancelled) return;
    entry.state = 'failed'; entry.reason = reason.slice(0, 200); delete entry.content;
    if (!entry.pumping) this.options.workspace(id).reserveStaging(`radio:${entry.id}`, METADATA_BYTES);
    if (entry.direction === 'incoming') this.options.workspace(id).cancelTransfer(entry.id);
  }
  private async pump(entry: RecordEntry): Promise<void> {
    entry.state = 'sending';
    const content = entry.content!;
    // Iterate Unicode code points so a chunk never splits a UTF-8 sequence.
    let chunk = '', bytes = 0, index = 0;
    const submit = async () => {
      if (entry.cancelled || !this.entries(entry.from).has(entry.id) || !this.options.active(entry.from) || this.options.mission(entry.from) !== entry.mission || entry.expiresAt <= performance.now()) throw new Error('Transfer cancelled by lifecycle or received objective');
      await this.send(entry.from, entry.to, entry, { operation: 'chunk', index: index++, content: chunk });
      chunk = ''; bytes = 0;
    };
    for (const point of content) {
      const length = Buffer.byteLength(point);
      if (bytes + length > 4096) await submit();
      chunk += point; bytes += length;
    }
    if (chunk || index === 0) await submit();
    delete entry.content;
    if (!['complete', 'failed', 'cancelled'].includes(entry.state)) entry.state = 'queued';
  }
  private async send(from: DroneId, to: DroneId, entry: RecordEntry, data: Record<string, unknown>): Promise<unknown> {
    if (this.stopped || !this.options.active(from)) throw new Error('Transfer sender is unavailable');
    if ((this.pendingSends.get(from) ?? 0) >= 32) throw new Error('staging_full: transfer submissions are busy; wait for pending radio calls');
    const ttlMs = Math.max(1, Math.min(LIFETIME_MS, Math.ceil(entry.expiresAt - performance.now())));
    const message: RadioMessage = { protocol: 'fleet-radio/1', sessionId: this.options.sessionId, id: `transfer:${randomUUID()}`, sequence: ++this.serial,
      from, to, kind: 'transfer', text: 'Private inert file transfer', sentAt: new Date().toISOString(), simTime: this.options.simTime(), mission: this.options.mission(from),
      data: { transferId: entry.id, path: entry.path, bytes: entry.bytes, sha256: entry.sha256, deadlineMs: entry.expiresAt, ...data } };
    const key = `rpc:${randomUUID()}`, workspace = this.options.workspace(from);
    workspace.reserveStaging(key, Buffer.byteLength(JSON.stringify(message)) * 2 + 512);
    this.pendingSends.set(from, (this.pendingSends.get(from) ?? 0) + 1);
    const beforeSend = () => {
      this.check(from);
      // Control receipts/tombstones remain valid after explicit cancellation.
      // Source chunks require the same live entry right up to native admission.
      if (data.operation === 'chunk' && (entry.cancelled || this.entries(from).get(entry.id) !== entry
        || this.options.mission(from) !== entry.mission || entry.expiresAt <= performance.now())) {
        throw new Error('Transfer cancelled by lifecycle or received objective');
      }
    };
    try { beforeSend(); return await this.options.send(message, ttlMs, beforeSend); }
    finally { workspace.releaseStaging(key); this.pendingSends.set(from, this.pendingSends.get(from)! - 1); }
  }
  receive(id: DroneId, message: RadioMessage): void {
    if (message.kind !== 'transfer') return;
    let announced: RecordEntry | undefined;
    try {
      this.check(id);
      if (!isDroneId(message.from, this.options.roster) || message.to !== id || message.from === id) throw new Error('Invalid transfer sender or recipient');
      const data = message.data ?? {}, transferId = String(data.transferId ?? '');
      if (!/^[a-f\d-]{36}$/.test(transferId)) throw new Error('Invalid transfer identity');
      let entry = this.entries(id).get(transferId);
      if (data.operation === 'cancel') {
        if (!entry && typeof data.path === 'string' && typeof data.bytes === 'number' && typeof data.sha256 === 'string' && typeof data.deadlineMs === 'number'
          && /^[a-f0-9]{64}$/.test(data.sha256) && Number.isSafeInteger(data.bytes) && data.bytes >= 0 && data.bytes <= ONBOARD_LIMITS.file
          && data.deadlineMs > performance.now() && data.deadlineMs <= performance.now() + LIFETIME_MS + 1000) {
          workspacePath(data.path);
          entry = { id: transferId, from: message.from, to: id, path: data.path, bytes: data.bytes, sha256: data.sha256,
            expiresAt: data.deadlineMs, mission: message.mission, direction: 'incoming', state: 'cancelled' };
          this.reserve(id, entry, 0);
        }
        if (entry && (entry.from === message.from || entry.to === message.from)) this.remove(id, entry);
        return;
      }
      if (entry?.cancelled) return;
      if (data.operation === 'result') {
        if (!entry || entry.direction !== 'outgoing' || entry.to !== message.from) return;
        if (data.verified === true && data.sha256 === entry.sha256) { entry.state = 'complete'; delete entry.content; if (!entry.pumping) this.options.workspace(id).reserveStaging(`radio:${entry.id}`, METADATA_BYTES); }
        else this.fail(id, entry, String(data.reason ?? 'Recipient rejected transfer'));
        return;
      }
      if (data.operation !== 'chunk' || typeof data.content !== 'string' || !Number.isInteger(data.index) || typeof data.bytes !== 'number' || typeof data.deadlineMs !== 'number' || typeof data.path !== 'string' || typeof data.sha256 !== 'string') throw new Error('Invalid transfer announcement/chunk');
      workspacePath(data.path);
      if (!Number.isSafeInteger(data.bytes) || data.bytes < 0 || data.bytes > ONBOARD_LIMITS.file || !/^[a-f0-9]{64}$/.test(data.sha256)
        || !Number.isFinite(data.deadlineMs) || data.deadlineMs <= performance.now() || data.deadlineMs > performance.now() + LIFETIME_MS + 1000
        || (data.index as number) < 0 || (data.index as number) >= 64 || Buffer.byteLength(data.content) > 4096) throw new Error('Invalid bounded transfer metadata or chunk');
      if (!entry) {
        entry = { id: transferId, from: message.from, to: id, path: data.path, bytes: data.bytes, sha256: data.sha256,
          expiresAt: data.deadlineMs, mission: message.mission, direction: 'incoming', state: 'sending' };
        announced = entry;
        this.reserve(id, entry, 0);
        try { this.options.workspace(id).beginTransfer({ id: entry.id, path: entry.path, size: entry.bytes, sha256: entry.sha256, expiresAt: entry.expiresAt }); }
        catch (error) { this.fail(id, entry, String(error)); throw error; }
      }
      if (entry.direction !== 'incoming' || entry.from !== message.from || entry.sha256 !== data.sha256 || entry.bytes !== data.bytes || entry.path !== data.path) throw new Error('Conflicting transfer announcement');
      if (entry.state === 'failed') return;
      const workspace = this.options.workspace(id);
      workspace.transferChunk(entry.id, data.index as number, data.content);
      const current = workspace.getTransfer(entry.id);
      if (!current.ready && current.received === current.size) {
        workspace.completeTransfer(entry.id); entry.state = 'complete';
        void this.send(id, entry.from, entry, { operation: 'result', verified: true }).catch(() => {});
        this.options.onEvent?.({ event: 'transfer-verified', drone: id, ...this.describe(entry) });
      }
    } catch (error) {
      const entry = this.entries(id).get(String(message.data?.transferId ?? '')) ?? announced;
      if (entry) {
        this.fail(id, entry, String(error));
        void this.send(id, message.from as DroneId, entry, { operation: 'result', verified: false, reason: String(error).slice(0, 160) }).catch(() => {});
      }
      this.options.onEvent?.({ event: 'transfer-rejected', drone: id, messageId: message.id, reason: String(error).slice(0, 200) });
    } finally {
      // Native mail was stored before ACK. Processing is now complete (including
      // an explicit rejection); source code remains inert and is never an inbox tool result.
      this.options.consume(id, [message.id]);
    }
  }
  retire(id: DroneId): void { for (const entry of this.entries(id).values()) this.remove(id, entry, true); }
  stop(): void { this.stopped = true; clearInterval(this.timer); for (const id of this.records.keys()) this.retire(id); }
}
