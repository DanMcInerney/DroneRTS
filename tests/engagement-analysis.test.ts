import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FleetGame } from '../server/game.ts';
import { MATCH_FLEET } from '../shared/fleet.ts';

const run = promisify(execFile);
test('engagement measurements separate delivery from decisions and use past geometry with occlusion', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-engagement-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionId = 'session-fixture.jsonl', session = join(directory, 'replays', 'session-fixture');
  await mkdir(session, { recursive: true });
  await writeFile(join(directory, 'result.json'), JSON.stringify({ sessionId, scenario: 'fixture' }));
  const manifest = Object.fromEntries(await Promise.all(['server/world-geometry.ts', 'client/scene.ts', 'client/drone-model.ts'].map(async file =>
    [file, createHash('sha256').update(await readFile(new URL(`../${file}`, import.meta.url))).digest('hex')])));
  await writeFile(join(directory, 'source-manifest.json'), JSON.stringify(manifest));
  const game = new FleetGame();
  const poses = [[0, 10, 0], [100, 10, 100], [110, 10, 100], [0, 10, -14], [8, 10, -14], [0, 10, 14]];
  game.state.drones.forEach((drone, i) => Object.assign(drone, { x: poses[i][0], y: poses[i][1], z: poses[i][2], yaw: 0, pitch: 0 }));
  const frame = { type: 'frame', simTime: 0, drones: structuredClone(game.state.drones) };
  const future = structuredClone(frame); future.simTime = 0.6; future.drones[3].z = -300;
  const records = [{ type: 'header', roster: MATCH_FLEET, camera: { width: 512, height: 288, fov: 76, near: 0.08, far: 500 },
    scene: { obstacles: [{ id: 'wall', x: 0, z: -7, width: 2, depth: 2, height: 20, rotation: 0 }] } },
    frame, { type: 'observation', drone: 'drone-1', simTime: 0.5, pose: game.state.drones[0], imageId: 'camera.jpg' }, future];
  await writeFile(join(session, 'frames.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const audit = [
    { wallTime: '2026-09-14T00:00:01.010Z', type: 'agent', value: { type: 'tool-result', role: 'drone-1', name: 'observe', result: { content: [{ type: 'text', text: JSON.stringify({
      sensors: { timestamp: { capturedAt: '2026-09-14T00:00:01.000Z', simTime: 0.5 } }, deliveredAt: '2026-09-14T00:00:01.010Z' }) }] } } },
    { wallTime: '2026-09-14T00:00:01.050Z', type: 'agent', value: { type: 'mcp-result', role: 'drone-1', tool: 'observe' } },
    { wallTime: '2026-09-14T00:00:05.010Z', type: 'agent', value: { type: 'tool', role: 'drone-1', name: 'fire' } },
  ];
  await writeFile(join(directory, sessionId), audit.map(r => JSON.stringify(r)).join('\n') + '\n');
  await run(process.execPath, ['--import', 'tsx', 'scripts/analyze-engagement.ts', directory]);
  const result = JSON.parse(await readFile(join(directory, 'engagement-analysis.json'), 'utf8'));
  assert.equal(result.timing.captureToDeliveryMs.p50, 10);
  assert.equal(result.timing.allTransitions.deliveryToNextCallMs.p50, 4000);
  assert.equal(result.timing.allTransitions.captureToNextCallMs.p50, 4010);
  assert.equal(result.timing.allTransitions.nativeCompletionToNextCallMs.p50, 3960);
  assert.equal(result.viewing.evaluatedPairs, 3);
  assert.equal(result.viewing.inFrustum.observationTargetPairs, 2);
  assert.equal(result.viewing.buildingBlockedPairs, 1);
  assert.equal(result.viewing.centerClear.distinctImages, 1);
  assert.equal(result.viewing.opportunities[0].target, 'drone-5');
  assert.equal(result.viewing.peerFrameAge.p50, 0.5);

  // A zoomed acquisition has its own projection even if the sampled drone state is older.
  const zoomRecords = records.map(record => record.type === 'observation' ? { ...record, cameraFov: 20 } : record);
  await writeFile(join(session, 'frames.jsonl'), zoomRecords.map(r => JSON.stringify(r)).join('\n') + '\n');
  await run(process.execPath, ['--import', 'tsx', 'scripts/analyze-engagement.ts', directory]);
  const zoom = JSON.parse(await readFile(join(directory, 'engagement-analysis.json'), 'utf8'));
  assert.equal(zoom.viewing.inFrustum.observationTargetPairs, 1);
  assert.equal(zoom.viewing.centerClear.distinctImages, 0);

  manifest['client/drone-model.ts'] = 'historical-body-geometry';
  await writeFile(join(directory, 'source-manifest.json'), JSON.stringify(manifest));
  const preserved = await readFile(join(directory, 'engagement-analysis.json'), 'utf8');
  await assert.rejects(run(process.execPath, ['--import', 'tsx', 'scripts/analyze-engagement.ts', directory]), /differs from this checkout/);
  assert.equal(await readFile(join(directory, 'engagement-analysis.json'), 'utf8'), preserved);
});
