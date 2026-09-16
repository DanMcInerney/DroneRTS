import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Input, Issue, RecordAt, Run } from './types.ts';

// Replay writes <=32 MiB, <=2 MiB header and <=1 MiB records. The retained
// 900-second audit/replay measured 14.6/14.7 MB. Bounds include ample headroom.
export const LIMITS = { file: 128 * 1024 * 1024, record: 2 * 1024 * 1024, records: 100_000,
  metadata: 16 * 1024 * 1024, image: 512 * 1024, images: 64 * 1024 * 1024 } as const;
export const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Reject links at every ancestor, including Windows junctions. Never follow a manifest path. */
export async function safePath(root: string, name = ''): Promise<string> {
  if (name && (isAbsolute(name) || /(^|[\\/])\.\.([\\/]|$)|:/.test(name))) throw new Error(`Unsafe evidence path: ${name}`);
  const target = resolve(root, name), rel = relative(resolve(root), target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Escaping evidence path: ${name}`);
  for (let current = target; ; current = dirname(current)) {
    const s = await lstat(current).catch(error => { if (error.code === 'ENOENT') return; throw error; });
    if (s?.isSymbolicLink()) throw new Error(`Linked evidence path: ${current}`);
    if (dirname(current) === current) break;
  }
  return target;
}

async function signature(path: string) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink()) throw new Error(`Evidence is not a regular file: ${path}`);
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
}
async function digest(path: string) {
  const h = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > LIMITS.file) throw new Error('Input grew beyond the file limit while hashing');
    h.update(chunk);
  }
  return h.digest('hex');
}
async function boundedBytes(path: string, limit: number) {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('Input exceeds the metadata limit');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Streams bytes, keeps line locations, never silently skips malformed/limited records. */
export async function readJsonLines(path: string, file: string, issues: Issue[], maxRecords: number = LIMITS.records) {
  const records: RecordAt[] = []; let line = 0, pending = Buffer.alloc(0), oversized = false, invalid = 0, scanned = 0;
  function consume(bytes: Buffer, terminated: boolean) {
    line++;
    if (oversized || bytes.length > LIMITS.record) {
      issues.push({ kind: 'record-limit', ref: { file, line }, detail: 'Record exceeds 2 MiB' }); invalid++; return;
    }
    if (!bytes.toString('utf8').trim()) return;
    if (records.length >= maxRecords) {
      if (!issues.some(i => i.kind === 'index-limit' && i.ref.file === file)) issues.push({ kind: 'index-limit', ref: { file, line }, detail: `Index exceeds ${maxRecords} records` });
      return;
    }
    try {
      const data = JSON.parse(bytes.toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a record object');
      records.push({ data, ref: { file, line }, order: line });
    } catch {
      invalid++; issues.push({ kind: terminated ? 'corrupt-record' : 'truncated-tail', ref: { file, line }, detail: 'Malformed JSONL record' });
    }
  }
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer; let start = 0;
    scanned += bytes.length;
    if (scanned > LIMITS.file) throw new Error('Input grew beyond the file limit while reading');
    for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) {
      const part = bytes.subarray(start, end);
      consume(oversized ? Buffer.alloc(0) : Buffer.concat([pending, part]), true);
      pending = Buffer.alloc(0); oversized = false; start = end + 1;
    }
    if (!oversized) {
      pending = Buffer.concat([pending, bytes.subarray(start)]);
      if (pending.length > LIMITS.record) { oversized = true; pending = Buffer.alloc(0); }
    }
  }
  if (pending.length || oversized) consume(pending, false);
  return { records, invalid };
}

export async function loadRun(directory: string, options: { closedByRunner?: boolean; legacy?: boolean;
  validateMetadata?: (result: any, manifest: any) => void | Promise<void> } = {}): Promise<Run> {
  directory = await realpath(await safePath(resolve(directory)));
  const run: Run = { directory, result: {}, manifest: {}, replayStatus: {}, cleanup: {}, audit: [], replay: [], inputs: [], issues: [] };
  const identities = new Map<string, { path: string; signature: string; sha256: string }>();
  async function input(file: string, kind: 'json' | 'jsonl' | 'image', optional = false): Promise<any> {
    const path = await safePath(directory, file);
    let before: string;
    try { before = await signature(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      run.inputs.push({ file, state: 'missing' });
      if (!optional) run.issues.push({ kind: 'missing-input', ref: { file }, detail: 'Input unavailable' });
      return kind === 'jsonl' ? [] : {};
    }
    const bytes = (await lstat(path)).size;
    const limit = kind === 'json' ? LIMITS.metadata : kind === 'image' ? LIMITS.image : LIMITS.file;
    if (bytes > limit) {
      run.inputs.push({ file, bytes, state: 'limited' });
      run.issues.push({ kind: 'file-limit', ref: { file }, detail: `Input exceeds ${limit} bytes` });
      return kind === 'jsonl' ? [] : {};
    }
    const sha256 = await digest(path), entry: Input = { file, bytes, sha256, state: 'read' }; run.inputs.push(entry);
    let value: any = {};
    if (kind === 'jsonl') {
      const loaded = await readJsonLines(path, file, run.issues);
      value = loaded.records; entry.records = value.length; entry.invalid = loaded.invalid;
    } else if (kind === 'json') {
      const bytes = await boundedBytes(path, LIMITS.metadata);
      try { value = JSON.parse(bytes.toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); }
      catch { run.issues.push({ kind: 'invalid-metadata', ref: { file }, detail: 'Expected JSON object' }); value = {}; }
    }
    identities.set(file, { path, signature: before, sha256 });
    return value;
  }
  // A grouped managed trial can have its marker on an ancestor directory.
  for (let current = directory; ; current = dirname(current)) {
    const marker = await safePath(current, '.run.json');
    const bytes = await boundedBytes(marker, LIMITS.metadata).catch(error => { if (error.code === 'ENOENT') return; throw error; });
    if (bytes) {
      if (bytes.length > LIMITS.metadata) throw new Error('Oversized managed-run marker');
      const m = JSON.parse(bytes.toString());
      if (m.schema !== 'fleet-test-artifacts/1' || typeof m.completed !== 'boolean' || !Number.isInteger(m.pid) || m.pid <= 0) throw new Error('Invalid managed-run marker');
      let alive = true;
      try { process.kill(m.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
      if (!m.completed && alive && !(options.closedByRunner && m.pid === process.pid)) throw new Error('Refusing to audit an active managed run');
    }
    if (dirname(current) === current) break;
  }
  run.result = await input('result.json', 'json');
  run.manifest = await input('source-manifest.json', 'json', options.legacy);
  await options.validateMetadata?.(run.result, run.manifest);
  if (run.result.cleanup === 'pending') throw new Error('Trial writers have not closed');
  const session = run.result.sessionId;
  if (session !== undefined && (typeof session !== 'string' || !/^session-[\w-]+\.jsonl$/.test(session))) throw new Error('Invalid session audit basename');
  if (session) {
    run.sessionFile = session; run.replayDirectory = `replays/${session.slice(0, -6)}`;
    run.replayStatus = await input(`${run.replayDirectory}/status.json`, 'json', true);
    if (run.replayStatus.state === 'recording') throw new Error('Replay writer is still recording');
    run.audit = await input(session, 'jsonl');
    run.replay = await input(`${run.replayDirectory}/frames.jsonl`, 'jsonl');
    {
      let total = 0;
      const images = new Set<string>();
      for (const record of run.replay) if (record.data.type === 'observation' && record.data.imageId !== undefined) {
        const id = record.data.imageId;
        if (typeof id !== 'string' || !/^[\w-]+\.(jpg|jpeg|png)$/.test(id)) throw new Error('Invalid replay image basename');
        await safePath(directory, `${run.replayDirectory}/${id}`);
        if (options.legacy) continue;
        if (images.has(id)) continue;
        images.add(id);
        const imageBytes = (await lstat(await safePath(directory, `${run.replayDirectory}/${id}`)).catch(error => { if (error.code === 'ENOENT') return; throw error; }))?.size ?? 0;
        if (total + imageBytes > LIMITS.images) { run.issues.push({ kind: 'image-limit', ref: record.ref, detail: 'Image hash budget exhausted' }); break; }
        await input(`${run.replayDirectory}/${id}`, 'image');
        total += run.inputs.at(-1)?.bytes ?? 0;
      }
      if (!options.legacy) run.cleanup = await input('cleanup-check.json', 'json', true);
    }
  } else run.issues.push({ kind: 'missing-session', ref: { file: 'result.json', pointer: '/sessionId' }, detail: 'No recorded session ID' });
  // Rehash at the end too: unchanged size alone cannot establish stable input.
  for (const [file, identity] of identities) {
    await safePath(directory, file);
    if (await signature(identity.path) !== identity.signature || await digest(identity.path) !== identity.sha256) throw new Error(`Input changed during audit: ${file}`);
  }
  if (options.legacy && run.issues.length) throw new Error(`Incomplete analysis input: ${run.issues[0].detail}`);
  return run;
}
