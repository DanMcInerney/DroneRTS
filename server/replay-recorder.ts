import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { open, rename, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DroneId, GameState, RadioMessage } from '../shared/types.ts';
import type { MatchEvent } from '../shared/rts.ts';
import type { RecordedObservation, ReplayCancellation, ReplayExecution, ReplayEnd, ReplayHeader, ReplayObservation, ReplayRecord } from '../shared/replay.ts';
import { redactDiagnostic } from './diagnostics.ts';
import { replayDirectory } from './replay-paths.ts';

export interface ReplayLimits {
  dataBytes: number; imageBytes: number; imageSizeBytes: number;
  queueBytes: number; queueRecords: number; queuedImages: number;
}
export const REPLAY_LIMITS: Readonly<ReplayLimits> = Object.freeze({
  dataBytes: 32 * 1024 * 1024, imageBytes: 64 * 1024 * 1024, imageSizeBytes: 512 * 1024,
  queueBytes: 4 * 1024 * 1024, queueRecords: 256, queuedImages: 6,
});
const MAX_HEADER = 2 * 1024 * 1024, MAX_RECORD = 1024 * 1024, END_RESERVE = 1024;
/** Source archives share the bounded replay writer, not actor workspace capacity. */
export const REPLAY_SOURCE_BYTES = 256 * 1024;
interface Job { line: Buffer; image?: { id: string; data: Buffer } }
interface RecorderOptions {
  directory: string; sessionId: string; header: ReplayHeader;
  onWarning?: (message: string) => void; limits?: Partial<ReplayLimits>;
}

/** Player evidence has its own bounded writer; storage never stalls a game tick. */
export class ReplayRecorder {
  private file?: FileHandle;
  private directory?: string;
  private limits: ReplayLimits;
  private queue: Job[] = [];
  private queuedBytes = 0;
  private queuedImages = 0;
  private dataBytes = 0;
  private imageBytes = 0;
  private omittedImages = 0;
  private lastFrame = -Infinity;
  private lastTime = 0;
  private limited = false;
  private failed = false;
  private accepting = false;
  private pumping?: Promise<void>;
  private stopping?: Promise<void>;
  private pendingEnd?: ReplayEnd;

