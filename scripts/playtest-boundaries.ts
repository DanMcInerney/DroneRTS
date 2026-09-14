import { chromium, type Page } from '@playwright/test';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runName = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const artifactsDir = join(projectDir, 'artifacts', 'playtest-boundaries', runName);
const url = 'http://127.0.0.1:4318';
const firstInstruction = 'Each drone must report its own four sensors: local position XYZ, heading in degrees, timestamp with capturedAt and simTime, and the camera image, including one visible feature from that image. Make exactly one small controlled movement experiment based on your current readings, share the observed change with your peers using the radio, then hover and wait.';
const secondInstruction = 'Hold position now. Each drone acknowledge this instruction and report your current position and timestamp.';
const startupTimeoutMs = 120_000;
const trialBudgetMs = 105_000;

type DroneState = { id: string; x: number; y: number; z: number; yaw: number; pitch: number; status: string; online: boolean; observations: number; action?: { id: string; kind: string; target?: { x: number; y: number; z: number } } };
type RadioMessage = { protocol?: string; sessionId?: string; sequence?: number; sentAt?: string; id?: string; from: string; to: string; kind: string; text: string; mission: number; simTime: number };
type WorldState = { simTime: number; mission: number; running: boolean; completed: boolean; drones: DroneState[]; radio: RadioMessage[]; runtime: Record<string, any> };
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

async function waitFor(page: Page, predicate: (current: WorldState) => boolean, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  let current = await state(page);
  while (!predicate(current) && Date.now() < deadline) {
    await page.waitForTimeout(1500);
    current = await state(page);
  }
  if (!predicate(current)) throw new Error(`Timed out waiting for ${label}`);
  return current;
}

async function capture(page: Page, filename: string) {
  await page.screenshot({ path: join(artifactsDir, filename), fullPage: false });
  result.screenshots.push(`artifacts/playtest-boundaries/${runName}/${filename}`);
}

async function record(page: Page, label: string) {
  const current = await state(page);
  const sample = {
    wallTime: new Date().toISOString(),
    label,
    simTime: current.simTime,
    mission: current.mission,
    running: current.running,
    completed: current.completed,
    runtime: current.runtime,
    drones: current.drones.map(({ id, x, y, z, yaw, pitch, status, online, observations, action }) => ({ id, x, y, z, yaw, pitch, status, online, observations, action })),
    radioCount: current.radio.length,
    radio: current.radio.slice(-12),
  };
  result.stateSamples.push(sample);
  await appendFile(join(artifactsDir, 'state-history.jsonl'), JSON.stringify(sample) + '\n');
  return current;
}

