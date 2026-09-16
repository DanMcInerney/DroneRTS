/** Developer-only arrangements and objectives; never imported by production gameplay. */
import type { FleetGame } from '../server/game.ts';
import { RTS_CONFIG } from '../shared/rts.ts';

export const SCENARIOS = ['attention', 'haul-single', 'haul-team', 'flight', 'aim-stationary', 'aim-moving', 'encounter', 'encounter-reversed', 'match'] as const;
export type TrialScenario = typeof SCENARIOS[number];

export function arrangeTrial(game: FleetGame, scenario: TrialScenario) {
  if (scenario === 'attention') {
    const mission = 'This is a bounded controller and sensor qualification trial. Stay at your starting position; do not travel, buy, gather or attack. Observe your own camera and local feedback, answer actual teammate messages and wait between updates. Report new local notices or uncertain possible-shot observations to your teammates, including what you can see in the fresh camera image. The trial may supply synthetic local sound measurements; they do not establish an attacker or require a maneuver.';
    game.queueMission(mission, 'blue'); game.queueMission(mission, 'red');
    return { fixture: true, description: 'Six native pilots and production camera/geometry; stationary protocol qualification with explicitly synthetic local evidence, not an acoustic physics or autonomy claim.', missions: { blue: mission, red: mission } };
  }
  if (scenario === 'match') return { fixture: false, description: 'Unmodified production opening and missions.' };
  if (scenario === 'haul-single' || scenario === 'haul-team') {
    const blue = scenario === 'haul-single'
      ? 'This is a bounded physical hauling trial. For this trial only, drone-1 should discover salvage, pick it up and deliver it to a friendly base while staying alive. Repeat the collection and delivery if time permits. Drone-2 and drone-3 should remain at their starting positions, keep observing and answer actual peer messages; do not leave, buy, gather or attack. The active drone chooses its own observations, route, equipment and methods. Do not attack during this trial.'
      : 'This is a bounded team hauling trial. Your team should discover finite salvage, carry it to your friendly base and deliver useful shared income while keeping each other alive. Coordinate through actual radio messages and choose your own plans, equipment and methods. Do not attack during this trial.';
    const red = 'This is a bounded hauling evaluation for the other team. Remain at your starting positions, observe and wait. Do not leave, buy, gather or attack during this trial.';
    game.queueMission(blue, 'blue'); game.queueMission(red, 'red');
    return { fixture: true, description: scenario === 'haul-single'
      ? 'Production geometry, stock and loadouts with six clean-context actors; explicit trial objectives designate one blue hauler and five stationary actors. No resource coordinates, routes, grant, recognition helper or solved routine is supplied.'
      : 'Production geometry, stock and loadouts with six clean-context actors; blue chooses its own logistics and red receives a stationary trial objective. No resource coordinates, routes, grants or solved routines are supplied.',
      missions: { blue, red }, initialDrones: structuredClone(game.state.drones) };
  }
  if (scenario === 'flight') {
    const mission = 'This is a flight practice trial. Practice controlled turns, short moves, stopping and hovering. Compare your own observations before and after each experiment. Then try navigating along a visible street or open corridor while avoiding contact with terrain, buildings and other drones. Choose your own route and share useful measurements with teammates. Do not gather resources or attack during this trial.';
    game.queueMission(mission, 'blue'); game.queueMission(mission, 'red');
    return { fixture: false, description: 'Production opening; flight-only operator objective.', missions: { blue: mission, red: mission } };
  }
  // Three spaced, initially visible pairs above the city. These fixtures do not
  // establish resource discovery, purchase decisions or enemy acquisition.
  const encounter = scenario === 'encounter' || scenario === 'encounter-reversed';
  for (const [index, drone] of game.state.drones.entries()) {
    const blue = drone.team === 'blue';
    const north = scenario === 'encounter-reversed' ? blue : !blue;
    Object.assign(drone, { x: -45 + (index % 3) * 20, y: 30, z: north ? 26 : 40,
      yaw: (north ? 180 : 0) + (encounter || blue ? 8 : 0), pitch: 0 });
    drone.equipment = { gun: blue || encounter, armor: false, miner: false };
    drone.ammo = drone.equipment.gun ? RTS_CONFIG.magazineSize : 0;
  }
  if (encounter) {
    const mission = 'This is a combat encounter trial. Eliminate the opposing team while keeping your team alive. Use your attached gun, choose your own movement and aim, and coordinate with teammates using what you observe. Avoid contact with terrain, buildings and other drones, and avoid friendly fire. Do not mine or buy during this trial.';
    game.queueMission(mission, 'blue'); game.queueMission(mission, 'red');
    return { fixture: true, description: 'Three initially visible opposing pairs; both teams receive guns, equal camera offsets and the same combat objective. Movement and aiming are autonomous. No geometry or calibration is sent to agents.',
      missions: { blue: mission, red: mission }, initialDrones: structuredClone(game.state.drones) };
  }
  const blue = 'This is an aiming practice trial. Use your attached gun to engage enemy drones that you can see. Hold your position while testing camera aim and firing. Learn from successive camera observations and share useful findings with teammates. Avoid friendly fire. Do not mine or buy during this trial.';
  const red = scenario === 'aim-stationary'
    ? 'This is a stationary target practice trial. Hold your starting position. You may look and observe, but do not travel, mine, buy or fire. Continue waiting and observing until stopped or destroyed.'
    : 'This is a moving target practice trial. Choose two nearby positions from your own observations and repeatedly fly back and forth between them. Avoid contact with terrain, buildings and other drones. Do not mine, buy or fire. Continue moving and observing until stopped or destroyed.';
  game.queueMission(blue, 'blue'); game.queueMission(red, 'red');
  return { fixture: true, description: 'Three visible pairs; blue receives fixture guns, red receives a target-motion objective. No geometry or calibration is sent to agents.',
    missions: { blue, red }, initialDrones: structuredClone(game.state.drones) };
}
