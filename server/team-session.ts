import { randomUUID } from 'node:crypto';
import { CodexFleetRuntime, type RuntimeOptions } from './runtime.ts';
import { createDroneTools, MODEL, EFFORT } from './runtime-tools.ts';
import { FleetNetwork } from './network.ts';
import { RadioTransfers, type TransferRequest } from './radio-transfer.ts';
import { MavlinkAdapter } from './mavlink.ts';
import type { FleetGame } from './game.ts';
import { MATCH_FLEET, teamForDrone, teamRoster, type DroneId, type TeamId } from '../shared/fleet.ts';
import type { NetworkState, RadioMessage, RuntimeState } from '../shared/types.ts';

const TEAMS: TeamId[] = ['blue', 'red'];
type RuntimeActor = Pick<CodexFleetRuntime, 'start' | 'stop' | 'retireDrone' | 'refreshTools'>;
type NetworkActor = Pick<FleetNetwork, 'start' | 'stop' | 'state' | 'send' | 'consume' | 'link'> & Partial<Pick<FleetNetwork, 'storage'>>;
type VehicleActor = Pick<MavlinkAdapter, 'start' | 'stop' | 'command' | 'sample'>;
type Dependencies = {
  runtime?: (options: RuntimeOptions) => RuntimeActor;
  network?: (options: ConstructorParameters<typeof FleetNetwork>[0]) => NetworkActor;
  vehicle?: (options: ConstructorParameters<typeof MavlinkAdapter>[0]) => VehicleActor;
};

/** One match, two independent native parents, two radio namespaces, six vehicle IDs. */
export class TeamSession {
  private stopped = false;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private radioReady = false;
  private radioDirty = false;
  private radioTask?: Promise<void>;
  private radioFailure?: Error;
  private manualIsolation = new Set<DroneId>();
  private retired = new Set<DroneId>();
  private appliedLinks = new Map<DroneId, boolean>();
  private readonly interferenceChanged = () => { void this.reconcileRadio().catch(() => {}); };
  private runtimes = new Map<TeamId, RuntimeActor>();
  private networks = new Map<TeamId, NetworkActor>();
  private runtimeStates = new Map<TeamId, RuntimeState>();
  private networkStates = new Map<TeamId, NetworkState>();
  private transfers = new Map<TeamId, RadioTransfers>();
  readonly vehicle: VehicleActor;
  readonly radio = {
    send: async (message: RadioMessage, options: { beforeSend?: () => void } = {}) => {
      if (message.from === 'player') throw new Error('Player radio must select a team');
      await this.reconcileRadio();
      this.validateSender(message, true);
      options.beforeSend?.();
      return this.networkFor(teamForDrone(message.from as DroneId)).send(message);
    },
    sendTeam: async (team: TeamId, message: RadioMessage) => {
      if (message.from !== 'player') throw new Error('Only player messages use the operator relay');
      if (team !== 'blue' && message.kind && message.kind !== 'mission') throw new Error('Ordinary player chat cannot access red');
      await this.reconcileRadio();
      return this.networkFor(team).send(message);
    },
    consume: (id: DroneId, ids: string[]) => this.networkFor(teamForDrone(id)).consume(id, ids),
    storage: (id: DroneId) => this.networkFor(teamForDrone(id)).storage?.(id),
    transfer: (id: DroneId, args: Record<string, unknown>) => this.transfers.get(teamForDrone(id))!.tool(id, args as unknown as TransferRequest),
  };

