# Ownership and extension boundaries

The current game remains one team of three equal drones hunting six chests. The parent relays the player's original instructions to exactly those three Luna/xhigh actors. The modules below separate the concepts that will change when the game gains opposing teams, resources and equipment. Combat, inventory and a multi-team match runtime are not implemented yet.

## One concept, one owner

| Concept | Owner | Boundary |
| --- | --- | --- |
| Fleet membership and vehicle identities | `shared/fleet.ts` | The validated default roster supplies IDs, labels, colors and MAVLink system IDs. Runtime roles, transport workers and presentation derive their membership from it. Python helpers receive the roster explicitly and validate it at their process boundary. |
| Geographic world | `shared/city.ts`, generated `shared/city-data.json` | Bounds, buildings, roads, river, launch poses and intersection candidates. `scripts/build-city.mjs` owns conversion from the checked-in geographic sources. Geography does not place chests or award discoveries. |
| Treasure-hunt rules | `server/treasure-hunt.ts` | Layout selection, launch/reset behavior, private visual evidence, report qualification, attribution and completion. It uses explicit geometry inputs and returns player results. |
| Flight response | `server/drone-motion.ts` | Velocity, acceleration, braking, shortest-arc turns and actuator limits. Controller state stays private; `FleetGame` applies collision checks to the proposed translation. |
| Solid geometry queries | `server/world-geometry.ts` | Swept intersection against oriented building volumes, shared by flight and visual occlusion. |
| Drone optics | `shared/camera-profile.ts` | The renderer, capture metadata and objective visibility use the same optical profile. Explorer optics are independent. Calibration never enters agent prompts or observations. |
| Game/tool orchestration | `server/game.ts` | Authoritative public state, simulation steps, mission epochs, role-bound tool execution and the sensor/inbox delivery boundary. It invokes motion and objective owners rather than embedding their rules. |
| Durable radio delivery | `server/network.ts`, `network/peer*.py` | Each `FleetNetwork` has an explicit roster and network namespace. Native Zenoh transports bytes; the peer store owns retry, expiry, acknowledgements and deduplication. |
| Vehicle wire protocol | `server/mavlink.ts`, `network/mavlink.py` | Per-roster UDP endpoint pairs, MAVLink validation and frame conversion. Only decoded accepted commands reach the simulation. |
| Agent hosting | `server/runtime*.ts` | Model verification, isolated Codex configuration, native child bootstrap policy and MCP access. It does not choose missions or own game rules. |
| Browser composition | `client/scene.ts` | Shares a renderer across feeds, overview, explorer and sensor capture. Display interpolation is never used for a sensor capture. |
| Unit display lifetime | `client/drone-visuals.ts`, `client/pose-buffer.ts` | Mesh reconciliation and pose interpolation join by drone ID. Missing units are removed and disposed; reordered snapshots cannot exchange identities. Temporary sensor-scene changes are restored even when capture fails. |
| Player map and explorer | `client/overhead-map.ts`, `client/explorer.ts` | Map projection, markers, destinations and entry controls; independent invisible free-camera movement. These overlays do not become drone observations. |
| Presentation metadata | `client/drone-presentation.ts` | Resolves roster labels/colors for feeds, markers and cards, with deterministic presentation for additional unit IDs. |
| Per-unit player panels | `client/fleet-panels.ts` | Reconciles feed cards, map summaries and network controls by ID and binds each to its own telemetry. |
| Diagnostics | `server/diagnostics.ts`, `shared/diagnostics.ts`, `client/admin.ts` | The server owns bounded/redacted evidence access; the shared module owns API types and categories; the browser owns navigation and presentation. Available reasoning summaries are distinguished from unavailable hidden reasoning. |
| Application lifecycle | `server/index.ts` | Composes game, transports, runtime, HTTP and camera connections; starts and stops them together. |

`GameState` is the player/browser state contract, not an agent observation. Avoid maintaining a second authoritative copy of drone poses, treasure progress or mission versions in a subsystem. Display history, velocity and private evidence are purpose-specific derived or private state.

## Growing into an RTS

Introduce match/team membership at the composition boundary when multi-team gameplay is implemented. Use globally distinct unit IDs within a match; presentation and interpolation already join by those IDs rather than array positions. The current Cincinnati launch poses are scenario data, so larger playable fleets also need explicit spawn placement and lifecycle handling in the simulator and agent host. Changing the transport roster alone does not create a playable multi-team match.

Construct each team's `FleetNetwork` with only that team's roster, a distinct `networkId` UUID and its own peer processes/stores. Teams may share the enclosing game `sessionId`; the network ID separates their radio topics and storage. The network adapter already supports a roster per instance; do not route opposing-team messages through one shared broadcast roster. Namespace and membership checks provide local experiment isolation, not cryptographic peer authentication. Match ownership must also bind each role's tools and observations to its own team.

Add resource, equipment and damage rules as focused simulator owners when those rules exist. Let them consume accepted actions, simulation time and explicit world inputs, and publish authoritative state changes. Keep wire decoding, sensor delivery, presentation and objective rules separate. For example, changing the victory condition should replace the hunt's report/completion behavior without changing MAVLink parsing or mailbox delivery. An equipment-driven camera change must resolve through the same optical profile used by rendering and private visibility.

A removed unit must be retired in all authoritative owners: its actor/tool access, motion, inbox, transport and match state. Browser removal is already handled, but it does not itself terminate an agent or decide death. This keeps rendering from becoming an accidental gameplay authority.

## Verification boundaries

`npm test` checks simulation behavior, optical edge agreement, private scoring, sensor isolation, unit identity/lifetimes, roster validation, real Zenoh/MAVLink helpers, runtime policy and diagnostic pagination/redaction without model inference. `npm run build` checks the shared TypeScript contracts and production bundle.

With an idle isolated server on port 4318, `node --import tsx scripts/verify-ui.ts` exercises the actual browser, map/explorer controls, sensor captures, diagnostics, mobile layout and reset. The fixture blocks inference. Live Luna/xhigh trials remain separate and must preserve an active player session on port 4317.