async function postStop() {
  try {
    await fetch(`${url}/api/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  } catch (error) {
    result.failures.push(`4318 cleanup request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function findNewSession(before: string[]) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const files = (await readdir(join(projectDir, 'artifacts'))).filter(file => file.startsWith('session-') && file.endsWith('.jsonl'));
    const fresh = files.filter(file => !before.includes(file));
    if (fresh.length) return fresh.sort().at(-1);
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  return undefined;
}

function text(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

async function inspectSession(before: string[]) {
  const sessionFile = await findNewSession(before);
  result.checks.sessionFile = sessionFile ? `artifacts/${sessionFile}` : null;
  if (!sessionFile) {
    result.failures.push('No new 4318 session audit file was found after cleanup.');
    return;
  }
  const sessionPath = join(projectDir, 'artifacts', sessionFile);
  const raw = await readFile(sessionPath, 'utf8');
  const records = raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as AuditRecord);
  const tools = records.filter(record => record.type === 'tool').map(record => record.value as { drone: string; name: string; args?: Record<string, unknown> });
  const observations = records.filter(record => record.type === 'observation').map(record => record.value as { drone: string; sensors?: any; mission?: number; deliveredCursor?: number; eventCount?: number });
  const errors = records.filter(record => record.type === 'tool-error' || record.type === 'runtime-error' || record.type === 'policy-denied' || (record.type === 'agent' && /error/i.test(text(record.value?.type)))).map(record => ({ type: record.type, value: record.value }));
  const radio = records.filter(record => record.type === 'radio').map(record => record.value as RadioMessage);
  const nativeCalls = records.filter(record => record.type === 'agent' && record.value?.type === 'native-agent-call').map(record => record.value);
  const eventTypes = [...new Set(records.filter(record => record.type === 'agent').map(record => record.value?.type).filter(Boolean))];

  // Game emits one tool record immediately before each observation. Pair per drone
  // so the audit can show which response types carried the sensor bundle.
  const pending = new Map<string, string[]>();
  const pairs: Array<{ drone: string; tool: string; sensors: any }> = [];
  for (const record of records) {
    if (record.type === 'tool') {
      const value = record.value as { drone: string; name: string };
      const queue = pending.get(value.drone) ?? [];
      queue.push(value.name);
      pending.set(value.drone, queue);
    } else if (record.type === 'observation') {
      const value = record.value as { drone: string; sensors?: any };
      const queue = pending.get(value.drone) ?? [];
      pairs.push({ drone: value.drone, tool: queue.shift() ?? 'unmatched', sensors: value.sensors });
      pending.set(value.drone, queue);
    }
  }
  const sensorByTool = Object.fromEntries(['observe', 'act', 'send', 'wait'].map(tool => {
    const matching = pairs.filter(pair => pair.tool === tool);
    return [tool, {
      responses: matching.length,
      withPosition: matching.filter(pair => pair.sensors?.position?.frame === 'local' && ['x', 'y', 'z'].every(axis => typeof pair.sensors.position[axis] === 'number')).length,
      withHeading: matching.filter(pair => typeof pair.sensors?.heading?.degrees === 'number').length,
      withTimestamp: matching.filter(pair => typeof pair.sensors?.timestamp?.capturedAt === 'string' && typeof pair.sensors.timestamp.simTime === 'number').length,
      withCameraImage: matching.filter(pair => pair.sensors?.camera?.available === true && pair.sensors.camera.width === 512 && pair.sensors.camera.height === 288).length,
      cameraUnavailable: matching.filter(pair => pair.sensors?.camera?.available === false).length,
    }];
  }));
  const firstMissionActs = tools.filter(tool => tool.name === 'act' && tool.args?.mission === 1);
  const firstMissionFlyToByDrone = Object.fromEntries(['drone-1', 'drone-2', 'drone-3'].map(drone => [drone, firstMissionActs.filter(tool => tool.drone === drone && tool.args?.kind === 'fly_to').length]));
  const firstMissionPeerMessages = radio.filter(message => message.mission === 1 && message.from.startsWith('drone-'));
  const secondMissionMessages = radio.filter(message => message.mission === 2 && message.from.startsWith('drone-'));
  const secondByDrone = Object.fromEntries(['drone-1', 'drone-2', 'drone-3'].map(drone => {
    const messages = secondMissionMessages.filter(message => message.from === drone);
    const joined = messages.map(message => message.text).join(' ');
    return [drone, {
      messages: messages.length,
      texts: messages.map(message => message.text),
      acknowledges: /ack|received|hold|holding|instruction/i.test(joined),
      reportsPosition: /position|local|x\s*[=:]|y\s*[=:]|z\s*[=:]/i.test(joined),
      reportsTimestamp: /timestamp|capturedAt|simTime|time/i.test(joined),
    }];
  }));
  const radioSessionIds = [...new Set(radio.map(message => message.sessionId).filter(Boolean))];
  const radioSequences = radio.map(message => message.sequence).filter((sequence): sequence is number => typeof sequence === 'number');
  const sequenceMonotonic = radioSequences.every((sequence, index) => index === 0 || sequence > radioSequences[index - 1]);
  const auditHasOmniscientEvent = records.some(record => /mission_complete/i.test(text(record.value)));
  const toolNames = Object.fromEntries(['observe', 'act', 'send', 'wait'].map(name => [name, tools.filter(tool => tool.name === name).length]));
  const afterArgs = tools.filter(tool => tool.name === 'wait').map(tool => tool.args && Object.prototype.hasOwnProperty.call(tool.args, 'after'));

  result.checks.sessionAudit = {
    recordCount: records.length,
    eventTypes,
    nativeCalls: nativeCalls.map(call => ({ tool: call.tool, status: call.status, model: call.model, effort: call.effort, children: call.children })),
    toolCalls: toolNames,
    waitAfterArguments: { calls: afterArgs.length, supplied: afterArgs.filter(Boolean).length },
    sensorBundlesByTool: sensorByTool,
    firstMissionFlyToByDrone,
    firstMissionPeerMessages: firstMissionPeerMessages.map(message => ({ from: message.from, text: message.text, sequence: message.sequence, sentAt: message.sentAt })),
    secondMissionByDrone: secondByDrone,
    radio: { count: radio.length, protocols: [...new Set(radio.map(message => message.protocol))], sessionIds: radioSessionIds, sequenceMonotonic, sentAtParseable: radio.every(message => typeof message.sentAt === 'string' && !Number.isNaN(Date.parse(message.sentAt))) },
    unmatchedObservationCount: pairs.filter(pair => pair.tool === 'unmatched').length,
    pendingToolCount: [...pending.values()].reduce((count, queue) => count + queue.length, 0),
    toolErrors: errors,
    auditHasOmniscientMissionCompleteEvent: auditHasOmniscientEvent,
    cameraPayloadsRedactedInAudit: raw.includes('[camera image]'),
  };
}

const beforeSessions = (await readdir(join(projectDir, 'artifacts'))).filter(file => file.startsWith('session-') && file.endsWith('.jsonl'));
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on('console', message => result.console.push({ type: message.type(), text: message.text() }));
page.on('pageerror', error => result.console.push({ type: 'pageerror', text: error.message }));

let firstMission = -1;
let secondMission = -1;
let onlineState: WorldState | undefined;
try {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Launch fleet' }).waitFor({ state: 'visible', timeout: 10_000 });
  await capture(page, 'idle.png');
  const idle = await record(page, 'idle-before-launch');
  result.checks.initialConnection = await page.getByText('Simulator connected', { exact: true }).isVisible();
  result.checks.initialRuntime = idle.runtime;
  if (idle.runtime.model !== 'gpt-5.6-luna' || idle.runtime.effort !== 'xhigh') throw new Error('Initial runtime metadata was not Luna/xhigh.');

  await page.getByRole('button', { name: 'Launch fleet' }).click();
  await capture(page, 'launch-starting.png');
  onlineState = await waitFor(page, current => current.runtime.status === 'running' && current.drones.length === 3 && current.drones.every(drone => drone.online), startupTimeoutMs, 'three online drones');
  await record(page, 'three-native-drones-online');
  result.checks.runtimeModel = { model: onlineState.runtime.model, effort: onlineState.runtime.effort };
  result.checks.threeDronesOnline = onlineState.drones.every(drone => drone.online);
  result.checks.nativeChildren = onlineState.runtime.children ?? null;
  await capture(page, 'three-drones-online.png');

  const instruction = page.locator('#instruction');
  await instruction.fill(firstInstruction);
  await page.getByRole('button', { name: 'Send instruction' }).click();
  await capture(page, 'mission-one-sent.png');
  let current = await waitFor(page, candidate => candidate.mission === 1 && candidate.radio.some(message => message.from === 'player' && message.mission === 1), 30_000, 'mission one forwarding');
  firstMission = current.mission;
  const initialPositions = Object.fromEntries(current.drones.map(drone => [drone.id, { x: drone.x, y: drone.y, z: drone.z }]));
  await record(page, 'mission-one-forwarded');

  const trialStart = Date.now();
  let secondSent = false;
  let lastSampleAt = 0;
  while (Date.now() - trialStart < trialBudgetMs) {
    await page.waitForTimeout(2000);
    current = await state(page);
    if (!current.running) {
      result.failures.push(`Fleet stopped during bounded trial: ${current.runtime.status} ${current.runtime.message}`);
      break;
    }
    if (current.mission !== firstMission && !secondSent) {
      result.failures.push(`Mission changed before the second directive: expected ${firstMission}, got ${current.mission}`);
      break;
    }
    if (Date.now() - lastSampleAt >= 10_000) {
      await record(page, 'mission-one-live');
      lastSampleAt = Date.now();
    }
    if (!secondSent && Date.now() - trialStart >= 42_000) {
      await instruction.fill(secondInstruction);
      await page.getByRole('button', { name: 'Send instruction' }).click();
      secondSent = true;
      await capture(page, 'mission-two-sent.png');
      current = await waitFor(page, candidate => candidate.mission === 2 && candidate.radio.some(message => message.from === 'player' && message.mission === 2), 30_000, 'mission two forwarding');
      secondMission = current.mission;
      result.checks.stateImmediatelyAfterSecondMission = { drones: current.drones.map(drone => ({ id: drone.id, status: drone.status, action: drone.action })), mission: current.mission };
      await record(page, 'mission-two-forwarded');
    }
    if (secondSent) {
      const missionTwoSenders = new Set(current.radio.filter(message => message.mission === 2 && message.from.startsWith('drone-')).map(message => message.from));
      if (missionTwoSenders.size === 3) {
        await capture(page, 'all-three-second-mission-replies.png');
        break;
      }
    }
  }
  current = await record(page, 'bounded-trial-end');
  const displacement = Object.fromEntries(current.drones.map(drone => {
    const start = initialPositions[drone.id];
    return [drone.id, { x: drone.x - start.x, y: drone.y - start.y, z: drone.z - start.z, distance: Math.hypot(drone.x - start.x, drone.y - start.y, drone.z - start.z), status: drone.status, observations: drone.observations }];
  }));
  result.checks.peerCommunication = { totalRadioMessages: current.radio.length, peerMessages: current.radio.filter(message => message.from.startsWith('drone-')).length, senders: [...new Set(current.radio.filter(message => message.from.startsWith('drone-')).map(message => message.from))] };
  result.checks.movement = displacement;
  result.checks.cameraUseVisibleInState = current.drones.map(drone => ({ id: drone.id, observations: drone.observations }));
  result.checks.secondMissionSent = secondSent;
  result.checks.secondMission = secondMission;
  if (!secondSent) result.failures.push('The second directive was not sent within the bounded trial.');
  await capture(page, 'bounded-trial-end.png');
} catch (error) {
  result.failures.push(error instanceof Error ? error.message : String(error));
  try { await record(page, 'failure-state'); } catch (recordError) { result.failures.push(`Could not record failure state: ${recordError instanceof Error ? recordError.message : String(recordError)}`); }
} finally {
  // Cleanup is deliberately scoped to the approved 4318 endpoint.
  await postStop();
  try {
    const stopped = await waitFor(page, current => !current.running && current.runtime.status === 'stopped', 30_000, '4318 fleet stop');
    result.checks.stop = { running: stopped.running, runtimeStatus: stopped.runtime.status, dronesOffline: stopped.drones.every(drone => !drone.online) };
    await record(page, 'stopped');
    await capture(page, 'stopped.png');
  } catch (error) {
    result.failures.push(`Stop verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await inspectSession(beforeSessions);
  result.finishedAt = new Date().toISOString();
  await capture(page, 'final-browser-state.png').catch(() => {});
  await writeFile(join(artifactsDir, 'playtest-result.json'), JSON.stringify(result, null, 2) + '\n');
  await browser.close();
}

console.log(JSON.stringify({ artifact: join(artifactsDir, 'playtest-result.json'), failures: result.failures, checks: result.checks }, null, 2));
if (result.failures.length) process.exitCode = 1;
