/** Bounded browser fixture: actual camera/MCP delivery, no model runtime or inference.
 * Run with node --import tsx scripts/cockpit-fixture.ts. It owns an ephemeral port
 * and shuts down after ten minutes. /api/fixture controls only this synthetic match.
 */
import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FleetGame } from '../server/game.ts';
import { FleetMcpServer } from '../server/runtime-mcp.ts';
import { createDroneTools } from '../server/runtime-tools.ts';
import { CockpitStore, cockpitRouter } from '../server/cockpit.ts';
import { RuntimeReasoning } from '../server/runtime-reasoning.ts';
import { MATCH_DRONE_IDS, teamRoster } from '../shared/fleet.ts';
import type { DroneId, ToolResult } from '../shared/types.ts';

const game = new FleetGame(), store = new CockpitStore();
const reasoning = new RuntimeReasoning(event => store.recordRuntime(game.sessionIdentity, { ...event, role: event.threadId }));
const app = express(), server = createServer(app);
const sockets = new WebSocketServer({ noServer: true });
const clients = new Map<DroneId, Client>();
const captures = new Map<string, { resolve: (image: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let cameraUnavailable = false, shuttingDown = false;
game.setConnected(true); game.start(); store.reset(game.sessionIdentity);
game.state.runtime.message = 'Deterministic cockpit fixture — no model inference';
const toolsFor = (id: DroneId) => createDroneTools(teamRoster(id === 'drone-1' ? 'blue' : 'red'), game.toolCapabilities(id));
const mcp = new FleetMcpServer({ roles: ['drone-1', 'drone-4'], active: () => !shuttingDown,
  tools: role => role === 'parent' ? [] : toolsFor(role),
  call: (role, name, args) => game.tool(role, name, args), policy: () => ({}), onEvent: () => {},
  onToolEvidence: evidence => store.recordTool(game.sessionIdentity, evidence),
});
const endpoint = await mcp.start();
for (const id of ['drone-1', 'drone-4'] as const) {
  const client = new Client({ name: `fixture-${id}`, version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp/${endpoint.tokens[id]}`)));
  clients.set(id, client);
}
const broadcast = () => {
  for (const socket of sockets.clients) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'state', state: game.state }));
};
server.on('upgrade', (request, socket, head) => {
  if (request.url === '/ws') sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
});
sockets.on('connection', socket => {
  broadcast(); socket.on('message', bytes => {
    const packet = JSON.parse(String(bytes));
    const capture = captures.get(packet.requestId);
    if (packet.type === 'capture-result' && capture) {
      captures.delete(packet.requestId); clearTimeout(capture.timer);
      if (typeof packet.image === 'string') capture.resolve(packet.image);
      else capture.reject(new Error('Fixture capture unavailable'));
    }
  });
});
game.capture = (droneId, pose, simTime, drones, match) => {
  if (cameraUnavailable) return Promise.reject(new Error('Intentional fixture camera failure'));
  const socket = [...sockets.clients].find(item => item.readyState === WebSocket.OPEN);
  if (!socket) return Promise.reject(new Error('Open the fixture browser first'));
  return new Promise((resolveImage, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => { captures.delete(requestId); reject(new Error('Fixture camera timeout')); }, 8000);
    captures.set(requestId, { resolve: resolveImage, reject, timer });
    socket.send(JSON.stringify({ type: 'capture', requestId, droneId, pose, simTime, drones, match }));
  });
};
app.use(express.json());
app.get('/api/state', (_req, res) => res.json(game.state));
app.use('/api/cockpit', cockpitRouter({ store, state: () => game.state, tools: id => toolsFor(id).map(tool => tool.name) }));
app.post('/api/start', (_req, res) => { res.status(409).json({ error: 'Model inference is disabled in this fixture.' }); });
app.post('/api/stop', (_req, res) => { game.stop(); broadcast(); res.json({ stopped: true }); });
app.post('/api/fixture', async (req, res) => {
  try {
    const id = req.body.droneId === 'drone-4' ? 'drone-4' : 'drone-1';
    const client = clients.get(id)!;
    switch (req.body.action) {
      case 'bootstrap':
        for (const drone of MATCH_DRONE_IDS) await game.tool(drone, 'observe');
        await game.forwardTeam('blue'); await game.forwardTeam('red');
        break;
      case 'mail':
        game.inboxes[id].push({ type: 'radio', from: id === 'drone-1' ? 'drone-2' : 'drone-5', text: 'Fixture teammate: checking the cargo pad.', mission: 1 });
        break;
      case 'camera-off': cameraUnavailable = true; break;
      case 'camera-on': cameraUnavailable = false; break;
      case 'output':
        store.recordRuntime(game.sessionIdentity, { type: 'actor-message', role: id, itemId: 'fixture-output', text: 'Fixture output: observing the cargo and sharing the result.' });
        reasoning.accept('item/started', { threadId: id, item: { type: 'reasoning', id: 'fixture-reasoning' } });
        reasoning.accept('item/reasoning/textDelta', { threadId: id, itemId: 'fixture-reasoning', delta: 'Synthetic native reasoning for UI verification; ' });
        reasoning.accept('item/reasoning/textDelta', { threadId: id, itemId: 'fixture-reasoning', delta: 'no model inference.' });
        reasoning.accept('item/reasoning/summaryTextDelta', { threadId: id, itemId: 'fixture-reasoning', delta: 'Synthetic summary for UI verification; no model inference.' });
        break;
      case 'reasoning-complete':
        reasoning.accept('item/completed', { threadId: id, item: { type: 'reasoning', id: 'fixture-reasoning', content: [], summary: [] } });
        reasoning.accept('item/completed', { threadId: id, item: { type: 'reasoning', id: 'fixture-unavailable', content: [], summary: [], encryptedContent: 'synthetic opaque fixture content' } });
        break;
      case 'cargo': {
        const node = game.state.match!.resources[req.body.index === 1 ? 1 : req.body.index === 2 ? 2 : 0];
        const drone = game.state.drones.find(drone => drone.id === id)!;
        // Developer-controlled viewpoint to verify real 512×288 resource pixels.
        Object.assign(drone, { x: node.x, y: 3.2, z: node.z + 7, yaw: 0, pitch: -17 });
        break;
      }
      case 'reset':
        reasoning.flush();
        game.stop(); game.reset(); game.start(); store.reset(game.sessionIdentity);
        game.state.runtime.message = 'Deterministic cockpit fixture — no model inference';
        broadcast(); res.json({ reset: true }); return;
      case 'observe': break;
      default: res.status(400).json({ error: 'Unknown fixture action' }); return;
    }
    broadcast();
    const result = await client.callTool({ name: req.body.tool === 'send' ? 'send' : 'observe', arguments: req.body.tool === 'send'
      ? { mission: 1, to: 'all', kind: 'chat', text: 'Fixture outbound: inspecting the cargo.' } : {} });
    res.json({ result: result as ToolResult, snapshot: store.snapshot(id, { running: game.state.running, tools: toolsFor(id).map(tool => tool.name) }) });
  } catch (error) { res.status(500).json({ error: String(error) }); }
});
const vite = await createViteServer({ root: resolve('.'), server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
app.use(vite.middlewares);
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Fixture failed to bind');
console.log(JSON.stringify({ url: `http://127.0.0.1:${address.port}`, inference: false, drones: MATCH_DRONE_IDS, expiresInMinutes: 10 }));
const broadcastTimer = setInterval(broadcast, 500);
const deadline = setTimeout(() => { void shutdown(); }, 600_000);
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  clearInterval(broadcastTimer); clearTimeout(deadline); game.stop();
  for (const capture of captures.values()) { clearTimeout(capture.timer); capture.reject(new Error('Fixture stopped')); }
  captures.clear();
  for (const socket of sockets.clients) socket.close();
  await Promise.allSettled([...clients.values()].map(client => client.close()));
  await mcp.stop(); await vite.close();
  sockets.close(); server.closeAllConnections(); server.close(); process.exit(0);
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
