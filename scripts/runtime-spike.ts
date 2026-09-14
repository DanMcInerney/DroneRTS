// A bounded native-runtime test with synthetic sensors, not a game playtest.
import { CodexFleetRuntime } from '../server/runtime.js';
import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
const roles = ['drone-1', 'drone-2', 'drone-3'];
const seen = new Set<string>();
const sent = new Set<string>();
const history: unknown[] = [];
let mission = 0;
let stopped = false;
const pending = new Map<string, (() => void)[]>();
function crc32(b: Buffer) { let c = 0xffffffff; for (const n of b) { c ^= n; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ 0xffffffff) >>> 0; }
function frame(rgb: number[]) {
  const chunk = (name: string, body: Buffer) => { const type = Buffer.from(name); const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, body]))); return Buffer.concat([len, type, body, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(96, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(64 * (96 * 3 + 1)); for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) for (let c = 0; c < 3; c++) rows[y * 289 + 1 + x * 3 + c] = rgb[c];
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const colors = [[240,30,30], [20,225,30], [30,60,240]].map(frame);
const log = (e: unknown) => { history.push(e); console.log(JSON.stringify(e)); };
const text = (x: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(x) }] });
const runtime = new CodexFleetRuntime({
  projectDir: process.cwd(), onStatus: log, onEvent: log,
  toolHandler: async (role, name, args) => {
    seen.add(role);
    if (name === 'forward_next_instruction') {
      if (mission === 0) {
        while (roles.some(role => !seen.has(role)) && !stopped) await new Promise(r => setTimeout(r, 100));
        mission = 1; for (const list of pending.values()) for (const release of list) release(); pending.clear();
        return text({ forwarded: true, mission });
      }
      await new Promise(r => setTimeout(r, 25000)); return text({ stopped, timeout: !stopped });
    }
    if (name === 'observe') return { content: [{ type: 'text', text: JSON.stringify({ mission, pose: { x: 0, y: 8, z: 0, yaw: 0, pitch: 0 }, simTime: 1 }) }, { type: 'image', data: colors[roles.indexOf(role)], mimeType: 'image/png' }] };
    if (name === 'send') { sent.add(role); log({ type: 'radio', role, ...args }); return text({ sent: true }); }
    if (name === 'wait') {
      if (!mission) await new Promise<void>(resolve => { const list = pending.get(role) ?? []; list.push(resolve); pending.set(role, list); setTimeout(resolve, 25000); });
      else if (sent.has(role)) await new Promise(r => setTimeout(r, 25000));
      return text({ mission, cursor: 1, events: stopped ? [{ type: 'stopped' }] : sent.has(role) ? [] : [{ type: 'player', mission, text: 'Runtime sensor test: observe your camera once and send one short radio message naming the color you actually see, then wait. Do not move.' }] });
    }
    return text({ accepted: true });
  },
});
try {
  await runtime.start();
  const deadline = Date.now() + Number(process.env.SPIKE_DURATION_MS ?? 30000);
  while (Date.now() < deadline && sent.size < 3) await new Promise(r => setTimeout(r, 250));
  log({ type: 'spike-result', observedActors: [...seen], radioActors: [...sent], syntheticSensorTestOnly: true });
} catch (error) { log({ type: 'spike-error', message: String(error) }); process.exitCode = 1; }
finally { stopped = true; await runtime.stop(); await writeFile('runtime-spike-evidence.json', JSON.stringify(history, null, 2)); }
