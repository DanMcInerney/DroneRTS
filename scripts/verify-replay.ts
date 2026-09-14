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
import type { ReplayFrame, ReplayHeader, ReplayObservation, ReplayRecord } from '../shared/replay.ts';
import type { ToolResult } from '../shared/types.ts';
import { RTS_CONFIG } from '../shared/rts.ts';

const port = Number(process.env.FLEET_QA_PORT ?? 4318);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
const base = `http://127.0.0.1:${port}`;
assert.equal((await (await fetch(`${base}/api/state`)).json()).running, false, 'Preserve active match');
const output = resolve(process.env.FLEET_QA_OUTPUT ?? 'artifacts/replay-ui'), directory = resolve(output, `store-${randomUUID()}`);
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
  Object.assign(drone, { x: i === 0 || i === 3 ? 0 : i * 10, y: 2, z: i === 3 ? 8 : 20, yaw: 0, pitch: 0, charging: false });
});
game.state.match!.resources = [{ id: 'qa-salvage', x: 0, y: 0, z: 18, remaining: 80, capacity: 80, zoneSize: 6 }];
game.state.match!.servicePads = [{ id: 'qa-service', team: 'blue', x: 0, y: 0, z: 20, zoneSize: 6 }];
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
  await page.locator('#replay-scrub').fill(String(Number(time.toFixed(2))));
  await page.locator('#replay-scrub').dispatchEvent('input');
};
try {
  await page.goto(base); await page.locator('#connection-text').getByText('Simulator connected').waitFor();
  assert.equal(body(await game.tool('drone-1', 'observe')).sensors.camera.available, true);
  assert.equal(body(await game.tool('drone-4', 'observe')).sensors.camera.available, true);
  await page.locator('.admin-link').click();
  await page.locator('#replay-workspace').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#replay-actor option').count(), 6);
  const drone = game.state.drones[0], earnedBefore = game.state.match!.teams.blue.earned;
  // Physical cube occupancy drives mining and charging without interaction calls.
  await step(220);
  assert.equal(drone.mining, 'qa-salvage'); assert.ok(game.state.match!.teams.blue.earned > earnedBefore);
  assert.equal(drone.charging, true); assert.equal(drone.servicing, undefined);
  assert.equal(drone.battery, RTS_CONFIG.batteryCapacity, 'The friendly cube supplies power while mining');
  const purchase = await game.tool('drone-1', 'buy', { mission: 1, item: 'gun' });
  assert.equal(body(purchase).equipped, 'gun');
  // A fixture grant adds jammer coverage without claiming this is an economy
  // benchmark. The separate RTS browser fixture verifies earned purchases.
  game.state.match!.teams.blue.credits += RTS_CONFIG.prices.jammer;
  assert.equal(body(await game.tool('drone-1', 'buy', { mission: 1, item: 'jammer' })).equipped, 'jammer');
  assert.equal(body(await game.tool('drone-1', 'jam', { mission: 1, enabled: true })).jamming, true);
  await step(2); const jamTime = game.state.simTime;
  assert.equal(body(await game.tool('drone-1', 'jam', { mission: 1, enabled: false })).jamming, false);
  game.state.match!.teams.blue.credits += RTS_CONFIG.prices.battery;
  const enlarged = body(await game.tool('drone-1', 'buy', { mission: 1, item: 'battery', replace: 'jammer' }));
  assert.equal(enlarged.battery.capacity, RTS_CONFIG.extendedBatteryCapacity);
  assert.equal(drone.battery, RTS_CONFIG.batteryCapacity, 'Installing extra capacity creates no charge');
  // Explicit low-charge/ammo fixture states let replay cover partial charging
  // and rearming without adding an unrelated shot to the combat evidence.
  drone.battery = RTS_CONFIG.batteryCapacity / 5;
  const depletedCharge = drone.battery;
  await step(20); const chargingTime = game.state.simTime;
  assert.equal(drone.charging, true); assert.equal(drone.servicing, undefined);
  assert.ok(drone.battery > depletedCharge && drone.battery < RTS_CONFIG.extendedBatteryCapacity);
  drone.ammo = RTS_CONFIG.magazineSize - 1;
  assert.equal(body(await game.tool('drone-1', 'rearm', { mission: 1 })).accepted, true);
  await step(10); const chargingAndRearmTime = game.state.simTime;
  assert.equal(drone.charging, true); assert.equal(game.state.drones[0].servicing?.kind, 'rearm');
  assert.equal(drone.mining, 'qa-salvage', 'Rearming is independent of occupancy mining and charging');
  assert.equal(body(await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 4, y: 2, z: 20 })).accepted, true);
  for (let i = 0; i < 80 && drone.action; i++) await step(1);
  assert.equal(drone.action, undefined); assert.equal(drone.charging, false); assert.equal(drone.servicing, undefined);
  assert.equal(drone.mining, undefined);
  const retainedCharge = drone.battery;
  await step(5); const outsideTime = game.state.simTime;
  assert.ok(drone.battery > depletedCharge && drone.battery <= retainedCharge && drone.battery > retainedCharge - 1,
    'Leaving the cube retains accumulated charge, apart from normal flight consumption');
  assert.equal(body(await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 0, y: 2, z: 20 })).accepted, true);
  for (let i = 0; i < 80 && drone.action; i++) await step(1);
  assert.equal(drone.action, undefined); assert.equal(drone.charging, true);
  assert.equal(body(await game.tool('drone-1', 'rearm', { mission: 1 })).accepted, true);
  await step(Math.ceil(2 * RTS_CONFIG.rechargeDuration * 10) + 1);
  assert.equal(drone.battery, RTS_CONFIG.extendedBatteryCapacity); assert.equal(drone.servicing, undefined);
  assert.equal(drone.ammo, RTS_CONFIG.magazineSize);
  await game.tool('drone-1', 'act', { mission: 1, kind: 'look', heading: 0, pitch: 0 }); await step(40);
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
  const frames = records.filter((record): record is ReplayFrame => record.type === 'frame');
  const recordedDrone = (time: number) => frames.find(frame => frame.simTime === time)?.drones.find(member => member.id === 'drone-1');
  assert.ok(frames.every(frame => frame.drones.every(member => typeof member.charging === 'boolean')),
    'Modern frames explicitly preserve charging, including false states');
  assert.ok(frames.every(frame => frame.match?.resources.every(node => node.zoneSize === 6 && node.y === 0)
    && frame.match.servicePads?.every(pad => pad.zoneSize === 6 && pad.y === 0)));
  assert.equal(recordedDrone(chargingTime)?.charging, true); assert.equal(recordedDrone(chargingTime)?.servicing, undefined);
  assert.equal(recordedDrone(chargingTime)?.equipment?.battery, true);
  assert.equal(recordedDrone(chargingAndRearmTime)?.charging, true); assert.equal(recordedDrone(chargingAndRearmTime)?.servicing?.kind, 'rearm');
  assert.equal(recordedDrone(outsideTime)?.charging, false); assert.ok(recordedDrone(outsideTime)!.battery! > depletedCharge);
  assert.equal(records.some(record => record.type === 'command' && (record.name === 'mine' || record.name === 'recharge')), false);
  const actual = records.find((record): record is ReplayObservation => record.type === 'observation' && record.drone === 'drone-1' && record.simTime > 21 && record.imageAvailable);
  assert.ok(actual?.imageId);
  const evidence = await fetch(`${api}/api/diagnostics/sessions/${sessionId}/replay/images/${actual.imageId}`);
  const purchaseImage = purchase.content.find(item => item.type === 'image'); assert.ok(purchaseImage?.type === 'image');
  assert.deepEqual(Buffer.from(await evidence.arrayBuffer()), Buffer.from(purchaseImage.data, 'base64'));
  await page.locator('#replay-actor').selectOption('drone-1');
  await page.locator('#replay-extent').selectOption('activity');
  await seek(jamTime);
  assert.match(await page.locator('#replay-drone-state').innerText(), /jammer on/i);
  assert.match(await page.locator('#replay-drone-state').innerText(), /radio jammed/i);
  assert.match(await page.locator('#replay-drone-state').innerText(), /battery/i);
  await page.locator('#admin-replay').screenshot({ path: resolve(output, 'replay-interference.png') });
  await seek(chargingTime);
  assert.match(await page.locator('#replay-drone-state').innerText(), /charging/i);
  assert.ok((await page.locator('#replay-drone-state').innerText()).includes(
    `Battery ${Math.round(recordedDrone(chargingTime)!.battery! / RTS_CONFIG.extendedBatteryCapacity * 100)}%`),
  'Replay uses the recorded modern 600-capacity loadout instead of legacy capacity');
  await page.locator('#admin-replay').screenshot({ path: resolve(output, 'replay-charging.png') });
  await seek(chargingAndRearmTime);
  assert.match(await page.locator('#replay-drone-state').innerText(), /charging/i);
  assert.match(await page.locator('#replay-drone-state').innerText(), /rearming/i);
  await seek(outsideTime);
  assert.doesNotMatch(await page.locator('#replay-drone-state').innerText(), /charging/i);
  await page.locator('#replay-latest').click();
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
    checks: ['live recording append', 'time scrubbing', 'playback', 'event seeking', 'six-actor selection', 'physical shot and impact correlation', 'image bytes match delivered camera', 'automatic cube mining without a mine command', 'recorded explicit cube bounds and charging booleans', '300 / 600 battery capacity', 'automatic partial charging independent of rearming', 'charge retained after leaving the cube', 'recorded interference', 'replay/live sensor isolation', 'missing and legacy evidence', 'responsive layout', 'no browser errors'] };
  await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally {
  game.stop(); await recorder.stop(game.state.simTime); await browser.close();
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
}
