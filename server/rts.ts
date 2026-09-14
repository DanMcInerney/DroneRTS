import { randomUUID } from 'node:crypto';
import type { Drone, DroneId, GameState } from '../shared/types.ts';
import { batteryCapacityFor, emptyEquipment, startingEquipment, EQUIPMENT_MODULES, insideZone, resourceZoneSize, serviceZoneSize, RTS_CONFIG, type EquipmentItem, type EquipmentModule, type MatchEvent, type MatchState, type Point, type ResourceNode, type ServicePad, type TeamId } from '../shared/rts.ts';
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
const chargeOf = (drone: Drone) => drone.battery ?? RTS_CONFIG.batteryCapacity;

/** All durable match state belongs to GameState. No second economy or damage authority exists. */
export class RtsRules {
  constructor(private readonly onEvent?: (event: MatchEvent) => void) {}

  newMatch(resources: readonly ResourceNode[], servicePads: readonly ServicePad[] = []): MatchState {
    const economy = () => ({ credits: RTS_CONFIG.startingCredits, earned: 0, shopUnlocked: true });
    return {
      phase: 'ready', winner: null, teams: { blue: economy(), red: economy() },
      resources: resources.map(node => ({ ...node, remaining: node.capacity, zoneSize: resourceZoneSize(node) })),
      servicePads: servicePads.map(pad => ({ ...pad, zoneSize: serviceZoneSize(pad) })), projectiles: [], events: [],
    };
  }

  begin(state: GameState) {
    // Refund old reservations before replacing their wallet; never credit the next match.
    for (const drone of state.drones) this.cancelService(state, drone);
    const previous = matchOf(state);
    state.match = this.newMatch(previous.resources, previous.servicePads); state.match.phase = 'active'; state.completed = false;
    for (const drone of state.drones) {
      drone.alive = true; drone.equipment = startingEquipment(); drone.mining = undefined; drone.lastFiredAt = undefined;
      drone.ammo = 0; drone.cameraMode = 'wide'; drone.servicing = undefined;
      drone.battery = RTS_CONFIG.batteryCapacity; drone.jamming = false; drone.charging = false;
    }
    this.syncInterference(state);
    this.event(state, { type: 'match_started', message: 'Salvage is live. Last team flying wins.' });
  }

  private assertActive(state: GameState, drone: Drone) {
    if (!alive(drone)) throw new Error('This drone is destroyed');
    if (matchOf(state).phase !== 'active') throw new Error('The match is not active');
    if (chargeOf(drone) <= 0) throw new Error('No battery charge remains');
    team(drone);
  }

  /** Compatibility acknowledgement. Occupancy alone controls automatic extraction. */
  mine(state: GameState, drone: Drone, _legacyResourceId?: string) {
    this.assertActive(state, drone);
    const node = this.resourceAt(state, drone);
    drone.mining = node?.id;
    if (!node) throw new Error('No accessible salvage in reach; enter a resource zone');
    return { accepted: true, action: 'mine' };
  }

  cancelMining(drone: Drone) { drone.mining = undefined; }

  buy(state: GameState, drone: Drone, item: EquipmentItem, replace?: EquipmentModule) {
    this.assertActive(state, drone);
    if (!Object.hasOwn(RTS_CONFIG.prices, item)) throw new Error('Unknown attachment');
    const wallet = matchOf(state).teams[team(drone)], price = RTS_CONFIG.prices[item];
    if (!wallet.shopUnlocked) throw new Error('The team shop is unavailable');
    if (!this.friendlyPad(state, drone)) throw new Error('A friendly service pad must be within reach');
    const gear = equipment(drone), isModule = EQUIPMENT_MODULES.includes(item as EquipmentModule);
    if (replace !== undefined && (!isModule || !EQUIPMENT_MODULES.includes(replace) || !gear[replace] || replace === item)) {
      throw new Error('Replacement must name a different equipped module');
    }
    if (item === 'miner_upgrade') {
      if (!gear.miner) throw new Error('A mining drill is required');
      if (gear.minerUpgrade) throw new Error('This attachment is already equipped');
    } else if (gear[item]) throw new Error('This attachment is already equipped');
    if (isModule && EQUIPMENT_MODULES.filter(module => gear[module]).length - Number(replace !== undefined) >= RTS_CONFIG.moduleSlots) {
      throw new Error('Both module slots are occupied; choose a module to replace');
    }
    // A successful refit can use its own refunded reservation. Failed validation changes nothing.
    const refund = drone.servicing?.kind === 'recharge' ? 0 : (drone.servicing?.paid ?? 0);
    if (wallet.credits + refund + 1e-9 < price) throw new Error('Insufficient shared team credits');
    // Synchronous validation and debit are one transaction even when peer calls arrive together.
    this.cancelService(state, drone);
    wallet.credits = Math.max(0, wallet.credits - price);
    if (replace) {
      gear[replace] = false;
      if (replace === 'gun') { drone.ammo = 0; drone.lastFiredAt = undefined; }
      if (replace === 'miner') gear.minerUpgrade = false;
      if (replace === 'optics') drone.cameraMode = 'wide';
    }
    if (item === 'miner_upgrade') gear.minerUpgrade = true;
    else gear[item] = true;
    if (item === 'gun') drone.ammo = RTS_CONFIG.magazineSize;
    drone.battery = Math.min(chargeOf(drone), batteryCapacityFor(drone));
    drone.jamming = false; this.syncInterference(state);
    this.event(state, { type: 'purchased', team: team(drone), drone: drone.id, message: `${drone.id} attached ${item}.` });
    return { equipped: item, credits: wallet.credits };
  }

