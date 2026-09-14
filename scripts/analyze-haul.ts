/** Offline factual logistics analysis. Never routes evidence back into actor inputs. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ReplayFrame, ReplayRecord } from '../shared/replay.ts';
const directory = resolve(process.argv[2]);
const result = JSON.parse(await readFile(resolve(directory, 'result.json'), 'utf8'));
const replay = resolve(directory, 'replays', result.sessionId.slice(0, -6), 'frames.jsonl');
const records: ReplayRecord[] = (await readFile(replay, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const audit: any[] = (await readFile(resolve(directory, result.sessionId), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const frames = records.filter((record): record is ReplayFrame => record.type === 'frame');
const events = records.filter(record => record.type === 'event').map(record => record.event);
const radio = audit.filter(record => record.type === 'radio').map(record => record.value);
const tools = audit.filter(record => record.type === 'tool').map(record => record.value);
const bundles = audit.filter(record => record.type === 'agent' && record.value.type === 'tool-result').flatMap(record => {
  try { return [{ role: record.value.role, body: JSON.parse(record.value.result.content.find((item: any) => item.type === 'text').text) }]; }
  catch { return []; }
});
const counts = (values: string[]) => Object.fromEntries([...new Set(values)].map(value => [value, values.filter(item => item === value).length]));
const last = frames.at(-1)!, deposits = events.filter(event => event.type === 'cargo_delivered');
const pickups = events.filter(event => event.type === 'cargo_loaded');
const initial = frames[0];
const stock = (frame: ReplayFrame) => (frame.match?.resources ?? []).reduce((sum, node) => sum + node.remaining, 0);
const aboard = (frame: ReplayFrame) => frame.drones.reduce((sum, drone) => sum + (drone.cargo?.amount ?? 0), 0);
const delivered = Object.values(last.match!.teams).reduce((sum, team) => sum + team.earned, 0);
const overlap = { twoBlueMovingSeconds: 0, threeBlueMovingSeconds: 0, blueServiceAndOtherMovementSeconds: 0 };
for (let i = 1; i < frames.length; i++) {
  const previous = frames[i - 1], dt = Math.max(0, frames[i].simTime - previous.simTime);
  const blue = previous.drones.filter(drone => drone.team === 'blue' && drone.alive);
  const moving = blue.filter(drone => Math.hypot(drone.velocity?.x ?? 0, drone.velocity?.y ?? 0, drone.velocity?.z ?? 0) > .05);
  const servicing = blue.filter(drone => ['loading', 'unloading'].includes(drone.logistics?.state ?? ''));
  if (moving.length >= 2) overlap.twoBlueMovingSeconds += dt;
  if (moving.length >= 3) overlap.threeBlueMovingSeconds += dt;
  if (servicing.some(drone => moving.some(other => other.id !== drone.id))) overlap.blueServiceAndOtherMovementSeconds += dt;
}
const summary = {
  scenario: result.scenario, sourceManifestSha256: result.manifestSha256, directory,
  model: result.model, effort: result.effort, seconds: last.simTime, endReason: result.endReason,
  fixture: result.fixture, firstPickupSeconds: pickups[0]?.simTime ?? null, firstDepositSeconds: deposits[0]?.simTime ?? null,
  pickupCount: pickups.length, deliveryCount: deposits.length, deliveredSalvage: delivered,
  loadsPerMinute: last.simTime ? deposits.length * 60 / last.simTime : 0,
  deliveryCountByDrone: Object.fromEntries(last.drones.map(drone => [drone.id, deposits.filter(event => event.drone === drone.id).length])),
  sampledOverlap: overlap,
  economy: last.match!.teams, initialStock: stock(initial), stockRemaining: stock(last), cargoAboard: aboard(last), salvageLost: last.match!.salvageLost ?? 0,
  conservationDelta: stock(last) + aboard(last) + delivered + (last.match!.salvageLost ?? 0) - stock(initial) - aboard(initial),
  collisionEvents: events.filter(event => /collision/.test(event.type)
    || ['armor_consumed', 'destroyed'].includes(event.type) && ['terrain', 'ram'].includes(event.cause ?? '')),
  armorEvents: events.filter(event => event.type === 'armor_consumed'),
  bulletEvents: events.filter(event => ['armor_consumed', 'destroyed'].includes(event.type) && event.cause === 'bullet'),
  destructionEvents: events.filter(event => event.type === 'destroyed'),
  cargoEvents: events.filter(event => event.type.startsWith('cargo_')),
  jobStates: counts(bundles.map(bundle => bundle.body.job?.state).filter(Boolean)),
  blockedReports: bundles.filter(bundle => bundle.body.job?.state === 'blocked').map(bundle => ({ role: bundle.role, job: bundle.body.job })),
  actualPeerReports: radio.filter(message => message.from !== 'player' && ['found', 'claim', 'done'].includes(message.kind)),
  receivedPeerMessages: counts(bundles.flatMap(bundle => (bundle.body.events ?? []).filter((event: any) => event.type === 'radio' && event.message?.from !== 'player').map(() => bundle.role))),
  playerReplies: radio.filter(message => message.to === 'player'),
  authoredScripts: tools.filter(tool => tool.name === 'workspace' && tool.args?.op === 'write'),
  routineSubmissions: tools.filter(tool => tool.name === 'routine'),
  transfers: tools.filter(tool => tool.name === 'transfer'),
  finalStorage: Object.fromEntries(last.drones.map(drone => [drone.id, drone.storage ?? null])),
  toolCounts: counts(tools.map(tool => tool.name)),
  errors: result.failures, cleanup: result.cleanup,
  limitations: 'Observed discovery requires review of acquired pixels and actor reports; first visual discovery and causal report usefulness are not inferred from omniscient locations. Sampled overlap measures motion/service coexistence, not useful work or strategy. Missing optional storage means unavailable, not zero. Scripts are archived evidence and are never executed by this analyzer.',
};
await writeFile(resolve(directory, 'haul-analysis.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, fixture: summary.fixture?.description,
  actualPeerReports: summary.actualPeerReports.map(message => ({ from: message.from, to: message.to, kind: message.kind, simTime: message.simTime, text: message.text })),
  authoredScripts: summary.authoredScripts.length, routineSubmissions: summary.routineSubmissions.length,
  transfers: summary.transfers.length }, null, 2));
