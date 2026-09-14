import { Router } from 'express';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { GameState } from '../shared/types.ts';
import { DEFAULT_FLEET, isDroneId, validateRoster, type FleetRoster } from '../shared/fleet.ts';
import { DIAGNOSTIC_CATEGORIES, type DiagnosticCategory, type DiagnosticEvent, type DiagnosticPage, type DiagnosticSession, type DiagnosticStatus } from '../shared/diagnostics.ts';

export type { DiagnosticEvent } from '../shared/diagnostics.ts';

const SESSION = /^session-[\w-]+\.jsonl$/;
const MAX_READ = 512 * 1024;
const MAX_LINE = 128 * 1024;
const CATEGORIES: readonly string[] = DIAGNOSTIC_CATEGORIES.map(([id]) => id);
const SYSTEM_ROLES = ['all', 'parent', 'operator', 'player', 'system'];

/** Applied both before persistence and at read time for historical audit files. */
export function redactDiagnostic(value: unknown, depth = 0): unknown {
  if (depth > 24) return '[nested content omitted]';
  if (typeof value === 'string') {
    if (/^data:image\//i.test(value)) return '[camera image omitted]';
    // MCP text content can contain a JSON sensor bundle or credential object.
    if (value.length < MAX_LINE && /^[\[{]/.test(value.trim())) {
      try { return JSON.stringify(redactDiagnostic(JSON.parse(value), depth + 1)); } catch { /* Ordinary text. */ }
    }
    return value.replace(/data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+/gi, '[camera image omitted]')
      .replace(/\bBearer\s+[A-Za-z0-9_.~+\/-]+=*/gi, 'Bearer [redacted]')
      .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[redacted]')
      .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)\s*[=:]\s*)["']?[^\s,"';]+["']?/gi, '$1[redacted]')
      .replace(/\/(mcp|policy)\/[a-f0-9]{32,}/gi, '/$1/[redacted]')
      .slice(0, 48_000) + (value.length > 48_000 ? '\n[long text truncated]' : '');
  }
  if (Array.isArray(value)) return value.slice(0, 256).map(item => redactDiagnostic(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).slice(0, 256).map(([key, item]) => {
    const normalized = key.replace(/[-_]/g, '').toLowerCase();
    const secret = /(?:token|apikey|password|secret)$/.test(normalized) || /^(authorization|cookie|setcookie|credentials|encryptedcontent)$/.test(normalized);
    const camera = (record.type === 'image' || record.type === 'image_url' || record.type === 'input_image') && ['data', 'url', 'image_url'].includes(key);
    return [key, secret ? '[redacted]' : camera ? '[camera image omitted]' : redactDiagnostic(item, depth + 1)];
  }));
}

function classify(type: string, value: Record<string, unknown>): DiagnosticCategory {
  if (/error|fatal|denied|failed/.test(`${type} ${value.type ?? ''} ${value.event ?? ''} ${value.status ?? ''}`)) return 'errors';
  if (type === 'mavlink') return 'mavlink';
  if (type === 'network' || type === 'radio' || type === 'network-link') return 'network';
  if (type === 'observation') return 'sensors';
  if (type === 'tool' || (type === 'agent' && /tool|mcp-result/.test(String(value.type)))) return 'tools';
  if (type === 'agent') return 'agents';
  return 'system';
}
function eventAt(line: string, offset: number): DiagnosticEvent {
  try {
    const record = redactDiagnostic(JSON.parse(line)) as Record<string, unknown>;
    const value = record.value && typeof record.value === 'object' ? record.value as Record<string, unknown> : {};
    const type = typeof record.type === 'string' ? record.type : 'unknown';
    const role = String(value.role ?? value.droneId ?? value.drone ?? value.from ?? 'system').replace('drone_', 'drone-');
    const subtype = String(value.event ?? value.type ?? value.name ?? value.kind ?? value.status ?? '');
    return { offset, wallTime: String(record.wallTime ?? ''), type, role, category: classify(type, value), title: `${type}${subtype ? ` · ${subtype}` : ''}`, value: record.value ?? record };
  } catch {
    return { offset, wallTime: '', type: 'invalid-record', role: 'system', category: 'errors', title: 'Unreadable audit record', value: { message: 'This JSONL record is malformed; its contents were omitted.' } };
  }
}

