# DroneRTS implementation handoff: onboard agents, cargo and constrained scripting

**Subsequent rules change:** the user-authorized cargo-v2 revision removes batteries, charging and power-loss deaths from new matches. Its current contract is in [README.md](README.md); the battery requirements below describe the earlier cargo-v1 handoff.

Prepared September 14, 2026. **This is an implementation specification, not a report of completed features.** This session writes documentation only. Use this as the primary handoff for the next chat. It consolidates [the gameplay plan](DRONE-RTS-NEXT-SESSION-PLAN.md) and [the researched protocol addendum](ONBOARD-LIBRARIES-AND-PROTOCOLS.md); those remain supporting evidence. Where the plans differ, this document supplies the latest storage and agent-runtime decisions.

**Feedback/performance refinement:** read [the Gemini brief assessment and execution contract](ONBOARD-FEEDBACK-REFINEMENT.md) with sections 2–5 below. It specifies small command batches, automatic feedback at supported agent boundaries, continuous local control, command leases, measured timing targets and corrections to unverified library-footprint/FPS claims. These are proposed interface changes; current actor permissions are unchanged until the corresponding implementation/rules revision lands.

**Complete implementation scope:** this handoff includes the earlier map-graphics, resource placement/recognition, physical hauling, equipment economy, coordination and replay recommendations alongside the onboard-computer work. Section 1 owns the gameplay/visual design, sections 2–5 own sensing/control/storage/networking, and sections 6–8 own coordination, implementation order and verification. Use the linked research for supporting technical detail; it does not replace the gameplay work.

## Start here

Implement a simple, watchable three-versus-three logistics RTS. Each drone has its own onboard agent, private observations, small persistent workspace, local flight controller and peer radio. Drones discover finite salvage, carry it home, spend shared income and fight using the existing simplified game weapon. Roles and tactics emerge from their choices, equipment and actual conversations.

The player commander is only a blue-team chat participant: send messages and receive replies. Do not build a command hierarchy, central planner, voting system or elaborate commander UI.

**Deliberate hardware exemption:** assume each drone can run its chosen agent/model locally. A model can actually execute on the host or through a remote inference service; treat that as its simulated onboard brain. Do not model the feasibility, weight, power, thermal load or disk footprint of that inference engine and its model weights. Preserve real decision/tool latency, failures and each actor's isolation. This exemption does not grant unlimited script storage, libraries, image processing, messaging or control throughput.

“Any agent” means the architecture should accept compatible agent backends through the same bounded interface. It does not mean an agent gets arbitrary host tools or a teammate's state. Keep the existing Codex backend first and retain **gpt-5.6-luna / xhigh as the default for gameplay and playtests**. Make backend/model configuration explicit; never silently substitute a model. Do not spend this iteration implementing multiple providers. Any future provider must pass the same observation, tool and lifecycle checks.

Other deliberate game simplifications remain: finite salvage as the single currency, simplified aircraft physics and weapons, idealized first-version state estimation, and initially basic radio faults. Describe these honestly; an architectural realism score is not evidence of physical flight readiness.

## Baseline and boundaries

Repository at preparation: `C:\Users\danhm\.codex\worktrees\5eed\DroneRTS`. The checkout contains substantial unrelated uncommitted work. Inspect status and preserve it. Read `AGENTS.md`, `README.md`, `ARCHITECTURE.md`, `CITY.md`, `NETWORK.md` and `MAVLINK.md` before editing implementation.

Current capabilities include actual per-drone camera images, local XYZ/heading/time, native Zenoh team messaging, real MAVLink 2 parsing around a custom game controller, asynchronous single-target movement, starting armor and roughly five/ten-minute battery endurance. Current gaps include no private script workspace, no route queue, sparse telemetry, automatic bank-on-mining instead of cargo delivery, and an operator bridge that cannot receive ordinary drone conversation.

The latest analyzed trial at `artifacts/focused-trials/2026-09-14T16-48-54-374Z-match/` ran about 480 seconds: 47 peer messages, two gun purchases, zero mined salvage and zero shots. One protected environment contact and two friendly collision incidents occurred. Collision-associated decimal waypoints survived MAVLink decoding exactly; coordinate rounding did not explain them. Median image-delivery-to-next-command time was about 6.1 seconds. See `RTS-PLAYTEST.md` and the earlier plan for the tested source manifest and limits. Raw artifacts may be absent in another checkout. This evidence motivates better local control and a proven collection loop before another full battle.

