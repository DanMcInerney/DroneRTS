import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TeamSession } from '../server/team-session.ts';
import type { FleetGame } from '../server/game.ts';
import type { RuntimeOptions } from '../server/runtime.ts';
import type { FleetNetwork } from '../server/network.ts';
import type { RadioMessage } from '../shared/types.ts';
import { MATCH_DRONE_IDS, MATCH_FLEET } from '../shared/fleet.ts';

function fixture() {
  const relays: string[] = [], droneCalls: string[] = [], statuses: any[] = [], networks: any[] = [];
  const runtimeOptions: RuntimeOptions[] = [], networkOptions: Array<ConstructorParameters<typeof FleetNetwork>[0]> = [];
  const sent: Array<{ team: string; message: RadioMessage }> = [], links: unknown[] = [], retired: string[] = [], stopped: string[] = [];
  let vehicleRoster: unknown;
  const game = { sessionIdentity: randomUUID(), state: { running: true, drones: MATCH_DRONE_IDS.map(id => ({ id, alive: true })) },
    forwardTeam: async (team: string) => { relays.push(team); return { content: [] }; },
    tool: async (role: string) => { droneCalls.push(role); return { content: [] }; },
    toolCapabilities: () => ({ shop: false, gun: false, alive: true }),
    receiveRadio: () => {},
  } as unknown as FleetGame;
  const session = new TeamSession({ projectDir: process.cwd(), game, onStatus: state => statuses.push(state), onNetwork: state => networks.push(state), onEvent: () => {}, onFailure: error => { throw new Error(error); } }, {
    runtime: options => { runtimeOptions.push(options); return { start: async () => { options.onStatus({ status: 'running', children: options.roster!.map(member => ({ id: `${member.id}-thread`, role: member.id })), usage: 10 }); }, stop: async () => { stopped.push(`${options.team}-runtime`); }, retireDrone: async id => { retired.push(id); }, refreshTools: async () => {} }; },
    network: options => {
      networkOptions.push(options); const team = options.roster![0].id === 'drone-1' ? 'blue' : 'red';
      const state = { status: 'starting' as const, transport: 'zenoh-tcp' as const, vehicle: 'mavlink2-udp' as const, message: '', peers: options.roster!.map(member => ({ id: member.id, online: false, peers: 0, pending: 0, inbox: 0 })) };
      return { state, start: async () => { options.onState({ ...state, status: 'online' }); }, stop: async () => { stopped.push(`${team}-network`); }, send: async message => { sent.push({ team, message }); }, consume: () => {}, link: async (id, online) => { links.push({ id, online }); } };
    },
    vehicle: options => { vehicleRoster = options.roster; return { start: async () => {}, stop: async () => { stopped.push('vehicle'); }, command: async () => ({}), sample: async () => ({ position: { x: 0, y: 0, z: 0 }, heading: { degrees: 0 }, simTime: 0 }) }; },
  });
  return { session, game, relays, droneCalls, statuses, networks, runtimeOptions, networkOptions, sent, links, retired, stopped, vehicleRoster };
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
