import type { Drone } from './types';
import { cargoCapacityFor } from '../shared/rts';

/** Spectator summaries use only authoritative fields and preserve absent historical state. */
export function onboardPresentation(drone: Drone) {
  const cargo = drone.cargo;
  const logistics = drone.logistics;
  const active = drone.alive !== false && logistics && ['loading', 'unloading'].includes(logistics.state);
  return {
    cargo: cargo ? `CARGO ${cargo.amount.toFixed(0)} / ${cargoCapacityFor(drone)}` : undefined,
    logistics: logistics ? `${logistics.state.toUpperCase()}${active ? ` · ${Math.round(logistics.progress * 100)}% · ${logistics.remaining.toFixed(1)}s` : ''}${logistics.reason ? ` · ${logistics.reason.replaceAll('_', ' ')}` : ''}` : undefined,
    progress: active ? Math.max(0, Math.min(1, logistics.progress)) : undefined,
    job: drone.job ? `${drone.job.kind.toUpperCase()} · ${drone.job.state.toUpperCase()}${drone.job.step !== undefined ? ` · ${drone.job.step + 1}/${drone.job.totalSteps ?? '?'}` : ''}${drone.job.reason ? ` · ${drone.job.reason}` : ''}` : undefined,
    source: drone.job?.sourceHash ? `${drone.job.sourcePath ?? 'Routine'} · SHA256 ${drone.job.sourceHash.slice(0, 12)}` : undefined,
    storage: drone.storage ? Object.entries(drone.storage).filter((entry): entry is [string, { usedBytes: number; limitBytes: number; freeBytes: number }] => {
      const value = entry[1]; return Boolean(value && typeof value === 'object' && 'usedBytes' in value && 'limitBytes' in value);
    }).map(([name, partition]) => `${name}: ${formatBytes(partition.usedBytes)} / ${formatBytes(partition.limitBytes)}`).join(' · ') : undefined,
  };
}

export function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`;
}
