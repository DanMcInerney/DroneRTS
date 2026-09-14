# DroneRTS

A local Three.js treasure hunt with a square world enclosing Cincinnati, a detailed downtown core, three FPV cameras, an overhead map, an invisible explorer and a diagnostics dashboard. One real Codex session launches three native drone subagents. The parent forwards player instructions; the drones choose their own movements and communicate through a small radio protocol.

All four gameplay actors are configured as **gpt-5.6-luna / xhigh**. The runtime checks the installed model list before starting inference and does not substitute another model.

Open this repository's root folder as your development workspace. [AGENTS.md](AGENTS.md) provides the project context, development commands and sensor boundaries for a coding agent continuing the work. [ARCHITECTURE.md](ARCHITECTURE.md) maps concept ownership and extension boundaries for future teams, resources, equipment and combat.

## Run

Requires Node.js 22+, Python (tested with 3.12.4), and an installed, signed-in Codex CLI. Development used Node 24.15.0 and Codex CLI 0.144.0 on Windows. Python dependencies live in the project `.venv`; no operating-system mesh configuration is changed.

```sh
npm install
npm run network:setup
npm run dev
```

Open **http://127.0.0.1:4317**, start the fleet, and send:

> Find the treasure chests scattered around the city. Fly close enough to inspect each chest with your camera, then report it to the fleet using a found radio message. Share discoveries and coordinate your search.

Keep the browser open: it supplies the camera images. The simulator pauses when the browser disconnects, and the runtime stops after ten seconds without a browser. Stop halts motion and shuts down the native agent session and protocol helpers. Reset restores the initial world while stopped. A new instruction crosses Zenoh; each drone adopts its version, hovers and rejects old commands when that drone actually receives it. An isolated drone keeps its last received mission until another valid instruction arrives or the player stops the fleet. Message expiry removes undelivered contents; it does not automatically cancel an already accepted mission.

The objective is to discover six chests at random mapped downtown street intersections. Reset moves all six to different intersections; Launch preserves the selected layout and clears discovery progress. A nearby clear camera observation followed by a `found` radio report credits a discovery. The player sees progress; agents receive neither hidden target positions nor scoring thresholds or completion events. The city uses mapped streets/footprints and researched landmark heights, with simple rectangular massing. See [CITY.md](CITY.md) for implementation and [CINCINNATI-SOURCES.md](CINCINNATI-SOURCES.md) for geographic evidence and approximations.

The overhead map beneath the cameras shows the entire world, drone headings and destination lines. **Downtown** zooms to the detailed building area; **Entire map** restores the full square. Click a location to enter **God view**: WASD moves, Q/E changes altitude, Shift increases speed, mouse or arrow keys look around, and Esc returns to the flight deck. This invisible camera never becomes a drone or changes its sensors. Outside downtown, terrain and the sourced winding rivers provide a simple geographic backdrop, not a complete building model of every neighborhood.

Click **Admin** to inspect live fleet health and current or historical session logs. Filter by category or actor, search, expand source JSON, pause the feed or export. New sessions record sampled Zenoh payloads and acknowledgements, CRC-validated MAVLink hex/decoded packets, tool arguments/results, and reasoning summaries the runtime provides. Hidden model reasoning is unavailable; older logs may lack the newer fields. Credentials and camera images are redacted. Drone cameras continue servicing agents while Admin or God view is open.

```sh
npm test
npm run build
npm start
```

`npm start` serves the production build. Set `FLEET_PORT` to choose another port. Set `CODEX_BIN` only if the runtime cannot find the installed CLI.

## Components

