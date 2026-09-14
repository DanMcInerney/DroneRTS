/** Deterministic developer fixtures only: no model, browser, server, or live transport. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FleetGame } from '../server/game.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';
import { RTS_CONFIG, type Point } from '../shared/rts.ts';
import type { Drone, DroneId, Obstacle, ToolResult } from '../shared/types.ts';

const wrap = (value: number) => ((value + 180) % 360 + 360) % 360 - 180;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const pose = (d: Drone) => ({ x: d.x, y: d.y, z: d.z, yaw: d.yaw, pitch: d.pitch });
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const body = (result: ToolResult) => JSON.parse(result.content.find(c => c.type === 'text')!.text);
// A one-pixel placeholder satisfies the isolated unit-test sensor seam. It is not scene evidence.
const SYNTHETIC_CAMERA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1QAAAAASUVORK5CYII=';
type Sample = ReturnType<typeof sample>;
type Metrics = Record<string, string | boolean | number | null>;
function sample(game: FleetGame) {
  return { time: game.state.simTime, drones: game.state.drones.map(d => ({ id: d.id, ...pose(d), alive: d.alive,
    action: d.action?.id ?? null, armor: d.equipment?.armor })), projectiles: structuredClone(game.state.match!.projectiles) };
}

class Fixture {
  game = new FleetGame();
  trace: Sample[] = [];
  commands: unknown[] = [];
  constructor(readonly name: string, readonly tickSeconds: number) {}
  get drone() { return this.game.state.drones[0]; }
  get target() { return this.game.state.drones[3]; }
  async ready() {
    this.game.setConnected(true); this.game.start(); this.game.state.obstacles = [];
    this.game.state.match!.resources = [];
    this.game.capture = async () => SYNTHETIC_CAMERA;
    this.game.state.drones.forEach((d, i) => Object.assign(d, { x: 100 + 10 * i, y: 20, z: 100, yaw: 0, pitch: 0 }));
    Object.assign(this.drone, { x: 0, y: 10, z: 0 });
    for (const id of MATCH_DRONE_IDS) await this.game.tool(id, 'observe');
    for (const team of ['blue', 'red'] as const) {
      this.game.queueMission('Developer deterministic fixture; no actor inference.', team);
      await this.game.forwardTeam(team);
    }
    this.trace.push(sample(this.game));
    return this;
  }
  async command(args: Record<string, unknown>, id: DroneId = this.drone.id, name = 'act') {
    const result = await this.game.tool(id, name, { mission: 1, ...args });
    const value = body(result);
    this.commands.push({ time: this.game.state.simTime, id, name, args, result: value });
    assert.ok(!result.isError && !value.rejected && !value.stopped, JSON.stringify(value));
    return value;
  }
  advance(seconds: number) {
    const end = this.game.state.simTime + seconds;
    while (this.game.state.running && this.game.state.simTime < end - 1e-9) {
      this.game.tick(Math.min(this.tickSeconds, end - this.game.state.simTime));
      this.trace.push(sample(this.game));
    }
  }
  until(test: () => boolean, limit: number) {
    const end = this.game.state.simTime + limit;
    while (!test() && this.game.state.running && this.game.state.simTime < end - 1e-9) {
      this.advance(Math.min(this.tickSeconds, end - this.game.state.simTime));
    }
    return test();
  }
  finish(metrics: Metrics, setup: unknown = {}) {
    const result = { name: this.name, tickSeconds: this.tickSeconds, setup, metrics,
      commands: this.commands, trace: this.trace, events: structuredClone(this.game.state.match!.events),
      inboxes: Object.fromEntries(MATCH_DRONE_IDS.map(id => [id, structuredClone(this.game.inboxes[id].events)])) };
    this.game.stop(); return result;
  }
}
type Result = ReturnType<Fixture['finish']>;

async function turn(tick: number, yaw: number, targetYaw: number, targetPitch = 0): Promise<Result> {
  const f = await new Fixture(`turn_${yaw}_to_${targetYaw}_pitch_${targetPitch}`, tick).ready();
  Object.assign(f.drone, { yaw }); f.trace = [sample(f.game)];
  await f.command({ kind: 'look', heading: -targetYaw, pitch: targetPitch });
  f.advance(6);
  const samples = f.trace.map(s => ({ time: s.time, ...s.drones[0] }));
  let yawTravel = 0, maxYawRate = 0, maxPitchRate = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i], dt = b.time - a.time, delta = wrap(b.yaw - a.yaw);
    yawTravel += delta; maxYawRate = Math.max(maxYawRate, Math.abs(delta / dt));
    maxPitchRate = Math.max(maxPitchRate, Math.abs((b.pitch - a.pitch) / dt));
  }
  const settled = samples.findIndex((s, i) => Math.abs(wrap(targetYaw - s.yaw)) <= 0.1
    && Math.abs(targetPitch - s.pitch) <= 0.1 && samples.slice(i).every(v => Math.abs(wrap(targetYaw - v.yaw)) <= 0.1 && Math.abs(targetPitch - v.pitch) <= 0.1));
  assert.ok(Math.abs(wrap(f.drone.yaw - targetYaw)) < 1e-6);
  assert.ok(Math.abs(f.drone.pitch - targetPitch) < 1e-6);
  assert.ok(Math.abs(yawTravel - wrap(targetYaw - yaw)) < 1e-6);
  return f.finish({ signedYawTravelDegrees: round(yawTravel), maxSampleYawRateDegreesPerSecond: round(maxYawRate),
    maxSamplePitchRateDegreesPerSecond: round(maxPitchRate), settledWithinPointOneDegreeSeconds: samples[settled] ? round(samples[settled].time) : null,
    finalYawErrorDegrees: round(wrap(f.drone.yaw - targetYaw)), finalPitchErrorDegrees: round(f.drone.pitch - targetPitch) },
  { initialYaw: yaw, targetYaw, targetPitch, durationSeconds: 6 });
}

async function waypoint(tick: number, length: number): Promise<Result> {
  const f = await new Fixture(`waypoint_${length}`, tick).ready(), start = pose(f.drone);
  const target = { x: length, y: 10, z: 0 };
  await f.command({ kind: 'fly_to', ...target });
  const arrived = f.until(() => !f.drone.action, 15);
  const atArrival = f.game.state.simTime; f.advance(1);
  const arrivals = f.game.inboxes[f.drone.id].events.filter(e => e.type === 'arrived');
  const speeds = f.trace.slice(1).map((s, i) => distance(s.drones[0], f.trace[i].drones[0]) / (s.time - f.trace[i].time));
  const maxOvershoot = Math.max(0, ...f.trace.map(s => s.drones[0].x - target.x));
  assert.ok(arrived && f.drone.alive); assert.equal(arrivals.length, 1); assert.equal(distance(f.drone, target), 0);
  return f.finish({ arrived, arrivalEventSeconds: arrivals[0].simTime as number, arrivalObservedSeconds: round(atArrival),
    finalErrorWorldUnits: distance(f.drone, target), maxOvershootWorldUnits: round(maxOvershoot),
    maxSampleSpeedWorldUnitsPerSecond: round(Math.max(...speeds)), arrivalEvents: arrivals.length }, { start, target });
}

async function hover(tick: number, reverse: boolean): Promise<Result> {
  const f = await new Fixture(reverse ? 'reverse_then_hover' : 'cruise_then_hover', tick).ready();
  await f.command({ kind: 'fly_to', x: 60, y: 10, z: 0 }); f.advance(1);
  const atCommand = pose(f.drone), commandTime = f.game.state.simTime;
  if (reverse) { await f.command({ kind: 'fly_to', x: -60, y: 10, z: 0 }); f.advance(0.1); }
  await f.command({ kind: 'hover' });
  const atHover = pose(f.drone), hoverTime = f.game.state.simTime; f.advance(2);
  const drift = distance(atHover, f.drone), final = pose(f.drone); f.advance(1);
  const samples = f.trace.filter(s => s.time >= hoverTime - 1e-9), stable = samples.findIndex(s => distance(s.drones[0], final) < 1e-6);
  assert.ok(drift > 0); assert.equal(distance(final, f.drone), 0); assert.equal(f.drone.action, undefined);
  assert.equal(f.game.inboxes[f.drone.id].events.filter(e => e.type === 'arrived').length, 0);
  return f.finish({ alive: f.drone.alive !== false, coastAfterReverseWorldUnits: round(atHover.x - atCommand.x),
    brakingDriftWorldUnits: round(drift), observedStopSecondsAfterHover: samples[stable] ? round(samples[stable].time - hoverTime) : null,
    driftDuringFinalSecondWorldUnits: distance(final, f.drone), finalHeadingDegrees: round(-f.drone.yaw) },
  { commandTime, hoverTime, atCommand, atHover });
}

async function corridor(tick: number): Promise<Result> {
  const f = await new Fixture('clear_corridor', tick).ready();
  Object.assign(f.drone, { z: 12 });
  f.game.state.obstacles = [-3, 3].map(x => ({ x, z: 0, width: 2, depth: 20, height: 14 }));
  f.trace = [sample(f.game)];
  const targets = [{ x: 0, y: 10, z: -12 }, { x: 8, y: 10, z: -12 }];
  let completed = 0;
  for (const target of targets) {
    await f.command({ kind: 'fly_to', ...target });
    if (f.until(() => !f.drone.action, 15) && f.drone.alive && distance(f.drone, target) < 1e-6) completed++;
    else break;
  }
  assert.equal(completed, 2); assert.ok(f.drone.alive);
  return f.finish({ completedLegs: completed, plannedLegs: 2, durationSeconds: round(f.game.state.simTime),
    collisionEvents: f.game.state.match!.events.filter(e => e.cause === 'terrain' || e.cause === 'ram').length,
    alive: Boolean(f.drone.alive), corridorLateralErrorWorldUnits: round(Math.max(...f.trace.filter(s => s.drones[0].z >= -10).map(s => Math.abs(s.drones[0].x)))) },
  { obstacles: f.game.state.obstacles, targets, scriptedGeometry: true });
}

async function obstacle(tick: number, armor: boolean): Promise<Result> {
  const f = await new Fixture(armor ? 'armored_obstacle_contact' : 'unarmored_obstacle_contact', tick).ready();
  f.drone.equipment!.armor = armor;
  const wall: Obstacle = { x: 0, z: -6, width: 6, depth: 2, height: 14 };
  f.game.state.obstacles = [wall];
  await f.command({ kind: 'fly_to', x: 0, y: 10, z: -15 }); f.advance(5);
  const impacts = f.game.state.match!.events.filter(e => e.drone === f.drone.id && e.cause === 'terrain');
  assert.equal(impacts.length, 1); assert.equal(f.drone.alive, armor); assert.equal(f.drone.equipment!.armor, false);
  const final = pose(f.drone); f.advance(1); assert.equal(distance(final, f.drone), 0);
  return f.finish({ alive: f.drone.alive !== false, armorRemaining: f.drone.equipment!.armor,
    impactEvents: impacts.length, impactTimeSeconds: impacts[0].simTime, finalZ: round(f.drone.z),
    driftDuringFinalSecondWorldUnits: distance(final, f.drone) }, { obstacles: [wall], armor });
}

/** Analytic calibration belongs only to this developer fixture; no actor receives it. */
function ballisticAim(relative: Point, velocity: Point) {
  const value = (t: number) => Math.hypot(relative.x + velocity.x * t, relative.y + velocity.y * t + RTS_CONFIG.bulletGravity * t * t / 2,
    relative.z + velocity.z * t) - RTS_CONFIG.bulletSpeed * t;
  let lo = 0, hi = 0;
  for (let t = 0.001; t <= RTS_CONFIG.bulletLifetime; t += 0.001) {
    if (value(t) <= 0) { hi = t; break; } lo = t;
  }
  assert.ok(hi > 0, 'Fixture target must admit an intercept within projectile lifetime');
  for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (value(mid) > 0) lo = mid; else hi = mid; }
  const t = (lo + hi) / 2;
  return { vector: { x: relative.x + velocity.x * t, y: relative.y + velocity.y * t + RTS_CONFIG.bulletGravity * t * t / 2,
    z: relative.z + velocity.z * t }, interceptSeconds: t };
}

