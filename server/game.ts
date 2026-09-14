import { LaunchGate } from './launch-gate.ts';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { type Drone, type DroneId, type GameState, type Pose, type Role, type ToolResult, type RadioMessage, type GameEvent } from '../shared/types.ts';
import { MATCH_DRONE_IDS as DRONE_IDS, teamForDrone, teamRoster, type TeamId } from '../shared/fleet.ts';
import { BATTLEFIELD } from '../shared/battlefield.ts';
import { batteryCapacityFor, hasBatteries, cargoCapacityFor, startingEquipment, RTS_CONFIG, type EquipmentItem, type EquipmentModule, type MatchState } from '../shared/rts.ts';
import { CITY } from '../shared/city.ts';
import { cameraFovFor, DRONE_CAMERA } from '../shared/camera-profile.ts';
import { Mailbox } from './mailbox.ts';
import { CAMERA_PITCH_LIMITS, DroneMotion } from './drone-motion.ts';
import { RtsRules } from './rts.ts';
import type { RecordedObservation } from '../shared/replay.ts';
import { createDroneTools, MODEL, EFFORT, RTS_MISSION } from './runtime-tools.ts';
import { CommandJobs } from './command-jobs.ts';
import { ONBOARD_PROFILE, type MovementProfile, type ObservationOrigin } from '../shared/onboard.ts';
import { LocalSensors, rangeSampleFresh } from './local-sensors.ts';
import { OnboardStorageError, OnboardWorkspace } from './onboard-workspace.ts';
import { RoutineRunner, type RoutineCallContext, type RoutineStatus } from './routine-runner.ts';
import { onboardRuntimeBytes } from './onboard-manifest.ts';

const BOUNDS = CITY.bounds;
const textResult = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const finite = (value: unknown, label: string) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
};
const poseOf = ({ x, y, z, yaw, pitch }: Pose): Pose => ({ x, y, z, yaw, pitch });
const positionOf = ({ x, y, z }: Pose) => ({ x, y, z });
const mailExpired = (message: { expiresMonotonicMs?: number; expiresAt?: string }) =>
  message.expiresMonotonicMs !== undefined ? message.expiresMonotonicMs <= performance.now()
    : Boolean(message.expiresAt && Date.parse(message.expiresAt) <= Date.now());
const activityOf = (drone: Drone) => drone.action ? { id: drone.action.id, kind: drone.action.kind }
  : drone.servicing ? { id: 'servicing', kind: drone.servicing.kind ?? 'rearm' }
  : drone.mining ? { id: 'mining', kind: 'mine' } : null;
class ControllerRejection extends Error {}
interface VehicleTransport {
  command(id: DroneId, args: Record<string, unknown>, pose: Pose, simTime: number): Promise<Record<string, unknown>>;
  sample(id: DroneId, pose: Pose, simTime: number, velocity?: { x: number; y: number; z: number }): Promise<{
    position: { x: number; y: number; z: number }; heading: { degrees: number }; simTime: number;
    velocity?: { x: number; y: number; z: number }; cameraOrientation?: { heading: number; pitch: number };
  }>;
}
interface RadioTransport {
  send(message: RadioMessage, options?: { beforeSend?: () => void }): Promise<unknown>; sendTeam?(team: TeamId, message: RadioMessage): Promise<unknown>;
  consume(id: DroneId, ids: string[]): void;
  transfer?(id: DroneId, args: Record<string, unknown>): Promise<unknown>;
  storage?(id: DroneId): unknown;
}

export class FleetGame extends EventEmitter {
  private launchGate?: LaunchGate;
  awaitFleetLaunch() { this.launchGate = new LaunchGate(this.state.drones.map(drone => drone.id)); }
  state: GameState;
  inboxes: Record<DroneId, Mailbox>;
  private playerQueue: Array<{ id: string; text: string; team: TeamId; bootstrap?: boolean }> = [];
  private playerWake = new Set<() => void>();
  private serial = 0;
  private rules = new RtsRules(event => {
    this.emit('match-event', event);
    if (event.drone && event.type === 'armor_consumed') {
      this.jobs?.cancel(event.drone, 'armor-lost');
      this.routines?.get(event.drone)?.cancel('armor-lost');
      const collision = event.cause === 'terrain' || event.cause === 'ram';
      // Local damage feedback only: never forward the impact's target, source or coordinates.
      this.inboxes[event.drone].push({ type: 'armor_lost', mission: this.droneMissions[event.drone],
        cause: collision ? 'collision' : 'hit', message: collision ? 'Collision detected. Armor lost.' : 'Hit detected. Armor lost.',
        simTime: event.simTime, occurredAt: new Date().toISOString() });
    }
    if (event.drone && ['service_completed', 'service_cancelled', 'battery_low', 'battery_full', 'radio_changed', 'cargo_loading', 'cargo_loaded', 'cargo_unloading', 'cargo_delivered', 'cargo_cancelled'].includes(event.type)) {
      this.inboxes[event.drone].push({ type: event.type, mission: this.droneMissions[event.drone], simTime: event.simTime, occurredAt: new Date().toISOString() });
    }
    if (event.type === 'radio_changed') {
      this.radioInterferenceChanged?.();
      for (const wake of [...this.playerWake]) wake();
    }
  });
  private teamMissions: Record<TeamId, number> = { blue: 0, red: 0 };
  private connected = false;
  private toolErrors = new Map<Role, number>();
  private sessionId = randomUUID();
  private toolTurns = new Map<DroneId, Promise<unknown>>();
  private receivedRadio = new Map<string, number>();
  private droneMissions = Object.fromEntries(DRONE_IDS.map(id => [id, 0])) as Record<DroneId, number>;
  private deferredRadio = new Map<DroneId, RadioMessage[]>();
  private motion = new DroneMotion();
  private localSensors = new LocalSensors();
  private jobs = new CommandJobs({
    drone: id => this.drone(id), validate: (id, mission) => this.validateMission(id, mission),
    hold: id => { const drone = this.drone(id); drone.action = undefined; this.motion.hover(drone); },
    waypoint: async (id, target, profile, owner, valid) => {
      const drone = this.drone(id), mission = this.droneMissions[id];
      const args = { ...target, kind: 'fly_to', mission };
      const decoded = this.vehicleTransport ? await this.vehicleTransport.command(id, args, poseOf(drone), this.state.simTime) : args;
      if (!valid()) return;
      this.validateMission(id, mission);
      this.act(drone, { ...decoded, mission, profile, owner });
    },
    event: (id, job) => {
      this.motionVersions.set(id, (this.motionVersions.get(id) ?? 0) + 1);
      if (job.state === 'blocked' || job.state === 'failed') this.routines?.get(id)?.cancel(job.reason ?? job.state);
      this.inboxes[id].push({ type: 'job', mission: job.mission, job, simTime: this.state.simTime });
      this.emit('job', { drone: id, job, simTime: this.state.simTime }); this.emit('change');
    },
  });
  private observationSequences = new Map<DroneId, number>();
  private deliveredObservationSequences = new Map<DroneId, number[]>();
  private latestCameras = new Map<DroneId, { available: boolean; acquiredAtMs: number; simTime: number; pose: Pose; image?: ToolResult['content'][number] }>();
  private workspaces = new Map<DroneId, OnboardWorkspace>();
  private motionVersions = new Map<DroneId, number>();
  private routines = new Map<DroneId, RoutineRunner>();
  private routineEvents = new Map<DroneId, GameEvent[]>();
  radioTransport?: RadioTransport;
  radioInterferenceChanged?: () => void;
  vehicleTransport?: VehicleTransport;
  get sessionIdentity() { return this.sessionId; }
  capture: (id: DroneId, pose: Pose, simTime: number, drones: Drone[], match?: MatchState) => Promise<string> = async () => { throw new Error('Camera browser is disconnected'); };

