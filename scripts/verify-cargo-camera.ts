/** Acquired-camera fixtures only: no actors, simulation tick, or inference endpoints. */
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { FleetGame } from '../server/game.ts';
import type { Pose } from '../shared/types.ts';
import { intersectsBuilding } from '../server/world-geometry.ts';
import { createArtifactRun } from './test-artifacts.ts';

const stage = process.argv[2] ?? 'after';
assert.ok(['baseline', 'after', 'profile'].includes(stage));
const port = Number(process.env.FLEET_QA_PORT ?? 4320);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 4317);
const preflight: Record<string, unknown> = {};
for (const checked of new Set([4317, 4318, port])) {
  try {
    const response = await fetch(`http://127.0.0.1:${checked}/api/state`, { signal: AbortSignal.timeout(2000) });
    const state = await response.json(); preflight[checked] = { running: state.running, simTime: state.simTime };
    assert.notEqual(checked, port, `Preserve existing server on ${port}`);
  } catch (error) {
    if (error instanceof TypeError && (error.cause as NodeJS.ErrnoException)?.code === 'ECONNREFUSED') preflight[checked] = 'unavailable';
    else throw error;
  }
}
const { directory } = createArtifactRun(`cargo-camera-${stage}`, { output: process.env.FLEET_QA_OUTPUT });
await mkdir(directory, { recursive: true });
const game = new FleetGame(), app = express(), server = createServer(app);
const sockets = new WebSocketServer({ server, path: '/ws' });
const pending = new Map<string, { done: (value: string) => void; fail: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
app.get('/api/state', (_req, res) => res.json(game.state));
app.post('/api/{*path}', (_req, res) => res.status(409).json({ error: 'Deterministic camera fixture; inference disabled.' }));
sockets.on('connection', socket => {
  game.setConnected(true); socket.send(JSON.stringify({ type: 'state', state: game.state }));
  socket.on('message', raw => {
    const packet = JSON.parse(raw.toString()), capture = pending.get(packet.requestId);
    if (packet.type !== 'capture-result' || !capture) return;
    pending.delete(packet.requestId); clearTimeout(capture.timer);
    typeof packet.image === 'string' ? capture.done(packet.image) : capture.fail(new Error('Invalid image'));
  });
});
const { createServer: createViteServer } = await import('vite');
const rendererRoot = resolve(process.env.FLEET_QA_RENDERER_ROOT ?? '.');
const vite = await createViteServer({ root: rendererRoot, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
app.use(vite.middlewares);
const sourcePaths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(path => /\.(ts|json|mjs|py|html|css)$/.test(path));
const sourceManifest = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
await writeFile(resolve(directory, 'source-manifest.json'), JSON.stringify(sourceManifest, null, 2));
const capture = async (name: string, pose: Pose, state = game.state, save = true, droneId = 'drone-1') => {
  const socket = [...sockets.clients].find(candidate => candidate.readyState === WebSocket.OPEN); assert.ok(socket);
  const requestId = randomUUID(), start = performance.now();
  const image = await new Promise<string>((done, fail) => {
    const timer = setTimeout(() => { pending.delete(requestId); fail(new Error(`Camera timeout: ${name}`)); }, 15000);
    pending.set(requestId, { done, fail, timer });
    socket.send(JSON.stringify({ type: 'capture', requestId, droneId, pose, simTime: state.simTime, drones: state.drones, match: state.match }));
  });
  assert.match(image, /^data:image\/jpeg;base64,/);
  const milliseconds = performance.now() - start, bytes = Buffer.from(image.split(',')[1], 'base64');
  if (save) await writeFile(resolve(directory, `${name}.jpg`), bytes);
  return { name, pose, milliseconds, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};
const frames: Awaited<ReturnType<typeof capture>>[] = [];
try {
  await new Promise<void>(done => server.listen(port, '127.0.0.1', done));
  console.log(JSON.stringify({ ready: `http://127.0.0.1:${port}`, stage, directory, inference: false }));
  const deadline = Date.now() + 60000;
  while (!sockets.clients.size && Date.now() < deadline) await delay(250);
  assert.ok(sockets.clients.size, 'A camera browser must connect within 60 seconds');
  if (stage !== 'profile') {
  // Explicit frozen poses preserve comparability if resource placement changes.
  const fixtureFile = resolve(directory, '..', 'poses.json');
  let poses: Record<string, Pose>;
  if (stage === 'baseline') {
    poses = {};
    for (const node of game.state.match!.resources) {
      poses[`${node.id}-low`] = { x: node.x, y: 2, z: node.z + 7, yaw: 0, pitch: -15 };
      poses[`${node.id}-oblique`] = { x: node.x, y: 10, z: node.z + 14, yaw: 0, pitch: -35.5 };
      for (const height of [8, 15, 25, 40, 60]) poses[`${node.id}-overhead-${height}`] = { x: node.x, y: height, z: node.z, yaw: 0, pitch: -90 };
    }
    for (const pad of game.state.match!.servicePads ?? []) {
      poses[`${pad.id}-low`] = { x: pad.x, y: 3, z: pad.z + 8, yaw: 0, pitch: -20 };
      poses[`${pad.id}-overhead`] = { x: pad.x, y: 14, z: pad.z, yaw: 0, pitch: -90 };
    }
    for (const drone of game.state.drones) poses[`${drone.id}-initial`] = { x: drone.x, y: drone.y, z: drone.z, yaw: drone.yaw, pitch: drone.pitch };
    await writeFile(fixtureFile, JSON.stringify(poses, null, 2));
  } else poses = JSON.parse(await readFile(fixtureFile, 'utf8'));
  for (const [name, pose] of Object.entries(poses)) frames.push(await capture(name, pose, game.state, true, /^drone-[1-6]-initial$/.test(name) ? name.slice(0, 7) : 'drone-1'));
  const central = game.state.match!.resources.find(node => node.id === 'salvage-fountain')!;
  const currentPose: Pose = { x: central.x, y: 12, z: central.z + 12, yaw: 0, pitch: -45 };
  for (const amount of [central.capacity, 30, 0]) {
    const state = structuredClone(game.state); state.match!.resources.find(node => node.id === central.id)!.remaining = amount;
    frames.push(await capture(`current-central-stock-${amount}`, currentPose, state));
  }
  // Current-geometry positive approaches complement the identical-pose negatives
  // above. These additional fixtures have no pre-change comparison claim.
  if (stage === 'after') {
    for (const height of [8, 15, 25, 40, 60]) frames.push(await capture(`current-central-overhead-${height}`,
      { x: central.x, y: height, z: central.z, yaw: 0, pitch: -90 }));
    for (const node of game.state.match!.resources) {
      const approaches = Array.from({ length: 48 }, (_, i) => {
        const angle = i * Math.PI / 24;
        const pose = { x: node.x + Math.sin(angle) * 6, y: 2, z: node.z + Math.cos(angle) * 6,
          yaw: angle * 180 / Math.PI, pitch: -15 };
        return pose;
      }).filter(pose => !game.state.obstacles.some(building => intersectsBuilding(pose, { ...node, y: .3 }, building, 0)));
      assert.ok(approaches.length, `Current depot ${node.id} has a visible low approach`);
      for (const [index, pose] of [approaches[0], approaches[Math.floor(approaches.length / 2)]].entries()) {
        frames.push(await capture(`${node.id}-clear-approach-${index}`, pose));
        if (node.id === central.id) for (const amount of [30, 0]) {
          const state = structuredClone(game.state); state.match!.resources.find(item => item.id === node.id)!.remaining = amount;
          frames.push(await capture(`central-clear-${index}-stock-${amount}`, pose, state));
        }
      }
      // Find an actual unobstructed camera pose whose view of every tested
      // corner/center of this depot is blocked by authoritative buildings.
      const size = node.zoneSize ?? 6;
      const samples = [-.5, 0, .5].flatMap(x => [-.5, 0, .5].flatMap(z => [.05, .21].map(y =>
        ({ x: node.x + x * size, y: node.y + y, z: node.z + z * size }))));
      const negative = [8, 12, 18, 24].flatMap(radius => Array.from({ length: 48 }, (_, i) => {
        const angle = i * Math.PI / 24;
        return { x: node.x + Math.sin(angle) * radius, y: 2, z: node.z + Math.cos(angle) * radius,
          yaw: angle * 180 / Math.PI, pitch: Math.atan2(.12 - 2, radius) * 180 / Math.PI };
      })).find(pose => !game.state.obstacles.some(building => intersectsBuilding(pose, pose, building, .38))
        && samples.every(sample => game.state.obstacles.some(building => intersectsBuilding(pose, sample, building, 0))));
      assert.ok(negative, `Occluded negative exists for ${node.id}`);
      const stocked = await capture(`${node.id}-behind-building-stock`, negative);
      const empty = structuredClone(game.state); empty.match!.resources.find(item => item.id === node.id)!.remaining = 0;
      const hiddenEmpty = await capture(`${node.id}-behind-building-empty`, negative, empty);
      assert.equal(stocked.sha256, hiddenEmpty.sha256, 'Hidden stock cannot draw through buildings');
      frames.push(stocked, hiddenEmpty);
    }
    const identity = structuredClone(game.state), pad = identity.match!.servicePads![0];
    identity.drones.forEach(drone => { drone.cargo = { amount: 0 }; });
    Object.assign(identity.drones[1], { x: pad.x - 1, y: 1.5, z: pad.z, yaw: 0, cargo: { amount: 30 } });
    Object.assign(identity.drones[3], { x: pad.x + 1, y: 1.5, z: pad.z, yaw: 0, cargo: { amount: 30 } });
    frames.push(await capture('cargo-and-team-identity-oblique', { x: pad.x, y: 3, z: pad.z + 4, yaw: 0, pitch: -20 }, identity));
    frames.push(await capture('cargo-and-team-identity-overhead', { x: pad.x, y: 7, z: pad.z, yaw: 0, pitch: -90 }, identity));
    for (const drone of identity.drones) drone.cargo = { amount: 0 };
    frames.push(await capture('delivered-empty-grips-oblique', { x: pad.x, y: 3, z: pad.z + 4, yaw: 0, pitch: -20 }, identity));
  }
  }
  if (stage === 'profile') for (const drone of game.state.drones) frames.push(await capture(`${drone.id}-initial`, drone, game.state, true, drone.id));
  const batches: number[] = [];
  // Acquire six independent drone camera frames per batch; end-to-end host timing
  // includes WebSocket, render, readback, JPEG encoding and delivery (not FPS).
  for (let i = 0; i < 8; i++) {
    const start = performance.now();
    await Promise.all(game.state.drones.map(drone => capture(`perf-${i}-${drone.id}`, drone, game.state, false, drone.id)));
    batches.push(performance.now() - start);
  }
  const sorted = [...batches].sort((a, b) => a - b);
  const result = { passed: true, inference: false, stage, rendererRoot, observerIdentity: 'requested drone', preflight, frames, sixCameraBatchesMs: batches,
    medianSixCameraBatchMs: sorted[Math.floor(sorted.length / 2)], p95SixCameraBatchMs: sorted[Math.ceil(sorted.length * .95) - 1],
    limitations: 'Developer fixture poses and image review; this does not establish autonomous perception, navigation, service or teamwork. End-to-end capture latency is not renderer FPS.' };
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: true, directory, frames: frames.length, medianSixCameraBatchMs: result.medianSixCameraBatchMs }));
} finally {
  for (const capture of pending.values()) { clearTimeout(capture.timer); capture.fail(new Error('Fixture stopped')); }
  for (const socket of sockets.clients) socket.terminate();
  await new Promise<void>(done => sockets.close(() => done()));
  await vite.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
}
