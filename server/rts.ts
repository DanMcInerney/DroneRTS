import { randomUUID } from 'node:crypto';
import type { Drone, DroneId, GameState } from '../shared/types.ts';
import { batteryCapacityFor, hasBatteries, isCargoRules, CARGO_V1_EQUIPMENT_MODULES, cargoCapacityFor, CARGO_CONFIG, emptyEquipment, startingEquipment, EQUIPMENT_MODULES, LEGACY_EQUIPMENT_MODULES, insideApron, insideZone, resourceZoneSize, serviceZoneSize, RTS_CONFIG, type CargoInactiveReason, type EquipmentItem, type EquipmentModule, type MatchEvent, type MatchState, type Point, type ResourceNode, type ServicePad, type TeamId } from '../shared/rts.ts';
import { CITY, type CityPoint } from '../shared/city.ts';
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
const chargeOf = (state: GameState, drone: Drone) => hasBatteries(matchOf(state).rulesVersion) ? drone.battery ?? RTS_CONFIG.batteryCapacity : Infinity;
const cargoOf = (drone: Drone) => drone.cargo ??= { amount: 0 };
const usesCargo = (state: GameState) => isCargoRules(matchOf(state).rulesVersion);

/** All durable match state belongs to GameState. No second economy or damage authority exists. */
export class RtsRules {
  constructor(private readonly onEvent?: (event: MatchEvent) => void) {}

  newMatch(resources: readonly ResourceNode[], servicePads: readonly ServicePad[] = []): MatchState {
    const economy = () => ({ credits: RTS_CONFIG.startingCredits, earned: 0, shopUnlocked: true });
    return {
      rulesVersion: 'cargo-v2', salvageLost: 0, phase: 'ready', winner: null, teams: { blue: economy(), red: economy() },
      resources: resources.filter(node => node.kind !== 'dropped').map(node => ({ ...node, kind: 'cache', reserved: 0, remaining: node.capacity, zoneSize: resourceZoneSize(node) })),
      servicePads: servicePads.map(pad => ({ ...pad, zoneSize: serviceZoneSize(pad) })), projectiles: [], events: [],
    };
  }

  begin(state: GameState) {
    // Refund old reservations before replacing their wallet; never credit the next match.
    for (const drone of state.drones) { this.cancelService(state, drone); this.cancelLogistics(state, drone); }
    const previous = matchOf(state);
    state.match = this.newMatch(previous.resources, previous.servicePads); state.match.phase = 'active'; state.completed = false;
    for (const drone of state.drones) {
      drone.alive = true; drone.equipment = startingEquipment(); drone.mining = undefined; drone.lastFiredAt = undefined;
      drone.ammo = 0; drone.cameraMode = 'wide'; drone.servicing = undefined;
      drone.gunPurchased = false; drone.cargo = { amount: 0 }; drone.logistics = undefined;
      delete drone.battery; delete drone.charging; drone.jamming = false;
    }
    this.syncInterference(state);
    this.event(state, { type: 'match_started', message: 'Salvage is live. Last team flying wins.' });
  }

  private assertActive(state: GameState, drone: Drone) {
    if (!alive(drone)) throw new Error('This drone is destroyed');
    if (matchOf(state).phase !== 'active') throw new Error('The match is not active');
    if (chargeOf(state, drone) <= 0) throw new Error('No battery charge remains');
    team(drone);
  }

  /** Compatibility acknowledgement; physical pickup is automatic under cargo rules. */
  mine(state: GameState, drone: Drone, _legacyResourceId?: string) {
    this.assertActive(state, drone);
    if (usesCargo(state)) {
      // Compatibility calls cannot probe for hidden stock from arbitrary height.
      // The acknowledgement is identical everywhere; automatic service supplies
      // bounded local interaction feedback on the next simulation sample.
      return { accepted: true, action: 'mine' };
    }
    const node = this.resourceAt(state, drone);
    drone.mining = node?.id;
    if (!node) throw new Error('No accessible salvage in reach; enter a resource zone');
    return { accepted: true, action: 'mine' };
  }

  cancelMining(drone: Drone) { drone.mining = undefined; }

