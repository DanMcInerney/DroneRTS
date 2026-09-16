import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { OnboardWorkspace, type WorkspaceSnapshot } from './onboard-workspace.ts';
import { deployOnboardRuntime } from './onboard-manifest.ts';

export const ROUTINE_LIMITS = Object.freeze({ heapBytes: 32 * 1024 * 1024, sliceMs: 20, cpuMsPerSecond: 250, operationsPerSecond: 64, pendingCalls: 8, requestBytes: 72 * 1024, responseBytes: 256 * 1024, hostDeadlineMs: 2000, wallTimeMs: 120_000, startupDeadlineMs: 5000, heartbeatDeadlineMs: 750 });
export type RoutineLimits = { [Key in keyof typeof ROUTINE_LIMITS]: number };
export interface RoutineStatus { id: string; kind: 'routine'; state: 'accepted' | 'running' | 'completed' | 'cancelled' | 'failed'; mission: number; path: string; sourceHash: string; version: number; startedAt: number; updatedAt: number; error?: string; reason?: string; cleanupPending?: boolean }
export interface RoutineCallContext { signal: AbortSignal; mission: number; jobId: string; origin?: unknown }
export interface RoutineTrace { jobId: string; sourceHash: string; operation: string; args: unknown; outcome?: unknown; error?: string }
export interface RoutineHost {
  /** Must enforce alive/mission/capability/one movement writer on admission and after awaited adapters. */
  validate(mission: number, jobId: string): void;
  call(method: string, args: unknown, context: RoutineCallContext): Promise<unknown>;
  onState?(status: RoutineStatus): void;
  onSource?(source: { path: string; version: number; hash: string; source: string }): void;
  onTrace?(trace: RoutineTrace): void;
}
export interface RoutineStart { path: string; mission: number; input?: object; replace?: boolean; origin?: unknown }
interface ActiveRoutine { worker: Worker; status: RoutineStatus; snapshot: WorkspaceSnapshot; argumentJson: string; controller: AbortController; calls: Map<number, AbortController>; recentCalls: number[]; heartbeatAt: number; origin?: unknown; timer: ReturnType<typeof setInterval> }
const HOST_METHODS = new Set(['telemetry', 'camera', 'act', 'send', 'buy', 'fire', 'rearm', 'cameraMode', 'events']);
const ALL_METHODS = new Set([...HOST_METHODS, 'sleep', 'files.list', 'files.read', 'files.write', 'files.delete', 'files.stat', 'files.status']);
function boundedJson(value: unknown, limit: number): string { const json = JSON.stringify(value ?? null); if (Buffer.byteLength(json) > limit) throw new Error('host_payload_too_large'); return json; }
function safeError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1024); }
/** One QuickJS worker per drone. Host work has independent queue, byte, rate and deadline limits. */
export class RoutineRunner {
  private active?: ActiveRoutine;
  private last?: RoutineStatus;
  private retiring = new Set<Promise<number>>();
  readonly limits: RoutineLimits;
  constructor(readonly workspace: OnboardWorkspace, private host: RoutineHost, limits: Partial<RoutineLimits> = {}) {
    this.limits = { ...ROUTINE_LIMITS, ...limits };
    for (const key of Object.keys(ROUTINE_LIMITS) as Array<keyof typeof ROUTINE_LIMITS>) if (!Number.isFinite(this.limits[key]) || this.limits[key] <= 0 || this.limits[key] > ROUTINE_LIMITS[key]) throw new Error(`Invalid or enlarged routine limit: ${key}`);
  }
  preflight(input: RoutineStart): void {
    if (typeof process.threadCpuUsage !== 'function') throw new Error('Routines require Node 22.19+ or 24+ with thread CPU accounting.');
    process.threadCpuUsage();
    if (!Number.isSafeInteger(input.mission) || input.mission < 0) throw new Error('invalid_mission');
    if (this.active && !input.replace) throw new Error('routine_busy: cancel or explicitly replace the active routine');
    if (this.retiring.size) throw new Error('routine_cleanup_pending: previous worker is terminating; retry after cleanup');
    this.host.validate(input.mission, this.active?.status.id ?? 'routine-admission');
    this.workspace.stat(input.path);
    if (!/\.m?js$/i.test(input.path)) throw new Error('Routine entry must be a .js or .mjs file.');
    if (input.input !== undefined && (!input.input || typeof input.input !== 'object' || Array.isArray(input.input))) throw new Error('Routine input must be an object.');
    boundedJson(input.input ?? {}, 16 * 1024);
    deployOnboardRuntime();
  }
  start(input: RoutineStart): RoutineStatus {
    this.preflight(input);
    const id = randomUUID();
    this.host.validate(input.mission, id);
    const argumentJson = boundedJson(input.input ?? {}, 16 * 1024);
    const snapshot = this.workspace.pin(input.path);
    if (this.active) this.cancel('explicit_replacement');
    const now = performance.now();
    const status: RoutineStatus = { id, kind: 'routine', state: 'accepted', mission: input.mission, path: input.path, sourceHash: snapshot.entry.sha256, version: snapshot.entry.version, startedAt: now, updatedAt: now };
    let worker: Worker;
    try {
      worker = new Worker(deployOnboardRuntime(), { workerData: { path: input.path, files: snapshot.files, argumentJson, limits: this.limits }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 } });
    } catch (error) { snapshot.release(); throw error; }
    const active: ActiveRoutine = { worker, status, snapshot, argumentJson, controller: new AbortController(), calls: new Map(), recentCalls: [], heartbeatAt: now, origin: input.origin, timer: setInterval(() => this.watchdog(id), 100) };
    this.active = active; this.last = status;
    worker.on('message', message => this.receive(active, message));
    worker.on('error', error => this.finish(active, 'failed', safeError(error)));
    worker.on('exit', code => { if (this.active === active) this.finish(active, 'failed', `worker_exit:${code}`); });
    for (const [path, source] of Object.entries(snapshot.files)) this.host.onSource?.({ path, version: source.version, hash: source.sha256, source: source.source });
    this.emit(status);
    return { ...status };
  }
  status(): RoutineStatus | null { return this.last ? { ...this.last, cleanupPending: this.retiring.size > 0 } : null; }
  arguments(id: string) {
    const active = this.active;
    return active?.status.id === id ? { path: active.status.path, input: JSON.parse(active.argumentJson),
      sourceHash: active.status.sourceHash, version: active.status.version } : undefined;
  }
  cancel(reason = 'cancelled', jobId?: string): RoutineStatus | null {
    if (jobId && this.last?.id !== jobId) throw new Error('routine_job_mismatch');
    if (this.active) this.finish(this.active, 'cancelled', reason);
    return this.status();
  }
  private watchdog(id: string): void {
    const active = this.active; if (!active || active.status.id !== id) return;
    const now = performance.now();
    try { this.host.validate(active.status.mission, id); } catch (error) { this.finish(active, 'cancelled', safeError(error)); return; }
    if (now - active.status.startedAt > this.limits.wallTimeMs) this.finish(active, 'failed', 'routine_wall_deadline');
    else if (now - active.heartbeatAt > (active.status.state === 'accepted' ? this.limits.startupDeadlineMs : this.limits.heartbeatDeadlineMs)) this.finish(active, 'failed', 'worker_unresponsive');
  }
  private receive(active: ActiveRoutine, message: unknown): void {
    if (this.active !== active || !message || typeof message !== 'object') return;
    const value = message as Record<string, unknown>;
    if (value.type === 'ready') { active.status = { ...active.status, state: 'running', updatedAt: performance.now() }; active.heartbeatAt = performance.now(); this.last = active.status; this.emit(active.status); }
    else if (value.type === 'heartbeat') active.heartbeatAt = performance.now();
    else if (value.type === 'done') this.finish(active, 'completed');
    else if (value.type === 'failed') this.finish(active, 'failed', safeError(value.error));
    else if (value.type === 'call') void this.call(active, value);
  }
  private async call(active: ActiveRoutine, value: Record<string, unknown>): Promise<void> {
    const id = value.id as number, method = value.method as string;
    let args: unknown;
    let controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!Number.isSafeInteger(id) || id < 1 || active.calls.has(id) || typeof method !== 'string' || !ALL_METHODS.has(method) || typeof value.json !== 'string' || Buffer.byteLength(value.json) > this.limits.requestBytes) throw new Error('invalid_sdk_call');
      const now = performance.now(); active.recentCalls = active.recentCalls.filter(at => now - at < 1000);
      if (active.recentCalls.length >= this.limits.operationsPerSecond) throw new Error('sdk_rate_exceeded');
      if (active.calls.size >= this.limits.pendingCalls) throw new Error('sdk_pending_limit');
      active.recentCalls.push(now); args = JSON.parse(value.json);
      try { this.host.validate(active.status.mission, active.status.id); } catch (error) { this.finish(active, 'cancelled', safeError(error)); return; }
      controller = new AbortController(); active.calls.set(id, controller);
      const context: RoutineCallContext = { signal: controller.signal, mission: active.status.mission, jobId: active.status.id, origin: active.origin };
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('host_call_deadline')); controller!.abort(); }, this.limits.hostDeadlineMs); });
      const cancelled = new Promise<never>((_, reject) => { controller!.signal.addEventListener('abort', () => reject(new Error('host_call_cancelled')), { once: true }); });
      const outcome = await Promise.race([this.dispatch(method, args, context), deadline, cancelled]);
      if (this.active !== active || controller.signal.aborted) return;
      try { this.host.validate(active.status.mission, active.status.id); } catch (error) { this.finish(active, 'cancelled', safeError(error)); return; }
      const json = boundedJson(outcome, this.limits.responseBytes);
      active.worker.postMessage({ type: 'result', id, json });
      this.trace(active, { operation: method, args, outcome });
    } catch (error) {
      const reason = safeError(error);
      if (this.active === active) { active.worker.postMessage({ type: 'result', id, error: reason }); this.trace(active, { operation: method, args, error: reason }); }
      if (['sdk_rate_exceeded', 'sdk_pending_limit', 'host_call_deadline', 'host_call_cancelled', 'invalid_sdk_call'].includes(reason)) this.finish(active, 'failed', reason);
    } finally { if (timer) clearTimeout(timer); if (controller) { controller.abort(); active.calls.delete(id); } }
  }
  private async dispatch(method: string, value: unknown, context: RoutineCallContext): Promise<unknown> {
    const args = value as Record<string, unknown>;
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid_sdk_arguments');
    if (method === 'sleep') {
      const ms = args.ms; if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 1 || ms > 1000) throw new Error('sleep must be 1–1000 milliseconds');
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); context.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('host_call_cancelled')); }, { once: true }); });
      return null;
    }
    if (method === 'files.list') return this.workspace.list();
    if (method === 'files.status') return this.workspace.status();
    if (method === 'files.read') return this.workspace.read(args.path as string);
    if (method === 'files.stat') return this.workspace.stat(args.path as string);
    if (method === 'files.write') return this.workspace.write(args.path as string, args.content as string);
    if (method === 'files.delete') return this.workspace.delete(args.path as string);
    return this.host.call(method, args, context);
  }
  private trace(active: ActiveRoutine, entry: Omit<RoutineTrace, 'jobId' | 'sourceHash'>): void {
    const trace = { ...entry, jobId: active.status.id, sourceHash: active.status.sourceHash };
    // Logs rotate independently; replay hooks are host-only and must impose their own bounded retention.
    this.workspace.appendLog({ ...trace, args: boundedSummary(trace.args), outcome: boundedSummary(trace.outcome) });
    this.host.onTrace?.(trace);
  }
  private emit(status: RoutineStatus): void { this.workspace.appendLog({ routine: status }); this.host.onState?.({ ...status }); }
  private finish(active: ActiveRoutine, state: 'completed' | 'cancelled' | 'failed', reason?: string): void {
    if (this.active !== active) return;
    this.active = undefined;
    clearInterval(active.timer); active.controller.abort(); for (const controller of active.calls.values()) controller.abort(); active.calls.clear();
    const termination = active.worker.terminate(); this.retiring.add(termination);
    void termination.finally(() => { this.retiring.delete(termination); active.snapshot.release(); });
    this.last = { ...active.status, state, updatedAt: performance.now(), ...(reason ? state === 'failed' ? { error: reason } : { reason } : {}) };
    this.emit(this.last);
  }
}
function boundedSummary(value: unknown): unknown { const json = JSON.stringify(value ?? null); return Buffer.byteLength(json) <= 2048 ? value : { omittedBytes: Buffer.byteLength(json) }; }
