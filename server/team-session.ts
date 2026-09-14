import { randomUUID } from 'node:crypto';
import { CodexFleetRuntime, type RuntimeOptions } from './runtime.ts';
import { createDroneTools, MODEL, EFFORT } from './runtime-tools.ts';
import { FleetNetwork } from './network.ts';
import { MavlinkAdapter } from './mavlink.ts';
import type { FleetGame } from './game.ts';
import { MATCH_FLEET, teamForDrone, teamRoster, type DroneId, type TeamId } from '../shared/fleet.ts';
import type { NetworkState, RadioMessage, RuntimeState } from '../shared/types.ts';

const TEAMS: TeamId[] = ['blue', 'red'];
type RuntimeActor = Pick<CodexFleetRuntime, 'start' | 'stop' | 'retireDrone' | 'refreshTools'>;
type NetworkActor = Pick<FleetNetwork, 'start' | 'stop' | 'state' | 'send' | 'consume' | 'link'>;
type VehicleActor = Pick<MavlinkAdapter, 'start' | 'stop' | 'command' | 'sample'>;
type Dependencies = {
  runtime?: (options: RuntimeOptions) => RuntimeActor;
  network?: (options: ConstructorParameters<typeof FleetNetwork>[0]) => NetworkActor;
  vehicle?: (options: ConstructorParameters<typeof MavlinkAdapter>[0]) => VehicleActor;
};

/** One match, two independent native parents, two radio namespaces, six vehicle IDs. */
export class TeamSession {
  private stopped = false;
  private stopPromise?: Promise<void>;
  private runtimes = new Map<TeamId, RuntimeActor>();
  private networks = new Map<TeamId, NetworkActor>();
  private runtimeStates = new Map<TeamId, RuntimeState>();
  private networkStates = new Map<TeamId, NetworkState>();
  readonly vehicle: VehicleActor;
  readonly radio = {
    send: async (message: RadioMessage) => {
      if (message.from === 'player') throw new Error('Player radio must select a team');
      return this.networkFor(teamForDrone(message.from as DroneId)).send(message);
    },
    sendTeam: async (team: TeamId, message: RadioMessage) => {
      if (message.from !== 'player') throw new Error('Only original player instructions use the team relay');
      return this.networkFor(team).send(message);
    },
    consume: (id: DroneId, ids: string[]) => this.networkFor(teamForDrone(id)).consume(id, ids),
  };

  constructor(private options: { projectDir: string; game: FleetGame; onStatus: (status: RuntimeState) => void; onNetwork: (state: NetworkState) => void; onEvent: (type: string, event: unknown) => void; onFailure: (message: string) => void }, dependencies: Dependencies = {}) {
    for (const team of TEAMS) {
      this.runtimeStates.set(team, { status: 'starting', message: `${team} team connecting`, model: MODEL, effort: EFFORT, children: [], usage: 0 });
      const network = (dependencies.network ?? (config => new FleetNetwork(config)))({ projectDir: options.projectDir, sessionId: options.game.sessionIdentity,
        networkId: randomUUID(), roster: teamRoster(team),
        onReceive: (id, message) => { if (!this.stopped) options.game.receiveRadio(id, message); },
        onState: state => { this.networkStates.set(team, state); this.publishNetwork(); },
        onEvent: event => options.onEvent('network', { team, ...event }),
        onFailure: message => this.fail(`${team} network: ${message}`),
      });
      this.networks.set(team, network); this.networkStates.set(team, network.state);
      const runtime = (dependencies.runtime ?? (config => new CodexFleetRuntime(config)))({ projectDir: options.projectDir, roster: teamRoster(team), team,
        toolHandler: async (role, name, args) => {
          if (role === 'parent') return options.game.forwardTeam(team);
          if (!teamRoster(team).some(member => member.id === role)) throw new Error('Actor identity is outside this team');
          return options.game.tool(role, name, args);
        },
        toolsForRole: role => teamRoster(team).some(member => member.id === role) ? createDroneTools(teamRoster(team), options.game.toolCapabilities(role)) : [],
        onStatus: status => {
          if (this.stopped) return;
          Object.assign(this.runtimeStates.get(team)!, status); this.publishRuntime();
          if (status.status === 'error') this.fail(`${team} runtime: ${String(status.message)}`);
        },
        onEvent: event => options.onEvent('agent', { team, ...event }),
      });
      this.runtimes.set(team, runtime);
    }
    this.vehicle = (dependencies.vehicle ?? (config => new MavlinkAdapter(config)))({ projectDir: options.projectDir, roster: MATCH_FLEET, onEvent: event => {
      options.onEvent('mavlink', event);
      if (event.event === 'fatal') this.fail(String(event.message));
    } });
  }

