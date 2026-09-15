import express from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { FleetRole } from './runtime-tools.ts';
import type { ToolResult } from '../shared/types.ts';
import type { CockpitToolEvidence } from '../shared/cockpit.ts';

type Connection = { role: FleetRole; server: Server; transport: StreamableHTTPServerTransport; catalog: string };
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
    call: (role: FleetRole, name: string, args: Record<string, unknown>) => Promise<ToolResult>;
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
          connection = { role, server, transport, catalog: JSON.stringify(this.options.tools(role)) };
          const owned = connection;
          this.connections.add(owned);
          server.onclose = () => { this.connections.delete(owned); if (transport.sessionId) this.sessions.delete(transport.sessionId); };
          server.setRequestHandler(ListToolsRequestSchema, async () => {
            const tools = this.options.tools(role);
            this.options.onToolsListed?.(role, tools);
            return { tools };
          });
          server.setRequestHandler(CallToolRequestSchema, async request => {
            const name = request.params.name, args = request.params.arguments ?? {};
            this.evidence({ type: 'call', role, name, arguments: args });
            let result: ToolResult;
            try {
              const catalog = this.options.tools(role);
              if (!this.options.active()) result = errorResult('The simulation has stopped.');
              else if (!catalog.some(tool => tool.name === name)) {
                // Rejected guesses still deliver the actor's fresh decision bundle.
                const observation = catalog.some(tool => tool.name === 'observe') ? await this.options.call(role, 'observe', {}) : { content: [] };
                result = { ...observation, isError: true, content: [...errorResult('This tool is unavailable for this actor.').content, ...observation.content] };
              } else {
                result = await this.options.call(role, name, args);
                await this.refreshTools();
              }
            } catch (error) { result = errorResult(error instanceof Error ? error.message : String(error)); }
            // Capture the final MCP result, including error wrappers and controller refreshes.
            this.evidence({ type: 'delivery', role, name, result });
            return result;
          });
          await server.connect(transport);
        }
        if (!['POST', 'GET', 'DELETE'].includes(req.method)) { res.status(405).end(); return; }
        await connection.transport.handleRequest(req, res, req.body);
      } catch (error) {
        this.options.onEvent({ type: 'mcp-transport-error', role, message: String(error) });
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
