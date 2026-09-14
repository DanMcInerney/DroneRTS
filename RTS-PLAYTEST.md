# RTS verification — September 14, 2026

This report covers the working implementation on `codex/cincinnati-rts`, based on merged PR #3 (`7e664d6`, God view and Admin). Testing used Windows, the installed Codex CLI 0.144.0, real local Zenoh/MAVLink helpers and the Codex sidebar browser. All inference actors used **gpt-5.6-luna / xhigh**. The original idle service on port 4317 was preserved during development; live trials used port 4318.

The exact 86-file source manifest is saved locally in `artifacts/rts-source-manifest.json` (SHA-256 `ada03f9e189945bc69848ec1ae05c93e96d18ffbd456abb9ba1851a9d63fb8ad`). It covers code, styles, HTML, configuration and data used for the final checks, excluding prose reports and local session artifacts.

## Deterministic game and browser checks

`npm test` passed **121/121 tests** after the runtime repair. `npm run build` passed TypeScript and produced the production bundle; Vite reports the existing large-bundle advisory. Tests cover swept moving-drone contacts, armor consumption and separation, building/ground collision, physical projectile travel and gravity, cover, friendly fire, mining reach and depletion, miner acceleration, atomic shared purchases, simultaneous victory/draw and reset. Observation tests cover camera evidence, unavailable images, mission versions, cross-team isolation, death during acquisition, immutable render snapshots, own mining feedback and absence of opponent economy notifications. Integration tests use actual Zenoh and MAVLink helper processes without inference.

`node --import tsx scripts/verify-rts.ts` passed using a browser fixture attached to the real renderer and `FleetGame`, with inference explicitly blocked. It captured six actual 512×288 sensor images, exercised God view and Admin while sensor acquisition continued, and completed an earning → purchase → camera aim → physical shot → kill → victory sequence. The mobile layout at 390 pixels had no horizontal overflow, reset restored all six drones, and there were no page errors. This fixed duel proves the simulator and interface path, not autonomous targeting skill.

Local evidence: `artifacts/rts-ui/result.json`, the six `drone-*-initial.jpg` images, `armed-camera.jpg`, `projectile.png`, `victory.png`, `desktop.png` and `mobile.png`. Full-page screenshots can show blank offscreen FPV panels because the renderer only draws visible viewports; `live-feeds.png` records the visible feed layout, and the individual sensor images verify camera output directly.

## Live trial 1 — initial opening

`artifacts/playtest-rts/2026-09-14T05-13-35-466Z/result.json`

Six native drones started, received their team missions, acquired their own images and communicated over radio. The match ended naturally after about 195 simulation seconds: red won with drones 5 and 6 surviving. Four drones died in terrain collisions. Neither team mined. The trial reported no runtime failure and stopped its test fleet.

This exposed a weak opening: agents spent their early turns exploring away from salvage without discovering mining. The starting positions were moved within safe mining reach with cameras facing each team's opening deposit, and the drone prompt was simplified to remove prescribed coordination conventions. No map coordinates, movement calibration or resource explanation were added to actor instructions.

## Live trial 2 — mining and a discovered runtime defect

`artifacts/playtest-rts/2026-09-14T05-19-19-331Z/result.json`

The revised opening produced actual resource discovery and mining by red drone 5, earning the team's full 80-credit opening deposit. Its peers received the shared account state. One blue drone crashed.

The actors then reported that `buy` appeared in their controller response but was absent from their callable tool namespace. A prior native MCP inventory preflight had shown a changed catalog, but had not proved that a running model turn could call it. The trial was deliberately stopped at about 180 seconds to repair this. Its recorded “Match stopped early” failure is that intentional diagnostic abort; this trial is not presented as a passing complete match.

