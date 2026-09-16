/** Isolated production-camera smoke pixels; no agents, server state or inference. */
import type { FleetScene } from '../client/scene';
import type { WorldState } from '../client/types';
import { projectileSmoke, projectileTrails } from '../client/projectile-trail-model';
import { wreckDisplayTime } from '../client/wreck-model';
import { RTS_CONFIG, type MatchEvent, type MatchState } from '../shared/rts';

export function projectileTrailFixture(fleet: FleetScene, source: WorldState) {
  if (!source.match) throw new Error('Projectile fixture requires a match snapshot');
  const state = structuredClone(source), match = state.match!;
  state.running = false; state.speed = 1; state.simTime = 12;
  state.obstacles = [{ id: 'projectile-background', x: 0, z: -4, width: 30, depth: 1, height: 12 }];
  state.drones.forEach(drone => { drone.alive = false; });
  match.rulesVersion = 'cargo-v3'; match.resources = []; match.servicePads = []; match.projectiles = []; match.events = []; match.wrecks = [];
  const absent = structuredClone(match), shots: Record<string, string> = {}, segments: Record<string, number> = {};
  const pose = { x: 0, y: 8, z: 12, yaw: 0, pitch: 0 };
  const fired: MatchEvent = { id: 'fixture-fire', type: 'fired', projectileId: 'fixture-shot', simTime: 10, x: -8, y: 8, z: 0, message: '' };
  const position = (age: number) => ({ x: -8 + 32 * age, y: 8 - RTS_CONFIG.bulletGravity * age * age / 2, z: 0 });
  const active = (age: number): MatchState => ({ ...structuredClone(absent), events: [fired],
    projectiles: [{ id: 'fixture-shot', owner: 'drone-1', team: 'blue', ...position(age), vx: 32, vy: -RTS_CONFIG.bulletGravity * age, vz: 0, age }] });
  const impact: MatchEvent = { id: 'fixture-impact', type: 'impact', projectileId: 'fixture-shot', simTime: 10.5, ...position(.5), message: '' };
  match.events = [fired, impact]; fleet.update(state);
  const acquire = (name: string, snapshot: MatchState, time: number) => {
    shots[`projectile-${name}`] = fleet.capture('drone-1', pose, state.drones, snapshot, time);
    segments[name] = projectileTrails(snapshot, time).flatMap(trail => projectileSmoke(trail, time)).length;
  };
  acquire('absent', absent, 9);
  acquire('before', match, 9);
  acquire('active', active(.25), 10.25);
  acquire('impact', match, 10.5);
  acquire('fading', match, 13);
  acquire('gone', match, 16.2);
  acquire('past-repeat', active(.25), 10.25);
  const trajectory = projectileTrails(match, 10.5)[0], endpoint = projectileSmoke(trajectory, trajectory.endedAt).at(-1)!.end;
  const endpointError = Math.hypot(endpoint.x - impact.x!, endpoint.y - impact.y!, endpoint.z - impact.z!);
  const expired = { ...structuredClone(match), events: [fired, { ...impact, type: 'projectile_expired' }] };
  acquire('expired', expired, 10.5);
  const legacy = { ...match, rulesVersion: 'cargo-v2' as const }; acquire('legacy', legacy, 10.5);
  state.obstacles.push({ id: 'projectile-cover', x: 0, z: 6, width: 30, depth: 1, height: 12 }); fleet.update(state);
  acquire('occluded', match, 10.5); acquire('occluded-absent', absent, 10.5);
  state.obstacles.pop(); fleet.update(state);
  match.phase = 'finished'; state.simTime = 10.5; fleet.update(state);
  const victoryTime = wreckDisplayTime(state, 2.5); acquire('victory-tail', match, victoryTime);
  const stopped = { ...state, match: { ...match, phase: 'active' as const } };
  const frozenTime = wreckDisplayTime(stopped, 2.5); acquire('stopped', stopped.match, frozenTime);
  const times: number[] = [];
  for (let index = 0; index < 12; index++) {
    const begin = performance.now(); fleet.capture('drone-1', pose, state.drones, match, 10.5 + index / 30);
    if (index >= 2) times.push(performance.now() - begin);
  }
  state.match = structuredClone(absent); state.simTime = 0; fleet.update(state); acquire('reset', state.match, 0);
  return { shots, segments, endpointError, victoryTime, frozenTime, captureMs: times.sort((a, b) => a - b) };
}
