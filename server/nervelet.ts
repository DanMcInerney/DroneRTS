import { Bridge, ChangeSignal, waitSchema } from 'nervelet';
import type { AttentionOptions, Bundle, Command, CommandIdentity, CommandContext, Environment, Goal, ImageAttachment, Job, Json, Profile, Receipt, Snapshot } from 'nervelet';
import { createHash } from 'node:crypto';
import { withAbort } from './abort.ts';
import { ACOUSTIC_BRIEFING } from '../shared/mission.ts';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { DroneId, GameEvent, ToolResult } from '../shared/types.ts';
import { teamForDrone, teamRoster } from '../shared/fleet.ts';
import { createDroneTools, droneInstructions, NERVELET_RULE } from './runtime-tools.ts';
import { compactObservationValue, resultSubmission, verifyFleetResult, type SubmittedResult } from './observation-format.ts';
import type { FleetGame } from './game.ts';

const text = (value: unknown, isError = false): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError } : {}) });
const body = (result: ToolResult): any => JSON.parse(result.content.find(item => item.type === 'text')!.text);
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value));
export const NERVELET_CACHE_RESERVE = 384 * 1024;
const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = (command: Command) => createHash('sha256').update(canonical(command)).digest('hex');

/** One borrowed environment per authenticated pilot. No second sensor store or controller. */
export class DroneNervelet implements Environment {
  readonly changes = new ChangeSignal();
  readonly profile: Profile;
  readonly bridge: Bridge;
  private readonly session: string;
  private ready: Promise<void>;
  private goalTask: Promise<unknown> = Promise.resolve();
  private captured?: any;
  private commit?: (events: GameEvent[]) => void;
  private effect?: { result: any; isError: boolean };
  private jobCommands = new Map<string, string>();
  private executions = new Map<string, { kind: string; digest: string; pending: Promise<Receipt>; unresolved: boolean }>();
  private active?: { controller: AbortController; done: Promise<ToolResult>; watchTelemetry: boolean };
  private closed = false;
  private readonly onChange = () => {
    if (!this.alive()) this.active?.controller.abort(new Error('Drone session ended'));
    this.changes.notify();
  };
  private readonly onMail = (event: { drone: DroneId }) => { if (event.drone === this.id) this.onChange(); };
  // Ordinary waits wake on actual events. Only numeric conditions need tick updates.
  private readonly onTick = () => { if (this.active?.watchTelemetry) this.onChange(); };
  private readonly onGoal = (event: { drone: DroneId; goal: Goal }) => {
    if (event.drone !== this.id || this.closed) return;
    // Serialize actual native receipts, never the operator's queued intent.
    this.goalTask = this.goalTask.then(() => this.bridge.receiveGoal(event.goal));
    void this.goalTask.catch(error => this.game.emit('transport-error', { role: this.id, message: `Nervelet goal: ${error}` }));
  };

