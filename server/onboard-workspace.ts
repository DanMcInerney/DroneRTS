import { createHash, randomUUID } from 'node:crypto';
import { onboardRuntimeBytes } from './onboard-manifest.ts';

const KiB = 1024;
export const ONBOARD_LIMITS = Object.freeze({ runtime: 8 * 1024 * KiB, workspace: 2 * 1024 * KiB, radio: 4 * 1024 * KiB, staging: 1024 * KiB, logs: 1024 * KiB, diagnosticLogs: 512 * KiB, localEvents: 512 * KiB, file: 64 * KiB, files: 256, name: 128, networkTransaction: 256 * KiB, optionalLibraries: 256 * KiB });
export class OnboardStorageError extends Error {
  constructor(public readonly code: string, public readonly partition: string, message: string) { super(message); this.name = 'OnboardStorageError'; }
}
export interface WorkspaceFile { path: string; bytes: number; sha256: string; version: number; metadataBytes: number }
interface Version extends WorkspaceFile { content: Buffer; refs: number }
interface Transfer { id: string; path: string; size: number; sha256: string; expiresAt: number; chunks: Map<number, Buffer>; received: number; ready: boolean; allocation: number }
export interface WorkspaceSnapshot { id: string; entry: WorkspaceFile; files: Record<string, { source: string; sha256: string; version: number }>; release(): void }
export type PartitionUsage = { usedBytes: number; limitBytes: number; freeBytes: number };
export interface OnboardStorageStatus { runtime: PartitionUsage; workspace: PartitionUsage; radio: PartitionUsage; staging: PartitionUsage; logs: PartitionUsage; files: number; retainedVersions: number; revoked: boolean }
export function onboardHash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export function workspacePath(path: string): string {
  if (typeof path !== 'string' || !path || Buffer.byteLength(path) > ONBOARD_LIMITS.name || !/^[\p{L}\p{N}_./ -]+$/u.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..') || !/\.(md|json|js|mjs|txt|png|jpg)$/i.test(path)) throw new OnboardStorageError('invalid_path', 'workspace', 'Use a relative workspace filename (128 UTF-8 bytes maximum), without parent traversal.');
  return path;
}
/** A byte-accounted virtual disk. Persistent within one match, never a host filesystem path. */
export class OnboardWorkspace {
  private files = new Map<string, Version>();
  private versions = new Set<Version>();
  private staging = new Map<string, number>();
  private transfers = new Map<string, Transfer>();
  private logs: Buffer[] = [];
  private logBytes = 0;
  private sequence = 0;
  private revoked = false;
  constructor(private options: { runtimeBytes?: number; radioBytes?: () => number; eventBytes?: () => number; now?: () => number } = {}) {
    this.options = { ...options, runtimeBytes: options.runtimeBytes ?? onboardRuntimeBytes() };
    if (this.options.runtimeBytes! > ONBOARD_LIMITS.runtime) throw new OnboardStorageError('runtime_full', 'runtime', 'Measured application assets exceed the 8 MiB runtime partition.');
  }
  private check(): void { if (this.revoked) throw new OnboardStorageError('revoked', 'workspace', 'Onboard access was revoked.'); this.expireTransfers(); }
  private used(): number { let total = 0; for (const item of this.versions) total += item.bytes + item.metadataBytes; return total; }
  private describe(value: Version): WorkspaceFile { return { path: value.path, bytes: value.bytes, sha256: value.sha256, version: value.version, metadataBytes: value.metadataBytes }; }
  list(): WorkspaceFile[] { this.check(); return [...this.files.values()].map(item => this.describe(item)).sort((a, b) => a.path.localeCompare(b.path)); }
  /** Player inspection must not expire transfers, allocate storage or change actor state. */
  inspect(): { entries: WorkspaceFile[]; status: OnboardStorageStatus } {
    return { entries: this.revoked ? [] : [...this.files.values()].map(item => this.describe(item)).sort((a, b) => a.path.localeCompare(b.path)), status: this.describeStatus() };
  }
  inspectFile(path: string): { entry: WorkspaceFile; content: string } {
    if (this.revoked) throw new OnboardStorageError('revoked', 'workspace', 'Onboard access was revoked.');
    const value = this.files.get(workspacePath(path));
    if (!value) throw new OnboardStorageError('not_found', 'workspace', 'Workspace file does not exist.');
    return { entry: this.describe(value), content: value.content.toString('utf8') };
  }
  stat(path: string): WorkspaceFile { this.check(); const value = this.files.get(workspacePath(path)); if (!value) throw new OnboardStorageError('not_found', 'workspace', 'Workspace file does not exist.'); return this.describe(value); }
  read(path: string): string { this.stat(path); return this.files.get(path)!.content.toString('utf8'); }
  write(path: string, content: string): WorkspaceFile {
    this.check(); workspacePath(path);
    if (typeof content !== 'string') throw new OnboardStorageError('invalid_content', 'workspace', 'File content must be UTF-8 text.');
    const bytes = Buffer.byteLength(content);
    if (bytes > ONBOARD_LIMITS.file) throw new OnboardStorageError('file_full', 'workspace', 'A workspace file may use at most 65536 UTF-8 bytes.');
    const old = this.files.get(path), hash = onboardHash(content);
    if (old?.sha256 === hash) return this.describe(old);
    if (this.versions.size - (old && old.refs === 0 ? 1 : 0) >= ONBOARD_LIMITS.files) throw new OnboardStorageError('file_count_full', 'workspace', 'The workspace already contains 256 files, including retained versions.');
    const next = { path, bytes, sha256: hash, version: this.sequence + 1 };
    // The serialized inode and its UTF-8 name are charged alongside bytes, including retained versions.
    const metadataBytes = Buffer.byteLength(JSON.stringify(next)) + 32;
    const allocation = bytes + metadataBytes;
    const freed = old && old.refs === 0 ? old.bytes + old.metadataBytes : 0;
    if (this.used() - freed + allocation > ONBOARD_LIMITS.workspace) throw new OnboardStorageError('workspace_full', 'workspace', 'Workspace partition full; delete files or finish routines retaining older versions.');
    const stagingKey = `write:${randomUUID()}`;
    this.reserveStaging(stagingKey, allocation);
    try {
      const value: Version = { ...next, metadataBytes, content: Buffer.from(content, 'utf8'), refs: 0 };
      this.files.set(path, value); this.versions.add(value); this.sequence++;
      if (old && old.refs === 0) this.versions.delete(old);
      return this.describe(value);
    } finally { this.releaseStaging(stagingKey); }
  }
  delete(path: string): { deleted: true; retained: boolean } {
    this.stat(path); const value = this.files.get(path)!; this.files.delete(path);
    if (value.refs === 0) this.versions.delete(value);
    return { deleted: true, retained: value.refs > 0 };
  }
  pin(path: string): WorkspaceSnapshot {
    this.stat(path);
    if (!/\.m?js$/i.test(path)) throw new OnboardStorageError('not_script', 'workspace', 'Routine entry must be a .js or .mjs file.');
    const pinned = [...this.files.values()].filter(item => /\.m?js$/i.test(item.path));
    const files: WorkspaceSnapshot['files'] = Object.create(null);
    for (const item of pinned) { item.refs++; files[item.path] = { source: item.content.toString('utf8'), sha256: item.sha256, version: item.version }; }
    let released = false;
    return { id: randomUUID(), entry: this.stat(path), files, release: () => {
      if (released) return; released = true;
      for (const item of pinned) { item.refs--; if (!item.refs && this.files.get(item.path) !== item) this.versions.delete(item); }
    } };
  }
  reserveStaging(key: string, bytes: number): void {
    if (this.revoked) throw new OnboardStorageError('revoked', 'staging', 'Onboard access was revoked.');
    if (!Number.isSafeInteger(bytes) || bytes < 0 || key.length > 160) throw new OnboardStorageError('invalid_allocation', 'staging', 'Invalid staging allocation.');
    let used = ONBOARD_LIMITS.networkTransaction; for (const allocation of this.staging.values()) used += allocation;
    if (used - (this.staging.get(key) ?? 0) + bytes > ONBOARD_LIMITS.staging) throw new OnboardStorageError('staging_full', 'staging', 'Staging partition full; finish or cancel transfers.');
    this.staging.set(key, bytes);
  }
  releaseStaging(key: string): void { this.staging.delete(key); }
  beginTransfer(input: { id: string; path: string; size: number; sha256: string; expiresAt: number }): void {
    this.check(); workspacePath(input.path);
    if (!/^[a-zA-Z0-9_-]{1,96}$/.test(input.id) || !Number.isSafeInteger(input.size) || input.size < 0 || input.size > ONBOARD_LIMITS.file || !/^[a-f0-9]{64}$/.test(input.sha256) || !Number.isFinite(input.expiresAt) || input.expiresAt <= this.now() || input.expiresAt > this.now() + 300_000) throw new OnboardStorageError('invalid_transfer', 'staging', 'Transfer requires bounded size, SHA-256 and an expiry within five minutes.');
    const prior = this.transfers.get(input.id);
    if (prior) { if (prior.path === input.path && prior.sha256 === input.sha256 && prior.size === input.size) return; throw new OnboardStorageError('transfer_conflict', 'staging', 'Transfer identity already exists with different content.'); }
    // Reserve full announced content, bounded chunk metadata, plus a full verification/UTF-8-copy peak.
    const allocation = input.size * 3 + 4096 + Buffer.byteLength(JSON.stringify(input));
    this.reserveStaging(`transfer:${input.id}`, allocation);
    this.transfers.set(input.id, { ...input, chunks: new Map(), received: 0, ready: false, allocation });
  }
  transferChunk(id: string, index: number, content: string): void {
    this.check(); const transfer = this.transfer(id); const bytes = Buffer.byteLength(content);
    if (!Number.isInteger(index) || index < 0 || index >= 64 || typeof content !== 'string' || bytes > 4096) throw new OnboardStorageError('invalid_chunk', 'staging', 'Transfer chunks must have index 0–63 and at most 4096 UTF-8 bytes.');
    const previous = transfer.chunks.get(index);
    if (previous) { if (previous.toString('utf8') === content) return; throw new OnboardStorageError('chunk_conflict', 'staging', 'Duplicate chunk content differs.'); }
    if (transfer.ready || transfer.received + bytes > transfer.size) throw new OnboardStorageError('transfer_full', 'staging', 'Chunk exceeds announced transfer size or transfer is already complete.');
    transfer.chunks.set(index, Buffer.from(content)); transfer.received += bytes;
  }
  completeTransfer(id: string): { verified: true; sha256: string } {
    this.check(); const transfer = this.transfer(id); const content = this.transferBytes(transfer);
    if (content.length !== transfer.size || onboardHash(content) !== transfer.sha256) throw new OnboardStorageError('hash_mismatch', 'staging', 'Transfer is incomplete or its SHA-256 does not match.');
    transfer.ready = true; return { verified: true, sha256: transfer.sha256 };
  }
  importTransfer(id: string, path?: string): WorkspaceFile {
    this.check(); const transfer = this.transfer(id);
    if (!transfer.ready) throw new OnboardStorageError('unverified_transfer', 'staging', 'Verify all chunks before choosing to import.');
    const content = this.transferBytes(transfer).toString('utf8');
    const result = this.write(path ?? transfer.path, content); this.cancelTransfer(id); return result;
  }
  getTransfer(id: string): { id: string; path: string; size: number; received: number; ready: boolean; sha256: string; expiresAt: number } {
    this.check(); const value = this.transfer(id); return { id: value.id, path: value.path, size: value.size, received: value.received, ready: value.ready, sha256: value.sha256, expiresAt: value.expiresAt };
  }
  cancelTransfer(id: string): void { this.transfers.delete(id); this.releaseStaging(`transfer:${id}`); }
  private transfer(id: string): Transfer { const value = this.transfers.get(id); if (!value) throw new OnboardStorageError('transfer_missing', 'staging', 'Transfer does not exist or expired.'); return value; }
  private transferBytes(value: Transfer): Buffer { const ordered = [...value.chunks.entries()].sort((a,b) => a[0]-b[0]); if (ordered.some(([index], offset) => index !== offset)) throw new OnboardStorageError('missing_chunk', 'staging', 'Transfer has missing chunks.'); return Buffer.concat(ordered.map(([, bytes]) => bytes)); }
  private now(): number { return this.options.now?.() ?? performance.now(); }
  private expireTransfers(): void { for (const value of this.transfers.values()) if (value.expiresAt <= this.now()) this.cancelTransfer(value.id); }
  appendLog(value: unknown): void {
    if (this.revoked) return;
    const line = Buffer.from(JSON.stringify(value) + '\n');
    if (line.length > 16 * KiB) return;
    while (this.logBytes + line.length > ONBOARD_LIMITS.diagnosticLogs || this.logs.length >= 2048) this.logBytes -= this.logs.shift()!.length;
    this.logs.push(line); this.logBytes += line.length;
  }
  status(): OnboardStorageStatus {
    this.expireTransfers();
    return this.describeStatus();
  }
  private describeStatus(): OnboardStorageStatus {
    const usage = (usedBytes: number, limitBytes: number): PartitionUsage => ({ usedBytes, limitBytes, freeBytes: Math.max(0, limitBytes - usedBytes) });
    return { runtime: usage(this.options.runtimeBytes ?? 0, ONBOARD_LIMITS.runtime), workspace: usage(this.used(), ONBOARD_LIMITS.workspace), radio: usage(this.options.radioBytes?.() ?? 0, ONBOARD_LIMITS.radio), staging: usage(ONBOARD_LIMITS.networkTransaction + [...this.staging.values()].reduce((a,b) => a+b, 0), ONBOARD_LIMITS.staging), logs: usage(this.logBytes + (this.options.eventBytes?.() ?? 0), ONBOARD_LIMITS.logs), files: this.files.size, retainedVersions: [...this.versions].filter(value => this.files.get(value.path) !== value).length, revoked: this.revoked };
  }
  revoke(): void { this.revoked = true; this.files.clear(); this.versions.clear(); this.transfers.clear(); this.staging.clear(); this.logs = []; this.logBytes = 0; }
  reset(): void { this.revoke(); this.revoked = false; this.sequence = 0; }
}
