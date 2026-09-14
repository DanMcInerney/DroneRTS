# Independent RTS review — September 14, 2026

Reviewed the working implementation on `codex/cincinnati-rts` against prerequisite commit `7e664d6` (merged God view/Admin PR #3). The reviewer did not implement or repair game code, launch inference, or operate either server. This was one independent review, including a second pass for shared causes and inspection of the subsequent targeted repairs.

## Disposition

No open high-impact correctness, observation-isolation, lifecycle or interface finding remains in the reviewed implementation. This is a code and evidence review, not a claim that fresh agents consistently play competent RTS matches.

## High-impact finding found and resolved

**P1 — Unlocked tools were absent from active native model turns.** In live trial `2026-09-14T05-19-19-331Z`, red mined its 80-credit opening deposit but could not purchase equipment. Drone 4 reported that the controller listed `buy` without exposing a callable endpoint; drone 5 confirmed the same and unsuccessfully tried `act kind=buy`. The earlier no-inference MCP inventory preflight did not validate the active model's callable tool set. This prevented the autonomous economy/combat progression despite passing simulator tests.

The reviewed repair in `server/runtime.ts`, `server/runtime-mcp.ts` and `server/runtime-tools.ts` preserves the entire completed sensor/inbox result, then requests a normal native turn yield. It refreshes the native MCP inventory and resumes the same actor, mission and history with Luna/xhigh. Catalog refreshes have a separate recovery budget; Stop and retirement suppress resumption. The production prompt explicitly permits this transport-only yield. No private reasoning is interrupted to inject the new tools.

Closure evidence:

- `artifacts/runtime-catalog-native-smoke.json` and `-events.json`: a real Luna/xhigh protocol actor on Codex CLI 0.144.0 called `observe`, `buy(gun)` and `fire`, with two natural turn refreshes. This fixture uses synthetic sensors and explicit protocol-test tasks; it does not prove autonomous gameplay skill.
- The subsequent real six-drone match independently inspected at approximately 135 simulation seconds had recovered blue's full 80-credit deposit, equipped guns on drones 2 and 3 and armor on drone 1, and completed five natural catalog refreshes across those three production actors. All six drones remained alive and active; red continued operating independently. This proves purchases work under the production prompt and concurrent team activity.
- `artifacts/rts-tests.log`: all 121 automated tests passed after the repair. The implementation owner also reported the production build passing.

## Other reviewed boundaries

The shared bank and finite deposits have one authoritative owner, purchases debit synchronously, and mining requires private delivered-camera evidence plus physical reach. Aim-based projectiles use travel time, gravity and swept collisions; armor, friendly fire, terrain/drone contact and last-survivor resolution have direct deterministic coverage.

The actor surface contains no map geometry, resource coordinates, opponent telemetry, movement calibration, combat formulas or hit oracle. Each team's native parent is a mechanical relay, its three-member Zenoh network is isolated, and the shared MAVLink adapter uses all six distinct vehicle identities. Fresh observation snapshots, per-drone mission adoption, durable mail and actor retirement remain intact. Own mining feedback and shop-unlock notifications are scoped to the appropriate drone/team.

Actual desktop, mobile, visible live-feed and sensor-image artifacts were inspected. The team scoreboard, map, equipment, resources and eliminated-drone states are legible and consistent; no material clipping or interaction issue was found. God view and Admin camera continuity are covered by the deterministic browser fixture. Blank offscreen feeds in full-page screenshots are a viewport-rendering artifact; visible live feeds and individual sensor images were verified separately.

## Evidence limits

The deterministic browser fixture completed mining → purchase → aimed physical shot → kill → victory, with real renderer output and inference blocked. The first live match ended naturally through terrain crashes, without mining. The second exposed the resolved catalog defect and was intentionally stopped for repair. At this review's cutoff the final real match was still running; autonomous gun hits, competitive balance and its eventual result are not claimed here. Consult `RTS-PLAYTEST.md` for the completed bounded trial evidence and cleanup result.

Raw logs and screenshots are ignored local artifacts and may be absent in a fresh clone. This report does not validate code changes made after its reviewed state.
