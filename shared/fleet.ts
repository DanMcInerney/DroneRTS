import type { TeamId } from './rts.ts';
export type { TeamId } from './rts.ts';
/** Fleet membership is configuration, never inferred from array order or ID suffixes. */
export type DroneId = `drone-${number}`;
export interface FleetMember {
  readonly id: DroneId;
  readonly label: string;
  readonly color: string;
  readonly systemId: number;
}
export type FleetRoster = readonly FleetMember[];

/** Validate once at each process boundary and retain an immutable configuration. */
export function validateRoster(input: unknown): FleetRoster {
  if (!Array.isArray(input) || !input.length || input.length > 254) throw new Error('Fleet roster must contain 1–254 members');
  const ids = new Set<string>(), systems = new Set<number>();
  const members = input.map(value => {
    if (!value || typeof value !== 'object') throw new Error('Invalid fleet member');
    const { id, label, color, systemId } = value;
    if (typeof id !== 'string' || !/^drone-[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id.slice(6))) || ids.has(id)) throw new Error('Fleet drone identities must be distinct positive drone numbers');
    if (!Number.isInteger(systemId) || systemId < 1 || systemId > 254 || systems.has(systemId)) throw new Error('Fleet MAVLink system IDs must be distinct integers from 1 to 254');
    if (typeof label !== 'string' || !label.trim() || label.length > 80 || typeof color !== 'string' || !/^#[\da-f]{6}$/i.test(color)) throw new Error('Fleet members require a label and hex color');
    ids.add(id); systems.add(systemId);
    return Object.freeze({ id: id as DroneId, label, color, systemId });
  });
  return Object.freeze(members);
}

// Each team has exactly three equal actors and its own radio domain.
export const DEFAULT_FLEET = validateRoster([
  { id: 'drone-1', label: 'Blue 1', color: '#63d9ff', systemId: 1 },
  { id: 'drone-2', label: 'Blue 2', color: '#63d9ff', systemId: 2 },
  { id: 'drone-3', label: 'Blue 3', color: '#63d9ff', systemId: 3 },
]);
export const ENEMY_FLEET = validateRoster([
  { id: 'drone-4', label: 'Red 1', color: '#ff746f', systemId: 4 },
  { id: 'drone-5', label: 'Red 2', color: '#ff746f', systemId: 5 },
  { id: 'drone-6', label: 'Red 3', color: '#ff746f', systemId: 6 },
]);
export const MATCH_FLEET = validateRoster([...DEFAULT_FLEET, ...ENEMY_FLEET]);
export const MATCH_DRONE_IDS = Object.freeze(MATCH_FLEET.map(member => member.id));
export function teamRoster(team: TeamId): FleetRoster { return team === 'blue' ? DEFAULT_FLEET : ENEMY_FLEET; }
export function teamForDrone(id: DroneId): TeamId {
  if (DEFAULT_FLEET.some(member => member.id === id)) return 'blue';
  if (ENEMY_FLEET.some(member => member.id === id)) return 'red';
  throw new Error('Unknown match drone');
}
export const DRONE_IDS: readonly DroneId[] = Object.freeze(DEFAULT_FLEET.map(member => member.id));
export function fleetMember(id: unknown, roster: FleetRoster = DEFAULT_FLEET): FleetMember | undefined {
  return roster.find(member => member.id === id);
}
export function isDroneId(value: unknown, roster: FleetRoster = DEFAULT_FLEET): value is DroneId {
  return fleetMember(value, roster) !== undefined;
}
export function droneAgentType(id: DroneId): string { return id.replace('-', '_'); }
export function droneIdFromAgentType(value: unknown, roster: FleetRoster = DEFAULT_FLEET): DroneId | undefined {
  return roster.find(member => droneAgentType(member.id) === value)?.id;
}
