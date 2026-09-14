# Communication trial and starting armor — September 14, 2026

The new communication briefing was used in the normal-opening match launched at 16:28 UTC. Blue won at **145.283 simulation seconds** because all three red drones flew into buildings. No drone fired, neither team mined salvage, and no runtime or transport failure was recorded. This run does not demonstrate successful combat or an expanding economy.

The evidence does not indicate a regression in XYZ precision. Each fatal waypoint used integer coordinates, and each decoded MAVLink target exactly matched the request. The recorded paths crossed actual collision geometry. The earlier precision work added decimal guidance, three-decimal player readouts and a native fractional-motion test; it did not change the flight controller, movement scale or MAVLink coordinate conversion.

## Recorded collisions

| Drone | Time | Obstacle | Requested waypoint | Target rounding error |
| --- | ---: | --- | --- | ---: |
| Red 3 (`drone-6`) | 125.465 s | Great American Tower base | (38, 4, 18) | 0 |
| Red 1 (`drone-4`) | 130.966 s | Great American Tower crown | (39, 20, 20) | 0 |
| Red 2 (`drone-5`) | 145.283 s | Building `osm-28719685` | (24, 10, 12) | 0 |

These are developer coordinates, not information delivered to gameplay agents. The last command-to-collision intervals were approximately 0.495, 3.361 and 1.709 seconds. Their last delivered pre-command cameras were approximately 5.563, 8.198 and 13.565 seconds old when those commands were issued. The controller executes a straight waypoint flight and does not plan around buildings. Coordinate precision cannot make an obstructed route safe.

The actual pre-command images were inspected. Red 3's view showed a nearby facade occupying much of the image and a yellow cube farther along the street. Red 1's view was mostly sky and distant rooftops. Red 2's downward view showed the street, a yellow cube and adjacent roofs. These images support the recorded observation context; they do not establish what the models understood.

## Communication and economy

The run recorded **109 delivered camera images**, no missing images, and **14 peer messages**. The preceding minimal-briefing run sent 15 messages over 401.867 seconds. Communication was more frequent in this sample, but these two different-duration runs cannot establish a reliable improvement rate.

There was a concrete direct exchange: Red 1 requested a resource position and Red 3 replied with estimated coordinates and uncertainty. Blue drones also discussed resource sightings and mining intentions. Shared spending was still poorly coordinated: multiple red drones announced gun purchases, one succeeded, and two were rejected for insufficient team funds. Each team ultimately bought one gun. No mining happened before the early finish.

## Implemented follow-up

- Every fresh, reset or relaunched match grants each of the six drones one free armor charge, with both module slots empty. Team wallets still start at 30 salvage; the armor grant does not spend or earn credits.
- One collision consumes armor, stops the active movement and emits local `armor_lost` feedback: **Collision detected. Armor lost.** The existing deflection moves the drone clear of the contact.
- A bullet can consume the same charge, producing **Hit detected. Armor lost.** Alerts include a local timestamp but no attacker, obstacle identity, target locator or impact coordinates. They reach the drone through its normal fresh tool/event bundle.
- A second unprotected impact remains lethal. Replacement armor costs 20 salvage at a friendly cube. Empty batteries remain fatal despite armor.
- The briefing and player rules explain starting protection and its feedback. They add no navigation tactics or automatic pathfinding.

## Verification and limits

All three recorded fatal approaches were reproduced as deterministic fixtures against the actual city geometry. With starting armor, each survived its first collision, lost exactly one charge, received one local alert, cancelled its waypoint and retained no drifting velocity. Issuing the same obstructed waypoint again was fatal. Additional checks covered fresh/reset/relaunch equipment, independent armor per drone, unchanged wallets and bullet-versus-collision feedback.

The focused set covered **135 game, damage, service, endurance, runtime and replay checks**. Initial failures included stale expectations from the earlier five-minute battery change; those were corrected without changing battery behavior. The final set passed across the focused run and the replay-test rerun. The separate native MAVLink fractional-XYZ regression passed all six signed 0.01/0.05 movement steps, including continuous motion, exact decoded arrival, returned telemetry and no settling drift. TypeScript and the production build passed with the existing bundle-size advisory. The full suite and browser playtest were not rerun.

This is simulator verification of the new starting protection, not evidence that an autonomous drone learned from its collision. No new inference match was launched after the armor change.

## Evidence

Local trial directory: `artifacts/focused-trials/2026-09-14T16-28-13-099Z-match/`.

Trial source-manifest SHA-256: `bca706441b7309161fbb095b7bde4913f977cc932502ab447e7643d983202032`.

The original `result.json`, audit and replay were preserved. `scripts/analyze-trial.ts` and `scripts/analyze-engagement.ts` produced `analysis.json` and `engagement-analysis.json` before the armor implementation changed the source. `collision-analysis.json` records each last waypoint, decoded target, previous pose, colliding building and pre-command camera reference. Analysis against that historical revision must use its recorded calibration; the new armor code postdates the trial.

The trial ended naturally with complete cleanup. Its owned port-4319 server and gameplay actors/helpers stopped; the other checkout's idle port-4318 service was preserved.