- `client/`: instanced Cincinnati buildings/streets, treasure props, three cameras and player interface.
- `shared/city.ts`, `shared/city-data.json`: renderer/simulator-only city layout, generated from `city-research.json`.
- `server/game.ts`: simulation/tool orchestration, role-bound sensors, radio and mission versions.
- `server/drone-motion.ts`, `server/world-geometry.ts`: accelerated movement/turning and swept building collision.
- `server/treasure-hunt.ts`: randomized placement, private visual evidence and discovery rules.
- `shared/fleet.ts`, `shared/camera-profile.ts`: fleet membership/vehicle identities and renderer/simulator optical calibration.
- `server/diagnostics.ts`, `client/admin.ts`: bounded local audit browsing and the admin dashboard.
- `server/mailbox.ts`: asynchronous event delivery using cursors.
- `server/runtime*.ts`: Codex app-server integration, isolated native agent configuration, MCP endpoints and bootstrap policy.
- `server/index.ts`: local HTTP/WebSocket server and lifecycle.
- `shared/types.ts`, `shared/diagnostics.ts`: browser/server state and diagnostics contracts.

The Node process owns the world, renderer connection and model runtime. Three independent Python drone bridges exchange messages through native **Zenoh peer-mode TCP connections**, with a fourth operator bridge publishing player instructions. No central Zenoh router carries peer traffic. Each bridge has its own SQLite inbox/outbox, receipt acknowledgements, retries, expiry and duplicate suppression. A separate Python MAVLink helper has three controller/vehicle UDP endpoint pairs; actual MAVLink 2 packets carry commands and position/heading telemetry. The simulator acts on decoded wire values. See [NETWORK.md](NETWORK.md) and [MAVLINK.md](MAVLINK.md).

The Network lab controls close or reopen each drone's Zenoh session to simulate a partition. Sensor and vehicle-control links remain local, and messages queue while disconnected. This exercises real protocols on loopback, not an RF mesh, radio propagation, a full autopilot or aerodynamic physics. Gameplay never silently falls back to the old in-memory transport; missing dependencies or helper failure stop startup/the session. Pure unit tests retain an in-memory seam.

## Agent interface

The parent has `forward_next_instruction()`. It waits for queued player text and publishes it verbatim through the operator Zenoh bridge after the three drone agents are ready. Its receipt acknowledges local queuing; disconnected recipients receive the instruction after reconnecting if it has not expired.

Each drone has:

| Tool | Effect |
| --- | --- |
| `observe({})` | Refresh the common sensor and inbox bundle. |
| `act({mission,kind,...})` | `fly_to` an absolute waypoint, `look` in a direction, or `hover`. |
| `send({mission,to,kind,text,data?})` | Send a `chat`, `found`, `claim` or `done` packet. |
| `wait({timeout_ms})` | Sleep until unread mail, a controller event, or a timeout of up to 30 seconds; then return the common bundle. |

Every running drone tool response, including recoverable command errors, automatically returns all unread events and exactly four sensor fields: `position`, `heading`, `timestamp`, and `camera`. Position is simulator-local XYZ, **not GPS latitude/longitude**. Heading is a local compass reading in degrees, not a tilt measurement. Timestamp contains acquisition UTC (`capturedAt`) and elapsed simulation time (`simTime`). The camera is an actual image content block, paired with the sampled position and heading; failed captures explicitly report unavailable. No roll/pitch sensor, hidden targets, bounds, ground plane, field of view, speed, or pad scoring data is exposed.

Movement is asynchronous: `act` acknowledges acceptance, and an eventual `arrived` or `blocked` event wakes `wait`. Each drone's tools are serialized while other drones continue independently. Mail is drained after image capture, so messages arriving during capture are included too. A bridge acknowledges receipt after durable SQLite acceptance; inclusion in a model tool response marks the local record consumed. This is not proof the model understood it or exactly-once delivery across a model/server crash. Independent worker restart recovery is tested, but the app stops the fleet on helper failure rather than automatically resuming it. Arbitrary private reasoning cannot be interrupted with fresh context. Mission validity is checked again after MAVLink transit to prevent a command crossing a local mission replacement.

