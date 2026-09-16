/** Build the pinned, unpublished Nervelet package without depending on a user's absolute path. */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const revision = '54ba0d38e0ee7216212d231020d088da3a3fe435';
const integrity = '8f3ea917f4229fec422e414f3349aff08ef51b22816267ef37be22ffccc8f488';
const root = resolve(import.meta.dirname, '..');
const stage = resolve(root, `.runtime/nervelet-source-${revision.slice(0, 12)}`);
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true, shell: false });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} failed (${result.status})`);
}
mkdirSync(resolve(root, '.runtime'), { recursive: true });
if (!existsSync(resolve(stage, '.git'))) {
  const local = resolve(homedir(), 'tools/nervelet');
  run('git', ['clone', '--no-checkout', process.env.NERVELET_SOURCE ?? (existsSync(resolve(local, '.git')) ? local : 'https://github.com/DanMcInerney/nervelet.git'), stage]);
}
run('git', ['checkout', '--detach', revision], stage);
// Refuse dirty source instead of repairing or privately patching it.
run('git', ['diff', '--exit-code', revision, '--', 'src', 'package.json', 'package-lock.json'], stage);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// npm.cmd requires the Windows command processor; all arguments here are fixed.
const npmRun = args => process.platform === 'win32'
  ? run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `${npm} ${args.join(' ')}`], stage)
  : run(npm, args, stage);
npmRun(['ci', '--ignore-scripts']);
npmRun(['run', 'build']);
npmRun(['pack', '--ignore-scripts', '--pack-destination', '..']);
const archive = resolve(root, `.runtime/nervelet-${revision}.tgz`);
renameSync(resolve(root, '.runtime/nervelet-0.2.0.tgz'), archive);
const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
if (sha256 !== integrity) throw new Error(`Nervelet package integrity mismatch: ${sha256}; expected ${integrity}`);
console.log(JSON.stringify({ revision, archive, sha256 }));