Preserve:

- Two isolated teams of three clean-context drone actors. Existing native parents remain mechanical relays: no planning, assigning jobs or selecting equipment. Use the six-member match roster for match-wide operations.
- Own observations and actual delivered messages as the only gameplay knowledge. Player maps, resource coordinates, enemy state, internal collision geometry, developer files and future frames stay private.
- One resource, finite conserved value, atomic shared purchases, two module slots, separate one-hit armor, friendly fire, physical aiming and last-team-standing victory. No respawns or second victory currency.
- Native Zenoh and MAVLink failures remain explicit; no silent in-memory replacement in live gameplay.
- Fresh sensor/inbox bundles at model tool boundaries, per-drone actually received mission versions, and cancellation on death/Stop/reset. Model reasoning itself cannot be interrupted to insert a message.
- OpenStreetMap attribution and shared visual/collision geography. Historical replays and reports keep their original rules and meaning.

This design intentionally supersedes old restrictions against exposing the vehicle's calibration or private code storage, the cube-mining economy, and the old miner shop. Update conflicting `AGENTS.md`, interface documentation and tests as each corresponding feature lands. Do not preserve an obsolete restriction by quietly making the new feature ineffective.

## 1. Physical salvage and readable scenery

Use matte industrial yellow/ochre crates on dark pallets with a broad black symbol repeated on top and sides. Put them on painted loading aprons at road intersections. Make the usable apron large enough for all three separated drones; do not require alignment with a tiny individual crate. No glow, beams, floating labels or outlines through buildings.

| Rule | Initial game value |
| --- | --- |
| Opening team bank | 30 salvage; one basic module purchase |
| Standard load | One crate worth 30 salvage |
| Free cargo grip | One crate on every drone, no module slot |
| Cargo module | Two crates total |
| Pickup | Automatic low, slow hover over a loading apron for 3 simulation seconds |
| Delivery | Automatic low, slow hover over a friendly base apron for 2 simulation seconds |
| Loaded travel speed | 20% below unloaded maximum; no extra payload battery rule initially |
| Outer resources | Four caches, 60 salvage each |
| Central mega resource | One depot, 600 salvage; about 71% of total stock |

These are proposed balance values, not physical measurements or proven balance. Define the low-hover band, speed threshold and footprint once in shared contracts, render the corresponding apron, and explain the service conditions in the vehicle interface. Pickup fills available cargo capacity from available stock in one service interval; reserve each selected crate atomically. Partial remaining stock can fill a partial load. Do not restart loading when already full. Own feedback explicitly distinguishes `loading`, `carrying`, `unloading` and `charging`, including progress and the reason an attempted service is inactive. A drone should not have to guess whether it must land. Feedback describes its current interaction, never the location of a nearby depot.

Stock becomes cargo at pickup and becomes team credits only on completed delivery. A cancelled load releases reservations. A cancelled delivery retains the cargo. No repeat pickup/drop cycle creates money. On carrier destruction, unbanked cargo may settle at its actual crash site if an accessible valid surface exists; otherwise it is lost. Either team can recover accessible dropped cargo. Do not teleport it to a convenient depot or disclose a drop locator to actors. Reset starts a new rules instance; Stop must not duplicate or bank cargo.

Use a simple attached gripper, without rope or swinging-load simulation. Carrying cargo does not disable the existing gun; capacity, equipment slots and reduced speed supply the tradeoffs. Keep resources finite with no regeneration or passive income in this revision. Increase total stock later only if measured matches justify it.

The central depot should sit at the central intersection or an immediately connected open plaza, with three loading positions, multiple approaches and surrounding cover. Its loading apron should be visible from more approach directions than the outer caches, so collecting the larger stock involves exposure. Compare usable routes from both bases against the actual geometry; do not claim symmetry merely from straight-line distance. Outer caches begin outside the initial camera views, on accessible intersections/aprons clear of building footprints. Central abundance drives repeated trips and contention after the small outer caches empty; no capture timer, richer currency or passive ownership income.

