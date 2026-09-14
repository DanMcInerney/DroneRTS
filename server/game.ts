import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DRONE_IDS, type Drone, type DroneId, type GameState, type Pose, type Role, type ToolResult, type RadioMessage, type Treasure } from '../shared/types.ts';
import { CITY } from '../shared/city.ts';
import { DRONE_CAMERA } from '../shared/camera-profile.ts';
import { intersectsBuilding } from './world-geometry.ts';
import { Mailbox } from './mailbox.ts';
import { CAMERA_PITCH_LIMITS, DroneMotion } from './drone-motion.ts';
import { TreasureHunt } from './treasure-hunt.ts';
import { MODEL, EFFORT } from './runtime-tools.ts';

const BOUNDS = CITY.bounds;
const textResult = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const finite = (value: unknown, label: string) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
};
const poseOf = ({ x, y, z, yaw, pitch }: Pose): Pose => ({ x, y, z, yaw, pitch });
const positionOf = ({ x, y, z }: Pose) => ({ x, y, z });
class ControllerRejection extends Error {}
interface VehicleTransport {
  command(id: DroneId, args: Record<string, unknown>, pose: Pose, simTime: number): Promise<Record<string, unknown>>;
  sample(id: DroneId, pose: Pose, simTime: number): Promise<{ position: { x: number; y: number; z: number }; heading: { degrees: number }; simTime: number }>;
}
interface RadioTransport { send(message: RadioMessage): Promise<unknown>; consume(id: DroneId, ids: string[]): void }

export class FleetGame extends EventEmitter {
  state: GameState;
  inboxes: Record<DroneId, Mailbox>;
  private playerQueue: Array<{ id: string; text: string }> = [];
  private playerWake = new Set<() => void>();
  private serial = 0;
  private treasureHunt = new TreasureHunt(CITY.intersections);
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
  capture: (id: DroneId, pose: Pose, simTime: number, drones: Drone[]) => Promise<string> = async () => { throw new Error('Camera browser is disconnected'); };

  constructor() {
    super();
    this.inboxes = this.newInboxes();
    this.state = this.newState();
  }

  private newInboxes() { return Object.fromEntries(DRONE_IDS.map(id => [id, new Mailbox()])) as Record<DroneId, Mailbox>; }
  private newState(previous?: Treasure[]): GameState {
    return {
      simTime: 0, mission: 0, running: false, speed: 1,
      ...this.treasureHunt.newMap(previous),
      obstacles: CITY.buildings.map(building => ({ ...building })),
      drones: DRONE_IDS.map((id, i) => ({ id, ...CITY.spawns[i], status: 'Standby', online: false, observations: 0 })),
      radio: [], runtime: { status: 'idle', message: `Ready to launch ${DRONE_IDS.length} native drone agents`, model: MODEL, effort: EFFORT },
    };
  }

