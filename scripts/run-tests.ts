/** Save the complete suite output as one managed run, with no model inference. */
import { spawn } from 'node:child_process';
import { createWriteStream, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { createArtifactRun } from './test-artifacts.ts';

const run = createArtifactRun('tests');
const files = readdirSync(resolve('tests')).filter(name => name.endsWith('.test.ts')).sort().map(name => resolve('tests', name));
const concurrency = Math.min(4, availableParallelism());
const log = createWriteStream(resolve(run.directory, 'tests.log'));
const started = performance.now();
// Bound file-level parallelism on large developer machines; explicit Node flags override it.
const child = spawn(process.execPath, ['--import', 'tsx', '--test', `--test-concurrency=${concurrency}`, '--test-timeout=60000', ...process.argv.slice(2), ...files], {
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, FLEET_TEST_RUN: '' },
});
// Show progress as it happens while preserving the same managed artifact log.
child.stdout.on('data', chunk => { process.stdout.write(chunk); log.write(chunk); });
child.stderr.on('data', chunk => { process.stderr.write(chunk); log.write(chunk); });
child.on('error', error => { console.error(error); log.write(`${error}\n`); });
log.on('error', error => { console.error(error); process.exitCode = 1; child.kill(); });
const code = await new Promise<number | null>(done => child.once('close', done));
await new Promise<void>(done => log.end(done));
if (!process.exitCode) process.exitCode = code ?? 1;
console.log(`Test wall time: ${((performance.now() - started) / 1000).toFixed(2)}s`);
console.log(`Test artifacts: ${run.directory}`);
