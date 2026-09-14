# Automatic cube zones — September 14, 2026

The user replaced the earlier manual mining and timed charging design with simple physical volumes. This change supersedes the close-range camera-evidence repair proposed after the prior live matches. Those reports retain their historical scope.

## Implemented behavior

- Every resource is a grounded, translucent yellow **6×6×6 cube**. Its visible and active bounds use the same shared geometry. A living drone whose center is inside automatically extracts salvage, including while moving, looking away or firing. No camera evidence or `mine` call is required. Three drones fit in separate positions; finite income and proportional sharing on depletion remain enforced. The cube stays full size until empty, then disappears.
- Service areas are grounded translucent team-colored cubes of the same size. Being inside your own team's cube supplies power and restores **25 charge/second**. Leaving retains charge already gained. Charging is independent of movement, messaging, jamming and timed rearming. Enemy cubes do not charge or permit purchases. The optional `mine`/`recharge` compatibility tools acknowledge occupancy without stopping flight.
- Base battery capacity is **300**, three times the previous 100. The battery pack supplies **600**, twice the new base. Activity drain rates stay unchanged. Normal continuous movement consumes 0.3/second, giving approximately **16:40** of flight or **33:20** with the pack; hovering lasts longer, mining/jamming shorten those figures. Equipping a pack supplies capacity without creating charge. Power exhaustion remains fatal.
- Cube positions moved into fully clear, dry street spaces. They retain four outer deposits of 150 and a central downtown deposit of 900 at 1.5× extraction. All resources require exploration from the opening cameras. The mega cube is near Main/Fifth, east of its former Fountain Square position. Its street routes remain asymmetric, approximately 95 units from blue and 60 from red; these checks do not establish competitive balance.
- XYZ already supported decimals through the entire controller/MAVLink path. No physical rescaling or actuator change was needed. The UI now shows three decimals, and native integration verifies ±0.01/±0.05 adjustments on every axis, continuous intermediate motion, precise decoded arrival, fresh telemetry and no subsequent drift.
- Actors receive only own mining/charging booleans and local entry/exit/full-charge events alongside existing feedback. Cube appearance and automatic behavior are explained; locations, dimensions, map, motion calibration and hidden enemy state remain private. Replay records preserve explicit zone sizes and charging flags. Older recordings retain their earlier geometry and battery interpretation.

## Verification

| Check | Result |
| --- | --- |
| Full `npm test` | **251 passed**, including real Zenoh/MAVLink integration and the new fractional-movement test. Output: `artifacts/cube-zones-tests-final.txt`. |
| `npm run build` | TypeScript and production bundle passed; existing bundle-size advisory remains. Output: `artifacts/cube-zones-build.txt`. |
| `scripts/measure-controls.ts` | **34 fixtures passed**, with equal outcomes and final positions for 50 ms and 200 ms caller ticks. Evidence: `artifacts/control-measurements/2026-09-14T15-54-11.817Z/`. |
| `scripts/verify-rts.ts` | Actual browser cameras passed automatic three-drone mining and charging, retained partial charge, exit/return, purchases/refitting, timed rearm cancellation/refunds, physical combat, interference, responsive UI and reset. No browser errors. |
| `scripts/verify-replay.ts` | **635 records**, exact acquired image bytes, explicit cube bounds, charging true/false, concurrent mining/charging/rearming, interference, seeking, combat, legacy/missing evidence and responsive layouts. No browser errors or replay warnings. |

The browser scripts used `FLEET_QA_PORT=4319` and separate output directories: `artifacts/cube-zones-ui/` and `artifacts/cube-zones-replay-ui/`. Both result files record `inference: false`. Local camera images show the yellow and blue cubes from inside and outside; the actual production opening was also inspected in the Codex sidebar browser. The replay store is `store-a4a0678d-6d62-4613-9720-362268a35615/`.

The browser fixtures deliberately arrange drones and some equipment/charge states to isolate behavior. They prove that entering the volumes works mechanically; they do not measure autonomous navigation, collision avoidance, economic strategy or win rates. No model gameplay inference was launched for this change.

The owned 4319 QA server and temporary browser were stopped after verification. The other checkout's server on 4318 was preserved idle at simulation time zero; player port 4317 was unavailable. Raw artifacts remain local and excluded from Git. The final source manifest is saved in `artifacts/cube-zones-verification/source-manifest.json`.