Stock, empty pallets and carried crates must reflect authoritative state: visible stock shrinks at pickup, cargo appears beneath the carrier, and the carried prop disappears on delivery. Cargo props must not become accidental collision traps. Bases use team-painted aprons, three pad marks and a charging cabinet; repeat the cargo symbol where deliveries belong. Preserve automatic free charging on friendly charging-volume occupancy, including while moving, and retain charge gained when leaving. Loading/unloading separately require the stated low/slow conditions. Charging can overlap unloading and timed rearming. Keep existing endurance: about five minutes of normal flight, ten with a battery pack; fitting a pack does not create charge. A low-charge alert is useful, but the controller must not choose an automatic return route for the agent.

Above-roof scouting reveals more top surfaces through ordinary visibility, while making the scout visible from more positions. Greater altitude also makes objects smaller in the image. Use finite resolution and occlusion; do not give a guaranteed high-altitude resource detector. Identify a useful recognition altitude band empirically from acquired camera views; do not hardcode altitude-triggered discovery or teach a preferred scouting altitude to the actors.

The graphics workstream should deliver the following, using shared authoritative state and camera fixtures:

| Visual area | Implementation direction |
| --- | --- |
| City materials | Separate asphalt, sidewalks, walls and roofs through broad color/value differences. Simplify repetitive facade/window detail that becomes noise at drone-image resolution. |
| Geometry | Preserve Cincinnati's sourced street layout, skyline and rotated/tiered building shapes. Visual surfaces and collision geometry must agree. Never widen roads only in the renderer or add decorative collision clutter. |
| Light and grounding | Add restrained shadows/contact grounding where they help judge height and obstacles. Profile the six acquired camera feeds before adopting a lighting change; avoid effects that obscure crates or overexpose markings. |
| Resource readability | Use broad top/side markings and recognizable pallet/crate shapes. An empty depot remains visibly empty. No tiny text dependency or floating identification overlay. |
| Drone identity | Use broad blue/cyan or red panels on bodies and arms, visible from oblique and overhead angles. Keep recognition based on pixels rather than automatic friend/enemy labels. |
| Interaction readability | Match marked horizontal footprints to usable aprons and show all three service positions clearly. Share vertical service-band definitions with controller rules and interface documentation. |

Keep the shop centered on flexible equipment, with two module slots plus separate armor:

| Equipment/service | Cost and behavior |
| --- | --- |
| Basic cargo grip | Free, no slot; one crate |
| Cargo module | 30 salvage, one slot; two crates total |
| Optics | 30 salvage, one slot; existing wide/zoom projection, no automatic identification |
| Gun | 30 salvage, one slot; existing physically aimed weapon with 12 rounds |
| Battery pack | 30 salvage, one slot; doubles capacity and normal flight endurance without supplying charge |
| Armor | One free charge at launch; replacement costs 20, outside module slots |
| Rearm | 10 salvage; refill to 12 rounds after eight uninterrupted simulation seconds at friendly service; preserve cancellation and exactly-once reservation refund |

Fitting/replacing equipment requires friendly service occupancy. Keep explicit replacement without a resale refund and no free ammunition or battery refill from refitting. A team begins with enough funds for one basic module, so first ownership remains a shared decision. Replace miners/upgrades with cargo for new matches, and defer jamming from the first simplified ruleset while preserving historical equipment/replay interpretation. Do not expand weapon types during this work.

## 2. Onboard architecture and observation contract

```text
Each isolated drone
  agent/model backend                 [inference hardware abstracted]
       |
  bounded tools + private files
       |
  QuickJS routine / local vehicle SDK
       |                           |
  sensor reads + control requests   team radio API
       |                           |
  MAVLink vehicle adapter           native Zenoh peer
       |                           |-- two teammates
  continuous local controller       `-- simple player chat (blue only)
       |
  authoritative simulation