  constructor() {
    super();
    this.inboxes = this.newInboxes();
    this.state = this.newState();
  }

  private drone(id: DroneId) { return this.state.drones.find(drone => drone.id === id)!; }
  receivedMission(id: DroneId) { return this.droneMissions[id]; }
  onboardWorkspace(id: DroneId): OnboardWorkspace {
    if (!DRONE_IDS.includes(id)) throw new Error('Unknown onboard identity');
    let workspace = this.workspaces.get(id);
    if (!workspace) {
      workspace = new OnboardWorkspace({ runtimeBytes: onboardRuntimeBytes(),
        eventBytes: () => this.inboxes[id].localBytes,
        radioBytes: () => Number((this.radioTransport?.storage?.(id) as { storageBytes?: number } | undefined)?.storageBytes ?? 0) });
      this.workspaces.set(id, workspace);
    }
    return workspace;
  }
  private activeRoutine(id: DroneId) {
    const status = this.routines.get(id)?.status();
    return status && (status.state === 'accepted' || status.state === 'running') ? status : undefined;
  }
  private routineRunner(id: DroneId) {
    let runner = this.routines.get(id);
    if (!runner) {
      runner = new RoutineRunner(this.onboardWorkspace(id), {
        validate: mission => this.validateMission(id, mission),
        call: (method, args, context) => this.routineCall(id, method, args, context),
        onSource: source => this.emit('script-source', { drone: id, ...source, simTime: this.state.simTime }),
        onTrace: trace => this.emit('sdk-execution', { drone: id, ...trace, simTime: this.state.simTime }),
        onState: status => this.routineChanged(id, status),
      });
      this.routines.set(id, runner);
    }
    return runner;
  }
  private routineChanged(id: DroneId, status: RoutineStatus) {
    const terminal = ['completed', 'cancelled', 'failed'].includes(status.state);
    if (terminal) {
      if (this.jobs.owner(id) === status.id) this.jobs.cancel(id, `routine-${status.state}`);
      this.routineEvents.delete(id);
    } else this.routineEvents.set(id, this.routineEvents.get(id) ?? []);
    const job = { ...status, sourcePath: status.path, reason: status.reason ?? status.error };
    this.drone(id).job = job;
    this.inboxes[id].push({ type: 'routine', mission: status.mission, job, simTime: this.state.simTime });
    this.emit('routine-state', { drone: id, ...status, simTime: this.state.simTime }); this.emit('change');
  }
  private validateRoutine(id: DroneId, context: RoutineCallContext) {
    this.validateMission(id, context.mission);
    if (context.signal.aborted || this.activeRoutine(id)?.id !== context.jobId) throw new ControllerRejection('Routine no longer owns this operation');
  }
  private async routineCall(id: DroneId, method: string, value: unknown, context: RoutineCallContext) {
    this.validateRoutine(id, context);
    if (method === 'telemetry') return this.ownTelemetry(id);
    if (method === 'camera') {
      const frame = this.latestCameras.get(id);
      return frame ? { ...frame, ageMs: performance.now() - frame.acquiredAtMs, fresh: this.connected && performance.now() - frame.acquiredAtMs <= 2000 }
        : { available: false, reason: 'No model-acquired frame is available' };
    }
    if (method === 'events') {
      const events = this.routineEvents.get(id) ?? [];
      this.routineEvents.set(id, []);
      return { events: structuredClone(events) };
    }
    const args = value as Record<string, unknown>;
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ControllerRejection('SDK args must be an object');
    if (!['act', 'send', 'buy', 'fire', 'rearm', 'cameraMode'].includes(method)) throw new ControllerRejection('Unknown SDK operation');
    const response = await this.dispatch(id, method === 'cameraMode' ? 'camera' : method, { ...args, mission: context.mission }, context);
    this.validateRoutine(id, context);
    const block = response.content.find(item => item.type === 'text');
    const result = block?.type === 'text' ? JSON.parse(block.text) : {};
    if (response.isError || result.rejected) throw new ControllerRejection(result.reason ?? result.error ?? 'SDK operation rejected');
    return result;
  }
  private validateMission(id: DroneId, mission: number) {
    if (!this.state.running || this.drone(id).alive === false) throw new ControllerRejection('Drone session is stopped');
    if (!mission || this.droneMissions[id] !== mission) throw new ControllerRejection('Received objective changed; command cancelled');
  }
  private origin(id: DroneId, args: Record<string, unknown>): ObservationOrigin | undefined {
    const sequence = args.observation_sequence, cursor = args.event_cursor;
    if (sequence !== undefined && (!Number.isInteger(sequence) || !this.deliveredObservationSequences.get(id)?.includes(sequence as number))) throw new ControllerRejection('Originating observation was not delivered or is no longer retained');
    if (cursor !== undefined && (!Number.isInteger(cursor) || (cursor as number) < 0 || (cursor as number) > this.inboxes[id].delivered)) throw new ControllerRejection('Unknown originating event cursor');
    return { observationSequence: sequence as number | undefined ?? this.deliveredObservationSequences.get(id)?.at(-1),
      eventCursor: cursor as number | undefined ?? this.inboxes[id].delivered };
  }

  private newInboxes() { return Object.fromEntries(DRONE_IDS.map(id => {
    const mailbox = new Mailbox();
    mailbox.onOverflow = partition => {
      this.stop(); this.emit('transport-error', { role: id, message: `Onboard ${partition} inbox capacity exhausted; unread messages preserved` });
    };
    mailbox.onPush = event => {
      const events = this.routineEvents.get(id);
      if (!events || !this.activeRoutine(id)) return;
      if (Buffer.byteLength(JSON.stringify(events)) + Buffer.byteLength(JSON.stringify(event)) > 64 * 1024) {
        this.routines.get(id)?.cancel('routine-event-buffer-full'); return;
      }
      events.push(structuredClone(event));
    };
    return [id, mailbox];
  })) as Record<DroneId, Mailbox>; }
  private newState(): GameState {
    return {
      simTime: 0, mission: 0, running: false, speed: 1,
      completed: false, treasures: [], match: this.rules.newMatch(BATTLEFIELD.resources, BATTLEFIELD.servicePads),
      obstacles: CITY.buildings.map(building => ({ ...building })),
      drones: DRONE_IDS.map(id => ({ id, ...BATTLEFIELD.spawns[id], team: teamForDrone(id), alive: true,
        equipment: startingEquipment(), ammo: 0, cameraMode: 'wide', jamming: false, radioJammed: false,
        cargo: { amount: 0 }, velocity: { x: 0, y: 0, z: 0 },
        status: 'Standby', online: false, observations: 0 })),
      radio: [], runtime: { status: 'idle', message: `Ready to launch ${DRONE_IDS.length} native drone agents`, model: MODEL, effort: EFFORT },
    };
  }

