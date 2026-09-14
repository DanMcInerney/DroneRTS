import { chromium, type Page } from '@playwright/test';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runName = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const artifactsDir = join(projectDir, 'artifacts', 'playtest', runName);
const url = process.env.PLAYTEST_URL ?? 'http://127.0.0.1:4317';
const defaultInstruction = 'Find the colored pads and have one drone hover over each.';
const secondInstruction = 'Everyone hold position and briefly report your status.';
const initialBudgetMs = 3 * 60 * 1000;
const maximumBudgetMs = 5 * 60 * 1000;

type State = {
  simTime: number;
  mission: number;
  running: boolean;
  completed: boolean;
  radio: Array<{ id: string; from: string; to: string; kind: string; text: string; mission: number; simTime: number }>;
  drones: Array<{ id: string; x: number; y: number; z: number; status: string; online: boolean; observations: number; action?: unknown }>;
  runtime: { status: string; message: string; model: string; effort: string; [key: string]: unknown };
};

const result = {
  surface: 'isolated Playwright Chromium (approved fallback after in-app browser disconnect)',
  url,
  model: 'gpt-5.6-luna',
  effort: 'xhigh',
  defaultInstruction,
  secondInstruction,
  startedAt: new Date().toISOString(),
  finishedAt: undefined as string | undefined,
  screenshots: [] as string[],
  observations: [] as Array<Record<string, unknown>>,
  checks: {} as Record<string, unknown>,
  console: [] as Array<{ type: string; text: string }>,
  failures: [] as string[],
};

await mkdir(artifactsDir, { recursive: true });
await writeFile(join(artifactsDir, 'state-history.jsonl'), '');

async function state(page: Page): Promise<State> {
  return page.evaluate(async () => await (await fetch('/api/state')).json() as State);
}

async function waitFor(page: Page, predicate: (current: State) => boolean, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  let current = await state(page);
  while (!predicate(current) && Date.now() < deadline) {
    await page.waitForTimeout(2000);
    current = await state(page);
  }
  if (!predicate(current)) throw new Error(`Timed out waiting for ${label}`);
  return current;
}

async function capture(page: Page, filename: string) {
  const path = join(artifactsDir, filename);
  await page.screenshot({ path, fullPage: false });
  result.screenshots.push(`artifacts/playtest/${runName}/${filename}`);
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
    drones: current.drones.map(({ id, x, y, z, status, online, observations, action }) => ({ id, x, y, z, status, online, observations, action })),
    radioCount: current.radio.length,
    radio: current.radio.slice(-12),
  };
  result.observations.push(sample);
  await appendFile(join(artifactsDir, 'state-history.jsonl'), JSON.stringify(sample) + '\n');
  return current;
}

