// This host worker boots one isolated QuickJS heap. Guest source is never evaluated by Node.
import { parentPort, workerData } from 'node:worker_threads';
import { posix } from 'node:path';
import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';

const { path: entry, files, argumentJson, limits } = workerData;
let stopped = false, sequence = 0, runtime, vm, main, sliceStart = 0, sliceCpuStart = 0, interrupted = false, cpuSamples = [];
const pending = new Map();
const send = message => { if (!stopped) parentPort.postMessage(message); };
function fail(error) { if (stopped) return; send({ type: 'failed', error: String(error?.message ?? error).slice(0, 1024) }); stopped = true; }
function cpuUsed(now) { cpuSamples = cpuSamples.filter(item => now - item.at < 1000); return cpuSamples.reduce((sum, item) => sum + item.ms, 0); }
function threadCpuMs() { const usage = process.threadCpuUsage(); return (usage.user + usage.system) / 1000; }
function slice(fn) {
  if (stopped) return;
  sliceStart = performance.now(); sliceCpuStart = threadCpuMs(); interrupted = false;
  if (cpuUsed(sliceStart) >= limits.cpuMsPerSecond) { fail('guest_cpu_budget'); return; }
  const result = fn();
  const end = performance.now(), elapsedCpu = threadCpuMs() - sliceCpuStart, bucket = Math.ceil(end / 50) * 50;
  const current = cpuSamples.at(-1);
  if (current?.at === bucket) current.ms += elapsedCpu; else cpuSamples.push({ at: bucket, ms: elapsedCpu });
  if (interrupted || elapsedCpu > limits.sliceMs) { result?.dispose?.(); fail('guest_slice_deadline'); return; }
  if (cpuUsed(end) > limits.cpuMsPerSecond) { result?.dispose?.(); fail('guest_cpu_budget'); return; }
  return result;
}
function errorText(handle) {
  if (vm.typeof(handle) === 'string') return vm.getString(handle).slice(0, 1024);
  // An Error subclass can provide a hostile message getter: read it under the same interrupt budget.
  let message;
  try {
    message = slice(() => vm.getProp(handle, 'message'));
    if (!message || vm.typeof(message) !== 'string') return 'guest_exception';
    const text = vm.getString(message).slice(0, 1024);
    return /out of memory/i.test(text) ? 'guest_heap_limit' : text || 'guest_exception';
  } catch { return 'guest_exception'; } finally { message?.dispose(); }
}
function takeResult(result) {
  if (!result) return;
  if (result.error) { const reason = errorText(result.error); result.dispose(); fail(reason); return; }
  return result.value;
}
function pump() {
  if (stopped || !runtime) return;
  try {
    for (let count = 0; count < 8 && runtime.hasPendingJob() && !stopped; count++) {
      const result = slice(() => runtime.executePendingJobs(1));
      if (!result) return;
      if (result.error) { const reason = errorText(result.error); result.dispose(); fail(reason); return; }
      result.dispose();
    }
    if (main && !stopped) {
      const state = vm.getPromiseState(main);
      if (state.type === 'rejected') { const reason = errorText(state.error); state.error.dispose(); fail(reason); return; }
      if (state.type === 'fulfilled') { state.value.dispose(); if (!pending.size) { send({ type: 'done' }); stopped = true; return; } }
    }
    if (runtime.hasPendingJob() && !stopped) setImmediate(pump);
  } catch (error) { fail(error); }
}
parentPort.on('message', message => {
  if (stopped || message.type !== 'result') return;
  const deferred = pending.get(message.id); if (!deferred) return;
  pending.delete(message.id);
  try {
    slice(() => {
      const value = message.error ? vm.newError(message.error) : vm.newString(message.json);
      try { if (message.error) deferred.reject(value); else deferred.resolve(value); } finally { value.dispose(); deferred.dispose(); }
    });
    pump();
  } catch (error) { fail(error); }
});

