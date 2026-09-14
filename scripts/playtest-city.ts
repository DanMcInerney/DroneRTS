import { chromium, type Page } from '@playwright/test';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const url = 'http://127.0.0.1:4318';
const runName = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const artifactsDir = join(projectDir, 'artifacts', 'playtest-city', runName);
const startupTimeoutMs = 120_000;
const trialTimeoutMs = 150_000;
const missionText = 'Find the treasure chests scattered around the city. Fly close enough to inspect each chest with your camera, then report it to the fleet using a found radio message. Share discoveries and coordinate your search.';
const droneIds = ['drone-1', 'drone-2', 'drone-3'];
const previousRun = 'run-2026-09-14T03-11-15-324Z';
type Drone = { id: string; x: number; y: number; z: number; yaw: number; pitch: number; status: string; online: boolean; observations: number; action?: unknown };
type Radio = { id: string; from: string; to: string; kind: string; text: string; mission: number; simTime: number; protocol?: string; sessionId?: string; sequence?: number; sentAt?: string };
type WorldState = { simTime: number; mission: number; running: boolean; completed: boolean; drones: Drone[]; treasures: Array<{ id: string; found: boolean; foundBy?: string; foundAt?: number }>; radio: Radio[]; runtime: Record<string, any>; network?: { status: string; peers: Array<{ id: string; online: boolean; peers: number; pending: number; inbox: number }> } };
type AuditRecord = { wallTime: string; type: string; value: any };
const result: Record<string, any> = { surface: 'isolated Playwright Chromium (approved fallback)', url, model: 'gpt-5.6-luna', effort: 'xhigh', missionText, screenshots: [], stateSamples: [], checks: {}, console: [], failures: [], startedAt: new Date().toISOString() };