The repair keeps each drone's identity and history. A completed tool response carries the full fresh sensor/inbox bundle plus a transport-only request to end that turn. After natural completion, the runtime queues a supported MCP configuration reload, reads the refreshed tool inventory and starts a new turn for the same actor. Expected catalog changes do not consume the accidental-completion recovery budget. Death and Stop suppress resumption. The runtime never interrupts private reasoning to install the newly unlocked tool.

## Native tool-discovery proof

`artifacts/runtime-catalog-native-smoke.json` and `artifacts/runtime-catalog-native-smoke-events.json`

A bounded native Luna/xhigh protocol actor called `observe`, then `buy({mission:1,item:'gun'})`, then `fire({mission:1})` across two natural turn transitions in the same native thread. Both later tools were absent from its initial callable catalog. CLI 0.144.0 required the configuration reload as well as the idle child's inventory read; merely notifying or listing tools was insufficient. The smoke completed at 05:31:03 UTC and cleaned its temporary actor/runtime.

This fixture supplied synthetic sensors and explicit protocol-test tasks. It proves that the model itself can call newly discovered equipment tools; it is separate from an autonomous match and does not prove visual targeting or tactical competence. Production drone instructions contain an explicit exception permitting this transport-only temporary yield.

## Final live trial — repaired production runtime

`artifacts/playtest-rts/2026-09-14T05-32-30-728Z/result.json`

The full six-drone production match ran for its bounded ten-minute window and stopped automatically at 05:42:32 UTC. Its audit contains **470 camera observations, 41 peer radio messages, five purchases and seven gunshots**, with no recorded runtime or tool errors. All six native children were verified as Luna/xhigh, and the two parents remained mechanical relays.

Blue discovered and exhausted its opening deposit, earning 80 shared credits. The drones independently coordinated and purchased two guns, two armor charges and one miner, spending exactly the available income. The newly discovered tools worked across five natural catalog refreshes involving three concurrent production actors. Red continued its own visual exploration and mining experiments but did not recover salvage during this run.

Both armed blue drones fired while tracking perceived red contacts. No projectile hit was recorded. Live collisions exercised the requested survival rules: blue drone 1 consumed armor against terrain, and blue drone 2 survived contact with unarmored blue drone 3, consuming its armor while drone 3 was destroyed. Drone 1 later died in another terrain collision after losing its protection. At the time limit, drone 2 and all three red drones survived. There was **no natural winner** in this final bounded trial; the time limit stopped the trial without assigning a victory.

This proves live mining, shared spending, all three attachments, model-called firing, asynchronous radio, collision consequences and cleanup. It does not prove reliable autonomous aiming, successful contested-deposit mining, or balanced competitive strategy. The earlier natural victory and deterministic gun-kill victory remain separate evidence.

The test fleet stopped successfully. The isolated port-4318 server was shut down afterward, and the idle normal service on port 4317 was refreshed to the new six-drone RTS, ready for the player to launch a fresh match. No player match was interrupted.

## Interpretation

The game exposes a complete RTS ruleset, but agent strategy is learned during each match. Testing must distinguish deterministic physics success, native tool-protocol success and autonomous game performance. Terrain deaths, mistaken experiments and poor spending choices can be legitimate outcomes for fresh actors. None of the tests justify claiming consistently skilled autonomous gunfights or balanced competitive play.

Raw session records and screenshots are local ignored artifacts. Earlier treasure-hunt playtest/review documents describe older revisions and are not evidence for this implementation.

## Focused flight and aiming evaluation — September 14, 2026, 12:21–12:40 UTC

