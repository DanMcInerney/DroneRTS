/** A bounded real six-agent trial. Keep a game browser open on isolated port 4318. */
import assert from 'node:assert/strict';
import { mkdir, appendFile, writeFile, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { GameState } from '../shared/types.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';
import { createArtifactRun } from './test-artifacts.ts';

const base = 'http://127.0.0.1:4318';
const duration = Math.min(600, Math.max(30, Number(process.env.RTS_TRIAL_SECONDS ?? 480)));
const readState = async (): Promise<GameState> => (await fetch(`${base}/api/state`)).json();
const post = async (path: string) => {
  const response = await fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
};
const initial = await readState();
assert.equal(initial.running, false, 'Preserve any active trial');
assert.equal(initial.drones.length, 6);
const artifacts = createArtifactRun('playtest-rts'), directory = artifacts.directory;
await mkdir(directory, { recursive: true });
const before = await readdir(resolve('artifacts'));
const result: Record<string, any> = { startedAt: new Date().toISOString(), directory, duration, model: 'gpt-5.6-luna', effort: 'xhigh', samples: [], failures: [] };
let launched = false;
try {
  await post('reset'); await post('start'); launched = true;
  const started = Date.now();
  while (Date.now() - started < duration * 1000) {
    const state = await readState();
    const sample = { elapsed: Math.round((Date.now() - started) / 1000), simTime: state.simTime, running: state.running,
      runtime: state.runtime, network: state.network, drones: state.drones, match: state.match, radio: state.radio };
    result.samples.push(sample); await appendFile(resolve(directory, 'states.jsonl'), JSON.stringify(sample) + '\n');
    console.log(JSON.stringify({ elapsed: sample.elapsed, status: state.runtime.status, online: state.drones.filter(d => d.online).length,
      alive: state.drones.filter(d => d.alive !== false).length, observations: state.drones.map(d => d.observations),
      credits: Object.values(state.match!.teams).map(team => Math.floor(team.credits)), equipment: state.drones.map(d => d.equipment), events: state.match!.events.slice(-3).map(e => e.message) }));
    if (state.runtime.status === 'error') throw new Error(state.runtime.message);
    if (state.completed) { result.naturalCompletion = true; result.winner = state.match!.winner; break; }
    if (!state.running) throw new Error(`Match stopped early: ${state.runtime.message}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 10_000));
  }
} catch (error) { result.failures.push(String(error)); }
finally {
  if (launched) await post('stop').catch(error => result.failures.push(`Cleanup: ${error}`));
  const final = await readState(); result.stopped = !final.running;
  const logs = (await readdir(resolve('artifacts'))).filter(name => !before.includes(name) && /^session-.*\.jsonl$/.test(name));
  result.logs = logs;
  const records = (await Promise.all(logs.map(name => readFile(resolve('artifacts', name), 'utf8')))).flatMap(text => text.split('\n').filter(Boolean).map(line => JSON.parse(line)));
  result.agentActivity = Object.fromEntries(MATCH_DRONE_IDS.map(id => [id, {
    observations: records.filter(record => record.type === 'observation' && record.value.drone === id).length,
    tools: records.filter(record => record.type === 'tool' && record.value.drone === id).map(record => record.value.name),
    radio: records.filter(record => record.type === 'radio' && record.value.from === id).length,
  }]));
  result.verifiedModels = records.filter(record => record.type === 'agent' && record.value.type === 'model-verified').map(record => record.value);
  result.errors = records.filter(record => ['transport-error', 'tool-error'].includes(record.type) || record.type === 'agent' && /error|denied/.test(record.value.type ?? ''));
  result.completedAt = new Date().toISOString();
  if (result.stopped) for (const name of logs) artifacts.collectSession(name);
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ result: resolve(directory, 'result.json'), failures: result.failures, naturalCompletion: result.naturalCompletion ?? false, stopped: result.stopped, agentActivity: result.agentActivity }));
}
if (result.failures.length) process.exitCode = 1;