  /** Idempotently release an unfinished pickup; carried salvage is never banked by cancellation. */
  cancelLogistics(state: GameState, drone: Drone, reason: CargoInactiveReason = 'cancelled') {
    const service = drone.logistics;
    if (service?.state === 'loading' && service.sourceId && service.reserved) {
      const node = matchOf(state).resources.find(node => node.id === service.sourceId);
      if (node) node.reserved = Math.max(0, (node.reserved ?? 0) - service.reserved);
    }
    const active = service?.state === 'loading' || service?.state === 'unloading';
    drone.logistics = { state: cargoOf(drone).amount > 0 ? 'carrying' : 'idle', progress: 0, remaining: 0, duration: 0, reason };
    if (active) this.event(state, { type: 'cargo_cancelled', drone: drone.id, team: team(drone), message: `${drone.id} cargo service cancelled.` });
  }

  stop(state: GameState) {
    for (const drone of state.drones) {
      this.cancelService(state, drone); this.cancelLogistics(state, drone, 'stopped');
      this.cancelMining(drone); drone.charging = hasBatteries(matchOf(state).rulesVersion) ? false : undefined;
    }
  }

  buy(state: GameState, drone: Drone, item: EquipmentItem, replace?: EquipmentModule) {
    this.assertActive(state, drone);
    if (!Object.hasOwn(RTS_CONFIG.prices, item)) throw new Error('Unknown attachment');
    if (usesCargo(state) && (item === 'miner' || item === 'miner_upgrade' || item === 'jammer')) throw new Error('This attachment is unavailable under cargo rules');
    if (!hasBatteries(matchOf(state).rulesVersion) && item === 'battery') throw new Error('Batteries are unavailable under current rules');
    const wallet = matchOf(state).teams[team(drone)], price = RTS_CONFIG.prices[item];
    if (!wallet.shopUnlocked) throw new Error('The team shop is unavailable');
    if (!this.friendlyPad(state, drone)) throw new Error('A friendly service pad must be within reach');
    const modules: readonly EquipmentModule[] = usesCargo(state) ? hasBatteries(matchOf(state).rulesVersion) ? CARGO_V1_EQUIPMENT_MODULES : EQUIPMENT_MODULES : LEGACY_EQUIPMENT_MODULES;
    const gear = equipment(drone), isModule = modules.includes(item as EquipmentModule);
    if (replace !== undefined && (!isModule || !modules.includes(replace) || !gear[replace] || replace === item)) {
      throw new Error('Replacement must name a different equipped module');
    }
    if (item === 'miner_upgrade') {
      if (!gear.miner) throw new Error('A mining drill is required');
      if (gear.minerUpgrade) throw new Error('This attachment is already equipped');
    } else if (gear[item]) throw new Error('This attachment is already equipped');
    if (replace === 'cargo' && cargoOf(drone).amount > CARGO_CONFIG.gripCapacity) throw new Error('Deliver excess cargo before removing the cargo module');
    if (isModule && modules.filter(module => gear[module]).length - Number(replace !== undefined) >= RTS_CONFIG.moduleSlots) {
      throw new Error('Both module slots are occupied; choose a module to replace');
    }
    // A successful refit can use its own refunded reservation. Failed validation changes nothing.
    const refund = drone.servicing?.kind === 'recharge' ? 0 : (drone.servicing?.paid ?? 0);
    if (wallet.credits + refund + 1e-9 < price) throw new Error('Insufficient shared team credits');
    // Synchronous validation and debit are one transaction even when peer calls arrive together.
    this.cancelService(state, drone);
    this.cancelLogistics(state, drone, 'refitted');
    wallet.credits = Math.max(0, wallet.credits - price);
    if (replace) {
      gear[replace] = false;
      if (replace === 'gun') { drone.ammo = 0; drone.lastFiredAt = undefined; }
      if (replace === 'miner') gear.minerUpgrade = false;
      if (replace === 'optics') drone.cameraMode = 'wide';
    }
    if (item === 'miner_upgrade') gear.minerUpgrade = true;
    else gear[item] = true;
    if (item === 'gun') {
      drone.ammo = !usesCargo(state) || !drone.gunPurchased ? RTS_CONFIG.magazineSize : 0;
      drone.gunPurchased = true;
    }
    if (hasBatteries(matchOf(state).rulesVersion)) drone.battery = Math.min(chargeOf(state, drone), batteryCapacityFor(drone));
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
    if (!hasBatteries(matchOf(state).rulesVersion)) throw new Error('Recharging is unavailable under current rules');
    const pad = this.friendlyPad(state, drone);
    drone.charging = !!pad;
    if (!pad) throw new Error('A friendly service pad must be within reach');
    return { accepted: true, action: 'recharge', credits: matchOf(state).teams[team(drone)].credits };
  }

