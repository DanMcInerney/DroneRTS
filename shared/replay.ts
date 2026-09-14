import type { Drone, DroneId, Obstacle, Pose } from './types';
import type { CityPoint, CityRoad } from './city';
import type { MatchEvent, MatchState } from './rts';
import type { FleetMember } from './fleet';

/** Player-only recorded evidence. Never import this contract into actor tools/prompts. */
export interface ReplayHeader {
  type: 'header'; protocol: 'fleet-replay/1'; startedAt: string; sampleInterval: number;
  roster: readonly FleetMember[];
  scene: { name: string; bounds: { x: [number, number]; z: [number, number] };
    focus: { x: [number, number]; z: [number, number] }; obstacles: Obstacle[];
    roads: CityRoad[]; river: CityPoint[] };
  camera: { width: number; height: number };
}
export interface ReplayFrame {
  type: 'frame'; simTime: number; drones: Drone[];
  match?: Omit<MatchState, 'events'>;
}
export interface ReplayCommand {
  type: 'command'; simTime: number; drone: DroneId; name: string; args: Record<string, unknown>;
}
export interface ReplayObservation {
  type: 'observation'; simTime: number; drone: DroneId; pose: Pose; capturedAt: string; mission: number;
  cameraFov?: number;
  imageId?: string; imageAvailable: boolean; omission?: string;
}
export interface ReplayCombatEvent { type: 'event'; simTime: number; event: MatchEvent }
export interface ReplayEnd {
  type: 'end'; simTime: number; reason: 'stopped' | 'limit' | 'error';
  message?: string; omittedImages: number;
}
export type ReplayRecord = ReplayHeader | ReplayFrame | ReplayCommand | ReplayObservation | ReplayCombatEvent | ReplayEnd;
export interface ReplayPage {
  available: boolean; records: ReplayRecord[]; next: number; hasMore: boolean; bytes: number;
}

/** Internal acquisition event; persisted only by the separate bounded replay recorder. */
export interface RecordedObservation {
  drone: DroneId; pose: Pose; simTime: number; capturedAt: string; mission: number;
  cameraFov?: number;
  image?: { mimeType: string; data: string };
}
