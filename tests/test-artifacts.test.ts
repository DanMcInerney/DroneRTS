import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createArtifactRun, pruneTestRuns } from '../scripts/test-artifacts.ts';

function fixture(t: TestContext) {
  const projectDir = mkdtempSync(join(tmpdir(), 'fleet-retention-'));
  t.after(() => {
    assert.ok(resolve(projectDir).startsWith(resolve(tmpdir()) + sep));
    rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return projectDir;
}

test('retention keeps only the newest completed run, including failures, across test kinds', t => {
  const projectDir = fixture(t), options = { projectDir, registerExit: false };
  const first = createArtifactRun('match', options);
  writeFileSync(join(first.directory, 'image.jpg'), 'original'); first.finish();
  const second = createArtifactRun('ui', options);
  // Explicit chronology avoids relying on clock precision or random-ID ordering.
  const meta = JSON.parse(readFileSync(join(first.directory, '.run.json'), 'utf8'));
  writeFileSync(join(first.directory, '.run.json'), JSON.stringify({ ...meta, startedAt: '2000-01-01T00:00:00.000Z' }));
  writeFileSync(join(second.directory, 'failure.json'), '{"error":"fixture"}'); second.finish(); second.finish();
  assert.equal(existsSync(first.directory), false);
  assert.equal(readFileSync(join(second.directory, 'failure.json'), 'utf8'), '{"error":"fixture"}');
  assert.deepEqual(readdirSync(join(projectDir, 'artifacts/test-runs')), [second.directory.split(sep).at(-1)]);
});

test('active runs and unregistered/player artifacts are preserved', t => {
  const projectDir = fixture(t), options = { projectDir, registerExit: false };
  const active = createArtifactRun('match', options), finished = createArtifactRun('ui', options);
  const player = join(projectDir, 'artifacts/replays/player'); mkdirSync(player, { recursive: true });
  writeFileSync(join(player, 'image.jpg'), 'player');
  const unknown = join(projectDir, 'artifacts/test-runs/unregistered'); mkdirSync(unknown);
  writeFileSync(join(unknown, 'keep.txt'), 'unregistered');
  finished.finish(); pruneTestRuns(projectDir);
  assert.ok(existsSync(active.directory));
  assert.equal(readFileSync(join(player, 'image.jpg'), 'utf8'), 'player');
  assert.equal(readFileSync(join(unknown, 'keep.txt'), 'utf8'), 'unregistered');
});

test('managed cleanup refuses outside paths, existing output and linked directories', t => {
  const projectDir = fixture(t), options = { projectDir, registerExit: false };
  const outside = join(projectDir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'safe');
  assert.throws(() => createArtifactRun('ui', { ...options, output: outside }), /inside/);
  const run = createArtifactRun('ui', options);
  assert.throws(() => createArtifactRun('ui', { ...options, output: run.directory }), /overwrite/);
  symlinkSync(outside, join(projectDir, 'artifacts/test-runs/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  run.finish(); pruneTestRuns(projectDir);
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'safe');
  const linkedProject = join(projectDir, 'linked-project'); mkdirSync(linkedProject);
  symlinkSync(outside, join(linkedProject, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createArtifactRun('ui', { projectDir: linkedProject, registerExit: false }), /Linked/);
});

test('owned stopped session audit, camera replay and network stores move together', t => {
  const projectDir = fixture(t), run = createArtifactRun('match', { projectDir, registerExit: false });
  const session = 'session-test.jsonl', id = '11111111-1111-4111-8111-111111111111';
  const source = join(projectDir, 'artifacts'), network = join(source, 'network', id), replay = join(source, 'replays', 'session-test');
  mkdirSync(network, { recursive: true }); mkdirSync(replay, { recursive: true });
  writeFileSync(join(network, 'radio.sqlite'), 'store'); writeFileSync(join(replay, 'camera.jpg'), 'image');
  writeFileSync(join(source, session), JSON.stringify({ type: 'radio', value: { sessionId: id } }) + '\n');
  run.collectSession(session);
  assert.equal(readFileSync(join(run.directory, `network-${id}`, 'radio.sqlite'), 'utf8'), 'store');
  assert.equal(readFileSync(join(run.directory, 'replays/session-test/camera.jpg'), 'utf8'), 'image');
  assert.ok(existsSync(join(run.directory, session)));
  assert.equal(existsSync(network), false); assert.equal(existsSync(join(source, session)), false);
  assert.throws(() => run.collectSession('../session-test.jsonl'), /Invalid/);
  assert.throws(() => run.collectNetwork('../outside'), /Invalid/);
});

test('normal and failed process exits prune previous runs and preserve failure output', t => {
  const projectDir = fixture(t), module = new URL('../scripts/test-artifacts.ts', import.meta.url).href;
  for (const fail of [false, true]) {
    const code = `import {createArtifactRun} from ${JSON.stringify(module)}; import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; const run=createArtifactRun('process',{projectDir:${JSON.stringify(projectDir)}}); writeFileSync(join(run.directory,'outcome.txt'),${JSON.stringify(fail ? 'failed' : 'passed')}); ${fail ? "throw new Error('intentional fixture failure');" : ''}`;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, FLEET_TEST_RUN: '' } });
    assert.equal(result.status, fail ? 1 : 0, result.stderr);
  }
  const root = join(projectDir, 'artifacts/test-runs'), runs = readdirSync(root);
  assert.equal(runs.length, 1);
  assert.equal(readFileSync(join(root, runs[0], 'outcome.txt'), 'utf8'), 'failed');
});

test('grouped checks retain their shared run until the owning process completes', t => {
  const projectDir = fixture(t), run = createArtifactRun('qa', { projectDir, registerExit: false });
  const module = new URL('../scripts/test-artifacts.ts', import.meta.url).href;
  const code = `import {createArtifactRun} from ${JSON.stringify(module)}; import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; const run=createArtifactRun('browser',{projectDir:${JSON.stringify(projectDir)}}); writeFileSync(join(run.directory,'image.jpg'),'pixels');`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    encoding: 'utf8', env: { ...process.env, FLEET_TEST_RUN: run.directory },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(readFileSync(join(run.directory, '.run.json'), 'utf8')).completed, false);
  run.finish();
  assert.equal(readFileSync(join(run.directory, 'browser/image.jpg'), 'utf8'), 'pixels');
  assert.equal(readdirSync(join(projectDir, 'artifacts/test-runs')).length, 1);
});

test('an interrupted process cannot pin older artifacts indefinitely', t => {
  const projectDir = fixture(t), options = { projectDir, registerExit: false };
  const interrupted = createArtifactRun('interrupted', options);
  const exited = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  const path = join(interrupted.directory, '.run.json'), value = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...value, pid: Number(exited.stdout.trim()), startedAt: '2000-01-01T00:00:00.000Z' }));
  const latest = createArtifactRun('latest', options); latest.finish();
  assert.equal(existsSync(interrupted.directory), false); assert.ok(existsSync(latest.directory));
});
