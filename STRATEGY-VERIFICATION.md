# Strategic economy milestone 1 verification

Verified September 14, 2026 in the working tree based on `d4a11e5b46a84c02be37a9766bbd3e8980e8b9d5`. These results apply to the implemented first milestone in [STRATEGY-PLAN.md](STRATEGY-PLAN.md), not its later roadmap. No live model inference was launched.

## Implemented behavior

Both teams start with 30 shared salvage and zero mined income. Gun, drill and optics cost 30; armor costs 20. Every starting purchase leaves too little for a second item. Drones have two module slots and separate one-hit armor. Physical friendly service pads support purchases, explicit module replacement without refunds, and timed ammunition resupply.

All five deposits are outside every initial camera view. Four outer deposits hold 150 salvage each; the central Fountain Square deposit holds 900 and extracts at 1.5 times the normal rate. Bare mining, drill mining and upgraded drilling yield 0.5, 1 and 1.5 salvage per simulation second before the deposit multiplier. Deposits remain finite, with competing miners sharing the available remainder fairly.

Guns hold 12 rounds. Rearming reserves 10 salvage and requires eight uninterrupted simulation seconds at a friendly pad; cancellation refunds once. Optics change the actual camera projection. The private resource-evidence check and replay observation metadata retain the acquisition-time projection, including when equipment or mode changes while an image is pending. Player map markers, service-pad coordinates and optical calibration stay outside actor observations.

## Checks and evidence

| Check | Result |
| --- | --- |
| `npm test` | 190 tests passed, including real Zenoh and MAVLink integration. |
| `node --import tsx --test tests/replay-store.test.ts` | 16 tests passed after adding acquisition-time FOV persistence to the recorder regression. |
| `npm run build` | TypeScript and Vite production build passed. Existing large-bundle advisory remains. |
| `node --import tsx scripts/measure-controls.ts` | 34 prescribed control/ballistic fixtures passed; 50 ms and 200 ms caller ticks retained matching final positions, survival and event outcomes. |
| `FLEET_QA_PORT=4319 node --import tsx scripts/verify-rts.ts` | Passed: six actual cameras, exactly one opening purchase, wide/zoom image changes, earning/purchasing/refitting, ammo exhaustion, cancelled/completed rearm, physical projectile victory, spectator map updates, God/Admin capture isolation, mobile layout and reset. |
| `FLEET_QA_PORT=4319 node --import tsx scripts/verify-replay.ts` | Passed with 244 records: live append, scrub/playback/event seeking, six actors, shot/impact correlation, byte-exact camera images, replay/live isolation, missing/legacy evidence and responsive layout; no browser errors. |

The environment used Node 24.15.0 and the Python 3.14.6 interpreter selected by `network:setup`; the native helper integration tests passed in this environment. Python dependencies are isolated in the ignored `.venv`.

Local evidence, intentionally excluded from Git:

- `artifacts/control-measurements/2026-09-14T14-43-34.773Z/summary.json` and `trajectories.json`.
- `artifacts/rts-ui/result.json`, six initial camera images, wide/zoom images, and screenshots of optics, rearming, the service map, victory and mobile layout.
- `artifacts/replay-ui/result.json` and `store-5753bfa4-57e8-457e-becb-3847e4f7de21/`.
- `artifacts/strategy-verification/source-manifest.json`, containing the final source-file hashes and base revision.

The production opening was also inspected visually in the Codex sidebar browser. Deterministic fixture screenshots were inspected directly, including the actual zoom image, rearming presentation, map markers and phone replay controls. The map renders only while visible; verification scrolls it into view before asserting its current markers.

Port 4317 was unavailable before testing. Another checkout owned an idle server on 4318, so these browser fixtures used an owned isolated server on 4319. The temporary browser tab and 4319 server were closed afterward. Port 4318 remained idle at simulation time zero and was preserved.

## What remains unproven

These fixtures validate rules, transactions, physics, transport integration and presentation. They do not establish autonomous resource discovery under the new opening, scout usefulness, coordinated central-deposit fights, competitive balance or reliable match completion. Historical live matches in [RTS-PLAYTEST.md](RTS-PLAYTEST.md) used older economies and are not evidence for this revision. The next gameplay evaluation should use bounded Luna/xhigh matches and analyze their saved evidence before changing prices or claiming emergent strategy.

Battery endurance, active radio interference, payload droppers and replacement airframes remain deferred as described in the plan.
