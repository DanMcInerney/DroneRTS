import { fleetMember, MATCH_FLEET, teamForDrone, type DroneId } from '../shared/fleet';

/** Shared visual identity for feeds, radio, map markers, meshes and diagnostics. */
export function dronePresentation(id: string) {
  const member = fleetMember(id as DroneId, MATCH_FLEET);
  const suffix = id.match(/^drone-(\d+)$/)?.[1];
  const hash = [...id].reduce((value, character) => (value * 31 + character.charCodeAt(0)) >>> 0, 0);
  return {
    team: member ? teamForDrone(member.id) : undefined,
    label: member?.label ?? (suffix ? `Drone ${suffix}` : id),
    shortLabel: member ? member.label.replace('Blue ', 'B').replace('Red ', 'R') : suffix?.padStart(2, '0') ?? id,
    color: member?.color ?? `hsl(${hash % 360}, 65%, 74%)`,
  };
}
