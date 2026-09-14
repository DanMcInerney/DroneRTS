import type { DroneId } from './fleet.ts';

export type TeamId = 'blue' | 'red';
export type EquipmentItem = 'gun' | 'armor' | 'miner';
export interface Equipment { gun: boolean; armor: boolean; miner: boolean }
export interface Point { x: number; y: number; z: number }
export interface ResourceNode extends Point { id: string; remaining: number; capacity: number }
export interface TeamEconomy { credits: number; earned: number; shopUnlocked: boolean }
export interface Projectile extends Point {
  id: string; owner: DroneId; team: TeamId; vx: number; vy: number; vz: number; age: number;
}
export interface MatchEvent extends Partial<Point> {
  id: string; type: string; simTime: number; team?: TeamId; drone?: DroneId; target?: string; message: string;
}
export interface MatchState {
  phase: 'ready' | 'active' | 'finished'; winner: TeamId | 'draw' | null;
  teams: Record<TeamId, TeamEconomy>; resources: ResourceNode[]; projectiles: Projectile[]; events: MatchEvent[];
}

/** Simulator/player calibration. Only attachment prices are revealed, after the shop unlocks. */
export const RTS_CONFIG = Object.freeze({
  prices: Object.freeze({ gun: 20, armor: 12, miner: 16 }),
  miningRate: 1, minerRate: 3, miningRange: 2.6,
  droneRadius: 0.38, bulletRadius: 0.055, bulletSpeed: 32,
  bulletGravity: 2.4, bulletLifetime: 4, fireCooldown: 0.8,
});

export const emptyEquipment = (): Equipment => ({ gun: false, armor: false, miner: false });
