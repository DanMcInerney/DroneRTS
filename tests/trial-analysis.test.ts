import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FleetGame } from '../server/game.ts';

const run = promisify(execFile);
async function fixture(t: import('node:test').TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-analysis-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionId = 'session-fixture.jsonl';
  await writeFile(join(directory, 'result.json'), JSON.stringify({ sessionId, scenario: 'fixture', naturalCompletion: true, failures: [], warnings: [] }));
  const calibration = createHash('sha256').update(await readFile(new URL('../shared/rts.ts', import.meta.url))).digest('hex');
  await writeFile(join(directory, 'source-manifest.json'), JSON.stringify({ 'shared/rts.ts': calibration }));
  return { directory, sessionId };
}

test('historical analysis refuses changed calibration before overwriting saved results', async t => {
  const { directory } = await fixture(t);
  await writeFile(join(directory, 'source-manifest.json'), JSON.stringify({ 'shared/rts.ts': 'older-calibration' }));
  await writeFile(join(directory, 'analysis.json'), 'preserved historical analysis');
  await assert.rejects(run(process.execPath, ['--import', 'tsx', 'scripts/analyze-trial.ts', directory]), /calibration differs/);
  assert.equal(await readFile(join(directory, 'analysis.json'), 'utf8'), 'preserved historical analysis');
});

test('shot analysis excludes equal-time post-fire cameras and distinguishes unresolved shots', async t => {
  const { directory, sessionId } = await fixture(t), game = new FleetGame();
  const session = join(directory, 'replays', sessionId.slice(0, -6)); await mkdir(session, { recursive: true });
  const frame = { type: 'frame', simTime: 0, drones: game.state.drones, match: game.state.match };
  const camera = { type: 'observation', drone: 'drone-1', pose: game.state.drones[0], mission: 1, imageAvailable: true, capturedAt: '2026-09-14T00:00:00Z' };
  const records = [frame, { ...camera, simTime: 0, imageId: 'before.jpg' }, { ...frame, simTime: 1 },
    { type: 'event', simTime: 1, event: { type: 'fired', id: 'fire', projectileId: 'bullet', drone: 'drone-1', simTime: 1 } },
    { ...camera, simTime: 1, imageId: 'after.jpg' }, { type: 'end', simTime: 1, reason: 'stopped', omittedImages: 0 }];
  await writeFile(join(session, 'frames.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  await writeFile(join(directory, sessionId), JSON.stringify({ type: 'system', value: {} }) + '\n');
  await run(process.execPath, ['--import', 'tsx', 'scripts/analyze-trial.ts', directory]);
  const analysis = JSON.parse(await readFile(join(directory, 'analysis.json'), 'utf8'));
  assert.equal(analysis.shots[0].cameraImage, 'before.jpg');
  assert.equal(analysis.shots[0].cameraAge, 1);
  assert.equal(analysis.shots[0].frameAge, 0);
  assert.deepEqual(analysis.shotOutcomes, { 'unresolved-at-match-end': 1 });
});
