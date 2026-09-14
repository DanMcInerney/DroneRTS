# DroneRTS development

This is a standalone Git repository for a local Three.js drone swarm game. The current world is a simple model of downtown Cincinnati with hidden treasure chests. Read [README.md](README.md) for setup and the current architecture; [CITY.md](CITY.md), [NETWORK.md](NETWORK.md), and [MAVLINK.md](MAVLINK.md) describe their respective components.

## Run and verify

- Install JavaScript dependencies with `npm ci` and Python helpers with `npm run network:setup`. Node 22+ is required; Python 3.12.4 is the tested interpreter. Python dependencies belong in `.venv`.
- `npm run dev` serves the game at `http://127.0.0.1:4317`. `npm run build` checks TypeScript and creates the production bundle; `npm start` serves that bundle.
- `npm test` runs the automated suite, including real Zenoh and MAVLink helper integration tests, without model inference. Run relevant tests and the build after implementation changes.
- Live gameplay also requires an installed, signed-in Codex CLI and an open browser to provide camera images. Launch fleet starts the agents; Send transmits the mission text. A fleet waiting for its first instruction can be quiet.
- All gameplay actors and live playtest agents must use **gpt-5.6-luna / xhigh**, per the user's cost preference. Do not silently substitute another model or reasoning effort. This preference is scoped to gameplay/playtesting.
- Before restarting a server or launching a test mission, inspect `/api/state`. Preserve an active player session on port 4317; use an isolated server with `FLEET_PORT=4318` for automated live trials. Keep live trials bounded and stop the test fleet/server afterward.
- Use the Codex sidebar browser for watchable playtests when available. The user has also authorized isolated Playwright as a fallback. Do not start inference merely to validate documentation or a folder move.

## Preserve the experiment

- The parent session mechanically forwards the player's original instructions to exactly three native drone subagents. It does not plan, assign search areas or solve the mission.
- Each drone learns through its own camera, local XYZ position, heading and timestamp, plus received peer/player messages. Position is simulator-local XYZ, not latitude/longitude. There is no roll/pitch sensor.
- Keep map geometry, treasure locations, scoring rules, movement scale/speed, axis conventions, camera field of view and future observations out of drone prompts and tool responses. These facts may exist in developer documentation and renderer/simulator code; gameplay agents run in an isolated directory without access to them.
- Preserve fresh sensor/inbox bundles at drone tool boundaries, asynchronous movement and waits, durable peer mail, and per-drone mission versions. A model's private reasoning cannot be interrupted to inject input.
- Peer traffic uses native Zenoh connections and the vehicle adapter uses MAVLink 2 packets. Keep failures explicit; do not introduce a silent in-memory fallback for live gameplay. Loopback peer connections simulate partitions but are not a physical RF mesh or a full autopilot.
- Player-visible scores and world state are not agent observations. Treasure credit must require the existing private visual/proximity evidence and radio report, without exposing a scoring oracle to the drone.
- Preserve OpenStreetMap attribution and documented approximations when editing the city. Source evidence is in [CINCINNATI-SOURCES.md](CINCINNATI-SOURCES.md); regenerate `shared/city-data.json` with `node scripts/build-city.mjs` after source-data changes.

## Local data

Keep credentials, `.env` files, `.runtime`, `artifacts`, `.venv`, dependencies and build output out of Git. Existing playtest/review reports describe their tested revisions; they are not proof of later changes. Raw session artifacts are intentionally local and may not exist in a fresh clone.
