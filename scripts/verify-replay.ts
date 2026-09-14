/** Real renderer + local replay HTTP APIs, deterministic simulator, no model inference. */
import { chromium, type WebSocketRoute } from '@playwright/test';
import express from 'express';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { FleetGame } from '../server/game.ts';
import { ReplayRecorder } from '../server/replay-recorder.ts';
import { replayRouter, ReplayStore } from '../server/replay-store.ts';
import { diagnosticsRouter } from '../server/diagnostics.ts';
import { MATCH_DRONE_IDS, MATCH_FLEET } from '../shared/fleet.ts';
import { CITY } from '../shared/city.ts';
import { BATTLEFIELD } from '../shared/battlefield.ts';
import { DRONE_CAMERA } from '../shared/camera-profile.ts';
import type { ReplayHeader, ReplayObservation, ReplayRecord } from '../shared/replay.ts';
import type { ToolResult } from '../shared/types.ts';

const base = 'http://127.0.0.1:4318';
assert.equal((await (await fetch(`${base}/api/state`)).json()).running, false, 'Preserve active match');
const output = resolve('artifacts/replay-ui'), directory = resolve(output, `store-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const sessionId = 'session-replay-qa.jsonl', legacyId = 'session-legacy-qa.jsonl';
await writeFile(resolve(directory, sessionId), JSON.stringify({ type: 'system', value: { message: 'Deterministic replay fixture; no inference.' } }) + '\n');
await writeFile(resolve(directory, legacyId), '{}\n');
const game = new FleetGame(); game.setConnected(true); game.start();
game.capture = async () => 'data:image/jpeg;base64,AQID';
for (const id of MATCH_DRONE_IDS) await game.tool(id, 'observe');
await game.forwardTeam('blue'); await game.forwardTeam('red');
game.state.obstacles = [];
game.state.drones.forEach((drone, i) => {
  drone.alive = i === 0 || i === 3;
  Object.assign(drone, { x: i === 0 || i === 3 ? 0 : i * 10, y: 2, z: i === 3 ? 8 : 20, yaw: 0, pitch: 0 });
});
game.state.match!.resources = [{ id: 'qa-salvage', x: 0, y: 0.45, z: 18, remaining: 80, capacity: 80 }];
const header: ReplayHeader = {
  type: 'header', protocol: 'fleet-replay/1', startedAt: new Date().toISOString(), sampleInterval: 0.1,
  roster: MATCH_FLEET, scene: { name: CITY.name, bounds: CITY.bounds, focus: BATTLEFIELD.focus,
    obstacles: [], roads: CITY.roads, river: CITY.river }, camera: DRONE_CAMERA,
};
const warnings: string[] = [];
const recorder = await ReplayRecorder.create({ directory, sessionId, header, onWarning: message => warnings.push(message) });
recorder.recordFrame(game.state, true);
game.on('tool', ({ drone, name, args }) => recorder.recordCommand(drone, name, args, game.state.simTime));
game.on('recorded-observation', sample => recorder.recordObservation(sample));
game.on('match-event', event => recorder.recordEvent(event));
const app = express();
app.use('/api/diagnostics', diagnosticsRouter({ directory, roster: MATCH_FLEET, state: () => game.state, activeSession: () => game.state.running ? sessionId : undefined }));
app.use('/api/diagnostics', replayRouter({ directory }));
const server = createServer(app);
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const api = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.setDefaultTimeout(15000);
const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
let socket: WebSocketRoute | undefined, sequence = 0;
const pending = new Map<string, (image: string) => void>();
const broadcast = () => socket?.send(JSON.stringify({ type: 'state', state: game.state }));
await page.routeWebSocket('**/ws', route => {
  socket = route; broadcast();
  route.onMessage(data => { const message = JSON.parse(String(data)); if (message.type === 'capture-result') pending.get(message.requestId)?.(message.image); });
});
await page.route('**/api/state', route => route.fulfill({ json: game.state }));
await page.route('**/api/start', route => route.fulfill({ status: 409, json: { error: 'Inference disabled in deterministic QA' } }));
await page.route('**/api/diagnostics/**', async route => {
  const url = new URL(route.request().url()), response = await fetch(api + url.pathname + url.search);
  await route.fulfill({ status: response.status, contentType: response.headers.get('content-type') ?? 'application/json', body: Buffer.from(await response.arrayBuffer()) });
});
game.capture = (droneId, pose, simTime, drones, match) => new Promise((resolveImage, reject) => {
  const requestId = String(++sequence), timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Camera timeout')); }, 8000);
  pending.set(requestId, image => { clearTimeout(timer); pending.delete(requestId); resolveImage(image); });
  socket!.send(JSON.stringify({ type: 'capture', requestId, droneId, pose, simTime, drones, match }));
});
const body = (result: ToolResult) => JSON.parse((result.content[0] as { text: string }).text);
const step = async (count: number) => {
  for (let i = 0; i < count && game.state.running; i++) { game.tick(0.1); recorder.recordFrame(game.state); if (i % 10 === 0) await delay(5); }
  broadcast();
};
const seek = async (time: number) => {
  await page.locator('#replay-scrub').fill(String(time));
  await page.locator('#replay-scrub').dispatchEvent('input');
};
try {
  await page.goto(base); await page.locator('#connection-text').getByText('Simulator connected').waitFor();
  assert.equal(body(await game.tool('drone-1', 'observe')).sensors.camera.available, true);
  assert.equal(body(await game.tool('drone-4', 'observe')).sensors.camera.available, true);
  await page.locator('.admin-link').click();
  await page.locator('#replay-workspace').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#replay-actor option').count(), 6);
  assert.equal(body(await game.tool('drone-1', 'mine', { mission: 1 })).accepted, true);
  await step(220);
  const purchase = await game.tool('drone-1', 'buy', { mission: 1, item: 'gun' });
  assert.equal(body(purchase).equipped, 'gun');
  await page.waitForFunction(() => Number((document.querySelector('#replay-scrub') as HTMLInputElement).max) >= 21);
  // Seeking a historical frame cannot change the pixels used for a current live observation.
  await seek(0);
  const liveObservation = await game.tool('drone-1', 'observe');
  assert.equal(body(liveObservation).sensors.timestamp.simTime, game.state.simTime);
  assert.equal(body(liveObservation).sensors.camera.available, true);
  assert.equal(await page.locator('#replay-scrub').inputValue(), '0');
  assert.match(await page.locator('#replay-drone-state').innerText(), /none recorded/);
  assert.equal(body(await game.tool('drone-1', 'fire', { mission: 1 })).fired, true);
  await step(10); assert.equal(game.state.match!.winner, 'blue');
  recorder.recordFrame(game.state, true); await recorder.stop(game.state.simTime);
  // Closing and reopening refreshes a completed session through the same real HTTP reader.
  await page.locator('#admin-back').click(); await page.locator('.admin-link').click();
  await page.getByText('Recording complete.', { exact: false }).waitFor();
  await page.locator('#replay-latest').click();
  assert.match(await page.locator('#replay-metrics').innerText(), /1 \/ 1/);
  await page.locator('#replay-actor').selectOption('drone-4');
  assert.match(await page.locator('#replay-drone-state').innerText(), /DESTROYED/);
  await page.locator('#replay-camera').waitFor({ state: 'visible' });
  await page.waitForFunction(() => (document.querySelector('#replay-camera') as HTMLImageElement).naturalWidth > 0);
  const records: ReplayRecord[] = [], store = new ReplayStore(directory); let cursor = 0;
  for (;;) { const part = await store.page(sessionId, cursor); records.push(...part.records); cursor = part.next; if (!part.hasMore) break; }
  const actual = records.find((record): record is ReplayObservation => record.type === 'observation' && record.drone === 'drone-1' && record.simTime > 21 && record.imageAvailable);
  assert.ok(actual?.imageId);
  const evidence = await fetch(`${api}/api/diagnostics/sessions/${sessionId}/replay/images/${actual.imageId}`);
  const purchaseImage = purchase.content.find(item => item.type === 'image'); assert.ok(purchaseImage?.type === 'image');
  assert.deepEqual(Buffer.from(await evidence.arrayBuffer()), Buffer.from(purchaseImage.data, 'base64'));
  await page.locator('#replay-actor').selectOption('drone-1');
  await page.locator('#replay-extent').selectOption('activity');
  await page.locator('#admin-replay').screenshot({ path: resolve(output, 'replay-desktop.png') });
  await page.locator('.replay-event[data-event-type="fired"]').click();
  assert.ok(Number(await page.locator('#replay-scrub').inputValue()) > 21);
  await seek(0); await page.locator('#replay-speed').selectOption('8'); await page.locator('#replay-play').click();
  await page.waitForFunction(() => Number((document.querySelector('#replay-scrub') as HTMLInputElement).value) > 1);
  await page.locator('#replay-play').click();
  await page.locator('#replay-actor').selectOption('drone-3');
  assert.equal(await page.locator('#replay-camera').isVisible(), false);
  assert.match(await page.locator('#replay-camera-empty').innerText(), /No camera observation/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#admin-replay').evaluate(el => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: resolve(output, 'replay-mobile.png') });
  await page.locator('.replay-transport').evaluate(el => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: resolve(output, 'replay-mobile-controls.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  await page.locator('#admin-session').selectOption(legacyId);
  await page.locator('#replay-status').getByText('Replay is unavailable', { exact: false }).waitFor();
  assert.equal(await page.locator('#replay-workspace').isVisible(), false);
  assert.deepEqual(warnings, []); assert.deepEqual(errors, []);
  const result = { passed: true, inference: false, records: records.length, directory,
    checks: ['live recording append', 'time scrubbing', 'playback', 'event seeking', 'six-actor selection', 'physical shot and impact correlation', 'image bytes match delivered camera', 'replay/live sensor isolation', 'missing and legacy evidence', 'responsive layout', 'no browser errors'] };
  await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally {
  game.stop(); await recorder.stop(game.state.simTime); await browser.close();
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
}
