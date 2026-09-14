import type { ReplayCommand, ReplayCombatEvent, ReplayEnd, ReplayFrame, ReplayHeader, ReplayObservation, ReplayRecord } from '../shared/replay';
import type { DroneId } from '../shared/types';

type Timed = Exclude<ReplayRecord, ReplayHeader>;
export type ReplayMoment = ReplayCombatEvent | ReplayCommand;
export interface ReplaySample {
  time: number; frame?: ReplayFrame; observation?: ReplayObservation;
  events: ReplayCombatEvent[]; moments: ReplayMoment[];
  metrics: { shots: number; hits: number; deaths: number; terrain: number; ram: number; bullet: number; unknown: number; salvage: number };
}

/** Indexes evidence by acquisition/simulation time, never by the order disk writes finish. */
export class ReplayTimeline {
  header?: ReplayHeader;
  end?: ReplayEnd;
  records: Timed[] = [];
  frames: ReplayFrame[] = [];
  moments: ReplayMoment[] = [];
  observations = new Map<DroneId, ReplayObservation[]>();
  get start() { return this.frames[0]?.simTime ?? this.records[0]?.simTime ?? 0; }
  get finish() { return this.records.at(-1)?.simTime ?? 0; }
  get count() { return this.records.length + (this.header ? 1 : 0); }

  append(records: readonly ReplayRecord[]) {
    for (const record of records) {
      if (record.type === 'header') this.header ??= record;
      else if (Number.isFinite(record.simTime)) this.records.push(record);
    }
    // Stable sorting preserves the recorder's order for events at the same instant.
    this.records.sort((a, b) => a.simTime - b.simTime);
    this.frames = []; this.moments = []; this.observations.clear();
    for (const record of this.records) {
      if (record.type === 'frame') this.frames.push(record);
      if (record.type === 'event' || record.type === 'command') this.moments.push(record);
      if (record.type === 'end') this.end = record;
      if (record.type === 'observation') {
        const list = this.observations.get(record.drone) ?? [];
        list.push(record); this.observations.set(record.drone, list);
      }
    }
  }

  sample(time: number, actor?: DroneId): ReplaySample {
    const frame = atOrBefore(this.frames, time), observation = actor ? atOrBefore(this.observations.get(actor) ?? [], time) : undefined;
    const moments = this.moments.filter(record => record.simTime <= time);
    const events = moments.filter((record): record is ReplayCombatEvent => record.type === 'event');
    const metrics = { shots: 0, hits: 0, deaths: 0, terrain: 0, ram: 0, bullet: 0, unknown: 0, salvage: 0 };
    for (const { event } of events) {
      if (event.type === 'fired') metrics.shots++;
      if (event.type === 'impact' && event.target) metrics.hits++;
      if (event.type === 'destroyed') {
        metrics.deaths++;
        // Accept historical recordings that predate the structured cause field.
        const cause = (event.cause !== 'expired' ? event.cause : undefined) ?? event.message.match(/destroyed by (terrain|ram|bullet)\./)?.[1] as 'terrain' | 'ram' | 'bullet' | undefined;
        metrics[cause ?? 'unknown']++;
      }
    }
    metrics.salvage = Object.values(frame?.match?.teams ?? {}).reduce((sum, team) => sum + team.earned, 0);
    return { time, frame, observation, events, moments, metrics };
  }

  window(time: number, duration = 8) {
    const from = lowerBound(this.frames, time - duration), until = upperBound(this.frames, time);
    return this.frames.slice(from, until);
  }

  adjacent(time: number, direction: -1 | 1) {
    if (direction > 0) return this.moments[upperBound(this.moments, time)]?.simTime;
    return this.moments[lowerBound(this.moments, time) - 1]?.simTime;
  }
}

function lowerBound<T extends { simTime: number }>(items: readonly T[], time: number) {
  let low = 0, high = items.length;
  while (low < high) { const mid = (low + high) >>> 1; if (items[mid].simTime < time) low = mid + 1; else high = mid; }
  return low;
}
function upperBound<T extends { simTime: number }>(items: readonly T[], time: number) {
  let low = 0, high = items.length;
  while (low < high) { const mid = (low + high) >>> 1; if (items[mid].simTime <= time) low = mid + 1; else high = mid; }
  return low;
}
function atOrBefore<T extends { simTime: number }>(items: readonly T[], time: number) { return items[upperBound(items, time) - 1]; }

/** Audit records have multiple schemas; only an explicitly recorded simTime is seekable. */
export function auditReplayTime(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.simTime === 'number' && Number.isFinite(record.simTime)) return record.simTime;
  for (const key of ['value', 'event', 'message', 'payload']) {
    const nested = record[key];
    if (nested && typeof nested === 'object' && 'simTime' in nested && typeof nested.simTime === 'number' && Number.isFinite(nested.simTime)) return nested.simTime;
  }
}