export class DiagnosticsError extends Error { constructor(message: string, public status = 400) { super(message); } }
export class DiagnosticsStore {
  private readonly roster: FleetRoster;
  constructor(private directory: string, roster: FleetRoster = DEFAULT_FLEET) { this.roster = validateRoster(roster); }
  async list() {
    const sessions: DiagnosticSession[] = [];
    let directory;
    try { directory = await opendir(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    for await (const entry of directory) {
      if (!SESSION.test(entry.name) || !entry.isFile()) continue;
      const stats = await lstat(resolve(this.directory, entry.name)).catch(() => null);
      if (!stats?.isFile()) continue;
      sessions.push({ id: entry.name, bytes: stats.size, updatedAt: stats.mtime.toISOString() });
      // Keep the newest 200 without retaining an unbounded directory listing.
      if (sessions.length > 200) { sessions.sort((a, b) => b.id.localeCompare(a.id)); sessions.pop(); }
    }
    return sessions.sort((a, b) => b.id.localeCompare(a.id));
  }
  private async file(id: string) {
    if (!SESSION.test(id)) throw new DiagnosticsError('Choose a valid session log.');
    const path = resolve(this.directory, id);
    try {
      if (!(await lstat(path)).isFile()) throw new DiagnosticsError('Session log unavailable.', 404);
      const directory = await realpath(this.directory);
      if (!(await realpath(path)).startsWith(directory + sep)) throw new DiagnosticsError('Session log unavailable.', 404);
      return await open(path, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DiagnosticsError('Session log unavailable.', 404);
      throw error;
    }
  }
  async page(id: string, options: { after?: number; before?: number; limit?: number; category?: string; role?: string; query?: string } = {}): Promise<DiagnosticPage> {
    const limit = options.limit ?? 100, category = options.category ?? 'all', role = options.role ?? 'all', query = (options.query ?? '').toLowerCase();
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !CATEGORIES.includes(category) || !(SYSTEM_ROLES.includes(role) || isDroneId(role, this.roster)) || query.length > 200) throw new DiagnosticsError('Invalid event filters.');
    for (const cursor of [options.before, options.after]) if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new DiagnosticsError('Invalid event cursor.');
    if (options.before !== undefined && options.after !== undefined) throw new DiagnosticsError('Choose one event cursor.');
    const file = await this.file(id);
    try {
      const { size } = await file.stat();
      if ((options.after ?? options.before ?? 0) > size) throw new DiagnosticsError('Log changed; reload this session.', 409);
      const forward = options.after !== undefined;
      const end = forward ? Math.min(size, options.after! + MAX_READ) : Math.min(size, options.before ?? size);
      const start = forward ? options.after! : Math.max(0, end - MAX_READ);
      // One preceding byte distinguishes a line boundary from a clipped record.
      const readStart = Math.max(0, start - 1);
      const buffer = Buffer.alloc(end - readStart);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, readStart);
      const data = buffer.subarray(0, bytesRead);
      let cursor = start - readStart;
      if (start > 0 && data[cursor - 1] !== 10) {
        const newline = data.indexOf(10, cursor);
        cursor = newline < 0 ? data.length : newline + 1;
      }
      const scannedStart = readStart + cursor;
      let next = scannedStart, skipped = 0;
      const events: DiagnosticEvent[] = [];
      while (cursor < data.length) {
        const newline = data.indexOf(10, cursor);
        if (newline < 0) {
          // A normal partial writer record remains pending. Oversized records
          // advance by a bounded block and are never parsed or materialized.
          if (data.length - cursor > MAX_LINE) { skipped++; next = readStart + data.length; }
          break;
        }
        const offset = readStart + cursor;
        next = readStart + newline + 1;
        if (newline - cursor > MAX_LINE) { skipped++; cursor = newline + 1; continue; }
        const event = eventAt(data.subarray(cursor, newline).toString('utf8'), offset);
        cursor = newline + 1;
        if (category !== 'all' && event.category !== category) continue;
        const details = JSON.stringify(event.value);
        if (role !== 'all' && event.role !== role && !details.includes(`"${role}"`)) continue;
        if (query && !`${event.title} ${event.role} ${details}`.toLowerCase().includes(query)) continue;
        events.push(event);
        if (forward && events.length >= limit) break;
      }
      const selected = forward ? events : events.slice(-limit);
      // Re-read the clipped first record on the next backward page. Returning
      // `start` would cut that record off at both ends and silently lose it.
      // A block with no newline must still advance through an oversized record.
      const olderCursor = selected[0]?.offset ?? (scannedStart < end ? scannedStart : start);
      return { events: selected, next, before: olderCursor, hasOlder: olderCursor > 0, hasMore: next < size, bytes: size, skipped, scannedBytes: bytesRead, limits: { maxReadBytes: MAX_READ, maxRecordBytes: MAX_LINE } };
    } finally { await file.close(); }
  }
}

export function diagnosticsRouter(options: { directory: string; roster?: FleetRoster; state: () => GameState; activeSession: () => string | undefined }) {
  const router = Router(), store = new DiagnosticsStore(options.directory, options.roster);
  let downloads = 0;
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
  router.get('/sessions', async (_req, res) => { res.json({ sessions: await store.list(), activeSession: options.activeSession() ?? null }); });
  router.get('/status', (_req, res) => {
    const state = options.state();
    const status: DiagnosticStatus = { serverTime: new Date().toISOString(), activeSession: options.activeSession() ?? null, running: state.running, simTime: state.simTime, mission: state.mission, runtime: state.runtime, network: state.network, drones: state.drones.map(({ id, online, status, observations }) => ({ id, online, status, observations })) };
    res.json(redactDiagnostic(status));
  });
  router.get('/sessions/:id/events', async (req, res) => {
    const input = (key: string) => { const value = req.query[key]; if (value !== undefined && typeof value !== 'string') throw new DiagnosticsError('Invalid query parameter.'); return value as string | undefined; };
    const number = (key: string) => { const value = input(key); if (value === undefined) return undefined; if (!/^\d+$/.test(value)) throw new DiagnosticsError('Invalid numeric parameter.'); return Number(value); };
    const page = await store.page(String(req.params.id), { after: number('after'), before: number('before'), limit: number('limit'), category: input('category'), role: input('role'), query: input('q') });
    res.json(page);
  });
  router.get('/sessions/:id/download', async (req, res) => {
    if (downloads >= 2) throw new DiagnosticsError('Two exports are already running. Try again shortly.', 429);
    downloads++;
    try {
      const id = String(req.params.id);
      const first = await store.page(id, { after: 0, limit: 200 });
      if (first.bytes > 32 * 1024 * 1024) throw new DiagnosticsError('This log exceeds the 32 MB export limit. Export the visible filtered events instead.', 413);
      res.type('application/x-ndjson'); res.setHeader('Content-Disposition', `attachment; filename="${id}"`);
      async function* records() {
        let page = first, previous = -1;
        while (!res.destroyed) {
          for (const event of page.events) {
            if (event.offset >= first.bytes) return;
            yield JSON.stringify({ wallTime: event.wallTime, type: event.type, value: event.value }) + '\n';
          }
          if (page.next <= previous || page.next >= first.bytes) return;
          previous = page.next;
          page = await store.page(id, { after: page.next, limit: 200 });
        }
      }
      try { await pipeline(Readable.from(records()), res); }
      catch (error) { if (!res.destroyed) res.destroy(error as Error); }
    }
    finally { downloads--; }
  });
  router.use((error: Error, _req: import('express').Request, res: import('express').Response, _next: import('express').NextFunction) => {
    res.status(error instanceof DiagnosticsError ? error.status : 500).json({ error: error instanceof DiagnosticsError ? error.message : 'Could not read diagnostics.' });
  });
  return router;
}