  constructor(private options: { projectDir: string; game: FleetGame; onStatus: (status: RuntimeState) => void; onNetwork: (state: NetworkState) => void; onEvent: (type: string, event: unknown) => void; onFailure: (message: string) => void }, dependencies: Dependencies = {}) {
    for (const team of TEAMS) {
      this.runtimeStates.set(team, { status: 'starting', message: `${team} team connecting`, model: MODEL, effort: EFFORT, children: [], usage: 0 });
      const network = (dependencies.network ?? (config => new FleetNetwork(config)))({ projectDir: options.projectDir, sessionId: options.game.sessionIdentity,
        networkId: randomUUID(), roster: teamRoster(team), playerChat: team === 'blue',
        onReceive: (id, message) => { if (!this.stopped) options.game.receiveRadio(id, message); },
        onPlayerReceive: message => { if (!this.stopped && team === 'blue') options.game.receivePlayerRadio(message); },
        onTransferReceive: (id, message) => { if (!this.stopped) this.transfers.get(team)?.receive(id, message); },
        onDelivery: event => { if (!this.stopped) options.game.recordRadioDelivery(event.id, event); },
        onState: state => { this.networkStates.set(team, state); this.publishNetwork(); },
        onEvent: event => options.onEvent('network', { team, ...event }),
        onFailure: message => this.fail(`${team} network: ${message}`),
      });
      this.networks.set(team, network); this.networkStates.set(team, network.state);
      this.transfers.set(team, new RadioTransfers({ sessionId: options.game.sessionIdentity, roster: teamRoster(team),
        workspace: id => options.game.onboardWorkspace(id),
        active: id => !this.stopped && options.game.state.running && options.game.state.drones.some(drone => drone.id === id && drone.alive !== false),
        mission: id => options.game.receivedMission(id),
        simTime: () => options.game.state.simTime,
        send: async (message, ttlMs, beforeSend) => {
          await this.reconcileRadio();
          this.validateSender(message, message.data?.operation === 'chunk');
          beforeSend();
          return this.networkFor(team).send(message, { ttlMs });
        },
        consume: (id, ids) => network.consume(id, ids), onEvent: event => options.onEvent('network', { team, ...(event as object) }),
      }));
      const runtime = (dependencies.runtime ?? (config => new CodexFleetRuntime(config)))({ projectDir: options.projectDir, roster: teamRoster(team), team,
        toolHandler: async (role, name, args) => {
          if (role === 'parent') {
            try { return await options.game.forwardTeam(team); }
            catch (error) {
              this.fail(`${team} objective relay failed: ${error instanceof Error ? error.message : String(error)}`);
              throw error;
            }
          }
          if (!teamRoster(team).some(member => member.id === role)) throw new Error('Actor identity is outside this team');
          return options.game.tool(role, name, args);
        },
        toolsForRole: role => teamRoster(team).some(member => member.id === role) ? createDroneTools(teamRoster(team), options.game.toolCapabilities(role), team) : [],
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
  /** No await between these final lifecycle checks and native queue admission. */
  private validateSender(message: RadioMessage, requireMission: boolean) {
    const game = this.options.game, id = message.from as DroneId;
    if (this.stopped || !game.state.running || game.sessionIdentity !== message.sessionId || this.retired.has(id)
      || !game.state.drones.some(drone => drone.id === id && drone.alive !== false)) throw new Error('Radio sender is unavailable');
    if (requireMission && game.receivedMission(id) !== message.mission) throw new Error('Received objective changed; radio cancelled');
  }
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
  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Match startup cancelled'));
    if (this.startPromise) return this.startPromise;
    this.options.game.radioInterferenceChanged = this.interferenceChanged;
    this.startPromise = (async () => {
      try {
        await Promise.all([...this.networks.values()].map(network => network.start()).concat([this.vehicle.start()]));
        if (this.stopped || !this.options.game.state.running) throw new Error('Match startup cancelled');
        // Native workers start online. Desired restrictions are reconciled before actors start.
        for (const { id } of MATCH_FLEET) this.appliedLinks.set(id, true);
        this.radioReady = true;
        this.options.game.radioTransport = this.radio; this.options.game.vehicleTransport = this.vehicle;
        await this.reconcileRadio();
        if (this.stopped) throw new Error('Match startup cancelled');
        await Promise.all([...this.runtimes.values()].map(runtime => runtime.start()));
        if (this.stopped) throw new Error('Match startup cancelled');
      } catch (error) { await this.stop(); throw error; }
    })();
    return this.startPromise;
  }

  private desiredLink(id: DroneId) {
    const drone = this.options.game.state.drones.find(member => member.id === id);
    return Boolean(drone && drone.alive !== false && !drone.radioJammed && !this.manualIsolation.has(id) && !this.retired.has(id));
  }

  private async applyRadioLinks() {
    while (!this.stopped && this.radioDirty) {
      this.radioDirty = false;
      for (const { id } of MATCH_FLEET) {
        if (this.stopped) return;
        const online = this.desiredLink(id);
        if (this.appliedLinks.get(id) === online) continue;
        await this.networkFor(teamForDrone(id)).link(id, online);
        if (this.stopped) return;
        this.appliedLinks.set(id, online);
      }
    }
  }

  /** Settles native link changes before sending; native peers retain queued bytes while offline. */
  async reconcileRadio(): Promise<void> {
    this.radioDirty = true;
    while (!this.stopped && this.radioReady) {
      if (this.radioFailure) throw this.radioFailure;
      this.radioTask ??= this.applyRadioLinks();
      const task = this.radioTask;
      try { await task; }
      catch (error) {
        if (this.stopped) return;
        if (!this.radioFailure) {
          this.radioFailure = error instanceof Error ? error : new Error(String(error));
          this.fail(`Native radio reconciliation failed: ${this.radioFailure.message}`);
        }
        throw this.radioFailure;
      } finally { if (this.radioTask === task) this.radioTask = undefined; }
      // A newer request can arrive while the preceding task's completion is queued.
      if (!this.radioDirty && !this.radioTask) return;
    }
  }
  async link(id: DroneId, online: boolean) {
    this.networkFor(teamForDrone(id));
    if (online && (this.retired.has(id) || this.options.game.state.drones.find(drone => drone.id === id)?.alive === false)) throw new Error('Destroyed drones cannot reconnect');
    if (online) this.manualIsolation.delete(id); else this.manualIsolation.add(id);
    await this.reconcileRadio();
  }
  async retireDrone(id: DroneId) {
    if (this.stopped || this.retired.has(id)) return;
    this.retired.add(id);
    this.transfers.get(teamForDrone(id))?.retire(id);
    const team = teamForDrone(id);
    try { await Promise.all([this.runtimes.get(team)?.retireDrone(id), this.reconcileRadio()]); }
    catch (error) { if (!this.radioFailure) this.fail(`Could not retire ${id}: ${String(error)}`); }
  }
  async refreshTools() { await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.refreshTools())); }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.radioReady = false;
    for (const transfer of this.transfers.values()) transfer.stop();
    if (this.options.game.radioInterferenceChanged === this.interferenceChanged) this.options.game.radioInterferenceChanged = undefined;
    this.stopPromise = (async () => {
      await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.stop()).concat([...this.networks.values()].map(network => network.stop()), [this.vehicle.stop()]));
      if (this.options.game.radioTransport === this.radio) this.options.game.radioTransport = undefined;
      if (this.options.game.vehicleTransport === this.vehicle) this.options.game.vehicleTransport = undefined;
    })();
    return this.stopPromise;
  }
}
