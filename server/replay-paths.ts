import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export const REPLAY_SESSION = /^session-[A-Za-z0-9_-]+\.jsonl$/;
export const REPLAY_IMAGE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(jpg|png)$/;
export class ReplayError extends Error { constructor(message: string, public status = 400) { super(message); } }
export const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function directory(path: string, parent?: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ReplayError('Replay directory unavailable.', 404);
  const actual = await realpath(path);
  if (parent && !actual.startsWith(parent + sep)) throw new ReplayError('Replay directory unavailable.', 404);
  return actual;
}

/** Both readers and writers enforce the same local-only, non-symlink namespace. */
export async function replayDirectory(root: string, id: string, create = false) {
  if (!REPLAY_SESSION.test(id)) throw new ReplayError('Choose a valid replay session.');
  const artifactRoot = resolve(root);
  if (create) await mkdir(artifactRoot, { recursive: true });
  const actualRoot = await directory(artifactRoot);
  const replayRoot = resolve(actualRoot, 'replays');
  if (create) await mkdir(replayRoot, { recursive: true });
  const actualReplay = await directory(replayRoot, actualRoot);
  const sessionRoot = resolve(actualReplay, id.slice(0, -6));
  if (create) await mkdir(sessionRoot); // A new recorder never overwrites a previous replay.
  return directory(sessionRoot, actualReplay);
}

export async function replayFile(directory: string, filename: string) {
  const path = resolve(directory, filename), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !(await realpath(path)).startsWith(directory + sep)) throw new ReplayError('Replay file unavailable.', 404);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const opened = await file.stat();
  if (opened.dev !== stat.dev || opened.ino !== stat.ino) { await file.close(); throw new ReplayError('Replay file changed; retry.', 409); }
  return file;
}
