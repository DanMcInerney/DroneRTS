/** Offline player-only proximity, viewing-opportunity and tool-timing measurements. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ReplayFrame, ReplayHeader, ReplayObservation, ReplayRecord } from '../shared/replay.ts';
import type { Drone, Pose } from '../shared/types.ts';
import { intersectsBuilding } from '../server/world-geometry.ts';
import { extractObservationBoundaries } from './analysis-boundaries.ts';

if (!process.argv[2]) throw new Error('Usage: node --import tsx scripts/analyze-engagement.ts <saved-trial-directory>');
const directory = resolve(process.argv[2]);
const result = JSON.parse(await readFile(resolve(directory, 'result.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(directory, 'source-manifest.json'), 'utf8'));
// Optics and geometry come from the recording. These implementations own
// segment intersection, camera orientation and the visible body center offset.
for (const file of ['server/world-geometry.ts', 'client/scene.ts', 'client/drone-model.ts']) {
  const current = createHash('sha256').update(await readFile(new URL(`../${file}`, import.meta.url))).digest('hex');
  if (manifest[file] !== current) throw new Error(`Recorded ${file} differs from this checkout; existing engagement analysis was preserved.`);
}
const replayDirectory = resolve(directory, 'replays', result.sessionId.slice(0, -6));
const jsonLines = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const records: ReplayRecord[] = await jsonLines(resolve(replayDirectory, 'frames.jsonl'));
const audit: any[] = await jsonLines(resolve(directory, result.sessionId));
const header = records.find((record): record is ReplayHeader => record.type === 'header')!;
const camera = header.camera as ReplayHeader['camera'] & { fov?: number; near?: number; far?: number };
if (![camera.fov, camera.near, camera.far].every(value => typeof value === 'number' && Number.isFinite(value))) {
  throw new Error('Recorded camera calibration is incomplete; existing engagement analysis was preserved.');
}
const frames = records.filter((record): record is ReplayFrame => record.type === 'frame').sort((a, b) => a.simTime - b.simTime);
const observations = records.filter((record): record is ReplayObservation => record.type === 'observation');
const recordOrder = new Map(records.map((record, index) => [record, index]));
const round = (value: number) => Math.round(value * 1000) / 1000;
const distance = (a: Pick<Pose, 'x' | 'y' | 'z'>, b: Pick<Pose, 'x' | 'y' | 'z'>) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const stats = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { n: 0 };
  const quantile = (p: number) => {
    const index = (sorted.length - 1) * p, below = Math.floor(index), fraction = index - below;
    return round(sorted[below] + (sorted[Math.min(below + 1, sorted.length - 1)] - sorted[below]) * fraction);
  };
  return { n: sorted.length, min: round(sorted[0]), p50: quantile(0.5), p90: quantile(0.9), p95: quantile(0.95), max: round(sorted.at(-1)!), mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length) };
};
const frameAt = (time: number, beforeRecord = Infinity) => {
  let low = 0, high = frames.length;
  while (low < high) { const mid = Math.floor((low + high) / 2); if (frames[mid].simTime <= time) low = mid + 1; else high = mid; }
  let index = Math.max(0, low - 1);
  while (index > 0 && recordOrder.get(frames[index])! >= beforeRecord) index--;
  return frames[index];
};
const livePairs = (frame: ReplayFrame) => frame.drones.flatMap(a => frame.drones
  .filter(b => a.id < b.id && a.team !== b.team && a.alive !== false && b.alive !== false)
  .map(b => ({ a: a.id, b: b.id, distance: distance(a, b) })));
const nearest = frames.map(frame => ({ simTime: frame.simTime, ...livePairs(frame).sort((a, b) => a.distance - b.distance)[0] }));
const usableNearest = nearest.filter(value => Number.isFinite(value.distance));
const nearestSeconds = Object.fromEntries([10, 20, 40, 80, 120].map(limit => [limit, round(nearest.slice(0, -1).reduce((total, item, index) =>
  total + (item.distance <= limit ? nearest[index + 1].simTime - item.simTime : 0), 0))]));
const bodyCenter = (drone: Drone) => ({ x: drone.x, y: drone.y - 0.14, z: drone.z });
const viewing = observations.filter(observation => observation.imageId).flatMap(observation => {
  const frame = frameAt(observation.simTime, recordOrder.get(observation)), self = frame.drones.find(drone => drone.id === observation.drone)!;
  const yaw = observation.pose.yaw * Math.PI / 180, pitch = observation.pose.pitch * Math.PI / 180;
  const forward = { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
  const right = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
  const up = { x: Math.sin(yaw) * Math.sin(pitch), y: Math.cos(pitch), z: Math.cos(yaw) * Math.sin(pitch) };
  // Current recordings preserve the actual capture projection; old recordings use their header.
  const fov = observation.cameraFov ?? camera.fov!;
  if (!Number.isFinite(fov) || fov <= 0 || fov >= 180) throw new Error('Recorded observation has invalid camera calibration.');
  const tanVertical = Math.tan(fov * Math.PI / 360), tanHorizontal = tanVertical * camera.width / camera.height;
  return frame.drones.filter(target => target.team !== self.team && target.alive !== false).map(target => {
    const focus = bodyCenter(target), delta = { x: focus.x - observation.pose.x, y: focus.y - observation.pose.y, z: focus.z - observation.pose.z };
    const dot = (vector: typeof delta) => vector.x * delta.x + vector.y * delta.y + vector.z * delta.z;
    const depth = dot(forward), horizontal = dot(right), vertical = dot(up);
    const inFrustum = depth >= camera.near! && depth <= camera.far!
      && Math.abs(horizontal) <= depth * tanHorizontal && Math.abs(vertical) <= depth * tanVertical;
    const blocker = inFrustum ? header.scene.obstacles.find(building => intersectsBuilding(observation.pose, focus, building)) : undefined;
    return { drone: observation.drone, target: target.id, simTime: round(observation.simTime), imageId: observation.imageId,
      frameAge: round(observation.simTime - frame.simTime), range: round(distance(observation.pose, focus)),
      inFrustum, buildingOccluded: Boolean(blocker), blocker: blocker?.id ?? blocker?.name,
      centerClear: inFrustum && !blocker,
      pixel: inFrustum ? [round(camera.width / 2 * (1 + horizontal / depth / tanHorizontal)), round(camera.height / 2 * (1 - vertical / depth / tanVertical))] : null,
      // Unit reference avoids pretending that a bounding diameter is measured
      // visual recognition. A real body is smaller and depends on orientation.
      projectedPixelsPerUnit: depth > 0 ? round(camera.height / (2 * depth * tanVertical)) : null };
  });
});
const clear = viewing.filter(value => value.centerClear);
const projectionSummary = (values: typeof viewing) => ({
  observationTargetPairs: values.length,
  distinctImages: new Set(values.map(value => value.imageId)).size,
  range: stats(values.map(value => value.range)),
  pixelsPerUnit: stats(values.flatMap(value => value.projectedPixelsPerUnit === null ? [] : [value.projectedPixelsPerUnit])),
});
const paths = Object.fromEntries(header.roster.map(member => {
  const trace = frames.map(frame => ({ simTime: frame.simTime, drone: frame.drones.find(drone => drone.id === member.id)! }));
  let length = 0, movingSeconds = 0;
  for (let index = 1; index < trace.length; index++) {
    const a = trace[index - 1], b = trace[index], step = distance(a.drone, b.drone), dt = b.simTime - a.simTime;
    if (a.drone.alive !== false) { length += step; if (dt > 0 && step / dt > 0.1) movingSeconds += dt; }
  }
  const commands = records.filter(record => record.type === 'command' && record.drone === member.id && record.name === 'act');
  return [member.id, { pathLength: round(length), movingSeconds: round(movingSeconds),
    ranges: Object.fromEntries((['x', 'y', 'z'] as const).map(axis => [axis, [Math.min(...trace.map(value => value.drone[axis])), Math.max(...trace.map(value => value.drone[axis]))].map(round)])),
    maxDistanceFromStart: round(Math.max(...trace.map(value => distance(value.drone, trace[0].drone)))),
    positionsByMinute: Array.from({ length: Math.floor(frames.at(-1)!.simTime / 60) + 1 }, (_, index) => {
      const frame = frameAt(index * 60), drone = frame.drones.find(item => item.id === member.id)!;
      return { time: round(frame.simTime), x: round(drone.x), y: round(drone.y), z: round(drone.z) };
    }),
    movementCommands: commands, clearCenterViews: projectionSummary(clear.filter(value => value.drone === member.id)) }];
}));

const { deliveries, gaps } = extractObservationBoundaries(audit);
const transitions = gaps.map(({ role, from, callMs, nextTool }) => ({
  role, previousTool: from.name, nextTool, callAt: new Date(callMs).toISOString(),
  captureToCallMs: callMs - Date.parse(from.body.sensors?.timestamp?.capturedAt),
  deliveryToCallMs: callMs - Date.parse(from.body.deliveredAt),
  nativeCompletionToCallMs: from.completedMs === undefined ? null : callMs - from.completedMs,
}));
const transitionStats = (values: typeof transitions) => ({
  captureToNextCallMs: stats(values.map(value => value.captureToCallMs)),
  deliveryToNextCallMs: stats(values.map(value => value.deliveryToCallMs)),
  nativeCompletionToNextCallMs: stats(values.flatMap(value => value.nativeCompletionToCallMs === null ? [] : [value.nativeCompletionToCallMs])),
});
const summary = {
  scenario: result.scenario, revision: result.revision, manifestSha256: result.manifestSha256,
  frames: frames.length, observations: observations.length, duration: round(frames.at(-1)!.simTime),
  units: 'Distances and positions are simulator-local units. Times are seconds except fields ending Ms. Quantiles interpolate sorted observations; frame summaries are sample-weighted, duration summaries integrate preceding samples.',
  proximity: { nearestPairDistance: stats(usableNearest.map(value => value.distance)),
    closestSample: usableNearest.reduce((a, b) => a.distance < b.distance ? a : b),
    secondsWithAnyOpponentPairWithin: nearestSeconds,
    byMinute: Array.from({ length: Math.ceil(frames.at(-1)!.simTime / 60) }, (_, index) => ({
      minute: index + 1, nearestPairDistance: stats(usableNearest.filter(value => value.simTime >= index * 60 && value.simTime < (index + 1) * 60).map(value => value.distance)),
    })) },
  viewing: { evaluatedPairs: viewing.length, camera: header.camera, peerFrameAge: stats(viewing.map(value => value.frameAge)),
    inFrustum: projectionSummary(viewing.filter(value => value.inFrustum)),
    buildingBlockedPairs: viewing.filter(value => value.buildingOccluded).length,
    centerClear: projectionSummary(clear),
    clearPairsWithinRange: Object.fromEntries([10, 20, 40, 80, 120].map(limit => [limit, projectionSummary(clear.filter(value => value.range <= limit))])),
    opportunities: clear },
  paths,
  timing: { unit: 'milliseconds', observationsWithDelivery: deliveries.length,
    captureToDeliveryMs: stats(deliveries.map(value => Date.parse(value.body.deliveredAt) - Date.parse(value.body.sensors?.timestamp?.capturedAt))),
    serverResultToNativeCompletionMs: stats(deliveries.flatMap(value => value.completedMs === undefined ? [] : [value.completedMs - value.wallMs])),
    allTransitions: transitionStats(transitions),
    byNextTool: Object.fromEntries([...new Set(transitions.map(value => value.nextTool))].map(name => [name, transitionStats(transitions.filter(value => value.nextTool === name))])),
    byRole: Object.fromEntries(header.roster.map(member => [member.id, transitionStats(transitions.filter(value => value.role === member.id))])),
    fireTransitions: transitions.filter(value => value.nextTool === 'fire') },
  radio: audit.filter(record => record.type === 'radio' && record.value.from !== 'player').map(record => record.value),
  limitations: [
    'Viewing is a body-center frustum/building-occlusion proxy at delivered images, not proof of perception or recognizability. It omits partial silhouettes, terrain/props/drone occlusion, fog, lighting, JPEG loss and projected orientation. Actual camera files remain authoritative.',
    'Observer pose is exact acquisition evidence; opponent poses use the latest sampled frame at or before acquisition, preceding the observation in file order. Frame age is reported. No later simulation times or interpolated positions are used; same-tick mutations during image delivery cannot be reconstructed exactly.',
    'Proximity duration integrates preceding samples and movement speed uses sampled positions; duplicate forced frames receive zero duration. Neither proves agent intent.',
    'Capture-to-delivery includes MAVLink sample, browser round trip and encoding. Delivery-to-call includes response transport, model inference and tool dispatch/hooks; logs do not isolate private reasoning. Native completion is an app-server event, not a model-read timestamp.',
    'Each observation contributes at most its first following tool call in per-drone audit order; error-only outputs are not observations. A final delivery without a next call is excluded from transition distributions. Deliberate wait duration is not mislabeled inference time: each transition begins after the previous wait returns.',
  ],
};
await writeFile(resolve(directory, 'engagement-analysis.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, paths: Object.fromEntries(Object.entries(paths).map(([id, path]) => [id, { ...path, movementCommands: undefined, positionsByMinute: undefined }])),
  viewing: { ...summary.viewing, opportunities: undefined }, radio: undefined,
  timing: { ...summary.timing, byNextTool: undefined, byRole: undefined, fireTransitions: undefined } }, null, 2));
