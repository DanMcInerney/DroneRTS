import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TeamSession } from '../server/team-session.ts';
import type { FleetGame } from '../server/game.ts';
import type { RuntimeOptions } from '../server/runtime.ts';
import type { FleetNetwork } from '../server/network.ts';
import type { RadioMessage } from '../shared/types.ts';
import { MATCH_DRONE_IDS, MATCH_FLEET, type DroneId } from '../shared/fleet.ts';

function fixture(linkHook?: (id: DroneId, online: boolean) => Promise<void>, startHook?: () => Promise<void>) {
  const relays: string[] = [], droneCalls: string[] = [], statuses: any[] = [], networks: any[] = [];
  const runtimeOptions: RuntimeOptions[] = [], networkOptions: Array<ConstructorParameters<typeof FleetNetwork>[0]> = [];
  const sent: Array<{ team: string; message: RadioMessage }> = [], links: Array<{ id: DroneId; online: boolean }> = [], retired: string[] = [], stopped: string[] = [], failures: string[] = [], started: string[] = [];
  let vehicleRoster: unknown;
  const game = { sessionIdentity: randomUUID(), state: { running: true, drones: MATCH_DRONE_IDS.map(id => ({ id, alive: true })) },
    forwardTeam: async (team: string) => { relays.push(team); return { content: [] }; },
    tool: async (role: string) => { droneCalls.push(role); return { content: [] }; },
    toolCapabilities: () => ({ shop: false, gun: false, alive: true }),
    receiveRadio: () => {},
  } as unknown as FleetGame;
  const session = new TeamSession({ projectDir: process.cwd(), game, onStatus: state => statuses.push(state), onNetwork: state => networks.push(state), onEvent: () => {}, onFailure: error => failures.push(error) }, {
    runtime: options => { runtimeOptions.push(options); return { start: async () => { started.push(`${options.team}-runtime`); options.onStatus({ status: 'running', children: options.roster!.map(member => ({ id: `${member.id}-thread`, role: member.id })), usage: 10 }); }, stop: async () => { stopped.push(`${options.team}-runtime`); }, retireDrone: async id => { retired.push(id); }, refreshTools: async () => {} }; },
    network: options => {
      networkOptions.push(options); const team = options.roster![0].id === 'drone-1' ? 'blue' : 'red';
      const state = { status: 'starting' as const, transport: 'zenoh-tcp' as const, vehicle: 'mavlink2-udp' as const, message: '', peers: options.roster!.map(member => ({ id: member.id, online: false, peers: 0, pending: 0, inbox: 0 })) };
      return { state, start: async () => { started.push(`${team}-network`); await startHook?.(); options.onState({ ...state, status: 'online' }); }, stop: async () => { stopped.push(`${team}-network`); }, send: async message => { sent.push({ team, message }); }, consume: () => {}, link: async (id, online) => { links.push({ id, online }); await linkHook?.(id, online); } };
    },
    vehicle: options => { vehicleRoster = options.roster; return { start: async () => {}, stop: async () => { stopped.push('vehicle'); }, command: async () => ({}), sample: async () => ({ position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, cameraOrientation: { heading: 0, pitch: 0 }, heading: { degrees: 0 }, simTime: 0 }) }; },
  });
  return { session, game, relays, droneCalls, statuses, networks, runtimeOptions, networkOptions, sent, links, retired, stopped, vehicleRoster, failures, started };
}

