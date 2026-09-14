# DroneRTS

A local Three.js RTS in downtown Cincinnati: your blue swarm and an enemy red swarm each have three autonomous drones. Gather finite salvage, share the team's income, choose attachments and eliminate the opposing team. The last team with a surviving drone wins. Both swarms use real native Codex actors, peer-to-peer Zenoh radio and MAVLink 2 vehicle control.

All eight gameplay actors—six drones and two mechanical relay parents—use **gpt-5.6-luna / xhigh**. The runtime verifies the installed model list and never substitutes another model or effort. Each parent starts exactly three clean-context children and forwards its team's instructions unchanged; the drones make the decisions.

## Run a match

Requires Node.js 22.19+ (or 24+), Python (tested with 3.12.4), and an installed, signed-in Codex CLI. The Node minimum supplies per-thread CPU accounting for bounded routines. Python dependencies stay in the project `.venv`.

```sh
npm ci
npm run network:setup
npm run dev
```

Open [the local game](http://127.0.0.1:4317) and click **Launch match**. Both teams receive the same elimination-and-resource objective and common briefing: visible crates and hauling, team-painted bases and service, drone recognition and vehicle calibration. The commander is an ordinary **blue-only chat** participant who can send messages and receive drone replies. Chat preserves the active objective; red continues independently.

Keep a current game browser open: it supplies the actual drone camera images. A renderer fingerprint must match the server before the browser is accepted; reload an out-of-date page. Simulation pauses when no matching camera browser remains, and the runtime stops after ten seconds. Flight, spending and simulation time begin only after all six pilots have received their opening objective in a tool bundle. **Stop match** halts simulation and shuts down both native sessions and protocol helpers. **Reset match** restores all six drones and every deposit while stopped. Launching again also starts a fresh match with no equipment or credits carried forward. A completed match stops its agents automatically.

The six FPV feeds show each drone's physical view. Equipment and slot counts share a compact row; cargo and controller status sit side by side when space permits. Expand the controller for source/storage details. Each feed has its own outgoing radio transcript; empty logs collapse, and scrolling back pauses automatic following until **Latest** is selected. The header shows both teams' survivors and credits, and the overhead map sits at the bottom. Tactical maps, team banks, loadouts, resource counts and the combat log are omniscient **player information**, not actor observations. **Fit downtown** frames the **820 × 660 m** landmark core around Fountain Square, Carew Tower and Great American Tower. Click the map for invisible **God view**: WASD moves, Q/E changes altitude, Shift speeds up, mouse or arrow keys look, and Esc exits.

**Admin** opens live fleet health and bounded current/historical session audits. Filter by category or actor, search, inspect JSON or export records. Available runtime reasoning summaries are logged; hidden model reasoning is unavailable. Credentials and camera image payloads are redacted. Camera capture continues while Admin or God view is open.

New audit records identify each actor's native turn, reasoning/tool/compaction start and completion boundaries, input/context token counts and retry errors. These timestamps describe observed runtime activity, not private reasoning or guaranteed inference progress. Older logs without these records cannot distinguish a silent model interval from context compaction or backend delay.

New sessions also have **Match replay** inside Admin. Select a session, scrub simulation time or play at different speeds, and select a drone to inspect its recorded flight, attachments and actual acquired camera images. The tactical plot includes sampled projectile paths, exact fire/contact endpoints and the last eight seconds of flight trails. Event buttons seek to their timestamps; totals count only evidence up to the selected time. Cameras show acquisition time and age. Missing images and recording gaps are explicit; an old audit file cannot reconstruct a replay.

Replay records stay separate from audit exports under `artifacts/replays/<session>/`: `frames.jsonl`, a status marker and individual camera image files. Each recording is bounded to 32 MiB of data and 64 MiB of images, at most 512 KiB per image, with a bounded asynchronous write queue. Routine poses are sampled every 0.5 simulation seconds, with exact frames at command/event boundaries. A reserved final summary retains the outcome and totals even if detailed recording fills; the viewer distinguishes final totals from recorded coverage. Limits preserve the recorded prefix and show omitted evidence; storage failures leave gameplay running and appear in diagnostics. Limits apply per session, so remove old local session/replay folders when no longer needed. Replay never changes live drone sensors or exposes player information to agents.

## Economy and combat

New matches use **cargo-v2**. Each team begins with 30 shared salvage and each drone with one free armor charge, empty module slots and a free cargo grip. Four outer caches hold 60 salvage each; the central depot holds 600. Crates are matte yellow/ochre on dark pallets, with broad black cargo symbols and marked loading aprons. Stock is finite, the opening bases have no resource piles, and empty pallets remain visible.

Pickup requires the drone center over the marked apron, 0.6–2.4 local units above its surface, moving at most 0.3 local units per simulation second for three simulation seconds. One interval fills available capacity from available stock, with atomic reservations and partial final loads. The free grip carries 30 salvage; the cargo module carries 60. Loaded maximum speed is 20% lower. Cargo becomes shared credits only after two simulation seconds of the same low/slow service at a friendly base. Cancelling loading releases stock; cancelling unloading keeps cargo. Accessible crash-site drops can be collected by either team; inaccessible cargo is recorded lost.

Bases use team-painted aprons, three pad marks, a service cabinet and the cargo symbol. Friendly service occupancy means the drone center is horizontally inside the painted footprint and 0–6 local units above its surface. Fitting equipment and paid rearming use this volume. Cargo unloading retains its narrower low/slow conditions and can overlap timed rearming. Resource/base props do not add solid collision geometry.

| Item or service | Cost | Behavior |
| --- | ---: | --- |
| Free grip | 0 | Carries one 30-salvage crate, no module slot. |
| Cargo module | 30 | Carries 60 salvage total, one slot. |
| Gun | 30 | Initially contains 12 rounds; physical camera-aimed shots, cover and friendly fire. |
| Optics | 30 | Wide/zoom projection, no object identification or extra world knowledge. |
| Armor | 20 | One replacement armor charge, outside module slots. |
| Rearm | 10 | Refills to 12 rounds after eight uninterrupted simulation seconds at friendly service. |

Two module slots accept gun, cargo and optics. Fitting/replacement requires friendly service occupancy and explicit replacement without resale refunds. Refitting creates no free ammunition. Batteries, mining drills, upgrades and jamming are unavailable in new matches; historical recordings keep their original equipment meaning.

Rearming reserves payment and grants no ammunition before completion. Movement commands, translation, firing, refitting, damage, a received replacement objective, destruction and Stop cancel it with exactly one refund. Looking, camera mode, radio, waiting and unloading may continue. Ordinary chat does not cancel service or flight.

Flight has no endurance limit. New matches have no battery charge, drain, recharge service, battery attachment or power-loss death. Historical cargo-v1 and cube recordings retain their original battery state and death causes.

One armor charge absorbs one collision or bullet, then is lost. A protected collision stops movement and generates generic local collision/armor-loss feedback; bullet absorption gives generic hit/armor-loss feedback. Alerts reveal no attacker, obstacle identity or impact coordinates. Unprotected contacts with terrain, buildings, drones or bullets are lethal. Cargo may remain recoverable at a valid crash site. Eliminated drones lose all tool access and cannot respawn; last-team-standing victory and simultaneous-elimination draws remain unchanged.

These are initial simulator balance values. Historical cube-economy playtests do not validate cargo hauling or balance. The common briefing teaches recognition, rules, vehicle calibration, private radio and the need for actual teammate agreement on an initial plan, first item and purchaser. It does not assign tactics, roles, equipment, routes or reporting schedules.

## Actor tools and sensors

Each living drone has `observe`, `act`, `send`, `wait`, `route`, `workspace`, `routine`, `transfer`, `exchange` and the initially available `buy`. Gun unlocks `fire`/`rearm`; optics unlocks `camera`. Equipment removal revokes corresponding capabilities. There is no active `mine` or `jam` tool.

| Tool | Effect |
| --- | --- |
| `observe({})` | Fresh own acquired pixels, timestamped telemetry and unread events. |
| `act({mission,kind,...})` | Asynchronous absolute local waypoint, heading/camera aim or physical braking/hover; optional travel/precision profile and explicit replacement. |
| `send({mission,to,kind,text,data?})` | Team radio; blue alone may address `player`. All peer text, including `status`, stays in the received inbox until actual bundle inclusion. |
| `wait({timeout_ms})` | Relevant local/mail event, cancellation or bounded timeout. |
| `route({mission,op,waypoints?,profile?,replace?,job_id?})` | Start/status/cancel up to 32 ordered caller-chosen waypoints. |
| `workspace({mission,op,path?,content?})` | Private atomic list/read/write/delete/stat. |
| `routine({mission,op,path?,input?,replace?,job_id?})` | Start/status/cancel an isolated, bounded QuickJS module. |
| `transfer({mission,operation,to?,path?,transferId?})` | Offer/list/status/import/cancel bounded inert peer file transfers. |
| `exchange({mission,operations})` | Up to eight compatible operations with per-entry outcomes and one aggregate fresh bundle. |
| `buy({mission,item,replace?})` | Atomically fit an allowed item to the caller inside friendly service. |
| `fire({mission})` | Spend a round along actual camera aim; no target ID or hidden hit answer. |
| `rearm({mission})` | Begin timed magazine replenishment. |
| `camera({mission,mode})` | Select wide/zoom with equipped optics. |

The versioned onboard observation adds own velocity, measured camera orientation, calibrated finite range sensing and explicit sequence/freshness to own position, heading, timestamp and camera. Frame-associated pose remains the acquired pose; newer current telemetry is separately labeled. One local unit represents ten meters, X is east, Y up, Z south, and heading is clockwise from north. Camera output is 512×288 with 76° vertical field of view (32° zoom), and pitch reaches a true downward -90°. No body roll/pitch dynamics are invented.

Directional proximity uses 26 fixed finite beams with declared swept-sphere coverage; an independent downward sensor supplies range. Readings are anonymous distances with validity/coverage, never object IDs or world contact coordinates. Where extra sensing padding overlaps a nearby obstruction but the airframe is clear, the sensor reports a narrower footprint that still protects the full physical radius; this lets drones retreat from overlapping guard shells. Local assistance brakes/holds on obstruction or stale/unsupported coverage; it chooses no alternative route and does not provide collision immunity. The travel profile limits speed to 3 local units/s and acceleration to 6; precision uses 0.8 and 3. Loaded speed applies the cargo multiplier. This calibration describes simulated controls, not measured aircraft performance.

Own cargo/loading/unloading progress, service inactivity reasons, equipment/ammo, jobs, storage and shared balance are allowed feedback. Resource/base locations, enemy state, map geometry, arbitrary raycasts and future observations remain private. Pixel visibility and actual received messages are the only ways to learn battlefield facts.

Command admission and physical completion are different. One movement writer owns each drone; replacements are explicit. Ordered routes stop when blocked; routines fail or cancel on their enforced limits. Optional `observation_sequence` and `event_cursor` associate commands with actually delivered input. Mission versions are checked at admission and execution. Objective changes cancel only when that drone receives them; ordinary player/peer chat does not. Stop/death/capability loss invalidate affected work. Radio partitions leave valid local work running.

Every direct tool or aggregate exchange delivers one fresh acquired camera bundle and the next unread event slice, including eligible mail arriving during capture. Event slices use a 128 KiB budget; `hasMore:true` means more unread events remain for the next tool result or `wait`. The 1 MiB logs/cache partition reserves 512 KiB for unread local events and 512 KiB for rotating diagnostics, separate from the 4 MiB native radio quota. Batches return separate accepted/rejected/queued outcomes and do not roll back completed side effects. A wait or camera acquisition must not hold command admission or prevent cancellation. Models receive input at supported tool/next-turn boundaries; finishing private reasoning is not an injection point. Catalog changes request a natural turn yield after the existing fresh bundle, then resume the same actor with refreshed tools and history.

See [ONBOARD.md](ONBOARD.md) for private files, SDK syntax, package accounting and execution limits. [IMPLEMENTATION-VERIFICATION.md](IMPLEMENTATION-VERIFICATION.md) records current checks and outstanding autonomy gates. The [implementation handoff](DRONE-RTS-IMPLEMENTATION-HANDOFF.md) specifies the current revision; [STRATEGY-PLAN.md](STRATEGY-PLAN.md) remains earlier design evidence.

## Architecture and verification

[ARCHITECTURE.md](ARCHITECTURE.md) maps ownership. [CITY.md](CITY.md) describes private battlefield layout and the separate vehicle calibration; [CINCINNATI-SOURCES.md](CINCINNATI-SOURCES.md) records geographic evidence and approximations. [NETWORK.md](NETWORK.md) and [MAVLINK.md](MAVLINK.md) describe the native protocols. [AGENTS.md](AGENTS.md) gives development constraints. The current [QA handoff](QA-HANDOFF.md) prioritizes the reproduced braking failure, decision latency and remaining autonomy gates, with an offline reproduction command.

`server/team-session.ts` composes two isolated three-drone networks, two native parents and one six-vehicle MAVLink helper. Each team's drone bridges connect directly in peer mode, with an operator bridge carrying only that team's objectives and chat. Separate network UUIDs, roles, endpoints and durable SQLite stores isolate radio traffic. Network lab controls simulate a drone partition by closing/reopening its Zenoh session. This is real loopback protocol traffic; RF propagation, aerodynamic flight and a full autopilot remain outside the PoC. Missing dependencies or helper failure explicitly stop the session, with no silent in-memory gameplay fallback.

```sh
npm test
npm run build
npm start
```

`npm test` includes deterministic RTS rules, camera isolation, real Zenoh/MAVLink helpers and runtime policy without inference. The build checks TypeScript and creates the production bundle; `npm start` serves it. Restart the dev server and reload camera pages after changing renderer/shared source so the compiled and server fingerprints agree. Set `FLEET_PORT` for another port, `CODEX_BIN` if the installed CLI cannot be found, or `FLEET_PYTHON` for a configured Python interpreter.

Before a server restart or trial, inspect `/api/state` and preserve an active player session on port 4317. Start an isolated server with `FLEET_PORT=4318` for QA. `node --import tsx scripts/verify-rts.ts` exercises the deterministic browser fixture without starting model inference. `node --import tsx scripts/playtest-rts.ts` runs the bounded two-team Luna/xhigh live trial with an open browser and stops the test fleet afterward. Read [RTS-PLAYTEST.md](RTS-PLAYTEST.md) for the actual tested revision and results; deterministic physics success and autonomous model success are separate claims.

`node --import tsx scripts/verify-replay.ts` separately checks actual browser images, live recording append, scrubbing, playback, event navigation and camera isolation through local replay HTTP APIs. Its no-inference fixture includes cargo delivery, service, neutral QuickJS execution and inert archived source, plus an explicitly historical equipment frame. It keeps its data under `artifacts/test-runs/<run-directory>/`. Both deterministic browser scripts accept `FLEET_QA_PORT` when another checkout already owns 4318; start an owned idle server with the matching `FLEET_PORT`. [REPLAY-VERIFICATION.md](REPLAY-VERIFICATION.md) records historical replay validation; [STRATEGY-VERIFICATION.md](STRATEGY-VERIFICATION.md) records a historical economy milestone.

Test runners and `npm test` save raw output in a new `artifacts/test-runs/<run-directory>/`. After the process exits, only the newest run is retained across test kinds, including failed runs; active runs are protected. Analyze a live trial before starting another test. Related checks may share an active managed run through `FLEET_TEST_RUN`; its owner performs cleanup after all children finish. `FLEET_QA_OUTPUT`, when used, must name a new direct child of `artifacts/test-runs/`. Checked-in historical reports remain; old raw recordings are deliberately pruned. Player session archives outside the managed test directory are not swept. Historical browser fixtures verified batteries, charging, radio interference, power loss and recorded operational state under their recorded rules; they do not launch gameplay inference or substitute for native-network tests. [ENDURANCE-VERIFICATION.md](ENDURANCE-VERIFICATION.md) records that earlier milestone's checks and their limits.

Focused evaluation has separate deterministic and autonomous commands:

```sh
node --import tsx scripts/measure-controls.ts
node --import tsx scripts/playtest-focused.ts haul-single
node --import tsx scripts/playtest-focused.ts haul-team
node --import tsx scripts/playtest-focused.ts flight
node --import tsx scripts/playtest-focused.ts aim-stationary
node --import tsx scripts/playtest-focused.ts aim-moving
node --import tsx scripts/playtest-focused.ts encounter
node --import tsx scripts/playtest-focused.ts encounter-reversed
node --import tsx scripts/playtest-focused.ts match
node --import tsx scripts/analyze-trial.ts artifacts/test-runs/<run-directory>
node --import tsx scripts/analyze-haul.ts artifacts/test-runs/<run-directory>
node --import tsx scripts/analyze-engagement.ts artifacts/test-runs/<run-directory>
node --import tsx scripts/analyze-decision-latency.ts artifacts/test-runs/<run-directory>
```

`measure-controls.ts` runs 34 prescribed cargo-v2 flight, finite-sensor braking and ballistic fixtures with synthetic camera placeholders and no inference; actual contact damage is checked separately in the automated tests. All `playtest-focused.ts` modes **launch real Luna/xhigh inference**. Run them individually; each command owns its test server and requires a camera browser within 60 seconds. The default is [port 4318](http://127.0.0.1:4318). Set `RTS_TRIAL_PORT` to another free port when a different checkout owns 4318; player port 4317 is forbidden. The runner checks 4317, 4318 and the selected port, and refuses any existing server at its selected port. The defaults are 180 wall seconds for focused trials and 480 for a match; `RTS_TRIAL_SECONDS` accepts 30–600. Time includes native actor startup. Normal completion, time limit, Stop and signals stop the owned fleet and server. Other servers are preserved.

Flight uses the normal opening with a flight-only operator objective. Aiming fixtures position three visible pairs above the city and grant blue guns; red receives either a holding or a repeated-flight objective. Fixture objectives supply no battlefield coordinates or enemy telemetry; all actors retain the common vehicle calibration. Moving targets choose their own waypoints and can pause between commands, so a hit during that trial does not necessarily mean a hit on a moving target. `match` uses the production opening, equipment and missions. The test host disables other UI mutations except Stop.

`haul-single` designates one blue hauler and holds the other five drones; `haul-team` lets all three blue actors choose their logistics while red holds. Both use normal stock, bank and equipment, with no supplied resource positions, routes or helpers. Haul trials default to 300 wall seconds, adjustable within the same bounded range. Prove a fresh single haul, repeat it, then demonstrate useful overlapping team work with delivered income before running another full battle. `analyze-haul.ts` reports conservation, deliveries, contact events, actual radio, script/transfer use and storage. Its motion/service overlap counts alone do not establish useful cooperation.

`encounter` gives both teams guns, equal camera offsets and the same combat objective, with movement and aiming chosen by the drones. `encounter-reversed` swaps the teams' starting positions and viewing directions. These fixtures help separate close combat from exploration and purchases; allowing movement does not guarantee the actors will move.

Each live trial saves its source manifest, fixture description, audit, actual camera replay and result under ignored `artifacts/test-runs/`. `analyze-trial.ts` calculates flight distance, delivered arrivals, shots, physical contacts and pre-shot camera age from those files. It separates expired shots from projectiles still unresolved when the match stops; target speed is estimated from recorded poses. Analysis refuses a checkout whose `shared/rts.ts` differs from the saved calibration, preserving existing results. Replay is watchable in Admin while the test host is running. Raw evidence is local; the measured outcomes and limitations are recorded in [RTS-PLAYTEST.md](RTS-PLAYTEST.md).

`analyze-engagement.ts` separately measures team proximity, exploration, geometric camera opportunities and acquisition/delivery/next-command timing. It uses saved optics and buildings, verifies the relevant geometry/renderer source hashes and reports sampled-pose age. An unobstructed projected body center is a viewing opportunity, not proof that a drone recognized an enemy. Post-delivery time includes response transport, model processing and tool dispatch; it is not a direct measurement of private reasoning.

Session audits and screenshots are local under ignored `artifacts/`; temporary isolated Codex settings are cleaned up on Stop and never change the user's standing configuration. Earlier `PLAYTEST.md`, `NETWORK-PLAYTEST.md`, `CITY-PLAYTEST.md` and review reports document previous treasure-hunt revisions, not proof of current RTS behavior. Regenerate city geometry with `node scripts/build-city.mjs` after geographic source edits and preserve the displayed OpenStreetMap attribution.

`analyze-decision-latency.ts` reports retained model-result text bytes by field, actual image bytes, exact range-table duplication/sharing, backend token reports, acquisition delivery time, completed-tool-to-next-call distributions and compaction boundaries. It separates sampled motion/job/service activity from stationary gaps; holding may be intentional in focused fixtures. An optional trailing number (for example `300`) restricts measurement to that many wall seconds after match startup and writes `decision-latency-300s.json`, keeping the full report separate. Image/text bytes are not tokenizer counts, and native aggregate usage does not attribute tokens to individual fields. Single-run timing differences do not establish causality.
