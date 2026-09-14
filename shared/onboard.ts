import type { Point } from './rts.ts';

/** Public vehicle/application contract. No battlefield configuration belongs here. */
export const ONBOARD_PROFILE = Object.freeze({
  version: 'onboard/1', simulationUnitsPerMeter: 0.1, metersPerSimulationUnit: 10,
  frame: 'local-east-up-south', units: 'simulation-units',
  maxBatchOperations: 8, maxRouteSteps: 32, maxActiveRoutines: 1,
  velocityLeaseMs: 500, sensorMaxAgeMs: 150,
  storage: Object.freeze({ runtime: 8 * 1024 ** 2, workspace: 2 * 1024 ** 2,
    mail: 4 * 1024 ** 2, staging: 1024 ** 2, logs: 1024 ** 2 }),
  maxFileBytes: 64 * 1024, maxFiles: 256, optionalLibraryBytes: 256 * 1024,
});
export type MovementProfile = 'travel' | 'precision';
export type JobState = 'accepted' | 'running' | 'blocked' | 'completed' | 'cancelled' | 'failed';
export interface ObservationOrigin { observationSequence?: number; eventCursor?: number }
export interface DroneJob {
  id: string; kind: 'movement' | 'route' | 'routine'; state: JobState; mission: number;
  step?: number; totalSteps?: number; reason?: string; origin?: ObservationOrigin;
  startedAt?: number; updatedAt?: number; sourceHash?: string; sourcePath?: string;
}
export interface RouteSubmission {
  waypoints: Point[]; profile: MovementProfile; mission: number; origin?: ObservationOrigin;
}
export interface StoragePartitionUsage { usedBytes: number; limitBytes: number; freeBytes: number }
export type DroneStorage = Record<string, StoragePartitionUsage>;