  reset() {
    if (this.state.running) throw new Error('Stop the fleet before resetting');
    this.stop(); this.state = this.newState(); this.inboxes = this.newInboxes();
    this.playerQueue = []; this.emit('change');
  }
  start() {
    this.launchGate = undefined;
    if (!this.connected) throw new Error('Open the game browser before launching the fleet');
    this.inboxes = this.newInboxes();
    this.toolErrors.clear();
    this.sessionId = randomUUID();
    this.receivedRadio.clear();
    for (const id of DRONE_IDS) this.droneMissions[id] = 0;
    this.deferredRadio.clear();
    this.motion.clear();
    this.jobs.reset();
    for (const runner of this.routines.values()) runner.cancel('new-match');
    for (const workspace of this.workspaces.values()) workspace.revoke();
    this.routines.clear(); this.workspaces.clear(); this.routineEvents.clear();
    this.observationSequences.clear();
    this.deliveredObservationSequences.clear();
    this.localSensors.clear(); this.latestCameras.clear();
    this.teamMissions = { blue: 0, red: 0 };
    this.state.mission = 0; this.state.simTime = 0; this.state.radio = [];
    this.state.running = true;
    for (const drone of this.state.drones) Object.assign(drone, BATTLEFIELD.spawns[drone.id]);
    this.rules.begin(this.state);
    this.playerQueue = (['blue', 'red'] as const).map(team => ({ id: `player-${++this.serial}`, text: RTS_MISSION, team, bootstrap: true }));
    for (const drone of this.state.drones) { drone.action = undefined; drone.online = false; drone.status = 'Connecting'; }
    for (const drone of this.state.drones) { drone.job = undefined; drone.storage = undefined; }
    this.emit('change');
  }
  stop() {
    this.state.running = false;
    for (const id of DRONE_IDS) this.motionVersions.set(id, (this.motionVersions.get(id) ?? 0) + 1);
    for (const runner of this.routines.values()) runner.cancel('stopped');
    this.jobs.cancelAll('stopped');
    this.playerQueue = [];
    this.motion.clear();
    for (const drone of this.state.drones) drone.jamming = false;
    this.rules.syncInterference(this.state);
    for (const drone of this.state.drones) {
      this.rules.cancelLogistics(this.state, drone, 'stopped');
      drone.action = undefined; drone.online = false; drone.charging = hasBatteries(this.state.match?.rulesVersion) ? false : undefined; this.rules.cancelMining(drone); this.rules.cancelService(this.state, drone);
      if (drone.alive !== false) drone.status = 'Stopped';
      this.inboxes[drone.id].push({ type: 'stop', mission: this.state.mission, simTime: this.state.simTime, occurredAt: new Date().toISOString() });
    }
    for (const wake of [...this.playerWake]) wake();
    this.emit('change');
  }
  setConnected(value: boolean) { this.connected = value; this.emit('change'); }
  setSpeed(value: unknown) {
    const speed = finite(value, 'speed');
    if (speed < 0.25 || speed > 3) throw new Error('Speed must be between 0.25 and 3');
    this.state.speed = speed;
  }
  queueMission(value: unknown, team: TeamId = 'blue') {
    if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw new Error('Instruction must be 1–4000 characters');
    this.playerQueue = this.playerQueue.filter(item => !(item.team === team && item.bootstrap));
    const item = { id: `player-${++this.serial}`, text: value, team };
    this.playerQueue.push(item);
    for (const wake of [...this.playerWake]) wake();
    return { queued: true, id: item.id };
  }

  async sendPlayerChat(value: unknown, to: unknown = 'all') {
    if (!this.state.running) throw new Error('Launch the fleet before sending chat');
    if (typeof value !== 'string' || !value.trim() || value.length > 1200) throw new Error('Chat must be 1–1200 characters');
    if (to !== 'all' && !teamRoster('blue').some(peer => peer.id === to)) throw new Error('Player chat is available only to blue');
    const message = this.log('player', to as string, 'chat', value, { team: 'blue' }, this.teamMissions.blue);
    if (this.radioTransport?.sendTeam) await this.radioTransport.sendTeam('blue', message);
    else if (this.radioTransport) await this.radioTransport.send(message);
    else for (const peer of teamRoster('blue')) if (to === 'all' || to === peer.id) this.receiveRadio(peer.id, message);
    return { queued: message.id, stage: 'queued-locally' };
  }

  receivePlayerRadio(message: RadioMessage) {
    if (!this.state.running || message.sessionId !== this.sessionId || !teamRoster('blue').some(peer => peer.id === message.from)
      || !['all', 'player'].includes(message.to) || mailExpired(message)) return;
    const existing = this.state.radio.find(item => item.id === message.id);
    if (existing) existing.delivery = { ...(existing.delivery ?? { storedBy: [], bundledBy: [] }),
      storedBy: [...new Set([...(existing.delivery?.storedBy ?? []), 'player'])] };
    else { this.state.radio.push(structuredClone(message)); if (this.state.radio.length > 400) this.state.radio.shift(); }
    this.emit('player-radio', message); this.emit('change');
  }

  recordRadioDelivery(id: string, event: { status?: string; recipient?: string; recipients?: string[]; receivedBy?: string[] }) {
    const message = this.state.radio.find(item => item.id === id);
    if (!message) return;
    const received = event.status === 'stored' && event.recipient ? [event.recipient]
      : event.status === 'received' ? event.recipients ?? [] : event.receivedBy ?? [];
    message.delivery ??= { queuedAt: message.sentAt, storedBy: [], bundledBy: [] };
    message.delivery.storedBy = [...new Set([...message.delivery.storedBy, ...received])];
    this.emit('radio-delivery', structuredClone(message)); this.emit('change');
  }

  receiveRadio(recipient: DroneId, message: RadioMessage) {
    if (!DRONE_IDS.includes(recipient)) return;
    const member = this.state.drones.find(drone => drone.id === recipient);
    // Production receipt/expiry remains owned by native Zenoh. This isolated-test
    // seam cannot deliver radio around the interference rule.
    if (!this.radioTransport && (member?.radioJammed || this.state.drones.find(drone => drone.id === message.from)?.radioJammed)) return;
    if (member?.alive === false || (message.from === 'player' && message.kind !== 'mission' && teamForDrone(recipient) !== 'blue')
      || (message.from !== 'player' && !teamRoster(teamForDrone(recipient)).some(peer => peer.id === message.from))) {
      this.radioTransport?.consume(recipient, [message.id]); return;
    }
    const key = `${recipient}:${message.id}`;
    if (!this.state.running || message.sessionId !== this.sessionId) {
      this.radioTransport?.consume(recipient, [message.id]); return;
    }
    const nowMs = performance.now();
    for (const [id, expires] of this.receivedRadio) if (expires <= nowMs) this.receivedRadio.delete(id);
    if (this.receivedRadio.has(key)) return;
    this.receivedRadio.set(key, nowMs + Math.max(0, Math.min(120_000,
      message.expiresMonotonicMs !== undefined ? message.expiresMonotonicMs - nowMs : message.expiresAt ? Date.parse(message.expiresAt) - Date.now() : 120_000)));
    if (mailExpired(message)) {
      this.inboxes[recipient].push({ type: 'message_expired', mission: this.droneMissions[recipient], id: message.id });
      this.radioTransport?.consume(recipient, [message.id]); return;
    }
    if (message.from === 'player' && message.kind === 'mission') {
      if (message.mission <= this.droneMissions[recipient]) { this.radioTransport?.consume(recipient, [message.id]); return; }
      this.droneMissions[recipient] = message.mission;
      this.motionVersions.set(recipient, (this.motionVersions.get(recipient) ?? 0) + 1);
      const drone = this.state.drones.find(d => d.id === recipient)!;
      this.jobs.cancel(recipient, 'objective-replaced');
      this.routines.get(recipient)?.cancel('objective-replaced');
      this.rules.cancelLogistics(this.state, drone, 'objective-replaced');
      this.motion.clear(drone);
      this.rules.cancelService(this.state, drone);
      drone.jamming = false; this.rules.syncInterference(this.state);
      drone.action = undefined; drone.status = 'New instruction';
      this.inboxes[recipient].push({ type: 'player', mission: message.mission, text: message.text, id: message.id, simTime: message.simTime, occurredAt: message.sentAt, expiresAt: message.expiresAt, expiresMonotonicMs: message.expiresMonotonicMs });
      const pending = this.deferredRadio.get(recipient) ?? [];
      this.deferredRadio.delete(recipient);
      for (const item of pending) { this.receivedRadio.delete(`${recipient}:${item.id}`); this.receiveRadio(recipient, item); }
      return;
    }
    if (message.from !== 'player' && message.mission > this.droneMissions[recipient]) {
      const pending = this.deferredRadio.get(recipient) ?? []; pending.push(message); this.deferredRadio.set(recipient, pending); return;
    }
    if (message.from !== 'player' && message.mission < this.droneMissions[recipient]) { this.radioTransport?.consume(recipient, [message.id]); return; }
    this.inboxes[recipient].push({ type: 'radio', mission: message.mission, message });
  }

