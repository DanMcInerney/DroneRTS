import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

/** Local helper lifecycle and JSON-lines IPC; never carries peer radio between helpers. */
export class PythonRpc {
  private child?: ChildProcessWithoutNullStreams;
  private serial = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; cleanup(): void }>();
  private ready?: { resolve: () => void; reject: (error: Error) => void };
  private buffer = '';
  private stderr = '';
  private stopping = false;
  private stopPromise?: Promise<void>;
  private startPromise?: Promise<void>;

  constructor(private scriptPath: string, private args: string[] = [], private onEvent: (event: any) => void = () => {}, private pythonPath?: string) {}

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    const projectDir = resolve(dirname(this.scriptPath), '..');
    const python = this.pythonPath ?? process.env.FLEET_PYTHON ?? resolve(projectDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (!existsSync(python)) return Promise.reject(new Error('Network Python is unavailable. Run npm run network:setup (Python 3.12+) or set FLEET_PYTHON.'));
    this.stopping = false;
    this.startPromise = new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => { this.fail(new Error(`Network helper startup timed out: ${this.scriptPath}`)); void this.stop(); }, 25_000);
      this.ready = { resolve: () => { clearTimeout(timer); resolveReady(); }, reject: error => { clearTimeout(timer); rejectReady(error); } };
      this.child = spawn(python, ['-u', this.scriptPath, ...this.args], { cwd: projectDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' } });
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', chunk => {
        this.buffer += chunk;
        if (this.buffer.length > 2_000_000) { this.fail(new Error('Network helper output exceeded limit')); void this.stop(); return; }
        let index: number;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
          if (!line.trim()) continue;
          try { this.receive(JSON.parse(line)); }
          catch { this.fail(new Error('Invalid network helper response')); void this.stop(); return; }
        }
      });
      this.child.stderr.setEncoding('utf8');
      this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-5000); });
      this.child.stdin.on('error', error => { if (!this.stopping) this.fail(error); });
      this.child.on('error', error => this.fail(error));
      this.child.on('exit', code => {
        this.child = undefined;
        if (!this.stopping) this.fail(new Error(`Network helper exited (${code}). ${this.stderr.slice(-1200)}`));
      });
    });
    return this.startPromise;
  }

  private receive(message: any) {
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      pending.cleanup(); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(String(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.event === 'ready') { this.ready?.resolve(); this.ready = undefined; }
    this.onEvent(message);
  }

  private fail(error: Error) {
    this.ready?.reject(error); this.ready = undefined;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
    if (!this.stopping) this.onEvent({ event: 'fatal', message: error.message });
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!this.child || this.child.killed) return Promise.reject(new Error('Network helper is not running'));
    const id = ++this.serial;
    return new Promise((resolveResult, reject) => {
      const cancel = (error: Error) => { this.pending.get(id)?.cleanup(); this.pending.delete(id); reject(error); };
      const abort = () => cancel(signal!.reason);
      const timer = setTimeout(() => cancel(new Error(`Network helper request timed out: ${method}`)), timeoutMs);
      this.pending.set(id, { resolve: resolveResult, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n'); }
      catch (error) { cancel(error as Error); }
    });
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      const child = this.child;
      this.ready?.reject(new Error('Network helper startup cancelled')); this.ready = undefined;
      if (child) {
        await this.request('stop', {}, 1500).catch(() => {});
        child.stdin.end();
        if (child.exitCode === null) await new Promise<void>(resolveExit => {
          const timer = setTimeout(() => { child.kill(); resolveExit(); }, 1500);
          child.once('exit', () => { clearTimeout(timer); resolveExit(); });
        });
      }
      this.fail(new Error('Network helper stopped'));
      this.child = undefined;
    })();
    return this.stopPromise;
  }
}