async function shot(tick: number, range: number, moving: boolean, compensated: boolean, occluded = false): Promise<Result> {
  const f = await new Fixture(`shot_${range}_${moving ? 'moving' : 'stationary'}_${compensated ? 'compensated' : 'direct'}${occluded ? '_wall' : ''}`, tick).ready();
  Object.assign(f.target, { x: 0, y: 10, z: -range });
  f.drone.equipment!.gun = true;
  // The target starts from rest and accelerates for 0.5 s before firing: displacement 0.75, terminal velocity 3.
  const targetAtFire = { x: moving ? 0.75 : 0, y: 0, z: -range }, velocity = { x: moving ? 3 : 0, y: 0, z: 0 };
  const aim = compensated ? ballisticAim(targetAtFire, velocity) : { vector: targetAtFire, interceptSeconds: null };
  const heading = Math.atan2(aim.vector.x, -aim.vector.z) * 180 / Math.PI;
  const pitch = Math.atan2(aim.vector.y, Math.hypot(aim.vector.x, aim.vector.z)) * 180 / Math.PI;
  if (occluded) f.game.state.obstacles = [{ x: 0, z: -range / 2, width: 10, depth: 1, height: 20 }];
  f.trace = [sample(f.game)];
  await f.command({ kind: 'look', heading, pitch }); f.advance(3);
  if (moving) await f.command({ kind: 'fly_to', x: 60, y: 10, z: -range }, f.target.id);
  f.advance(0.5);
  assert.ok(Math.abs(f.target.x - targetAtFire.x) < 1e-6, 'Measured target displacement must match setup calibration');
  const fireTime = f.game.state.simTime, atFire = { shooter: pose(f.drone), target: pose(f.target) };
  await f.command({}, f.drone.id, 'fire'); f.advance(RTS_CONFIG.bulletLifetime + 0.1);
  const events = f.game.state.match!.events;
  const impact = events.find(e => e.type === 'impact'), expired = events.find(e => e.type === 'projectile_expired');
  const hit = impact?.target === f.target.id;
  const expectedHit = !occluded && (compensated || (!moving && range === 10));
  assert.equal(hit, expectedHit, `Unexpected physical shot outcome in ${f.name}`);
  assert.ok(impact || expired, 'Every fixture shot must reach a recorded endpoint');
  assert.equal(events.filter(e => e.type === 'fired').length, 1);
  return f.finish({ shots: 1, droneHits: hit ? 1 : 0, targetAlive: f.target.alive !== false,
    endpoint: impact?.cause ?? 'expired', endpointSecondsAfterFire: round((impact ?? expired)!.simTime - fireTime),
    nominalInterceptSeconds: aim.interceptSeconds === null ? null : round(aim.interceptSeconds),
    headingErrorAtFireDegrees: round(wrap(-f.drone.yaw - heading)), pitchErrorAtFireDegrees: round(f.drone.pitch - pitch) },
  { range, moving, compensated, occluded, targetAtFire, velocity, commandedAim: { heading, pitch }, atFire, fireTime,
    gunGrantedByDeveloperFixture: true, obstacles: f.game.state.obstacles });
}

