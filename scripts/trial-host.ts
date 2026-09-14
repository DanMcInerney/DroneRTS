/** Test-only host: real renderer, game, team runtime, Zenoh, MAVLink and replay writer. */
import express from 'express';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { FleetGame } from '../server/game.ts';
import { TeamSession } from '../server/team-session.ts';
import { ReplayRecorder } from '../server/replay-recorder.ts';
import { diagnosticsRouter, redactDiagnostic } from '../server/diagnostics.ts';
import { replayRouter } from '../server/replay-store.ts';
import { MATCH_FLEET } from '../shared/fleet.ts';
import { CITY } from '../shared/city.ts';
import { BATTLEFIELD } from '../shared/battlefield.ts';
import { DRONE_CAMERA } from '../shared/camera-profile.ts';
import { arrangeTrial, type TrialScenario } from './trial-scenarios.ts';

export async function createTrialHost(projectDir: string, directory: string, scenario: TrialScenario) {
  const game = new FleetGame(), app = express(), server = createServer(app);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 3_000_000 });
  const sessionId = `session-${scenario}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
  const log = createWriteStream(resolve(directory, sessionId));
  const failures: string[] = [], warnings: string[] = [];
  let runtime: TeamSession | undefined, recorder: ReplayRecorder | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined, disconnect: ReturnType<typeof setTimeout> | undefined;
  let stopPromise: Promise<void> | undefined, starting = false;
  const pending = new Map<string, { socket: WebSocket; resolve: (image: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const audit = (type: string, value: unknown) => log.write(JSON.stringify({ wallTime: new Date().toISOString(), type, value: redactDiagnostic(value) }) + '\n');
  const broadcast = () => {
    recorder?.recordFrame(game.state);
    const packet = JSON.stringify({ type: 'state', state: game.state });
    for (const socket of sockets.clients) if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 2_000_000) socket.send(packet);
  };
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    clearInterval(ticker); clearTimeout(disconnect); game.stop(); recorder?.recordFrame(game.state, true);
    for (const capture of pending.values()) { clearTimeout(capture.timer); capture.reject(new Error('Trial stopped')); }
    pending.clear();
    stopPromise = (async () => {
      await runtime?.stop(); await recorder?.stop(game.state.simTime);
      game.state.runtime.status = 'stopped'; game.state.runtime.message = 'Bounded trial stopped'; broadcast();
    })();
    return stopPromise;
  };
  const fail = (message: string) => { failures.push(message); audit('trial-error', { message }); void stop(); };
  app.use('/api', (req, res, next) => {
    if (req.get('origin') && req.get('origin') !== `http://${req.get('host')}`) { res.status(403).end(); return; }
    if (req.method === 'POST' && !req.is('application/json')) { res.status(415).end(); return; }
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/state', (_req, res) => res.json(game.state));
  app.use('/api/diagnostics', diagnosticsRouter({ directory, roster: MATCH_FLEET, state: () => game.state, activeSession: () => game.state.running ? sessionId : undefined }));
  app.use('/api/diagnostics', replayRouter({ directory }));
  app.post('/api/stop', async (_req, res) => { await stop(); res.json({ stopped: true }); });
  app.post('/api/{*path}', (_req, res) => res.status(409).json({ error: 'This bounded trial is controlled by its script.' }));
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') return;
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws, req));
  });
  sockets.on('connection', socket => {
    clearTimeout(disconnect); game.setConnected(true); broadcast();
    socket.on('message', bytes => {
      try {
        const message = JSON.parse(bytes.toString()), capture = pending.get(message.requestId);
        if (message.type !== 'capture-result' || !capture || capture.socket !== socket) return;
        pending.delete(message.requestId); clearTimeout(capture.timer);
        if (typeof message.image !== 'string' || message.image.length > 2_000_000) capture.reject(new Error('Invalid camera response'));
        else capture.resolve(message.image);
      } catch { /* A malformed response will time out its outstanding capture. */ }
    });
    socket.on('close', () => {
      for (const [id, capture] of pending) if (capture.socket === socket) {
        clearTimeout(capture.timer); capture.reject(new Error('Camera disconnected')); pending.delete(id);
      }
      if (!sockets.clients.size) { game.setConnected(false); if (game.state.running) disconnect = setTimeout(() => fail('Browser disconnected for ten seconds'), 10_000); }
    });
  });
  game.capture = (droneId, pose, simTime, drones, match) => new Promise((resolveImage, reject) => {
    const socket = [...sockets.clients].find(candidate => candidate.readyState === WebSocket.OPEN);
    if (!socket) { reject(new Error('Camera browser is disconnected')); return; }
    const requestId = randomUUID(), timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Camera timed out')); }, 8000);
    pending.set(requestId, { socket, resolve: resolveImage, reject, timer });
    socket.send(JSON.stringify({ type: 'capture', requestId, droneId, pose, simTime, drones, match }));
  });
  for (const event of ['radio', 'tool', 'observation', 'tool-error', 'transport-error', 'drone-destroyed', 'match-ended']) game.on(event, value => audit(event, value));
  game.on('tool', ({ drone, name, args }) => { recorder?.recordFrame(game.state, true); recorder?.recordCommand(drone, name, args, game.state.simTime); });
  game.on('recorded-observation', value => recorder?.recordObservation(value));
  game.on('match-event', event => { audit('combat', event); recorder?.recordFrame(game.state, true); recorder?.recordEvent(event); });
  game.on('drone-destroyed', ({ droneId }) => { void runtime?.retireDrone(droneId); });
  game.on('capabilities-changed', () => { void runtime?.refreshTools(); });
  game.on('match-ended', () => { void stop(); });
  game.on('transport-error', error => fail(error.message));
  game.on('tool-error', error => { if (error.consecutive >= 4) fail(error.message); });
  game.on('change', broadcast);
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ root: projectDir, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  app.use(vite.middlewares);
  try {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(4318, '127.0.0.1', done); });
  } catch (error) { await vite.close(); log.end(); throw error; }
  return {
    game, sessionId, failures, warnings,
    connected: () => sockets.clients.size > 0,
    async start() {
      if (starting || stopPromise) throw new Error('Trial is single-use');
      starting = true; game.start();
      const fixture = arrangeTrial(game, scenario); audit('trial-fixture', fixture);
      recorder = await ReplayRecorder.create({ directory, sessionId, header: {
        type: 'header', protocol: 'fleet-replay/1', startedAt: new Date().toISOString(), sampleInterval: 0.1,
        roster: MATCH_FLEET, scene: { name: `${CITY.name} · ${scenario} trial`, bounds: CITY.bounds,
          focus: BATTLEFIELD.focus, obstacles: game.state.obstacles, roads: CITY.roads, river: CITY.river }, camera: DRONE_CAMERA,
      }, onWarning: message => { warnings.push(message); audit('replay-warning', { message }); } });
      recorder.recordFrame(game.state, true);
      for (const event of game.state.match!.events) recorder.recordEvent(event);
      if (stopPromise) { await recorder.stop(game.state.simTime); throw new Error('Startup cancelled'); }
      runtime = new TeamSession({ projectDir, game,
        onStatus: status => { if (!stopPromise) { Object.assign(game.state.runtime, status); audit('runtime', status); broadcast(); } },
        onNetwork: state => { game.state.network = state; }, onEvent: audit, onFailure: fail,
      });
      let previous = performance.now();
      ticker = setInterval(() => { const now = performance.now(); game.tick((now - previous) / 1000); previous = now; broadcast(); }, 50);
      void runtime.start().catch(error => { if (!stopPromise) fail(String(error)); });
      return fixture;
    },
    stop,
    async close() {
      await stop();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(done => sockets.close(() => done()));
      await vite.close(); server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      await new Promise<void>(done => log.end(done));
    },
  };
}