  private log(from: string, to: string, kind: string, text: string, data?: Record<string, unknown>, mission = this.state.mission): RadioMessage {
    const sequence = ++this.serial;
    const message = { protocol: 'fleet-radio/1' as const, sessionId: this.sessionId, sequence, sentAt: new Date().toISOString(),
      id: `${this.sessionId}:${sequence}`, from, to, kind, text, data, mission, simTime: this.state.simTime };
    this.state.radio.push(message);
    if (this.state.radio.length > 400) this.state.radio.shift();
    this.emit('radio', message); this.emit('change');
    return message;
  }

  async forwardTeam(team: TeamId) {
    const members = () => this.state.drones.filter(d => teamForDrone(d.id) === team && d.alive !== false);
    const ready = () => this.playerQueue.some(item => item.team === team) && members().every(d => d.online && (this.radioTransport || !d.radioJammed));
    if (!ready() && this.state.running) {
      await new Promise<void>(resolve => {
        const wake = () => {
          if (this.state.running && !ready()) return;
          done();
        };
        const done = () => { clearTimeout(timer); this.playerWake.delete(wake); resolve(); };
        const timer = setTimeout(done, 30_000);
        this.playerWake.add(wake);
      });
    }
    if (!this.state.running) return textResult({ stopped: true });
    if (!ready()) return textResult({ waiting: true, readyDrones: members().filter(d => d.online).length });
    const item = this.playerQueue.splice(this.playerQueue.findIndex(item => item.team === team), 1)[0];
    const mission = ++this.teamMissions[team];
    if (team === 'blue') this.state.mission = mission;
    const message = this.log('player', 'all', 'mission', item.text, { team }, mission);
    if (this.radioTransport?.sendTeam) await this.radioTransport.sendTeam(team, message);
    else if (this.radioTransport) await this.radioTransport.send(message);
    else for (const member of members()) this.receiveRadio(member.id, message);
    return textResult({ forwarded: item.id, mission, recipients: members().map(d => d.id) });
  }

  toolCapabilities(role: Role) {
    const drone = this.state.drones.find(d => d.id === role);
    return { alive: Boolean(drone && drone.alive !== false && this.state.running),
      onboard: true,
      shop: Boolean(drone && this.state.match?.teams[teamForDrone(drone.id)].shopUnlocked), gun: Boolean(drone?.equipment?.gun), optics: Boolean(drone?.equipment?.optics), jammer: Boolean(drone?.equipment?.jammer) };
  }

  async tool(role: Role, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    if (role === 'parent' || !DRONE_IDS.includes(role)) return this.completeTool(role, name, args);
    // Safety/cancellation admission must not wait behind camera encoding or wait().
    if ((name === 'act' && args.kind === 'hover') || ((name === 'route' || name === 'routine') && args.op === 'cancel')) return this.completeTool(role, name, args);
    const sessionId = this.sessionId;
    // One decision boundary per drone; other drones continue independently.
    const turn = (this.toolTurns.get(role) ?? Promise.resolve()).then(() => sessionId === this.sessionId
      ? this.completeTool(role, name, args)
      : textResult({ stopped: true, instruction: 'This drone session has ended.' }));
    this.toolTurns.set(role, turn.catch(() => {}));
    return turn;
  }

  private async completeTool(role: Role, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const sessionId = this.sessionId;
    const result = await this.dispatch(role, name, args);
    if (sessionId !== this.sessionId) return textResult({ stopped: true, instruction: 'This drone session has ended.' });
    if (result.isError) {
      const consecutive = (this.toolErrors.get(role) ?? 0) + 1;
      this.toolErrors.set(role, consecutive);
      const message = result.content.find(content => content.type === 'text');
      this.emit('tool-error', { role, name, consecutive, message: message?.type === 'text' ? message.text : 'Tool failed' });
    } else this.toolErrors.set(role, 0);
    if (role !== 'parent' && DRONE_IDS.includes(role) && this.state.running && this.state.drones.find(d => d.id === role)?.alive !== false) {
      try { return await this.withObservation(role, result, args.after); }
      catch (error) {
        const message = `Observation transport failed: ${error instanceof Error ? error.message : String(error)}`;
        this.stop(); this.emit('transport-error', { role, message });
        return { ...textResult({ stopped: true, error: message, instruction: 'End this drone task; the sensor connection failed.' }), isError: true };
      }
    }
    return result;
  }

  private async snapshot(role: DroneId) {
    const sessionId = this.sessionId;
    const drone = this.state.drones.find(d => d.id === role)!, mission = this.droneMissions[role];
    const pose = poseOf(drone), simTime = this.state.simTime, capturedAt = new Date().toISOString(), acquiredAtMs = performance.now();
    const sequence = (this.observationSequences.get(role) ?? 0) + 1;
    this.observationSequences.set(role, sequence);
    const velocity = this.motion.velocity(drone);
    const ranges = this.localSensors.acquire(drone, this.state.obstacles, this.state.drones, simTime, acquiredAtMs);
    const currentAction = activityOf(drone);
    const zones = { mining: Boolean(drone.mining), charging: Boolean(drone.charging) };
    const peers = structuredClone(this.state.drones), matchState = structuredClone(this.state.match);
    const cameraFov = cameraFovFor(peers.find(peer => peer.id === role)!);
    const telemetry = this.vehicleTransport ? await this.vehicleTransport.sample(role, pose, simTime, velocity) : undefined;
    let camera: { available: boolean; width: number; height: number; error?: string } = { available: true, width: DRONE_CAMERA.width, height: DRONE_CAMERA.height };
    let image: ToolResult['content'][number] | undefined;
    try {
      const url = await this.capture(role, pose, simTime, peers, matchState);
      const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(url);
      if (!match) throw new Error('Invalid camera image');
      image = { type: 'image', mimeType: `image/${match[1]}`, data: match[2] };
      drone.observations++;
    } catch {
      camera = { ...camera, available: false, error: 'Camera unavailable; no image supplied. Wait for a fresh observation.' };
    }
    const ageMs = performance.now() - acquiredAtMs;
    if (sessionId === this.sessionId && this.state.running && this.drone(role).alive !== false
      && acquiredAtMs >= (this.latestCameras.get(role)?.acquiredAtMs ?? -Infinity)) {
      this.latestCameras.set(role, { available: camera.available, acquiredAtMs, simTime, pose, image });
    }
    const sensors = { sequence, frame: 'local-east-up-south', units: 'simulation-units', metersPerUnit: 10,
      validity: this.connected ? 'valid' : 'stalled', ageMs, idealizedStateEstimate: true,
      position: { frame: 'local', ...(telemetry?.position ?? positionOf(pose)) }, velocity: { ...(telemetry?.velocity ?? velocity), units: 'simulation-units/second' },
      heading: telemetry?.heading ?? { degrees: (360 - pose.yaw) % 360 }, cameraOrientation: telemetry?.cameraOrientation ?? { heading: (360 - pose.yaw) % 360, pitch: pose.pitch },
      timestamp: { capturedAt, acquiredAtMs, simTime: telemetry?.simTime ?? simTime },
      ranges: { ...ranges, fresh: rangeSampleFresh(ranges), ageMs },
      camera: { ...camera, sequence, acquiredAt: capturedAt, acquiredAtMs, simTime, framePose: pose,
        fovDegrees: cameraFov, ageMs, fresh: this.connected && ageMs <= 2000 } };
    return { sensors, image, currentAction, mission, pose, simTime, matchState, cameraFov, zones };
  }