If an action completes or the mission changes during image encoding, the bridge captures once more before delivery. Controller events include their own occurrence time; the bundle also carries delivery time, so later events are distinguishable from the image's acquisition time. Refresh is bounded rather than waiting indefinitely for a perfectly simultaneous network-wide state. Command receipts retain `commandMission` when a newer mission arrives. Rejected waypoint and camera-limit experiments are normal controller feedback with fresh bundles; they do not trigger the fatal tool-error counter.

The radio envelope is `fleet-radio/1`, with a unique session ID, message ID, sequence, role-bound sender, destination, kind, mission, UTC send time and simulation time. `chat`, `found`, `claim` and `done` are peer conventions. Lower drone ID resolves competing claims once the agents learn about them; no central planner allocates work. A queued send is not a receipt from every peer; inspect pending counts and the audit for delivery status. Player text and peer messages both use Zenoh. The player sees actual sent messages, not private reasoning. UUID namespaces and loopback restrictions isolate this local experiment; cryptographic peer authentication is future work.

Developer-only simulator geometry: Y is up. Internal yaw 0 faces negative Z and positive yaw turns left; HDG and `look.heading` use the opposite sign, wrapping to 0–360. Positive `look.pitch` tilts the camera up, but pitch is not a returned sensor. Flight accelerates and brakes at up to six units/s², with a three-unit/s cruise limit. Heading turns through the shortest arc at up to 180°/s; pitch is limited to 120°/s, both with eased angular acceleration. Retargeting and hover brake smoothly; Stop or a delivered new mission clears motion immediately. Browser feeds interpolate with a 100 ms display delay at up to 60 fps. Sensor captures always render the requested actual pose directly. These relationships are absent from agent instructions and the isolated runtime cannot read this README. This remains a simple controller, not aerodynamic physics.

## Session evidence

The server writes `artifacts/session-*.jsonl` during live runs. Logs include model verification, native child startup, tool usage, observations and radio packets. Camera image payloads and credentials are excluded. Session data and dependencies are ignored by Git. The runtime creates a temporary isolated Codex configuration and cleans it up when stopped; it does not edit the user's standing Codex settings.

Historical review and playtest reports describe local development runs. Their raw session logs, screenshots and `runtime-spike-evidence.json` remain local and are not included in this repository. The checked-in scripts can produce fresh evidence on a configured machine; live trials use the locally signed-in Codex account.

For browser verification without inference, serve an idle game on port 4318 and run `node --import tsx scripts/verify-ui.ts`. Its isolated Playwright page uses a test-only `FleetGame`, checks held keys, pointer lock, sensor isolation, diagnostics and reset, and saves results/screenshots to `artifacts/ui-verification`. It never launches Codex.

The interface and continuous simulation remain responsive while the language models think. Agent decision latency varies. The simulation-speed slider changes flight speed, not inference speed. Idle event-wait timeouts may still cause another model step, so use Stop when finished.

To reproduce the bounded live browser trial, keep the development server running and execute `npx tsx scripts/playtest.ts`. Install its isolated test browser with `npx playwright install chromium` if needed. This starts real Luna/xhigh inference and stops it after the mission and lifecycle checks; screenshots and logs go into a dated `artifacts/playtest/run-*` directory. See `PLAYTEST.md` for actual results and `REVIEW.md` for independent findings and their repair record.

The newer network trial uses an isolated server on port 4318 and `npx tsx scripts/playtest-network.ts`. It checks disconnect/reconnect behavior with real Luna/xhigh agents. See `NETWORK-PLAYTEST.md` for that run and `NETWORK-REVIEW.md` for the network review and telemetry-failure repair.

Those earlier trial reports describe the previous world. The current city trial uses port 4318 and `npx tsx scripts/playtest-city.ts`; see `CITY-PLAYTEST.md`. Rebuild the checked-in city layout with `node scripts/build-city.mjs`. Its OSM-derived geographic data retains attribution and source IDs; the interface displays the OpenStreetMap credit.
