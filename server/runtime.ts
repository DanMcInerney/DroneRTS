import express from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AppServerRpc } from './runtime-rpc.js';
import { BOOTSTRAP_MESSAGE, EFFORT, MODEL, droneInstructions, createDroneTools, createParentInstructions, relayTool, type FleetRole } from './runtime-tools.js';
import type { ToolResult } from '../shared/types.js';
import { DEFAULT_FLEET, validateRoster, droneAgentType, droneIdFromAgentType, type FleetRoster } from '../shared/fleet.ts';

type RuntimeOptions = {
  projectDir: string;
  roster?: FleetRoster;
  toolHandler: (role: FleetRole, name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  onStatus: (status: any) => void;
  onEvent: (event: any) => void;
};
const quoted = (value: string) => JSON.stringify(value);
const resultError = (message: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: message }) }] });

export class CodexFleetRuntime {
  private rpc?: AppServerRpc;
  private http?: HttpServer;
  private runDir?: string;
  private stopped = true;
  private threadId?: string;
  private roles = new Map<string, FleetRole>();
  private spawned = new Set<string>();
  private usage = new Map<string, number>();
  private activeTurns = new Map<string, string>();
  private connections = new Set<Server>();
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
        const agentConfig = `name = ${quoted(type)}\ndescription = ${quoted(`The ${role} simulation actor. Spawn exactly once, with clean context.`)}\nmodel = ${quoted(MODEL)}\nmodel_reasoning_effort = ${quoted(EFFORT)}\ndeveloper_instructions = ${quoted(droneInstructions(role, this.roster))}\n[agents]\nenabled = false\n[features]\nmulti_agent = false\nshell_tool = false\n[mcp_servers.fleet_parent]\nenabled = false\n[mcp_servers.fleet_${type}]\nurl = ${quoted(`${baseUrl}/mcp/${tokens[role]}`)}\nrequired = true\ntool_timeout_sec = 60\n`;
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

  private async startMcp() {
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    const tokens = Object.fromEntries(['parent', ...this.drones].map(role => [role, randomBytes(24).toString('hex')])) as Record<FleetRole, string>;
    const policyToken = randomBytes(24).toString('hex');
    app.post(`/policy/${policyToken}`, (req, res) => res.json(this.policy(req.body)));
    for (const role of ['parent', ...this.drones] as FleetRole[]) {
      const route = `/mcp/${tokens[role]}`;
      app.post(route, async (req, res) => {
        if (this.stopped) { res.status(503).end(); return; }
        const server = new Server({ name: `fleet-${role}`, version: '0.1.0' }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: role === 'parent' ? [relayTool] : this.droneTools }));
        server.setRequestHandler(CallToolRequestSchema, async request => {
          const name = request.params.name;
          const allowed = (role === 'parent' ? [relayTool] : this.droneTools).some(tool => tool.name === name);
          if (!allowed) return resultError('This tool is unavailable for this actor.');
          try {
            this.options.onEvent({ type: 'tool', role, name, arguments: request.params.arguments ?? {} });
            this.toolCalls++;
            const result = await this.options.toolHandler(role, name, request.params.arguments ?? {});
            // Camera pixels stay out of diagnostics; the audit writer also redacts
            // nested sensor JSON and credentials before storing other result fields.
            this.options.onEvent({ type: 'tool-result', role, name, result: { ...result, content: result.content.map(item => item.type === 'image' ? { type: 'image', data: '[camera image omitted]', mimeType: item.mimeType } : item) } });
            return { ...result };
          } catch (error) { return resultError(error instanceof Error ? error.message : String(error)); }
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        this.connections.add(server);
        res.on('close', () => { this.connections.delete(server); void server.close(); });
        try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
        catch { if (!res.headersSent) res.status(500).json({ error: 'MCP request failed.' }); }
      });
      app.get(route, (_req, res) => res.status(405).end());
      app.delete(route, (_req, res) => res.status(405).end());
    }
    this.http = createServer(app);
    await new Promise<void>((resolve, reject) => { this.http!.once('error', reject); this.http!.listen(0, '127.0.0.1', resolve); });
    const address = this.http.address();
    if (!address || typeof address === 'string') throw new Error('Cannot bind local MCP server.');
    return { port: address.port, tokens, policyToken };
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
    if (tool === `mcp__fleet_parent__${relayTool.name}`) return allow();
    const droneTool = /^mcp__fleet_(drone_\d+)__(.+)$/.exec(tool);
    if (droneTool && droneIdFromAgentType(droneTool[1], this.roster) && this.droneTools.some(allowed => allowed.name === droneTool[2])) return allow();
    if (tool === 'spawn_agent' || tool === 'Agent') {
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
    if (message.method === 'turn/started') this.activeTurns.set(p.threadId, p.turn.id);
    if (message.method === 'turn/completed') {
      this.activeTurns.delete(p.threadId);
      if (!this.stopped) {
        const role = this.roles.get(p.threadId) ?? 'unknown actor';
        this.options.onEvent({ type: 'actor-ended', role, status: p.turn.status, error: p.turn.error?.message });
        this.failRuntime(`${role} stopped its event loop. Reset the fleet to reconnect all actors.`);
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

  stop(updateStatus = true): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.stopped && !this.startPromise && !this.runDir && !this.rpc) return Promise.resolve();
    this.stopped = true;
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
    await Promise.allSettled([...this.connections].map(server => server.close()));
    if (this.http) { const http = this.http; this.http = undefined; http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
    if (this.runDir) {
      // Only remove the exact mkdtemp-created directory, never the user's Codex home.
      const owned = resolve(this.runDir);
      if (owned.startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')) && /^drone-fleet-[^/\\]+$/.test(owned.split(/[/\\]/).pop()!)) await rm(owned, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      this.runDir = undefined;
    }
    this.activeTurns.clear(); this.connections.clear();
  }
}