  constructor(private readonly game: FleetGame, readonly id: DroneId, private readonly options: { attention?: AttentionOptions; submission?: 'host' } = {}) {
    this.session = game.sessionIdentity;
    const tools = createDroneTools(teamRoster(teamForDrone(id)), { alive: true, onboard: true, shop: true, gun: true, optics: game.toolCapabilities(id).optics }, teamForDrone(id));
    this.profile = { id: `drone-${id}`, version: 'dronerts-nervelet/2', camera: { policy: 'capture_on_step' },
      instructions: droneInstructions(id, teamRoster(teamForDrone(id)), teamForDrone(id)) + (game.acousticEnabled ? `\n\n${ACOUSTIC_BRIEFING}` : ''),
      commands: Object.fromEntries(tools.filter(tool => !['observe', 'wait'].includes(tool.name)).map(tool => [tool.name, { description: tool.description!, schema: tool.inputSchema }])),
      waitFields: { cargo: { source: 'state', path: ['currentTelemetry', 'cargo', 'amount'], maxAgeMs: 150 },
        altitude: { source: 'state', path: ['currentTelemetry', 'position', 'y'], maxAgeMs: 150 } } };
    this.bridge = new Bridge(this, undefined, { environmentOwnership: 'borrowed', retainCommandArguments: false, submission: 'host', attention: options.attention,
      instructions: { transport: 'tools', waitMode: 'hold', commandSchemas: 'transport', stop: false, refreshTools: tools.map(tool => tool.name) },
      goalProvider: { get: () => game.receivedGoal(id) },
      limits: { maxGoalBytes: 24 * 1024, maxProfileBytes: 48 * 1024, maxRecoveryBytes: 640 * 1024, maxBundleBytes: 512 * 1024,
        maxRequestBytes: 512 * 1024, maxCommandBytes: 400 * 1024, receiptHistory: 64, bundleHistory: 32,
        maxImages: 1, maxMediaBytes: 512 * 1024, maxJobs: 2, operationMs: 5000 },
      trace: trace => {
        if (trace.type === 'admission' && trace.id) { const execution = this.executions.get(trace.id); if (execution) execution.unresolved = trace.reason === 'unknown'; }
        game.emit('nervelet-trace', { drone: id, ...trace });
      } });
    game.on('change', this.onChange); game.on('onboard-tick', this.onTick); game.on('onboard-change', this.onMail); game.on('received-goal', this.onGoal);
    game.onboardWorkspace(id).reserveCache('nervelet', NERVELET_CACHE_RESERVE);
    this.ready = this.bridge.start();
  }
  private alive() { return !this.closed && this.game.sessionIdentity === this.session && this.game.toolCapabilities(this.id).alive; }
  private assertAlive() { if (!this.alive()) throw new Error('Drone session ended'); }
  refresh(reason: string) { if (!this.closed) this.bridge.refresh(reason); }
  tools(): Tool[] {
    if (!this.alive()) return [];
    const available = createDroneTools(teamRoster(teamForDrone(this.id)), this.game.toolCapabilities(this.id), teamForDrone(this.id));
    return available.map(tool => {
      const passive = ['observe', 'wait'].includes(tool.name);
      const properties = { ...tool.inputSchema.properties };
      if (tool.name === 'wait') { delete properties.after; properties.until = waitSchema.properties.until; }
      const description = tool.name === 'wait'
        ? 'Wait for unread mail/events, or optional until conditions: event type, terminal job, numeric cargo amount or altitude threshold/change. timeout_ms bounds the wait to 30 seconds. Returns fresh camera/telemetry and an unread slice; hasMore preserves the rest. Local work continues.'
        : tool.description;
      return { ...tool, description: `${description} Echo nervelet.id as seen.${passive ? '' : ' Use nervelet.nextCommandId as command_id, nervelet.generation as generation; mission is still required.'}`,
        inputSchema: { ...tool.inputSchema, properties: { ...properties, seen: { type: 'string', maxLength: 128 },
          ...(!passive ? { command_id: { type: 'string', pattern: '^c[1-9][0-9]*$' }, generation: { type: 'integer', minimum: 1 } } : {}) },
          ...(!passive && this.options.attention ? { required: [...(tool.inputSchema.required ?? []), 'generation'] } : {}) } };
    });
  }
  async start() {} // Borrowed game owns acquisition, radio, and physics scheduling.
  async close() {
    if (this.closed) return;
    this.closed = true; this.active?.controller.abort(new Error('Drone session ended'));
    this.game.off('change', this.onChange); this.game.off('onboard-tick', this.onTick); this.game.off('onboard-change', this.onMail); this.game.off('received-goal', this.onGoal);
    await this.ready; await this.goalTask.catch(() => {}); await this.bridge.close();
    this.captured = undefined; this.commit = undefined; this.effect = undefined;
    this.game.existingOnboardWorkspace(this.id)?.releaseCache('nervelet');
  }
  async stop() { if (this.game.sessionIdentity === this.session) this.game.stopOnboard(this.id); this.changes.notify(); return { status: 'confirmed' as const }; }
  async cancel(id: string) { return this.game.cancelOnboard(this.id, id) ? { status: 'confirmed' as const } : { status: 'unknown' as const, reason: 'Job is not owned or retained' }; }
  acknowledge(through: number) { this.assertAlive(); this.game.acknowledgeOnboard(this.id, through); }
  wait(signal: AbortSignal) { return this.changes.wait(this.changes.sequence, signal); }
  async snapshot(after: number, signal: AbortSignal): Promise<Snapshot> {
    signal.throwIfAborted();
    const telemetry = this.game.onboardTelemetry(this.id);
    if (!this.game.toolCapabilities(this.id).shop) delete (telemetry as any).account;
    const state = { ...this.effect?.result, ...(this.captured ?? {}), currentTelemetry: telemetry, routine: this.game.onboardRoutine(this.id) };
    delete state.events; delete state.hasMore;
    const slice = this.game.onboardEvents(this.id, after);
    const jobs: Job[] = [telemetry.job, state.routine].filter(Boolean).map(job => ({ id: job.id,
      status: job.state === 'accepted' ? 'pending' : job.state, commandId: this.jobCommands.get(job.id) ?? 'environment-owned', kind: job.kind ?? 'routine',
      args: this.game.onboardJobArguments(this.id, job.id), startedMs: job.startedAt ?? 0, updatedMs: job.updatedAt ?? 0, ...(job.reason ? { reason: job.reason } : {}) }));
    return { state: { value: json(state), receivedMs: telemetry.acquiredAtMs, acquired: { clock: 'host-monotonic', ms: telemetry.acquiredAtMs }, valid: telemetry.validity === 'valid', maxAgeMs: 150 },
      jobs, events: slice.events.map(event => ({ seq: event.cursor, kind: event.type, atMs: this.game.inboxes[this.id].receivedAt(event.cursor), data: json(event) })), hasMore: slice.hasMore };
  }
  async capture(signal: AbortSignal): Promise<ImageAttachment[]> {
    this.captured = undefined; this.commit = undefined;
    const result = await this.game.acquireOnboard(this.id, signal, commit => { this.commit = commit; });
    signal.throwIfAborted(); this.assertAlive();
    this.captured = body(result);
    const camera = this.captured.sensors.camera;
    return result.content.flatMap(item => item.type === 'image' ? [{ ...item, mimeType: item.mimeType as 'image/png' | 'image/jpeg',
      // A delayed capture still contains real pixels from its recorded scene.
      // Age is evidence for the pilot, not a reason to invalidate or recapture it.
      id: `${this.session}:${this.id}:${camera.sequence}`, receivedMs: performance.now(), acquired: { clock: 'host-monotonic', ms: camera.acquiredAtMs },
      valid: camera.available && this.captured.sensors.validity === 'valid', reused: false }] : []);
  }
  execute(command: Command, context: CommandContext): Promise<Receipt> {
    if (this.executions.size >= 64) {
      const evict = [...this.executions].find(([, execution]) => !execution.unresolved);
      if (!evict) return Promise.resolve({ id: command.id, status: 'not_executed', reason: 'Original execution records are full; reconcile unresolved results.' });
      this.executions.delete(evict[0]);
    }
    const pending = this.executeOnce(command, context);
    this.executions.set(command.id, { kind: command.kind, digest: digest(command), pending, unresolved: true });
    return pending;
  }
  async reconcileReceipt(identity: CommandIdentity, signal: AbortSignal): Promise<Receipt> {
    signal.throwIfAborted();
    const record = this.executions.get(identity.id);
    if (!record || record.kind !== identity.kind || record.digest !== identity.digest)
      return { id: identity.id, status: 'unknown', reason: 'Authoritative execution identity is not retained or does not match' };
    const receipt = await withAbort(record.pending, signal);
    record.unresolved = receipt.status === 'unknown';
    return receipt;
  }
  private async executeOnce(command: Command, context: CommandContext): Promise<Receipt> {
    const check = () => { context.assertCurrent?.(); this.assertAlive(); };
    check();
    const result = await this.game.executeOnboard(this.id, command.kind, command.args, check);
    const value = body(result);
    const jobId = value.job?.id ?? value.routine?.id;
    if (jobId && value.accepted) {
      this.jobCommands.set(jobId, command.id);
      while (this.jobCommands.size > 2) this.jobCommands.delete(this.jobCommands.keys().next().value!);
    }
    if (!context.signal.aborted) this.effect = { result: value, isError: Boolean(result.isError) };
    const failed = result.isError || value.rejected || value.launchPending || value.stopped;
    return { id: command.id, status: failed ? 'rejected' : value.accepted || value.queued ? 'accepted' : 'completed',
      ...(value.job?.id || value.routine?.id ? { jobId: value.job?.id ?? value.routine.id } : {}),
      ...(failed ? { reason: String(value.reason ?? value.error ?? value.instruction ?? 'not admitted').slice(0, 256) } : {}) };
  }
  call(name: string, args: Record<string, any> = {}, signal?: AbortSignal): Promise<ToolResult> {
    const control = name === 'act' && args.kind === 'hover' || ['route', 'routine'].includes(name) && args.op === 'cancel';
    if (control) return this.controlCall(name, args).then(result => this.finalize(result, signal));
    if (this.active) return Promise.resolve(text({ rejected: true, reason: 'Nervelet busy: use one ordinary call at a time; batch compatible commands with exchange.' }, true));
    const controller = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const done = this.ordinary(name, args, requestSignal).then(result => this.finalize(result, requestSignal)).finally(() => { if (this.active?.controller === controller) this.active = undefined; });
    this.active = { controller, done, watchTelemetry: name === 'wait' && Array.isArray(args.until) && args.until.some(c => c?.kind === 'threshold' || c?.kind === 'change') }; return done;
  }
  abortTools(reason: unknown = new Error('Native turn cancelled')) { this.active?.controller.abort(reason); }
  private finalize(result: ToolResult, signal?: AbortSignal) {
    try {
      // Cancellation results remain paired errors, but abandoned observations cannot submit.
      if ((result as SubmittedResult)[resultSubmission]) signal?.throwIfAborted();
      verifyFleetResult(result);
      if (this.options.submission !== 'host') (result as SubmittedResult)[resultSubmission]?.submitted();
      return result;
    } catch (error) {
      (result as SubmittedResult)[resultSubmission]?.failed(error);
      return text({ rejected: true, cancelled: signal?.aborted ?? false, reason: String(error), instruction: 'Observe for recovery; do not replay uncertain effects.' }, true);
    }
  }
  private async controlCall(name: string, args: Record<string, any>): Promise<ToolResult> {
    if (!this.alive() || args.mission !== this.game.receivedMission(this.id)) return text({ rejected: true, reason: 'Stopped or stale mission' }, true);
    this.active?.controller.abort(new Error('Cancelled by responsive control'));
    const result = await this.game.executeOnboard(this.id, name, args, () => this.assertAlive());
    await this.active?.done;
    // A new observation still has to be acknowledged; cancellation never auto-acks mail.
    const observation = await this.call('observe', { seen: args.seen });
    return { ...observation, content: [...observation.content, { type: 'text', text: JSON.stringify({ control: body(result) }) }] };
  }
  private async ordinary(name: string, args: Record<string, any>, signal: AbortSignal): Promise<ToolResult> {
    try {
      await this.ready; await this.goalTask; this.assertAlive(); signal.throwIfAborted();
      // Resolve only retained original executions. Never repeat a mutation.
      if (this.bridge.stats().unresolved && this.bridge.attention()?.status !== 'pending') {
        for (const id of this.executions.keys()) {
          try { await this.bridge.reconcile(id); } catch { /* Only unresolved retained receipts are reconcilable. */ }
        }
      }
      this.game.markActorOnline(this.id); this.captured = undefined; this.commit = undefined; this.effect = undefined;
      let request: any;
      if (name === 'observe' || name === 'wait') request = { schemaVersion: 2, seen: args.seen,
        ...(name === 'wait' ? args.until === undefined ? { waitMs: args.timeout_ms ?? 30000 }
          : { wait: { until: args.until, reviewMs: args.timeout_ms ?? 30000 } } : {}) };
      else {
        if (!args.command_id) return text({ rejected: true, reason: 'command_id required. Use nervelet.nextCommandId from observe; echo nervelet.id as seen.' }, true);
        const { seen, command_id, generation, ...commandArgs } = args;
        request = { schemaVersion: 2, seen, generation, goalVersion: args.mission, commands: [{ id: command_id, kind: name, args: commandArgs }] };
      }
      let bundle = await this.bridge.step(request, signal, { maxHoldMs: 30000, textEncoding: 'tool-result', wrapperBytes: 4096 });
      signal.throwIfAborted(); this.assertAlive();
      // Attention may cancel the camera already in flight. Reacquire once at the
      // same host boundary, without acknowledging evidence or replaying effects.
      const acquiredCamera = (value: Bundle) => Boolean(value.attachments?.some(image => image.valid && !image.reused)
        && (value.state?.value as any)?.sensors?.camera?.available);
      if (bundle.attention && !acquiredCamera(bundle)) {
        bundle = await this.bridge.step({ schemaVersion: 2 }, signal, { textEncoding: 'tool-result', wrapperBytes: 4096 });
        if (!acquiredCamera(bundle)) {
          const error = new Error('Emergency recovery could not acquire camera content');
          this.bridge.failSubmission(bundle.id, error); throw error;
        }
      }
      if (bundle.fault && this.bridge.attention()?.status !== 'pending') {
        for (const receipt of bundle.results ?? []) if (receipt.status === 'unknown') await this.bridge.reconcile(receipt.id);
        if (this.bridge.status().fault) {
          this.game.stop(); this.game.emit('transport-error', { role: this.id, message: `Nervelet: ${bundle.fault}` });
          return text({ stopped: true, fault: bundle.fault, nervelet: { id: bundle.id, results: bundle.results }, instruction: 'Match stopped after unresolved admission; do not replay commands.' }, true);
        }
        // Recovery after reconciliation requires another delivered observation.
        return this.output(await this.bridge.step({ schemaVersion: 2 }, signal, { textEncoding: 'tool-result', wrapperBytes: 4096 }));
      }
      return this.output(bundle);
    } catch (error) {
      return text({ stopped: !this.alive(), cancelled: signal.aborted, rejected: true, reason: String(error), instruction: 'Observe again for fresh evidence; do not replay uncertain commands.' }, true);
    } finally { this.captured = undefined; this.commit = undefined; this.effect = undefined; }
  }
  private output(bundle: Bundle): ToolResult {
    const { state, attachments, events, ...metadata } = bundle;
    const included = (events ?? []).map(event => ({ ...(event.data as unknown as GameEvent), nerveletEventId: event.id, receivedAtMs: event.atMs, redelivered: event.redelivered }));
    const commit = this.commit;
    const observation: any = state?.value ?? {};
    const deliveredAtMs = performance.now();
    observation.deliveredAtMs = deliveredAtMs; observation.deliveredAt = new Date().toISOString();
    if (observation.sensors) {
      observation.sensors.ageMs = deliveredAtMs - observation.sensors.timestamp.acquiredAtMs;
      observation.sensors.camera.ageMs = deliveredAtMs - observation.sensors.camera.acquiredAtMs;
      observation.sensors.camera.fresh &&= observation.sensors.camera.ageMs <= 2000;
    }
    observation.currentTelemetry.ageMs = deliveredAtMs - observation.currentTelemetry.acquiredAtMs;
    for (const ranges of [observation.sensors?.ranges, observation.currentTelemetry.ranges]) if (ranges) {
      ranges.ageMs = deliveredAtMs - ranges.acquiredAtMs; ranges.fresh &&= ranges.ageMs <= 150;
    }
    // Failed capture never reuses an earlier picture or says its camera is available.
    if (!attachments?.length) {
      if (observation.sensors?.camera) observation.sensors.camera = { ...observation.sensors.camera, available: false, fresh: false };
      else observation.camera = { available: false, reason: bundle.media?.reason ?? 'No camera image acquired' };
    }
    const final = { ...observation, events: included, hasMore: Boolean(bundle.hasMore),
      cursor: included.at(-1)?.cursor ?? this.game.inboxes[this.id].delivered,
      launchReady: this.game.launchReady, nervelet: { ...metadata, aliases: NERVELET_RULE },
      availableTools: this.tools().map(tool => tool.name),
    };
    const result: SubmittedResult = text(compactObservationValue(final), this.effect?.isError);
    for (const image of attachments ?? []) result.content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
    let settled = false;
    result[resultSubmission] = {
      submitted: () => { if (settled) return; settled = true; if (this.alive()) { this.game.deliveredOnboard(this.id, included); commit?.(included); this.bridge.confirmSubmission(bundle.id); } },
      failed: error => { if (settled) return; settled = true; this.bridge.failSubmission(bundle.id, error); },
    };
    return result;
  }
}
