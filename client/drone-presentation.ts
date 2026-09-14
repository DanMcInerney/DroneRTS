import { fleetMember, type DroneId } from '../shared/fleet';

/** Shared visual identity for feeds, radio, map markers, meshes and diagnostics. */
export function dronePresentation(id: string) {
  const member = fleetMember(id as DroneId);
  const suffix = id.match(/^drone-(\d+)$/)?.[1];
  const hash = [...id].reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 0);
  return {
    label: member?.label ?? (suffix ? `Drone ${suffix}` : id),
    shortLabel: suffix?.padStart(2, '0') ?? id,
    color: member?.color ?? `hsl(${hash % 360}, 65%, 74%)`,
  };
}
