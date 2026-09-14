import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { type Drone, type DroneId, type GameState, type Pose, type Role, type ToolResult, type RadioMessage } from '../shared/types.ts';
import { MATCH_DRONE_IDS as DRONE_IDS, teamForDrone, teamRoster, type TeamId } from '../shared/fleet.ts';
import { BATTLEFIELD } from '../shared/battlefield.ts';
import type { MatchState } from '../shared/rts.ts';
import { CITY } from '../shared/city.ts';
import { DRONE_CAMERA } from '../shared/camera-profile.ts';
import { Mailbox } from './mailbox.ts';
import { CAMERA_PITCH_LIMITS, DroneMotion } from './drone-motion.ts';
import { RtsRules } from './rts.ts';
import type { RecordedObservation } from '../shared/replay.ts';
import { ResourceVision } from './resource-vision.ts';
import { MODEL, EFFORT, RTS_MISSION } from './runtime-tools.ts';

const BOUNDS = CITY.bounds;
const textResult = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const finite = (value: unknown, label: string) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
};
const poseOf = ({ x, y, z, yaw, pitch }: Pose): Pose => ({ x, y, z, yaw, pitch });
const positionOf = ({ x, y, z }: Pose) => ({ x, y, z });
const activityOf = (drone: Drone) => drone.action ? { id: drone.action.id, kind: drone.action.kind }
  : drone.mining ? { id: 'mining', kind: 'mine' } : null;
class ControllerRejection extends Error {}
interface VehicleTransport {
  command(id: DroneId, args: Record<string, unknown>, pose: Pose, simTime: number): Promise<Record<string, unknown>>;
  sample(id: DroneId, pose: Pose, simTime: number): Promise<{ position: { x: number; y: number; z: number }; heading: { degrees: number }; simTime: number }>;
}
interface RadioTransport { send(message: RadioMessage): Promise<unknown>; sendTeam?(team: TeamId, message: RadioMessage): Promise<unknown>; consume(id: DroneId, ids: string[]): void }

export class FleetGame extends EventEmitter {
  state: GameState;
  inboxes: Record<DroneId, Mailbox>;
  private playerQueue: Array<{ id: string; text: string; team: TeamId; bootstrap?: boolean }> = [];
  private playerWake = new Set<() => void>();
  private serial = 0;
  private rules = new RtsRules(event => this.emit('match-event', event));
  private vision = new ResourceVision();
  private teamMissions: Record<TeamId, number> = { blue: 0, red: 0 };
  private connected = false;
  private toolErrors = new Map<Role, number>();
  private sessionId = randomUUID();
  private toolTurns = new Map<DroneId, Promise<unknown>>();
  private receivedRadio = new Set<string>();
  private droneMissions = Object.fromEntries(DRONE_IDS.map(id => [id, 0])) as Record<DroneId, number>;
  private deferredRadio = new Map<DroneId, RadioMessage[]>();
  private motion = new DroneMotion();
  radioTransport?: RadioTransport;
  vehicleTransport?: VehicleTransport;
  get sessionIdentity() { return this.sessionId; }
  capture: (id: DroneId, pose: Pose, simTime: number, drones: Drone[], match?: MatchState) => Promise<string> = async () => { throw new Error('Camera browser is disconnected'); };

  constructor() {
    super();
    this.inboxes = this.newInboxes();
    this.state = this.newState();
  }

  private newInboxes() { return Object.fromEntries(DRONE_IDS.map(id => [id, new Mailbox()])) as Record<DroneId, Mailbox>; }
  private newState(): GameState {
    return {
      simTime: 0, mission: 0, running: false, speed: 1,
      completed: false, treasures: [], match: this.rules.newMatch(BATTLEFIELD.resources),
      obstacles: CITY.buildings.map(building => ({ ...building })),
      drones: DRONE_IDS.map(id => ({ id, ...BATTLEFIELD.spawns[id], team: teamForDrone(id), alive: true,
        equipment: { gun: false, armor: false, miner: false }, status: 'Standby', online: false, observations: 0 })),
      radio: [], runtime: { status: 'idle', message: `Ready to launch ${DRONE_IDS.length} native drone agents`, model: MODEL, effort: EFFORT },
    };
  }