test('two native parents each relay only to their three-member team over distinct radio domains', async () => {
  const f = fixture(); await f.session.start();
  assert.deepEqual(f.runtimeOptions.map(options => options.roster!.map(member => member.id)), [['drone-1', 'drone-2', 'drone-3'], ['drone-4', 'drone-5', 'drone-6']]);
  assert.notEqual(f.networkOptions[0].networkId, f.networkOptions[1].networkId);
  assert.equal(f.networkOptions[0].sessionId, f.networkOptions[1].sessionId);
  assert.deepEqual(f.vehicleRoster, MATCH_FLEET);
  await f.runtimeOptions[0].toolHandler('parent', 'forward_next_instruction', {});
  await f.runtimeOptions[1].toolHandler('parent', 'forward_next_instruction', {});
  assert.deepEqual(f.relays, ['blue', 'red']);
  await assert.rejects(f.runtimeOptions[0].toolHandler('drone-4', 'observe', {}), /outside this team/);
  assert.deepEqual(f.runtimeOptions[0].toolsForRole!('drone-4'), []);
  const latest = f.statuses.at(-1);
  assert.equal(latest.status, 'running'); assert.equal(latest.children.length, 6); assert.equal(latest.usage, 20);
  assert.deepEqual(Object.keys(latest.teams), ['blue', 'red']); assert.equal(f.networks.at(-1).peers.length, 6);
  await f.session.stop(); assert.equal(f.stopped.length, 5);
});

test('radio reconciliation serializes native calls, coalesces rapidly changing interference and gates sends', async () => {
  let release!: () => void, active = 0, maxActive = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async (_id, online) => { active++; maxActive = Math.max(maxActive, active); if (!online) await blocked; active--; });
  await f.session.start();
  const drone = f.game.state.drones[0];
  drone.radioJammed = true; f.game.radioInterferenceChanged!();
  assert.deepEqual(f.links, [{ id: drone.id, online: false }]);
  for (const jammed of [false, true, false]) { drone.radioJammed = jammed; f.game.radioInterferenceChanged!(); }
  const send = f.session.radio.send({ from: 'drone-2', to: 'all' } as RadioMessage);
  const relay = f.session.radio.sendTeam('red', { from: 'player', to: 'all' } as RadioMessage);
  assert.equal(f.sent.length, 0);
  release(); await Promise.all([send, relay, f.session.reconcileRadio()]);
  assert.deepEqual(f.links, [{ id: drone.id, online: false }, { id: drone.id, online: true }]);
  assert.equal(maxActive, 1); assert.equal(f.sent.length, 2);
  assert.deepEqual(f.failures, []); await f.session.stop();
});

test('clearing a jammer preserves manual isolation and never reconnects destroyed or retired actors', async () => {
  const f = fixture(); await f.session.start();
  const [manual, dead, retired] = f.game.state.drones;
  await f.session.link(manual.id, false);
  for (const drone of [manual, dead, retired]) drone.radioJammed = true;
  f.game.radioInterferenceChanged!(); await f.session.reconcileRadio();
  dead.alive = false; await f.session.retireDrone(retired.id); await f.session.retireDrone(retired.id);
  for (const drone of [manual, dead, retired]) drone.radioJammed = false;
  f.game.radioInterferenceChanged!(); await f.session.reconcileRadio();
  assert.equal(f.links.some(link => link.online), false);
  assert.deepEqual(f.retired, [retired.id]);
  await assert.rejects(f.session.link(dead.id, true), /cannot reconnect/);
  await assert.rejects(f.session.link(retired.id, true), /cannot reconnect/);
  manual.radioJammed = true; await f.session.link(manual.id, true);
  assert.equal(f.links.some(link => link.online), false, 'manual reconnect cannot override active interference');
  manual.radioJammed = false; f.game.radioInterferenceChanged!(); await f.session.reconcileRadio();
  assert.deepEqual(f.links.at(-1), { id: manual.id, online: true });
  await f.session.stop();
});

test('death during an in-flight native reconnect is followed by disconnection, never a stale final state', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async (_id, online) => { if (online) await blocked; }); await f.session.start();
  const drone = f.game.state.drones[0]; drone.radioJammed = true; await f.session.reconcileRadio();
  drone.radioJammed = false; f.game.radioInterferenceChanged!();
  assert.deepEqual(f.links.at(-1), { id: drone.id, online: true });
  drone.alive = false; const retiring = f.session.retireDrone(drone.id);
  release(); await retiring; await f.session.reconcileRadio();
  assert.deepEqual(f.links, [{ id: drone.id, online: false }, { id: drone.id, online: true }, { id: drone.id, online: false }]);
  await f.session.stop();
});

