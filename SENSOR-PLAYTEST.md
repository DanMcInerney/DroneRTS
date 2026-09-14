# Revised sensor delivery playtest

Run date: 14 September 2026 (UTC)

Surface: isolated headless Playwright Chromium with SwiftShader

Endpoint: `http://127.0.0.1:4318` only

Runtime: `gpt-5.6-luna / xhigh`

The single bounded trial passed the revised sensor, mission, radio, movement, and cleanup checks. The browser launched one parent and exactly three native drone children. The active session started at `01:15:11Z` after startup and stopped at `01:16:08Z` when all three replies to the second mission arrived. Including startup, the run occupied about 80 seconds. This is below the nominal 90–120 second trial target because the harness stopped after the required second-mission acknowledgements; no second trial was started.

The first plain mission required each drone to report its own four sensors, identify one visible feature, make exactly one small controlled movement experiment, share the observed change, then hover and wait. Each drone made one `fly_to` experiment from its initial position by `+1` local X:

| Drone | Initial position | Final position before mission 2 | Movement | First mission fly-to calls |
| --- | --- | --- | ---: | ---: |
| drone-1 | `(-5, 7, 23)` | `(-4, 7, 23)` | `1` local unit | 1 |
| drone-2 | `(0, 7, 23)` | `(1, 7, 23)` | `1` local unit | 1 |
| drone-3 | `(5, 7, 23)` | `(6, 7, 23)` | `1` local unit | 1 |

The audit recorded 9 peer radio messages from all three drones and 11 radio messages total. Each drone described a visible camera feature and reported the observed position, heading or image change. The UI screenshot shows the three live FPV views and the three mission-2 replies in the radio panel.

The audit paired the game tool event immediately before each observation event. Sensor delivery was complete for every paired response:

| Tool response | Paired responses | Local XYZ | Heading | `capturedAt` + `simTime` | Camera |
| --- | ---: | ---: | ---: | ---: | ---: |
| `act` | 6 | 6 | 6 | 6 | 6 (`512×288`, available) |
| `send` | 9 | 9 | 9 | 9 | 9 (`512×288`, available) |
| `wait` | 12 | 12 | 12 | 12 | 12 (`512×288`, available) |

No `observe` calls were needed: the initial mission delivery woke each drone’s `wait`, and the new bundle was present on every `wait`, `act`, and `send` response. All 12 waits omitted the legacy `after` cursor argument. Every observation had a delivered cursor and no unmatched or pending tool/observation pair remained. The audit stores camera availability and dimensions; camera image payloads are delivered to the actor but are not persisted as raw image data in the session log.

One capture timing nuance is visible in the audit. Drone-3’s `act` capture began at `01:15:25.484Z`, before its one-unit move completed; the arrival event entered its inbox during the roughly 470 ms capture. Its response therefore still reported the pre-arrival position alongside the arrival event. This is observed capture timing, with no missing sensor bundle or delivery error.

The second directive was sent while mission 1 was active: “Hold position now. Each drone acknowledge this instruction and report your current position and timestamp.” Mission 2 cleared the three prior actions (`status: New instruction`, no action at the forwarding boundary), and each drone sent one mission-2 acknowledgement containing its current local position and timestamp. Radio records used `fleet-radio/1`, one session UUID, strictly increasing sequence numbers, and parseable `sentAt` values.

Stop cleanup was successful: `running=false`, runtime status `stopped`, and all three drones offline. There were no tool errors, policy denials, or runtime errors. The audit contained no omniscient `mission_complete` agent event. A single nonfatal browser console warning reported a SwiftShader `ReadPixels` GPU stall while rendering camera captures.

Evidence:

- [playtest-result.json](artifacts/playtest-boundaries/run-2026-09-14T01-14-43-509Z/playtest-result.json) — machine-readable checks and findings.
- [state-history.jsonl](artifacts/playtest-boundaries/run-2026-09-14T01-14-43-509Z/state-history.jsonl) — browser-visible state samples.
- [session-2026-09-14T01-14-48-287Z.jsonl](artifacts/session-2026-09-14T01-14-48-287Z.jsonl) — 4318 session audit.
- Screenshots: `idle.png`, `launch-starting.png`, `three-drones-online.png`, `mission-one-sent.png`, `mission-two-sent.png`, `all-three-second-mission-replies.png`, `bounded-trial-end.png`, `stopped.png`, and `final-browser-state.png` in `artifacts/playtest-boundaries/run-2026-09-14T01-14-43-509Z/`.
# Subsequent repair validation

After this recorded Luna/xhigh run, the coordinator added one bounded image refresh when an action completes or the mission changes during capture, plus controller-event/delivery timestamps and command receipt epochs. Deterministic tests reproduce the observed drone-3 timing case and verify the returned position is sampled after arrival. Expected movement/camera-limit rejections also now preserve the running fleet and return sensors. The revised suite has 25 passing tests and the production build passes. These repairs were not followed by another live inference trial; the original evidence below is preserved.