  jam(state: GameState, drone: Drone, enabled: boolean) {
    this.assertActive(state, drone);
    if (usesCargo(state)) throw new Error('Jamming is unavailable under cargo rules');
    if (!equipment(drone).jammer) throw new Error('No jammer is attached');
    if (typeof enabled !== 'boolean') throw new Error('Jammer state must be enabled or disabled');
    if (enabled && drone.servicing) throw new Error('The jammer cannot operate during servicing');
    drone.jamming = enabled; this.syncInterference(state);
    return { jamming: drone.jamming };
  }

  /** Only local radio availability is reported; emitter identities and distances stay private. */
  syncInterference(state: GameState) {
    const active = matchOf(state).phase === 'active' && !usesCargo(state);
    for (const drone of state.drones) {
      if (!active || !alive(drone) || !drone.equipment?.jammer || chargeOf(state, drone) <= 0 || drone.servicing) drone.jamming = false;
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
      this.stop(state);
      return [];
    }
    if (!Number.isFinite(dt) || dt <= 0) return [];
    const changed = new Set<DroneId>();
    this.stepDroneContacts(state, previousPositions, changed);
    this.stepBullets(state, dt, previousPositions, changed);
    for (const drone of state.drones) drone.mining = !usesCargo(state) && alive(drone) ? this.resourceAt(state, drone)?.id : undefined;
    this.stepServices(state, dt, previousPositions);
    if (hasBatteries(matchOf(state).rulesVersion)) this.stepEnergy(state, dt, previousPositions, changed);
    if (usesCargo(state)) this.stepLogistics(state, dt, previousPositions);
    else this.stepMining(state, dt);
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
      if (!alive(drone) || chargeOf(state, drone) <= 0 || !equipment(drone).gun || drone.action || moved || !pad || !this.inServiceReach(state, drone, pad)) {
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
      drone.charging = hasBatteries(matchOf(state).rulesVersion) ? false : undefined;
      if (!alive(drone)) continue;
      const before = Math.min(chargeOf(state, drone), batteryCapacityFor(drone));
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

  private logisticsReason(drone: Drone, apron: Point, size: number, speed: number, previous?: Point): CargoInactiveReason | undefined {
    if (!insideApron(drone, apron, size) || previous && !insideApron(previous, apron, size)) return 'outside_apron';
    if (drone.y < apron.y + CARGO_CONFIG.hoverMin || previous && previous.y < apron.y + CARGO_CONFIG.hoverMin) return 'below_hover_band';
    if (drone.y > apron.y + CARGO_CONFIG.hoverMax || previous && previous.y > apron.y + CARGO_CONFIG.hoverMax) return 'above_hover_band';
    if (!Number.isFinite(speed) || speed > CARGO_CONFIG.maxServiceSpeed + 1e-9) return 'moving_too_fast';
    return undefined;
  }

  private stepLogistics(state: GameState, dt: number, previous: ReadonlyMap<DroneId, Point>) {
    const match = matchOf(state);
    const speeds = new Map(state.drones.map(drone => {
      const measured = drone.velocity ? Math.hypot(drone.velocity.x, drone.velocity.y, drone.velocity.z) : 0;
      const swept = previous.has(drone.id) ? distance(previous.get(drone.id)!, drone) / dt : 0;
      return [drone.id, Math.max(measured, swept)];
    }));
    // Release all invalid reservations before admitting new contenders this tick.
    for (const drone of state.drones) {
      if (!alive(drone)) { this.cancelLogistics(state, drone, 'destroyed'); continue; }
      const service = drone.logistics;
      if (!service || service.state !== 'loading' && service.state !== 'unloading') continue;
      const source = service.state === 'loading'
        ? match.resources.find(node => node.id === service.sourceId)
        : match.servicePads?.find(pad => pad.id === service.sourceId && pad.team === team(drone));
      const size = source ? ('team' in source ? serviceZoneSize(source) : resourceZoneSize(source)) : 0;
      const reason = !source ? 'outside_apron' : this.logisticsReason(drone, source, size, speeds.get(drone.id)!, previous.get(drone.id));
      if (reason) this.cancelLogistics(state, drone, reason);
      else if (service.state === 'loading' && cargoOf(drone).amount + (service.reserved ?? 0) > cargoCapacityFor(drone) + 1e-9) {
        this.cancelLogistics(state, drone, 'cargo_full');
      }
    }
    for (const drone of state.drones) {
      if (!alive(drone) || chargeOf(state, drone) <= 0) continue;
      const cargo = cargoOf(drone), speed = speeds.get(drone.id)!;
      let service = drone.logistics;
      if (!service || service.state !== 'loading' && service.state !== 'unloading') {
        const pad = match.servicePads?.find(pad => pad.team === team(drone) && insideApron(drone, pad, serviceZoneSize(pad)));
        const localContact = (node: ResourceNode) => insideApron(drone, node, resourceZoneSize(node))
          && drone.y >= node.y && drone.y <= node.y + CARGO_CONFIG.hoverMax + RTS_CONFIG.droneRadius;
        const node = match.resources.find(node => localContact(node) && node.remaining - (node.reserved ?? 0) > 1e-9)
          ?? match.resources.find(localContact);
        const source = cargo.amount > 0 && pad ? pad : node;
        let reason: CargoInactiveReason | undefined = source
          ? this.logisticsReason(drone, source, 'team' in source ? serviceZoneSize(source) : resourceZoneSize(source), speed, previous.get(drone.id))
          : pad ? 'no_cargo' : 'outside_apron';
        if (!reason && source && !('team' in source)) {
          if (cargo.amount >= cargoCapacityFor(drone) - 1e-9) reason = 'cargo_full';
          else if (source.remaining <= 1e-9) reason = 'stock_empty';
          else if (source.remaining - (source.reserved ?? 0) <= 1e-9) reason = 'stock_reserved';
        }
        if (reason || !source) {
          drone.logistics = { state: cargo.amount > 0 ? 'carrying' : 'idle', progress: 0, remaining: 0, duration: 0, reason };
          continue;
        }
        const unloading = 'team' in source;
        const duration = unloading ? CARGO_CONFIG.deliveryDuration : CARGO_CONFIG.pickupDuration;
        const reserved = unloading ? undefined : Math.min(cargoCapacityFor(drone) - cargo.amount, source.remaining - (source.reserved ?? 0));
        if (!unloading) source.reserved = (source.reserved ?? 0) + reserved!;
        service = drone.logistics = { state: unloading ? 'unloading' : 'loading', sourceId: source.id,
          progress: 0, remaining: duration, duration, ...(reserved === undefined ? {} : { reserved }) };
        this.event(state, { type: unloading ? 'cargo_unloading' : 'cargo_loading', team: team(drone), drone: drone.id,
          message: `${drone.id} began ${unloading ? 'unloading' : 'loading'} cargo.` });
      }
      service.remaining = Math.max(0, service.remaining - dt);
      service.progress = 1 - service.remaining / service.duration;
      if (service.remaining > 1e-9) continue;
      if (service.state === 'loading') {
        const node = match.resources.find(node => node.id === service.sourceId)!;
        const amount = service.reserved ?? 0;
        node.reserved = Math.max(0, (node.reserved ?? 0) - amount);
        node.remaining = Math.max(0, node.remaining - amount);
        cargo.amount += amount;
        this.event(state, { type: 'cargo_loaded', drone: drone.id, team: team(drone), message: `${drone.id} picked up ${amount} salvage.` });
        if (node.remaining <= 1e-9) this.event(state, { type: 'resource_depleted', target: node.id, ...position(node), message: 'A salvage depot was exhausted.' });
      } else {
        const amount = cargo.amount, wallet = match.teams[team(drone)];
        cargo.amount = 0; wallet.credits += amount; wallet.earned += amount;
        this.event(state, { type: 'cargo_delivered', drone: drone.id, team: team(drone), message: `${drone.id} delivered ${amount} salvage.` });
      }
      drone.logistics = { state: cargo.amount > 0 ? 'carrying' : 'idle', progress: 1, remaining: 0, duration: service.duration };
    }
  }

  private dropCargo(state: GameState, drone: Drone, crash: Point) {
    const amount = cargoOf(drone).amount;
    if (amount <= 0) return;
    cargoOf(drone).amount = 0;
    const match = matchOf(state), size = CARGO_CONFIG.droppedApronSize;
    // A payload falls vertically from its actual crash position. A wall impact,
    // water, narrow roof or blocked landing footprint loses it; never relocate it.
    const fall = terrainContact({ ...crash, y: Math.max(crash.y, RTS_CONFIG.droneRadius + 0.001) },
      { ...crash, y: -1 }, state.obstacles, RTS_CONFIG.droneRadius);
    const surface = fall && fall.normal.y > 0.99 ? { x: crash.x, y: fall.contact.y - RTS_CONFIG.droneRadius, z: crash.z } : undefined;
    const inPolygon = (point: CityPoint, ring: CityPoint[]) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a.z > point.z) !== (b.z > point.z) && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
      }
      return inside;
    };
    const samples = surface && [-0.5, 0, 0.5].flatMap(x => [-0.5, 0, 0.5].map(z => ({ ...surface, x: surface.x + x * size, z: surface.z + z * size })));
    const obstructed = surface && state.obstacles.some(building => {
      const bottom = building.baseY ?? 0, top = bottom + building.height;
      if (top < surface.y + CARGO_CONFIG.hoverMin - RTS_CONFIG.droneRadius
        || bottom > surface.y + CARGO_CONFIG.hoverMax + RTS_CONFIG.droneRadius) return false;
      const angle = (building.rotation ?? 0) * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
      const x = building.x - surface.x, z = building.z - surface.z;
      const half = size / 2 + RTS_CONFIG.droneRadius, width = building.width / 2, depth = building.depth / 2;
      // Four separating axes cover the complete marked footprint, including thin
      // rotated obstacles between the support samples below.
      return Math.abs(x) <= half + width * Math.abs(c) + depth * Math.abs(s)
        && Math.abs(z) <= half + width * Math.abs(s) + depth * Math.abs(c)
        && Math.abs(x * c - z * s) <= width + half * (Math.abs(c) + Math.abs(s))
        && Math.abs(x * s + z * c) <= depth + half * (Math.abs(c) + Math.abs(s));
    });
    const valid = !obstructed && samples && samples.every(point => point.x >= CITY.bounds.x[0] && point.x <= CITY.bounds.x[1]
      && point.z >= CITY.bounds.z[0] && point.z <= CITY.bounds.z[1]
      && !(point.y <= 0 && inPolygon(point, CITY.river) && !CITY.riverHoles.some(ring => inPolygon(point, ring)))
      && !terrainContact({ ...point, y: point.y + CARGO_CONFIG.hoverMin }, { ...point, y: point.y + CARGO_CONFIG.hoverMax }, state.obstacles, RTS_CONFIG.droneRadius)
      && Math.abs((terrainContact({ ...point, y: point.y + 0.01 }, { ...point, y: -1 }, state.obstacles, 0)?.contact.y ?? -Infinity) - point.y) < 0.02);
    if (valid && surface) {
      match.resources.push({ ...surface, id: `dropped-${randomUUID()}`, kind: 'dropped', zoneSize: size, capacity: amount, remaining: amount, reserved: 0 });
      this.event(state, { type: 'cargo_dropped', drone: drone.id, team: team(drone), ...surface, message: `${drone.id} dropped ${amount} salvage.` });
    } else {
      match.salvageLost = (match.salvageLost ?? 0) + amount;
      this.event(state, { type: 'cargo_lost', drone: drone.id, team: team(drone), message: `${drone.id} lost ${amount} unbanked salvage.` });
    }
    drone.logistics = { state: 'idle', progress: 0, remaining: 0, duration: 0, reason: 'destroyed' };
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
    this.cancelService(state, drone); this.cancelLogistics(state, drone); this.cancelMining(drone); drone.action = undefined;
    drone.jamming = false; drone.charging = hasBatteries(matchOf(state).rulesVersion) ? false : undefined;
    if (cause !== 'power' && equipment(drone).armor) {
      equipment(drone).armor = false; drone.status = cause === 'bullet' ? 'Hit detected. Armor lost.' : 'Collision detected. Armor lost.';
      this.syncInterference(state);
      this.event(state, { type: 'armor_consumed', cause, projectileId, team: team(drone), drone: drone.id, target: source, ...position(impact ?? drone), message: `${drone.id}: ${drone.status}` });
    } else {
      drone.alive = false; drone.online = false; drone.status = 'Destroyed'; drone.ammo = 0;
      if (usesCargo(state)) this.dropCargo(state, drone, cause === 'terrain' && impact ? impact : drone);
      this.syncInterference(state);
      this.event(state, { type: 'destroyed', cause, projectileId, team: team(drone), drone: drone.id, target: source, ...position(impact ?? drone), message: `${drone.id} was destroyed by ${cause}.` });
    }
  }

  private resolveVictory(state: GameState) {
    const survivors = new Set(state.drones.filter(alive).map(team));
    if (survivors.size > 1) return;
    const match = matchOf(state);
    match.phase = 'finished'; match.winner = survivors.size ? [...survivors][0] : 'draw'; state.completed = true;
    for (const drone of state.drones) { this.cancelService(state, drone); this.cancelLogistics(state, drone, 'stopped'); drone.mining = undefined; drone.action = undefined; drone.jamming = false; drone.charging = hasBatteries(matchOf(state).rulesVersion) ? false : undefined; }
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