try {
  if (typeof process.threadCpuUsage !== 'function') throw new Error('thread_cpu_accounting_unavailable: routines require Node 22.19+ or 24+');
  threadCpuMs();
  // Bound linear memory too: the engine's allocation accounting alone does not
  // cap accumulated ArrayBuffer backing storage. Each worker owns this memory.
  const memoryPages = Math.floor(limits.heapBytes / 65536);
  const wasmMemory = new WebAssembly.Memory({ initial: Math.min(256, memoryPages), maximum: memoryPages });
  const quickJS = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmMemory }));
  runtime = quickJS.newRuntime();
  runtime.setMemoryLimit(limits.heapBytes); runtime.setMaxStackSize(256 * 1024);
  runtime.setInterruptHandler(() => {
    const now = performance.now();
    const currentCpu = threadCpuMs() - sliceCpuStart;
    if (stopped || currentCpu >= limits.sliceMs || cpuUsed(now) + currentCpu >= limits.cpuMsPerSecond) { interrupted = true; return true; }
    return false;
  });
  runtime.setModuleLoader(name => {
    if (!Object.hasOwn(files, name)) throw new Error('module_not_in_workspace_snapshot');
    return files[name].source;
  }, (base, name) => {
    if (!name.startsWith('./') && !name.startsWith('../')) throw new Error('only_relative_workspace_imports');
    const normalized = posix.normalize(posix.join(posix.dirname(base), name));
    if (normalized.startsWith('../') || normalized.startsWith('/') || !/\.m?js$/.test(normalized) || !Object.hasOwn(files, normalized)) throw new Error('module_not_in_workspace_snapshot');
    return normalized;
  });
  vm = runtime.newContext();
  const hostCall = vm.newFunction('__hostCall', (methodHandle, jsonHandle) => {
    if (pending.size >= limits.pendingCalls) { fail('sdk_pending_limit'); return { error: vm.newError('sdk_pending_limit') }; }
    // vm.getString is used only on SDK-created primitive strings; no host-side JSON traversal of guest objects.
    const method = vm.getString(methodHandle), json = vm.getString(jsonHandle);
    if (method.length > 32 || Buffer.byteLength(json) > limits.requestBytes) { fail('sdk_request_too_large'); return { error: vm.newError('sdk_request_too_large') }; }
    const deferred = vm.newPromise(), id = ++sequence; pending.set(id, deferred);
    send({ type: 'call', id, method, json });
    return deferred.handle.dup();
  });
  vm.setProp(vm.global, '__hostCall', hostCall); hostCall.dispose();
  const bootstrap = takeResult(slice(() => vm.evalCode(`
    (() => {
      const host = globalThis.__hostCall; delete globalThis.__hostCall;
      const stringify = JSON.stringify, parse = JSON.parse;
      const call = async (method, args = {}) => parse(await host(method, stringify(args)));
      const files = Object.freeze({
        list: () => call('files.list'), status: () => call('files.status'),
        read: path => call('files.read', {path}), stat: path => call('files.stat', {path}),
        write: (path, content) => call('files.write', {path, content}), delete: path => call('files.delete', {path})
      });
      Object.defineProperty(globalThis, 'input', { value: JSON.parse(${JSON.stringify(argumentJson)}), writable: false, configurable: false });
      Object.defineProperty(globalThis, 'drone', { value: Object.freeze({
        telemetry: () => call('telemetry'), camera: () => call('camera'), events: () => call('events'),
        act: args => call('act', args), send: args => call('send', args), buy: args => call('buy', args),
        fire: (args = {}) => call('fire', args), rearm: (args = {}) => call('rearm', args),
        cameraMode: args => call('cameraMode', args), sleep: ms => call('sleep', {ms}), files
      }), writable: false, configurable: false });
    })();
  `, 'onboard-sdk.js', { type: 'global' })));
  bootstrap?.dispose();
  if (!stopped) {
    send({ type: 'ready' });
    main = takeResult(slice(() => vm.evalCode(files[entry].source, entry, { type: 'module' })));
    pump();
  }
} catch (error) { fail(error); }
setInterval(() => { send({ type: 'heartbeat' }); }, 100);
