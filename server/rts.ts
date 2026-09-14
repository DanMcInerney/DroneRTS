import { randomUUID } from 'node:crypto';
import type { Drone, DroneId, GameState } from '../shared/types.ts';
import { emptyEquipment, RTS_CONFIG, type EquipmentItem, type MatchEvent, type MatchState, type Point, type ResourceNode, type TeamId } from '../shared/rts.ts';
import { intersectsBuilding } from './world-geometry.ts';
import { at, distance, offset, sphereContact, subtract, terrainContact, unit } from './rts-geometry.ts';

const position = ({ x, y, z }: Point): Point => ({ x, y, z });
const alive = (drone: Drone) => drone.alive !== false;
const team = (drone: Drone): TeamId => {
  if (drone.team !== 'blue' && drone.team !== 'red') throw new Error('Drone has no team');
  return drone.team;
};
const matchOf = (state: GameState) => {
  if (!state.match) throw new Error('No match is configured');
  return state.match;
};
const equipment = (drone: Drone) => drone.equipment ??= emptyEquipment();

/** All durable match state belongs to GameState. No second economy or damage authority exists. */
export class RtsRules {
  constructor(private readonly onEvent?: (event: MatchEvent) => void) {}

  newMatch(resources: readonly ResourceNode[]): MatchState {
    const economy = () => ({ credits: 0, earned: 0, shopUnlocked: false });
    return {
      phase: 'ready', winner: null, teams: { blue: economy(), red: economy() },
      resources: resources.map(node => ({ ...node, remaining: node.capacity })), projectiles: [], events: [],
    };
  }

  begin(state: GameState) {
    state.match = this.newMatch(matchOf(state).resources); state.match.phase = 'active'; state.completed = false;
    for (const drone of state.drones) {
      drone.alive = true; drone.equipment = emptyEquipment(); drone.mining = undefined; drone.lastFiredAt = undefined;
    }
    this.event(state, { type: 'match_started', message: 'Salvage is live. Last team flying wins.' });
  }

  private assertActive(state: GameState, drone: Drone) {
    if (!alive(drone)) throw new Error('This drone is destroyed');
    if (matchOf(state).phase !== 'active') throw new Error('The match is not active');
    team(drone);
  }

  /** resourceId must be selected by the private camera-evidence gate, never an arbitrary tool argument. */
  mine(state: GameState, drone: Drone, resourceId: string) {
    this.assertActive(state, drone);
    const node = matchOf(state).resources.find(value => value.id === resourceId);
    if (!node || !this.inMiningReach(state, drone, node)) throw new Error('No accessible salvage in reach');
    drone.mining = node.id; drone.action = undefined; drone.status = 'Mining salvage';
    return { accepted: true, action: 'mine' };
  }

  cancelMining(drone: Drone) { drone.mining = undefined; }

  buy(state: GameState, drone: Drone, item: EquipmentItem) {
    this.assertActive(state, drone);
    if (!Object.hasOwn(RTS_CONFIG.prices, item)) throw new Error('Unknown attachment');
    const wallet = matchOf(state).teams[team(drone)], price = RTS_CONFIG.prices[item];
    if (!wallet.shopUnlocked) throw new Error('The team has not recovered salvage yet');
    if (equipment(drone)[item]) throw new Error('This attachment is already equipped');
    if (wallet.credits + 1e-9 < price) throw new Error('Insufficient shared team credits');
    // Synchronous validation and debit are one transaction even when peer calls arrive together.
    wallet.credits = Math.max(0, wallet.credits - price); equipment(drone)[item] = true;
    this.event(state, { type: 'purchased', team: team(drone), drone: drone.id, message: `${drone.id} attached ${item}.` });
    return { equipped: item, credits: wallet.credits };
  }

