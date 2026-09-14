/** Developer-only arrangements and objectives; never imported by production gameplay. */
import type { FleetGame } from '../server/game.ts';

export const SCENARIOS = ['flight', 'aim-stationary', 'aim-moving', 'match'] as const;
export type TrialScenario = typeof SCENARIOS[number];

export function arrangeTrial(game: FleetGame, scenario: TrialScenario) {
  if (scenario === 'match') return { fixture: false, description: 'Unmodified production opening and missions.' };
  if (scenario === 'flight') {
    const mission = 'This is a flight practice trial. Practice controlled turns, short moves, stopping and hovering. Compare your own observations before and after each experiment. Then try navigating along a visible street or open corridor while avoiding contact with terrain, buildings and other drones. Choose your own route and share useful measurements with teammates. Do not gather resources or attack during this trial.';
    game.queueMission(mission, 'blue'); game.queueMission(mission, 'red');
    return { fixture: false, description: 'Production opening; flight-only operator objective.', missions: { blue: mission, red: mission } };
  }
  // Three spaced, initially visible pairs above the city. This is an aiming fixture,
  // not evidence of resource discovery, purchase decisions or enemy acquisition.
  for (const [index, drone] of game.state.drones.entries()) {
    const blue = drone.team === 'blue';
    Object.assign(drone, { x: -45 + (index % 3) * 20, y: 30, z: blue ? 40 : 26,
      yaw: blue ? 8 : 180, pitch: 0 });
    drone.equipment = { gun: blue, armor: false, miner: false };
  }
  const blue = 'This is an aiming practice trial. Use your attached gun to engage enemy drones that you can see. Hold your position while testing camera aim and firing. Learn from successive camera observations and share useful findings with teammates. Avoid friendly fire. Do not mine or buy during this trial.';
  const red = scenario === 'aim-stationary'
    ? 'This is a stationary target practice trial. Hold your starting position. You may look and observe, but do not travel, mine, buy or fire. Continue waiting and observing until stopped or destroyed.'
    : 'This is a moving target practice trial. Choose two nearby positions from your own observations and repeatedly fly back and forth between them. Avoid contact with terrain, buildings and other drones. Do not mine, buy or fire. Continue moving and observing until stopped or destroyed.';
  game.queueMission(blue, 'blue'); game.queueMission(red, 'red');
  return { fixture: true, description: 'Three visible pairs; blue receives fixture guns, red receives a target-motion objective. No geometry or calibration is sent to agents.',
    missions: { blue, red }, initialDrones: structuredClone(game.state.drones) };
}