  private async withObservation(role: DroneId, result: ToolResult, after: unknown): Promise<ToolResult> {
    const sessionId = this.sessionId;
    let sample = await this.snapshot(role);
    const active = () => this.state.running && sessionId === this.sessionId && this.state.drones.find(d => d.id === role)?.alive !== false;
    const drone = this.state.drones.find(d => d.id === role)!;
    // A short flight can finish while the browser encodes its frame. Refresh once
    // rather than pairing an arrival event with a pre-arrival picture by default.
    if (active() && (sample.currentAction?.id !== activityOf(drone)?.id || sample.currentAction?.kind !== activityOf(drone)?.kind
      || sample.zones.mining !== Boolean(drone.mining) || sample.zones.charging !== Boolean(drone.charging)
      || sample.mission !== this.droneMissions[role])) sample = await this.snapshot(role);
    if (!active()) return textResult({ stopped: true, instruction: 'This drone session has ended.' });
    const deferred = this.deferredRadio.get(role) ?? [];
    const expired = deferred.filter(message => mailExpired(message));
    this.deferredRadio.set(role, deferred.filter(message => !expired.includes(message)));
    for (const message of expired) {
      this.inboxes[role].push({ type: 'message_expired', mission: this.droneMissions[role], id: message.id });
      this.radioTransport?.consume(role, [message.id]);
    }
    // Drain after capture so mail arriving during rendering is included. No await after this cut.
    const inbox = this.inboxes[role].drain(typeof after === 'number' && Number.isFinite(after) ? after : undefined);
    const mailIds = inbox.events.filter(event => event.type === 'radio' || event.type === 'player')
      .map(event => event.type === 'radio' ? (event.message as RadioMessage | undefined)?.id : event.id)
      .filter((id): id is string => typeof id === 'string');
    this.radioTransport?.consume(role, mailIds);
    for (const id of mailIds) {
      const message = this.state.radio.find(item => item.id === id);
      if (message && (message.kind !== 'mission' || !mailExpired(message))) {
        message.delivery ??= { queuedAt: message.sentAt, storedBy: [], bundledBy: [] };
        message.delivery.bundledBy = [...new Set([...message.delivery.bundledBy, role])];
        this.emit('radio-delivery', structuredClone(message));
      }
    }
    inbox.events = inbox.events.map(event => {
      const expiry = event.type === 'radio' ? event.message as RadioMessage : { expiresAt: event.expiresAt as string | undefined, expiresMonotonicMs: event.expiresMonotonicMs as number | undefined };
      return event.type !== 'radio' && mailExpired(expiry)
        ? { cursor: event.cursor, type: 'message_expired', mission: this.droneMissions[role], id: event.type === 'radio' ? (event.message as RadioMessage).id : event.id }
        : event;
    });
    const { sensors, image } = sample;
    if (this.launchGate?.delivered(role, inbox.events.some(event => event.type === 'player' && event.mission === this.droneMissions[role] && Number(event.mission) > 0))) {
      for (const member of this.state.drones) this.inboxes[member.id].push({ type: 'launch_ready', mission: this.droneMissions[member.id] });
    }
    this.deliveredObservationSequences.set(role, [...(this.deliveredObservationSequences.get(role) ?? []), sensors.sequence].slice(-64));
    this.storageStatus(role);
    const original = result.content.find(c => c.type === 'text');
    const value = original?.type === 'text' ? JSON.parse(original.text) : {};
    const feedback = { ...value, protocol: 'fleet-observation/2', sessionId, mission: this.droneMissions[role],
      stopped: false, ...inbox, launchReady: this.launchGate?.ready ?? true, currentAction: activityOf(drone),
      sensors,
      currentTelemetry: this.ownTelemetry(role), job: this.jobs.status(role),
      routine: this.routines.get(role)?.status() ?? null,
      ...(this.workspaces.has(role) ? { storage: this.storageStatus(role) } : {}),
      cargo: { amount: drone.cargo?.amount ?? 0, capacity: cargoCapacityFor(drone) },
      logistics: drone.logistics ? { state: drone.logistics.state, progress: drone.logistics.progress,
        remaining: drone.logistics.remaining, duration: drone.logistics.duration, reason: drone.logistics.reason } : null,
      ...(hasBatteries(this.state.match?.rulesVersion) ? { battery: { charge: drone.battery ?? RTS_CONFIG.batteryCapacity, capacity: batteryCapacityFor(drone),
        low: (drone.battery ?? RTS_CONFIG.batteryCapacity) <= batteryCapacityFor(drone) * RTS_CONFIG.lowBatteryFraction }, charging: Boolean(drone.charging) } : {}),
      jamming: Boolean(drone.jamming), radioJammed: Boolean(drone.radioJammed),
      mining: Boolean(drone.mining),
      service: drone.servicing ? { kind: drone.servicing.kind ?? 'rearm', remaining: drone.servicing.remaining } : null,
      ...(this.toolCapabilities(role).shop ? { equipment: drone.equipment, ammo: drone.ammo ?? 0, cameraMode: drone.cameraMode ?? 'wide',
        account: { credits: this.state.match!.teams[teamForDrone(role)].credits } } : {}),
      availableTools: createDroneTools(teamRoster(teamForDrone(role)), this.toolCapabilities(role), teamForDrone(role)).map(tool => tool.name) };
    // Age describes the assembled server bundle, including storage/telemetry
    // work after camera encoding. Native delivery can add separately measured latency.
    const deliveredAtMs = performance.now(), deliveredAt = new Date().toISOString();
    sensors.ageMs = Math.max(0, deliveredAtMs - sensors.timestamp.acquiredAtMs);
    sensors.validity = this.connected ? 'valid' : 'stalled';
    sensors.ranges.ageMs = Math.max(0, deliveredAtMs - sensors.ranges.acquiredAtMs);
    sensors.ranges.fresh = this.connected && rangeSampleFresh(sensors.ranges, deliveredAtMs);
    sensors.camera.ageMs = Math.max(0, deliveredAtMs - sensors.camera.acquiredAtMs);
    sensors.camera.fresh = this.connected && sensors.camera.available && sensors.camera.ageMs <= 2000;
    const currentTelemetry = { ...feedback.currentTelemetry,
      ageMs: Math.max(0, deliveredAtMs - feedback.currentTelemetry.acquiredAtMs),
      ranges: { ...feedback.currentTelemetry.ranges,
        ageMs: Math.max(0, deliveredAtMs - feedback.currentTelemetry.ranges.acquiredAtMs),
        fresh: this.connected && rangeSampleFresh(feedback.currentTelemetry.ranges, deliveredAtMs) } };
    const bundle = textResult({ ...feedback, currentTelemetry, deliveredAt, deliveredAtMs, deliverySimTime: this.state.simTime });
    if (image) bundle.content.push(image);
    if (result.isError) bundle.isError = true;
    this.emit('observation', { drone: role, sensors, mission: this.droneMissions[role], deliveredCursor: inbox.cursor, eventCount: inbox.events.length });
    // Acquisition evidence goes only to the player recorder, never into the tool bundle.
    // Emit the final delivered sample, excluding obsolete recaptures and retired actors.
    if (this.listenerCount('recorded-observation')) this.emit('recorded-observation', {
      drone: role, pose: sample.pose, simTime: sample.simTime, capturedAt: sensors.timestamp.capturedAt,
      mission: sample.mission, cameraFov: sample.cameraFov, ...(image?.type === 'image' ? { image: { mimeType: image.mimeType, data: image.data } } : {}),
    } satisfies RecordedObservation);
    return bundle;
  }

