import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { measureOnboardManifest } from '../server/onboard-manifest.ts';

const manifest = measureOnboardManifest();
const output = resolve('ONBOARD-PACKAGE-MANIFEST.json');
writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ output, platform: manifest.platform, installedBytes: manifest.installedBytes, limitBytes: manifest.limitBytes, fits: manifest.fits, artifactCount: manifest.artifacts.length }));
if (!manifest.fits) process.exitCode = 1;
