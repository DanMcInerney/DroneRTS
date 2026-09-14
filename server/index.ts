import express from 'express';
import { createServer } from 'node:http';
import { mkdirSync, createWriteStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { FleetGame } from './game.ts';
import { TeamSession } from './team-session.ts';
import { MODEL, EFFORT } from './runtime-tools.ts';
import { diagnosticsRouter, redactDiagnostic } from './diagnostics.ts';
import type { DroneId, Pose } from '../shared/types.ts';
import { MATCH_FLEET, MATCH_DRONE_IDS } from '../shared/fleet.ts';
import { ReplayRecorder } from './replay-recorder.ts';
import { replayRouter } from './replay-store.ts';
import { CITY } from '../shared/city.ts';
import { BATTLEFIELD } from '../shared/battlefield.ts';
import { DRONE_CAMERA } from '../shared/camera-profile.ts';
import type { ReplayHeader, RecordedObservation } from '../shared/replay.ts';
import type { MatchEvent } from '../shared/rts.ts';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.FLEET_PORT ?? 4317);
const app = express();
const server = createServer(app);
const sockets = new WebSocketServer({ noServer: true, maxPayload: 3_000_000 });
const game = new FleetGame();
let runtime: TeamSession | undefined;
let starting = false, stopping = false;
let stopPromise: Promise<void> | undefined;
let disconnectedTimer: ReturnType<typeof setTimeout> | undefined;
let sessionLog: ReturnType<typeof createWriteStream> | undefined;
let activeSessionLog: string | undefined;
let replay: ReplayRecorder | undefined;
let replayCreation: Promise<ReplayRecorder> | undefined;
const captures = new Map<string, { socket: WebSocket; resolve: (image: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function audit(type: string, value: unknown) {
  if (!sessionLog) return;
  const clean = redactDiagnostic(value);
  sessionLog.write(JSON.stringify({ wallTime: new Date().toISOString(), type, value: clean }) + '\n');
}
function broadcast() {
  replay?.recordFrame(game.state);
  const message = JSON.stringify({ type: 'state', state: game.state });
  for (const socket of sockets.clients) if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 2_000_000) socket.send(message);
}
function setRuntime(status: Record<string, unknown>) {
  Object.assign(game.state.runtime, status); audit('runtime', status); broadcast();
  if ((status.status === 'error' || status.status === 'stopped') && game.state.running) game.stop();
}
function stopFleet(message = 'Fleet stopped'): Promise<void> {
  if (stopPromise) return stopPromise;
  stopping = true;
  game.stop();
  replay?.recordFrame(game.state, true);
  const closingReplay = replay, pendingReplay = replayCreation;
  replay = undefined;
  for (const [id, pending] of captures) { clearTimeout(pending.timer); pending.reject(new Error('Fleet stopped')); captures.delete(id); }
  stopPromise = (async () => {
    try {
      const results = await Promise.allSettled([runtime?.stop(), closingReplay?.stop(game.state.simTime), pendingReplay?.then(recording => recording.stop(game.state.simTime))]);
      if (results[0].status === 'rejected') throw results[0].reason;
    }
    finally {
      runtime = undefined;
      game.radioTransport = undefined; game.vehicleTransport = undefined;
      starting = false; stopping = false;
      setRuntime({ status: 'stopped', message });
      sessionLog?.end(); sessionLog = undefined; activeSessionLog = undefined;
    }
  })().finally(() => { stopPromise = undefined; });
  return stopPromise;
}

app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  if (origin && origin !== `http://${req.get('host')}`) { res.status(403).json({ error: 'Only the game page can control this local fleet' }); return; }
  if (req.method === 'POST' && !req.is('application/json')) { res.status(415).json({ error: 'Use application/json' }); return; }
  next();
});
app.use(express.json({ limit: '16kb' }));
app.get('/api/state', (_req, res) => res.json(game.state));
app.use('/api/diagnostics', diagnosticsRouter({ directory: resolve(projectDir, 'artifacts'), roster: MATCH_FLEET, state: () => game.state, activeSession: () => activeSessionLog }));
app.use('/api/diagnostics', replayRouter({ directory: resolve(projectDir, 'artifacts') }));
app.post('/api/start', async (_req, res) => {
  if (runtime || starting || stopping || game.state.running) { res.status(409).json({ error: 'Fleet is already running or changing state' }); return; }
  try {
    game.start(); starting = true;
    mkdirSync(resolve(projectDir, 'artifacts'), { recursive: true });
    activeSessionLog = `session-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    sessionLog = createWriteStream(resolve(projectDir, 'artifacts', activeSessionLog));
    const logId = activeSessionLog;
    const header: ReplayHeader = {
      type: 'header', protocol: 'fleet-replay/1', startedAt: new Date().toISOString(), sampleInterval: 0.1,
      roster: MATCH_FLEET, scene: { name: CITY.name, bounds: { x: CITY.bounds.x, z: CITY.bounds.z },
        focus: BATTLEFIELD.focus, obstacles: game.state.obstacles, roads: CITY.roads, river: CITY.river },
      camera: { width: DRONE_CAMERA.width, height: DRONE_CAMERA.height },
    };
    const creation = ReplayRecorder.create({ directory: resolve(projectDir, 'artifacts'), sessionId: logId, header,
      onWarning: message => audit('replay-warning', { message }) });
    replayCreation = creation;
    const recording = await creation.catch(error => { audit('replay-warning', { message: String(error) }); return undefined; });
    if (replayCreation === creation) replayCreation = undefined;
    // Stop can arrive while the replay directory opens. Never restart that cancelled match.
    if (activeSessionLog !== logId || stopping || !game.state.running) {
      await recording?.stop(game.state.simTime);
      res.status(409).json({ error: 'Match startup was cancelled.' }); return;
    }
    replay = recording;
    replay?.recordFrame(game.state, true);
    for (const event of game.state.match?.events ?? []) replay?.recordEvent(event);
    delete game.state.runtime.threadId; game.state.runtime.children = []; game.state.runtime.usage = 0;
    setRuntime({ status: 'starting', message: `Verifying Luna / xhigh and creating ${MATCH_DRONE_IDS.length} native drone agents`, model: MODEL, effort: EFFORT });
    const activeRuntime = new TeamSession({ projectDir, game,
      onStatus: status => { if (runtime === activeRuntime) setRuntime(status); },
      onNetwork: state => { if (runtime === activeRuntime) { game.state.network = state; broadcast(); } },
      onEvent: audit,
      onFailure: message => {
        if (runtime !== activeRuntime || stopping) return;
        void stopFleet(message).then(() => { if (!runtime) setRuntime({ status: 'error', message }); });
      },
    });
    runtime = activeRuntime;
    void activeRuntime.start().then(() => { if (runtime === activeRuntime) { starting = false; broadcast(); } }).catch(async error => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Fleet runtime:', message);
      if (runtime !== activeRuntime) return;
      await stopFleet(message);
      setRuntime({ status: 'error', message });
    });
    res.json({ starting: true, model: MODEL, effort: EFFORT });
  } catch (error) { await stopFleet(String(error)); res.status(400).json({ error: String(error) }); }
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
    if (!runtime || game.state.network?.status !== 'online' || stopping) throw new Error('Launch the fleet before changing network links');
    if (!MATCH_DRONE_IDS.includes(req.body.droneId) || typeof req.body.online !== 'boolean') throw new Error('Choose a drone and link state');
    await runtime.link(req.body.droneId, req.body.online);
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
game.capture = async (droneId: DroneId, pose: Pose, simTime: number, drones, match) => {
  const socket = [...sockets.clients].find(client => client.readyState === WebSocket.OPEN);
  if (!socket) throw new Error('Camera browser is disconnected');
  const requestId = randomUUID();
  return new Promise<string>((resolveImage, reject) => {
    const timer = setTimeout(() => { captures.delete(requestId); reject(new Error('Camera capture timed out; check the game browser')); }, 8000);
    captures.set(requestId, { socket, resolve: resolveImage, reject, timer });
    socket.send(JSON.stringify({ type: 'capture', requestId, droneId, pose, simTime, drones, match }));
  });
};
for (const event of ['radio', 'tool', 'observation', 'tool-error', 'transport-error', 'drone-destroyed', 'match-ended']) game.on(event, value => audit(event, value));
game.on('tool', ({ drone, name, args }) => replay?.recordCommand(drone, name, args, game.state.simTime));
game.on('recorded-observation', (sample: RecordedObservation) => replay?.recordObservation(sample));
game.on('match-event', (event: MatchEvent) => { audit('combat', event); replay?.recordEvent(event); });
game.on('transport-error', error => {
  if (!stopping) void stopFleet(error.message).then(() => { if (!runtime) setRuntime({ status: 'error', message: error.message }); });
});
game.on('tool-error', error => {
  if (error.consecutive >= 4 && game.state.running && !stopping) {
    const message = `${error.role} repeatedly failed a game tool. Fleet stopped to prevent repeated inference. ${error.message}`;
    void stopFleet(message).then(() => setRuntime({ status: 'error', message }));
  }
});
game.on('drone-destroyed', ({ droneId }) => { void runtime?.retireDrone(droneId); });
game.on('capabilities-changed', () => { void runtime?.refreshTools(); });
game.on('match-ended', () => { void stopFleet('Match finished. All native actors stopped.'); });
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