  private fail(message: string) { if (!this.stopped) this.options.onFailure(message); }
  private networkFor(team: TeamId) {
    const network = this.networks.get(team);
    if (this.stopped || !network) throw new Error('Team radio is unavailable');
    return network;
  }
  private publishNetwork() {
    const states = [...this.networkStates.values()];
    const state: NetworkState & { teams: Record<string, NetworkState> } = {
      status: states.some(state => state.status === 'error') ? 'error' : states.length === 2 && states.every(state => state.status === 'online') ? 'online' : this.stopped ? 'offline' : 'starting',
      transport: 'zenoh-tcp', vehicle: 'mavlink2-udp', message: 'Two isolated Zenoh teams · six MAVLink 2 vehicles',
      pendingMissions: states.reduce((sum, state) => sum + (state.pendingMissions ?? 0), 0),
      peers: states.flatMap(state => state.peers), teams: Object.fromEntries(this.networkStates),
    };
    this.options.onNetwork(state);
  }
  private publishRuntime() {
    const states = [...this.runtimeStates.values()];
    const children = states.flatMap(state => Array.isArray(state.children) ? state.children : []);
    const status = states.some(state => state.status === 'error') ? 'error' : states.every(state => state.status === 'running') ? 'running' : 'starting';
    this.options.onStatus({ status, message: status === 'running' ? 'Two teams of three native Luna / xhigh drones connected.' : `Connecting teams (${children.length}/6 native drones)…`,
      model: MODEL, effort: EFFORT, children, teams: Object.fromEntries(this.runtimeStates),
      usage: states.reduce((sum, state) => sum + (typeof state.usage === 'number' ? state.usage : 0), 0),
      threadId: this.runtimeStates.get('blue')?.threadId,
    });
  }
  async start() {
    await Promise.all([...this.networks.values()].map(network => network.start()).concat([this.vehicle.start()]));
    if (this.stopped || !this.options.game.state.running) throw new Error('Match startup cancelled');
    this.options.game.radioTransport = this.radio; this.options.game.vehicleTransport = this.vehicle;
    await Promise.all([...this.runtimes.values()].map(runtime => runtime.start()));
    if (this.stopped) throw new Error('Match startup cancelled');
  }
  async link(id: DroneId, online: boolean) {
    if (this.options.game.state.drones.find(drone => drone.id === id)?.alive === false) throw new Error('Destroyed drones cannot reconnect');
    await this.networkFor(teamForDrone(id)).link(id, online);
  }
  async retireDrone(id: DroneId) {
    if (this.stopped) return;
    const team = teamForDrone(id);
    try { await Promise.all([this.runtimes.get(team)?.retireDrone(id), this.networkFor(team).link(id, false)]); }
    catch (error) { this.fail(`Could not retire ${id}: ${String(error)}`); }
  }
  async refreshTools() { await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.refreshTools())); }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = (async () => {
      await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.stop()).concat([...this.networks.values()].map(network => network.stop()), [this.vehicle.stop()]));
      if (this.options.game.radioTransport === this.radio) this.options.game.radioTransport = undefined;
      if (this.options.game.vehicleTransport === this.vehicle) this.options.game.vehicleTransport = undefined;
    })();
    return this.stopPromise;
  }
}
