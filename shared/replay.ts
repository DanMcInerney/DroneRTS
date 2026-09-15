import type { Drone, DroneId, Obstacle, Pose, RadioMessage } from './types';
import type { CityPoint, CityRoad } from './city';
import type { MatchEvent, MatchState } from './rts';
import type { FleetMember } from './fleet';

/** Player-only recorded evidence. Never import this contract into actor tools/prompts. */
export interface ReplayHeader {
  type: 'header'; protocol: 'fleet-replay/1'; startedAt: string; sampleInterval: number;
  /** Absent in historical recordings; never apply current rules to those frames. */
  rulesVersion?: string;
  rendererId?: string;
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
/** Immutable UTF-8 source evidence. The viewer displays this as text and never evaluates it. */
export interface ReplayScriptSource {
  type: 'script-source'; simTime: number; drone: DroneId; path: string;
  version: string | number; sourceHash: string; sourceBytes: number; source?: string; omission?: string;
}
export interface ReplayExecution {
  type: 'execution'; simTime: number; drone: DroneId; jobId?: string; sourceHash?: string;
  operation: string; args: Record<string, unknown>; outcome: unknown; error?: string;
}
export interface ReplayCancellation {
  type: 'cancellation'; simTime: number; drone: DroneId; jobId: string; reason: string; sourceHash?: string;
}
export interface ReplayRadio { type: 'radio'; simTime: number; message: RadioMessage }
export interface ReplayEnd {
  type: 'end'; simTime: number; reason: 'stopped' | 'limit' | 'error';
  message?: string; omittedImages: number;
}
export type ReplayRecord = ReplayHeader | ReplayFrame | ReplayCommand | ReplayObservation | ReplayCombatEvent | ReplayEnd | ReplayScriptSource | ReplayExecution | ReplayCancellation | ReplayRadio;
export interface ReplayPage {
  available: boolean; records: ReplayRecord[]; next: number; hasMore: boolean; bytes: number;
  summary?: ReplaySummary;
}
export interface ReplaySummary {
  simTime: number; coveredThrough: number; survivors: string[]; winner: string | null;
  blueCredits: number; redCredits: number; blueDelivered: number; redDelivered: number;
  stock: number; aboard: number; lost: number; shots: number;
}

/** Internal acquisition event; persisted only by the separate bounded replay recorder. */
export interface RecordedObservation {
  drone: DroneId; pose: Pose; simTime: number; capturedAt: string; mission: number;
  cameraFov?: number;
  image?: { mimeType: string; data: string };
}
