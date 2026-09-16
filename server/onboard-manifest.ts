import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface OnboardArtifact { path: string; package: string; version: string; license: string; bytes: number; sha256: string }
export interface OnboardPackageManifest { schema: 'drone-onboard-package/v1'; runtime: 'QuickJS WASM 0.32.0 release-sync'; platform: string; artifacts: OnboardArtifact[]; artifactBytes: number; manifestBytes: number; installedBytes: number; limitBytes: number; fits: boolean; optionalGuestLibraries: never[]; exclusions: string[] }
const localFiles = ['server/onboard-manifest.ts', 'server/onboard-workspace.ts', 'server/routine-runner.ts', 'server/routine-worker.mjs', 'server/radio-transfer.ts', 'server/nervelet.ts', 'server/abort.ts', 'server/onboard-attention.ts', 'server/observation-format.ts', 'server/acoustic-sensor.ts', 'server/rts-geometry.ts', 'shared/acoustic-profile.ts', 'shared/onboard.ts'];
// Runtime imports of the onboard adapter/briefing are charged as well, even when
// their simulator-side implementation also serves other vehicles.
localFiles.push('server/nervelet-results.ts', 'server/runtime-tools.ts', 'server/agent-backend.ts', 'server/drone-motion.ts', 'server/local-sensors.ts',
  'shared/mission.ts', 'shared/fleet.ts', 'shared/rts.ts', 'shared/camera-profile.ts', 'shared/actor-environment.ts');
const measuredBytes = new WeakMap<OnboardPackageManifest, Map<string, Buffer>>();
/** Includes all installed files and every transitive runtime package, even unused variants/source maps. */
export function measureOnboardManifest(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')): OnboardPackageManifest {
  const artifacts: OnboardArtifact[] = [], visited = new Set<string>(), snapshot = new Map<string, Buffer>();
  const addFile = (path: string, pkg: string, version: string, license: string): void => {
    const bytes = readFileSync(path);
    const relativePath = relative(root, path).replaceAll('\\', '/'); snapshot.set(relativePath, bytes);
    artifacts.push({ path: relativePath, package: pkg, version, license, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
  };
  const walk = (directory: string, pkg: string, version: string, license: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, pkg, version, license);
      else if (entry.isFile()) addFile(path, pkg, version, license);
      else throw new Error(`Unexpected onboard package artifact: ${path}`);
    }
  };
  const visit = (name: string, parent = root): void => {
    let directory = parent, packageRoot: string | undefined;
    while (true) { const candidate = join(directory, 'node_modules', name); if (existsSync(join(candidate, 'package.json'))) { packageRoot = candidate; break; } const next = dirname(directory); if (next === directory) break; directory = next; }
    if (!packageRoot) throw new Error(`Missing onboard application dependency ${name}; run npm ci.`);
    if (visited.has(packageRoot)) return; visited.add(packageRoot);
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { name: string; version: string; license: string; dependencies?: Record<string, string> };
    if (pkg.license !== 'MIT' && !(pkg.name === 'fast-uri' && pkg.license === 'BSD-3-Clause')) throw new Error(`Unreviewed onboard package license: ${pkg.name} ${pkg.license}`);
    walk(packageRoot, pkg.name, pkg.version, pkg.license);
    for (const dependency of Object.keys(pkg.dependencies ?? {})) visit(dependency, packageRoot);
  };
  // The umbrella dev package includes unsupported unused variants and exceeds the partition.
  // These are the worker's actual import roots; the full installed contents of each are deployed.
  visit('quickjs-emscripten-core'); visit('@jitl/quickjs-wasmfile-release-sync');
  visit('nervelet'); // Includes Ajv and all its runtime dependencies; no optional driver/serial imports.
  for (const path of localFiles) if (existsSync(join(root, path)) && statSync(join(root, path)).isFile()) addFile(join(root, path), 'DroneRTS onboard SDK', '1', 'Project source; local application');
  artifacts.sort((a,b) => a.path.localeCompare(b.path));
  const artifactBytes = artifacts.reduce((sum, item) => sum + item.bytes, 0);
  const manifest: OnboardPackageManifest = { schema: 'drone-onboard-package/v1', runtime: 'QuickJS WASM 0.32.0 release-sync', platform: `${process.platform}/${process.arch}; Node ${process.versions.node}`, artifacts, artifactBytes, manifestBytes: 0, installedBytes: artifactBytes, limitBytes: 8 * 1024 * 1024, fits: false, optionalGuestLibraries: [], exclusions: ['Node/Python/OS and renderer are fixed simulator infrastructure.', 'Zenoh and pymavlink are fixed network/vehicle platform infrastructure, not guest imports.', 'Inference engine and model weights are separately exempt.', 'Development tools, replay archives and repository files are inaccessible to guests.', 'The unused umbrella quickjs-emscripten development package and debug/asyncify variants are not deployed; their full installation exceeds 8 MiB.'] };
  // Stabilize the decimal byte counters; no self hash is claimed for this metadata file.
  for (let attempt = 0; attempt < 8; attempt++) { const bytes = Buffer.byteLength(JSON.stringify(manifest, null, 2) + '\n'); manifest.manifestBytes = bytes; manifest.installedBytes = artifactBytes + bytes; manifest.fits = manifest.installedBytes <= manifest.limitBytes; }
  measuredBytes.set(manifest, snapshot); return manifest;
}
let cachedManifest: OnboardPackageManifest | undefined;
export function onboardRuntimeBytes(): number {
  cachedManifest ??= measureOnboardManifest();
  if (!cachedManifest.fits) throw new Error(`Onboard runtime partition full: ${cachedManifest.installedBytes}/${cachedManifest.limitBytes} bytes.`);
  return cachedManifest.installedBytes;
}
let deployedWorker: string | undefined;
/** Materialize precisely the measured package instead of borrowing undeclared host application assets. */
export function deployOnboardRuntime(): string {
  if (deployedWorker) return deployedWorker;
  onboardRuntimeBytes();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  // Content versions use a fresh isolated directory: old host archives never become guest files.
  const manifestText = JSON.stringify(cachedManifest!, null, 2) + '\n';
  const packageHash = createHash('sha256').update(manifestText).digest('hex').slice(0, 16);
  const deployment = join(root, '.runtime', 'onboard-application', `${packageHash}-${process.pid}`);
  for (const artifact of cachedManifest!.artifacts) {
    const target = join(deployment, artifact.path); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, measuredBytes.get(cachedManifest!)!.get(artifact.path)!);
    const deployed = readFileSync(target);
    if (deployed.byteLength !== artifact.bytes || createHash('sha256').update(deployed).digest('hex') !== artifact.sha256) throw new Error('Onboard deployment hash mismatch.');
  }
  writeFileSync(join(deployment, 'manifest.json'), manifestText);
  deployedWorker = join(deployment, 'server', 'routine-worker.mjs');
  measuredBytes.delete(cachedManifest!);
  return deployedWorker;
}