```

Tool access is local to the simulated drone. The peer radio carries communication between drones. MAVLink represents the vehicle interface. A disconnected team radio does not stop the onboard agent, its camera or its current valid flight job. A failed local controller link is a separate fault with local hold/failure handling.

Sensors are read-only. Controls are validated requests; an actor cannot set its reported position, charge, collision status or measured sensor values. Both direct tools and authored scripts use the same permissions and authoritative game operations.

Expose own position and velocity, heading, measured camera orientation, charge/capacity, cargo, equipment, job state and finite local range readings. Provide axes, units, camera calibration and actuator limits: this is knowledge of the vehicle, not of the battlefield. Current world geometry uses one game unit per ten meters; initially preserve geometry and expose a clearly documented conversion. Do not relabel existing values as meters without converting. Audit vehicle size and service spacing before making scale claims.

Add a downward range sensor and short-range directional proximity sensors, with explicit coverage and unavailable/out-of-range states. These are modeled new sensors, not capabilities automatically supplied by MAVLink. Return distances and validity, not obstacle/resource/enemy IDs or world coordinates. A stable camera should reach a true downward view. Do not invent body roll/pitch dynamics that do not exist.

Every sample needs acquisition time, coordinate frame/units, sequence and freshness/validity. Keep frame-associated pose distinct from newer current telemetry. The routine consumes a continuous own-state estimate; the model receives fresh bundles at tool boundaries. Coalesce high-rate state but preserve discrete collision, cargo, job and mail events. Start with declared idealized state estimates; defer noise/drift until basic tasks work.

Do not expose arbitrary pixel-to-world raycasting, a hidden resource locator, automatic target classification or a global pathfinder. Agents may derive estimates from pixels, calibration and their own observations, and share them as estimates.

## 3. Local control, command batches and scripts

Add generic local braking/holding based only on the modeled finite-range observations. Nearby drones are anonymous physical obstructions. An occupied destination or stale required coverage produces a stopped/blocked report, rather than repeated acceleration into a teammate. The agent chooses another route. This is local assistance, not global navigation or projectile avoidance. Actual contacts can still consume armor or kill an unarmored drone.

Use one command-job mechanism for bounded ordered routes and authored routines. Start returns immediately with a job ID. Distinguish accepted, running, blocked, completed, cancelled and failed. A route step completes before the next step; camera and messaging can operate while moving. Allow a documented travel/precision movement profile without selecting a route for the agent. One movement writer owns the vehicle. Replacing it explicitly cancels prior movement; tool and script commands cannot race silently.

Add a small application-level batch (initially eight operations) for compatible submissions with one aggregate fresh sensor/inbox result. Return per-operation outcomes, never imply rollback of completed side effects, and put dependent actions in an ordered job/routine. Keep admission separate from waits, camera encoding and transfer completion so cancellation remains responsive. Local routines consume continuous telemetry; the model gets fresh input at actual supported tool/turn boundaries, not at an assumed mid-thought interruption. Attach originating observation/event identifiers and revalidate critical state before execution. Finite velocity leases are renewed by healthy local execution, never by requiring the thinking model to emit high-rate keep-alives. Details and measurements are in the linked refinement.

Validate capability and mission version both at submission and execution. Stop/reset, death, power loss, a newly received objective and invalid capabilities cancel affected work. Armor loss stops movement; obstruction stops the route pending a new decision. No old queued shot, purchase, cargo transition or movement can execute afterward. Ordinary peer/player chat does not replace the objective or cancel a job.

Add a virtual `workspace` interface for list/read/write/delete/stat and a `routine` interface for start/status/cancel. Permit Markdown, JSON and small JavaScript modules. Each drone can build its own reusable helpers and notes. Provide short examples of SDK syntax, such as caller-supplied waypoints or reading a sensor; do not preload scouting, hauling, targeting or role strategies.

Use one isolated QuickJS runtime per drone behind a terminable worker/process boundary. No host shell, filesystem, environment, credentials, repository access, sockets, arbitrary package installation, native processes or unrestricted module loader. Ordinary Node `vm` is not the isolation boundary. The SDK exposes own sensors/images, permitted controls, job events, private files and actual team radio only. Existing toy firing remains gated by equipment, physical aim, ammo and cooldown; add no enemy-ID aiming or hidden hit receipts.

Initial configurable runtime limits: one active routine, one movement owner, at most 32 route steps, 32 MiB guest heap, bounded host buffers/handles, and enforced CPU and wall-time limits independent of model inference. Begin with a 20 ms uninterrupted guest slice and a 250 ms guest CPU budget per wall-clock second per drone; measure under six-drone load and tune explicitly. Async waiting yields. Bound host callbacks, pending promises, image work and SDK rates separately; guest interruption alone cannot constrain host work. Fail with a specific reason and clean up safely without freezing physics or other actors. Log the actual configured limits in each trial manifest.

The model can observe, send messages, edit a future routine or cancel while a routine runs. Running code uses an immutable version/hash until explicitly replaced. Preserve fresh mail and sensing at model boundaries without acquiring a new camera image on every internal script operation.

## 4. Small onboard disk: concrete first profile

Use a **16 MiB managed application-storage partition per drone**, divided below. This is a tunable simulation profile, not a claim that all real drones have 16 MiB of total disk. KiB/MiB use powers of 1024. Fixed flight firmware/OS and host simulator infrastructure are outside this application partition and must be identified as such; it is not a complete board-image measurement. The model engine/weights are separately exempt under the explicit inference assumption.

| Partition | Hard budget | What counts |
| --- | ---: | --- |
| Read-only application runtime and built-ins | 8 MiB | Deployed QuickJS runtime assets, its deployed wrapper/loader, SDK, allowlisted application libraries and required notices/metadata |
| Private workspace | 2 MiB | Authored/imported scripts, Markdown/JSON notes, saved sensor files, filenames/metadata, retained versions and persistent compiled caches |
| Durable radio mail | 4 MiB | Inbound/outbound payloads, per-recipient state, deduplication records and persistent delivery metadata |
| Transfer/transaction staging | 1 MiB | Partial library transfers, temporary replacement files and attributable database transaction/WAL space |
| Local logs/cache | 1 MiB | Bounded onboard diagnostic history and disposable cached content |

Do not silently borrow from another partition or enlarge these limits at runtime. Expose own usage/free bytes and partition-specific errors through a compact storage status, so agents can manage their own files. Storage should constrain accumulation and reuse, not require constant deletion for ordinary small routines.

Additional limits: **64 KiB per workspace file**, **256 workspace files**, and **256 KiB combined optional guest-library payload**, within the corresponding partition ceilings. SDK/runtime assets remain inside the 8 MiB read-only ceiling. Count UTF-8 bytes or actual binary bytes, not characters or tokens. Cap names and metadata too. No arbitrary npm/pip imports. Start with a tiny SDK and optionally a selected gl-matrix bundle; add no OpenCV by default.

Build a versioned onboard package manifest recording artifact path, version, hash, license and installed bytes. Measure deployed artifacts and all transitive application dependencies, not an advertised gzip size, source-repository size or guessed upstream footprint. A host-provided function implementing an optional drone library must have its corresponding deployed implementation/runtime assets charged to the manifest; do not hide a large image-processing library behind a zero-cost SDK function. Document the existing Zenoh/pymavlink bridges as fixed vehicle/network platform infrastructure, outside guest imports, rather than falsely claiming their full Python/OS deployment fits this partition. If an application package exceeds its allowance, omit or reduce it and report the result; do not quietly raise the cap.

The exact deployment split is a simulator abstraction. Host Node/Python, renderer, development dependencies, replay archives and external inference infrastructure are not files a drone can use as free storage. A separate complete hardware-image footprint is outside this iteration. The constraint being tested is a small bounded programmable application environment.

Storage semantics:

- Writes, imports and replacements are atomic. Preflight the final allocation and temporary peak allocation; failure leaves the old file intact. Retained old code versions and compiled caches consume their real allowance. Loaded runtimes have separate RAM limits and cannot keep unlimited deleted versions alive.
- Inbound code remains inert in staging until all chunks and the content hash verify. Import requires recipient choice and available workspace space. Move ownership/accounting atomically from staging to workspace; count any real temporary copies. No compression/archive support initially, and no automatic execution.
- No automatically synchronized team folder. An imported copy costs space on each recipient. Content-addressed deduplication is allowed only for actual identical stored bytes and must preserve ownership/isolation; do not use it to grant unread remote content.
- Durable unread mail is never silently evicted. On capacity exhaustion, reject admission before a storage receipt/ACK and report backpressure to the sender, whose bounded outbox can retry until expiry. Quota reservation, persistence and receipt generation must agree. Reserve a small bounded portion of the mail budget for objective/control traffic so script transfers cannot occupy everything; do not claim this guarantees delivery over a disconnected link.
- Bound deduplication retention by the supported retry/expiry lifetime; do not remove a tombstone while an accepted retry could still recreate a side effect. Expired mail, delivered outgoing payloads and consumed incoming payloads may be collected according to documented retention. Keep the identifiers needed for deduplication within quota.
- Enforce bounded backing-store growth as well as logical payload quotas. Include SQLite indexes, metadata and transient WAL/checkpoint space in the documented accounting. Test actual disk growth under sustained retries, duplicates and writes. A separate host audit copy is permitted for replay but must never refill the actor's memory or inbox.
- Local logs/cache may rotate. Do not silently delete authored files, unread messages or an active transfer to make room. Return actionable storage-full errors; agents choose which authored files to delete. Expired or cancelled transfers release staging space.
- Unsaved sensor frames may pass through bounded RAM buffers without a disk charge; saving them consumes workspace bytes and respects file limits. Streams cannot become an unbounded hidden history. Model conversation context remains the backend's finite context window, not a host archive-retrieval tool or a shared scratchpad.
- Workspaces survive turns/catalog refreshes within a match. A new match starts empty; destruction revokes access. Host replay may retain bounded archival copies, but later actors cannot read them. Cross-match learned libraries remain a separate future experiment.

## 5. Libraries and communication protocols

Keep [Zenoh](https://zenoh.io/docs/getting-started/deployment/) for peer messaging and [pymavlink](https://github.com/ArduPilot/pymavlink) for the existing vehicle adapter. Add [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) for private routines; optionally add a pinned, bounded [gl-matrix](https://github.com/toji/gl-matrix) subset for neutral vector/rotation math. Verify Windows compatibility, licenses and measured installed size before adopting versions. No package was installed by this handoff session.

[OpenCV.js](https://docs.opencv.org/4.13.0/d4/da1/tutorial_js_setup.html) is deferred: its standard WASM-based build is not a drop-in stock QuickJS guest module, and a bounded worker bridge still has a storage/runtime cost. Add selected image operations only when evidence justifies them and their full attributed artifacts fit. Defer MAVSDK/ROS/full autopilot migration; the current MAVLink endpoint implements a small simulator profile, not a complete autopilot.

Keep two isolated four-peer Zenoh networks: three drones plus each existing operator bridge. Give the blue operator ordinary group/direct receive and send support; keep the red automatic objective bridge and independent actors. Ordinary player chat cannot access red. Global UI Stop is host cleanup, not a radio message that somehow crosses a partition.

Use the existing JSON message format plus only necessary versioning/identity metadata: match/network, bound sender and boot identity, sender sequence, stable message ID, recipient(s), kind, timestamps/expiry, optional reply/proposal revision, and text/data. Sender identity is host-bound; a topic namespace is not cryptographic authentication. Keep messages small. Retain short chat limits and use bounded low-priority chunks for code instead of sending huge scripts in ordinary chat. Shared plan content and reporting schedules remain agent-authored.

| Traffic | Delivery behavior |
| --- | --- |
| Chat, objective changes, explicit coordination replies | Bounded durable storage, expiry, retry/backoff, per-recipient receipts and deduplication |
| Agent-selected own status | Latest value with short lifetime; stale coordinates do not replay as current after reconnect |
| Scripts and larger notes | Size-announced, bounded lower-priority chunks, content hash, receipt/completion state and explicit import; obey sender/receiver quotas |

Distinguish **queued locally**, **stored by recipient**, **included in an agent tool bundle**, **explicitly answered**, and **requested action completed**. Storage receipts do not establish understanding or agreement. Duplicate deliveries are possible; deduplication and idempotent effects provide correct local behavior. A disconnected broadcast recipient must not prevent others receiving it.

Likewise, an accepted vehicle command is not proof of arrival. Standard MAVLink command ACK behavior does not apply to every setpoint message; keep this simulator's setpoint echo documented as an adapter convention. Stable application command IDs and received mission versions belong in the job layer, not invented MAVLink fields. [MAVLink command protocol](https://mavlink.io/en/services/command.html)

Label simulation time separately from monotonic host time. First protocol trials run at fixed 1x without pause. Use monotonic host time for transport retry/expiry and runtime CPU/deadline budgets; use simulation time for physics and game service timers. Define freshness for paused/stalled sensors explicitly instead of marking old images fresh because simulation time stopped. Record both acquisition and delivery timing. Before supporting speed/pause in these trials, test and document how each deadline behaves.

Initially test real native delivery, bounded queueing, delay and whole-peer partition/reconnection. Later add a single controlled link layer for repeatable connection availability, latency and bandwidth. Apply faults before application receipt/ACK, and ensure native traffic cannot bypass a simulated cut. Do not drop arbitrary TCP stream bytes to imitate RF packet loss. Full physical RF propagation, packet-level mesh routing and automatic relaying are deferred; loopback Zenoh alone proves none of them. Local flight/routines continue during radio loss.

## 6. Coordination without prescribed strategy

Teach the objective, visual recognition, pickup/delivery/charging conditions, vehicle calibration, equipment rules, tool syntax, storage limits and communication semantics. Keep the opening request to agree through actual peer replies on an initial plan, first item and purchaser before departure/purchase. Allow messages to reference a proposal/version without prescribing the proposal's content.

Do not assign permanent villager/scout/attacker roles, a leader, routes, purchases, radio schedules, target priorities or solved libraries. Shared delivered income, scarce opening funds, visible cargo, limited equipment and physical service capacity make coordination useful. Message counts earn nothing. A scout's report, a safe arrival or a reusable helper matters only if another drone receives and uses it successfully.

Optional own-status broadcasts and notebook entries must be chosen by agents and based on their observations/messages. A notebook can record estimated positions, observation time, source and confidence; its author chooses the contents. Purchase receipts may be shared through actual peer messages, and receipt of a report does not turn an estimate into ground truth. No automatic shared map, teammate camera feed or omniscient team notebook. The player may write tactical instructions through ordinary blue chat; the system briefing itself remains about playing the game.

The intended coordination benefits are measurable consequences: a received scouting report can reduce another drone's search time; separated approaches can reduce waiting and collisions; recovering a loaded carrier preserves purchasing power; and reusing a received helper can reduce repeated work. These are opportunities supplied by the mechanics, not plans injected into actor prompts. Do not add points for messages, a fixed division of labor or online-training claims. Defer voting/budget-reservation machinery, base destruction and replacement airframes until a separate design decision.

For watchability, extend existing spectator/replay surfaces with actual cargo state, service/job progress, delivered income, radio delivery stages, script versions and storage usage. Record executed SDK calls and cancellation reasons alongside immutable source hashes/versions, within bounded replay storage. Replays display historical code and evidence; they never execute archived scripts. Show only observed/reported plans as such, rather than inventing an authoritative team strategy. These player diagnostics remain outside drone inputs and do not require a larger commander system.

## 7. Implementation order and bounded parallel work

1. **Baseline and shared contracts.** Inspect the dirty checkout and existing evidence. Define versioned cargo/apron state, own telemetry, job lifecycle, workspace/storage quotas, message classes and agent-backend boundary before parallel edits. Record simulator settings and proposed behavior separately from historical results.
2. **Graphics alongside local sensing/control.** Use the previously requested graphics subagent for the section-1 material/lighting, depot/base, drone-recognition and camera-fixture deliverables. Use agreed fixture state until authoritative cargo lands; remove fixture-only state from live rendering at integration. Another bounded workstream can add own telemetry/local braking after shared contracts exist. The lead owns shared types and integration; establish disjoint editing ownership.
3. **Prove one physical haul.** Implement reservations, pickup, cargo rendering, delivery, conservation, destruction recovery, simplified shop and updated rules briefing. Remove obsolete mining tools from the new active ruleset and update recognition/service instructions consistently. Prove discovery-to-delivery before broader scripting/network expansion or economy tuning.
4. **Jobs and constrained onboard workspace.** Add the route runner, measured package manifest, per-drone storage ledger, QuickJS/SDK, atomic files, termination and code/version replay. Keep the current backend and default model. Prove a neutral routine without giving it a solved game strategy.
5. **Quota-aware radio and library sharing.** Add traffic-class behavior, queue accounting, stale status coalescing, chunked inert transfers and ordinary blue-player replies. Prove partition/backpressure behavior while local execution continues. Add bounded link latency/bandwidth only after these basics work.
6. **Integrate and evaluate.** Run relevant deterministic tests/build and camera QA, then bounded autonomous single-haul, team-haul and full-match trials in that order. Tune values only from evidence. Preserve historical reports and label fixture-assisted results.

Likely ownership: `shared/rts.ts`, `shared/types.ts`, `shared/battlefield.ts`, `server/rts.ts` and `server/game.ts` for contracts/economy; `server/drone-motion.ts`, `server/mavlink.ts` and `network/mavlink.py` for control/sensors; `server/runtime-tools.ts`, `server/runtime.ts`, `server/runtime-mcp.ts` and new focused modules for agent/workspace/runtime; `server/network.ts` and `network/peer*.py` for native messaging/storage; `client/scene.ts`, `client/city-scene.ts`, `client/combat-view.ts` and drone presentation modules for graphics; existing shared/recorder/player replay modules for evidence. Confirm paths and current ownership before edits.

## 8. Acceptance gates and verification

- **Economy:** pickup/reservation/deposit cancellation, simultaneous collection, partial stock, dropped cargo, repeated retries, death, Stop and reset conserve value. Only delivery and authorized spending affect shared credits after initialization. Three separated drones can service together.
- **Visibility:** inspect acquired low/oblique/overhead camera frames, behind-building negatives, partial/empty stock, cargo, both team identities and both bases. Include screenshots at identical poses before/after graphics edits and verify visual/collision agreement. Measure the useful recognition altitude band and six-camera performance. A pretty spectator view alone is not success.
- **Control:** replay occupied-waypoint failures with valid local sensors and verify braking/hold. Cover corners, roof edges, moving obstacles and stale sensing. No global geometry or hidden identities leak through sensor/control feedback.
- **Jobs:** ordered execution, one movement writer, camera/radio coexistence, explicit replacement, accurate acceptance/completion states and no stale actions after lifecycle cancellation. Radio partition does not freeze local execution.
- **Storage/runtime:** measure the deployed manifest; exercise per-file/total limits, Unicode byte counts, many tiny files, failed atomic replacements, retained versions, import duplicates, expired transfers, full mailbox/backpressure, dedup retention, WAL growth and reset isolation. Runaway guest code and slow host operations cannot freeze the simulator. No shell/network/host-state access or hidden storage loophole.
- **Protocol:** duplicate/reordered/expired mail, sender/receiver restart semantics, partial delivery, replayed old status, interrupted code transfer, recipient quota failure, receipt versus comprehension, and blue player send/replies with red access rejected. Explicit objective replacement cancels only after that drone actually receives it; ordinary chat does not.
- **Autonomy:** demonstrate a fresh-context drone identifying, picking up and delivering with no supplied resource coordinates, then repeat. Next show three drones doing overlapping useful work with actual delivered income and received peer messages. Record scripts authored/imported/reused and real storage usage. Only then run another full battle.
- **Honest evidence:** track time to first discovery/pickup/deposit, loads/minute, collisions/prevented contacts, charging trips, time from a received report to useful action, and script reuse. Test that bounded replay exposes the actual versions/actions without executing code or feeding archived knowledge back to actors. These are evaluation metrics, not in-game reward points. Fixtures prove mechanics, not model perception or emergent teamwork.

Run focused automated tests and `npm run build` after implementation changes. Run the broader suite when shared contracts/runtime integration settle; do not rerun all tests after every small adjustment. This documentation task itself needs no tests, package installs or inference.

Before live launches inspect `/api/state`, preserve active player port 4317, and use an owned free isolated port (4318 normally; `RTS_TRIAL_PORT` for `scripts/playtest-focused.ts` when necessary). Use bounded trials, the configured Luna/xhigh default and a camera-providing browser. Use the sidebar browser when available; isolated Playwright is authorized as fallback. Analyze saved evidence before making autonomy claims and stop every owned actor/helper/server afterward. Consult README for current runner commands rather than guessing flags.

## Paste into the new chat

> Implement `DRONE-RTS-IMPLEMENTATION-HANDOFF.md` incrementally in this repository. Read the repo instructions and baseline documents, preserve existing uncommitted work, and begin with shared contracts, the graphics subagent and useful own telemetry/local flight assistance. Prove one autonomous cargo collection-and-delivery loop before expanding to constrained scripts, quota-aware peer library sharing and full matches. Treat the agent/model as an interchangeable simulated onboard brain with inference hardware abstracted, while enforcing the specified small application storage and bounded tools. Keep the commander to simple blue-team chat, preserve private observations and real native peer traffic, and let the drones choose their own tactics and libraries. Use the existing Luna/xhigh gameplay default unless I explicitly select another configuration. Update documentation/tests as each authorized design change lands and report measured results honestly.