test('native reconciliation failure is reported once, blocks later sends and never falls back', async () => {
  const f = fixture(async () => { throw new Error('Native peer failed'); }); await f.session.start();
  f.game.state.drones[0].radioJammed = true; f.game.radioInterferenceChanged!();
  await assert.rejects(f.session.reconcileRadio(), /Native peer failed/);
  await assert.rejects(f.session.radio.send({ from: 'drone-2', to: 'all' } as RadioMessage), /Native peer failed/);
  await assert.rejects(f.session.radio.sendTeam('red', { from: 'player', to: 'all' } as RadioMessage), /Native peer failed/);
  assert.deepEqual(f.failures, ['Native radio reconciliation failed: Native peer failed']);
  assert.equal(f.sent.length, 0); assert.equal(f.links.length, 1); await f.session.stop();
});

test('startup applies interference before actors begin, repeats safely, and stop removes only its own callback', async () => {
  const f = fixture(); f.game.state.drones[0].radioJammed = true;
  await Promise.all([f.session.start(), f.session.start()]);
  assert.equal(f.started.length, 4); assert.deepEqual(f.links, [{ id: 'drone-1', online: false }]);
  const owned = f.game.radioInterferenceChanged!;
  const replacement = () => {};
  f.game.radioInterferenceChanged = replacement;
  await f.session.stop(); assert.equal(f.game.radioInterferenceChanged, replacement);
  f.game.state.drones[0].radioJammed = false; owned(); await f.session.reconcileRadio();
  assert.equal(f.links.length, 1); await assert.rejects(f.session.start(), /cancelled/);
  const clean = fixture(); await clean.session.start(); await clean.session.stop();
  assert.equal(clean.game.radioInterferenceChanged, undefined);
});

test('stop during native startup prevents actor startup and cannot rebind the old interference callback', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(undefined, () => blocked);
  const starting = f.session.start();
  const rejected = assert.rejects(starting, /cancelled/);
  await f.session.stop(); release(); await rejected;
  assert.equal(f.game.radioInterferenceChanged, undefined);
  assert.equal(f.game.radioTransport, undefined); assert.equal(f.started.some(name => name.endsWith('runtime')), false);
});

test('stop during a pending link prevents further reconnects and queued sends', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(() => blocked); await f.session.start();
  f.game.state.drones[0].radioJammed = true; f.game.radioInterferenceChanged!();
  const pending = f.session.radio.send({ from: 'drone-2', to: 'all' } as RadioMessage);
  const rejected = assert.rejects(pending, /unavailable/);
  f.game.state.drones[0].radioJammed = false; f.game.radioInterferenceChanged!();
  await f.session.stop(); release(); await rejected;
  assert.deepEqual(f.links, [{ id: 'drone-1', online: false }]);
  assert.equal(f.sent.length, 0); assert.equal(f.game.radioInterferenceChanged, undefined);
  assert.deepEqual(f.failures, []);
});

test('team radio routes player and peer messages correctly; destruction disconnects only the dead actor', async () => {
  const f = fixture(); await f.session.start();
  const message = { from: 'player', to: 'all' } as RadioMessage;
  await f.session.radio.sendTeam('red', message);
  await f.session.radio.send({ ...message, from: 'drone-2' });
  assert.deepEqual(f.sent.map(item => item.team), ['red', 'blue']);
  await assert.rejects(f.session.radio.send(message), /select a team/);
  await f.session.retireDrone('drone-5');
  assert.deepEqual(f.retired, ['drone-5']); assert.deepEqual(f.links, [{ id: 'drone-5', online: false }]);
  assert.deepEqual(f.stopped, []);
  f.game.state.drones.find(drone => drone.id === 'drone-5')!.alive = false;
  await assert.rejects(f.session.link('drone-5', true), /cannot reconnect/);
  await f.session.link('drone-6', true);
  await f.session.stop(); await f.session.stop(); assert.equal(f.stopped.length, 5);
  assert.equal(f.game.radioTransport, undefined); assert.equal(f.game.vehicleTransport, undefined);
});