This separate evaluation starts from merged `33e9428a655eac117d206e3940bf6fff614ef391` (PR #4). Flight, combat, economy and production actor prompts are unchanged; the later replay persistence repair is described below. New developer scripts arrange and measure trials. Each live run records its launch-time source hashes in `source-manifest.json`; the manifest fingerprint is also in `result.json` and `analysis.json`. Windows Node 24.15.0, Python 3.12.4 and Codex CLI 0.144.0 were used. The existing Python environment was verified through `FLEET_PYTHON`; no credentials or raw artifacts are committed.

### Deterministic baseline

`node --import tsx scripts/measure-controls.ts` passed **34/34 fixtures**: 17 prescribed scenarios with 50 ms and 200 ms caller ticks. Final positions, survival and combat-event outcomes agreed across tick durations. These fixtures use synthetic one-pixel camera placeholders, no browser, no native protocols and no inference; they establish controller/physics behavior, not visual navigation or model skill.

| Measurement | Observed baseline |
| --- | --- |
| Shortest-arc turns | Both wrap directions traveled 2°, with zero final error. |
| 90° yaw / 50° pitch | Settled within 0.1° in 1.9 s at the 50 ms sampling interval. |
| Waypoints of 0.2, 6 and 20 units | One arrival event each and zero final position error; largest sampled overshoot 0.024792 units. |
| Hover from full cruise | Braked over 0.75 units and stopped in 0.50 s; no subsequent drift. |
| Scripted corridor | Two route legs completed without collision. |
| Wall contact | Unarmored drone destroyed; armored drone lost armor once and remained stably separated. |
| Stationary ballistic fixtures | Direct level shot hit at range 10 and missed at range 40; gravity compensation hit at range 40. |
| Moving ballistic fixtures | Direct shot missed at range 30; prescribed lead and gravity compensation hit. An intervening wall blocked a shot. |

Local evidence: `artifacts/control-measurements/2026-09-14T12-22-08.578Z/summary.json` and `trajectories.json`. No underlying control or projectile defect was demonstrated, so production physics was not changed.

### Live focused trials

All trials used the Codex sidebar browser on an owned port-4318 host, the production `FleetGame` and `TeamSession`, two real isolated Zenoh networks, six MAVLink identities and actual recorded camera images. Each audit contains six native `spawnAgent` receipts with **gpt-5.6-luna / xhigh**, plus model verification for both parents. Parents relayed the original trial objectives mechanically. No world geometry, target telemetry, flight calibration or ballistic calculation was sent to the actors.

| Trial | Simulation duration | Camera observations / peer messages | Measured outcome |
| --- | --- | --- | --- |
| Flight, normal opening | 179.99 s | 96 / 19 | 11 delivered arrivals; four survivors; two blue drones lost in one friendly collision. No terrain deaths. |
| Stationary aiming fixture | 107.56 s, natural completion | 54 / 9 | Seven shots, three drone hits and three bullet eliminations. Three shots expired; one remained unresolved when blue won. |
| Moving-target objective fixture | 239.89 s, time limit | 281 / 21 | 20 shots, one drone hit, 19 expired shots. Five survivors; no winner. The hit target was stationary at firing and impact. |

Flight actors independently tested turns and small movements, then shared actual measurements. Blue 2 traversed about 25.1 sampled world units over three arrivals along a visible road; red drones completed eight further arrivals. Blue 1 commanded a three-unit move toward stationary Blue 3, entering its collision radius at 56.59 s and destroying both. The pre-collision camera visibly contains the cyan teammate. This is an unsafe route choice, not evidence of a wrong controller axis or spontaneous collision. All three red drones and Blue 2 demonstrated safe short navigation, but this single trial does not establish reliable team collision avoidance. The hover commands largely followed arrivals, so braking during model-controlled cruise remains less tested than deterministic braking.

The aiming fixtures placed three opposing pairs 14 units apart above the city, with blue cameras initially offset by 8°. Blue received guns directly in fixture setup; the agents received only an aiming objective and normal tools/sensors. Red was told either to hold or to choose nearby back-and-forth waypoints. These tests do not prove autonomous purchases, enemy discovery or tactical positioning.

In the stationary trial all three blue actors independently achieved a gun kill after camera turns. Shot analysis recorded angular offsets of 0°, 1° and 0° for the three hits, with about 0.43 s travel time. A 4° error missed by roughly one unit at the target's projected range, consistent with the ballistic baseline. Blue 2 also fired twice toward its already-destroyed target's position. Saved before/after images show a colored live body becoming a dark tilted wreck; this subtle visual change at distance was not consistently interpreted by the actor. No hidden hit receipts were introduced.

In the moving trial red actors traveled approximately 140.9, 105.7 and 130.7 sampled units, spending about 60.7, 45.4 and 55.7 s in motion above 0.1 units/s. They paused between asynchronous commands. The only hit, Blue 2 → Red 2 at 186.73 s, followed a 0.459 s flight while the target was paused. Pre-shot camera ages ranged from 2.51 to 7.08 s. Only three shots had the closest angular live opponent moving above 0.1 units/s at firing; none hit. That opponent selection is an offline diagnostic, not a claim about the model's intended target. The trial establishes difficulty tracking intermittent motion, not reliable moving-target interception or a proven feedback defect.

All three focused runs stopped their fleets and owned servers, with zero recorded runtime/tool errors and zero missing camera images. Real replay was inspected through Admin during the moving trial while current sensor acquisition continued. That trial then logged a Windows `EPERM` failure replacing its final replay status marker: its complete JSONL and images remain available for offline analysis, but the error marker blocks normal Admin reopening. Flight and stationary trials had no replay warnings. This storage defect is separate from autonomous flight/aiming performance; see the repair and verification below. Local evidence directories under `artifacts/focused-trials/`:

- `2026-09-14T12-21-11-122Z-flight` — manifest `3115907bb547b6b278cedffcfc7f28153ad00354d9078d29b4cbbd86bfa77040`.
- `2026-09-14T12-24-30-884Z-aim-stationary` — manifest `9b1f2cc07461f6e335a8862ed145f5a06e5db8f7a9048204a859d2d45c920c60`.
- `2026-09-14T12-27-08-580Z-aim-moving` — manifest `4f0c317b9aced7d35e41228fb92d0f641a09bb04b0287234cc76f50be99d1b54`.

Each contains `result.json`, `analysis.json`, a redacted session audit and bounded replay with actual image files. Screenshots supplement the flight and moving-trial evidence. Raw artifacts remain local and may be absent from another clone.

### Full match after the focused trials

`artifacts/focused-trials/2026-09-14T12-31-40-795Z-match/` contains the full-match result, analysis, audit and replay. Its launch manifest is `f6465e5142d54ce0c1f26cee06de65b08cc75e04f494992450e254c3a8acefe7`. It used the normal production opening, zero starting credits/equipment, original elimination missions and six fresh Luna/xhigh children. The test host applied no aiming or flight-practice objective. This run still used the original replay writer; the later storage repair is verified separately below.

The eight-minute wall limit produced **479.91 simulation seconds, 458 camera observations, 72 peer messages and 15 purchases**, with no runtime/tool errors, replay warnings or missing images. All six drones survived; there was no winner. Both teams exhausted their 80-credit opening deposits. Blue also found and mined 157.14 credits from the riverfront deposit, earning **237.14** total; red earned **80**. No opposing extraction from the same deposit was recorded, so contested mining is not established.

Purchases comprised five guns, nine armor charges and one miner. Three terrain collisions consumed blue armor without a death. Blue spent 148 credits and red spent 76; final shared balances were 89.14 and 4. Blue 2 bought the miner and continued gathering from the richer deposit. This is evidence of autonomous resource discovery beyond the opening and continued economy decisions, with one match as the observation unit.

The sole shot, by Blue 3 at 456.06 s, expired without contact. Its preceding camera shows empty sky and schematic terrain; the drone explicitly radioed that it fired a test shot with no enemy contact. Every live red drone was more than 112° away from its firing direction. Thus this match did not produce a gun engagement, even though the stationary fixture demonstrated autonomous kills. Coordinated combat, reliable moving-target interception, contested mining and consistent match completion remain unproven.

The trial stopped all owned actors and its server. The final state check found port 4318 unavailable and the preserved player service on 4317 still idle at simulation time zero. No player match was interrupted.

### Independent review, repairs and checks

One fresh independent review cross-checked the trial code and raw evidence. It found the moving-trial status-marker failure above and a historical-analysis provenance risk: the initial analyzer used the current checkout's ballistic constants under the saved run's fingerprint. The analyzer now verifies the saved `shared/rts.ts` hash before calculating diagnostics or replacing an existing analysis. It also uses record order to exclude a post-fire camera acquired at the same simulation timestamp from evidence available before that shot, and labels unfinished projectile outcomes separately.

The replay repair is confined to `server/replay-recorder.ts`. It retries atomic status-file replacement for `EPERM`, `EACCES` and `EBUSY` with five bounded delays totaling 385 ms, retaining the previous complete marker throughout. Persistent failures and unrelated storage errors still use the explicit failure path. Transient Windows file contention is a plausible cause of the observed `EPERM`, not a proven identification of the process holding the file. The original failed recording and warning remain unchanged as historical evidence.

The deterministic baseline passed 34 fixtures and 48 existing game/RTS tests. After the replay repair, 25 replay tests passed, including new transient replacement, permanent denial, nonretryable error and concurrent real-reader coverage. Two analyzer regressions passed for historical calibration protection and pre-shot camera ordering. TypeScript and the production build passed; the existing Vite bundle-size advisory remains. The trial runner also rejected a nonfinite duration and refused an occupied port 4318 without affecting the active full match (`artifacts/focused-trial-guards.json`).

The final `node --import tsx scripts/verify-replay.ts` browser check passed without inference against an owned idle production server on port 4318. Its 245 records verified live append, scrubbing, playback, event seeking, all six actors, physical shot/impact correlation, byte-for-byte camera evidence, replay/live sensor isolation, unavailable legacy evidence and responsive layout, with no browser errors. Evidence is in `artifacts/replay-ui/result.json` and `store-80f0bdd9-24a9-4c67-8796-67fb49ffef87/`. That server and its browser were closed afterward. The reviewer completed the same review after the full-match evidence arrived and reported no additional high-impact findings; the repair checks above were performed by the implementer.

## Encounter, latency and acquisition evaluation — September 14, 2026

This follow-up starts from merged PR #5, `681c6d09b03b0091fb98af9d2917bcd050e0083d`. The user authorized stopping port 4317 and requested watchable tests in the Codex browser. Port 4317 was stopped before this evaluation. All live runs below use the same Codex browser tab on an owned port-4318 host, six fresh native Luna/xhigh drone actors, two mechanical parents and actual Zenoh/MAVLink transports. Raw records remain local under ignored `artifacts/focused-trials/`; each run has a source manifest, result, audit, actual camera replay and offline analyses.

### What the previous evidence actually establishes

`scripts/analyze-engagement.ts` now separates camera acquisition/delivery from the subsequent command interval and measures team proximity and camera opportunities. It uses recorded optics and buildings, verifies the relevant geometry/renderer source hashes, preserves acquisition-time observer poses and uses preceding sampled opponent poses. The projection is a body-center frustum/building-occlusion proxy; it does not establish that a silhouette was recognizable. Frame age and excluded effects such as fog, JPEG loss and partial silhouettes are explicit.

Reanalysis of the previous normal match (`2026-09-14T12-31-40-795Z-match`) corrects an overly broad interpretation that the teams never met. Blue 3 and Red 1 approached within **18.18 local units** at 244.53 s; some opposing pair was within 40 units for **120.46 sampled seconds**. However, only **four of 458 delivered images** had a clear opponent-center projection within 40 units, and none had one within 20. Across 168 images, 365 clear observer-target projections had a median range of 90.66 units. Blue 3 traveled 484.3 sampled units while red actors traveled 23.4, 85.5 and 43.1; actual red radio describes holding depleted-resource overwatch, scanning and uncertain colored specks. The evidence points to limited useful acquisition and recognition, not simply lack of geographic proximity.

The actual camera `482e151f-721c-4d1d-b8c6-febef95e553f.jpg` at 237.74 s shows pale armor rings near the lower edge where the offline projection places two red drones. The associated colors and bodies are difficult to distinguish. Red 1 reported a completed scan with no cyan contact at 243.71 s. These are evidence about those observations, not a general claim that every nearby opponent is invisible.

| Recorded run | Delivered observations | Acquisition → server delivery, median / maximum | Server delivery → next tool, median / p95 |
| --- | ---: | ---: | ---: |
| Previous normal match | 458 | 10 / 44 ms | 3.889 / 9.938 s |
| Previous moving-target fixture | 281 | 10 / 103 ms | 3.535 / 8.369 s |
| First new encounter | 60 | 12 / 52 ms | 4.843 / 8.556 s |

The multi-second interval is predominantly after server delivery. It includes native response processing, model decisions and tool dispatch; these logs do not isolate private reasoning or the moment a model reads an image. Deliberate waits are measured after their result returns. No slow camera-transport defect was demonstrated, and no change to camera freshness, asynchronous movement or gameplay model/effort was justified.

### Symmetric encounters and resolution comparison

`encounter` positions three opposing pairs above the city, gives both teams guns and equal camera offsets, and sends both teams the same combat objective. Drones choose their own movement and aim. `encounter-reversed` swaps the starting positions and directions. These are combat fixtures, not normal resource matches. Neither baseline run included translation; the resolution candidate did include autonomous movement, with Blue 2, Red 1 and Red 2 traveling 19.85, 11.71 and 32.04 sampled units respectively. Its only bullet kill still hit a stationary target.

| Trial | Camera | Simulation seconds | Images / peer messages | Shots and outcome |
| --- | --- | ---: | ---: | --- |
| Encounter | 512×288 | 79.29 | 60 / 14 | 9 shots, 3 stationary bullet kills, 6 expired; natural blue victory. |
| Reversed encounter | 512×288 | 239.59 | 139 / 25 | 23 shots, 3 stationary bullet kills, 1 terrain impact, 19 expired; three survivors, no winner. |
| Reversed encounter, resolution candidate | 1024×576 | 239.88 | 158 / 24 | 21 shots, 1 stationary bullet kill, 19 expired, 1 unresolved at stop; five survivors, no winner. |

The first encounter's red actors received 8, 6 and 4 images containing clear opponent-center projections but never fired. Their radio reported no confirmed enemies; the saved first red image `9ec806d6-3539-45a3-b133-69fec0ac2a5f.jpg` shows the paired blue drone as a thin dark/cyan mark at 14 units. Reversing positions produced kills by both teams, so one run did not establish a general team-color disadvantage.

The resolution candidate changed only camera width/height, retaining the same aspect, FOV, scene, rules, objectives and Luna/xhigh settings. Its images show more shape detail, but the paired encounter did not demonstrate improved combat. Median camera delivery rose from 13 to 21 ms, while median post-delivery time was 4.193 versus 4.467 s. The replay images occupied 1.89 versus 5.68 MiB (139 versus 158 images); these are observed storage totals, not a billing comparison. One independent model run per arrangement is insufficient to estimate a reliable performance effect.

All three runs have zero runtime/tool errors, replay warnings and missing camera images. Their local directories and launch manifest fingerprints are:

- `2026-09-14T13-14-28-970Z-encounter` — `2de6a93e707542eb8b2135aa86afbcc86faaa10fc5e5c279eb87e97437e58d70`.
- `2026-09-14T13-17-52-808Z-encounter-reversed` — `70ecf00e1bccc3ce5ab0683b3d0d3dd22d540b995db8fc803034d3d5b7ea64e5`.
- `2026-09-14T13-22-33-424Z-encounter-reversed` — `7bea11691af992c5e5fa494f714f56970986d2a590a1277fca7d4545a481eb94`.

### Moving-target resolution trial and disposition

The candidate then repeated the original moving-target objective for 239.79 simulation seconds. Its 176 delivered images and ten shots produced **zero projectile contacts**; all ten shots expired. Red 1 chose a route through stationary Blue 1 and both were destroyed by a ram at 50.02 s. Red 2 continued a lateral patrol and Red 3 chose a vertical patrol; four drones survived the time limit. Only one shot had its closest angular live opponent moving above 0.1 units/s at firing, and it missed. This is a diagnostic opponent selection, not a statement about the actor's intended target.

Median capture/delivery was 18 ms and post-delivery/next-call time was 3.856 s. No runtime/tool errors, replay warnings or missing camera images were recorded. Evidence is `2026-09-14T13-27-02-283Z-aim-moving/`. The earlier 512×288 trial's one paused-target hit and this trial's zero hits do not establish a reliable moving-target benefit. The larger images remain historical experimental evidence; the candidate was **rejected and 512×288 restored** before the first normal-match follow-up. Flight, combat, economy, camera timing semantics and FOV remain unchanged; the subsequent prompt reminder is described below.


### Normal-match follow-up and interrupted reminder trial

The normal opening in `2026-09-14T13-31-46-536Z-match` ran to its eight-minute wall limit: 479.97 simulation seconds, 331 camera observations, 54 drone-sent radio messages (56 total entries including player goals), five survivors and no winner. Each team earned 80 credits from its opening deposit. No shots were fired. A blue teammate collision destroyed Blue 3 and consumed Blue 2's armor at 259.28 s; another teammate collision consumed Red 1 and Red 2's armor at 423.11 s. Its manifest is `93409d21d996baf7133c0a66c908e34ee0221ed86c2b7e981057869bb13daea0`. No runtime/tool failures or replay warnings were recorded.

Those contacts motivated a general drone-prompt reminder to treat a teammate's reported position as occupied, select a separate vantage from its own observations, and coordinate its route over radio. It supplies no map, calibration, coordinates or assigned route. Trial `2026-09-14T13-40-33-325Z-match`, manifest `2294b7fdf2636649e3d209df0dd5bcf4f3ee503eff2491db0200f60732409a0c`, was stopped when the user requested the UI change. It ended after 67.70 simulation seconds with 40 observations, all six drones alive, no recorded runtime/tool failures or replay warnings, and `external-stop` as its recorded end reason. This is an incomplete trial, not evidence of better collision avoidance or match completion. The reminder remains in the final prompt; its gameplay benefit has not been established.

## Camera-first UI verification — September 14, 2026

The dashboard now has one compact desktop header, outgoing radio transcripts under each drone feed, and the overhead map at the bottom. Each transcript follows new messages until the reader scrolls back; **Latest** resumes following. Rules and network inspection remain expandable below mission control.

Verified interactively in the Codex in-app browser with an isolated, inference-free fixture on port 4318 using recorded radio traffic from `2026-09-14T13-31-46-536Z-match`. Checked six sender-specific transcripts, direct-recipient labels, literal HTML-like message text, pause/resume on new messages, reset to six empty logs, camera capture for all six drones, and God view from the relocated map. Camera capture also succeeded while God view was open. Desktop (1280px), tablet (768px iframe), and phone (390px iframe) layouts were visually checked. Browser error/warning log was empty during the interaction checks.

`npm run build` passed, with the existing bundle-size advisory. All 23 tests in `tests/game.test.ts` and `tests/rts-game.test.ts` passed. No new live gameplay inference was launched for these UI checks. This validates the presentation change; it does not establish improved agent combat performance.

Before PR merge, the full automated suite passed all 149 tests, including real Zenoh and MAVLink integration checks. The production build passed with the existing bundle-size advisory. The watchable UI checks above used the same final client code.