  reset() {
    if (this.state.running) throw new Error('Stop the fleet before resetting');
    this.stop(); this.state = this.newState(this.state.treasures); this.inboxes = this.newInboxes();
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
    this.state.mission = 0; this.state.radio = [];
    this.state.running = true;
    Object.assign(this.state, this.treasureHunt.restart(this.state.treasures));
    for (const drone of this.state.drones) { drone.action = undefined; drone.online = false; drone.status = 'Connecting'; }
    this.emit('change');
  }
  stop() {
    this.state.running = false;
    this.playerQueue = [];
    this.motion.clear();
    for (const drone of this.state.drones) {
      drone.action = undefined; drone.online = false; drone.status = 'Stopped';
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
  queueMission(value: unknown) {
    if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw new Error('Instruction must be 1–4000 characters');
    const item = { id: `player-${++this.serial}`, text: value };
    this.playerQueue.push(item);
    for (const wake of [...this.playerWake]) wake();
    return { queued: true, id: item.id };
  }

  receiveRadio(recipient: DroneId, message: RadioMessage) {
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

  private async forward() {
    const ready = () => this.playerQueue.length > 0 && this.state.drones.every(d => d.online);
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
    if (!ready()) return textResult({ waiting: true, readyDrones: this.state.drones.filter(d => d.online).length });
    const item = this.playerQueue.shift()!;
    this.state.mission++;
    const message = this.log('player', 'all', 'mission', item.text);
    if (this.radioTransport) await this.radioTransport.send(message);
    else for (const id of DRONE_IDS) this.receiveRadio(id, message);
    return textResult({ forwarded: item.id, mission: this.state.mission, recipients: [...DRONE_IDS] });
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
    if (role !== 'parent' && DRONE_IDS.includes(role) && this.state.running) {
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
    const currentAction = drone.action ? { id: drone.action.id, kind: drone.action.kind } : null;
    const peers = this.state.drones.map(d => ({ ...d }));
    const telemetry = this.vehicleTransport ? await this.vehicleTransport.sample(role, pose, simTime) : undefined;
    let camera: { available: boolean; width: number; height: number; error?: string } = { available: true, width: DRONE_CAMERA.width, height: DRONE_CAMERA.height };
    let image: ToolResult['content'][number] | undefined;
    try {
      const url = await this.capture(role, pose, simTime, peers);
      const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(url);
      if (!match) throw new Error('Invalid camera image');
      image = { type: 'image', mimeType: `image/${match[1]}`, data: match[2] };
      drone.observations++;
    } catch {
      camera = { ...camera, available: false, error: 'Camera unavailable; no image supplied. Wait for a fresh observation.' };
    }
    const sensors = { position: { frame: 'local', ...(telemetry?.position ?? positionOf(pose)) }, heading: telemetry?.heading ?? { degrees: (360 - pose.yaw) % 360 },
      timestamp: { capturedAt, simTime: telemetry?.simTime ?? simTime }, camera };
    return { sensors, image, currentAction, mission, pose, simTime };
  }

  private async withObservation(role: DroneId, result: ToolResult, after: unknown): Promise<ToolResult> {
    const sessionId = this.sessionId;
    let sample = await this.snapshot(role);
    const active = () => this.state.running && sessionId === this.sessionId;
    const drone = this.state.drones.find(d => d.id === role)!;
    // A short flight can finish while the browser encodes its frame. Refresh once
    // rather than pairing an arrival event with a pre-arrival picture by default.
    if (active() && (sample.currentAction?.id !== drone.action?.id || sample.mission !== this.droneMissions[role])) sample = await this.snapshot(role);
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
    this.treasureHunt.recordObservation({ drone: role, pose: sample.pose, mission: sample.mission,
      simTime: sample.simTime, imageAvailable: Boolean(image) }, this.state.treasures, this.state.obstacles);
    const original = result.content.find(c => c.type === 'text');
    const value = original?.type === 'text' ? JSON.parse(original.text) : {};
    const bundle = textResult({ ...value, protocol: 'fleet-observation/1', sessionId, mission: this.droneMissions[role],
      stopped: false, ...inbox, currentAction: drone.action ? { id: drone.action.id, kind: drone.action.kind } : null,
      deliveredAt: new Date().toISOString(), deliverySimTime: this.state.simTime, sensors });
    if (image) bundle.content.push(image);
    if (result.isError) bundle.isError = true;
    this.emit('observation', { drone: role, sensors, mission: this.droneMissions[role], deliveredCursor: inbox.cursor, eventCount: inbox.events.length });
    return bundle;
  }

  private async dispatch(role: Role, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      if (role === 'parent') {
        if (name !== 'forward_next_instruction') throw new Error('The relay parent has no drone tools');
        return await this.forward();
      }
      if (!DRONE_IDS.includes(role)) throw new Error('Unknown drone identity');
      if (!this.state.running) return textResult({ stopped: true, instruction: 'End your drone task; this session has stopped.' });
      const drone = this.state.drones.find(d => d.id === role)!;
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
      if (name !== 'send' && name !== 'act') throw new Error('Tool is not available to this drone');
      if (args.mission !== this.droneMissions[role] || !this.droneMissions[role]) throw new Error(`Stale or missing mission; your current mission is ${this.droneMissions[role]}. Read your inbox before acting.`);
      if (name === 'send') {
        const to = args.to as string, kind = args.kind as string, text = args.text;
        if (to !== 'all' && !DRONE_IDS.includes(to as DroneId)) throw new Error('Unknown radio recipient');
        if (!['chat', 'found', 'claim', 'done'].includes(kind)) throw new Error('Unknown radio message kind');
        if (typeof text !== 'string' || !text.trim() || text.length > 1600) throw new Error('Radio message must be 1–1600 characters');
        const data = args.data as Record<string, unknown> | undefined;
        if (data && (typeof data !== 'object' || Array.isArray(data) || JSON.stringify(data).length > 3000)) throw new Error('Radio data must be a small JSON object');
        const message = this.log(role, to, kind, text, data, this.droneMissions[role]);
        if (this.radioTransport) {
          await this.radioTransport.send(message);
          this.reportTreasure(role, message);
          return textResult({ queued: message.id, delivery: 'Awaiting peer receipt', commandMission: args.mission });
        }
        // In-memory seam is for isolated unit tests. The application always installs Zenoh.
        for (const id of DRONE_IDS) if (id !== role && (to === 'all' || id === to)) this.receiveRadio(id, message);
        this.reportTreasure(role, message);
        return textResult({ sent: message.id, commandMission: args.mission });
      }
      const decoded = this.vehicleTransport ? await this.vehicleTransport.command(role, args, poseOf(drone), this.state.simTime) : args;
      if (!this.state.running) return textResult({ stopped: true });
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
    for (let i = 0; i < steps; i++) this.step(dt / steps);
  }

  private step(dt: number) {
    this.state.simTime += dt;
    for (const drone of this.state.drones) {
      const { next, arrived } = this.motion.step(drone, dt);
      if (next.x === drone.x && next.y === drone.y && next.z === drone.z && !arrived) continue;
      const blocked = (['x', 'y', 'z'] as const).some(axis => next[axis] < BOUNDS[axis][0] || next[axis] > BOUNDS[axis][1])
        || this.state.obstacles.some(o => intersectsBuilding(drone, next, o, 0.3));
      if (blocked) {
        this.inboxes[drone.id].push({ type: 'blocked', mission: this.droneMissions[drone.id], actionId: drone.action?.id, simTime: this.state.simTime, occurredAt: new Date().toISOString() });
        this.motion.clear(drone);
        drone.action = undefined; drone.status = 'Obstacle — hovering';
      } else {
        Object.assign(drone, next);
        if (arrived) {
          this.inboxes[drone.id].push({ type: 'arrived', mission: this.droneMissions[drone.id], actionId: drone.action!.id, simTime: this.state.simTime, occurredAt: new Date().toISOString() });
          drone.action = undefined; drone.status = 'Hovering';
        }
      }
    }
  }

  private reportTreasure(role: DroneId, message: RadioMessage) {
    if (!this.state.running) return;
    const outcome = this.treasureHunt.report({ drone: role, message, mission: this.droneMissions[role],
      simTime: this.state.simTime }, this.state.treasures);
    if (!outcome) return;
    // Score and identities belong to the player HUD; agents see only their own image and radio.
    this.emit('treasure-found', outcome.event);
    this.state.completed = outcome.completed;
    this.emit('change');
  }
}