  rearm(state: GameState, drone: Drone) {
    this.assertActive(state, drone);
    if (!equipment(drone).gun) throw new Error('No gun is attached');
    if (drone.servicing) throw new Error('Servicing is already in progress');
    if ((drone.ammo ?? 0) >= RTS_CONFIG.magazineSize) throw new Error('The magazine is already full');
    const pad = this.friendlyPad(state, drone);
    if (!pad) throw new Error('A friendly service pad must be within reach');
    const wallet = matchOf(state).teams[team(drone)];
    if (wallet.credits + 1e-9 < RTS_CONFIG.rearmCost) throw new Error('Insufficient shared team credits');
    wallet.credits = Math.max(0, wallet.credits - RTS_CONFIG.rearmCost);
    drone.servicing = { kind: 'rearm', padId: pad.id, remaining: RTS_CONFIG.serviceDuration, paid: RTS_CONFIG.rearmCost };
    drone.action = undefined; drone.status = 'Rearming';
    drone.jamming = false; this.syncInterference(state);
    this.event(state, { type: 'service_started', team: team(drone), drone: drone.id, message: `${drone.id} is rearming.` });
    return { accepted: true, action: 'rearm', credits: wallet.credits };
  }

  recharge(state: GameState, drone: Drone) {
    this.assertActive(state, drone);
    const pad = this.friendlyPad(state, drone);
    drone.charging = !!pad;
    if (!pad) throw new Error('A friendly service pad must be within reach');
    return { accepted: true, action: 'recharge', credits: matchOf(state).teams[team(drone)].credits };
  }

  jam(state: GameState, drone: Drone, enabled: boolean) {
    this.assertActive(state, drone);
    if (!equipment(drone).jammer) throw new Error('No jammer is attached');
    if (typeof enabled !== 'boolean') throw new Error('Jammer state must be enabled or disabled');
    if (enabled && drone.servicing) throw new Error('The jammer cannot operate during servicing');
    drone.jamming = enabled; this.syncInterference(state);
    return { jamming: drone.jamming };
  }

  /** Only local radio availability is reported; emitter identities and distances stay private. */
  syncInterference(state: GameState) {
    const active = matchOf(state).phase === 'active';
    for (const drone of state.drones) {
      if (!active || !alive(drone) || !drone.equipment?.jammer || chargeOf(drone) <= 0 || drone.servicing) drone.jamming = false;
    }
    const sources = state.drones.filter(drone => drone.jamming);
    const changes: Drone[] = [];
    for (const drone of state.drones) {
      const jammed = active && alive(drone) && sources.some(source => distance(drone, source) <= RTS_CONFIG.jammerRange);
      if (!!drone.radioJammed !== jammed) changes.push(drone);
      drone.radioJammed = jammed;
    }
    // Native transport reconciliation can run from any event; expose the complete new state first.
    for (const drone of changes) this.event(state, {
      type: 'radio_changed', team: team(drone), drone: drone.id,
      message: drone.radioJammed ? 'Local peer radio is interrupted.' : 'Local radio interference cleared.',
    });
  }

