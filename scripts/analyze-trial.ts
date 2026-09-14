/** Reproducible, player-only analysis of saved focused-trial evidence. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ReplayFrame, ReplayObservation, ReplayRecord } from '../shared/replay.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';
import type { Point } from '../shared/rts.ts';
import { RTS_CONFIG } from '../shared/rts.ts';

const directory = resolve(process.argv[2]);
const result = JSON.parse(await readFile(resolve(directory, 'result.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(directory, 'source-manifest.json'), 'utf8'));
const currentCalibration = createHash('sha256').update(await readFile(new URL('../shared/rts.ts', import.meta.url))).digest('hex');
if (manifest['shared/rts.ts'] !== currentCalibration) {
  throw new Error('Replay calibration differs from this checkout. Analyze with the recorded shared/rts.ts revision; existing analysis was preserved.');
}
const replayDir = resolve(directory, 'replays', result.sessionId.slice(0, -6));
const records: ReplayRecord[] = (await readFile(resolve(replayDir, 'frames.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const audit: any[] = (await readFile(resolve(directory, result.sessionId), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const frames = records.filter((r): r is ReplayFrame => r.type === 'frame');
const observations = records.filter((r): r is ReplayObservation => r.type === 'observation').sort((a, b) => a.simTime - b.simTime);
const commands = records.filter(r => r.type === 'command');
const events = records.filter(r => r.type === 'event').map(r => r.event);
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const wrap = (a: number) => ((a + 180) % 360 + 360) % 360 - 180;
const count = (items: string[]) => Object.fromEntries([...new Set(items)].map(key => [key, items.filter(item => item === key).length]));
const rounded = (n: number) => Math.round(n * 1000) / 1000;
const bodies = audit.filter(r => r.type === 'agent' && r.value.type === 'tool-result').flatMap(r => {
  try { return [{ role: r.value.role, name: r.value.name, body: JSON.parse(r.value.result.content[0].text) }]; } catch { return []; }
});
const drones = Object.fromEntries(MATCH_DRONE_IDS.map(id => {
  const trace = frames.map(f => ({ time: f.simTime, drone: f.drones.find(d => d.id === id)! }));
  let path = 0, yawTravel = 0, movingSeconds = 0;
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1], b = trace[i], step = distance(a.drone, b.drone), dt = b.time - a.time;
    if (a.drone.alive !== false) { path += step; yawTravel += Math.abs(wrap(b.drone.yaw - a.drone.yaw)); if (dt > 0 && step / dt > 0.1) movingSeconds += dt; }
  }
  const own = commands.filter(c => c.drone === id);
  const ownBodies = bodies.filter(b => b.role === id);
  const inboxEvents = ownBodies.flatMap(b => b.body.events ?? []);
  return [id, { observations: observations.filter(o => o.drone === id).length,
    missingImages: observations.filter(o => o.drone === id && !o.imageId).length,
    commands: count(own.map(c => c.name === 'act' ? String(c.args.kind) : c.name)),
    deliveredEvents: count(inboxEvents.map(e => e.type)),
    rejected: ownBodies.filter(b => b.body.rejected || b.body.error).map(b => ({ tool: b.name, reason: b.body.reason ?? b.body.error })),
    pathLength: rounded(path), yawTravelDegrees: rounded(yawTravel), movingSeconds: rounded(movingSeconds),
    altitudeRange: [Math.min(...trace.map(t => t.drone.y)), Math.max(...trace.map(t => t.drone.y))].map(rounded),
    finalAlive: trace.at(-1)!.drone.alive, initial: trace[0].drone, final: trace.at(-1)!.drone }];
}));
const shots = events.filter(e => e.type === 'fired').map(event => {
  // The host records a forced frame at the fire event. Choose that exact state,
  // falling back to a preceding sample only if analyzing another recorder.
  const eventIndex = records.findIndex(r => r.type === 'event' && r.event.id === event.id);
  const preceding = records.slice(0, eventIndex);
  const frame = preceding.findLast((r): r is ReplayFrame => r.type === 'frame' && r.simTime <= event.simTime)!;
  const shooter = frame.drones.find(d => d.id === event.drone)!;
  const yaw = shooter.yaw * Math.PI / 180, pitch = shooter.pitch * Math.PI / 180;
  const forward = { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
  const previous = frames.findLast(f => f.simTime < frame.simTime - 0.05);
  const targets = frame.drones.filter(d => d.team !== shooter.team && d.alive !== false).map(target => {
    const range = distance(shooter, target), delta = { x: target.x - shooter.x, y: target.y - shooter.y, z: target.z - shooter.z };
    const along = delta.x * forward.x + delta.y * forward.y + delta.z * forward.z;
    const angularError = Math.acos(Math.max(-1, Math.min(1, along / range))) * 180 / Math.PI;
    const before = previous?.drones.find(d => d.id === target.id);
    const targetSpeed = before && previous ? distance(before, target) / (frame.simTime - previous.simTime) : undefined;
    // Diagnostic comparison assumes the target freezes at firing time. It is not
    // a prediction supplied to an actor or a claim about actual future motion.
    const time = Math.max(0, along / RTS_CONFIG.bulletSpeed);
    const bulletAtProjection = { x: shooter.x + forward.x * RTS_CONFIG.bulletSpeed * time,
      y: shooter.y + forward.y * RTS_CONFIG.bulletSpeed * time - RTS_CONFIG.bulletGravity * time * time / 2,
      z: shooter.z + forward.z * RTS_CONFIG.bulletSpeed * time };
    return { drone: target.id, range: rounded(range), angularError: rounded(angularError), targetSpeed: targetSpeed === undefined ? null : rounded(targetSpeed),
      projectedTravelSeconds: rounded(time), frozenTargetMissAtProjection: rounded(distance(bulletAtProjection, target)) };
  }).sort((a, b) => a.angularError - b.angularError);
  // A fire result may capture at the same simulation time after the event; it
  // cannot be evidence the actor used to decide that shot. Preserve file order.
  const camera = preceding.findLast((r): r is ReplayObservation => r.type === 'observation' && r.drone === shooter.id && r.simTime <= event.simTime);
  const contacts = events.filter(e => e.projectileId === event.projectileId && e.type !== 'fired');
  const impact = contacts.find(e => e.type === 'impact');
  const hitFrame = impact && frames.findLast(f => f.simTime <= impact.simTime);
  const hitTarget = hitFrame?.drones.find(d => d.id === impact?.target);
  const beforeHit = impact && frames.findLast(f => f.simTime < impact.simTime - 0.05);
  const previousTarget = beforeHit?.drones.find(d => d.id === impact?.target);
  const impactSpeed = hitTarget && previousTarget && impact && beforeHit
    ? distance(hitTarget, previousTarget) / (impact.simTime - beforeHit.simTime) : null;
  const outcome = impact ? impact.cause === 'bullet' ? 'drone-hit' : 'terrain-impact'
    : contacts.some(e => e.type === 'projectile_expired') ? 'expired'
    : result.naturalCompletion ? 'unresolved-at-match-end' : 'unresolved-at-trial-stop';
  return { simTime: event.simTime, shooter: shooter.id, pose: { x: shooter.x, y: shooter.y, z: shooter.z, yaw: shooter.yaw, pitch: shooter.pitch },
    frameAge: event.simTime - frame.simTime, cameraAge: camera ? event.simTime - camera.simTime : null,
    cameraImage: camera?.imageId, targets, contacts, outcome,
    travelUntilImpact: impact ? impact.simTime - event.simTime : null,
    targetSpeedBeforeImpact: impactSpeed === null ? null : rounded(impactSpeed) };
});
const summary = { scenario: result.scenario, revision: result.revision, manifestSha256: result.manifestSha256,
  simSeconds: frames.at(-1)?.simTime, endReason: result.endReason, naturalCompletion: result.naturalCompletion, winner: result.winner,
  failures: result.failures, warnings: result.warnings, verifiedModels: audit.filter(r => r.type === 'agent' && r.value.type === 'model-verified').map(r => r.value),
  nativeSpawns: audit.filter(r => r.type === 'agent' && r.value.type === 'native-agent-call').map(r => r.value),
  actors: result.finalState?.runtime.children, events: count(events.map(e => e.type)),
  errors: audit.filter(r => ['tool-error', 'transport-error', 'trial-error'].includes(r.type)
    || r.type === 'agent' && /error|denied/.test(r.value.type ?? '')),
  peerMessages: audit.filter(r => r.type === 'radio' && r.value.from !== 'player').length,
  teamEconomy: frames.at(-1)?.match?.teams, resources: frames.at(-1)?.match?.resources,
  replayEnd: records.findLast(r => r.type === 'end'), drones, shots, shotOutcomes: count(shots.map(s => s.outcome)),
  limits: 'Path length and target speed use sampled player poses. Frozen-target miss is diagnostic only. Fixture guns and initial enemy visibility do not prove autonomous economy, discovery, or match skill.',
};
await writeFile(resolve(directory, 'analysis.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, drones: Object.fromEntries(Object.entries(drones).map(([id, d]) => [id, { ...d, initial: undefined, final: undefined }])),
  shots: shots.map(s => ({ ...s, pose: undefined, targets: s.targets.slice(0, 1) })) }, null, 2));
