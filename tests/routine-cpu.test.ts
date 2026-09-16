import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { ROUTINE_LIMITS } from '../server/routine-runner.ts';

// Exercise the production worker with a deliberately coarse, monotonic CPU
// counter. Windows can charge a clock tick to a much shorter execution slice.
// Control elapsed time too, so host scheduling cannot change these guard cases.
async function withCoarseCpu(source: string) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const worker = new Worker(`
    let ticks = 0, elapsed = 0;
    process.threadCpuUsage = () => ({ user: (ticks += 16000), system: 0 });
    performance.now = () => ++elapsed;
    import(${JSON.stringify(new URL('../server/routine-worker.mjs', import.meta.url).href)});
  `, { eval: true, execArgv: [], workerData: {
    path: 'entry.js', files: { 'entry.js': { source } }, argumentJson: '{}', limits: ROUTINE_LIMITS,
  } });
  try {
    const result = await new Promise<{ type: string; error?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Coarse CPU fixture exceeded its deadline')), 5000);
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.on('message', message => {
        if (message.type === 'done' || message.type === 'failed') { clearTimeout(timer); resolve(message); }
        if (message.type === 'call') {
          calls.push({ method: message.method, args: JSON.parse(message.json) });
          worker.postMessage({ type: 'result', id: message.id, json: '{"sequence":7}' });
        }
      });
    });
    return { ...result, calls };
  } finally { await worker.terminate(); }
}

test('coarse CPU ticks do not reject a short routine that reads and writes through the SDK', async () => {
  const result = await withCoarseCpu('const own = await drone.telemetry(); await drone.files.write("sample.json", JSON.stringify(own));');
  assert.equal(result.type, 'done', JSON.stringify(result));
  assert.deepEqual(result.calls, [
    { method: 'telemetry', args: {} },
    { method: 'files.write', args: { path: 'sample.json', content: '{"sequence":7}' } },
  ]);
});

test('short slices still accumulate their full CPU counter deltas toward the rolling limit', async () => {
  const result = await withCoarseCpu('for (let n = 0; n < 30; n++) await drone.telemetry();');
  assert.equal(result.type, 'failed', JSON.stringify(result));
  assert.equal(result.error, 'guest_cpu_budget');
  assert.ok(result.calls.length > 0 && result.calls.length < 30, JSON.stringify(result));
});
