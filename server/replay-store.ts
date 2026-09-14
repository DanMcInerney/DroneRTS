import { Router } from 'express';
import { pipeline } from 'node:stream/promises';
import type { ReplayPage, ReplayRecord } from '../shared/replay.ts';
import { missing, REPLAY_IMAGE, replayDirectory, ReplayError, replayFile } from './replay-paths.ts';

const PAGE_BYTES = 4 * 1024 * 1024, RECORD_BYTES = 2 * 1024 * 1024, PAGE_RECORDS = 256;
const TYPES = new Set(['header', 'frame', 'command', 'observation', 'event', 'end']);

/** Byte cursors read only complete records, even while a match is recording. */
export class ReplayStore {
  constructor(private directory: string) {}
  async page(id: string, after = 0): Promise<ReplayPage> {
    if (!Number.isSafeInteger(after) || after < 0) throw new ReplayError('Invalid replay cursor.');
    let directory: string, file;
    try { directory = await replayDirectory(this.directory, id); file = await replayFile(directory, 'frames.jsonl'); }
    catch (error) { if (missing(error)) return { available: false, records: [], next: 0, hasMore: false, bytes: 0 }; throw error; }
    try {
      // This small independent marker exposes writer failures even after a partial line.
      let status;
      try {
        status = await replayFile(directory, 'status.json');
        if ((await status.stat()).size > 2048) throw new ReplayError('Replay status is oversized.', 409);
        const value = JSON.parse(await status.readFile('utf8')) as { state: string };
        if (value.state === 'error') throw new ReplayError('Replay recording failed. Its audit log contains the storage error.', 409);
      } catch (error) { if (!missing(error)) throw error; } finally { await status?.close(); }
      const { size } = await file.stat();
      if (after > size) throw new ReplayError('Replay changed; reload this session.', 409);
      if (after > 0) {
        const previous = Buffer.alloc(1); await file.read(previous, 0, 1, after - 1);
        if (previous[0] !== 10) throw new ReplayError('Replay cursor must follow a complete record.');
      }
      // Reserve space for the JSON envelope so an HTTP page stays below 4 MiB.
      const buffer = Buffer.alloc(Math.min(size - after, PAGE_BYTES - 1024));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, after);
      const data = buffer.subarray(0, bytesRead), records: ReplayRecord[] = [];
      let cursor = 0;
      while (cursor < data.length && records.length < PAGE_RECORDS) {
        const newline = data.indexOf(10, cursor);
        if (newline < 0) {
          if (data.length - cursor > RECORD_BYTES) throw new ReplayError('Replay contains an oversized record.', 413);
          break; // Keep the same cursor until the writer finishes this line.
        }
        if (newline - cursor > RECORD_BYTES) throw new ReplayError('Replay contains an oversized record.', 413);
        let record: ReplayRecord;
        try { record = JSON.parse(data.subarray(cursor, newline).toString('utf8')); }
        catch { throw new ReplayError('Replay contains a malformed record.', 409); }
        if (!record || !TYPES.has(record.type)) throw new ReplayError('Replay contains an unknown record.', 409);
        records.push(record); cursor = newline + 1;
      }
      return { available: true, records, next: after + cursor, hasMore: after + cursor < size, bytes: size };
    } finally { await file.close(); }
  }

  async image(id: string, imageId: string) {
    if (!REPLAY_IMAGE.test(imageId)) throw new ReplayError('Choose a valid replay image.');
    try {
      const directory = await replayDirectory(this.directory, id), file = await replayFile(directory, imageId);
      if ((await file.stat()).size > 512 * 1024) { await file.close(); throw new ReplayError('Replay image exceeds its size limit.', 413); }
      return { file, mimeType: imageId.endsWith('.png') ? 'image/png' : 'image/jpeg' };
    } catch (error) { if (missing(error)) throw new ReplayError('Replay image unavailable.', 404); throw error; }
  }
}

export function replayRouter(options: { directory: string }) {
  const router = Router(), store = new ReplayStore(options.directory);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
  router.get('/sessions/:id/replay', async (req, res) => {
    const after = req.query.after;
    if (after !== undefined && (typeof after !== 'string' || !/^\d+$/.test(after))) throw new ReplayError('Invalid replay cursor.');
    res.json(await store.page(String(req.params.id), after === undefined ? 0 : Number(after)));
  });
  router.get('/sessions/:id/replay/images/:imageId', async (req, res) => {
    const { file, mimeType } = await store.image(String(req.params.id), String(req.params.imageId));
    res.type(mimeType);
    try { await pipeline(file.createReadStream(), res); }
    catch (error) { if (!res.destroyed) res.destroy(error as Error); }
    finally { await file.close().catch(() => {}); }
  });
  router.use((error: Error, _req: import('express').Request, res: import('express').Response, _next: import('express').NextFunction) => {
    res.status(error instanceof ReplayError ? error.status : 500).json({ error: error instanceof ReplayError ? error.message : 'Could not read replay evidence.' });
  });
  return router;
}
