import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const windows = 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe';
const blender = process.env.BLENDER_BIN || (existsSync(windows) ? windows : 'blender');
const result = spawnSync(blender, ['--background', '--python-exit-code', '1', '--python', 'scripts/build-graphics.py'], { stdio: 'inherit', windowsHide: true });
if (result.error) console.error('Set BLENDER_BIN to your Blender executable.', result.error.message);
process.exitCode = result.status ?? 1;
