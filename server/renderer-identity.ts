import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Same deterministic identity at Vite compilation and server startup. */
export function rendererIdentity(root: string): string {
  const hash = createHash('sha256');
  const visit = (directory: string): string[] => readdirSync(join(root, directory), { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? visit(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]);
  const paths = [...visit('client'), ...visit('shared'), 'index.html', 'package-lock.json'];
  for (const path of paths.sort()) hash.update(path).update('\0').update(readFileSync(join(root, path))).update('\0');
  return hash.digest('hex');
}
