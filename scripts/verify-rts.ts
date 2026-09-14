/** Deterministic browser + simulator QA. All inference endpoints are blocked. */
import { chromium, type WebSocketRoute } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FleetGame } from '../server/game.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';
import type { ToolResult } from '../shared/types.ts';
import { CARGO_CONFIG, RTS_CONFIG, apronServicePositions } from '../shared/rts.ts';

const port = Number(process.env.FLEET_QA_PORT ?? 4318);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 4317, 'Use an isolated QA port');
const base = `http://127.0.0.1:${port}`;
const preflight: Record<string, unknown> = {};
for (const checked of new Set([4317, 4318, port])) {
  try {
    const state = await (await fetch(`http://127.0.0.1:${checked}/api/state`, { signal: AbortSignal.timeout(2000) })).json();
    preflight[checked] = { running: state.running, simTime: state.simTime };
  } catch (error) {
    if (error instanceof TypeError && (error.cause as NodeJS.ErrnoException)?.code === 'ECONNREFUSED') preflight[checked] = 'unavailable';
    else throw error;
  }
}
assert.equal((await (await fetch(`${base}/api/state`)).json()).running, false, 'Preserve active match');
const directory = resolve(process.env.FLEET_QA_OUTPUT ?? 'artifacts/rts-ui'); await mkdir(directory, { recursive: true });
const body = (result: ToolResult) => JSON.parse((result.content[0] as { text: string }).text);
const game = new FleetGame(); game.setConnected(true); game.start();
game.capture = async () => 'data:image/jpeg;base64,AQID';
for (const id of MATCH_DRONE_IDS) await game.tool(id, 'observe');
await game.forwardTeam('blue'); await game.forwardTeam('red');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
page.setDefaultTimeout(15000);
const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
let socket: WebSocketRoute | undefined;
let sequence = 0;
const captures = new Map<string, (image: string) => void>();
const broadcast = () => socket?.send(JSON.stringify({ type: 'state', state: game.state }));
await page.routeWebSocket('**/ws', route => {
  socket = route; broadcast();
  route.onMessage(data => { const message = JSON.parse(String(data)); if (message.type === 'capture-result') captures.get(message.requestId)?.(message.image); });
});
await page.route('**/api/state', route => route.fulfill({ json: game.state }));
await page.route('**/api/start', route => route.fulfill({ status: 409, json: { error: 'Inference disabled in deterministic QA' } }));
await page.route('**/api/stop', async route => { game.stop(); broadcast(); await route.fulfill({ json: { stopped: true } }); });
await page.route('**/api/reset', async route => { game.reset(); broadcast(); await route.fulfill({ json: game.state }); });
game.capture = (droneId, pose, simTime, drones, match) => new Promise((resolveImage, reject) => {
  const requestId = String(++sequence), timer = setTimeout(() => { captures.delete(requestId); reject(new Error('Camera timeout')); }, 8000);
  captures.set(requestId, image => { clearTimeout(timer); captures.delete(requestId); resolveImage(image); });
  socket!.send(JSON.stringify({ type: 'capture', requestId, droneId, pose, simTime, drones, match }));
});
const imageFile = async (name: string, result: ToolResult) => {
  const image = result.content.find(item => item.type === 'image'); assert.ok(image && image.type === 'image');
  await writeFile(resolve(directory, name), Buffer.from(image.data, 'base64'));
};
try {
  await page.goto(base); await page.locator('#connection-text').getByText('Simulator connected').waitFor();
  assert.equal(await page.locator('.feed-card').count(), 6);
  await page.screenshot({ path: resolve(directory, 'desktop.png'), fullPage: true });
  for (const id of MATCH_DRONE_IDS) {
    const observed = await game.tool(id, 'observe');
    assert.equal(body(observed).sensors.camera.available, true);
    await imageFile(`${id}-initial.jpg`, observed);
  }
  assert.equal(game.state.match!.teams.blue.credits, RTS_CONFIG.startingCredits);
  assert.equal(body(await game.tool('drone-1', 'buy', { mission: 1, item: 'optics' })).equipped, 'optics');
  assert.equal(body(await game.tool('drone-2', 'buy', { mission: 1, item: 'armor' })).rejected, true);
  const wide = await game.tool('drone-1', 'observe');
  const zoom = await game.tool('drone-1', 'camera', { mission: 1, mode: 'zoom' });
  assert.equal(body(zoom).cameraMode, 'zoom');
  assert.notEqual(wide.content.find(item => item.type === 'image')?.data, zoom.content.find(item => item.type === 'image')?.data);
  await imageFile('optics-wide.jpg', wide); await imageFile('optics-zoom.jpg', zoom);
  broadcast();
  const firstCard = page.locator('.feed-card[data-drone="drone-1"]');
  await firstCard.locator('.camera-mode').getByText('ZOOM', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(directory, 'optics.png'), fullPage: true });
  await game.tool('drone-1', 'camera', { mission: 1, mode: 'wide' });
  await page.locator('#overview-map').click({ position: { x: 240, y: 130 } });
  await page.locator('.explorer').waitFor({ state: 'visible' });
  await page.keyboard.down('w'); await page.waitForTimeout(180); await page.keyboard.up('w');
  const godObservation = await game.tool('drone-1', 'observe');
  assert.equal(body(godObservation).sensors.camera.available, true);
  await page.keyboard.press('Escape');
  await page.locator('.admin-link').click(); await page.locator('.admin-page').waitFor({ state: 'visible' });
  assert.equal(body(await game.tool('drone-4', 'observe')).sensors.camera.available, true);
  await page.screenshot({ path: resolve(directory, 'admin.png') }); await page.locator('#admin-back').click();
  // Prescribed open-ground fixture isolates physical services and spectator UI.
  // No actor, resource finder or model inference is used here.
  game.state.obstacles = [];
  game.state.drones.forEach((drone, index) => Object.assign(drone, { x: [-2, 0, 2, 40, 44, 48][index], y: 1.5, z: 20, yaw: 0, pitch: 0 }));
  const resource = { id: 'qa-three-loaders', x: 0, y: 0, z: 20, zoneSize: 6, capacity: 180, remaining: 180 };
  const pad = { id: 'qa-three-deliverers', team: 'blue' as const, x: -12, y: 0, z: 20, zoneSize: 6 };
  game.state.match!.resources = [resource]; game.state.match!.servicePads = [pad];
  game.state.drones.slice(0, 3).forEach((drone, i) => Object.assign(drone, apronServicePositions(resource, 6)[i]));
  const tick = (seconds: number) => { for (let time = 0; time < seconds; time += .05) game.tick(Math.min(.05, seconds - time)); };
  tick(1); broadcast();
  await firstCard.locator('.logistics-label').getByText(/LOADING/).waitFor();
  await page.screenshot({ path: resolve(directory, 'three-loading.png'), fullPage: true });
  tick(CARGO_CONFIG.pickupDuration + .1);
  assert.ok(game.state.drones.slice(0, 3).every(drone => drone.alive && drone.cargo?.amount === 30));
  assert.equal(game.state.match!.teams.blue.earned, 0, 'Pickup does not bank income');
  assert.equal(resource.remaining, 90); broadcast();
  await imageFile('carrying-camera.jpg', await game.tool('drone-1', 'observe'));
  await firstCard.locator('.cargo-label').getByText('CARGO 30 / 30', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(directory, 'three-carrying.png'), fullPage: true });
  game.state.drones.slice(0, 3).forEach((drone, i) => Object.assign(drone, apronServicePositions(pad, 6)[i]));
  tick(.5); broadcast();
  await firstCard.locator('.logistics-label').getByText(/UNLOADING/).waitFor();
  assert.equal(await page.locator('.battery-status, .battery-meter, .charging-status, [data-item="battery"]').count(), 0);
  await page.screenshot({ path: resolve(directory, 'unloading.png'), fullPage: true });
  tick(CARGO_CONFIG.deliveryDuration + .1); broadcast();
  assert.equal(game.state.match!.teams.blue.earned, 90);
  assert.equal(game.state.match!.teams.blue.credits, 90, 'Opening optics spent the original allowance');
  assert.ok(game.state.drones.slice(0, 3).every(drone => drone.cargo?.amount === 0 && drone.battery === undefined));
  await firstCard.locator('.cargo-label').getByText('CARGO 0 / 30', { exact: true }).waitFor();
  assert.equal(body(await game.tool('drone-1', 'buy', { mission: 1, item: 'gun' })).equipped, 'gun');
  assert.equal(body(await game.tool('drone-1', 'buy', { mission: 1, item: 'cargo', replace: 'optics' })).equipped, 'cargo');
  assert.equal((await game.tool('drone-1', 'camera', { mission: 1, mode: 'zoom' })).isError, true);
  assert.equal(body(await game.tool('drone-1', 'buy', { mission: 1, item: 'miner' })).rejected, true);
  broadcast(); await firstCard.locator('.module-count').getByText('2/2 MODULES', { exact: true }).waitFor();
  // Empty a real finite magazine into clear air; rearming reserves then refunds.
  for (let shot = 0; shot < RTS_CONFIG.magazineSize; shot++) {
    assert.equal(body(await game.tool('drone-1', 'fire', { mission: 1 })).fired, true); tick(1);
  }
  assert.equal(game.state.drones[0].ammo, 0);
  assert.equal(body(await game.tool('drone-1', 'fire', { mission: 1 })).rejected, true);
  const credits = game.state.match!.teams.blue.credits;
  assert.equal(body(await game.tool('drone-1', 'rearm', { mission: 1 })).accepted, true);
  await game.tool('drone-1', 'act', { mission: 1, kind: 'hover' });
  assert.equal(game.state.match!.teams.blue.credits, credits);
  assert.equal(body(await game.tool('drone-1', 'rearm', { mission: 1 })).accepted, true);
  tick(4); broadcast(); await firstCard.locator('.service-status').waitFor({ state: 'visible' });
  await page.screenshot({ path: resolve(directory, 'rearming.png'), fullPage: true });
  tick(4.2); broadcast(); assert.equal(game.state.drones[0].ammo, RTS_CONFIG.magazineSize);
  await firstCard.locator('.ammo-status').getByText('12/12 ROUNDS', { exact: true }).waitFor();
  await page.locator('#overview-map').scrollIntoViewIfNeeded();
  await page.locator('.map-resource[data-resource-id="qa-three-loaders"]').waitFor({ state: 'visible' });
  await page.locator('.map-service-pad[data-pad-id="qa-three-deliverers"]').waitFor({ state: 'visible' });
  await page.screenshot({ path: resolve(directory, 'delivered-map.png'), fullPage: true });
  // Blue player conversation uses actual delivered radio state, not model plans.
  game.receivePlayerRadio({ protocol: 'fleet-radio/1', sessionId: game.state.radio[0].sessionId, sequence: 1, sentAt: new Date().toISOString(),
    id: 'qa-reply', from: 'drone-1', to: 'player', kind: 'chat', text: 'Cargo delivered; request received.', simTime: game.state.simTime, mission: 1 });
  broadcast(); await page.locator('#player-chat').getByText('Cargo delivered; request received.').waitFor();
  await firstCard.scrollIntoViewIfNeeded(); await firstCard.locator('.onboard-state > summary').click();
  await page.screenshot({ path: resolve(directory, 'cargo-controller.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(directory, 'mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  game.stop(); broadcast(); await page.locator('#reset').click();
  assert.ok(game.state.drones.every(drone => drone.cargo?.amount === 0 && drone.equipment?.armor && drone.battery === undefined));
  assert.deepEqual(errors, []);
  const result = { passed: true, inference: false, fixture: true, directory, port, preflight,
    checks: ['six actual cameras', 'optics wide/zoom', 'God view and Admin camera isolation', 'simultaneous pickup and carry without bank credit',
      'simultaneous delivery without battery UI', 'delivered income funds modules', 'explicit cargo refit', 'legacy miner rejected',
      'finite gun ammunition', 'cancelled/refunded and completed rearm', 'cargo map and player reply', 'responsive layout', 'fresh reset'] };
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { game.stop(); await browser.close(); }