await mkdir(artifactsDir, { recursive: true });
await writeFile(join(artifactsDir, 'state-history.jsonl'), '');
const state = (page: Page) => page.evaluate(async () => await (await fetch('/api/state')).json() as WorldState);
async function waitFor(page: Page, predicate: (value: WorldState) => boolean, timeout: number, label: string) {
  const deadline = Date.now() + timeout; let current = await state(page);
  while (!predicate(current) && Date.now() < deadline) { await page.waitForTimeout(1500); current = await state(page); }
  if (!predicate(current)) throw new Error(`Timed out waiting for ${label}`);
  return current;
}
async function post(path: string) {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error ?? `POST /api/${path} failed (${response.status})`);
  return value;
}
async function capture(page: Page, name: string) { await page.screenshot({ path: join(artifactsDir, name), fullPage: false }); result.screenshots.push(join('artifacts', 'playtest-city', runName, name)); }
async function captureProbe(page: Page, poses: any[]) {
  const ids = droneIds.map((id, index) => `probe-${Date.now()}-${index}-${id}`);
  const sentAt = await page.evaluate(({ poses, ids }) => {
    const socket = (window as any).__fleetSockets?.find((item: WebSocket) => item.readyState === WebSocket.OPEN) as WebSocket | undefined;
    if (!socket) throw new Error('Synthetic capture probe could not find an open fleet WebSocket.');
    const starts = (window as any).__fleetProbeStarts as Record<string, number>;
    ids.forEach(requestId => { starts[requestId] = performance.now(); });
    ids.forEach((requestId, index) => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'capture', requestId, droneId: poses[index].id, pose: poses[index], drones: poses }) })));
    return performance.now();
  }, { poses, ids });
  try { await page.waitForFunction(expected => (window as any).__fleetProbeResults?.filter((item: any) => expected.includes(item.requestId)).length === expected.length, ids, { timeout: 20_000 }); } catch { /* keep the actual partial timing evidence */ }
  const responses = await page.evaluate(expected => (window as any).__fleetProbeResults.filter((item: any) => expected.includes(item.requestId)), ids);
  result.checks.captureProbe = { requests: ids.map((requestId, index) => ({ requestId, drone: droneIds[index] })), responses, sentAtMs: sentAt, responseCount: responses.length, latenciesMs: responses.map((item: any) => ({ requestId: item.requestId, drone: item.droneId, latency: item.receivedAt - item.startedAt })) };
}
async function record(page: Page, label: string) {
  const current = await state(page);
  const sample = { wallTime: new Date().toISOString(), label, simTime: current.simTime, mission: current.mission, running: current.running, completed: current.completed, runtime: current.runtime, network: current.network, drones: current.drones, treasures: current.treasures, radio: current.radio.slice(-20) };
  result.stateSamples.push(sample); await appendFile(join(artifactsDir, 'state-history.jsonl'), JSON.stringify(sample) + '\n'); return current;
}
async function inspectSession(before: string[]) {
  let sessionFile: string | undefined;
  for (let i = 0; i < 12 && !sessionFile; i++) { const files = (await readdir(join(projectDir, 'artifacts'))).filter(file => file.startsWith('session-') && file.endsWith('.jsonl')); sessionFile = files.filter(file => !before.includes(file)).sort().at(-1); if (!sessionFile) await new Promise(resolveWait => setTimeout(resolveWait, 500)); }
  result.checks.sessionFile = sessionFile ? join('artifacts', sessionFile) : null;
  if (!sessionFile) { result.failures.push('No fresh 4318 session audit file found after cleanup.'); return; }
  const raw = await readFile(join(projectDir, 'artifacts', sessionFile), 'utf8');
  const records = raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as AuditRecord);
  const observations = records.filter(r => r.type === 'observation').map(r => r.value as { drone: string; mission?: number; sensors?: any });
  const radio = records.filter(r => r.type === 'radio').map(r => r.value as Radio);
  const tools = records.filter(r => r.type === 'tool').map(r => r.value as { drone?: string; name: string; args?: any });
  const sensorOk = (s: any) => s?.position?.frame === 'local' && ['x', 'y', 'z'].every(axis => typeof s.position[axis] === 'number') && typeof s?.heading?.degrees === 'number' && typeof s?.timestamp?.capturedAt === 'string' && typeof s?.timestamp?.simTime === 'number' && s?.camera?.available === true && s.camera.width === 512 && s.camera.height === 288;
  const sensorByDrone = Object.fromEntries(droneIds.map(id => [id, { observations: observations.filter(o => o.drone === id).length, cameraBundles: observations.filter(o => o.drone === id && sensorOk(o.sensors)).length, radioMessages: radio.filter(m => m.from === id).length }]));
  const foundMessages = radio.filter(m => m.kind === 'found' && /\b(chests?|treasure)\b/i.test(m.text));
  const cameraBeforeFound = foundMessages.map(message => ({ from: message.from, messageId: message.id, simTime: message.simTime, text: message.text, priorCameraObservation: observations.some(o => o.drone === message.from && o.mission === message.mission && sensorOk(o.sensors) && (o.sensors.timestamp.simTime ?? 0) <= message.simTime) }));
  const errors = records.filter(r => ['tool-error', 'runtime-error', 'policy-denied', 'transport-error'].includes(r.type) || (r.type === 'agent' && /error/i.test(String(r.value?.type))));
  result.checks.sessionAudit = { recordCount: records.length, sensorByDrone, foundMessages, cameraBeforeFound, toolCalls: Object.fromEntries(droneIds.map(id => [id, tools.filter(t => t.drone === id).map(t => t.name)])), errors, cameraPayloadsRedacted: raw.includes('[camera image]'), eventTypes: [...new Set(records.filter(r => r.type === 'agent').map(r => r.value?.type).filter(Boolean))] };
  await writeFile(join(artifactsDir, 'audit-summary.json'), JSON.stringify(result.checks.sessionAudit, null, 2) + '\n');
  if (errors.length) result.failures.push(`Session audit contains ${errors.length} runtime/tool error records.`);
}

