/** Prescribed physical logistics fixtures. No inference; geometry is developer-only. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { FleetGame } from '../server/game.ts';
import { CITY } from '../shared/city.ts';
import { BATTLEFIELD } from '../shared/battlefield.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';
import { CARGO_CONFIG, RTS_CONFIG, apronServicePositions, resourceZoneSize, type Point } from '../shared/rts.ts';
import { intersectsBuilding } from '../server/world-geometry.ts';
import type { ToolResult } from '../shared/types.ts';

const output = resolve(process.env.FLEET_QA_OUTPUT ?? 'artifacts/cargo-mechanics');
await mkdir(output, { recursive: true });
const parse = (result: ToolResult) => JSON.parse((result.content[0] as { text: string }).text);
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const clear = (a: Point, b: Point, margin = RTS_CONFIG.droneRadius + .15) =>
  !CITY.buildings.some(building => intersectsBuilding(a, b, building, margin));

/** A test-only visibility graph, never supplied to gameplay actors or the SDK. */
function prescribedRoute(start: Point, end: Point, obstructions: Point[] = []): Point[] {
  const serviceApproaches = BATTLEFIELD.servicePads.flatMap(p => [-4, -2, 0, 2, 4].flatMap(x => [-4, -2, 0, 2, 4]
    .map(z => ({ x: p.x + x, y: start.y, z: p.z + z }))));
  const points = [start, end, ...serviceApproaches, ...CITY.intersections.map(p => ({ ...p, y: start.y }))];
  const avoidsDrones = (a: Point, b: Point) => obstructions.every(drone => {
    const span = distance(a, b), fraction = span ? Math.max(0, Math.min(1,
      ((drone.x - a.x) * (b.x - a.x) + (drone.y - a.y) * (b.y - a.y) + (drone.z - a.z) * (b.z - a.z)) / span ** 2)) : 0;
    return distance(drone, { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction, z: a.z + (b.z - a.z) * fraction }) > 1.05;
  });
  const distances = points.map(() => Infinity), previous = points.map(() => -1), pending = new Set(points.map((_, i) => i));
  distances[0] = 0;
  while (pending.size) {
    let nearest = -1;
    for (const i of pending) if (nearest < 0 || distances[i] < distances[nearest]) nearest = i;
    if (nearest === 1 || !Number.isFinite(distances[nearest])) break;
    pending.delete(nearest);
    for (const i of pending) {
      const span = distance(points[nearest], points[i]);
      if (span > 25 || distances[nearest] + span >= distances[i] || !clear(points[nearest], points[i]) || !avoidsDrones(points[nearest], points[i])) continue;
      distances[i] = distances[nearest] + span; previous[i] = nearest;
    }
  }
  assert.ok(Number.isFinite(distances[1]), 'Prescribed collision-clear route exists');
  const route: Point[] = []; for (let i = 1; i !== 0; i = previous[i]) route.unshift(points[i]);
  return route;
}

