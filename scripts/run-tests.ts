/** Save the complete suite output as one managed run, with no model inference. */
import { spawn } from 'node:child_process';
import { createWriteStream, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { createArtifactRun } from './test-artifacts.ts';

const run = createArtifactRun('tests');
const files = readdirSync(resolve('tests')).filter(name => name.endsWith('.test.ts')).sort();
const concurrency = Math.min(4, availableParallelism());
// These real-worker fixtures enforce a 20 ms CPU slice. On Windows, coarse CPU
// counters plus competing cold starts make that boundary scheduling-sensitive.
// Give only these three files an isolated phase; keep the rest parallel.
const isolated = new Set(process.platform === 'win32'
  ? ['onboard-game.test.ts', 'onboard-routine.test.ts', 'radio-admission.test.ts'] : []);
const batches = [
  { label: 'Parallel tests', files: files.filter(name => !isolated.has(name)), flags: [] as string[] },
  { label: 'Isolated routine integration tests', files: files.filter(name => isolated.has(name)), flags: ['--test-concurrency=1'] },
];
const log = createWriteStream(resolve(run.directory, 'tests.log'));
const started = performance.now();
let child: ReturnType<typeof spawn> | undefined;
log.on('error', error => { console.error(error); process.exitCode = 1; child?.kill(); });
for (const batch of batches) {
  if (!batch.files.length) continue;
  const heading = `${batch.label}: ${batch.files.length} files\n`;
  process.stdout.write(heading); log.write(heading);
  // Caller flags override the default parallelism; the Windows routine phase stays isolated.
  child = spawn(process.execPath, ['--import', 'tsx', '--test', `--test-concurrency=${concurrency}`, '--test-timeout=60000', ...process.argv.slice(2), ...batch.flags, ...batch.files.map(name => resolve('tests', name))], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, FLEET_TEST_RUN: '' },
  });
  child.stdout!.on('data', chunk => { process.stdout.write(chunk); log.write(chunk); });
  child.stderr!.on('data', chunk => { process.stderr.write(chunk); log.write(chunk); });
  child.on('error', error => { console.error(error); log.write(`${error}\n`); });
  const code = await new Promise<number | null>(done => child!.once('close', done));
  if (code !== 0) process.exitCode = code ?? 1;
  if (process.exitCode) break;
}
await new Promise<void>(done => log.end(done));
console.log(`Test wall time: ${((performance.now() - started) / 1000).toFixed(2)}s`);
console.log(`Test artifacts: ${run.directory}`);