  cancelService(state: GameState, drone: Drone) {
    const service = drone.servicing;
    if (!service) return;
    // Clear first so repeated lifecycle paths (including death and Stop) cannot refund twice.
    drone.servicing = undefined;
    const charging = service.kind === 'recharge';
    if (!charging) matchOf(state).teams[team(drone)].credits += service.paid;
    if (alive(drone)) drone.status = charging ? 'Recharging cancelled' : 'Rearming cancelled';
    this.event(state, { type: 'service_cancelled', team: team(drone), drone: drone.id,
      message: charging ? `${drone.id} cancelled recharging.` : `${drone.id} cancelled rearming; salvage refunded.` });
  }

  fire(state: GameState, drone: Drone) {
    this.assertActive(state, drone);
    if (!equipment(drone).gun) throw new Error('No gun is attached');
    if ((drone.ammo ?? 0) <= 0) throw new Error('The magazine is empty; rearm at a friendly service pad');
    if (drone.lastFiredAt !== undefined && state.simTime - drone.lastFiredAt < RTS_CONFIG.fireCooldown - 1e-9) throw new Error('Gun is cycling');
    this.cancelService(state, drone);
    drone.ammo = (drone.ammo ?? 0) - 1;
    const yaw = drone.yaw * Math.PI / 180, pitch = drone.pitch * Math.PI / 180;
    const forward = { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
    const speed = RTS_CONFIG.bulletSpeed;
    // Start at the body center, ignoring only the owner: muzzle offsets must not shoot through walls.
    const projectileId = randomUUID();
    matchOf(state).projectiles.push({ id: projectileId, owner: drone.id, team: team(drone), ...position(drone),
      vx: forward.x * speed, vy: forward.y * speed, vz: forward.z * speed, age: 0 });
    drone.lastFiredAt = state.simTime;
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
    if (!state.running || matchOf(state).phase !== 'active') {
      for (const drone of state.drones) { drone.mining = undefined; drone.charging = false; }
      return [];
    }
    if (!Number.isFinite(dt) || dt <= 0) return [];
    const changed = new Set<DroneId>();
    this.stepDroneContacts(state, previousPositions, changed);
    this.stepBullets(state, dt, previousPositions, changed);
    for (const drone of state.drones) drone.mining = alive(drone) ? this.resourceAt(state, drone)?.id : undefined;
    this.stepServices(state, dt, previousPositions);
    this.stepEnergy(state, dt, previousPositions, changed);
    this.stepMining(state, dt);
    this.resolveVictory(state);
    this.syncInterference(state);
    return [...changed];
  }

  private inMiningReach(_state: GameState, drone: Drone, node: ResourceNode) {
    return node.remaining > 1e-9 && insideZone(drone, node, resourceZoneSize(node));
  }

  private resourceAt(state: GameState, drone: Drone) {
    // At most one deposit per drone even if custom fixtures overlap their volumes.
    return matchOf(state).resources.find(node => node.id === drone.mining && this.inMiningReach(state, drone, node))
      ?? matchOf(state).resources.find(node => this.inMiningReach(state, drone, node));
  }

  private inServiceReach(state: GameState, drone: Drone, pad: ServicePad) {
    return pad.team === team(drone) && insideZone(drone, pad, serviceZoneSize(pad));
  }

  private friendlyPad(state: GameState, drone: Drone) {
    return matchOf(state).servicePads?.find(pad => this.inServiceReach(state, drone, pad));
  }

  private stepServices(state: GameState, dt: number, previous: ReadonlyMap<DroneId, Point>) {
    for (const drone of state.drones) {
      const service = drone.servicing;
      if (!service) continue;
      const pad = matchOf(state).servicePads?.find(candidate => candidate.id === service.padId);
      const moved = previous.has(drone.id) && distance(previous.get(drone.id)!, drone) > 1e-7;
      const charging = service.kind === 'recharge';
      // Legacy timed recharge records cannot grant an instant refill under zone charging.
      if (charging) { drone.servicing = undefined; continue; }
      if (!alive(drone) || chargeOf(drone) <= 0 || !equipment(drone).gun || drone.action || moved || !pad || !this.inServiceReach(state, drone, pad)) {
        this.cancelService(state, drone); continue;
      }
      service.remaining = Math.max(0, service.remaining - dt);
      if (service.remaining > 1e-9) continue;
      drone.servicing = undefined;
      drone.ammo = RTS_CONFIG.magazineSize; drone.status = 'Rearmed';
      this.event(state, { type: 'service_completed', team: team(drone), drone: drone.id, message: `${drone.id} rearmed.` });
    }
  }

  private stepEnergy(state: GameState, dt: number, previous: ReadonlyMap<DroneId, Point>, changed: Set<DroneId>) {
    for (const drone of state.drones) {
      drone.charging = false;
      if (!alive(drone)) continue;
      const before = Math.min(chargeOf(drone), batteryCapacityFor(drone));
      if (before <= 0) { drone.battery = 0; this.damage(state, drone, 'power'); changed.add(drone.id); continue; }
      if (this.friendlyPad(state, drone)) {
        drone.charging = true;
        drone.battery = Math.min(batteryCapacityFor(drone), before + dt * RTS_CONFIG.batteryCapacity / RTS_CONFIG.rechargeDuration);
        if (before < batteryCapacityFor(drone) - 1e-9 && drone.battery >= batteryCapacityFor(drone) - 1e-9) {
          this.event(state, { type: 'battery_full', team: team(drone), drone: drone.id, message: 'Battery charge is full.' });
        }
        continue;
      }
      const moving = previous.has(drone.id) && distance(previous.get(drone.id)!, drone) > 1e-7;
      const node = drone.mining && matchOf(state).resources.find(candidate => candidate.id === drone.mining);
      const mining = !!node && this.inMiningReach(state, drone, node);
      const rate = RTS_CONFIG.idleDrain + (moving ? RTS_CONFIG.movingDrain : 0)
        + (mining ? RTS_CONFIG.miningDrain : 0) + (drone.jamming && drone.equipment?.jammer ? RTS_CONFIG.jammerDrain : 0);
      drone.battery = Math.max(0, before - dt * rate);
      if (drone.battery <= 1e-9) {
        drone.battery = 0; this.damage(state, drone, 'power'); changed.add(drone.id); continue;
      }
      const threshold = batteryCapacityFor(drone) * RTS_CONFIG.lowBatteryFraction;
      if (before > threshold + 1e-9 && drone.battery <= threshold + 1e-9) {
        this.event(state, { type: 'battery_low', team: team(drone), drone: drone.id, message: 'Battery charge is low.' });
      }
    }
  }

  private stepMining(state: GameState, dt: number) {
    const match = matchOf(state);
    for (const node of match.resources) {
      const miners = state.drones.filter(drone => alive(drone) && drone.mining === node.id);
      const available = miners.filter(drone => this.inMiningReach(state, drone, node));
      for (const drone of miners) if (!available.includes(drone)) { this.cancelMining(drone); drone.status = 'Salvage out of reach'; }
      const demands = available.map(drone => {
        const gear = equipment(drone);
        const rate = gear.miner ? (gear.minerUpgrade ? RTS_CONFIG.upgradedMinerRate : RTS_CONFIG.minerRate) : RTS_CONFIG.miningRate;
        return { drone, amount: dt * rate * (node.extractionMultiplier ?? 1) };
      });
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

  private damage(state: GameState, drone: Drone, cause: 'terrain' | 'ram' | 'bullet' | 'power', source?: DroneId, impact?: Point, projectileId?: string) {
    if (!alive(drone)) return;
    this.cancelService(state, drone); this.cancelMining(drone); drone.action = undefined;
    drone.jamming = false; drone.charging = false;
    if (cause !== 'power' && equipment(drone).armor) {
      equipment(drone).armor = false; drone.status = cause === 'bullet' ? 'Hit detected. Armor lost.' : 'Collision detected. Armor lost.';
      this.syncInterference(state);
      this.event(state, { type: 'armor_consumed', cause, projectileId, team: team(drone), drone: drone.id, target: source, ...position(impact ?? drone), message: `${drone.id}: ${drone.status}` });
    } else {
      drone.alive = false; drone.online = false; drone.status = 'Destroyed'; drone.ammo = 0;
      this.syncInterference(state);
      this.event(state, { type: 'destroyed', cause, projectileId, team: team(drone), drone: drone.id, target: source, ...position(impact ?? drone), message: `${drone.id} was destroyed by ${cause}.` });
    }
  }

  private resolveVictory(state: GameState) {
    const survivors = new Set(state.drones.filter(alive).map(team));
    if (survivors.size > 1) return;
    const match = matchOf(state);
    match.phase = 'finished'; match.winner = survivors.size ? [...survivors][0] : 'draw'; state.completed = true;
    for (const drone of state.drones) { this.cancelService(state, drone); drone.mining = undefined; drone.action = undefined; drone.jamming = false; drone.charging = false; }
    this.syncInterference(state);
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
