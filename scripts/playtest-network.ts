import { chromium, type Page } from '@playwright/test';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const url = 'http://127.0.0.1:4318';
const runName = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const artifactsDir = join(projectDir, 'artifacts', 'playtest-network', runName);
const startupTimeoutMs = 120_000;
const trialTimeoutMs = 120_000;
const firstInstruction = 'Each drone move 1 unit relative to its current position then report the observed change using the radio before hovering and waiting.';
const secondInstruction = 'Hold position and report current position and timestamp. Acknowledge this new instruction.';
const droneIds = ['drone-1', 'drone-2', 'drone-3'];

type Drone = { id: string; x: number; y: number; z: number; yaw: number; pitch: number; status: string; online: boolean; observations: number; action?: unknown };
type Radio = { id: string; from: string; to: string; kind: string; text: string; mission: number; simTime: number; protocol?: string; sessionId?: string; sequence?: number; sentAt?: string };
type WorldState = { simTime: number; mission: number; running: boolean; completed: boolean; drones: Drone[]; radio: Radio[]; runtime: Record<string, any>; network?: { status: string; transport: string; vehicle: string; message: string; pendingMissions?: number; peers: Array<{ id: string; online: boolean; peers: number; pending: number; inbox: number }> } };
type AuditRecord = { wallTime: string; type: string; value: any };

const result: Record<string, any> = {
  surface: 'isolated Playwright Chromium (approved fallback)',
  url,
  model: 'gpt-5.6-luna',
  effort: 'xhigh',
  firstInstruction,
  secondInstruction,
  startedAt: new Date().toISOString(),
  screenshots: [] as string[],
  stateSamples: [] as any[],
  checks: {} as Record<string, any>,
  console: [] as Array<{ type: string; text: string }>,
  failures: [] as string[],
};

await mkdir(artifactsDir, { recursive: true });
await writeFile(join(artifactsDir, 'state-history.jsonl'), '');

async function state(page: Page): Promise<WorldState> {
  return page.evaluate(async () => await (await fetch('/api/state')).json() as WorldState);
}

async function waitFor(page: Page, predicate: (value: WorldState) => boolean, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  let current = await state(page);
  while (!predicate(current) && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining > 0) await page.waitForTimeout(Math.min(1000, remaining));
    current = await state(page);
  }
  if (!predicate(current)) throw new Error(`Timed out waiting for ${label}`);
  return current;
}

async function api(path: string, body: unknown = {}) {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error ?? `POST /api/${path} failed (${response.status})`);
  return value;
}

async function captureNetwork(page: Page, filename: string) {
  const locator = page.locator('.network-lab');
  await locator.scrollIntoViewIfNeeded();
  await locator.screenshot({ path: join(artifactsDir, filename) });
  result.screenshots.push(join('artifacts', 'playtest-network', runName, filename));
}

async function layoutCheck(page: Page, label: string) {
  const metrics = await page.evaluate(() => {
    const network = document.querySelector<HTMLElement>('.network-lab');
    const peers = Array.from(document.querySelectorAll<HTMLElement>('.network-peer'));
    const viewport = document.documentElement.clientWidth;
    return {
      viewport,
      documentWidth: document.documentElement.scrollWidth,
      noHorizontalOverflow: document.documentElement.scrollWidth <= viewport + 1,
      networkVisible: Boolean(network && network.getBoundingClientRect().width > 0),
      peersFit: peers.every(peer => peer.getBoundingClientRect().right <= viewport + 1),
      networkWidth: network?.getBoundingClientRect().width ?? 0,
      peerWidths: peers.map(peer => peer.getBoundingClientRect().width),
    };
  });
  result.checks.mobile390 ??= {};
  result.checks.mobile390[label] = metrics;
  if (!metrics.noHorizontalOverflow || !metrics.networkVisible || !metrics.peersFit) throw new Error(`390px layout check failed (${label})`);
}

async function record(page: Page, label: string) {
  const current = await state(page);
  const sample = {
    wallTime: new Date().toISOString(), label, simTime: current.simTime, mission: current.mission,
    running: current.running, completed: current.completed, runtime: current.runtime, network: current.network,
    drones: current.drones.map(({ id, x, y, z, yaw, pitch, status, online, observations, action }) => ({ id, x, y, z, yaw, pitch, status, online, observations, action })),
    radio: current.radio.slice(-16),
  };
  result.stateSamples.push(sample);
  await appendFile(join(artifactsDir, 'state-history.jsonl'), JSON.stringify(sample) + '\n');
  return current;
}

function text(value: unknown) { return typeof value === 'string' ? value : JSON.stringify(value ?? ''); }