  private constructor(private options: RecorderOptions, private replaceStatus = rename) {
    this.limits = { ...REPLAY_LIMITS, ...options.limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > REPLAY_LIMITS[key as keyof ReplayLimits]) throw new Error(`Invalid replay ${key} limit.`);
    }
  }

  static async create(options: RecorderOptions, io: { replaceStatus?: typeof rename } = {}): Promise<ReplayRecorder> {
    // Invalid optional limits are a programmer error; filesystem failures are not.
    const recorder = new ReplayRecorder(options, io.replaceStatus);
    try {
      const header = Buffer.from(JSON.stringify(options.header) + '\n');
      if (header.length > MAX_HEADER || header.length + END_RESERVE > recorder.limits.dataBytes) throw new Error('Replay header exceeds the recording budget.');
      if (!Number.isFinite(options.header.sampleInterval) || options.header.sampleInterval <= 0) throw new Error('Replay sampling interval must be positive.');
      recorder.directory = await replayDirectory(options.directory, options.sessionId, true);
      recorder.file = await open(resolve(recorder.directory, 'frames.jsonl'), 'wx');
      await recorder.write(header);
      recorder.dataBytes = header.length;
      await recorder.status('recording');
      recorder.accepting = true;
    } catch (error) { await recorder.fail(error); }
    return recorder;
  }

  private warn(message: string) { try { this.options.onWarning?.(message); } catch { /* Diagnostics cannot break simulation. */ } }
  private async status(state: 'recording' | 'stopped' | 'limit' | 'error', message?: string) {
    if (!this.directory) return;
    const temporary = resolve(this.directory, `status-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ state, ...(message ? { message } : {}) }), { flag: 'wx' });
      // Windows can briefly deny replacement while a reader or scanner holds the
      // destination. Keep the old complete marker available and retry atomically;
      // persistent failures still reach the normal explicit error path.
      const backoff = [10, 25, 50, 100, 200];
      for (let attempt = 0; ; attempt++) {
        try { await this.replaceStatus(temporary, resolve(this.directory, 'status.json')); break; }
        catch (error) {
          if (attempt === backoff.length || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          await delay(backoff[attempt]);
        }
      }
    } finally { await unlink(temporary).catch(() => {}); }
  }
  private async write(data: Buffer) {
    if (!this.file) throw new Error('Replay writer is closed.');
    let offset = 0;
    while (offset < data.length) {
      const { bytesWritten } = await this.file.write(data, offset, data.length - offset);
      if (!bytesWritten) throw new Error('Replay writer made no progress.');
      offset += bytesWritten;
    }
  }
  private async fail(error: unknown) {
    if (this.failed) return;
    this.failed = true; this.accepting = false;
    const message = `Replay recording failed: ${error instanceof Error ? error.message : String(error)}`;
    this.warn(message);
    this.queue = []; this.queuedBytes = 0; this.queuedImages = 0;
    // Persist an independent error marker, including if the JSONL write ended mid-record.
    await this.status('error', message).catch(() => {});
    await this.file?.close().catch(() => {}); this.file = undefined;
  }

  recordFrame(state: GameState, force = false) {
    if (!this.accepting || (!force && state.simTime - this.lastFrame < this.options.header.sampleInterval - 1e-9)) return;
    this.lastFrame = state.simTime;
    const match = state.match && (({ events: _events, ...value }) => value)(state.match);
    this.enqueue({ type: 'frame', simTime: state.simTime, drones: state.drones, ...(match ? { match } : {}) });
  }
  recordCommand(drone: DroneId, name: string, args: Record<string, unknown>, simTime: number) {
    this.enqueue({ type: 'command', simTime, drone, name, args: redactDiagnostic(args) as Record<string, unknown> });
  }
  recordEvent(event: MatchEvent) { this.enqueue({ type: 'event', simTime: event.simTime, event }); }

  recordScriptSource(value: { drone: DroneId; path: string; version: string | number; source: string; simTime: number }): string {
    const sourceBytes = Buffer.byteLength(value.source, 'utf8');
    const sourceHash = createHash('sha256').update(value.source, 'utf8').digest('hex');
    this.enqueue({ type: 'script-source', drone: value.drone, path: value.path, version: value.version, simTime: value.simTime, sourceHash, sourceBytes,
      ...(sourceBytes <= REPLAY_SOURCE_BYTES ? { source: value.source } : { omission: `Source exceeds the ${REPLAY_SOURCE_BYTES}-byte replay source limit.` }) });
    return sourceHash;
  }
  recordExecution(value: Omit<ReplayExecution, 'type'>) {
    this.enqueue({ ...value, type: 'execution', args: redactDiagnostic(value.args) as Record<string, unknown>, outcome: redactDiagnostic(value.outcome) });
  }
  recordCancellation(value: Omit<ReplayCancellation, 'type'>) { this.enqueue({ ...value, type: 'cancellation' }); }
  recordRadio(message: RadioMessage, simTime: number) { this.enqueue({ type: 'radio', simTime, message: redactDiagnostic(message) as RadioMessage }); }

  recordObservation(value: RecordedObservation) {
    if (!this.accepting) return;
    const record: ReplayObservation = { type: 'observation', drone: value.drone, pose: value.pose, simTime: value.simTime, capturedAt: value.capturedAt, mission: value.mission, imageAvailable: false,
      ...(typeof value.cameraFov === 'number' && Number.isFinite(value.cameraFov) && value.cameraFov > 0 && value.cameraFov < 180 ? { cameraFov: value.cameraFov } : {}) };
    let image: Job['image'];
    const source = value.image;
    if (!source) record.omission = 'No camera image was delivered.';
    else if (!['image/jpeg', 'image/png'].includes(source.mimeType)) record.omission = 'Unsupported camera image format.';
    else if (source.data.length > Math.ceil(this.limits.imageSizeBytes / 3) * 4) record.omission = 'Camera image exceeds the per-image limit.';
    else if (this.queuedImages >= this.limits.queuedImages) record.omission = 'Camera image queue is full.';
    else {
      const data = Buffer.from(source.data, 'base64');
      const jpeg = source.mimeType === 'image/jpeg';
      const signature = jpeg ? data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff : data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      if (!signature || !/^[A-Za-z0-9+/]*={0,2}$/.test(source.data)) record.omission = 'Invalid camera image encoding.';
      else if (data.length > this.limits.imageSizeBytes || this.imageBytes + data.length > this.limits.imageBytes) record.omission = 'Camera image storage limit reached.';
      else {
        const id = `${randomUUID()}.${jpeg ? 'jpg' : 'png'}`;
        image = { id, data }; record.imageId = id; record.imageAvailable = true;
      }
    }
    if (!image) {
      this.omittedImages++;
      if (source) { this.limited = true; if (this.omittedImages === 1) this.warn(`Replay camera omitted: ${record.omission}`); }
    }
    this.enqueue(record, image);
  }

  private enqueue(record: Exclude<ReplayRecord, ReplayHeader | ReplayEnd>, image?: Job['image']) {
    if (!this.accepting) return;
    this.lastTime = Math.max(this.lastTime, record.simTime);
    let line: Buffer;
    try { line = Buffer.from(JSON.stringify(record) + '\n'); }
    catch (error) { this.accepting = false; void this.stop(this.lastTime, 'error'); this.warn(`Replay record serialization failed: ${String(error)}`); return; }
    const size = line.length + (image?.data.length ?? 0);
    if (line.length > MAX_RECORD || this.dataBytes + line.length + END_RESERVE > this.limits.dataBytes || this.queuedBytes + size > this.limits.queueBytes || this.queue.length >= this.limits.queueRecords) {
      this.limited = true; this.warn('Replay recording limit reached; the recorded prefix remains available.');
      void this.stop(this.lastTime, 'limit'); return;
    }
    this.dataBytes += line.length; this.queuedBytes += size;
    if (image) { this.queuedImages++; this.imageBytes += image.data.length; }
    this.queue.push({ line, image });
    this.pump();
  }

  private pump() {
    if (this.pumping || this.failed) return;
    this.pumping = this.drain().finally(() => { this.pumping = undefined; if (this.queue.length && !this.failed) this.pump(); });
  }
  private async drain() {
    try {
      while (this.queue.length) {
        const job = this.queue[0];
        if (job.image) {
          const path = resolve(this.directory!, job.image.id);
          try { await writeFile(path, job.image.data, { flag: 'wx' }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') await unlink(path).catch(() => {}); throw error; }
        }
        await this.write(job.line);
        this.queue.shift(); this.queuedBytes -= job.line.length + (job.image?.data.length ?? 0);
        if (job.image) this.queuedImages--;
      }
    } catch (error) { await this.fail(error); }
  }

  stop(simTime: number, reason: ReplayEnd['reason'] = 'stopped'): Promise<void> {
    if (this.stopping) return this.stopping;
    this.accepting = false;
    this.pendingEnd = { type: 'end', simTime, reason: this.limited && reason === 'stopped' ? 'limit' : reason, omittedImages: this.omittedImages };
    if (this.pendingEnd.reason === 'limit') this.pendingEnd.message = 'Recording is incomplete: storage or queue limits omitted evidence.';
    if (reason === 'error') this.pendingEnd.message = 'Recording stopped because an evidence record could not be written.';
    this.stopping = (async () => {
      while (this.pumping) await this.pumping;
      if (!this.file || this.failed) return;
      try {
        await this.write(Buffer.from(JSON.stringify(this.pendingEnd) + '\n'));
        await this.file.close(); this.file = undefined;
        await this.status(this.pendingEnd!.reason, this.pendingEnd!.message);
      } catch (error) { await this.fail(error); }
    })();
    return this.stopping;
  }
}
