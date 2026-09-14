import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { createInterface } from 'node:readline';

function codexCommand(): { command: string; prefix: string[] } {
  if (process.env.CODEX_BIN) return { command: process.env.CODEX_BIN, prefix: [] };
  for (const folder of (process.env.PATH ?? '').split(delimiter)) {
    if (existsSync(join(folder, 'codex.exe'))) return { command: join(folder, 'codex.exe'), prefix: [] };
    const script = join(folder, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(script)) return { command: process.execPath, prefix: [script] };
    if (process.platform !== 'win32' && existsSync(join(folder, 'codex'))) return { command: join(folder, 'codex'), prefix: [] };
  }
  throw new Error('Codex CLI not found. Install Codex and sign in, or set CODEX_BIN to its executable.');
}

export class AppServerRpc {
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;
  constructor(private onMessage: (message: any) => void, private onExit: (message: string) => void) {}

  async start(cwd: string, codexHome: string) {
    const cmd = codexCommand();
    this.process = spawn(cmd.command, [...cmd.prefix, '--dangerously-bypass-hook-trust', 'app-server', '--stdio'], {
      cwd, env: { ...process.env, CODEX_HOME: codexHome }, stdio: 'pipe', windowsHide: true,
    });
    let stderr = '';
    this.process.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-5000); });
    this.process.on('error', error => this.fail(error));
    this.process.on('exit', (code) => {
      this.fail(new Error(`Codex app-server exited (${code}). ${stderr.replace(/\x1b\[[0-9;]*m/g, '').slice(-1400)}`));
    });
    createInterface({ input: this.process.stdout }).on('line', line => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else this.onMessage(message);
    });
    await this.request('initialize', { clientInfo: { name: 'drone_fleet_poc', title: 'Drone Fleet PoC', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.notify('initialized', {});
  }

  request(method: string, params: any = {}, timeoutMs = 30000): Promise<any> {
    if (this.closed || !this.process?.stdin.writable) return Promise.reject(new Error('Codex runtime is not connected.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process!.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  notify(method: string, params: any) { this.process?.stdin.write(`${JSON.stringify({ method, params })}\n`); }
  rejectRequest(id: number | string, reason: string) { this.process?.stdin.write(`${JSON.stringify({ id, error: { code: -32000, message: reason } })}\n`); }
  private fail(error: Error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    if (!this.closed) this.onExit(error.message);
  }
  async stop() {
    if (this.closed) return;
    this.closed = true;
    const proc = this.process;
    if (!proc) return;
    this.fail(new Error('Runtime stopped.'));
    proc.stdin.end();
    await Promise.race([new Promise<void>(resolve => proc.once('exit', () => resolve())), new Promise<void>(resolve => setTimeout(resolve, 1500))]);
    if (proc.exitCode === null) {
      if (process.platform === 'win32' && proc.pid) {
        await new Promise<void>(resolve => { const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('exit', () => resolve()); killer.on('error', () => resolve()); });
      } else proc.kill('SIGTERM');
    }
  }
}
