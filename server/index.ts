import express from 'express';
import { createServer } from 'node:http';
import { mkdirSync, createWriteStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { FleetGame } from './game.ts';
import { CodexFleetRuntime } from './runtime.ts';
import { MODEL, EFFORT } from './runtime-tools.ts';
import { FleetNetwork } from './network.ts';
import { MavlinkAdapter } from './mavlink.ts';
import { diagnosticsRouter, redactDiagnostic } from './diagnostics.ts';
import { DRONE_IDS, type DroneId, type Pose } from '../shared/types.ts';
import { DEFAULT_FLEET } from '../shared/fleet.ts';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.FLEET_PORT ?? 4317);
const app = express();
const server = createServer(app);
const sockets = new WebSocketServer({ noServer: true, maxPayload: 3_000_000 });
const game = new FleetGame();
let runtime: CodexFleetRuntime | undefined;
let network: FleetNetwork | undefined;
let vehicle: MavlinkAdapter | undefined;
let starting = false, stopping = false;
let disconnectedTimer: ReturnType<typeof setTimeout> | undefined;
let sessionLog: ReturnType<typeof createWriteStream> | undefined;
let activeSessionLog: string | undefined;
const captures = new Map<string, { socket: WebSocket; resolve: (image: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function audit(type: string, value: unknown) {
  if (!sessionLog) return;
  const clean = redactDiagnostic(value);
  sessionLog.write(JSON.stringify({ wallTime: new Date().toISOString(), type, value: clean }) + '\n');
}
function broadcast() {
  const message = JSON.stringify({ type: 'state', state: game.state });
  for (const socket of sockets.clients) if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 2_000_000) socket.send(message);
}
function setRuntime(status: Record<string, unknown>) {
  Object.assign(game.state.runtime, status); audit('runtime', status); broadcast();
  if ((status.status === 'error' || status.status === 'stopped') && game.state.running) game.stop();
}
async function stopFleet(message = 'Fleet stopped') {
  if (stopping) return;
  stopping = true;
  game.stop();
  for (const [id, pending] of captures) { clearTimeout(pending.timer); pending.reject(new Error('Fleet stopped')); captures.delete(id); }
  try { await Promise.allSettled([runtime?.stop(), network?.stop(), vehicle?.stop()]); }
  finally {
    runtime = undefined; network = undefined; vehicle = undefined;
    game.radioTransport = undefined; game.vehicleTransport = undefined;
    starting = false; stopping = false;
    setRuntime({ status: 'stopped', message });
    sessionLog?.end(); sessionLog = undefined; activeSessionLog = undefined;
  }
}

app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  if (origin && origin !== `http://${req.get('host')}`) { res.status(403).json({ error: 'Only the game page can control this local fleet' }); return; }
  if (req.method === 'POST' && !req.is('application/json')) { res.status(415).json({ error: 'Use application/json' }); return; }
  next();
});
app.use(express.json({ limit: '16kb' }));
app.get('/api/state', (_req, res) => res.json(game.state));
app.use('/api/diagnostics', diagnosticsRouter({ directory: resolve(projectDir, 'artifacts'), roster: DEFAULT_FLEET, state: () => game.state, activeSession: () => activeSessionLog }));
app.post('/api/start', async (_req, res) => {
  if (runtime || starting || stopping || game.state.running) { res.status(409).json({ error: 'Fleet is already running or changing state' }); return; }
  try {
    game.start(); starting = true;
    mkdirSync(resolve(projectDir, 'artifacts'), { recursive: true });
    activeSessionLog = `session-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    sessionLog = createWriteStream(resolve(projectDir, 'artifacts', activeSessionLog));
    delete game.state.runtime.threadId; game.state.runtime.children = []; game.state.runtime.usage = 0;
    setRuntime({ status: 'starting', message: `Verifying Luna / xhigh and creating ${DRONE_IDS.length} native drone agents`, model: MODEL, effort: EFFORT });
    const networkFailure = (message: string) => {
      if (network !== activeNetwork || stopping) return;
      void stopFleet(message).then(() => { if (!runtime) setRuntime({ status: 'error', message }); });
    };
    const activeNetwork = new FleetNetwork({ projectDir, roster: DEFAULT_FLEET, sessionId: game.sessionIdentity,
      onReceive: (id, message) => game.receiveRadio(id, message),
      onState: state => { if (network === activeNetwork) { game.state.network = state; broadcast(); } },
      onEvent: event => audit('network', event), onFailure: networkFailure,
    });
    const activeVehicle = new MavlinkAdapter({ projectDir, roster: DEFAULT_FLEET, onEvent: event => {
      audit('mavlink', event);
      if (event.event === 'fatal') networkFailure(String(event.message));
    } });
    network = activeNetwork; vehicle = activeVehicle;
    const activeRuntime = new CodexFleetRuntime({ projectDir, roster: DEFAULT_FLEET,
      toolHandler: (role, name, args) => game.tool(role, name, args),
      onStatus: status => {
        if (runtime !== activeRuntime) return;
        setRuntime(status);
        if (status.status === 'error' && !stopping) {
          void stopFleet(String(status.message)).then(() => {
            if (!runtime) setRuntime({ status: 'error', message: status.message });
          });
        }
      },
      onEvent: event => audit('agent', event),
    });
    runtime = activeRuntime;
    void (async () => {
      await Promise.all([activeNetwork.start(), activeVehicle.start()]);
      if (runtime !== activeRuntime || stopping || !game.state.running) throw new Error('Fleet startup cancelled');
      game.radioTransport = activeNetwork; game.vehicleTransport = activeVehicle;
      await activeRuntime.start();
    })().then(() => { if (runtime === activeRuntime) { starting = false; broadcast(); } }).catch(async error => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Fleet runtime:', message);
      if (runtime !== activeRuntime) return;
      await stopFleet(message);
      setRuntime({ status: 'error', message });
    });
    res.json({ starting: true, model: MODEL, effort: EFFORT });
  } catch (error) { starting = false; res.status(400).json({ error: String(error) }); }
});
app.post('/api/stop', async (_req, res) => { await stopFleet(); res.json({ stopped: true }); });
app.post('/api/reset', (_req, res) => {
  try { if (starting || stopping) throw new Error('Wait for the current start/stop to finish'); game.reset(); res.json(game.state); }
  catch (error) { res.status(409).json({ error: String(error) }); }
});
app.post('/api/mission', (req, res) => {
  try { const result = game.queueMission(req.body.text); audit('player-queued', req.body); broadcast(); res.json(result); }
  catch (error) { res.status(400).json({ error: String(error) }); }
});
app.post('/api/speed', (req, res) => {
  try { game.setSpeed(req.body.speed); res.json({ speed: game.state.speed }); }
  catch (error) { res.status(400).json({ error: String(error) }); }
});
app.post('/api/network/link', async (req, res) => {
  try {
    if (!network || network.state.status !== 'online' || stopping) throw new Error('Launch the fleet before changing network links');
    if (!DRONE_IDS.includes(req.body.droneId) || typeof req.body.online !== 'boolean') throw new Error('Choose a drone and link state');
    await network.link(req.body.droneId, req.body.online);
    audit('network-link', req.body); res.json({ updated: true });
  } catch (error) { res.status(400).json({ error: String(error) }); }
});

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') return;
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { socket.destroy(); return; }
  sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws, req));
});
sockets.on('connection', socket => {
  clearTimeout(disconnectedTimer);
  game.setConnected(true); broadcast();
  socket.on('message', bytes => {
    try {
      const packet = JSON.parse(bytes.toString());
      if (packet.type !== 'capture-result') return;
      const pending = captures.get(packet.requestId);
      if (!pending || pending.socket !== socket) return;
      captures.delete(packet.requestId); clearTimeout(pending.timer);
      if (typeof packet.image !== 'string' || packet.image.length > 2_000_000) pending.reject(new Error('Invalid camera result'));
      else pending.resolve(packet.image);
    } catch { /* Ignore malformed transport input; pending capture will time out. */ }
  });
  socket.on('close', () => {
    for (const [id, pending] of captures) if (pending.socket === socket) {
      clearTimeout(pending.timer); pending.reject(new Error('Camera browser disconnected')); captures.delete(id);
    }
    if (sockets.clients.size === 0) {
      game.setConnected(false);
      if (game.state.running) disconnectedTimer = setTimeout(() => { void stopFleet('Browser disconnected; fleet stopped to prevent unattended inference'); }, 10_000);
    }
  });
});
game.capture = async (droneId: DroneId, pose: Pose, simTime: number, drones) => {
  const socket = [...sockets.clients].find(client => client.readyState === WebSocket.OPEN);
  if (!socket) throw new Error('Camera browser is disconnected');
  const requestId = randomUUID();
  return new Promise<string>((resolveImage, reject) => {
    const timer = setTimeout(() => { captures.delete(requestId); reject(new Error('Camera capture timed out; check the game browser')); }, 8000);
    captures.set(requestId, { socket, resolve: resolveImage, reject, timer });
    socket.send(JSON.stringify({ type: 'capture', requestId, droneId, pose, simTime, drones }));
  });
};
for (const event of ['radio', 'tool', 'observation', 'tool-error', 'transport-error', 'treasure-found']) game.on(event, value => audit(event, value));
game.on('transport-error', error => {
  if (!stopping) void stopFleet(error.message).then(() => { if (!runtime) setRuntime({ status: 'error', message: error.message }); });
});
game.on('tool-error', error => {
  if (error.consecutive >= 4 && game.state.running && !stopping) {
    const message = `${error.role} repeatedly failed a game tool. Fleet stopped to prevent repeated inference. ${error.message}`;
    void stopFleet(message).then(() => setRuntime({ status: 'error', message }));
  }
});
game.on('change', broadcast);

const production = process.argv.includes('--production');
if (production) app.use(express.static(resolve(projectDir, 'dist')));
else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ root: projectDir, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  app.use(vite.middlewares);
}
let lastTick = performance.now();
const ticker = setInterval(() => { const now = performance.now(); game.tick((now - lastTick) / 1000); lastTick = now; broadcast(); }, 50);
server.listen(port, '127.0.0.1', () => console.log(`Fleet game ready: http://127.0.0.1:${port} (Luna / xhigh)`));
async function shutdown() { clearInterval(ticker); clearTimeout(disconnectedTimer); await stopFleet(); server.close(); process.exit(0); }
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