  reset() {
    if (this.state.running) throw new Error('Stop the fleet before resetting');
    this.stop(); this.state = this.newState(); this.inboxes = this.newInboxes(); this.vision.clear();
    this.playerQueue = []; this.emit('change');
  }
  start() {
    if (!this.connected) throw new Error('Open the game browser before launching the fleet');
    this.inboxes = this.newInboxes();
    this.toolErrors.clear();
    this.sessionId = randomUUID();
    this.receivedRadio.clear();
    for (const id of DRONE_IDS) this.droneMissions[id] = 0;
    this.deferredRadio.clear();
    this.motion.clear();
    this.vision.clear(); this.teamMissions = { blue: 0, red: 0 };
    this.state.mission = 0; this.state.simTime = 0; this.state.radio = [];
    this.state.running = true;
    for (const drone of this.state.drones) Object.assign(drone, BATTLEFIELD.spawns[drone.id]);
    this.rules.begin(this.state);
    this.playerQueue = (['blue', 'red'] as const).map(team => ({ id: `player-${++this.serial}`, text: RTS_MISSION, team, bootstrap: true }));
    for (const drone of this.state.drones) { drone.action = undefined; drone.online = false; drone.status = 'Connecting'; }
    this.emit('change');
  }
  stop() {
    this.state.running = false;
    this.playerQueue = [];
    this.motion.clear();
    for (const drone of this.state.drones) {
      drone.action = undefined; drone.online = false; this.rules.cancelMining(drone);
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

  receiveRadio(recipient: DroneId, message: RadioMessage) {
    if (!DRONE_IDS.includes(recipient)) return;
    const member = this.state.drones.find(drone => drone.id === recipient);
    if (member?.alive === false || (message.from !== 'player' && !teamRoster(teamForDrone(recipient)).some(peer => peer.id === message.from))) {
      this.radioTransport?.consume(recipient, [message.id]); return;
    }
    const key = `${recipient}:${message.id}`;
    if (!this.state.running || message.sessionId !== this.sessionId) {
      this.radioTransport?.consume(recipient, [message.id]); return;
    }
    if (this.receivedRadio.has(key)) return;
    this.receivedRadio.add(key);
    if (message.expiresAt && Date.parse(message.expiresAt) <= Date.now()) {
      this.inboxes[recipient].push({ type: 'message_expired', mission: this.droneMissions[recipient], id: message.id });
      this.radioTransport?.consume(recipient, [message.id]); return;
    }
    if (message.from === 'player' && message.kind === 'mission') {
      if (message.mission <= this.droneMissions[recipient]) { this.radioTransport?.consume(recipient, [message.id]); return; }
      this.droneMissions[recipient] = message.mission;
      const drone = this.state.drones.find(d => d.id === recipient)!;
      this.motion.clear(drone);
      this.rules.cancelMining(drone); this.vision.forget(recipient);
      drone.action = undefined; drone.status = 'New instruction';
      this.inboxes[recipient].push({ type: 'player', mission: message.mission, text: message.text, id: message.id, simTime: message.simTime, occurredAt: message.sentAt, expiresAt: message.expiresAt });
      const pending = this.deferredRadio.get(recipient) ?? [];
      this.deferredRadio.delete(recipient);
      for (const item of pending) { this.receivedRadio.delete(`${recipient}:${item.id}`); this.receiveRadio(recipient, item); }
      return;
    }
    if (message.mission > this.droneMissions[recipient]) {
      const pending = this.deferredRadio.get(recipient) ?? []; pending.push(message); this.deferredRadio.set(recipient, pending); return;
    }
    if (message.mission < this.droneMissions[recipient]) { this.radioTransport?.consume(recipient, [message.id]); return; }
    this.inboxes[recipient].push({ type: 'radio', mission: message.mission, message });
  }

  private log(from: string, to: string, kind: string, text: string, data?: Record<string, unknown>, mission = this.state.mission) {
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
    const ready = () => this.playerQueue.some(item => item.team === team) && members().every(d => d.online);
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
      shop: Boolean(drone && this.state.match?.teams[teamForDrone(drone.id)].shopUnlocked), gun: Boolean(drone?.equipment?.gun) };
  }

  async tool(role: Role, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    if (role === 'parent' || !DRONE_IDS.includes(role)) return this.completeTool(role, name, args);
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
    const drone = this.state.drones.find(d => d.id === role)!, mission = this.droneMissions[role];
    const pose = poseOf(drone), simTime = this.state.simTime, capturedAt = new Date().toISOString();
    const currentAction = activityOf(drone);
    const peers = structuredClone(this.state.drones), matchState = structuredClone(this.state.match);
    const telemetry = this.vehicleTransport ? await this.vehicleTransport.sample(role, pose, simTime) : undefined;
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
    const sensors = { position: { frame: 'local', ...(telemetry?.position ?? positionOf(pose)) }, heading: telemetry?.heading ?? { degrees: (360 - pose.yaw) % 360 },
      timestamp: { capturedAt, simTime: telemetry?.simTime ?? simTime }, camera };
    return { sensors, image, currentAction, mission, pose, simTime, matchState };
  }

  private async withObservation(role: DroneId, result: ToolResult, after: unknown): Promise<ToolResult> {
    const sessionId = this.sessionId;
    let sample = await this.snapshot(role);
    const active = () => this.state.running && sessionId === this.sessionId && this.state.drones.find(d => d.id === role)?.alive !== false;
    const drone = this.state.drones.find(d => d.id === role)!;
    // A short flight can finish while the browser encodes its frame. Refresh once
    // rather than pairing an arrival event with a pre-arrival picture by default.
    if (active() && (sample.currentAction?.id !== activityOf(drone)?.id || sample.mission !== this.droneMissions[role])) sample = await this.snapshot(role);
    if (!active()) return textResult({ stopped: true, instruction: 'This drone session has ended.' });
    const deferred = this.deferredRadio.get(role) ?? [];
    const expired = deferred.filter(message => message.expiresAt && Date.parse(message.expiresAt) <= Date.now());
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
    inbox.events = inbox.events.map(event => {
      const expiresAt = event.type === 'radio' ? (event.message as RadioMessage | undefined)?.expiresAt : event.expiresAt;
      return typeof expiresAt === 'string' && Date.parse(expiresAt) <= Date.now()
        ? { cursor: event.cursor, type: 'message_expired', mission: this.droneMissions[role], id: event.type === 'radio' ? (event.message as RadioMessage).id : event.id }
        : event;
    });
    const { sensors, image } = sample;
    this.vision.record(role, sample.pose, sample.mission, sample.simTime, Boolean(image), sample.matchState?.resources ?? [], this.state.obstacles);
    const original = result.content.find(c => c.type === 'text');
    const value = original?.type === 'text' ? JSON.parse(original.text) : {};
    const bundle = textResult({ ...value, protocol: 'fleet-observation/1', sessionId, mission: this.droneMissions[role],
      stopped: false, ...inbox, currentAction: activityOf(drone),
      deliveredAt: new Date().toISOString(), deliverySimTime: this.state.simTime, sensors,
      ...(this.toolCapabilities(role).shop ? { equipment: drone.equipment, account: { credits: this.state.match!.teams[teamForDrone(role)].credits }, availableTools: ['observe', 'act', 'send', 'wait', 'mine', 'buy', ...(drone.equipment?.gun ? ['fire'] : [])] } : {}) });
    if (image) bundle.content.push(image);
    if (result.isError) bundle.isError = true;
    this.emit('observation', { drone: role, sensors, mission: this.droneMissions[role], deliveredCursor: inbox.cursor, eventCount: inbox.events.length });
    // Acquisition evidence goes only to the player recorder, never into the tool bundle.
    // Emit the final delivered sample, excluding obsolete recaptures and retired actors.
    if (this.listenerCount('recorded-observation')) this.emit('recorded-observation', {
      drone: role, pose: sample.pose, simTime: sample.simTime, capturedAt: sensors.timestamp.capturedAt,
      mission: sample.mission, ...(image?.type === 'image' ? { image: { mimeType: image.mimeType, data: image.data } } : {}),
    } satisfies RecordedObservation);
    return bundle;
  }

  private async dispatch(role: Role, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      if (role === 'parent') {
        if (name !== 'forward_next_instruction') throw new Error('The relay parent has no drone tools');
        return await this.forwardTeam('blue');
      }
      if (!DRONE_IDS.includes(role)) throw new Error('Unknown drone identity');
      if (!this.state.running) return textResult({ stopped: true, instruction: 'End your drone task; this session has stopped.' });
      const drone = this.state.drones.find(d => d.id === role)!;
      if (drone.alive === false) return textResult({ stopped: true, destroyed: true, instruction: 'Your drone has been destroyed. End this task.' });
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
      if (!['send', 'act', 'mine', 'buy', 'fire'].includes(name)) throw new Error('Tool is not available to this drone');
      if (args.mission !== this.droneMissions[role] || !this.droneMissions[role]) throw new Error(`Stale or missing mission; your current mission is ${this.droneMissions[role]}. Read your inbox before acting.`);
      if (name === 'send') {
        const to = args.to as string, kind = args.kind as string, text = args.text;
        if (to !== 'all' && !teamRoster(teamForDrone(role)).some(peer => peer.id === to)) throw new Error('Unknown radio recipient');
        if (!['chat', 'found', 'claim', 'done'].includes(kind)) throw new Error('Unknown radio message kind');
        if (typeof text !== 'string' || !text.trim() || text.length > 1600) throw new Error('Radio message must be 1–1600 characters');
        const data = args.data as Record<string, unknown> | undefined;
        if (data && (typeof data !== 'object' || Array.isArray(data) || JSON.stringify(data).length > 3000)) throw new Error('Radio data must be a small JSON object');
        const message = this.log(role, to, kind, text, data, this.droneMissions[role]);
        if (this.radioTransport) {
          await this.radioTransport.send(message);
          return textResult({ queued: message.id, delivery: 'Awaiting peer receipt', commandMission: args.mission });
        }
        // In-memory seam is for isolated unit tests. The application always installs Zenoh.
        for (const { id } of teamRoster(teamForDrone(role))) if (id !== role && (to === 'all' || id === to)) this.receiveRadio(id, message);
        return textResult({ sent: message.id, commandMission: args.mission });
      }
      if (name === 'mine' || name === 'buy' || name === 'fire') {
        try {
          const result = name === 'mine' ? this.rules.mine(this.state, drone, this.vision.select(role, this.droneMissions[role], this.state.simTime) ?? '')
            : name === 'buy' ? this.rules.buy(this.state, drone, args.item as any) : this.rules.fire(this.state, drone);
          if (name === 'mine') { this.motion.clear(drone); drone.action = undefined; }
          this.emit('capabilities-changed'); this.emit('change');
          return textResult({ ...result, commandMission: args.mission });
        } catch (error) { throw new ControllerRejection(error instanceof Error ? error.message : String(error)); }
      }
      const decoded = this.vehicleTransport ? await this.vehicleTransport.command(role, args, poseOf(drone), this.state.simTime) : args;
      if (!this.state.running) return textResult({ stopped: true });
      if (!this.toolCapabilities(role).alive) return textResult({ stopped: true, destroyed: true });
      if (args.mission !== this.droneMissions[role]) throw new Error('Mission changed while the command was in transit; command rejected');
      return this.act(drone, { ...decoded, mission: args.mission });
    } catch (error) {
      if (error instanceof ControllerRejection) return textResult({ accepted: false, rejected: true, reason: error.message, commandMission: args.mission });
      return { ...textResult({ error: error instanceof Error ? error.message : String(error) }), isError: true };
    }
  }

