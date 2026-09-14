export const DRONE_IDS = ['drone-1', 'drone-2', 'drone-3'] as const;
export type DroneId = typeof DRONE_IDS[number];
export type Role = 'parent' | DroneId;
export interface Pose { x: number; y: number; z: number; yaw: number; pitch: number }
export interface Action { id: string; kind: string; target?: { x: number; y: number; z: number } }
export interface Drone extends Pose {
  id: DroneId; status: string; action?: Action; online: boolean; observations: number;
}
export interface Obstacle { id?: string; name?: string; color?: string; x: number; z: number; width: number; depth: number; height: number; rotation?: number; baseY?: number }
export interface Treasure { id: string; x: number; y: number; z: number; found: boolean; foundBy?: DroneId; foundAt?: number }
export interface RadioMessage {
  expiresAt?: string;
  protocol: 'fleet-radio/1'; sessionId: string; sequence: number; sentAt: string;
  id: string; from: string; to: string; kind: string; text: string;
  simTime: number; mission: number; data?: Record<string, unknown>;
}
export interface RuntimeState {
  status: string; message: string; model: string; effort: string;
  threadId?: string; children?: unknown; usage?: unknown; [key: string]: unknown;
}
export interface GameState {
  simTime: number; mission: number; running: boolean; speed: number; completed: boolean;
  treasures: Treasure[]; obstacles: Obstacle[]; drones: Drone[]; radio: RadioMessage[]; runtime: RuntimeState;
  network?: NetworkState;
}
export interface NetworkState {
  pendingMissions?: number;
  status: 'offline' | 'starting' | 'online' | 'error'; transport: 'zenoh-tcp'; vehicle: 'mavlink2-udp'; message: string;
  peers: Array<{ id: DroneId; online: boolean; peers: number; pending: number; inbox: number }>;
}
export interface GameEvent { cursor: number; type: string; mission: number; [key: string]: unknown }
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}
