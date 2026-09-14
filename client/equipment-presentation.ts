import type { Drone } from './types';
import { batteryCapacityFor, EQUIPMENT_MODULES, RTS_CONFIG, type MatchState, type ServiceAction } from '../shared/rts';

/** Player presentation only. Missing historical telemetry stays unknown. */
export function batteryPresentation(drone: Drone, recordedCapacity?: number) {
  if (drone.battery === undefined || !Number.isFinite(drone.battery)) return;
  const capacity = recordedCapacity ?? batteryCapacityFor(drone), charge = Math.max(0, Math.min(capacity, drone.battery));
  const fraction = charge / capacity;
  return { charge, capacity, percent: Math.round(fraction * 100), low: fraction <= RTS_CONFIG.lowBatteryFraction };
}

export function servicePresentation(service?: ServiceAction) {
  if (!service) return;
  const charging = service.kind === 'recharge';
  const duration = charging ? RTS_CONFIG.rechargeDuration : RTS_CONFIG.serviceDuration;
  const remaining = Math.max(0, service.remaining);
  return { label: charging ? 'Charging' : 'Rearming', remaining, progress: Math.max(0, Math.min(1, 1 - remaining / duration)) };
}

export const equippedModuleCount = (drone: Drone) => EQUIPMENT_MODULES.filter(item => drone.equipment?.[item]).length;

export function chargingPresentation(drone: Drone, battery = batteryPresentation(drone)) {
  if (drone.alive === false || drone.charging !== true) return;
  return { label: battery && battery.charge >= battery.capacity ? 'CHARGED' : battery ? `AUTOCHARGING · ${battery.percent}%` : 'AUTOCHARGING', progress: battery?.percent };
}

/** Replays report the saved fields without guessing absent battery/radio state. */
export function recordedOperations(drone: Drone, match?: Pick<MatchState, 'resources' | 'servicePads'>): string[] {
  // Explicit recorded cube sizes mark the revision that increased capacity.
  // Earlier records used 100/150 charge; do not reinterpret them with live tuning.
  const modern = match?.resources.some(node => node.zoneSize !== undefined) || match?.servicePads?.some(pad => pad.zoneSize !== undefined);
  const battery = batteryPresentation(drone, modern ? undefined : drone.equipment?.battery ? 150 : 100), service = servicePresentation(drone.servicing);
  const charging = chargingPresentation(drone, battery);
  return [
    drone.ammo !== undefined ? `${drone.ammo} rounds` : '',
    drone.cameraMode ? `Camera ${drone.cameraMode}` : '',
    battery ? `Battery ${battery.percent}%${battery.low ? ' · LOW' : ''}` : '',
    charging?.label ?? '',
    service ? `${service.label} · ${service.remaining.toFixed(1)}s remaining` : '',
    drone.jamming !== undefined ? `Jammer ${drone.jamming ? 'on' : 'off'}` : '',
    drone.radioJammed !== undefined ? drone.radioJammed ? 'Radio jammed' : 'Radio clear' : '',
  ].filter(Boolean);
}
