/** Bounded browser/controller verification with no Codex inference or live fleet startup.
 * Serve on FLEET_PORT=4318, then run: node --import tsx scripts/verify-ui.ts
 * Playwright supplies held-key/pointer-lock controls unavailable in sidebar automation.
 */
import { chromium, type WebSocketRoute } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FleetGame } from '../server/game.ts';
import { DRONE_IDS, type Pose } from '../shared/types.ts';

const base = 'http://127.0.0.1:4318';
const state = await fetch(`${base}/api/state`).then(response => response.json());
assert.equal(state.running, false, 'Isolated server must be idle; no player session may be used');
const output = resolve('artifacts/ui-verification'); await mkdir(output, { recursive: true });
const game = new FleetGame(); game.setConnected(true); game.start();
game.state.drones.forEach(drone => { drone.y = 30; });
for (const id of DRONE_IDS) await game.tool(id, 'observe');
game.queueMission('Bounded controller verification'); await game.tool('parent', 'forward_next_instruction');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
page.setDefaultTimeout(15_000);
const history = await fetch(`${base}/api/diagnostics/sessions`).then(response => response.json()) as { sessions: { id: string }[] };
const historicalMavlink = history.sessions.length ? await fetch(`${base}/api/diagnostics/sessions/${encodeURIComponent(history.sessions[0].id)}/events?category=mavlink`).then(response => response.json()) as { events: unknown[] } : { events: [] };
const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
let transport: WebSocketRoute | undefined, timer: ReturnType<typeof setInterval> | undefined;
const captures = new Map<string, (image: string) => void>();
let sequence = 0;
const broadcast = () => transport?.send(JSON.stringify({ type: 'state', state: game.state }));
await page.routeWebSocket('**/ws', socket => {
  transport = socket; broadcast();
  socket.onMessage(data => { const result = JSON.parse(String(data)); if (result.type === 'capture-result') captures.get(result.requestId)?.(result.image); });
});
await page.route('**/api/state', route => route.fulfill({ json: game.state }));
await page.route('**/api/start', route => route.fulfill({ status: 409, json: { error: 'Inference disabled in browser verification' } }));
await page.route('**/api/reset', async route => { game.stop(); game.reset(); broadcast(); await route.fulfill({ json: game.state }); });
game.capture = (droneId: string, pose: Pose, simTime: number, drones) => new Promise((resolveImage, reject) => {
  const requestId = String(++sequence), deadline = setTimeout(() => { captures.delete(requestId); reject(new Error('Capture timed out')); }, 8000);
  captures.set(requestId, image => { clearTimeout(deadline); captures.delete(requestId); resolveImage(image); });
  transport!.send(JSON.stringify({ type: 'capture', requestId, droneId, pose, simTime, drones }));
});
const sleep = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
try {
  await page.goto(base); await page.locator('#connection-text').filter({ hasText: 'Simulator connected' }).waitFor();
  await page.locator('.world-canvas').waitFor();
  await page.screenshot({ path: resolve(output, 'desktop-map.png'), fullPage: true });
  const before = game.state.drones[0].yaw;
  await game.tool('drone-1', 'act', { mission: 1, kind: 'look', heading: 100, pitch: -25 });
  assert.equal(game.state.drones[0].yaw, before);
  await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 64, y: 30, z: 69 });
  timer = setInterval(() => { game.tick(0.05); broadcast(); }, 50);
  await page.locator('#map-downtown').click();
  await sleep(900);
  await page.locator('.overview-panel').screenshot({ path: resolve(output, 'overhead-moving.png') });
  assert.equal(await page.locator('.map-marker').count(), 3);
  assert.equal(await page.locator('.map-lines path').count(), 1, 'Waypoint route is visible');
  clearInterval(timer); timer = undefined;
  const baseline = structuredClone(game.state);
  const fourth = { ...baseline.drones[0], id: 'drone-4' as const, x: baseline.drones[0].x + 20,
    action: { id: 'viewer-only-target', kind: 'fly_to', target: { x: baseline.drones[0].x + 28, y: 30, z: 69 } } };
  const added = { ...baseline, simTime: baseline.simTime + 0.05, drones: [...baseline.drones].reverse().concat(fourth) };
  transport!.send(JSON.stringify({ type: 'state', state: added }));
  await page.locator('.map-marker[data-drone-id="drone-4"]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('.feed-card').count(), 4);
  for (const drone of added.drones) {
    assert.equal(await page.locator(`.feed-card[data-drone-id="${drone.id}"] .coord-x`).innerText(), drone.x.toFixed(1), 'Reordered feeds retain their own identity');
    assert.equal(await page.locator(`.map-fleet-item[data-drone-id="${drone.id}"] .map-fleet-status`).innerText(), `${drone.status} · Y ${drone.y.toFixed(1)}`);
  }
  assert.equal(await page.locator('.map-lines path').count(), 2, 'A fourth unit can display its own destination');
  transport!.send(JSON.stringify({ type: 'state', state: { ...added, drones: added.drones.filter(drone => ['drone-2', 'drone-4'].includes(drone.id)) } }));
  await page.locator('.map-marker[data-drone-id="drone-1"]').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.feed-card').count(), 2);
  const afterRemoval = await game.tool('drone-2', 'observe');
  assert.equal(JSON.parse((afterRemoval.content[0] as { text: string }).text).sensors.camera.available, true, 'Capture must handle snapshot units absent from the newest displayed state');
  assert.equal(await page.locator('.map-marker').count(), 2, 'A capture must not resurrect removed display units');
  broadcast();
  await page.locator('.map-marker[data-drone-id="drone-1"]').waitFor({ state: 'attached' });
  timer = setInterval(() => { game.tick(0.05); broadcast(); }, 50);
  await page.locator('#overview-map').click(); await page.locator('.explorer').waitFor({ state: 'visible' });
  const initial = await page.locator('.explorer-position').innerText();
  await page.keyboard.down('w'); await sleep(400); await page.keyboard.up('w');
  const moved = await page.locator('.explorer-position').innerText(); assert.notEqual(moved, initial);
  await page.keyboard.down('e'); await sleep(250); await page.keyboard.up('e');
  assert.notEqual(await page.locator('.explorer-position').innerText(), moved);
  await page.keyboard.down('ArrowRight'); await sleep(250); await page.keyboard.up('ArrowRight');
  const preMouse = await page.locator('.explorer-position').innerText();
  await page.locator('.explorer-view').click();
  await page.mouse.move(740, 510); await page.mouse.move(850, 490); await sleep(100);
  const mouseLocked = await page.evaluate(() => Boolean(document.pointerLockElement));
  assert.equal(mouseLocked, true); assert.notEqual(await page.locator('.explorer-position').innerText(), preMouse);
  const observation = await game.tool('drone-1', 'observe');
  const body = JSON.parse((observation.content[0] as { text: string }).text);
  assert.equal(body.sensors.camera.available, true, 'Explorer must still supply real drone camera');
  assert.equal(body.sensors.position.y, 30, 'Explorer altitude cannot become a drone sensor');
  await page.screenshot({ path: resolve(output, 'god-view.png') });
  await page.keyboard.press('Escape'); await page.locator('.explorer').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => Boolean(document.pointerLockElement)), false);
  assert.equal(await page.locator('#world-views > .world-canvas').count(), 1);
  await page.getByRole('link', { name: 'Admin', exact: true }).click();
  await page.locator('.admin-page').waitFor({ state: 'visible' });
  await page.locator('#admin-session option').first().waitFor({ state: 'attached' });
  await page.screenshot({ path: resolve(output, 'admin-desktop.png') });
  if (historicalMavlink.events.length) {
    await page.locator('[data-category="mavlink"]').click();
    await page.locator('#admin-timeline .category-mavlink').first().waitFor();
    await page.locator('#admin-timeline summary').first().click();
    assert.ok((await page.locator('#admin-timeline details[open] pre').innerText()).includes('MAVLink2'));
    assert.equal(await page.locator('#admin-follow').getAttribute('aria-pressed'), 'false');
  } else if (!history.sessions.length) {
    await page.getByText('Your next session starts here.').waitFor();
  }
  const adminObservation = await game.tool('drone-2', 'observe');
  assert.equal(JSON.parse((adminObservation.content[0] as { text: string }).text).sensors.camera.available, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(output, 'admin-mobile.png') });
  assert.ok(await page.locator('.admin-page').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await page.locator('#admin-back').click(); await page.locator('.admin-page').waitFor({ state: 'hidden' });
  clearInterval(timer); timer = undefined; game.stop(); broadcast();
  const old = new Set(game.state.treasures.map(t => `${t.x},${t.z}`));
  await page.locator('#reset').click();
  await page.locator('#mission-feedback').filter({ hasText: 'World reset' }).waitFor();
  assert.ok(game.state.treasures.every(t => !old.has(`${t.x},${t.z}`)));
  await page.screenshot({ path: resolve(output, 'game-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('#alert').isVisible(), false, 'No caught renderer or transport errors');
  const result = { passed: true, inference: false, historicalMavlinkChecked: historicalMavlink.events.length > 0, verified: ['controller turn and flight', 'map markers and route', 'reordered/inserted/removed units', 'capture across unit lifecycle changes', 'WASD', 'altitude', 'arrow and captured mouse look', 'Escape', 'drone capture during god view and admin', 'admin navigation', 'mobile layout', 'reset chest relocation'], screenshots: output };
  await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { if (timer) clearInterval(timer); game.stop(); await browser.close(); }