  private act(drone: Drone, args: Record<string, unknown>) {
    const kind = args.kind;
    if (kind === 'hover') {
      this.rules.cancelMining(drone);
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
    this.rules.cancelMining(drone);
    drone.action = { id: `action-${++this.serial}`, kind, target }; drone.status = 'Flying';
    this.motion.faceWaypoint(drone, target);
    return textResult({ actionId: drone.action.id, accepted: true, target, commandMission: args.mission });
  }

  tick(dt: number) {
    if (!this.state.running || !this.connected) return;
    if (!Number.isFinite(dt)) return;
    dt = Math.min(Math.max(dt, 0), 0.25) * this.state.speed;
    // Fixed maximum integration step keeps acceleration and swept collisions
    // consistent through slow browser frames and the simulation-speed slider.
    const steps = Math.ceil(dt * 120);
    for (let i = 0; i < steps && this.state.running; i++) this.step(dt / steps);
  }

  private step(dt: number) {
    this.state.simTime += dt;
    const previous = new Map(this.state.drones.map(drone => [drone.id, { x: drone.x, y: drone.y, z: drone.z }]));
    const alive = new Set(this.state.drones.filter(drone => drone.alive !== false).map(drone => drone.id));
    const armored = new Set(this.state.drones.filter(drone => drone.equipment?.armor).map(drone => drone.id));
    const mining = new Set(this.state.drones.filter(drone => drone.mining).map(drone => drone.id));
    const unlocked = { blue: this.state.match!.teams.blue.shopUnlocked, red: this.state.match!.teams.red.shopUnlocked };
    for (const drone of this.state.drones) {
      if (drone.alive === false) continue;
      const { next, arrived } = this.motion.step(drone, dt);
      const collision = this.rules.terrainCollision(this.state, drone, previous.get(drone.id)!, next);
      Object.assign(drone, collision.position);
      if (collision.collided) {
        this.motion.clear(drone);
      } else if (arrived && drone.action) {
        this.inboxes[drone.id].push({ type: 'arrived', mission: this.droneMissions[drone.id], actionId: drone.action.id, simTime: this.state.simTime, occurredAt: new Date().toISOString() });
        drone.action = undefined; drone.status = 'Hovering';
      }
    }
    for (const id of this.rules.step(this.state, dt, previous)) this.motion.clear(this.state.drones.find(drone => drone.id === id)!);
    for (const drone of this.state.drones) {
      if (alive.has(drone.id) && drone.alive === false) {
        this.motion.clear(drone); this.vision.forget(drone.id); this.deferredRadio.delete(drone.id);
        drone.online = false;
        this.inboxes[drone.id].push({ type: 'destroyed', mission: this.droneMissions[drone.id], simTime: this.state.simTime });
        this.emit('drone-destroyed', { droneId: drone.id });
      } else if (armored.has(drone.id) && !drone.equipment?.armor) {
        this.inboxes[drone.id].push({ type: 'armor_lost', mission: this.droneMissions[drone.id], simTime: this.state.simTime });
      }
      if (drone.alive !== false && mining.has(drone.id) && !drone.mining) {
        this.inboxes[drone.id].push({ type: 'mining_stopped', mission: this.droneMissions[drone.id], simTime: this.state.simTime });
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
