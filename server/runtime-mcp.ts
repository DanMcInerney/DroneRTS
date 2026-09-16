import express from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { FleetRole } from './runtime-tools.ts';
import type { ToolResult } from '../shared/types.ts';
import type { CockpitToolEvidence } from '../shared/cockpit.ts';
import { resultSubmission, verifyFleetResult, type SubmittedResult } from './observation-format.ts';

type RequestScope = { controller: AbortController; result?: SubmittedResult; handlerStarted: boolean; handlerDone: boolean; sent: boolean; outputDone: boolean;
  error?: unknown; ticket?: { signal: AbortSignal; settled(): void }; cleanup: Array<() => void>; finish(): void; fail(error: unknown): void };
type Connection = { role: FleetRole; server: Server; transport: StreamableHTTPServerTransport; catalog: string; requests: Map<unknown, RequestScope> };
const errorResult = (message: string): ToolResult => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: message }) }] });

/** Bearer URLs select one actor. Persistent MCP sessions carry catalog changes over SSE. */
export class FleetMcpServer {
  private http?: HttpServer;
  private sessions = new Map<string, Connection>();
  private connections = new Set<Connection>();
  constructor(private options: {
    roles: FleetRole[];
    active: () => boolean;
    tools: (role: FleetRole) => Tool[];
    call: (role: FleetRole, name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;
    beginTool?: (role: FleetRole) => { signal: AbortSignal; settled(): void };
    policy: (event: unknown) => unknown;
    onEvent: (event: unknown) => void;
    onToolsListed?: (role: FleetRole, tools: Tool[]) => void;
    onToolEvidence?: (event: CockpitToolEvidence) => void;
  }) {}

  async start() {
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    const tokens = Object.fromEntries(this.options.roles.map(role => [role, randomBytes(24).toString('hex')])) as Record<FleetRole, string>;
    const policyToken = randomBytes(24).toString('hex');
    app.post(`/policy/${policyToken}`, (req, res) => res.json(this.options.policy(req.body)));
    for (const role of this.options.roles) app.all(`/mcp/${tokens[role]}`, async (req, res) => {
      if (!this.options.active()) { res.status(503).end(); return; }
      const id = req.get('mcp-session-id');
      let connection = id ? this.sessions.get(id) : undefined;
      if (id && (!connection || connection.role !== role)) { res.status(404).json({ error: 'Unknown actor session' }); return; }
      try {
        if (!connection) {
          if (req.method !== 'POST' || !isInitializeRequest(req.body)) { res.status(400).json({ error: 'Initialize an actor session first' }); return; }
          // Reconnecting a role closes its abandoned sessions instead of accumulating streams.
          for (const old of this.connections) if (old.role === role) await old.server.close();
          const server = new Server({ name: `fleet-${role}`, version: '0.2.0' }, { capabilities: { tools: { listChanged: true } } });
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
            onsessioninitialized: sessionId => { this.sessions.set(sessionId, connection!); },
          });
          connection = { role, server, transport, catalog: JSON.stringify(this.options.tools(role)), requests: new Map() };
          const owned = connection;
          this.connections.add(owned);
          server.onclose = () => { for (const request of owned.requests.values()) request.fail(new Error('MCP session closed')); this.connections.delete(owned); if (transport.sessionId) this.sessions.delete(transport.sessionId); };
          // SDK 1.30.0 is pinned: inspect the instance's final JSON-RPC result
          // here, after SDK formatting, and confirm only its HTTP finish below.
          // Keep the real-client overflow/disconnect/correlation tests on upgrades.
          const send = transport.send.bind(transport);
          transport.send = async (message, options) => {
            const request = 'id' in message && !('method' in message) ? owned.requests.get(message.id) : undefined;
            try {
              if (request) {
                request.controller.signal.throwIfAborted();
                request.ticket?.signal.throwIfAborted();
                if ('result' in message) {
                  const sizes = verifyFleetResult(message.result as ToolResult, message.id);
                  this.options.onEvent({ type: 'mcp-output-sized', role, ...sizes });
                  request.sent = true;
                } else request.error = new Error('MCP rejected final tool output');
                if (!request.handlerStarted) request.handlerDone = true;
              }
              await send(message, options);
            } catch (error) { request?.fail(error); throw error; }
          };
          server.setRequestHandler(ListToolsRequestSchema, async () => {
            const tools = this.options.tools(role);
            this.options.onToolsListed?.(role, tools);
            return { tools };
          });
          server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
            const name = request.params.name, args = request.params.arguments ?? {};
            const scope = owned.requests.get(extra.requestId);
            if (!scope) throw new Error('Missing scoped MCP request');
            scope.handlerStarted = true;
            const abort = () => scope.controller.abort(extra.signal.reason);
            extra.signal.addEventListener('abort', abort, { once: true });
            scope.cleanup.push(() => extra.signal.removeEventListener('abort', abort));
            if (extra.signal.aborted) abort();
            this.evidence({ type: 'call', role, name, arguments: args });
            let result: SubmittedResult | undefined;
            try {
              scope.ticket = this.options.beginTool?.(role);
              const signal = scope.ticket ? AbortSignal.any([scope.controller.signal, scope.ticket.signal]) : scope.controller.signal;
              signal.throwIfAborted();
              const catalog = this.options.tools(role);
              if (!this.options.active()) result = errorResult('The simulation has stopped.');
              else if (!catalog.some(tool => tool.name === name)) {
                // Rejected guesses still deliver the actor's fresh decision bundle.
                const observation = catalog.some(tool => tool.name === 'observe') ? await this.options.call(role, 'observe', {}, signal) : { content: [] };
                result = { ...observation, isError: true, content: [...errorResult('This tool is unavailable for this actor.').content, ...observation.content] };
              } else {
                result = await this.options.call(role, name, args, signal);
                await this.refreshTools();
              }
              signal.throwIfAborted();
              verifyFleetResult(result, extra.requestId);
            } catch (error) {
              result?.[resultSubmission]?.failed(error);
              result = errorResult(error instanceof Error ? error.message : String(error));
            }
            scope.result = result; scope.handlerDone = true; scope.finish();
            // Capture the final MCP result, including error wrappers and controller refreshes.
            this.evidence({ type: 'delivery', role, name, result });
            return result;
          });
          await server.connect(transport);
        }
        if (!['POST', 'GET', 'DELETE'].includes(req.method)) { res.status(405).end(); return; }
        if (req.method === 'POST' && req.body?.method === 'tools/call') {
          const owned = connection, requestId = req.body.id;
          if (owned.requests.has(requestId) || owned.requests.size >= 8) { res.status(429).end(); return; }
          let finished = false;
          const scope: RequestScope = { controller: new AbortController(), handlerStarted: false, handlerDone: false, sent: false, outputDone: false, cleanup: [],
            finish: () => {
              if (finished || !scope.outputDone || !scope.handlerDone) return;
              finished = true; owned.requests.delete(requestId); scope.cleanup.forEach(cleanup => cleanup());
              try {
                if (scope.error || !scope.sent || scope.controller.signal.aborted || scope.ticket?.signal.aborted) scope.result?.[resultSubmission]?.failed(scope.error ?? new Error('MCP output cancelled'));
                else scope.result?.[resultSubmission]?.submitted();
              } finally { scope.ticket?.settled(); }
            },
            fail: error => { scope.error = error; scope.controller.abort(error); scope.outputDone = true; if (!scope.handlerStarted) scope.handlerDone = true; scope.finish(); res.destroy(); },
          };
          const finish = () => { scope.outputDone = true; if (res.statusCode !== 200) scope.error = new Error(`MCP HTTP ${res.statusCode}`); scope.finish(); };
          const close = () => { if (!res.writableFinished) scope.fail(new Error('MCP client disconnected')); };
          res.once('finish', finish); res.once('close', close);
          scope.cleanup.push(() => { res.off('finish', finish); res.off('close', close); });
          owned.requests.set(requestId, scope);
        }
        await connection.transport.handleRequest(req, res, req.body);
      } catch (error) {
        this.options.onEvent({ type: 'mcp-transport-error', role, message: String(error) });
        connection?.requests.get(req.body?.id)?.fail(error);
        if (!res.headersSent) res.status(500).json({ error: 'MCP request failed.' });
      }
    });
    this.http = createServer(app);
    await new Promise<void>((resolve, reject) => { this.http!.once('error', reject); this.http!.listen(0, '127.0.0.1', resolve); });
    const address = this.http.address();
    if (!address || typeof address === 'string') throw new Error('Cannot bind local MCP server.');
    return { port: address.port, tokens, policyToken };
  }

  private evidence(event: CockpitToolEvidence) {
    try { this.options.onToolEvidence?.(event); }
    catch { this.options.onEvent({ type: 'player-evidence-error', role: event.role }); }
  }

  async refreshTools() {
    await Promise.allSettled([...this.connections].map(async connection => {
      const catalog = JSON.stringify(this.options.tools(connection.role));
      if (catalog === connection.catalog) return;
      connection.catalog = catalog;
      try { await connection.server.sendToolListChanged(); }
      catch (error) { this.options.onEvent({ type: 'mcp-catalog-notification-error', role: connection.role, message: String(error) }); }
    }));
  }

  async stop() {
    await Promise.allSettled([...this.connections].map(connection => connection.server.close()));
    if (this.http) { const http = this.http; this.http = undefined; http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
    this.connections.clear(); this.sessions.clear();
  }
}
