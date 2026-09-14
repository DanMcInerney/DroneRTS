# Endurance and radio interference verification

Milestone 2 of [STRATEGY-PLAN.md](STRATEGY-PLAN.md) was implemented and verified on September 14, 2026 in the working tree based on `d4a11e5b46a84c02be37a9766bbd3e8980e8b9d5`. This follows the earlier economy milestone; the earlier reports retain their own tested scope. No gameplay model inference was launched.

## Resulting rules

- Every drone starts with 100 battery charge. A 30-salvage battery module increases capacity to 150 and consumes a module slot, without granting charge. Removing it caps stored charge at 100.
- Hovering consumes 0.2 charge per simulation second, with 0.1 added for actual translation, 0.15 for active mining and 0.8 for an enabled jammer. Pausing simulation pauses drain. A local warning fires when charge crosses 20%; empty charge causes a fatal power-loss crash even with armor.
- Free charging at a friendly service pad restores full capacity after 12 uninterrupted seconds. Charging and rearming use one service slot. Valid servicing uses pad power; interruption grants no partial charge. Rearm cancellation still refunds its reservation exactly once.
- A 45-salvage jammer module interrupts nearby native peer-radio sessions, including the emitter and friendly drones. Multiple sources combine. Cameras, local flight control and private reasoning continue. Native queued messages retain their existing expiry and deduplication behavior.
- One serialized transport reconciler combines interference, manual isolation, retirement and destruction. Clearing interference cannot override another reason for disconnection. Link failures remain explicit. Native transition latency and already-delivered packets are preserved, rather than presenting instantaneous physical RF behavior.
- Tools expose only own charge/capacity, service and jammer/interference feedback outside the unchanged four sensor fields. No source identities, affected roster, radius or locator is supplied. UI and replays show battery, charging, interference and power-loss outcomes; missing historical state remains unknown.

## Verification

| Check | Result |
| --- | --- |
| `npm test` | **242 passed**, zero failures, including real Zenoh and MAVLink helpers. Full output: `artifacts/endurance-tests-final.txt`. |
| Rules and game tests | Covered capacity/refit transactions, activity drain, pause, warning thresholds, service timing/interruption, armor-bypassing power loss, simultaneous final losses, mission/Stop/reset and revoked tools. |
| Native radio integration | Actual jammer tools disconnected self/friendly/enemy Zenoh sessions. Sender, recipient and operator queues resumed exactly once within their own team domains. Unit tests also covered overlapping requests, reconnection races, manual isolation, retirement, failure and startup/shutdown. |
| `node --import tsx scripts/measure-controls.ts` | **34 fixtures passed**; 17 scenarios at 50 ms and 200 ms caller ticks retained matching survival/events and identical final positions. |
| Deterministic RTS browser fixture | Passed opening/economy/zoom/ammo/rearm/physical victory plus larger battery without free charge, cancelled/completed charging, friendly/enemy interference, real camera images while jammed, armor-independent power loss, responsive UI and reset. |
| Deterministic replay browser fixture | Passed with **381 records**, including saved battery/charging/interference, exact delivered image bytes, seek/playback/events, live/replay isolation, missing/legacy evidence and responsive UI. No browser errors. |
| `npm run build` | TypeScript and Vite production build passed. The existing large-bundle advisory remains. |

The browser commands used `FLEET_QA_PORT=4319` and separate `FLEET_QA_OUTPUT` directories so earlier local evidence stayed intact. Their local evidence is in `artifacts/endurance-ui/` and `artifacts/endurance-replay-ui/`, including `result.json` files and inspected screenshots. The completed replay is in `store-b1a979f5-e2d5-4193-9ac7-613741475ec7/`. Control evidence is in `artifacts/control-measurements/2026-09-14T15-08-45.695Z/`. A final source manifest is saved under `artifacts/endurance-verification/source-manifest.json`. Artifacts remain intentionally excluded from Git.

The production opening was inspected in the Codex sidebar browser. Charging, mobile interference and recorded charging screenshots were visually inspected. The operational fixtures use explicit placements and supplemental funds to isolate the relevant behavior; they are not autonomous matches or economic success rates. The native integration uses synthetic camera bytes to isolate transport; actual camera rendering is verified separately by the browser fixtures.

## Replay race found during verification

The full suite exposed a legitimate race when the recorder atomically replaced `status.json` between a reader's path check and file open. The existing identity check correctly rejected the changed file, but a normal finalization could surface as an avoidable replay error.

`ReplayStore` now retries the replaceable status marker at most three times only for a typed identity-replacement error, repeating the existing path, symlink and file-identity checks. Frame and image reads keep their previous protections. Persistent replacement, malformed/oversized/error status contents and unrelated failures remain explicit. All 20 recorder/store tests passed, including deterministic retry/exhaustion cases and real concurrent finalization; the final full suite and replay browser check also passed.

## Scope and cleanup

An independent bounded review found no actionable issues in the endurance, tool, native reconciliation and replay paths. Deterministic checks establish the implemented behavior, not autonomous strategy or competitive balance. New live Luna/xhigh matches are still needed to measure return-for-charge decisions, useful jammer coordination and economy/combat outcomes. These values and interference zones are game abstractions, not real aircraft or radio specifications. Payload drops and replacement airframes remain future work.

Port 4317 was unavailable. Another checkout's idle server occupied 4318 and was preserved. The owned 4319 test server and temporary sidebar browser tab were closed after verification; 4318 remained idle at simulation time zero. Native integration tests shut down their own helpers.
