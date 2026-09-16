/** Opt-in native qualification. Real Luna children, renderer, Zenoh and MAVLink.
 * Synthetic evidence tests the attention transport, never acoustic accuracy. */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createArtifactRun } from './test-artifacts.ts';
import { createTrialHost } from './trial-host.ts';
import { MODEL, EFFORT } from '../server/runtime-tools.ts';

const mode = process.argv[2] ?? 'attention';
assert.ok(['attention', 'haul-single', 'haul-repeat', 'haul-team'].includes(mode));
const port = Number(process.env.RTS_TRIAL_PORT ?? 4328), seconds = Number(process.env.RTS_TRIAL_SECONDS ?? 240);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 4317);
assert.ok(seconds >= 30 && seconds <= 600);
process.env.FLEET_ATTENTION = mode === 'attention' ? 'experimental' : '';
process.env.FLEET_ACOUSTIC = ''; // Sensor accuracy is qualified independently.
const preflight: Record<string, unknown> = {};
for (const checked of new Set([4317, 4318, port])) {
  try {
    const response = await fetch(`http://127.0.0.1:${checked}/api/state`, { signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok); const state = await response.json();
    preflight[checked] = { running: state.running, simTime: state.simTime, runtime: state.runtime.status };
    assert.notEqual(checked, port, `Trial port ${port} is occupied; preserve that server`);
  } catch (error) {
    if (error instanceof TypeError && (error.cause as NodeJS.ErrnoException)?.code === 'ECONNREFUSED') preflight[checked] = 'unavailable';
    else throw error;
  }
}
const label = process.env.RTS_TRIAL_LABEL ?? '';
assert.match(label, /^[a-z0-9-]*$/);
const projectDir = resolve(import.meta.dirname, '..'), artifacts = createArtifactRun(`native-${mode}${label ? `-${label}` : ''}`), directory = artifacts.directory;
const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: projectDir, encoding: 'utf8' }).split(/\r?\n/).filter(p => /\.(ts|mjs|json|py|html|css)$/.test(p)).sort();
const manifest = Object.fromEntries(await Promise.all(paths.map(async p => [p, createHash('sha256').update(await readFile(resolve(projectDir, p))).digest('hex')])));
await writeFile(resolve(directory, 'source-manifest.json'), JSON.stringify(manifest, null, 2));
const result: any = { mode, model: MODEL, effort: EFFORT, port, seconds, preflight, directory, startedAt: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectDir, encoding: 'utf8' }).trim(), sourceManifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  injections: [], samples: [], resources: [], failures: [], browserErrors: [] };
let reasoning = false, waiting = false, tools = new Set<string>(), ordinaryIncluded = false, ordinaryResponse = false, emergencyResponseAt = 0, resumed = false, heldSettledAt = 0;
const host = await createTrialHost(projectDir, directory, mode === 'haul-repeat' ? 'haul-single' : mode as 'attention' | 'haul-single' | 'haul-team', port, (type, value) => {
  if (type !== 'agent' || value.role !== 'drone-1') return;
  if (value.type === 'actor-activity') {
    if (value.activity === 'reasoning') reasoning = value.phase === 'started';
    if (value.activity === 'mcpToolCall') value.phase === 'started' ? tools.add(value.itemId) : tools.delete(value.itemId);
  }
  if (value.type === 'tool-result') {
    if (value.name === 'wait') waiting = false;
    for (const item of value.result.content) if (item.type === 'text') {
      try { if (JSON.parse(item.text).events?.some((e: any) => e.type === 'qualification_notice')) ordinaryIncluded = true; } catch {}
    }
  }
  if (value.type === 'tool' && ordinaryIncluded) ordinaryResponse = true;
  if (value.type === 'tool' && value.name === 'wait') waiting = true;
  if (value.type === 'attention-turn-resumed') resumed = true;
  if (value.type === 'attention-settled' && value.route === 'boundary') heldSettledAt = performance.now();
  if (value.type === 'tool' && resumed && !emergencyResponseAt) emergencyResponseAt = performance.now();
});
const histogram = monitorEventLoopDelay({ resolution: 20 }); histogram.enable();
const cpu = process.cpuUsage(), started = performance.now();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, cancelled = false;
const cancel = () => { cancelled = true; void host.stop(); };
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
let nextResource = 0, resourceWork: Promise<void> | undefined;
async function resources() {
  const sample: any = { elapsedMs: performance.now() - started, hostRss: process.memoryUsage().rss, hostCpu: process.cpuUsage(cpu) };
  if (process.platform === 'win32') {
    const script = `$rows=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name; $ids=[System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${process.pid}); do {$changed=$false; foreach($row in $rows) {if($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) {$changed=$true}}} while($changed); @($rows | Where-Object {$ids.Contains([int]$_.ProcessId)} | ForEach-Object {$p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if($p) {[PSCustomObject]@{pid=$p.Id; name=$p.ProcessName; cpuSeconds=$p.CPU; rss=$p.WorkingSet64; peakRss=$p.PeakWorkingSet64}}}) | ConvertTo-Json -Compress`;
    try { const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000 }); sample.processes = JSON.parse(stdout); }
    catch (error) { sample.error = String(error); }
  }
  result.resources.push(sample);
}
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => result.browserErrors.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}`);
  for (let i = 0; i < 120 && !host.connected(); i++) await delay(250);
  assert.ok(host.connected(), 'Actual camera renderer did not become ready');
  result.fixture = await host.start(); result.sessionId = host.sessionId;
  await page.screenshot({ path: resolve(directory, 'camera-browser.png') });
  console.log(JSON.stringify({ ready: port, mode, directory }));
  const deadline = performance.now() + seconds * 1000;
  let sampleAt = 0;
  while (!cancelled && host.game.state.running && performance.now() < deadline) {
    const now = performance.now(), state = host.game.state;
    if (now >= sampleAt) {
      const sample = { elapsedMs: now - started, simTime: state.simTime, launchReady: host.game.launchReady, runtime: state.runtime,
        observations: state.drones.map(d => d.observations), alive: state.drones.map(d => d.alive), earned: Object.values(state.match!.teams).map(t => t.earned) };
      result.samples.push(structuredClone(sample)); console.log(JSON.stringify({ ...sample, runtime: state.runtime.status })); sampleAt = now + 10000;
    }
    if (now >= nextResource && !resourceWork) {
      nextResource = now + 15000; resourceWork = resources().finally(() => { resourceWork = undefined; });
    }
    if (mode === 'attention' && host.game.launchReady && reasoning && !tools.size && state.drones[0].observations >= 2) {
      const phase = result.injections.length === 0 ? 'ordinary' : result.injections.length === 1 && ordinaryResponse ? 'emergency' : undefined;
      if (phase) {
        const event = phase === 'ordinary' ? { type: 'qualification_notice', text: 'Synthetic ordinary local notice for controller qualification.' }
          : { type: 'acoustic_impulse', possibleShot: true, uncertain: true, sensorProfile: 'qualification/synthetic', text: 'Synthetic local sound measurement for controller qualification; no actual shot is asserted.' };
        result.injections.push({ phase, observedAtMs: now, elapsedMs: now - started, simTime: state.simTime, reasoning, pendingNativeTools: tools.size });
        host.game.inboxes['drone-1'].push({ ...event, simTime: state.simTime, mission: host.game.receivedMission('drone-1') });
        console.log(JSON.stringify({ injected: phase, elapsedMs: now - started }));
      }
    }
    if (mode === 'attention' && result.injections.length === 2 && emergencyResponseAt && now - emergencyResponseAt > 5000 && waiting && tools.size > 0) {
      result.injections.push({ phase: 'emergency-held', observedAtMs: now, elapsedMs: now - started, simTime: state.simTime, reasoning, pendingNativeTools: tools.size });
      host.game.inboxes['drone-1'].push({ type: 'acoustic_impulse', possibleShot: true, uncertain: true, sensorProfile: 'qualification/synthetic',
        text: 'Second synthetic local sound episode for held-boundary qualification; no actual shot is asserted.', simTime: state.simTime, mission: host.game.receivedMission('drone-1') });
      console.log(JSON.stringify({ injected: 'emergency-held', elapsedMs: now - started }));
    }
    if (mode === 'attention' && heldSettledAt && now - heldSettledAt > 20000) { result.completedProtocol = true; break; }
    const target = mode === 'haul-repeat' ? 60 : mode === 'haul-team' ? 90 : 30;
    if (mode !== 'attention' && state.match!.teams.blue.earned >= target) { result.completedTrialObjective = true; break; }
    await delay(100);
  }
  result.endReason = cancelled ? 'signal' : result.completedProtocol || result.completedTrialObjective ? 'bounded-objective' : host.failures.length ? 'failure' : 'time-limit';
} catch (error) { result.failures.push(String(error)); }
finally {
  result.finalState = structuredClone(host.game.state); result.cleanup = 'pending';
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(result, null, 2));
  await host.close().then(() => { result.cleanup = 'complete'; }).catch(error => result.failures.push(`Cleanup: ${error}`));
  await browser?.close(); await resourceWork;
  histogram.disable(); result.eventLoopMs = { p50: histogram.percentile(50) / 1e6, p95: histogram.percentile(95) / 1e6, p99: histogram.percentile(99) / 1e6, max: histogram.max / 1e6 };
  result.hostCpu = process.cpuUsage(cpu); result.hostResourceUsage = process.resourceUsage(); result.failures.push(...host.failures);
  result.completedAt = new Date().toISOString();
  if (result.cleanup === 'complete') artifacts.collectNetwork(host.game.sessionIdentity);
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(result, null, 2));
  process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  console.log(JSON.stringify({ result: resolve(directory, 'result.json'), cleanup: result.cleanup, failures: result.failures }));
}
if (result.failures.length) process.exitCode = 1;