  private ownTelemetry(role: DroneId) {
    const drone = this.drone(role), acquiredAtMs = performance.now();
    const ranges = this.localSensors.acquire(drone, this.state.obstacles, this.state.drones, this.state.simTime, acquiredAtMs);
    return { sequence: ranges.sequence, frame: 'local-east-up-south', units: 'simulation-units', metersPerUnit: 10,
      acquiredAt: ranges.acquiredAt, acquiredAtMs, simTime: this.state.simTime, validity: this.connected ? 'valid' : 'stalled',
      position: positionOf(drone), velocity: this.motion.velocity(drone), heading: (360 - drone.yaw) % 360, cameraPitch: drone.pitch,
      ranges, ...(hasBatteries(this.state.match?.rulesVersion) ? { battery: { charge: drone.battery ?? 0, capacity: batteryCapacityFor(drone) }, charging: Boolean(drone.charging) } : {}),
      cargo: { amount: drone.cargo?.amount ?? 0, capacity: cargoCapacityFor(drone) },
      logistics: drone.logistics ? { state: drone.logistics.state, progress: drone.logistics.progress, remaining: drone.logistics.remaining,
        duration: drone.logistics.duration, reason: drone.logistics.reason } : null,
      service: drone.servicing ? { kind: drone.servicing.kind ?? 'rearm', remaining: drone.servicing.remaining } : null,
      equipment: structuredClone(drone.equipment), ammo: drone.ammo ?? 0,
      account: { credits: this.state.match!.teams[teamForDrone(role)].credits }, job: this.jobs.status(role) };
  }
  private storageStatus(id: DroneId) {
    const status = this.onboardWorkspace(id).status();
    this.drone(id).storage = { runtime: status.runtime, workspace: status.workspace, radio: status.radio, staging: status.staging, logs: status.logs };
    return status;
  }

