import type { DroneId, ToolResult } from './types.ts';

export type CockpitToolEvidence =
  | { type: 'call'; role: DroneId | 'parent'; name: string; arguments: Record<string, unknown> }
  | { type: 'delivery'; role: DroneId | 'parent'; name: string; result: ToolResult };

/** Player-only evidence. Never import this contract into actor instructions or tools. */
export interface CockpitCall {
  sequence: number; name: string; arguments: Record<string, unknown>; startedAt: string;
}
export interface CockpitDelivery {
  sequence: number; receivedAt: string; tool: string; isError: boolean;
  bundle: Record<string, unknown> | null; result: ToolResult; omissions: string[];
}
export interface CockpitImage {
  sequence: number; deliverySequence: number; url: string; mimeType: string;
  receivedAt: string; capturedAt: string | null; simTime: number | null;
}
export interface CockpitEvent {
  sequence: number; at: string; kind: 'call' | 'result' | 'output' | 'summary' | 'reasoning' | 'reasoning-status' | 'lifecycle';
  name?: string; text?: string; itemId?: string; delta?: boolean; streaming?: boolean; data?: unknown;
}
export interface CockpitWorkspaceEntry { path: string; bytes: number; sha256: string; version: number; metadataBytes: number }
export interface CockpitWorkspaceFile extends CockpitWorkspaceEntry {
  droneId: DroneId; sessionId: string; content: string; omissions: string[];
}
export interface CockpitWorkspaceState {
  available: boolean; reason: string; entries: CockpitWorkspaceEntry[];
  storage?: Record<string, { usedBytes: number; limitBytes: number; freeBytes: number }>;
  retainedVersions?: number;
}
export interface CockpitWorkspace extends CockpitWorkspaceState {
  tools: string[];
  compute: { model: string; effort: string; sandbox: string; shell: boolean; filesystem: boolean; web: boolean;
    codeExecution: boolean; hostFilesystem: boolean; executionEngine: string; filesystemScope: string;
    heapBytes: number; cpuMsPerSecond: number; maxRoutineMs: number };
  libraries: Array<{ name: string; purpose: string; access: 'host only' | 'guest' }>;
  optionalGuestLibraries: string[];
  limits: { fileBytes: number; files: number; workspaceBytes: number; optionalLibraryBytes: number };
}
export interface CockpitSnapshot {
  protocol: 'fleet-cockpit/1'; droneId: DroneId; sessionId: string | null;
  cursor: number; reset: boolean; truncated: boolean; running: boolean; serverTime: string;
  lastDelivery: CockpitDelivery | null; lastImage: CockpitImage | null; lastCall: CockpitCall | null;
  events: CockpitEvent[]; workspace: CockpitWorkspace;
}