const results: Result[] = [];
for (const tick of [0.05, 0.2]) {
  for (const [yaw, targetYaw, pitch] of [[0, 90, 50], [179, -179, 0], [-179, 179, 0]]) results.push(await turn(tick, yaw, targetYaw, pitch));
  for (const length of [0.2, 6, 20]) results.push(await waypoint(tick, length));
  results.push(await hover(tick, false), await hover(tick, true), await corridor(tick), await obstacle(tick, false), await obstacle(tick, true));
  for (const [range, moving, compensated, occluded] of [
    [10, false, false, false], [40, false, false, false], [40, false, true, false],
    [30, true, false, false], [30, true, true, false], [10, false, false, true],
  ] as const) results.push(await shot(tick, range, moving, compensated, occluded));
}
const comparisons = results.filter(r => r.tickSeconds === 0.05).map(a => {
  const b = results.find(r => r.name === a.name && r.tickSeconds === 0.2)!;
  const final = (r: Result) => r.trace.at(-1)!.drones;
  return { name: a.name, maxFinalPositionDifferenceWorldUnits: round(Math.max(...final(a).map((d, i) => distance(d, final(b)[i])))),
    sameAliveOutcomes: final(a).every((d, i) => d.alive === final(b)[i].alive),
    sameEventTypes: JSON.stringify(a.events.map(e => [e.type, e.cause])) === JSON.stringify(b.events.map(e => [e.type, e.cause])) };
});
assert.ok(comparisons.every(c => c.sameAliveOutcomes && c.sameEventTypes));
const stamp = new Date().toISOString(), directory = path.resolve('artifacts', 'control-measurements', stamp.replaceAll(':', '-'));
await mkdir(directory, { recursive: true });
const metadata = { measuredAt: stamp, revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim(),
  node: process.version, command: 'node --import tsx scripts/measure-controls.ts', inference: false,
  cameraEvidence: 'Synthetic one-pixel fixture only. No scene camera, visual perception, actor decision, MAVLink or Zenoh validation.',
  units: 'Simulator-local world units, simulation seconds, degrees. Sample rates are caller ticks; FleetGame integrates at <= 1/120 s.',
  population: '17 prespecified deterministic scenarios at two caller tick durations (34 runs). One observation unit is a scenario run; these are fixtures, not autonomous success rates.',
  limits: 'Scripted paths and ballistic calibration are developer-only. Arrival/impact events have internal-substep precision; observed stop/settle times and maximum speed are sample estimates. No production constants or prompts modified.' };
const summary = { metadata, cases: results.map(({ name, tickSeconds, metrics }) => ({ name, tickSeconds, metrics })), comparisons };
await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
await writeFile(path.join(directory, 'trajectories.json'), JSON.stringify({ metadata, results }, null, 2));
console.log(JSON.stringify({ artifact: directory, passedRuns: results.length, inference: false,
  tickComparison: { cases: comparisons.length, sameAliveAndEventOutcomes: comparisons.every(c => c.sameAliveOutcomes && c.sameEventTypes),
    maxFinalPositionDifferenceWorldUnits: Math.max(...comparisons.map(c => c.maxFinalPositionDifferenceWorldUnits)) },
  metricsAt50Milliseconds: summary.cases.filter(c => c.tickSeconds === 0.05).map(({ name, metrics }) => ({ name, ...metrics })) }));