  fire(state: GameState, drone: Drone) {
    this.assertActive(state, drone);
    if (!equipment(drone).gun) throw new Error('No gun is attached');
    if (drone.lastFiredAt !== undefined && state.simTime - drone.lastFiredAt < RTS_CONFIG.fireCooldown - 1e-9) throw new Error('Gun is cycling');
    const yaw = drone.yaw * Math.PI / 180, pitch = drone.pitch * Math.PI / 180;
    const forward = { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
    const speed = RTS_CONFIG.bulletSpeed;
    // Start at the body center, ignoring only the owner: muzzle offsets must not shoot through walls.
    const projectileId = randomUUID();
    matchOf(state).projectiles.push({ id: projectileId, owner: drone.id, team: team(drone), ...position(drone),
      vx: forward.x * speed, vy: forward.y * speed, vz: forward.z * speed, age: 0 });
    drone.lastFiredAt = state.simTime; this.cancelMining(drone);
    this.event(state, { type: 'fired', projectileId, team: team(drone), drone: drone.id, ...position(drone), message: `${drone.id} fired.` });
    return { fired: true };
  }

  terrainCollision(state: GameState, drone: Drone, from: Point, next: Point): { collided: boolean; position: Point } {
    if (!alive(drone) || matchOf(state).phase !== 'active') return { collided: false, position: next };
    const hit = terrainContact(from, next, state.obstacles, RTS_CONFIG.droneRadius);
    if (!hit) return { collided: false, position: next };
    this.damage(state, drone, 'terrain', undefined, hit.contact);
    const result = alive(drone) ? offset(hit.contact, hit.normal, 0.35) : hit.contact;
    return { collided: true, position: result };
  }

  /** Returns vehicles whose controllers must clear residual motion after an impact. */
  step(state: GameState, dt: number, previousPositions: ReadonlyMap<DroneId, Point> = new Map()): DroneId[] {
    if (!Number.isFinite(dt) || dt <= 0 || matchOf(state).phase !== 'active') return [];
    const changed = new Set<DroneId>();
    this.stepDroneContacts(state, previousPositions, changed);
    this.stepBullets(state, dt, previousPositions, changed);
    this.stepMining(state, dt);
    this.resolveVictory(state);
    return [...changed];
  }

  private inMiningReach(state: GameState, drone: Drone, node: ResourceNode) {
    const focus = { x: node.x, y: node.y + 0.65, z: node.z };
    return node.remaining > 1e-9 && distance(drone, focus) <= RTS_CONFIG.miningRange
      && !state.obstacles.some(building => intersectsBuilding(drone, focus, building));
  }

  private stepMining(state: GameState, dt: number) {
    const match = matchOf(state);
    for (const node of match.resources) {
      const miners = state.drones.filter(drone => alive(drone) && drone.mining === node.id);
      const available = miners.filter(drone => this.inMiningReach(state, drone, node));
      for (const drone of miners) if (!available.includes(drone)) { this.cancelMining(drone); drone.status = 'Salvage out of reach'; }
      const demands = available.map(drone => ({ drone, amount: dt * (equipment(drone).miner ? RTS_CONFIG.minerRate : RTS_CONFIG.miningRate) }));
      const wanted = demands.reduce((sum, miner) => sum + miner.amount, 0), scale = wanted ? Math.min(1, node.remaining / wanted) : 0;
      // Share a nearly exhausted deposit proportionally; roster order cannot steal its final tick.
      for (const { drone, amount } of demands) {
        const recovered = amount * scale, wallet = match.teams[team(drone)];
        wallet.credits += recovered; wallet.earned += recovered;
        if (recovered > 0 && !wallet.shopUnlocked) {
          wallet.shopUnlocked = true;
          this.event(state, { type: 'shop_unlocked', drone: drone.id, team: team(drone), message: `${team(drone)} recovered its first salvage. Attachments unlocked.` });
        }
      }
      node.remaining = Math.max(0, node.remaining - wanted * scale);
      if (wanted > 0 && node.remaining < 1e-9) {
        node.remaining = 0;
        for (const drone of available) { this.cancelMining(drone); drone.status = 'Salvage depleted'; }
        this.event(state, { type: 'resource_depleted', target: node.id, ...position(node), message: 'A salvage deposit was exhausted.' });
      }
    }
  }

  private stepDroneContacts(state: GameState, previous: ReadonlyMap<DroneId, Point>, changed: Set<DroneId>) {
    const drones = state.drones.filter(alive), end = new Map(drones.map(drone => [drone.id, position(drone)]));
    for (const drone of drones) Object.assign(drone, previous.get(drone.id) ?? drone);
    // Recompute after every impact: an armor deflection cancels the old trajectory.
    // Each event consumes armor or a vehicle, so six drones require at most 12 events.
    for (let iteration = 0; iteration < drones.length * 2; iteration++) {
      const contacts: Array<{ a: Drone; b: Drone; t: number }> = [];
      for (let i = 0; i < drones.length; i++) for (let j = i + 1; j < drones.length; j++) {
        const a = drones[i], b = drones[j];
        if (!alive(a) || !alive(b)) continue;
        const t = sphereContact(a, end.get(a.id)!, b, end.get(b.id)!, 2 * RTS_CONFIG.droneRadius);
        if (t !== undefined) contacts.push({ a, b, t });
      }
      if (!contacts.length) break;
      const time = Math.min(...contacts.map(contact => contact.t));
      const batch = contacts.filter(contact => contact.t <= time + 1e-7);
      for (const drone of drones) if (alive(drone)) Object.assign(drone, at(drone, end.get(drone.id)!, time));
      const impacts = new Map<Drone, Array<{ other: Drone; t: number }>>();
      for (const { a, b, t } of batch) if (alive(a) && alive(b)) {
        impacts.set(a, [...(impacts.get(a) ?? []), { other: b, t }]);
        impacts.set(b, [...(impacts.get(b) ?? []), { other: a, t }]);
      }
      const impactPositions = new Map([...impacts.keys()].map(drone => [drone.id, position(drone)]));
      // Simultaneous three-way contact consumes armor once, then applies the remaining impact.
      for (const [drone, hits] of impacts) {
        for (const { other } of hits) this.damage(state, drone, 'ram', other.id);
        changed.add(drone.id); end.set(drone.id, position(drone));
      }
      for (const [drone, hits] of impacts) {
        if (alive(drone)) {
          const direction = unit(subtract(drone, impactPositions.get(hits[0].other.id)!));
          Object.assign(drone, this.ramDeflection(state, drone, direction));
          end.set(drone.id, position(drone));
        }
      }
    }
    for (const drone of drones) if (alive(drone)) Object.assign(drone, end.get(drone.id));
  }

  private ramDeflection(state: GameState, drone: Drone, normal: Point): Point {
    const tangent = unit({ x: -normal.z, y: 0, z: normal.x });
    const directions = [normal, { x: 0, y: 1, z: 0 }, tangent, offset({ x: 0, y: 0, z: 0 }, tangent, -1)];
    // A wall can prevent the normal separation. Deflect up or tangentially through a
    // clear swept path instead of teleporting through the wall or leaving bodies touching.
    for (const amount of [0.42, 0.2, 0.08, 0.85]) for (const direction of directions) {
      const candidate = offset(drone, direction, amount);
      if (terrainContact(drone, candidate, state.obstacles, RTS_CONFIG.droneRadius)) continue;
      if (state.drones.some(other => other.id !== drone.id && alive(other) && distance(candidate, other) <= 2 * RTS_CONFIG.droneRadius + 1e-5)) continue;
      return candidate;
    }
    return position(drone);
  }

  private stepBullets(state: GameState, dt: number, previous: ReadonlyMap<DroneId, Point>, changed: Set<DroneId>) {
    const match = matchOf(state), keep = [];
    for (const bullet of match.projectiles) {
      let elapsed = 0, consumed = false;
      const duration = Math.min(dt, Math.max(0, RTS_CONFIG.bulletLifetime - bullet.age));
      while (elapsed < duration - 1e-12 && !consumed) {
        // Chords of a gravity arc with at most 0.000021 world units of sag error.
        const h = Math.min(1 / 120, duration - elapsed), from = position(bullet);
        const next = { x: bullet.x + bullet.vx * h, y: bullet.y + bullet.vy * h - RTS_CONFIG.bulletGravity * h * h / 2, z: bullet.z + bullet.vz * h };
        const terrain = terrainContact(from, next, state.obstacles, RTS_CONFIG.bulletRadius);
        let first = terrain?.t ?? Infinity, target: Drone | undefined;
        for (const drone of state.drones) {
          if (!alive(drone) || drone.id === bullet.owner) continue;
          const start = previous.get(drone.id) ?? drone;
          const a = at(start, drone, elapsed / dt), b = at(start, drone, (elapsed + h) / dt);
          const t = sphereContact(from, next, a, b, RTS_CONFIG.droneRadius + RTS_CONFIG.bulletRadius);
          if (t !== undefined && t < first - 1e-10) { first = t; target = drone; }
        }
        if (Number.isFinite(first)) {
          consumed = true;
          const impact = at(from, next, first);
          if (target) { this.damage(state, target, 'bullet', bullet.owner, impact, bullet.id); changed.add(target.id); }
          this.event(state, { type: 'impact', projectileId: bullet.id, cause: target ? 'bullet' : 'terrain', team: bullet.team, drone: bullet.owner, target: target?.id, ...impact, message: target ? 'Projectile hit a drone.' : 'Projectile struck terrain.' });
        } else Object.assign(bullet, next);
        bullet.vy -= RTS_CONFIG.bulletGravity * h; bullet.age += h; elapsed += h;
      }
      if (!consumed && bullet.age < RTS_CONFIG.bulletLifetime - 1e-9) keep.push(bullet);
      else if (!consumed) this.event(state, { type: 'projectile_expired', projectileId: bullet.id, cause: 'expired', team: bullet.team, drone: bullet.owner, ...position(bullet), message: 'Projectile expired without an impact.' });
    }
    match.projectiles = keep;
  }

  private damage(state: GameState, drone: Drone, cause: 'terrain' | 'ram' | 'bullet', source?: DroneId, impact?: Point, projectileId?: string) {
    if (!alive(drone)) return;
    this.cancelMining(drone); drone.action = undefined;
    if (equipment(drone).armor) {
      equipment(drone).armor = false; drone.status = 'Armor absorbed impact';
      this.event(state, { type: 'armor_consumed', cause, projectileId, team: team(drone), drone: drone.id, target: source, ...position(impact ?? drone), message: `${drone.id}'s armor absorbed ${cause === 'bullet' ? 'a bullet' : 'a collision'}.` });
    } else {
      drone.alive = false; drone.online = false; drone.status = 'Destroyed';
      this.event(state, { type: 'destroyed', cause, projectileId, team: team(drone), drone: drone.id, target: source, ...position(impact ?? drone), message: `${drone.id} was destroyed by ${cause}.` });
    }
  }

  private resolveVictory(state: GameState) {
    const survivors = new Set(state.drones.filter(alive).map(team));
    if (survivors.size > 1) return;
    const match = matchOf(state);
    match.phase = 'finished'; match.winner = survivors.size ? [...survivors][0] : 'draw'; state.completed = true;
    for (const drone of state.drones) { drone.mining = undefined; drone.action = undefined; }
    match.projectiles = [];
    this.event(state, { type: 'match_finished', message: match.winner === 'draw' ? 'Draw. Both teams were eliminated.' : `${match.winner} wins. Last team flying.` });
  }

  private event(state: GameState, event: Omit<MatchEvent, 'id' | 'simTime'>) {
    const events = matchOf(state).events;
    const record = { ...event, id: randomUUID(), simTime: state.simTime };
    events.push(record);
    if (events.length > 160) events.splice(0, events.length - 160);
    this.onEvent?.(record);
  }
}
