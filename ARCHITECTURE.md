# RTS ownership and observation boundaries

A match has two teams of three drones, two mechanical native parents and one authoritative simulator. Every gameplay actor uses Luna/xhigh. The blue and red runtimes start independently with clean actor contexts. Each parent relays the team's queued original text without planning; each drone chooses its own movement, mining, spending, aiming and peer messages.

## One concept, one owner

| Concept | Owner | Boundary |
| --- | --- | --- |
| Fleet and team membership | `shared/fleet.ts` | Explicit blue/red rosters and globally unique vehicle IDs. `MATCH_FLEET`/`MATCH_DRONE_IDS` cover six actors; `DEFAULT_FLEET`/`DRONE_IDS` remain the three-member blue/default transport roster. Use `teamForDrone` rather than inferring team from array order. |
| Geographic world | `shared/city.ts`, generated `shared/city-data.json` | Sourced buildings, roads, parks, river and unequal municipal extents. `scripts/build-city.mjs` converts checked-in source data. No geography enters actor tools. |
| Match layout | `shared/battlefield.ts` | Six clear starting poses, finite salvage placements and initial player camera focus. `CITY.spawns` derives from these poses. |
| RTS contracts and tuning | `shared/rts.ts` | Team, equipment, economy and projectile types plus simulator-only prices, rates and physical constants. |
| Economy, combat and victory | `server/rts.ts` | Shared-wallet transactions, asynchronous finite mining, attachments, armor consumption, physical bullets, death and last-team-standing resolution. Durable state lives in `GameState.match` and drone records. |
| Swept combat geometry | `server/rts-geometry.ts`, `server/world-geometry.ts` | Moving sphere contacts and oriented building/ground intersections used by collisions, projectiles and occlusion. |
| Private resource evidence | `server/resource-vision.ts` | Records only deposits visible in an actually delivered image with current mission/time and clear line of sight. `mine` selects from this private evidence; it does not accept a target coordinate or disclose candidates. |
| Flight response | `server/drone-motion.ts` | Velocity, acceleration, braking, shortest-arc turns and actuator limits. The simulator applies damage/collision to the proposed motion. |
| Drone optics | `shared/camera-profile.ts` | Shared actual-capture and visibility calibration. Observer camera optics are independent. Calibration never enters actor prompts or tool descriptions. |
| Game/tool orchestration | `server/game.ts` | Authoritative player state, simulation steps, per-team/per-drone mission delivery, role-bound tool execution and fresh sensor/inbox bundles. Delegates RTS rules and private visibility. |
| Team session composition | `server/team-session.ts` | Two native runtimes, two independent radio namespaces, six-vehicle MAVLink adapter, progressive tool refresh, dead-actor retirement and joint shutdown. |
| Durable radio | `server/network.ts`, `network/peer*.py` | Each network has only one team's validated roster, a distinct UUID and separate peer processes/stores. Native Zenoh carries bytes; SQLite owns retry, expiry, ACKs and deduplication. |
| Vehicle wire protocol | `server/mavlink.ts`, `network/mavlink.py` | Six UDP endpoint pairs with unique system IDs, reference MAVLink 2 parsing and private frame conversion. Only accepted decoded controls reach physics. Mining, purchases and firing are simulator actions, not invented MAVLink commands. |
| Native actor hosting | `server/runtime*.ts` | Model verification, isolated settings, clean child bootstrap, role tokens, policy enforcement and dynamic MCP tool lists. Parents have only the mechanical relay; drone tools unlock from game-owned capabilities. |
| Browser composition | `client/scene.ts` | One renderer serves six feeds, tactical map, explorer and truthful sensor captures. Display interpolation is never used for capture. |
| Physical visual state | `client/drone-model.ts`, `client/drone-visuals.ts`, `client/combat-view.ts` | ID-keyed bodies, equipment, visible damage, finite salvage and projectile geometry. Snapshot capture temporarily applies the captured world state and restores presentation afterward. |
| Player information | `client/match-panel.ts`, `client/overhead-map.ts`, `client/fleet-panels.ts` | Team banks, resource meters, combat events, map markers and cards are spectator DOM overlays, outside camera images. |
| Invisible observer | `client/explorer.ts` | Independent free camera with altitude-sensitive travel; does not create a unit or change its sensors. |
| Diagnostics | `server/diagnostics.ts`, `shared/diagnostics.ts`, `client/admin.ts` | Bounded/redacted local audit queries, evidence types and admin UI. Available reasoning summaries are distinguished from unavailable hidden reasoning. |
| Application lifecycle | `server/index.ts` | HTTP/WebSocket connections, capture delivery, match startup/stop, browser disconnect timeout and protocol/runtime failures. |

## Team and actor isolation

`GameState` is the omniscient player/browser contract. It is never an actor observation. A drone receives only its own position, heading, timestamps, actual camera pixels and unread local events/messages. Own equipment and unlocked team balance are permitted interaction receipts; opponent poses, opponent equipment, resource coordinates, map bounds and combat calibration are not. Camera pixels may naturally show other drones, buildings, signs, salvage and projectiles.

Both teams receive the same initial elimination/resource objective. Subsequent UI missions target blue only. `TeamSession` routes player messages to the selected team's operator bridge and teammate messages only to that team's native network. Each recipient adopts a mission when the real network delivers it. A partition never grants a drone a new mission early. Network namespaces and membership checks isolate this local experiment; they are not cryptographic peer authentication.

The initial MCP list contains `observe`, `act`, `send`, `wait` and `mine`. A team's first recovered salvage unlocks `buy`; a drone's gun unlocks `fire`. Server capability checks still reject unavailable operations even if a client guesses a tool name. Death removes tool access, stops motion and mining, disconnects that drone's peer and interrupts its native actor. Match completion stops both sessions and all protocol helpers.

A successful shot follows camera aim and a gravity arc through swept collisions; it cannot target an enemy ID or obtain a hidden hit answer. Mining needs recent private optical evidence and physical reach; it cannot probe arbitrary resource IDs. The old `server/treasure-hunt.ts` remains a historical isolated module with its own regression tests and no active role in RTS scoring.

Keep one authoritative copy of poses, equipment, credits, resources, projectiles and mission versions. Display interpolation, velocity and private sightings are derived or purpose-specific internal state. Changes to damage rules should not require rewriting MAVLink parsing, mailbox delivery or camera composition.

## Verification

`npm test` covers finite shared mining, purchasing races, dynamic tools, armor/ram/building/ground impacts, ballistic hits and misses, elimination, resource evidence, camera boundaries, team/runtime isolation, real Zenoh/MAVLink helpers, diagnostics and unit identity. `npm run build` validates shared TypeScript contracts and the production bundle.

With an idle isolated server on port 4318, `node --import tsx scripts/verify-rts.ts` exercises the actual browser through a deterministic fixture. `node --import tsx scripts/playtest-rts.ts` separately runs bounded real two-team Luna/xhigh inference with browser cameras. Both preserve active player sessions on port 4317. [RTS-PLAYTEST.md](RTS-PLAYTEST.md) records current evidence; earlier treasure-hunt/network reports remain historical and do not validate subsequent RTS changes.
