/** Deterministic browser + simulator QA. All inference endpoints are blocked. */
import { chromium, type WebSocketRoute } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FleetGame } from '../server/game.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';
import type { ToolResult } from '../shared/types.ts';

const base = 'http://127.0.0.1:4318';
assert.equal((await (await fetch(`${base}/api/state`)).json()).running, false, 'Preserve active match');
const directory = resolve('artifacts/rts-ui'); await mkdir(directory, { recursive: true });
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
  await page.locator('#overview-map').click({ position: { x: 240, y: 130 } });
  await page.locator('.explorer').waitFor({ state: 'visible' });
  await page.keyboard.down('w'); await page.waitForTimeout(180); await page.keyboard.up('w');
  const godObservation = await game.tool('drone-1', 'observe');
  assert.equal(body(godObservation).sensors.camera.available, true);
  await page.keyboard.press('Escape');
  await page.locator('.admin-link').click(); await page.locator('.admin-page').waitFor({ state: 'visible' });
  assert.equal(body(await game.tool('drone-4', 'observe')).sensors.camera.available, true);
  await page.screenshot({ path: resolve(directory, 'admin.png') }); await page.locator('#admin-back').click();
  // A fixed duel verifies the full earning -> purchase -> aim -> shot -> victory path.
  game.state.obstacles = [];
  game.state.drones.forEach((drone, i) => { drone.alive = i === 0 || i === 3; Object.assign(drone, { x: 0, y: 2, z: i === 0 ? 20 : 8, yaw: 0, pitch: 0 }); });
  game.state.match!.resources = [{ id: 'qa-salvage', x: 0, y: 0.45, z: 18, remaining: 80, capacity: 80 }];
  broadcast(); await game.tool('drone-1', 'observe');
  assert.equal(body(await game.tool('drone-1', 'mine', { mission: 1 })).accepted, true);
  for (let i = 0; i < 88; i++) game.tick(0.25);
  const purchase = await game.tool('drone-1', 'buy', { mission: 1, item: 'gun' });
  assert.equal(body(purchase).equipped, 'gun'); broadcast();
  await imageFile('armed-camera.jpg', purchase);
  // At this range gravity drop is small enough for a centre-aim hit; no target argument is supplied.
  assert.equal(body(await game.tool('drone-1', 'fire', { mission: 1 })).fired, true);
  game.tick(0.1); broadcast(); await page.screenshot({ path: resolve(directory, 'projectile.png') });
  for (let i = 0; i < 10 && game.state.running; i++) game.tick(0.1);
  assert.equal(game.state.match!.winner, 'blue'); assert.equal(game.state.running, false); broadcast();
  await page.locator('#match-result').waitFor({ state: 'visible' });
  await page.screenshot({ path: resolve(directory, 'victory.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(directory, 'mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  await page.locator('#reset').click();
  assert.equal(game.state.match!.phase, 'ready'); assert.equal(game.state.drones.filter(d => d.alive).length, 6);
  assert.deepEqual(errors, []);
  const result = { passed: true, inference: false, directory, checks: ['six cameras', 'actual sensor images', 'God view camera isolation', 'Admin camera isolation', 'mine / shared credit / buy / aim / physical shot / victory', 'responsive layout', 'reset'] };
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { game.stop(); await browser.close(); }
