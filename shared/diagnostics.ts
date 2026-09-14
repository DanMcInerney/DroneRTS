import type { GameState, RuntimeState } from './types';

/** Read-only player diagnostics contract, independent of the agent tool surface. */
export const DIAGNOSTIC_CATEGORIES = [
  ['all', 'All events'], ['network', 'Peer radio'], ['mavlink', 'MAVLink'],
  ['agents', 'Agent activity'], ['tools', 'Tool calls'], ['sensors', 'Observations'],
  ['system', 'System'], ['errors', 'Errors'],
] as const;
export type DiagnosticCategory = typeof DIAGNOSTIC_CATEGORIES[number][0];
export interface DiagnosticEvent {
  offset: number; wallTime: string; type: string; category: DiagnosticCategory;
  role: string; title: string; value: unknown;
}
export interface DiagnosticPage {
  events: DiagnosticEvent[]; next: number; before: number; hasOlder: boolean;
  hasMore: boolean; bytes: number; skipped: number; scannedBytes: number;
  limits: { maxReadBytes: number; maxRecordBytes: number };
}
export interface DiagnosticSession { id: string; bytes: number; updatedAt: string }
export interface DiagnosticStatus {
  serverTime: string; activeSession: string | null; running: boolean; simTime: number; mission: number;
  runtime: RuntimeState; network?: GameState['network'];
  drones: Array<Pick<GameState['drones'][number], 'id' | 'online' | 'status' | 'observations'>>;
}
