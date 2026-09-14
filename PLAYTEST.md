# PoC validation record

Build and playtest date: 13 September 2026.

The browser playtester is **gpt-5.6-luna / xhigh**. Every live gameplay runtime, including the parent, is configured and checked for that same model and effort. Simulator unit tests use no model inference.

## Browser inspection

Luna inspected the actual local browser on desktop and at 390 × 844:

- Three real rendered FPV views appear side by side on desktop.
- Drone cards stack on mobile; mission and radio controls remain readable without visible clipping.
- Launch, Stop, Reset, mission and speed controls are present with clear startup state.
- One non-blocking Three.js warning concerns deprecated PCFSoftShadowMap.

Screenshots: `artifacts/playtest/desktop-idle.png` and `artifacts/playtest/mobile-controls-idle.png`.

## Deterministic checks

Seven simulator/mailbox tests passed before live gameplay: queued event delivery, role isolation, verbatim relay, mission replacement and stale-command rejection, movement/collision and disconnect pause, camera result structure, objective scoring, Stop wakeup and restart isolation. TypeScript and the Vite production build passed.

## Live gameplay

Surface: isolated Playwright Chromium with a temporary profile, used under the explicit approved fallback after the in-app Browser disconnected. The page connected to `http://127.0.0.1:4317`; this was a real Three.js WebGL session, not a synthetic sensor run. The runtime and all gameplay actors reported `gpt-5.6-luna / xhigh`.

### Passed

- Visible Launch fleet action accepted and verified a parent plus exactly three native drone children. The session log records the model verification, three `spawnAgent` calls, and three connected child roles.
- Visible Send instruction action forwarded the unchanged default text as mission 1 to all three drones.
- Real camera loop worked: the session log records 21 `observe({camera:true})` calls and 21 observation events, and `mission-radio-progress.png` shows live FPV canvases with changing poses and observation counts.
- Real fleet radio worked: 12 messages were rendered in the radio panel. Drones announced sectors, claimed yellow and red pads, and exchanged completion/status messages.
- Real movement worked: drone-3 reached and hovered at approximately `(2, 3, 10)` for yellow; drone-2 reached and hovered at approximately `(-17, 3, -8)` for red; drone-1 moved through multiple waypoints while searching for blue.
- Emergency Stop endpoint completed cleanly when the parent identified the stale wait loop; the state became `running=false`, runtime `stopped`, with inference shut down. This operational stop is captured in `playtest-result.json`.
- Visible Reset world action completed after the aborted run and cleared `mission` to 0, `completed` to false, and the radio transcript to 0 messages. Evidence is in `artifacts/playtest/reset-check.json` and `reset-after-abort.png`.

### Failed

- Mission 1 did not complete. The parent stopped the trial at about 2:45 wall time after repeated immediate `wait(after:5, ...)` calls from drone-3 caused a rapid usage increase (`813k` to `904k` in four seconds; final reported usage `1,569,977`). The server-side wait cursor recovery needs repair before another inference run.

### Untested

- Mission 2 / second instruction relay and native wakeup.
- Stop fleet button semantics (the emergency stop used the same server endpoint directly to halt inference immediately).
- Reset world button after a completed mission lifecycle (the post-abort stopped lifecycle was verified separately).

The aborted-run evidence is in `artifacts/playtest/playtest-result.json`, `artifacts/playtest/state-history.jsonl`, and `artifacts/session-2026-09-14T00-17-58-339Z.jsonl`. Screenshots include `artifacts/playtest/isolated-idle.png`, `launch-starting.png`, `mission-queued.png`, `mission-radio-progress.png`, and `final-browser-state.png`.

### Repaired rerun

Run window: 14 September 2026, 00:31:19–00:37:03 UTC. Evidence is under `artifacts/playtest/run-2026-09-14T00-31-19-027Z/`, with session log `artifacts/session-2026-09-14T00-31-23-531Z.jsonl`. The run used an isolated Playwright Chromium temporary profile against the local app and a real Three.js WebGL surface.

#### Passed

- Runtime model and effort were verified as `gpt-5.6-luna / xhigh`; one parent and exactly three native children connected.
- The default mission was forwarded unchanged as mission 1. All three children produced live camera observations (22 observation events total) and movement updates; the UI rendered the three FPV views, radio transcript and mission progress.
- The repaired event cursor behaved correctly: waits omitted the stale `after` hint, respected the minimum delay, and did not reproduce the prior immediate wait loop.
- Radio coordination worked, including claims, yield and status messages. Mission 2 forwarded `Everyone hold position and briefly report your status.` and all three drones replied (three reports, four mission-2 radio messages).
- The visible Stop fleet action left `running=false`, runtime `stopped`, and all drones offline. The visible Reset world action then returned the world to mission 0, `completed=false`, with an empty radio transcript.

#### Failed

- Mission 1 did not complete within the five-minute bound. Drone-3 and drone-1 found distinct saturated pad-like landmarks and reached hover states, but drone-2 first claimed the decorative launch circle near `(0,23)` as yellow and later treated an orange square obstacle near `(5,-6)` as a pad. The pad visual language needs the planned production adjustment (remove the decorative launch disk and make landing pads unmistakable H-marked targets) before the objective can be judged complete.
- Two nonfatal camera tool errors occurred when children requested pitch `-90` even though the tool limit is `-85`; each stopped at one consecutive failure and the runtime continued. This is an agent/tool contract mismatch worth addressing in the prompt or tool interface.

#### Untested

- Full mission-1 completion and objective scoring after the visual target adjustment.

The repaired-run screenshots are `mission-three-minute-progress.png`, `mission-complete.png` (bounded-end view; mission was incomplete), `mission-2-forwarded.png`, `stopped.png`, `reset.png`, and `final-browser-state.png` in the dated evidence directory. The first stale-cursor failure above remains preserved as historical evidence; the rerun demonstrates that the server repair resolved that failure.
