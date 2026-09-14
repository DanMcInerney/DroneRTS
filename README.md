# DroneRTS

A local Three.js RTS in Cincinnati: your blue swarm and an enemy red swarm each have three autonomous drones. Gather finite salvage, share the team's income, choose attachments and eliminate the opposing team. The last team with a surviving drone wins. Both swarms use real native Codex actors, peer-to-peer Zenoh radio and MAVLink 2 vehicle control.

All eight gameplay actors—six drones and two mechanical relay parents—use **gpt-5.6-luna / xhigh**. The runtime verifies the installed model list and never substitutes another model or effort. Each parent starts exactly three clean-context children and forwards its team's instructions unchanged; the drones make the decisions.

## Run a match

Requires Node.js 22+, Python (tested with 3.12.4), and an installed, signed-in Codex CLI. Python dependencies stay in the project `.venv`.

```sh
npm ci
npm run network:setup
npm run dev
```

Open [the local game](http://127.0.0.1:4317) and click **Launch match**. Both teams automatically receive the same elimination-and-resource objective. Use the mission box to send additional instructions to **blue only**. Red continues pursuing its objective independently.

Keep the browser open: it supplies the actual drone camera images. Simulation pauses when the last browser disconnects, and the runtime stops after ten seconds without a browser. **Stop match** halts simulation and shuts down both native sessions and protocol helpers. **Reset match** restores all six drones and every deposit while stopped. Launching again also starts a fresh match with no equipment or credits carried forward. A completed match stops its agents automatically.

The six FPV feeds show each drone's physical view. Each feed has its own outgoing radio transcript below it; scroll back to pause automatic following, then choose **Latest** to resume. The compact header shows both teams' survivors and credits, and the overhead map sits at the bottom of the page. The tactical map, team banks, loadouts, resource counts and combat log are omniscient **player information**. They are not actor observations. **Battlefield** frames the detailed downtown combat area; **Cincinnati** shows the full municipal extent and winding Ohio River. Click the map for invisible **God view**: WASD moves, Q/E changes altitude, Shift speeds up, mouse or arrow keys look, and Esc exits. Outer neighborhoods are schematic flat terrain; only downtown has the sourced building and street reconstruction.

**Admin** opens live fleet health and bounded current/historical session audits. Filter by category or actor, search, inspect JSON or export records. Available runtime reasoning summaries are logged; hidden model reasoning is unavailable. Credentials and camera image payloads are redacted. Camera capture continues while Admin or God view is open.

New sessions also have **Match replay** inside Admin. Select a session, scrub simulation time or play at different speeds, and select a drone to inspect its recorded flight, attachments and actual acquired camera images. The tactical plot includes sampled projectile paths, exact fire/contact endpoints and the last eight seconds of flight trails. Event buttons seek to their timestamps; totals count only evidence up to the selected time. Cameras show acquisition time and age. Missing images and recording gaps are explicit; an old audit file cannot reconstruct a replay.

Replay records stay separate from audit exports under `artifacts/replays/<session>/`: `frames.jsonl`, a status marker and individual camera image files. Each recording is bounded to 32 MiB of data and 64 MiB of images, at most 512 KiB per image, with a bounded asynchronous write queue. Limits preserve the recorded prefix and show omitted evidence; storage failures leave gameplay running and appear in diagnostics. Limits apply per session, so remove old local session/replay folders when no longer needed. Replay never changes live drone sensors or exposes player information to agents.

## Economy and combat

All drones begin unequipped with zero team credits. Salvage deposits stay in fixed locations and deplete as drones mine nearby. Income immediately enters the team's shared bank; there is no hauling or base construction. Two small opening deposits support early decisions, while three richer downtown deposits reward exploration and contested control. An equipped miner gathers three times as fast as a bare drone. Buying is local to the purchasing drone, so teammates must agree who spends the shared bank on which role.

| Attachment | Cost | Effect |
| --- | ---: | --- |
| Gun | 20 credits | Fires a physical projectile along the drone's current camera aim. Shots have travel time, gravity and a firing cooldown; aim and lead matter. Buildings block bullets, and friendly fire is possible. |
| Armor | 12 credits | Absorbs one bullet or collision, then disappears. It can be purchased again after use. |
| Mining tool | 16 credits | Increases resource gathering speed from 1 to 3 credits per simulation second. |

A drone can hold one of each attachment. Unarmored contact with a building, terrain or another drone destroys it. In a two-drone collision, an armored drone survives and loses its armor; an unarmored participant dies. If both have armor, both survive the impact and lose it. A protected terrain impact bounces the drone away. Unarmored bullet hits destroy a drone; armor absorbs one bullet. Eliminated drones cannot act, earn income or respawn during the match. If both teams lose their final drones together, the result is a draw.

The constants in `shared/rts.ts` are simulator/player tuning, not actor instructions. Actors receive no predefined map, movement scale, axis directions, camera calibration, resource locations or combat formulas. They must make observations, experiment and share what they learn.

## Actor tools and sensors

Each drone initially has `observe`, `act`, `send`, `wait` and `mine`. The `buy` tool appears for that team after its first recovered salvage; `fire` appears only for a drone with a gun. Tool availability is enforced by the server as well as advertised through MCP. Destroyed drones lose tool access.

When the available tools change, the next completed tool result asks the drone to finish its current turn. The runtime refreshes the callable catalog while it is idle and resumes the same native actor with its existing history and mission. This transport update adds no tactical guidance, does not drain an extra inbox and does not interrupt private reasoning.

| Tool | Effect |
| --- | --- |
| `observe({})` | Fresh own sensor image and unread events. |
| `act({mission,kind,...})` | Start or replace an absolute local waypoint, a camera aim command or hover. |
| `send({mission,to,kind,text,data?})` | Actual teammate radio using `chat`, `found`, `claim` or `done`. Opponent addresses are unavailable. |
| `wait({timeout_ms})` | Wait asynchronously for unread mail, controller events or a bounded timeout. |
| `mine({mission})` | Gather a nearby, privately camera-observed deposit while in reach. It takes no location or target ID. |
| `buy({mission,item})` | Spend team credits to attach `gun`, `armor` or `miner` to this drone. |
| `fire({mission})` | Fire along the drone's current physical camera aim. It takes no enemy ID or coordinates. |

Every running drone tool response, including recoverable command errors, returns unread events and exactly four sensor fields: `position`, `heading`, `timestamp` and `camera`. Position is simulator-local XYZ, not latitude/longitude. Heading is a local degree reading; there is no roll/pitch sensor. The timestamp pairs acquisition UTC with elapsed simulation time. Camera pixels come from the requested actual pose, never interpolated display history. Failed captures explicitly report unavailable. After the shop unlocks, own equipment and the shared team balance appear as interaction feedback outside the sensor object. No enemy telemetry, resource locator, hit oracle, map bounds or scoring thresholds enter the bundle.

Movement and gathering continue while models think. `act` acknowledges acceptance; arrival, collision, new mission and other controller events wake `wait`. Tool calls are serialized per drone while peers continue independently. Mail arriving during camera encoding is included at delivery; if motion finishes or a mission changes during capture, one bounded refresh captures again. A model's private reasoning cannot be interrupted to inject new information.

Player directives cross the team's native Zenoh network. A drone adopts its new mission only upon actual delivery, then discards old commands and clears movement/mining. A radio-isolated drone retains its last received mission; undelivered messages expire. Stop is a global application lifecycle operation. The parents see only relay acknowledgements, never a map or mission contents to interpret.

## Architecture and verification

[ARCHITECTURE.md](ARCHITECTURE.md) maps ownership. [CITY.md](CITY.md) describes battlefield layout and private calibration; [CINCINNATI-SOURCES.md](CINCINNATI-SOURCES.md) records geographic evidence and approximations. [NETWORK.md](NETWORK.md) and [MAVLINK.md](MAVLINK.md) describe the native protocols. [AGENTS.md](AGENTS.md) gives development constraints.

`server/team-session.ts` composes two isolated three-drone networks, two native parents and one six-vehicle MAVLink helper. Each team's drone bridges connect directly in peer mode, with an operator bridge publishing only that team's instructions. Separate network UUIDs, roles, endpoints and durable SQLite stores isolate radio traffic. Network lab controls simulate a drone partition by closing/reopening its Zenoh session. This is real loopback protocol traffic; RF propagation, aerodynamic flight and a full autopilot remain outside the PoC. Missing dependencies or helper failure explicitly stop the session, with no silent in-memory gameplay fallback.

```sh
npm test
npm run build
npm start
```

`npm test` includes deterministic RTS rules, camera isolation, real Zenoh/MAVLink helpers and runtime policy without inference. The build checks TypeScript and creates the production bundle; `npm start` serves it. Set `FLEET_PORT` for another port, `CODEX_BIN` if the installed CLI cannot be found, or `FLEET_PYTHON` for a configured Python interpreter.

Before a server restart or trial, inspect `/api/state` and preserve an active player session on port 4317. Start an isolated server with `FLEET_PORT=4318` for QA. `node --import tsx scripts/verify-rts.ts` exercises the deterministic browser fixture without starting model inference. `node --import tsx scripts/playtest-rts.ts` runs the bounded two-team Luna/xhigh live trial with an open browser and stops the test fleet afterward. Read [RTS-PLAYTEST.md](RTS-PLAYTEST.md) for the actual tested revision and results; deterministic physics success and autonomous model success are separate claims.

`node --import tsx scripts/verify-replay.ts` separately checks actual browser images, live recording append, scrubbing, playback, event navigation and camera isolation through local replay HTTP APIs. It uses a deterministic duel without inference and keeps its fixture data under `artifacts/replay-ui/`. [REPLAY-VERIFICATION.md](REPLAY-VERIFICATION.md) records replay validation.

Focused evaluation has separate deterministic and autonomous commands:

```sh
node --import tsx scripts/measure-controls.ts
node --import tsx scripts/playtest-focused.ts flight
node --import tsx scripts/playtest-focused.ts aim-stationary
node --import tsx scripts/playtest-focused.ts aim-moving
node --import tsx scripts/playtest-focused.ts encounter
node --import tsx scripts/playtest-focused.ts encounter-reversed
node --import tsx scripts/playtest-focused.ts match
node --import tsx scripts/analyze-trial.ts artifacts/focused-trials/<run-directory>
node --import tsx scripts/analyze-engagement.ts artifacts/focused-trials/<run-directory>
```

`measure-controls.ts` runs 34 prescribed flight and ballistic fixtures with synthetic camera placeholders and no inference. All `playtest-focused.ts` modes **launch real Luna/xhigh inference**. Run them individually, with port 4318 free; each command owns its test server and requires a camera browser at [port 4318](http://127.0.0.1:4318) within 60 seconds. It inspects both local ports first and refuses an existing server on 4318. The defaults are 180 wall seconds for focused trials and 480 for a match; `RTS_TRIAL_SECONDS` accepts 30–600. Time includes native actor startup. Normal completion, time limit, Stop and signals stop the owned fleet and server. Port 4317 is preserved.

Flight uses the normal opening with a flight-only operator objective. Aiming fixtures position three visible pairs above the city and grant blue guns; red receives either a holding or a repeated-flight objective. These objectives contain no coordinates, calibration or enemy telemetry. Moving targets choose their own waypoints and can pause between commands, so a hit during that trial does not necessarily mean a hit on a moving target. `match` uses the unmodified production opening, equipment and missions. The test host disables other UI mutations except Stop.

`encounter` gives both teams guns, equal camera offsets and the same combat objective, with movement and aiming chosen by the drones. `encounter-reversed` swaps the teams' starting positions and viewing directions. These fixtures help separate close combat from exploration and purchases; allowing movement does not guarantee the actors will move.

Each live trial saves its source manifest, fixture description, audit, actual camera replay and result under ignored `artifacts/focused-trials/`. `analyze-trial.ts` calculates flight distance, delivered arrivals, shots, physical contacts and pre-shot camera age from those files. It separates expired shots from projectiles still unresolved when the match stops; target speed is estimated from recorded poses. Analysis refuses a checkout whose `shared/rts.ts` differs from the saved calibration, preserving existing results. Replay is watchable in Admin while the test host is running. Raw evidence is local; the measured outcomes and limitations are recorded in [RTS-PLAYTEST.md](RTS-PLAYTEST.md).

`analyze-engagement.ts` separately measures team proximity, exploration, geometric camera opportunities and acquisition/delivery/next-command timing. It uses saved optics and buildings, verifies the relevant geometry/renderer source hashes and reports sampled-pose age. An unobstructed projected body center is a viewing opportunity, not proof that a drone recognized an enemy. Post-delivery time includes response transport, model processing and tool dispatch; it is not a direct measurement of private reasoning.

Session audits and screenshots are local under ignored `artifacts/`; temporary isolated Codex settings are cleaned up on Stop and never change the user's standing configuration. Earlier `PLAYTEST.md`, `NETWORK-PLAYTEST.md`, `CITY-PLAYTEST.md` and review reports document previous treasure-hunt revisions, not proof of current RTS behavior. Regenerate city geometry with `node scripts/build-city.mjs` after geographic source edits and preserve the displayed OpenStreetMap attribution.