async function fresh() {
  const game = new FleetGame(); game.setConnected(true); game.start();
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  for (const id of MATCH_DRONE_IDS) await game.tool(id, 'observe');
  await game.forwardTeam('blue'); await game.forwardTeam('red');
  assert.equal(game.state.match!.rulesVersion, 'cargo-v2');
  return game;
}
const events: unknown[] = [], samples: unknown[] = [];
const game = await fresh();
game.on('match-event', event => events.push(event));
const carrier = game.state.drones[0], bank = game.state.match!.teams.blue;
const initialStock = game.state.match!.resources.reduce((sum, node) => sum + node.remaining, 0);
const tick = (seconds: number) => { for (let time = 0; time < seconds; time += .05) game.tick(Math.min(.05, seconds - time)); };
const conservation = () => {
  const total = game.state.match!.resources.reduce((sum, node) => sum + node.remaining, 0)
    + game.state.drones.reduce((sum, drone) => sum + (drone.cargo?.amount ?? 0), 0)
    + Object.values(game.state.match!.teams).reduce((sum, team) => sum + team.earned, 0)
    + (game.state.match!.salvageLost ?? 0);
  assert.ok(Math.abs(total - initialStock) < 1e-6, `Conserved salvage ${total}/${initialStock}`);
};
const fly = async (route: Point[]) => {
  for (const target of route) {
    assert.ok(clear(carrier, target));
    const result = parse(await game.tool(carrier.id, 'act', { mission: 1, kind: 'fly_to', ...target }));
    assert.equal(result.accepted, true, JSON.stringify(result));
    const deadline = game.state.simTime + 60;
    while (carrier.action && carrier.alive && game.state.simTime < deadline) {
      tick(.05);
      if (carrier.job?.state === 'blocked') throw new Error(`Prescribed route blocked: ${carrier.job.reason} to ${JSON.stringify(target)}`);
    }
    assert.equal(carrier.alive, true); assert.ok(distance(carrier, target) < .05, `Arrival at ${JSON.stringify(target)}, actual ${JSON.stringify({ x: carrier.x, y: carrier.y, z: carrier.z })}`);
    assert.equal(carrier.equipment!.armor, true, 'No protected collision on prescribed route');
    conservation(); samples.push(structuredClone({ simTime: game.state.simTime, drone: carrier, bank }));
  }
};
try {
  const start = { x: carrier.x, y: carrier.y, z: carrier.z };
  const stationaryDrones = game.state.drones.slice(1);
  const routes = game.state.match!.resources.map(node => ({ node, route: prescribedRoute(start, { x: node.x, y: start.y, z: node.z }, stationaryDrones) }));
  const length = (start: Point, route: Point[]) => route.reduce((sum, point, i) => sum + distance(i ? route[i - 1] : start, point), 0);
  routes.sort((a, b) => length(start, a.route) - length(start, b.route));
  const chosen = routes[0];
  await fly(chosen.route); const arrivedAt = game.state.simTime;
  const cargoDeadline = game.state.simTime + CARGO_CONFIG.pickupDuration + 2;
  while ((carrier.cargo?.amount ?? 0) < CARGO_CONFIG.gripCapacity && game.state.simTime < cargoDeadline) tick(.05);
  assert.equal(carrier.cargo!.amount, 30); assert.equal(bank.earned, 0, 'Pickup does not bank money'); conservation();
  const pickedUpAt = game.state.simTime;
  const returnRoute = prescribedRoute(carrier, start, stationaryDrones); await fly(returnRoute);
  const deliveryDeadline = game.state.simTime + CARGO_CONFIG.deliveryDuration + 2;
  while (bank.earned < 30 && game.state.simTime < deliveryDeadline) tick(.05);
  assert.equal(bank.earned, 30); assert.equal(bank.credits, RTS_CONFIG.startingCredits + 30);
  assert.equal(carrier.cargo!.amount, 0); conservation();
  const depositedAt = game.state.simTime;
  const routesByBase = BATTLEFIELD.servicePads.map(base => ({ team: base.team, resources: BATTLEFIELD.resources.map(node => {
    const start = { ...base, y: 1.8 }, route = prescribedRoute(start, { ...node, y: 1.8 });
    return { id: node.id, length: length(start, route), route };
  }) }));
  // Three bodies on the authoritative marks share one actual depot; fixture pose
  // placement isolates service capacity from navigation, without granting stock.
  const depot = game.state.match!.resources.find(node => node.capacity >= 90)!;
  const positions = apronServicePositions(depot, resourceZoneSize(depot));
  const stockBefore = depot.remaining;
  game.state.drones.slice(0, 3).forEach((drone, i) => Object.assign(drone, positions[i]));
  tick(CARGO_CONFIG.pickupDuration + .3);
  assert.ok(game.state.drones.slice(0, 3).every(drone => drone.alive && drone.cargo?.amount === 30));
  assert.equal(depot.remaining, stockBefore - 90); conservation();
  game.stop(); const conservedAtStop = structuredClone(game.state.match);
  game.stop(); assert.deepEqual(game.state.match, conservedAtStop, 'Repeated Stop is idempotent'); conservation();
  const sourcePaths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(path => /\.(ts|json|mjs|py)$/.test(path));
  const manifest = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
  await writeFile(resolve(output, 'source-manifest.json'), JSON.stringify(manifest, null, 2));
  const result = { passed: true, inference: false, fixture: true, arrivedAt, pickedUpAt, depositedAt, initialStock,
    suppliedRoute: chosen.route, returnRoute, routesByBase, events, samples,
    limitations: 'Developer routes use private collision geometry and synthetic camera placeholders. Fixture success proves physical mechanics only; it does not prove resource recognition, autonomous planning or teamwork.' };
  await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ passed: true, output, pickedUpAt, depositedAt }));
} finally { game.stop(); }
