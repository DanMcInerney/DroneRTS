import type { DroneId } from './fleet.ts';

export type TeamId = 'blue' | 'red';
export const EQUIPMENT_MODULES = ['gun', 'miner', 'optics', 'battery', 'jammer'] as const;
export type EquipmentModule = typeof EQUIPMENT_MODULES[number];
export type EquipmentItem = EquipmentModule | 'armor' | 'miner_upgrade';
export interface Equipment { gun: boolean; armor: boolean; miner: boolean; optics?: boolean; minerUpgrade?: boolean; battery?: boolean; jammer?: boolean }
export type CameraMode = 'wide' | 'zoom';
export interface Point { x: number; y: number; z: number }
/** XYZ is the ground-level center of the cube's bottom face. */
export interface ResourceNode extends Point { id: string; remaining: number; capacity: number; extractionMultiplier?: number; zoneSize?: number }
export interface ServicePad extends Point { id: string; team: TeamId; zoneSize?: number }
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
  phase: 'ready' | 'active' | 'finished'; winner: TeamId | 'draw' | null;
  teams: Record<TeamId, TeamEconomy>; resources: ResourceNode[]; projectiles: Projectile[]; events: MatchEvent[];
  servicePads?: ServicePad[];
}

/** Simulator/player calibration. Item prices and own equipment receipts are allowed interaction feedback. */
export const RTS_CONFIG = Object.freeze({
  startingCredits: 30, moduleSlots: 2,
  prices: Object.freeze({ gun: 30, armor: 20, miner: 30, optics: 30, miner_upgrade: 60, battery: 30, jammer: 45 }),
  miningRate: 0.5, minerRate: 1, upgradedMinerRate: 1.5,
  magazineSize: 12, rearmCost: 10, serviceDuration: 8,
  resourceZoneSize: 6, serviceZoneSize: 6,
  batteryCapacity: 300, extendedBatteryCapacity: 600, lowBatteryFraction: 0.2,
  idleDrain: 0.9, movingDrain: 0.1, miningDrain: 0.15, jammerDrain: 0.8,
  rechargeDuration: 12, jammerRange: 18,
  droneRadius: 0.38, bulletRadius: 0.055, bulletSpeed: 32,
  bulletGravity: 2.4, bulletLifetime: 4, fireCooldown: 0.8,
});

export const emptyEquipment = (): Equipment => ({ gun: false, armor: false, miner: false, optics: false, minerUpgrade: false, battery: false, jammer: false });
export const startingEquipment = (): Equipment => ({ ...emptyEquipment(), armor: true });
export const batteryCapacityFor = (drone: { equipment?: Equipment }): number => drone.equipment?.battery ? RTS_CONFIG.extendedBatteryCapacity : RTS_CONFIG.batteryCapacity;

export const resourceZoneSize = (node: ResourceNode): number => node.zoneSize ?? RTS_CONFIG.resourceZoneSize;
export const serviceZoneSize = (pad: ServicePad): number => pad.zoneSize ?? RTS_CONFIG.serviceZoneSize;
/** Visible volume and interaction volume share these exact bounds. */
export function insideZone(point: Point, zone: Point, size: number): boolean {
  const half = size / 2;
  return Math.abs(point.x - zone.x) <= half && Math.abs(point.z - zone.z) <= half
    && point.y >= zone.y && point.y <= zone.y + size;
}
