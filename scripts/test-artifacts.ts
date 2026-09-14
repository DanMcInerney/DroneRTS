/** One retained test run across runners. Player session archives are never swept. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const schema = 'fleet-test-artifacts/1';
type Marker = { schema: string; id: string; pid: number; startedAt: string; completed: boolean };

function inside(root: string, target: string) {
  const path = relative(root, target);
  if (!path || path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(path)) {
    throw new Error(`Test artifact path must be inside ${root}: ${target}`);
  }
}

function directory(path: string) {
  // Reject junctions/symlinks at every existing ancestor before creating/deleting anything.
  for (let current = resolve(path); ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Linked artifact path: ${current}`);
    if (dirname(current) === current) break;
  }
  mkdirSync(path, { recursive: true });
  return realpathSync(path);
}

function marker(path: string): Marker | undefined {
  try {
    if (lstatSync(path).isSymbolicLink() || lstatSync(resolve(path, '.run.json')).isSymbolicLink()) return;
    const value = JSON.parse(readFileSync(resolve(path, '.run.json'), 'utf8'));
    if (value.schema === schema && value.id === basename(path) && Number.isInteger(value.pid)
      && value.pid > 0 && typeof value.startedAt === 'string' && typeof value.completed === 'boolean') return value;
  } catch { /* Unregistered directories are not test-run deletion targets. */ }
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Called only after a runner closes its writers. Dead interrupted runs count as evidence too. */
export function pruneTestRuns(projectDir = project) {
  const root = directory(resolve(projectDir, 'artifacts/test-runs'));
  const runs = readdirSync(root).map(name => {
    const path = resolve(root, name); inside(root, path);
    return { path, value: marker(path) };
  }).filter(run => run.value && (run.value.completed || !alive(run.value.pid)))
    .sort((a, b) => b.value!.startedAt.localeCompare(a.value!.startedAt) || b.value!.id.localeCompare(a.value!.id));
  const removed: string[] = [];
  for (const run of runs.slice(1)) {
    // Recheck ownership and confinement immediately before a recursive delete.
    inside(root, run.path);
    const value = marker(run.path);
    if (!value || !value.completed && alive(value.pid)) continue;
    directory(run.path);
    rmSync(run.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    removed.push(run.path);
  }
  return { latest: runs[0]?.path, removed };
}

export function createArtifactRun(kind: string, options: { projectDir?: string; output?: string; registerExit?: boolean } = {}) {
  if (!/^[a-z0-9-]+$/.test(kind)) throw new Error('Invalid test run kind');
  const projectDir = options.projectDir ?? project;
  const root = directory(resolve(projectDir, 'artifacts/test-runs'));
  const group = process.env.FLEET_TEST_RUN;
  if (group) {
    const path = resolve(group); inside(root, path);
    const owner = marker(path);
    if (dirname(path) !== root || !owner || owner.completed || !alive(owner.pid)) throw new Error('FLEET_TEST_RUN must name an active managed run');
    const output = directory(resolve(path, kind));
    return { directory: output, finish() {}, collectNetwork: (session: string) => collectNetwork(projectDir, output, session),
      collectSession: (session: string) => collectSession(projectDir, output, session) };
  }
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${kind}-${randomUUID().slice(0, 8)}`;
  const output = resolve(options.output ?? resolve(root, id));
  inside(root, output);
  if (dirname(output) !== root) throw new Error('FLEET_QA_OUTPUT must be a new direct child of artifacts/test-runs');
  if (existsSync(output)) throw new Error(`Refusing to overwrite test run: ${output}`);
  directory(output);
  const value: Marker = { schema, id: basename(output), pid: process.pid, startedAt: new Date().toISOString(), completed: false };
  const save = () => writeFileSync(resolve(output, '.run.json'), JSON.stringify(value, null, 2));
  save();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true; value.completed = true; save();
    const result = pruneTestRuns(projectDir);
    if (result.removed.length) console.log(`Removed ${result.removed.length} older test run(s); kept ${result.latest}`);
  };
  if (options.registerExit !== false) process.once('exit', () => {
    try { finish(); } catch (error) { console.error(`Test artifact cleanup failed: ${error}`); process.exitCode = 1; }
  });
  return { directory: output, finish, collectNetwork: (session: string) => collectNetwork(projectDir, output, session),
    collectSession: (session: string) => collectSession(projectDir, output, session) };
}

function collectSession(projectDir: string, output: string, session: string) {
  if (!/^session-[a-zA-Z0-9-]+\.jsonl$/.test(session)) throw new Error('Invalid session audit filename');
  const root = directory(resolve(projectDir, 'artifacts')), source = resolve(root, session);
  inside(root, source);
  if (!existsSync(source)) return;
  if (lstatSync(source).isSymbolicLink()) throw new Error('Linked session audit');
  const records = readFileSync(source, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const sessions = new Set<string>(records.filter(record => ['radio', 'player-radio'].includes(record.type))
    .map(record => record.value?.sessionId).filter((id): id is string => typeof id === 'string'));
  for (const id of sessions) collectNetwork(projectDir, output, id);
  const replay = resolve(root, 'replays', session.slice(0, -6));
  inside(root, replay);
  if (existsSync(replay)) {
    directory(replay); directory(resolve(output, 'replays'));
    renameSync(replay, resolve(output, 'replays', basename(replay)));
  }
  directory(output); renameSync(source, resolve(output, session));
}

function collectNetwork(projectDir: string, output: string, session: string) {
  if (!/^[\da-f-]{36}$/i.test(session)) throw new Error('Invalid network session');
  const root = resolve(projectDir, 'artifacts/network'), source = resolve(root, session);
  inside(root, source);
  if (!existsSync(source)) return;
  directory(source); directory(output);
  // The caller has stopped its own network helpers before moving their stores.
  renameSync(source, resolve(output, `network-${session}`));
}