async function inspectSession(before: string[]) {
  let sessionFile: string | undefined;
  for (let attempt = 0; attempt < 12 && !sessionFile; attempt++) {
    const files = (await readdir(join(projectDir, 'artifacts'))).filter(file => file.startsWith('session-') && file.endsWith('.jsonl'));
    sessionFile = files.filter(file => !before.includes(file)).sort().at(-1);
    if (!sessionFile) await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  result.checks.sessionFile = sessionFile ? join('artifacts', sessionFile) : null;
  if (!sessionFile) { result.failures.push('No fresh 4318 session audit file found after cleanup.'); return; }
  const raw = await readFile(join(projectDir, 'artifacts', sessionFile), 'utf8');
  const records = raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as AuditRecord);
  const network = records.filter(record => record.type === 'network');
  const mavlink = records.filter(record => record.type === 'mavlink');
  const radio = records.filter(record => record.type === 'radio').map(record => record.value as Radio);
  const tools = records.filter(record => record.type === 'tool').map(record => record.value as { drone?: string; role?: string; name: string; args?: Record<string, unknown> });
  const observations = records.filter(record => record.type === 'observation').map(record => record.value as { drone: string; sensors?: any; mission?: number });
  const networkErrors = network.filter(record => ['fatal', 'error'].includes(record.value?.event));
  const mavlinkErrors = mavlink.filter(record => ['fatal', 'error'].includes(record.value?.event));
  const runtimeErrors = records.filter(record => ['tool-error', 'runtime-error', 'policy-denied'].includes(record.type) || (record.type === 'agent' && /error/i.test(text(record.value?.type))));
  const sensorOk = (sensor: any) => Boolean(sensor?.position?.frame === 'local' && ['x', 'y', 'z'].every(axis => typeof sensor.position[axis] === 'number') && typeof sensor?.heading?.degrees === 'number' && typeof sensor?.timestamp?.capturedAt === 'string' && typeof sensor?.timestamp?.simTime === 'number' && sensor?.camera?.available === true && sensor.camera.width === 512 && sensor.camera.height === 288);
  const sensorByDrone = Object.fromEntries(droneIds.map(id => [id, {
    missionOneBundles: observations.filter(item => item.drone === id && item.mission === 1).length,
    missionOneFourFields: observations.filter(item => item.drone === id && item.mission === 1 && sensorOk(item.sensors)).length,
  }]));
  const missionOneActs = tools.filter(item => item.name === 'act' && item.args?.mission === 1);
  const actKindsByDrone = Object.fromEntries(droneIds.map(id => [id, missionOneActs.filter(item => (item.drone ?? item.role) === id).map(item => item.args?.kind)]));
  const m2Ids = new Set(radio.filter(message => message.mission === 2).map(message => message.id));
  const m2Received = network.filter(record => record.value?.event === 'received' && record.value?.message?.mission === 2);
  const receivedByDrone = Object.fromEntries(droneIds.map(id => [id, m2Received.filter(record => record.value.drone === id).map(record => ({ at: record.wallTime, id: record.value.message.id, from: record.value.message.from }))]));
  const receivedBeforeReconnect = Object.fromEntries(droneIds.map(id => [id, result.timeline.reconnectRequestedAt
    ? m2Received.filter(record => record.value.drone === id && record.wallTime < result.timeline.reconnectRequestedAt).length
    : null]));
  const deliveries = network.filter(record => record.value?.event === 'delivery' && m2Ids.has(record.value.id)).map(record => ({ at: record.wallTime, drone: record.value.drone, id: record.value.id, status: record.value.status, recipients: record.value.recipients }));
  const missionTwoMessages = Object.fromEntries(droneIds.map(id => {
    const messages = radio.filter(message => message.mission === 2 && message.from === id);
    const joined = messages.map(message => message.text).join(' ');
    return [id, { count: messages.length, acknowledges: /ack|received|hold|holding|instruction/i.test(joined), reportsPosition: /position|local|x\s*[=:]|y\s*[=:]|z\s*[=:]/i.test(joined), reportsTimestamp: /timestamp|capturedAt|simTime|time/i.test(joined) }];
  }));
  const eventTypes = [...new Set(network.map(record => record.value?.event).filter(Boolean))];
  result.checks.sessionAudit = {
    recordCount: records.length,
    networkEventTypes: eventTypes,
    networkReadyWorkers: network.filter(record => record.value?.event === 'ready').map(record => record.value.drone),
    missionOneZenohReceived: Object.fromEntries(droneIds.map(id => [id, network.filter(record => record.value?.event === 'received' && record.value.drone === id && record.value.message?.mission === 1).length])),
    missionTwoZenohReceived: receivedByDrone,
    missionTwoReceivedBeforeReconnect: receivedBeforeReconnect,
    missionTwoDelivery: deliveries,
    missionTwoRadioByDrone: missionTwoMessages,
    missionOneActKindsByDrone: actKindsByDrone,
    sensorsByDrone: sensorByDrone,
    mavlink: { eventTypes: [...new Set(mavlink.map(record => record.value?.event).filter(Boolean))], wireOperations: mavlink.filter(record => record.value?.event === 'wire').length, ready: mavlink.filter(record => record.value?.event === 'ready').length },
    errors: { network: networkErrors, mavlink: mavlinkErrors, runtime: runtimeErrors },
    cameraPayloadsPresentInAudit: /data:image\/(?:jpeg|png);base64,/.test(raw),
    cameraMetadataObservationCount: (raw.match(/"camera":\{"available":true,"width":512,"height":288\}/g) ?? []).length,
  };
  await writeFile(join(artifactsDir, 'audit-summary.json'), JSON.stringify(result.checks.sessionAudit, null, 2) + '\n');
  if (networkErrors.length || mavlinkErrors.length) result.failures.push('Protocol transport errors occurred; inspect the session audit.');
  if (runtimeErrors.length) result.failures.push(`The zero-error criterion was not met: ${runtimeErrors.length} runtime/tool error records.`);
  if (receivedBeforeReconnect['drone-3']) result.failures.push('Drone 3 received mission-two traffic before the reconnect request.');
}

