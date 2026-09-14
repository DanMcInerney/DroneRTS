import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { FleetMcpServer } from './runtime-mcp.ts';
import { AppServerRpc } from './runtime-rpc.js';
import { BOOTSTRAP_MESSAGE, EFFORT, MODEL, droneInstructions, createDroneTools, createParentInstructions, relayTool, type FleetRole } from './runtime-tools.js';
import type { ToolResult } from '../shared/types.js';
import { DEFAULT_FLEET, validateRoster, droneAgentType, droneIdFromAgentType, type FleetRoster } from '../shared/fleet.ts';

export type RuntimeOptions = {
  projectDir: string;
  roster?: FleetRoster;
  team?: 'blue' | 'red';
  toolsForRole?: (role: FleetRole) => Tool[];
  toolHandler: (role: FleetRole, name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  onStatus: (status: any) => void;
  onEvent: (event: any) => void;
};
const quoted = (value: string) => JSON.stringify(value);


export class CodexFleetRuntime {
  private rpc?: AppServerRpc;
  private mcp?: FleetMcpServer;
  private runDir?: string;
  private stopped = true;
  private threadId?: string;
  private roles = new Map<string, FleetRole>();
  private spawned = new Set<string>();
  private usage = new Map<string, number>();
  private activeTurns = new Map<string, string>();
  private retired = new Set<FleetRole>();
  private resumptions = new Map<FleetRole, number>();
  private turnCatalogs = new Map<FleetRole, string>();
  private servedCatalogs = new Map<FleetRole, string>();
  private catalogYields = new Map<FleetRole, number>();
  private catalogWaiters = new Set<() => void>();
  private resuming = new Set<string>();
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private cleanupPromise?: Promise<void>;
  private failure?: string;
  private startupError?: string;
  private denied = 0;
  private toolCalls = 0;
  private readonly roster: FleetRoster;
  private readonly drones;
  private readonly droneTools;
  private readonly parentInstructions: string;
  constructor(private options: RuntimeOptions) {
    this.roster = validateRoster(options.roster ?? DEFAULT_FLEET);
    this.drones = this.roster.map(member => member.id);
    this.droneTools = createDroneTools(this.roster);
    this.parentInstructions = createParentInstructions(this.roster);
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (!this.stopped) return;
    this.startPromise = this.startInternal().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }
  private async startInternal() {
    this.stopped = false;
    this.options.onStatus({ status: 'starting', message: 'Checking Codex and Luna / xhigh…', model: MODEL, effort: EFFORT });
    try {
      this.runDir = await mkdtemp(join(tmpdir(), 'drone-fleet-'));
      const runHome = join(this.runDir, 'codex-home');
      const workDir = join(this.runDir, 'world');
      await mkdir(runHome); await mkdir(workDir); await mkdir(join(runHome, 'agents'));
      const originalHome = process.env.CODEX_HOME || join(homedir(), '.codex');
      const auth = join(originalHome, 'auth.json');
      if (!existsSync(auth)) throw new Error('Codex auth.json was not found. Run codex login before starting the fleet.');
      await copyFile(auth, join(runHome, 'auth.json'));
      const modelCache = join(originalHome, 'models_cache.json');
      if (existsSync(modelCache)) await copyFile(modelCache, join(runHome, 'models_cache.json'));
      this.assertActive();
      const { port, tokens, policyToken } = await this.startMcp();
      const baseUrl = `http://127.0.0.1:${port}`;
      const hookPath = join(this.runDir, 'policy-hook.mjs');
      await writeFile(hookPath, `let input='';for await(const chunk of process.stdin) input+=chunk;try {const r=await fetch(${JSON.stringify(`${baseUrl}/policy/${policyToken}`)},{method:'POST',headers:{'content-type':'application/json'},body:input,signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Policy unavailable');process.stdout.write(await r.text());}catch{process.stderr.write('Fleet policy unavailable: tool blocked.');process.exitCode=2;}`);
      const hookCommand = `node "${hookPath}"`;
      const unixCommand = `'${process.execPath.replace(/'/g, "'\\''")}' '${hookPath.replace(/'/g, "'\\''")}'`;
      const config = `model = ${quoted(MODEL)}\nmodel_reasoning_effort = ${quoted(EFFORT)}\napproval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\nproject_doc_max_bytes = 0\ncli_auth_credentials_store = "file"\n[features]\nshell_tool = false\nmulti_agent = true\nhooks = true\n[agents]\nmax_concurrent_threads_per_session = ${this.drones.length}\ndefault_subagent_model = ${quoted(MODEL)}\ndefault_subagent_reasoning_effort = ${quoted(EFFORT)}\n[tools]\nview_image = false\n[mcp_servers.fleet_parent]\nurl = ${quoted(`${baseUrl}/mcp/${tokens.parent}`)}\nrequired = true\ntool_timeout_sec = 60\n[[hooks.PreToolUse]]\nmatcher = ".*"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = ${quoted(unixCommand)}\ncommandWindows = ${quoted(hookCommand)}\ntimeout = 12\n`;
      const compatibleConfig = config.replace(`max_concurrent_threads_per_session = ${this.drones.length}`, `max_threads = ${this.drones.length}\nmax_depth = 1`)
        .replace(`default_subagent_model = ${quoted(MODEL)}\ndefault_subagent_reasoning_effort = ${quoted(EFFORT)}\n`, '')
        .replace('hooks = true', 'hooks = true\napps = false\nplugins = false\nimage_generation = false');
      const rolesConfig = this.drones.map(role => { const type = droneAgentType(role); return `[agents.${type}]\ndescription = ${quoted(`The ${role} simulation actor. Spawn exactly once, with clean context.`)}\nconfig_file = ${quoted(join(runHome, 'agents', `${type}.toml`))}\n`; }).join('');
      await writeFile(join(runHome, 'config.toml'), (compatibleConfig + rolesConfig).replaceAll('tool_timeout_sec = 60', 'tool_timeout_sec = 60\ndefault_tools_approval_mode = "approve"'));
      for (const role of this.drones) {
        const type = droneAgentType(role);
        const agentConfig = `name = ${quoted(type)}\ndescription = ${quoted(`The ${role} simulation actor. Spawn exactly once, with clean context.`)}\nmodel = ${quoted(MODEL)}\nmodel_reasoning_effort = ${quoted(EFFORT)}\ndeveloper_instructions = ${quoted(droneInstructions(role, this.roster, this.options.team))}\n[agents]\nenabled = false\n[features]\nmulti_agent = false\nshell_tool = false\n[mcp_servers.fleet_parent]\nenabled = false\n[mcp_servers.fleet_${type}]\nurl = ${quoted(`${baseUrl}/mcp/${tokens[role]}`)}\nrequired = true\ntool_timeout_sec = 60\n`;
        await writeFile(join(runHome, 'agents', `${type}.toml`), agentConfig.replace('[agents]\nenabled = false\n', '').replace('[mcp_servers.fleet_parent]\nenabled = false', `[mcp_servers.fleet_parent]\nurl = ${quoted(`${baseUrl}/mcp/${tokens.parent}`)}\nenabled = false`).replaceAll('tool_timeout_sec = 60', 'tool_timeout_sec = 60\ndefault_tools_approval_mode = "approve"'));
      }
      this.rpc = new AppServerRpc(message => this.onMessage(message), message => {
        if (!this.stopped) this.failRuntime(message);
      });
      this.assertActive();
      await this.rpc.start(workDir, runHome);
      this.assertActive();
      const models = await this.rpc.request('model/list', { includeHidden: true });
      this.assertActive();
      const luna = models.data?.find((m: any) => m.model === MODEL || m.id === MODEL);
      if (!luna || !luna.supportedReasoningEfforts?.some((e: any) => e.reasoningEffort === EFFORT)) throw new Error('Installed Codex did not advertise gpt-5.6-luna with xhigh. No inference was started.');
      if (this.startupError) throw new Error(this.startupError);
      this.options.onEvent({ type: 'model-verified', model: MODEL, effort: EFFORT, imageSupported: luna.inputModalities?.includes('image') });
      const thread = await this.rpc.request('thread/start', { cwd: workDir, model: MODEL, allowProviderModelFallback: false, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: 'You are an actor in a browser drone simulation. Follow your role-specific developer instructions. Use tools directly, keep reasoning brief, and wait for events when idle. Continue your event loop while the simulation is active. All actors use gpt-5.6-luna with xhigh reasoning.', developerInstructions: this.parentInstructions, config: { model_reasoning_effort: EFFORT, bypass_hook_trust: true }, ephemeral: true });
      this.assertActive();
      this.threadId = thread.thread.id;
      this.roles.set(this.threadId!, 'parent');
      this.options.onEvent({ type: 'runtime-version', version: thread.thread.cliVersion });
      this.options.onStatus({ cliVersion: thread.thread.cliVersion });
      if (process.env.FLEET_RUNTIME_PREFLIGHT === '1') return;
      this.options.onStatus({ status: 'starting', message: `Luna verified. Bootstrapping ${this.drones.length} native drone agents…`, threadId: this.threadId, children: [] });
      const turn = await this.rpc.request('turn/start', { threadId: this.threadId, model: MODEL, effort: EFFORT, input: [{ type: 'text', text: this.parentInstructions, text_elements: [] }] });
      this.activeTurns.set(this.threadId!, turn.turn.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.stopped) { this.failure = message; this.options.onStatus({ status: 'error', message }); }
      this.stopped = true;
      await this.cleanup(); throw error;
    }
  }

  private assertActive() { if (this.stopped) throw new Error('Fleet startup was cancelled.'); }

  toolsForRole(role: FleetRole): Tool[] {
    if (this.retired.has(role)) return [];
    return role === 'parent' ? [relayTool] : this.options.toolsForRole?.(role) ?? this.droneTools;
  }

  async refreshTools() { await this.mcp?.refreshTools(); }

  private recordToolsListed(role: FleetRole, tools: Tool[]) {
    const catalog = JSON.stringify(tools);
    this.servedCatalogs.set(role, catalog);
    // A native turn freezes its callable schemas. Later MCP list refreshes alone
    // do not change that turn's model request on Codex 0.144.
    if (!this.turnCatalogs.has(role)) this.turnCatalogs.set(role, catalog);
    for (const wake of this.catalogWaiters) wake();
  }

  private catalogBoundary(role: FleetRole, result: ToolResult): ToolResult {
    if (role === 'parent' || this.stopped || this.retired.has(role)) return result;
    const catalog = JSON.stringify(this.toolsForRole(role));
    const previous = this.turnCatalogs.get(role);
    if (!previous) { this.turnCatalogs.set(role, catalog); return result; }
    if (previous === catalog) return result;
    const attempts = (this.catalogYields.get(role) ?? 0) + 1;
    this.catalogYields.set(role, attempts);
    if (attempts > 3) { this.failRuntime(`${role} did not yield for its controller interface refresh.`); return result; }
    this.options.onEvent({ type: 'catalog-yield-requested', role, attempt: attempts });
    // The original fresh camera and unread events remain untouched. The actor
    // ends its own turn after reading them; no private reasoning is interrupted.
    return { ...result, content: [...result.content, { type: 'text', text: JSON.stringify({ controller: {
      type: 'tool_catalog_changed', instruction: 'Read this complete tool result, then finish this turn now with a brief acknowledgement and no more tool calls. Your same drone session will resume automatically with refreshed callable tools. This is not a new mission.',
    } }) }] };
  }

  private async awaitCurrentCatalog(threadId: string, role: FleetRole) {
    await this.refreshTools();
    // This supported app-server operation queues MCP configuration refresh for
    // loaded threads. It is issued only after this actor's turn has completed;
    // other actors keep their active turns and consume the queued refresh later.
    await this.rpc?.request('config/mcpServer/reload', {}, 8000);
    // On older Codex builds the notification marks inventory stale but does not
    // fetch it until an inventory read. This read is scoped to the idle child.
    await this.rpc?.request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly' }, 8000);
    const current = () => this.servedCatalogs.get(role) === JSON.stringify(this.toolsForRole(role));
    if (current()) return;
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => { clearTimeout(timer); this.catalogWaiters.delete(wake); error ? reject(error) : resolve(); };
      const wake = () => { if (this.stopped || this.retired.has(role)) done(new Error('Actor stopped during interface refresh')); else if (current()) done(); };
      const timer = setTimeout(() => done(new Error('Native MCP client did not refresh its callable tool catalog')), 8000);
      this.catalogWaiters.add(wake); wake();
    });
  }

  async retireDrone(role: FleetRole) {
    if (!this.drones.includes(role as typeof this.drones[number])) return;
    this.retired.add(role);
    for (const wake of this.catalogWaiters) wake();
    this.options.onEvent({ type: 'actor-retired', role });
    await Promise.allSettled([...this.roles].filter(([, actor]) => actor === role).map(async ([threadId]) => {
      const turnId = this.activeTurns.get(threadId);
      if (turnId) await this.rpc?.request('turn/interrupt', { threadId, turnId }, 2000);
    }));
    await this.refreshTools();
  }

  private async startMcp() {
    this.mcp = new FleetMcpServer({
      roles: ['parent', ...this.drones], active: () => !this.stopped,
      tools: role => this.toolsForRole(role), policy: event => this.policy(event), onEvent: this.options.onEvent,
      onToolsListed: (role, tools) => this.recordToolsListed(role, tools),
      call: async (role, name, args) => {
        this.options.onEvent({ type: 'tool', role, name, arguments: args });
        this.toolCalls++;
        const result = this.catalogBoundary(role, await this.options.toolHandler(role, name, args));
        this.options.onEvent({ type: 'tool-result', role, name, result: { ...result, content: result.content.map(item => item.type === 'image' ? { type: 'image', data: '[camera image omitted]', mimeType: item.mimeType } : item) } });
        return result;
      },
    });
    return this.mcp.start();
  }
  private policy(event: any) {
    this.options.onEvent({ type: 'policy-check', tool: event.tool_name, model: event.model, transcript: event.transcript_path?.split(/[/\\]/).pop(), sessionId: event.session_id });
    const allow = (updatedInput?: any) => updatedInput ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput } } : {};
    const deny = (reason: string) => {
      this.options.onEvent({ type: 'policy-denied', tool: event.tool_name, reason });
      if (++this.denied >= 4) this.failRuntime(`Repeated tool-policy failures: ${reason}`);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
    };
    if (this.stopped) return deny('The simulation has stopped.');
    if (event.model !== MODEL) return deny('Only Luna is permitted for this simulation.');
    const tool = String(event.tool_name ?? '');
    const actor = this.roles.get(event.session_id);
    if (actor && this.retired.has(actor)) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'This drone was destroyed. Finish now.' } };
    if (tool === `mcp__fleet_parent__${relayTool.name}` && (!actor || actor === 'parent')) return allow();
    const droneTool = /^mcp__fleet_(drone_\d+)__(.+)$/.exec(tool);
    const droneRole = droneTool && droneIdFromAgentType(droneTool[1], this.roster);
    if (droneRole && this.retired.has(droneRole)) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'This drone was destroyed. Finish now.' } };
    if (droneRole && (!actor || actor === droneRole) && this.toolsForRole(droneRole).some(allowed => allowed.name === droneTool![2])) return allow();
    if (tool === 'spawn_agent' || tool === 'Agent') {
      if (actor && actor !== 'parent') return deny('Only the mechanical relay can bootstrap actors.');
      const requested = event.tool_input ?? {};
      const agentType = requested.agent_type;
      if (!droneIdFromAgentType(agentType, this.roster)) return deny(`Spawn only ${this.drones.map(droneAgentType).join(', ')}, exactly once each.`);
      if (this.spawned.has(agentType)) return deny('That drone already exists. Use only the relay tool now.');
      this.spawned.add(agentType);
      this.options.onEvent({ type: 'bootstrap', agentType, policy: 'fixed prompt and Luna/xhigh enforced' });
      return allow({ agent_type: agentType, message: BOOTSTRAP_MESSAGE, model: MODEL, reasoning_effort: EFFORT, fork_context: false });
    }
    return deny('Fleet isolation permits only the actor’s game tools and the configured fixed drone spawns.');
  }

  private onMessage(message: any) {
    const p = message.params ?? {};
    if (message.id !== undefined && message.method) {
      this.options.onEvent({ type: 'runtime-request', method: message.method, threadId: p.threadId, serverName: p.serverName });
      this.rpc?.rejectRequest(message.id, 'Interactive approvals and external tools are disabled in this simulation.'); return;
    }
    if (message.method === 'thread/started') {
      const thread = p.thread;
      this.options.onEvent({ type: 'thread-started', threadId: thread?.id, role: thread?.agentRole, source: thread?.source, parentThreadId: thread?.parentThreadId });
      const role = droneIdFromAgentType(thread?.agentRole, this.roster);
      if (role) {
        this.roles.set(thread.id, role);
        const children = [...this.roles].filter(([, role]) => role !== 'parent').map(([id, role]) => ({ id, role }));
        this.options.onStatus({ children, status: children.length === this.drones.length ? 'running' : 'starting', message: children.length === this.drones.length ? `All ${this.drones.length} native Luna / xhigh drones connected.` : `Starting native drones (${children.length}/${this.drones.length})…` });
        this.options.onEvent({ type: 'child-started', role, threadId: thread.id, parentThreadId: thread.parentThreadId });
      }
    }
    if (message.method === 'turn/started') {
      this.activeTurns.set(p.threadId, p.turn.id);
      const role = this.roles.get(p.threadId);
      if (role && this.retired.has(role)) void this.retireDrone(role);
    }
    if (message.method === 'turn/completed') {
      this.activeTurns.delete(p.threadId);
      if (!this.stopped) {
        const role = this.roles.get(p.threadId) ?? 'unknown actor';
        this.options.onEvent({ type: 'actor-ended', role, status: p.turn.status, error: p.turn.error?.message });
        if (this.retired.has(role as FleetRole)) return;
        void this.resumeActor(p.threadId, role, this.catalogYields.has(role as FleetRole));
      }
    }
    if (message.method === 'thread/tokenUsage/updated') {
      this.usage.set(p.threadId, p.tokenUsage?.total?.totalTokens ?? 0);
      this.options.onStatus({ usage: [...this.usage.values()].reduce((a, b) => a + b, 0) });
      if (!this.toolCalls && [...this.usage.values()].reduce((a, b) => a + b, 0) > 40000) this.failRuntime('Bootstrap produced no game-tool calls after the token limit. Stopped to prevent wasted inference.');
    }
    if (message.method === 'item/completed' && p.item?.type === 'collabAgentToolCall') this.options.onEvent({ type: 'native-agent-call', tool: p.item.tool, status: p.item.status, model: p.item.model, effort: p.item.reasoningEffort, children: p.item.receiverThreadIds });
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage') this.options.onEvent({ type: 'actor-message', role: this.roles.get(p.threadId), text: p.item.text?.slice(0, 24_000) });
    if (message.method === 'item/completed' && p.item?.type === 'reasoning') {
      const summary = Array.isArray(p.item.summary) ? p.item.summary.slice(0, 32).map((part: unknown) => typeof part === 'string' ? part.slice(0, 6000) : String((part as { text?: unknown })?.text ?? '').slice(0, 6000)).filter(Boolean) : [];
      this.options.onEvent({ type: 'recorded-reasoning-summary', role: this.roles.get(p.threadId), threadId: p.threadId, itemId: p.item.id, summary, availability: summary.length ? 'Runtime-provided summary' : 'No reasoning summary was provided by this runtime' });
    }
    if (message.method === 'item/completed' && p.item?.type === 'mcpToolCall') this.options.onEvent({ type: 'mcp-result', role: this.roles.get(p.threadId), tool: p.item.tool, status: p.item.status, error: p.item.error });
    if (message.method === 'mcpServer/startupStatus/updated') {
      this.options.onEvent({ type: 'mcp-startup', ...p });
      const role = typeof p.name === 'string' && p.name.startsWith('fleet_') ? droneIdFromAgentType(p.name.slice(6), this.roster) : undefined;
      if (role && p.status === 'ready') {
        this.roles.set(p.threadId, role);
        const children = [...this.roles].filter(([, role]) => role !== 'parent').map(([id, role]) => ({ id, role }));
        this.options.onStatus({ children, status: children.length === this.drones.length ? 'running' : 'starting', message: children.length === this.drones.length ? `All ${this.drones.length} native Luna / xhigh drone tools connected.` : `Drone tools connected (${children.length}/${this.drones.length})…` });
      }
    }
    if (message.method === 'hook/completed') {
      this.options.onEvent({ type: 'hook-result', threadId: p.threadId, status: p.run?.status, durationMs: p.run?.durationMs, errors: p.run?.entries?.filter((entry: any) => entry.kind === 'error') });
      if (p.run?.status === 'failed') this.failRuntime('A fleet isolation hook failed. Runtime stopped.');
    }
    if (message.method === 'model/rerouted') this.failRuntime('Codex attempted to reroute the requested Luna model. Runtime stopped.');
    if (/warning/i.test(message.method ?? '')) {
      this.options.onEvent({ type: 'runtime-warning', message: p.message ?? p });
      if (/malformed agent role/i.test(JSON.stringify(p))) this.startupError = 'Installed Codex rejected a drone role configuration. No gameplay may start.';
    }
    if (message.method === 'error') this.options.onEvent({ type: 'runtime-error', message: p.error?.message ?? 'Codex error' });
  }

  private failRuntime(message: string) {
    if (this.stopped) return;
    this.failure = message;
    this.options.onStatus({ status: 'error', message });
    void this.stop(false);
  }

  private async resumeActor(threadId: string, role: string, catalogRefresh = false) {
    if (this.resuming.has(threadId)) return;
    const count = (this.resumptions.get(role as FleetRole) ?? 0) + 1;
    if (role === 'unknown actor' || (!catalogRefresh && count > 2)) { this.failRuntime(`${role} repeatedly stopped its event loop. The match cannot continue with a missing actor.`); return; }
    if (!catalogRefresh) this.resumptions.set(role as FleetRole, count);
    if (this.stopped || this.retired.has(role as FleetRole)) return;
    this.resuming.add(threadId);
    try {
      if (catalogRefresh) await this.awaitCurrentCatalog(threadId, role as FleetRole);
      if (this.stopped || this.retired.has(role as FleetRole)) return;
      this.turnCatalogs.set(role as FleetRole, JSON.stringify(this.toolsForRole(role as FleetRole)));
      this.catalogYields.delete(role as FleetRole);
      this.options.onEvent({ type: catalogRefresh ? 'catalog-turn-resumed' : 'actor-resumed', role, attempt: count });
      const turn = await this.rpc?.request('turn/start', { threadId, model: MODEL, effort: EFFORT, input: [{ type: 'text', text: catalogRefresh
        ? 'Your controller interface is refreshed. Continue your existing drone event loop with your current mission, received observations and currently callable fleet tools.'
        : role === 'parent'
        ? 'Continue your existing mechanical relay event loop. Do not create additional actors. Call forward_next_instruction until stopped.'
        : 'Continue your existing drone event loop using only your fleet tools. Call wait for current events. Finish only when destroyed or stopped.', text_elements: [] }] });
      if (turn) this.activeTurns.set(threadId, turn.turn.id);
      if (this.retired.has(role as FleetRole)) await this.retireDrone(role as FleetRole);
    } catch (error) { if (!this.stopped && !this.retired.has(role as FleetRole)) this.failRuntime(`Could not resume ${role}: ${String(error)}`); }
    finally { this.resuming.delete(threadId); }
  }

  stop(updateStatus = true): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.stopped && !this.startPromise && !this.runDir && !this.rpc) return Promise.resolve();
    this.stopped = true;
    for (const wake of this.catalogWaiters) wake();
    this.stopPromise = this.stopInternal(updateStatus).finally(() => { this.stopPromise = undefined; });
    return this.stopPromise;
  }

  private async stopInternal(updateStatus: boolean) {
    await this.cleanup();
    if (this.startPromise) await this.startPromise.catch(() => undefined);
    await this.cleanup();
    if (updateStatus && !this.failure) this.options.onStatus({ status: 'stopped', message: 'Fleet stopped. All runtime processes and temporary credentials cleaned up.' });
  }

  private cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = this.cleanupInternal().finally(() => { this.cleanupPromise = undefined; });
    return this.cleanupPromise;
  }

  private async cleanupInternal() {
    if (this.rpc) {
      await Promise.allSettled([...this.activeTurns].map(([threadId, turnId]) => this.rpc!.request('turn/interrupt', { threadId, turnId }, 2000)));
      await this.rpc.stop();
      this.rpc = undefined;
    }
    await this.mcp?.stop(); this.mcp = undefined;
    if (this.runDir) {
      // Only remove the exact mkdtemp-created directory, never the user's Codex home.
      const owned = resolve(this.runDir);
      if (owned.startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')) && /^drone-fleet-[^/\\]+$/.test(owned.split(/[/\\]/).pop()!)) await rm(owned, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      this.runDir = undefined;
    }
    this.activeTurns.clear();
  }
}