  private async dispatch(role: Role, name: string, args: Record<string, unknown>, routineContext?: RoutineCallContext): Promise<ToolResult> {
    try {
      if (role === 'parent') {
        if (name !== 'forward_next_instruction') throw new Error('The relay parent has no drone tools');
        return await this.forwardTeam('blue');
      }
      if (!DRONE_IDS.includes(role)) throw new Error('Unknown drone identity');
      if (!this.state.running) return textResult({ stopped: true, instruction: 'End your drone task; this session has stopped.' });
      const drone = this.state.drones.find(d => d.id === role)!;
      if (drone.alive === false) return textResult({ stopped: true, destroyed: true, instruction: 'Your drone has been destroyed. End this task.' });
      if (routineContext) this.validateRoutine(role, routineContext);
      if (!drone.online) {
        drone.online = true; drone.status = 'Ready';
        for (const wake of [...this.playerWake]) wake();
      }
      this.emit('tool', { drone: role, name, args });
      if (name === 'observe') {
        return textResult({ observed: true });
      }
      if (name === 'wait') {
        const duration = typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms) ? args.timeout_ms : 30_000;
        await this.inboxes[role].waitForMail(Math.max(1000, Math.min(duration, 30_000)));
        return textResult({ stopped: !this.state.running });
      }
      if (!createDroneTools(teamRoster(teamForDrone(role)), this.toolCapabilities(role), teamForDrone(role)).some(tool => tool.name === name)) throw new Error('Tool is not available to this drone');
      if (args.mission !== this.droneMissions[role] || !this.droneMissions[role]) throw new Error(`Stale or missing mission; your current mission is ${this.droneMissions[role]}. Read your inbox before acting.`);
      if (this.launchGate && !this.launchGate.ready && ['act', 'route', 'buy', 'fire', 'rearm', 'routine'].includes(name)) {
        return textResult({ launchPending: true, instruction: 'Launch is waiting for all six opening-objective bundles. Use wait; movement and purchases are not admitted yet.' });
      }
      const origin = routineContext?.origin as ObservationOrigin | undefined ?? this.origin(role, args);
      if (name === 'workspace') {
        const workspace = this.onboardWorkspace(role);
        let result: unknown;
        if (args.op === 'list') result = workspace.list();
        else if (args.op === 'stat') result = args.path === undefined ? workspace.status() : workspace.stat(args.path as string);
        else if (args.op === 'read') result = { path: args.path, content: workspace.read(args.path as string) };
        else if (args.op === 'write') result = workspace.write(args.path as string, args.content as string);
        else if (args.op === 'delete') result = workspace.delete(args.path as string);
        else throw new ControllerRejection('Unknown workspace operation');
        return textResult({ workspace: result, storage: workspace.status() });
      }
      if (name === 'routine') {
        const runner = this.routineRunner(role);
        if (args.op === 'status') {
          const status = runner.status();
          if (args.job_id !== undefined && status?.id !== args.job_id) throw new ControllerRejection('Routine job is no longer retained');
          return textResult({ routine: status });
        }
        if (args.op === 'cancel') return textResult({ routine: runner.cancel('requested', args.job_id as string | undefined) });
        if (args.op !== 'start') throw new ControllerRejection('Unknown routine operation');
        if (this.jobs.active(role) && args.replace !== true) throw new ControllerRejection('Movement writer is occupied; explicitly replace or cancel it');
        // Preflight every synchronous refusal before taking over the movement writer.
        runner.preflight({ path: args.path as string, mission: args.mission as number,
          input: args.input as object | undefined, replace: args.replace === true, origin });
        if (args.replace === true) this.jobs.cancel(role, 'routine-replaced');
        return textResult({ accepted: true, routine: runner.start({ path: args.path as string, mission: args.mission as number,
          input: args.input as object | undefined, replace: args.replace === true, origin }) });
      }
      if (name === 'exchange') {
        if (!Array.isArray(args.operations) || !args.operations.length || args.operations.length > ONBOARD_PROFILE.maxBatchOperations) throw new ControllerRejection('Exchange requires 1–8 operations');
        const allowed = ['act', 'route', 'send', 'camera', 'buy', 'fire', 'rearm'];
        const admittedTools = new Set(createDroneTools(teamRoster(teamForDrone(role)), this.toolCapabilities(role), teamForDrone(role)).map(tool => tool.name));
        const ids = new Set<string>(); let writers = 0;
        // Validate structure/conflicting writers before any admission. Later failures do not roll back earlier effects.
        for (const operation of args.operations) {
          if (!operation || typeof operation.id !== 'string' || !operation.id || operation.id.length > 64 || ids.has(operation.id)
            || !allowed.includes(operation.tool) || !operation.args || typeof operation.args !== 'object' || Array.isArray(operation.args)) throw new ControllerRejection('Each operation requires a unique short id, permitted tool and args object');
          ids.add(operation.id);
          if ((operation.tool === 'act' && operation.args.kind !== 'look') || (operation.tool === 'route' && operation.args.op !== 'status')) writers++;
        }
        if (writers > 1) throw new ControllerRejection('Exchange permits one movement writer');
        const outcomes = [];
        for (const operation of args.operations) {
          try {
            this.validateMission(role, args.mission as number);
            if (!admittedTools.has(operation.tool)) throw new ControllerRejection('Operation capability was unavailable at batch admission');
          } catch (error) {
            outcomes.push({ id: operation.id, tool: operation.tool, result: { accepted: false, rejected: true,
              reason: error instanceof Error ? error.message : String(error) }, isError: false });
            continue;
          }
          const response = await this.dispatch(role, operation.tool, { ...operation.args, mission: args.mission,
            observation_sequence: args.observation_sequence, event_cursor: args.event_cursor });
          const block = response.content.find(item => item.type === 'text');
          outcomes.push({ id: operation.id, tool: operation.tool, result: block?.type === 'text' ? JSON.parse(block.text) : {}, isError: Boolean(response.isError) });
        }
        return textResult({ outcomes, atomic: false, commandMission: args.mission });
      }
      if (name === 'route') {
        if (args.op === 'status') return textResult({ job: this.jobs.status(role, args.job_id as string | undefined) });
        if (args.op === 'cancel') {
          this.jobs.status(role, args.job_id as string | undefined);
          return textResult({ job: this.jobs.cancel(role, 'requested') });
        }
        if (args.op !== 'start') throw new ControllerRejection('Unknown route operation');
        this.jobs.validateWaypoints(args.waypoints, args.profile as MovementProfile | undefined);
        if (this.activeRoutine(role)) {
          if (args.replace !== true) throw new ControllerRejection('Routine owns movement; explicitly replace it');
          this.routines.get(role)!.cancel('route-replaced');
        }
        const job = this.jobs.start(role, args.mission as number, args.waypoints, { replace: args.replace === true,
          profile: args.profile as MovementProfile | undefined, origin });
        return textResult({ accepted: true, job, commandMission: args.mission });
      }
      if (name === 'transfer') {
        if (!this.radioTransport?.transfer) throw new ControllerRejection('Native transfer interface is unavailable');
        return textResult({ transfer: await this.radioTransport.transfer(role, args), commandMission: args.mission });
      }
      if (name === 'send') {
        const to = args.to as string, kind = args.kind as string, text = args.text;
        if (to !== 'all' && !(to === 'player' && teamForDrone(role) === 'blue') && !teamRoster(teamForDrone(role)).some(peer => peer.id === to)) throw new Error('Unknown radio recipient');
        if (!['chat', 'found', 'claim', 'done', 'status'].includes(kind)) throw new Error('Unknown radio message kind');
        if (typeof text !== 'string' || !text.trim() || text.length > 1600) throw new Error('Radio message must be 1–1600 characters');
        const data = args.data as Record<string, unknown> | undefined;
        if (data && (typeof data !== 'object' || Array.isArray(data) || JSON.stringify(data).length > 3000)) throw new Error('Radio data must be a small JSON object');
        if (!this.radioTransport && (drone.radioJammed || this.state.drones.some(peer => peer.alive !== false && peer.id !== role
          && teamForDrone(peer.id) === teamForDrone(role) && (to === 'all' || to === peer.id) && peer.radioJammed))) {
          throw new ControllerRejection('Radio delivery is unavailable during interference');
        }
        const message = this.log(role, to, kind, text, data, this.droneMissions[role]);
        if (this.radioTransport) {
          const beforeSend = () => {
            if (message.sessionId !== this.sessionId) throw new ControllerRejection('Drone session has ended; radio cancelled');
            this.validateMission(role, message.mission);
            if (routineContext) this.validateRoutine(role, routineContext);
          };
          try { await this.radioTransport.send(message, { beforeSend }); }
          catch (error) {
            message.delivery ??= { queuedAt: message.sentAt, storedBy: [], bundledBy: [] };
            message.delivery.error = error instanceof Error ? error.message : String(error);
            if (message.sessionId === this.sessionId) { this.emit('radio-delivery', structuredClone(message)); this.emit('change'); }
            throw error;
          }
          return textResult({ queued: message.id, delivery: 'Awaiting peer receipt', commandMission: args.mission });
        }
        // In-memory seam is for isolated unit tests. The application always installs Zenoh.
        for (const { id } of teamRoster(teamForDrone(role))) if (id !== role && (to === 'all' || id === to)) this.receiveRadio(id, message);
        return textResult({ sent: message.id, commandMission: args.mission });
      }
      if (name === 'camera') {
        if (args.mode !== 'wide' && args.mode !== 'zoom') throw new ControllerRejection('Unknown camera mode');
        drone.cameraMode = args.mode;
        this.emit('change');
        return textResult({ accepted: true, cameraMode: drone.cameraMode, commandMission: args.mission });
      }
      if (name === 'mine' || name === 'buy' || name === 'fire' || name === 'rearm' || name === 'recharge' || name === 'jam') {
        try {
          if (name === 'jam' && typeof args.enabled !== 'boolean') throw new Error('enabled must be a boolean');
          const result = name === 'mine' ? this.rules.mine(this.state, drone)
            : name === 'buy' ? this.rules.buy(this.state, drone, args.item as EquipmentItem, args.replace as EquipmentModule | undefined)
            : name === 'rearm' ? this.rules.rearm(this.state, drone)
            : name === 'recharge' ? this.rules.recharge(this.state, drone)
            : name === 'jam' ? this.rules.jam(this.state, drone, args.enabled as boolean) : this.rules.fire(this.state, drone);
          if (name === 'rearm') { this.jobs.cancel(role, 'rearming'); this.motionVersions.set(role, (this.motionVersions.get(role) ?? 0) + 1); this.motion.clear(drone); drone.action = undefined; }
          this.emit('capabilities-changed'); this.emit('change');
          return textResult({ ...result, commandMission: args.mission });
        } catch (error) { throw new ControllerRejection(error instanceof Error ? error.message : String(error)); }
      }
      if (name === 'act' && args.kind === 'fly_to') {
        this.jobs.validateWaypoints([{ x: args.x, y: args.y, z: args.z }], args.profile as MovementProfile | undefined);
        const routine = this.activeRoutine(role);
        if (routine && !routineContext) {
          if (args.replace !== true) throw new ControllerRejection('Routine owns movement; explicitly replace it');
          this.routines.get(role)!.cancel('movement-replaced');
        }
        const job = this.jobs.start(role, args.mission as number, [{ x: args.x, y: args.y, z: args.z }], {
          replace: args.replace === true, kind: 'movement', profile: args.profile as MovementProfile | undefined, origin,
          owner: routineContext?.jobId });
        return textResult({ accepted: true, job, actionId: job.id, commandMission: args.mission });
      }
      if (name === 'act' && args.kind === 'hover') {
        if (!routineContext) this.routines.get(role)?.cancel('hover-requested');
        this.jobs.cancel(role, 'hover-requested');
        this.motionVersions.set(role, (this.motionVersions.get(role) ?? 0) + 1);
      }
      const motionVersion = this.motionVersions.get(role) ?? 0;
      const decoded = this.vehicleTransport ? await this.vehicleTransport.command(role, args, poseOf(drone), this.state.simTime) : args;
      if (!this.state.running) return textResult({ stopped: true });
      if (!this.toolCapabilities(role).alive) return textResult({ stopped: true, destroyed: true });
      if (routineContext) this.validateRoutine(role, routineContext);
      if (args.kind === 'hover' && motionVersion !== (this.motionVersions.get(role) ?? 0)) throw new ControllerRejection('Hold superseded by a newer movement command');
      if (args.mission !== this.droneMissions[role]) throw new Error('Mission changed while the command was in transit; command rejected');
      return this.act(drone, { ...decoded, mission: args.mission });
    } catch (error) {
      if (error instanceof OnboardStorageError) return textResult({ accepted: false, rejected: true, reason: error.message,
        storageError: { code: error.code, partition: error.partition }, commandMission: args.mission });
      if (error instanceof ControllerRejection) return textResult({ accepted: false, rejected: true, reason: error.message, commandMission: args.mission });
      return { ...textResult({ error: error instanceof Error ? error.message : String(error) }), isError: true };
    }
  }

  private act(drone: Drone, args: Record<string, unknown>) {
    const kind = args.kind;
    if (kind === 'hover') {
      this.rules.cancelService(this.state, drone);
      this.motion.hover(drone);
      drone.action = undefined; drone.status = 'Hovering';
      return textResult({ hovering: true, commandMission: args.mission });
    }
    if (kind === 'look') {
      const yaw = args.heading === undefined ? undefined : -finite(args.heading, 'heading');
      const pitch = args.pitch === undefined ? undefined : finite(args.pitch, 'pitch');
      if (pitch !== undefined && (pitch < CAMERA_PITCH_LIMITS.min || pitch > CAMERA_PITCH_LIMITS.max)) throw new ControllerRejection('Camera command rejected by actuator limit');
      this.motion.look(drone, yaw, pitch);
      return textResult({ accepted: true, commandMission: args.mission });
    }
    if (kind !== 'fly_to') throw new Error('Unknown action kind');
    const target = { x: finite(args.x, 'x'), y: finite(args.y, 'y'), z: finite(args.z, 'z') };
    for (const axis of ['x', 'y', 'z'] as const) if (target[axis] < BOUNDS[axis][0] || target[axis] > BOUNDS[axis][1]) throw new ControllerRejection('Waypoint rejected by flight controller');
    this.rules.cancelService(this.state, drone);
    this.rules.cancelLogistics(this.state, drone, 'movement-replaced');
    drone.action = { id: `action-${++this.serial}`, kind, target, profile: args.profile as MovementProfile | undefined, owner: args.owner as string | undefined }; drone.status = 'Flying';
    this.motion.faceWaypoint(drone, target);
    return textResult({ actionId: drone.action.id, accepted: true, target, commandMission: args.mission });
  }

  tick(dt: number) {
    if (this.launchGate && !this.launchGate.ready) return;
    if (!this.state.running || !this.connected) return;
    if (!Number.isFinite(dt)) return;
    dt = Math.min(Math.max(dt, 0), 0.25) * this.state.speed;
    // Fixed maximum integration step keeps acceleration and swept collisions
    // consistent through slow browser frames and the simulation-speed slider.
    const steps = Math.ceil(dt * 120);
    for (let i = 0; i < steps && this.state.running; i++) this.step(dt / steps);
    for (const id of this.workspaces.keys()) if (this.drone(id).alive !== false) this.storageStatus(id);
  }

  private step(dt: number) {
    this.state.simTime += dt;
    const previous = new Map(this.state.drones.map(drone => [drone.id, { x: drone.x, y: drone.y, z: drone.z }]));
    const alive = new Set(this.state.drones.filter(drone => drone.alive !== false).map(drone => drone.id));
    const mining = new Set(this.state.drones.filter(drone => drone.mining).map(drone => drone.id));
    const charging = new Set(this.state.drones.filter(drone => drone.charging).map(drone => drone.id));
    const unlocked = { blue: this.state.match!.teams.blue.shopUnlocked, red: this.state.match!.teams.red.shopUnlocked };
    for (const drone of this.state.drones) {
      if (drone.alive === false) continue;
      this.jobs.tick(drone.id);
      const ranges = this.localSensors.acquire(drone, this.state.obstacles, this.state.drones, this.state.simTime);
      const { next, arrived, blocked } = this.motion.step(drone, dt, { ranges, profile: drone.action?.profile, loaded: (drone.cargo?.amount ?? 0) > 0 });
      drone.velocity = this.motion.velocity(drone);
      if (blocked) {
        this.jobs.cancel(drone.id, blocked, 'blocked');
        drone.action = undefined; drone.status = `Blocked: ${blocked}`;
      }
      const collision = this.rules.terrainCollision(this.state, drone, previous.get(drone.id)!, next);
      Object.assign(drone, collision.position);
      if (collision.collided) {
        this.motion.clear(drone);
      } else if (arrived && drone.action) {
        this.inboxes[drone.id].push({ type: 'arrived', mission: this.droneMissions[drone.id], actionId: drone.action.id, simTime: this.state.simTime, occurredAt: new Date().toISOString() });
        drone.action = undefined; drone.status = 'Hovering';
        this.jobs.arrived(drone.id);
      }
    }
    for (const id of this.rules.step(this.state, dt, previous)) this.motion.clear(this.state.drones.find(drone => drone.id === id)!);
    for (const drone of this.state.drones) {
      if (alive.has(drone.id) && drone.alive === false) {
        this.jobs.cancel(drone.id, 'destroyed');
        this.routines.get(drone.id)?.cancel('destroyed'); this.workspaces.get(drone.id)?.revoke();
        this.motion.clear(drone); this.deferredRadio.delete(drone.id);
        drone.online = false;
        this.inboxes[drone.id].push({ type: 'destroyed', mission: this.droneMissions[drone.id], simTime: this.state.simTime });
        this.emit('drone-destroyed', { droneId: drone.id });
      }
      if (drone.alive !== false) for (const [kind, before, now] of [
        ['mining', mining.has(drone.id), Boolean(drone.mining)], ['charging', charging.has(drone.id), Boolean(drone.charging)],
      ] as const) {
        if (before !== now) this.inboxes[drone.id].push({ type: `${kind}_${now ? 'started' : 'stopped'}`, mission: this.droneMissions[drone.id], simTime: this.state.simTime });
      }
    }
    for (const team of ['blue', 'red'] as const) {
      if (!unlocked[team] && this.state.match!.teams[team].shopUnlocked) {
        this.emit('capabilities-changed');
        for (const drone of this.state.drones.filter(drone => drone.alive !== false && teamForDrone(drone.id) === team)) {
          this.inboxes[drone.id].push({ type: 'equipment_available', mission: this.droneMissions[drone.id] });
        }
      }
    }
    if (this.state.match!.phase === 'finished') {
      this.state.completed = true;
      this.stop(); this.emit('match-ended', { winner: this.state.match!.winner });
    }
  }
}