const beforeSessions = (await readdir(join(projectDir, 'artifacts'))).filter(file => file.startsWith('session-') && file.endsWith('.jsonl'));
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on('console', message => result.console.push({ type: message.type(), text: message.text() }));
page.on('pageerror', error => result.console.push({ type: 'pageerror', text: error.message }));
result.timeline = {};
let trialStart = 0;

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Launch fleet' }).waitFor({ state: 'visible', timeout: 10_000 });
  await record(page, 'idle-before-launch');
  await page.getByRole('button', { name: 'Launch fleet' }).click();
  const online = await waitFor(page, current => Boolean(current.running && current.runtime.status === 'running' && current.network?.status === 'online' && current.network.peers.length === 3 && current.network.peers.every(peer => peer.online) && current.drones.every(drone => drone.online)), startupTimeoutMs, 'three online native drones and network online');
  result.checks.startup = { runtime: online.runtime, network: online.network, dronesOnline: online.drones.every(drone => drone.online), nativeChildren: online.runtime.children ?? null };
  await record(page, 'three-online-network-online');
  await captureNetwork(page, 'desktop-network-active.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await captureNetwork(page, 'mobile390-before.png');
  await layoutCheck(page, 'before');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(250);

  trialStart = Date.now();
  const initial = await state(page);
  const initialPositions = Object.fromEntries(initial.drones.map(drone => [drone.id, { x: drone.x, y: drone.y, z: drone.z }]));
  await page.locator('#instruction').fill(firstInstruction);
  await page.getByRole('button', { name: 'Send instruction' }).click();
  let current = await waitFor(page, value => value.mission === 1 && value.radio.some(message => message.from === 'player' && message.mission === 1), 30_000, 'mission one forwarding');
  result.timeline.missionOneForwardedAt = new Date().toISOString();
  result.checks.missionOne = { mission: current.mission, playerForwarded: true };
  const remainingAfterMissionOne = () => Math.max(1000, trialTimeoutMs - (Date.now() - trialStart));
  current = await waitFor(page, value => value.mission === 1 && value.drones.every(drone => {
    const start = initialPositions[drone.id];
    return drone.observations > 0 && Math.hypot(drone.x - start.x, drone.y - start.y, drone.z - start.z) >= 0.5 && ['Hovering', 'Obstacle — hovering'].includes(drone.status);
  }) && new Set(value.radio.filter(message => message.mission === 1 && message.from.startsWith('drone-')).map(message => message.from)).size === 3, Math.min(65_000, remainingAfterMissionOne()), 'all three mission-one movements, sensor observations and radio reports');
  const movement = Object.fromEntries(current.drones.map(drone => { const start = initialPositions[drone.id]; return [drone.id, { dx: drone.x - start.x, dy: drone.y - start.y, dz: drone.z - start.z, distance: Math.hypot(drone.x - start.x, drone.y - start.y, drone.z - start.z), status: drone.status, observations: drone.observations }]; }));
  result.checks.missionOne = { ...result.checks.missionOne, allThreeObserved: true, radioSenders: [...new Set(current.radio.filter(message => message.mission === 1 && message.from.startsWith('drone-')).map(message => message.from))], movement };
  await record(page, 'mission-one-observed-three-reports');

  const isolateButton = page.locator('#network-link-3');
  await isolateButton.click();
  current = await waitFor(page, value => value.network?.status === 'online' && value.network.peers.find(peer => peer.id === 'drone-3')?.online === false, 10_000, 'drone three isolated');
  result.timeline.isolatedAt = new Date().toISOString();
  result.checks.isolation = { drone3Online: current.network?.peers.find(peer => peer.id === 'drone-3')?.online, pendingMissions: current.network?.pendingMissions ?? null };
  await captureNetwork(page, 'desktop-network-isolated.png');

  await page.locator('#instruction').fill(secondInstruction);
  await page.getByRole('button', { name: 'Send instruction' }).click();
  current = await waitFor(page, value => value.mission === 2 && value.radio.some(message => message.from === 'player' && message.mission === 2), Math.min(25_000, remainingAfterMissionOne()), 'mission two forwarding');
  result.timeline.missionTwoForwardedAt = new Date().toISOString();
  await page.waitForTimeout(Math.min(7_000, Math.max(1000, remainingAfterMissionOne() - 1000)));
  current = await record(page, 'mission-two-isolated-seven-seconds');
  const isolatedMissionTwoSenders = [...new Set(current.radio.filter(message => message.mission === 2 && message.from.startsWith('drone-')).map(message => message.from))];
  result.checks.isolatedMissionTwo = { drone3Online: current.network?.peers.find(peer => peer.id === 'drone-3')?.online, pendingMissions: current.network?.pendingMissions ?? null, radioSenders: isolatedMissionTwoSenders, drone3AckedInUi: isolatedMissionTwoSenders.includes('drone-3') };
  if (isolatedMissionTwoSenders.includes('drone-3')) throw new Error('Drone 3 sent a mission-two radio message while isolated.');
  await captureNetwork(page, 'desktop-network-isolated-mission-two.png');

  result.timeline.reconnectRequestedAt = new Date().toISOString();
  await isolateButton.click();
  current = await waitFor(page, value => value.network?.status === 'online' && value.network.peers.find(peer => peer.id === 'drone-3')?.online === true, Math.min(10_000, remainingAfterMissionOne()), 'drone three reconnect');
  result.timeline.reconnectedAt = new Date().toISOString();
  current = await waitFor(page, value => value.mission === 2 && value.network?.pendingMissions === 0 && new Set(value.radio.filter(message => message.mission === 2 && message.from.startsWith('drone-')).map(message => message.from)).size === 3, Math.min(45_000, remainingAfterMissionOne()), 'all three mission-two acknowledgements and pending drain');
  result.checks.recovery = { drone3Online: current.network?.peers.find(peer => peer.id === 'drone-3')?.online, pendingMissions: current.network?.pendingMissions, radioSenders: [...new Set(current.radio.filter(message => message.mission === 2 && message.from.startsWith('drone-')).map(message => message.from))] };
  await record(page, 'mission-two-recovered-all-three-acks');
  await captureNetwork(page, 'desktop-network-recovered.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await captureNetwork(page, 'mobile390-after.png');
  await layoutCheck(page, 'after');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(250);
  result.checks.trialElapsedMs = Date.now() - trialStart;
} catch (error) {
  result.failures.push(error instanceof Error ? error.message : String(error));
  try { await record(page, 'failure-state'); } catch (recordError) { result.failures.push(`Could not record failure state: ${recordError instanceof Error ? recordError.message : String(recordError)}`); }
} finally {
  try { await api('stop'); } catch (error) { result.failures.push(`4318 cleanup request failed: ${error instanceof Error ? error.message : String(error)}`); }
  try {
    const stopped = await waitFor(page, value => !value.running && value.runtime.status === 'stopped', 30_000, '4318 fleet stop');
    result.checks.stop = { running: stopped.running, runtimeStatus: stopped.runtime.status, dronesOffline: stopped.drones.every(drone => !drone.online) };
    await record(page, 'stopped');
  } catch (error) { result.failures.push(`Stop verification failed: ${error instanceof Error ? error.message : String(error)}`); }
  await inspectSession(beforeSessions);
  result.checks.browserErrors = result.console.filter((item: { type: string }) => item.type === 'error' || item.type === 'pageerror');
  if (result.checks.browserErrors.length) result.failures.push(`Browser reported ${result.checks.browserErrors.length} console/page errors.`);
  result.finishedAt = new Date().toISOString();
  await writeFile(join(artifactsDir, 'playtest-result.json'), JSON.stringify(result, null, 2) + '\n');
  await browser.close();
}

console.log(JSON.stringify({ artifact: join(artifactsDir, 'playtest-result.json'), failures: result.failures, checks: result.checks }, null, 2));
if (result.failures.length) process.exitCode = 1;
