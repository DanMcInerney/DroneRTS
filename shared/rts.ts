import type { DroneId } from './fleet.ts';

export type TeamId = 'blue' | 'red';
export const EQUIPMENT_MODULES = ['gun', 'cargo', 'optics'] as const;
export const CARGO_V1_EQUIPMENT_MODULES = ['gun', 'cargo', 'optics', 'battery'] as const;
/** Retained only for interpreting recordings and explicitly historical rules fixtures. */
export const LEGACY_EQUIPMENT_MODULES = ['gun', 'miner', 'optics', 'battery', 'jammer'] as const;
export type EquipmentModule = typeof EQUIPMENT_MODULES[number] | typeof LEGACY_EQUIPMENT_MODULES[number];
export type EquipmentItem = EquipmentModule | 'armor' | 'miner_upgrade';
export interface Equipment { gun: boolean; armor: boolean; miner: boolean; cargo?: boolean; optics?: boolean; minerUpgrade?: boolean; battery?: boolean; jammer?: boolean }
export type CameraMode = 'wide' | 'zoom';
export interface Point { x: number; y: number; z: number }
/** XYZ is the apron surface center. Remaining includes stock reserved by incomplete loads. */
export interface ResourceNode extends Point { id: string; remaining: number; capacity: number; reserved?: number; kind?: 'cache' | 'dropped'; extractionMultiplier?: number; zoneSize?: number }
export interface ServicePad extends Point { id: string; team: TeamId; zoneSize?: number }
export interface CargoState { amount: number }
export type CargoInactiveReason = 'outside_apron' | 'above_hover_band' | 'below_hover_band' | 'moving_too_fast'
  | 'cargo_full' | 'stock_empty' | 'stock_reserved' | 'no_cargo' | 'cancelled' | 'destroyed' | 'stopped' | 'refitted'
  | 'objective-replaced' | 'movement-replaced';
/** sourceId/reserved are authoritative internals and must be omitted from actor feedback. */
export interface CargoServiceState {
  state: 'idle' | 'loading' | 'carrying' | 'unloading'; progress: number; remaining: number; duration: number;
  reason?: CargoInactiveReason; sourceId?: string; reserved?: number;
}
export interface ServiceAction { kind?: 'rearm' | 'recharge'; padId: string; remaining: number; paid: number }
export interface TeamEconomy { credits: number; earned: number; shopUnlocked: boolean }
export interface Projectile extends Point {
  id: string; owner: DroneId; team: TeamId; vx: number; vy: number; vz: number; age: number;
}
export interface MatchEvent extends Partial<Point> {
  id: string; type: string; simTime: number; team?: TeamId; drone?: DroneId; target?: string; message: string;
  projectileId?: string; cause?: 'terrain' | 'ram' | 'bullet' | 'expired' | 'power';
}
export interface MatchState {
  rulesVersion?: 'cube-v1' | 'cargo-v1' | 'cargo-v2'; salvageLost?: number;
  phase: 'ready' | 'active' | 'finished'; winner: TeamId | 'draw' | null;
  teams: Record<TeamId, TeamEconomy>; resources: ResourceNode[]; projectiles: Projectile[]; events: MatchEvent[];
  servicePads?: ServicePad[];
}

/** Simulator/player calibration. Item prices and own equipment receipts are allowed interaction feedback. */
export const RTS_CONFIG = Object.freeze({
  startingCredits: 30, moduleSlots: 2,
  prices: Object.freeze({ gun: 30, armor: 20, cargo: 30, miner: 30, optics: 30, miner_upgrade: 60, battery: 30, jammer: 45 }),
  miningRate: 0.5, minerRate: 1, upgradedMinerRate: 1.5,
  magazineSize: 12, rearmCost: 10, serviceDuration: 8,
  resourceZoneSize: 6, serviceZoneSize: 6,
  // Historical battery rules only; cargo-v2 has no energy simulation.
  batteryCapacity: 300, extendedBatteryCapacity: 600, lowBatteryFraction: 0.2,
  idleDrain: 0.9, movingDrain: 0.1, miningDrain: 0.15, jammerDrain: 0.8,
  rechargeDuration: 12, jammerRange: 18,
  droneRadius: 0.38, bulletRadius: 0.055, bulletSpeed: 32,
  bulletGravity: 2.4, bulletLifetime: 4, fireCooldown: 0.8,
});

export const emptyEquipment = (): Equipment => ({ gun: false, armor: false, cargo: false, miner: false, optics: false, minerUpgrade: false, battery: false, jammer: false });
export const startingEquipment = (): Equipment => ({ gun: false, armor: true, cargo: false, miner: false, optics: false, minerUpgrade: false, jammer: false });
export const isCargoRules = (version?: string): boolean => version === 'cargo-v1' || version === 'cargo-v2';
export const hasBatteries = (version?: string): boolean => version !== 'cargo-v2';
export const batteryCapacityFor = (drone: { equipment?: Equipment }): number => drone.equipment?.battery ? RTS_CONFIG.extendedBatteryCapacity : RTS_CONFIG.batteryCapacity;

/** Shared vehicle/apron calibration; lengths and speeds are simulator units and units/second. */
export const CARGO_CONFIG = Object.freeze({
  crateValue: 30, gripCapacity: 30, moduleCapacity: 60,
  pickupDuration: 3, deliveryDuration: 2, hoverMin: 0.6, hoverMax: 2.4,
  maxServiceSpeed: 0.3, loadedSpeedMultiplier: 0.8, droppedApronSize: 1.6,
});
export const cargoCapacityFor = (drone: { equipment?: Equipment }): number => drone.equipment?.cargo ? CARGO_CONFIG.moduleCapacity : CARGO_CONFIG.gripCapacity;
/** Three separated loading marks, identical for simulation fixtures and rendering. */
export const apronServicePositions = (apron: Point, size: number): Point[] =>
  [[-0.32, -0.25], [0.32, -0.25], [0, 0.32]].map(([x, z]) => ({
    x: apron.x + x * size, y: apron.y + (CARGO_CONFIG.hoverMin + CARGO_CONFIG.hoverMax) / 2, z: apron.z + z * size,
  }));
export function insideApron(point: Point, apron: Point, size: number): boolean {
  return Math.abs(point.x - apron.x) <= size / 2 && Math.abs(point.z - apron.z) <= size / 2;
}

export const resourceZoneSize = (node: ResourceNode): number => node.zoneSize ?? RTS_CONFIG.resourceZoneSize;
export const serviceZoneSize = (pad: ServicePad): number => pad.zoneSize ?? RTS_CONFIG.serviceZoneSize;
/** Visible volume and interaction volume share these exact bounds. */
export function insideZone(point: Point, zone: Point, size: number): boolean {
  const half = size / 2;
  return Math.abs(point.x - zone.x) <= half && Math.abs(point.z - zone.z) <= half
    && point.y >= zone.y && point.y <= zone.y + size;
}
