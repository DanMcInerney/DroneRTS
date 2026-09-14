import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const local = resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, shell: false });
  if (result.error || result.status !== 0) { console.error(result.error?.message ?? 'Python dependency setup failed'); process.exit(1); }
}
if (!existsSync(local)) run(process.env.FLEET_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), ['-m', 'venv', '.venv']);
run(local, ['-m', 'pip', 'install', '-r', 'network/requirements.txt']);
