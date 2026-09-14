/** Save the complete suite output as one managed run, with no model inference. */
import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createArtifactRun } from './test-artifacts.ts';

const run = createArtifactRun('tests');
const files = readdirSync(resolve('tests')).filter(name => name.endsWith('.test.ts')).sort().map(name => resolve('tests', name));
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-timeout=60000', ...process.argv.slice(2), ...files], {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, FLEET_TEST_RUN: '' },
});
writeFileSync(resolve(run.directory, 'tests.log'), (result.stdout ?? '') + (result.stderr ?? '') + (result.error ? String(result.error) : ''));
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
console.log(`Test artifacts: ${run.directory}`);