function hasMovement(current: State) {
  return current.drones.some((drone, index) => Math.hypot(drone.x - (index - 1) * 5, drone.z - 23) > 1 || drone.status === 'Flying');
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on('console', message => result.console.push({ type: message.type(), text: message.text() }));
page.on('pageerror', error => result.console.push({ type: 'pageerror', text: error.message }));

try {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Launch fleet' }).waitFor({ state: 'visible', timeout: 10_000 });
  await capture(page, 'isolated-idle.png');
  let current = await record(page, 'idle-before-launch');
  result.checks.initialConnection = await page.getByText('Simulator connected', { exact: true }).isVisible();
  result.checks.initialRuntime = current.runtime;

  await page.getByRole('button', { name: 'Launch fleet' }).click();
  await capture(page, 'launch-starting.png');
  current = await waitFor(page, s => s.runtime.status === 'running' && s.drones.every(drone => drone.online), 120_000, 'three connected native drones');
  await record(page, 'three-native-drones-connected');
  result.checks.runtimeModel = { model: current.runtime.model, effort: current.runtime.effort };
  result.checks.threeDronesConnected = current.drones.every(drone => drone.online);
  result.checks.runtimeThread = current.runtime.threadId ?? null;

  const instruction = page.locator('#instruction');
  await instruction.fill(defaultInstruction);
  await page.getByRole('button', { name: 'Send instruction' }).click();
  await capture(page, 'mission-queued.png');
  current = await waitFor(page, s => s.mission === 1 && s.radio.some(message => message.from === 'player' && message.mission === 1), 60_000, 'mission 1 forwarding');
  await record(page, 'mission-1-forwarded');
  const firstMission = current.mission;

  const missionStartedAt = Date.now();
  let lastRadioCount = current.radio.length;
  let nextSample = Date.now();
  let progressAtThreeMinutes = false;
  let missionComplete = false;
  while (Date.now() - missionStartedAt < maximumBudgetMs) {
    await page.waitForTimeout(2000);
    current = await state(page);
    if (current.mission !== firstMission) {
      result.checks.externalMissionChange = { expected: firstMission, actual: current.mission };
      throw new Error(`Mission ${firstMission} interrupted by external player mission ${current.mission}`);
    }
    if (Date.now() >= nextSample) {
      await record(page, 'mission-1-observation');
      nextSample = Date.now() + 10_000;
    }
    if (current.radio.length !== lastRadioCount) {
      lastRadioCount = current.radio.length;
      await capture(page, 'mission-radio-progress.png');
    }
    if (current.runtime.status === 'error' || !current.running) {
      throw new Error(`Mission 1 stopped early: ${current.runtime.status} ${current.runtime.message}`);
    }
    if (current.completed) {
      missionComplete = true;
      break;
    }
    if (!progressAtThreeMinutes && Date.now() - missionStartedAt >= initialBudgetMs) {
      progressAtThreeMinutes = hasMovement(current) || current.radio.length > 1 || current.drones.some(drone => drone.observations > 0);
      result.checks.progressAtThreeMinutes = progressAtThreeMinutes;
      if (!progressAtThreeMinutes) throw new Error('Mission 1 stalled without movement, observations, or radio traffic after 3 minutes');
      await capture(page, 'mission-three-minute-progress.png');
    }
  }
  if (!missionComplete) result.failures.push('Mission 1 did not complete within the five-minute bounded run');
  current = await record(page, missionComplete ? 'mission-1-complete' : 'mission-1-bounded-end');
  result.checks.mission1Completed = current.mission === firstMission && current.completed;
  result.checks.mission1SimTime = current.simTime;
  result.checks.mission1RadioCount = current.radio.length;
  result.checks.mission1Observations = current.drones.map(drone => ({ id: drone.id, observations: drone.observations }));
  await capture(page, 'mission-complete.png');

  const secondMission = current.mission + 1;
  await instruction.fill(secondInstruction);
  await page.getByRole('button', { name: 'Send instruction' }).click();
  current = await waitFor(page, s => s.mission === secondMission && s.radio.some(message => message.from === 'player' && message.mission === secondMission), 60_000, `mission ${secondMission} forwarding`);
  await record(page, 'mission-2-forwarded');
  result.checks.secondInstructionForwarded = current.mission === 2;
  await capture(page, 'mission-2-forwarded.png');

  const secondDeadline = Date.now() + 75_000;
  let mission2RadioCount = current.radio.length;
  let mission2Reports = 0;
  while (Date.now() < secondDeadline) {
    await page.waitForTimeout(2000);
    current = await state(page);
    mission2RadioCount = current.radio.filter(message => message.mission === secondMission).length;
    mission2Reports = new Set(current.radio.filter(message => message.mission === secondMission && message.from.startsWith('drone-')).map(message => message.from)).size;
    if (mission2Reports === 3) break;
  }
  await record(page, 'mission-2-report-observation');
  result.checks.secondInstructionDroneReports = mission2Reports;
  result.checks.secondInstructionRadioCount = mission2RadioCount;
  if (mission2Reports !== 3) result.failures.push('Not all three drones reported after the second instruction');

  await page.getByRole('button', { name: 'Stop fleet' }).click();
  current = await waitFor(page, s => !s.running && s.runtime.status === 'stopped', 60_000, 'fleet stop');
  await record(page, 'stopped');
  result.checks.stop = { running: current.running, runtimeStatus: current.runtime.status, dronesOffline: current.drones.every(drone => !drone.online) };
  await capture(page, 'stopped.png');

  await page.getByRole('button', { name: 'Reset world' }).click();
  current = await waitFor(page, s => !s.running && s.mission === 0 && !s.completed && s.radio.length === 0, 30_000, 'world reset');
  await record(page, 'reset');
  result.checks.reset = { running: current.running, mission: current.mission, completed: current.completed, radioCount: current.radio.length };
  await capture(page, 'reset.png');
} catch (error) {
  result.failures.push(error instanceof Error ? error.message : String(error));
  try {
    const current = await state(page);
    await record(page, 'failure-state');
    result.checks.failureState = { mission: current.mission, running: current.running, completed: current.completed, runtime: current.runtime, radioCount: current.radio.length };
    if (current.running) {
      await page.getByRole('button', { name: 'Stop fleet' }).click().catch(() => {});
      await waitFor(page, s => !s.running, 60_000, 'failure stop').catch(() => {});
    }
  } catch (cleanupError) {
    result.failures.push(`Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
  }
  throw error;
} finally {
  result.finishedAt = new Date().toISOString();
  const sessionFiles = (await readdir(join(projectDir, 'artifacts'))).filter(file => file.startsWith('session-') && file.endsWith('.jsonl')).sort();
  const sessionFile = sessionFiles.at(-1);
  if (sessionFile) {
    const sessionPath = join(projectDir, 'artifacts', sessionFile);
    const lines = (await readFile(sessionPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; value: any });
    const counts = Object.fromEntries([...new Set(lines.map(line => line.type))].map(type => [type, lines.filter(line => line.type === type).length]));
    const nativeCalls = lines.filter(line => line.type === 'agent' && line.value?.type === 'native-agent-call').map(line => ({ tool: line.value.tool, status: line.value.status, model: line.value.model, effort: line.value.effort, children: line.value.children }));
    const toolCalls = lines.filter(line => line.type === 'tool').map(line => ({ drone: line.value.drone, name: line.value.name, args: line.value.args }));
    const observations = lines.filter(line => line.type === 'observation').map(line => ({ drone: line.value.drone, pose: line.value.pose, simTime: line.value.simTime, mission: line.value.mission }));
    const radio = lines.filter(line => line.type === 'radio').map(line => line.value);
    result.checks.sessionLog = { path: `artifacts/${sessionFile}`, counts, nativeCalls, toolCalls, observations, radio };
  }
  await capture(page, 'final-browser-state.png').catch(() => {});
  await writeFile(join(artifactsDir, 'playtest-result.json'), JSON.stringify(result, null, 2) + '\n');
  if (process.env.PLAYTEST_HOLD_BROWSER !== '1') await browser.close();
}

if (result.failures.length) process.exitCode = 1;
console.log(JSON.stringify({ artifact: join(artifactsDir, 'playtest-result.json'), failures: result.failures,
  missionCompleted: result.checks.mission1Completed, secondInstructionReports: result.checks.secondInstructionDroneReports,
  stop: result.checks.stop, reset: result.checks.reset }, null, 2));
