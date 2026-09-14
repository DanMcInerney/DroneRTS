/** Bounded live trials on an owned port (4318 by default). Keep a camera browser open there. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createTrialHost } from './trial-host.ts';
import { SCENARIOS, type TrialScenario } from './trial-scenarios.ts';
import { MODEL, EFFORT } from '../server/runtime-tools.ts';

const scenario = process.argv[2] as TrialScenario;
assert.ok(SCENARIOS.includes(scenario), `Choose ${SCENARIOS.join(', ')}`);
const seconds = Number(process.env.RTS_TRIAL_SECONDS ?? (scenario === 'match' ? 480 : scenario.startsWith('haul-') ? 300 : 180));
assert.ok(Number.isFinite(seconds) && seconds >= 30 && seconds <= 600, 'Trial must be 30–600 wall seconds');
const port = Number(process.env.RTS_TRIAL_PORT ?? 4318);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 4317, 'Trial port must be 1024–65535 and must preserve player port 4317');
const url = `http://127.0.0.1:${port}`;
const projectDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const directory = resolve(projectDir, 'artifacts/focused-trials', `${new Date().toISOString().replace(/[:.]/g, '-')}-${scenario}`);
const preflight: Record<string, unknown> = {};
for (const checkedPort of new Set([4317, 4318, port])) {
  try {
    const response = await fetch(`http://127.0.0.1:${checkedPort}/api/state`, { signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok, `Port ${checkedPort} returned ${response.status}`);
    const state = await response.json();
    preflight[checkedPort] = { running: state.running, simTime: state.simTime, runtime: state.runtime.status };
    assert.notEqual(checkedPort, port, `Port ${port} already has a server; preserve it and stop only an owned server first`);
  } catch (error) {
    if (error instanceof TypeError && (error.cause as NodeJS.ErrnoException)?.code === 'ECONNREFUSED') preflight[checkedPort] = 'unavailable';
    else throw error;
  }
}
await mkdir(directory, { recursive: true });
const sourcePaths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: projectDir, encoding: 'utf8' })
  .split(/\r?\n/).filter(path => /\.(ts|json|mjs|py|html|css)$/.test(path)).sort();
const manifest = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, createHash('sha256').update(await readFile(resolve(projectDir, path))).digest('hex')])));
await writeFile(resolve(directory, 'source-manifest.json'), JSON.stringify(manifest, null, 2));
const result: Record<string, any> = { scenario, seconds, port, model: MODEL, effort: EFFORT, preflight, directory,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectDir, encoding: 'utf8' }).trim(),
  manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), startedAt: new Date().toISOString(), failures: [], samples: [] };
const host = await createTrialHost(projectDir, directory, scenario, port);
let cancelled = false, completedTrialObjective = false;
const cancel = () => { cancelled = true; void host.stop(); };
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
try {
  console.log(JSON.stringify({ ready: url, directory, scenario, seconds }));
  const browserDeadline = Date.now() + 60_000;
  while (!host.connected() && !cancelled && Date.now() < browserDeadline) await delay(250);
  assert.ok(host.connected() && !cancelled, 'Camera browser did not connect within 60 seconds');
  result.fixture = await host.start(); result.sessionId = host.sessionId;
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline && !cancelled) {
    const state = host.game.state;
    result.samples.push(structuredClone({ simTime: state.simTime, runtime: state.runtime, drones: state.drones, match: state.match }));
    console.log(JSON.stringify({ simTime: Math.round(state.simTime), status: state.runtime.status,
      observations: state.drones.map(d => d.observations), alive: state.drones.map(d => d.alive),
      earned: Object.values(state.match!.teams).map(team => Math.round(team.earned)), events: state.match!.events.slice(-2).map(event => event.message) }));
    if (scenario === 'haul-single' && state.match!.teams.blue.earned >= 30) {
      completedTrialObjective = true; break;
    }
    if (!state.running) break;
    await delay(Math.min(scenario.startsWith('haul-') ? 5_000 : 10_000, Math.max(0, deadline - Date.now())));
  }
  result.naturalCompletion = host.game.state.completed; result.winner = host.game.state.match!.winner;
  result.finalState = structuredClone(host.game.state);
  result.completedTrialObjective = completedTrialObjective;
  result.endReason = cancelled ? 'signal' : completedTrialObjective ? 'trial-objective-complete' : host.game.state.completed ? 'natural-completion' : host.failures.length ? 'failure' : host.game.state.running ? 'time-limit' : 'external-stop';
} catch (error) { result.failures.push(String(error)); }
finally {
  // Preserve the actual final snapshot even if cleanup never settles.
  result.cleanup = 'pending';
  await writeFile(resolve(directory, 'result.json'), JSON.stringify({ ...result,
    failures: [...result.failures, ...host.failures], warnings: host.warnings }, null, 2));
  await host.close().then(() => { result.cleanup = 'complete'; }).catch(error => {
    result.cleanup = 'failed'; result.failures.push(`Cleanup: ${error}`);
  });
  result.failures.push(...host.failures); result.warnings = host.warnings;
  result.stopped = !host.game.state.running; result.completedAt = new Date().toISOString();
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ result: resolve(directory, 'result.json'), stopped: result.stopped, failures: result.failures }));
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
}
if (result.failures.length) process.exitCode = 1;