const beforeSessions = (await readdir(join(projectDir, 'artifacts'))).filter(file => file.startsWith('session-') && file.endsWith('.jsonl'));
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on('console', message => result.console.push({ type: message.type(), text: message.text() }));
page.on('pageerror', error => result.console.push({ type: 'pageerror', text: error.message }));
await page.addInitScript(() => {
  const sockets: WebSocket[] = [];
  const probes: any[] = [];
  const probeStarts: Record<string, number> = {};
  Object.defineProperty(window, '__fleetSockets', { value: sockets });
  Object.defineProperty(window, '__fleetProbeResults', { value: probes });
  Object.defineProperty(window, '__fleetProbeStarts', { value: probeStarts });
  const addEventListener = WebSocket.prototype.addEventListener;
  WebSocket.prototype.addEventListener = function (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) { if (!sockets.includes(this)) sockets.push(this); return addEventListener.call(this, type, listener as EventListenerOrEventListenerObject, options); };
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    try { const message = JSON.parse(String(data)); if (message.type === 'capture-result' && String(message.requestId).startsWith('probe-')) probes.push({ requestId: message.requestId, receivedAt: performance.now(), startedAt: probeStarts[message.requestId], droneId: message.droneId ?? null }); } catch { /* ordinary WebSocket frames */ }
    return send.call(this, data);
  };
});
let initialPositions: Record<string, { x: number; y: number; z: number }> = {};
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Launch fleet' }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByRole('button', { name: 'Reset world' }).click();
  const reset = await waitFor(page, v => !v.running && v.runtime.status === 'idle' && v.mission === 0, 10_000, 'reset world');
  result.checks.reset = { mission: reset.mission, running: reset.running, runtimeStatus: reset.runtime.status };
  await capture(page, 'desktop-idle.png'); await record(page, 'idle-after-reset');
  await page.waitForTimeout(1000);
  const probeState = await state(page);
  await captureProbe(page, probeState.drones.map(drone => ({ id: drone.id, x: drone.x, y: drone.y, z: drone.z, yaw: drone.yaw, pitch: drone.pitch })));
  await page.getByRole('button', { name: 'Launch fleet' }).click();
  const online = await waitFor(page, v => Boolean(v.running && v.runtime.status === 'running' && v.runtime.model === 'gpt-5.6-luna' && v.runtime.effort === 'xhigh' && v.network?.status === 'online' && v.network.peers.length === 3 && v.network.peers.every(peer => peer.online) && v.drones.length === 3 && v.drones.every(drone => drone.online)), startupTimeoutMs, 'three online Luna/xhigh drones and network online');
  result.checks.startup = { runtime: online.runtime, network: online.network, dronesOnline: online.drones.every(drone => drone.online), nativeChildren: online.runtime.children ?? null };
  await capture(page, 'desktop-three-online.png');
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(250); await capture(page, 'mobile390-three-online.png');
  await page.setViewportSize({ width: 1280, height: 720 }); await page.waitForTimeout(250);
  initialPositions = Object.fromEntries(online.drones.map(drone => [drone.id, { x: drone.x, y: drone.y, z: drone.z }]));
  await page.locator('#instruction').fill(missionText); await page.getByRole('button', { name: 'Send instruction' }).click();
  let current = await waitFor(page, v => v.mission === 1 && v.radio.some(message => message.from === 'player' && message.mission === 1 && message.text === missionText), 30_000, 'unchanged default mission forwarding');
  result.checks.mission = { number: current.mission, forwardedUnchanged: true }; await record(page, 'mission-one-forwarded'); await capture(page, 'mission-one-sent.png');
  const trialStart = Date.now(); let lastRecord = 0; let finished = false;
  while (Date.now() - trialStart < trialTimeoutMs) {
    await page.waitForTimeout(2000); current = await state(page);
    if (!current.running) { result.failures.push(`Fleet stopped during bounded trial: ${current.runtime.status} ${current.runtime.message}`); break; }
    if (current.mission !== 1) { result.failures.push(`Mission changed unexpectedly during single-mission trial: ${current.mission}`); break; }
    if (Date.now() - lastRecord >= 10_000) { await record(page, 'mission-one-live'); lastRecord = Date.now(); }
    const unavailableReports = current.radio.filter(message => message.mission === 1 && message.from.startsWith('drone-') && /camera unavailable/i.test(message.text));
    if (unavailableReports.length >= 2) { result.checks.retryStopReason = { reason: 'repeated camera unavailable reports', reports: unavailableReports.map(message => ({ from: message.from, text: message.text, simTime: message.simTime })) }; break; }
    const found = current.treasures.filter(t => t.found);
    const radioSenders = new Set(current.radio.filter(m => m.mission === 1 && m.from.startsWith('drone-')).map(m => m.from));
    const observed = current.drones.every(drone => drone.observations > 0);
    const moved = current.drones.some(drone => { const start = initialPositions[drone.id]; return Math.hypot(drone.x - start.x, drone.y - start.y, drone.z - start.z) > 0.1; });
    if (found.length > 0 && observed && radioSenders.size === 3 && moved) { finished = true; result.checks.trialElapsedMs = Date.now() - trialStart; result.checks.progress = { found, radioSenders: [...radioSenders], allThreeCameraReadings: observed, moved }; await capture(page, 'mission-one-progress.png'); break; }
  }
  current = await record(page, 'bounded-trial-end');
  const displacement = Object.fromEntries(current.drones.map(drone => { const start = initialPositions[drone.id]; return [drone.id, { dx: drone.x - start.x, dy: drone.y - start.y, dz: drone.z - start.z, distance: Math.hypot(drone.x - start.x, drone.y - start.y, drone.z - start.z), observations: drone.observations, status: drone.status }]; }));
  result.checks.movement = displacement; result.checks.finishedConditions = finished; result.checks.finalFound = current.treasures.filter(t => t.found); result.checks.finalRadioSenders = [...new Set(current.radio.filter(m => m.mission === 1 && m.from.startsWith('drone-')).map(m => m.from))];
  if (!finished) result.failures.push('Bounded 150-second trial ended before one found chest, three camera readings/radio senders, and movement were all observed.');
  await capture(page, 'bounded-trial-end.png');
} catch (error) {
  result.failures.push(error instanceof Error ? error.message : String(error));
  try { await record(page, 'failure-state'); } catch (recordError) { result.failures.push(`Could not record failure state: ${recordError instanceof Error ? recordError.message : String(recordError)}`); }
} finally {
  try { await post('stop'); } catch (error) { result.failures.push(`4318 cleanup request failed: ${error instanceof Error ? error.message : String(error)}`); }
  try { const stopped = await waitFor(page, v => !v.running && v.runtime.status === 'stopped', 30_000, '4318 fleet stop'); result.checks.stop = { running: stopped.running, runtimeStatus: stopped.runtime.status, dronesOffline: stopped.drones.every(drone => !drone.online) }; await record(page, 'stopped'); await capture(page, 'stopped.png'); } catch (error) { result.failures.push(`Stop verification failed: ${error instanceof Error ? error.message : String(error)}`); }
  await inspectSession(beforeSessions);
  try { const previous = JSON.parse(await readFile(join(projectDir, 'artifacts', 'playtest-city', previousRun, 'playtest-result.json'), 'utf8')); result.checks.cameraComparison = { previousRun, previous: previous.checks?.sessionAudit?.sensorByDrone ?? null, current: result.checks.sessionAudit?.sensorByDrone ?? null }; } catch (error) { result.failures.push(`Could not load prior camera evidence: ${error instanceof Error ? error.message : String(error)}`); }
  result.checks.browserErrors = result.console.filter((item: { type: string }) => item.type === 'error' || item.type === 'pageerror');
  if (result.checks.browserErrors.length) result.failures.push(`Browser reported ${result.checks.browserErrors.length} console/page errors.`);
  result.finishedAt = new Date().toISOString(); await writeFile(join(artifactsDir, 'playtest-result.json'), JSON.stringify(result, null, 2) + '\n'); await browser.close();
}
console.log(JSON.stringify({ artifact: join(artifactsDir, 'playtest-result.json'), failures: result.failures, checks: result.checks }, null, 2));
if (result.failures.length) process.exitCode = 1;
