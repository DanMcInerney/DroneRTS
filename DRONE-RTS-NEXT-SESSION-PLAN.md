# DroneRTS: readable scouting, cargo logistics and programmable drones

**Implementation entry point:** [the consolidated handoff](DRONE-RTS-IMPLEMENTATION-HANDOFF.md) now combines this gameplay design with the protocol research and the user's latest small-disk/interchangeable-agent requirements. Use that document to start the next implementation chat; this plan remains supporting design and trial evidence.

Prepared September 14, 2026 for a new implementation session. This is a proposed design and implementation handoff, not a description of features already built. The current turn changed documentation only. A graphics subagent reviewed the scene and recorded recommendations below; it did not edit the map.

The follow-up [onboard libraries and protocol addendum](ONBOARD-LIBRARIES-AND-PROTOCOLS.md) specifies the recommended QuickJS/math stack, separation of local control from Zenoh peer radio, and delivery semantics. Read it before implementing the runtime/network stages. The player commander remains a simple team chat participant; no elaborate commander system is in scope. The cargo, graphics and equipment design below is unchanged.

## Direction

Build a small logistics RTS in which drones **find salvage, collect a load, bring it to their charging station, and spend the delivered salvage together**. Give them a useful onboard flight interface and a private place to write reusable routines. Let the models choose what to explore, which equipment to buy, who hauls, who scouts and who fights.

The main change is separating slow strategic decisions from continuous local vehicle control. More visual detail and more instructions alone will not solve the current navigation failures. Realism here means understandable sensing, stable flight, payload handling, limited visibility and communication delay. Keep the gun as the existing simplified game weapon; do not expand the weapon catalog during this work.

## Start from the evidence

Repository: `C:\Users\danhm\.codex\worktrees\5eed\DroneRTS`. This checkout contains substantial uncommitted work. Preserve it. Read `AGENTS.md`, `README.md`, `ARCHITECTURE.md`, `CITY.md`, `NETWORK.md` and `MAVLINK.md` before implementation.

Latest trial: `artifacts/focused-trials/2026-09-14T16-48-54-374Z-match/`. Source manifest: `9dd3a7ad76e410849b89205d17bf9e3ae9c77e9af184a33c863968c55b6d6e66`. Its `result.json`, `analysis.json`, `engagement-analysis.json` and `coordination-and-collision-analysis.json` are the current evidence. Raw artifacts are local and may be absent from another checkout.

- The 479.995-second match reached its time limit: one blue and three red drones survived, with no winner, shots or mined salvage. All six actors received the new opening agreement and starting-armor briefing.
- There were 47 peer messages; 26 occurred in the first 101 seconds. Both teams proposed conflicting buyers, switched their agreements, and bought a gun while their messages still disagreed about its owner. Blue 2 bought at 48.161 seconds; Red 2 bought at 53.264 seconds. There were no rejected duplicate purchases in this run. More messages did not establish reliable agreement.
- Three armor charges absorbed contacts and all three local alerts were delivered. Blue 3 survived a building approach, climbed and continued; it later flew to Blue 1's occupied destination and died. Later Blue 2 flew to Blue 1's new occupied destination, destroying the already unarmored Blue 1. Thus this run had one protected environment contact and two friendly collision incidents, not repeated environment deaths.
- The collision-associated waypoints decoded exactly through MAVLink: `(-30,5,20)`, `(8,5,40.5)` and `(30,20,40.5)`. Coordinate rounding does not explain these contacts.
- Drones reported seeing yellow cubes but did not enter them. The closest sampled approach to any resource volume was still 5.86 local units outside it. One optional mining status call correctly reported no resource in reach. Blue 1 guessed a resource position near `(8,5,40.5)`; its camera did show a distant yellow cube, but no resource exists at that guessed position.
- All four survivors completed a return/recharge cycle. There were 274 delivered images, none missing, no recorded runtime/transport errors or replay warnings, and successful cleanup. The owned 4319 service stopped; another checkout's idle 4318 service was preserved.
- Median delivery-to-next-command time was 6.095 seconds; the 95th percentile was 15.627 seconds. Camera acquisition-to-delivery was only 15 ms median. These timings include model and tool overhead and do not isolate private reasoning. They support moving routine control below the model's turn loop.

One run does not establish a causal improvement from armor or the briefing, or validate item balance. It does show that collection, navigation and shared understanding need attention before economy tuning.

## What the current drones can actually do

| Question | Current implementation | Proposed change |
| --- | --- | --- |
| Are sensors realistic? | Actual rendered 512×288 camera images plus own local XYZ, heading and timestamps; own battery/equipment/status and actual peer mail. Camera and telemetry acquisition are coordinated. But no velocity, measured camera pitch, coordinate calibration or camera calibration is exposed. Body roll/pitch are not simulated flight attitude. | Supply a documented, timestamped onboard state estimate, measured camera orientation, useful local ranging and camera calibration. Keep all undiscovered world information private. |
| Is MAVLink a real autopilot? | Real MAVLink 2 packets and native Zenoh peer traffic surround a custom game controller. This is not PX4/ArduPilot SITL. Position telemetry is idealized simulation state carried through a real wire format. | Keep the integration; improve the simulated onboard controller without claiming aircraft fidelity. |
| Can commands be batched? | No route queue or general batch tool. Actors are instructed to call one tool at a time. `act` starts asynchronous movement; later movement replaces its target, and `look` can run during movement. | Add a bounded route job and compatible motion/camera commands, with real progress, cancellation and stop conditions. |
| Can they write scripts? | No. Native actors run in an isolated read-only directory with filesystem, shell, web and arbitrary tools disabled. | Add a private virtual workspace and bounded game-only JavaScript routines through role-bound tools. Do not enable host shell or repository access. |

These findings come from `server/runtime-tools.ts`, `server/runtime.ts`, `server/game.ts`, `server/drone-motion.ts`, `server/mavlink.ts` and `network/mavlink.py`.

The distinction is supported by normal robotics interfaces: MAVSDK exposes position/velocity, attitude, battery and sensor health; it also supports uploaded multi-step missions. PX4 separates externally supplied commands from its flight stack and describes local distance-based collision prevention. These are references for the architecture, not a claim that every real drone carries the same equipment. [MAVSDK telemetry](https://mavsdk.mavlink.io/main/en/cpp/guide/telemetry.html), [MAVSDK missions](https://mavsdk.mavlink.io/main/en/cpp/guide/missions.html), [PX4 offboard control](https://docs.px4.io/main/en/flight_modes/offboard), [PX4 collision prevention](https://docs.px4.io/main/en/computer_vision/collision_prevention).

## 1. One resource, physically collected and delivered

Use **salvage crates** as the only resource. Each drone has a basic cargo attachment for free. There is no need to buy a miner before participating in the economy.

Recommended first-pass tuning, explicitly game values:

| Rule | Initial value |
| --- | --- |
| Opening shared bank | 30 per team |
| Standard load | One crate worth 30 salvage |
| Basic equipment purchase | 30 salvage; a delivered standard load buys one item |
| Pickup | Low, slow hover over a marked loading apron for 3 seconds |
| Deposit | Low, slow hover over a friendly base apron for 2 seconds |
| Carry limit | One crate normally; two with the cargo module |
| Loaded flight | 20% lower maximum travel speed, without an additional battery rule |
| Outer stock | Four caches of 60 salvage each: two loads per cache |
| Central stock | One depot of 600 salvage: twenty loads, about 71% of total stock |

Credit enters the shared wallet **only at delivery**. Picking up a crate changes physical stock and the drone's cargo, not its bank. There is no passive income, currency for sightings, or credit for repeatedly picking up and dropping the same crate. No regeneration in the first version. Finite stock can later be increased if real matches exhaust it too quickly.

Pickup and deposit should work automatically in the correct physical volume, just as charging does now. Use one fixed low hover band relative to the visible apron, with the whole footprint large enough for three separated drones. Do not require precise contact with a tiny crate center. A shared contract must define visual apron bounds, vertical pickup band, speed threshold and timer. Show `loading`, `carrying`, `unloading` and `charging` in own feedback. Include the service band in the interface instructions so drones are not guessing whether they must land.

Reserve individual crates atomically while loading; at successful pickup remove exactly that crate from depot stock and attach it to the drone. A cancelled load releases its reservation. Deposit transfers the cargo exactly once. A destroyed carrier drops unbanked cargo at its physical crash site when a valid accessible resting surface exists; otherwise that cargo is lost. Never teleport it to an easier place or reveal its coordinates through an event. Either team may recover reachable dropped cargo by the same pickup rule. Stop/reset must not mint or duplicate stock.

Model the crate attachment as a simple gripper with a forgiving interaction area, not a rope simulation. Carrying does not prohibit shooting. Slots and the slower return trip already create a useful tradeoff.

This loop is strategically promising but adds a return trip to a task the drones currently cannot complete. Do not launch the whole overhaul before proving that one drone can identify a depot, load, return and deposit with the new interface.

## 2. Make resources readable from the camera

Replace translucent yellow volumes with **matte industrial yellow/ochre cargo on dark pallets**, with a broad black marking repeated on the top and sides. Use shape and contrast rather than tiny writing. A painted loading apron shows the usable horizontal area. Loading crates are visual cargo props, not new accidental collision traps.

The central resource is a larger freight/salvage yard at the central intersection or an immediately connected open plaza, with more stock and three separated loading positions. Smaller caches occupy other road intersections or their visible loading aprons. Keep them outside the initial ground-level camera views, but not buried inside building footprints. Stock visibly shrinks; an exhausted depot has empty pallets. Cargo is visible underneath its carrier and disappears on delivery. All of this must come from authoritative cargo state.

Use comparable travel distances and clear approaches from both bases, checked against actual city geometry. Preserve multiple approaches and buildings around the center for cover. The central loading area itself should be exposed from more directions than the outer caches. Its larger stock makes repeated trips worthwhile after outer caches empty; do not add a capture timer, a second resource grade, or a magical center-income bonus.

Altitude should produce a natural tradeoff: above nearby roofs, a scout can see more loading areas and recognize their top markings, while its own silhouette becomes visible from more positions. Higher altitude also makes individual crates and aircraft smaller in the image. Do not make identification improve without limit as altitude rises. Use ordinary occlusion and finite image resolution, without glowing beams, floating labels, silhouettes through walls or automatic enemy alerts.

Replace base wire cubes with broad team-painted aprons, three pad marks and a charging cabinet. Reuse the cargo symbol to communicate where deliveries go. Automatic charging and unloading happen together while correctly positioned. Broad team color on drone bodies and arms supports identification from oblique and overhead views.

The graphics subagent found that building meshes already follow the rotated/tiered collision boxes. Improve asphalt/sidewalk/wall/roof separation, simplify repetitive facade detail and add restrained grounding/shadows. Do not widen roads only in the renderer, add decorative collision clutter, or assume prettier scenery fixes navigation. Review actual acquired drone images, not just the spectator view.

## 3. Give drones ordinary onboard knowledge

Intentionally revise the old experimental restriction that hides the vehicle's own calibration. Keep exploration about the world, not about discovering what its own coordinate system means.

Expose a compact state estimate: local position, velocity, heading, measured camera pitch/yaw, mode/job status, battery, cargo, own equipment, acquisition timestamp and freshness/validity. State which axes and units commands use and document camera image size, field of view and actuator limits. Current city coordinates use one game unit per ten meters. Preserve internal geometry initially and document the conversion; do not relabel existing values as meters or silently rescale the map. Audit drone visual/collision size relative to streets before claiming physical scale realism.

Add a simple downward range/height-above-surface reading and short-range directional proximity sensing. Ranges return a first-surface distance or explicit unavailable/out-of-range status, with timestamp and coverage. No object class, resource ID, enemy identity, hidden coordinates, or map access. These are modeled sensors added to all drones, not capabilities implied merely by using MAVLink. Do not manufacture roll/pitch readings for flight dynamics that do not exist; camera orientation is a separate quantity.

Use a stable camera that can reach a true downward view. Supply enough calibration that an agent can write its own image/geometry helpers; do not supply a function that raycasts an arbitrary image pixel into a hidden world coordinate or identifies every visible resource for it. Default helpers cover coordinate transforms and reading its own sensors, not solved perception.

Keep perfect-but-declared state estimates for the first version. Adding GPS noise, drift, video interference and detailed aerodynamics now would compound usability problems. They are later experiments after collection works.

## 4. Local flight assistance and command jobs

Keep continuous acceleration/braking and physical collisions. Add a generic local controller that slows and holds before a sensed obstruction, using only finite-range sensor observations. Include nearby drones as anonymous physical obstructions. It must not have a global route planner, see through buildings, choose an alternate strategic route, or evade projectiles for the model.

An occupied destination produces `blocked` plus own status, rather than repeatedly accelerating into a teammate. Pause the current route and ask the agent to choose another command. Failed/stale sensor coverage produces a clearly reported hold in the assisted mode. These behaviors apply equally to both teams. Hard contacts remain possible and consume the existing armor charge or destroy an unarmored drone; the initial armor remains useful as a fallback.

Introduce one bounded command-job mechanism: a short ordered route, optional camera direction, and a requested movement style such as travel or precision. Each motion step completes before the next begins. Allow compatible camera control and radio while moving. Reject competing movement writers; a manual replacement explicitly cancels the previous job. Return job ID, accepted parameters, progress and reason for stop. Validate each step again when it executes.

Stop/reset, death, newly received mission version, armor loss, blocked movement, power loss, timeout and invalid capabilities interrupt the appropriate job. No queued old-mission purchase, pickup or shot may execute afterward. Preserve fresh sensor/inbox bundles at model tool boundaries, and keep the model free to observe, send mail or cancel while a job runs.

This is a simplified onboard controller. PX4's distance-based prevention motivates braking using available sensor coverage; its documented behavior is not a guarantee for arbitrary autonomous routes. [PX4 collision prevention](https://docs.px4.io/main/en/computer_vision/collision_prevention).

## 5. Private scratchpads and reusable routines

Provide a **virtual per-drone workspace**, with Markdown notes, JSON memory and small JavaScript modules. Suggested interface: one `workspace` tool for list/read/write and one `routine` tool for start/status/cancel. Keep direct flight/radio tools available. Starting a routine returns immediately so the model can continue thinking or communicating.

Use a resource-limited interpreter with enforced CPU, memory, source-size and execution-time limits, separate from the host's privileged runtime. No host filesystem, environment, repository imports, credentials, network sockets or native child-process access. Do not solve this by enabling the existing Codex shell or treating ordinary Node `vm` as isolation. Select and verify the interpreter before enabling live actor code.

Expose only a small game SDK: own timestamped sensors and images, permitted control primitives, job progress, private key/value memory and the existing team radio. Scripts may use only what that drone has sensed or received. Limit observation/control rates; do not route a model inference call through every controller tick. One motion job owns the vehicle, whether submitted as a route or started by a routine. Scripts yield or run bounded callbacks; infinite loops must be terminable without freezing the simulator.

First routines should demonstrate neutral programming capabilities: record an observation, move through caller-supplied waypoints, wait for an event, or report own state. Supply API examples, not complete scout/miner/attacker strategies. Agents may build their own route libraries, collection shuttles and camera sweeps. A script can invoke the existing toy `fire` primitive when equipped, subject to its normal aim, ammunition and cooldown rules; do not add enemy-ID targeting, hidden hit detection or a prebuilt autonomous engagement routine.

Persist files across turns and catalog refreshes within the same match. Start every fresh match with clean private workspaces; retain historical files for player replay, not automatic agent memory. Cross-match learned libraries are a later, explicitly separate experiment.

Sharing a library or notebook entry must use actual team radio: versioned content, hashes and bounded chunks if needed. Recipients get only delivered content, can review/import it, and must explicitly choose to execute it. No shared host folder that silently bypasses partitions or gives teammates instant knowledge. Record source versions, execution events, SDK calls and cancellation reasons for replay. Replays display what executed; they must not execute archived code.

## 6. Reward coordination through consequences

All delivered salvage funds the team. Scouting can save other drones search time; protecting a loaded carrier can preserve a purchase; separate approaches and pickup positions can increase delivered income. Cargo creates visible trips that can be intercepted. These benefits come from physical success, not assigned roles or a bonus for sending messages.

The September 16 user update replaces opening negotiation with one brief team message acknowledging that the pilot is online; pilots then proceed without waiting for replies or agreement on a plan or first purchase. Allow optional plan IDs/revisions and acknowledgements referencing the exact proposal in the existing radio data field. Label delivery and acknowledgement accurately. Provide generic helpers to send/reference messages, not a forced leader, fixed purchase order or centrally generated plan. A published purchase receipt can be shared by the purchaser's own routine; do not claim its teammates know the result before receipt.

Use an agent-authored notebook populated by its own observations and actual delivered messages. An entry can contain a position, time, source and confidence chosen by the author. Never prepopulate depot coordinates, enemy positions, route solutions or true map data. Keep atomic purchases; postpone budget reservation or voting machinery until evidence shows it is needed.

Keep last-team-standing as the victory rule for this iteration. Income strengthens survival and equipment choices; it is not a second victory score. Do not add replacement airframes, base destruction or training rewards yet. The actors are not being trained online just because the game tracks delivery statistics.

## 7. Simplify the shop around flexible equipment

| Equipment | First-pass rule |
| --- | --- |
| Basic cargo grip | Free on every drone; one crate |
| Cargo module | 30 salvage; two crates instead of one |
| Optics | 30 salvage; current wide/zoom capability, useful for inspecting distant details |
| Gun | 30 salvage; retain current 12-round, physically aimed game weapon |
| Battery | 30 salvage; retain about five minutes base flight and ten with the pack |
| Armor | One free charge at launch; replacement costs 20 |

Keep two equipment slots plus separate armor. Cargo, optics, gun and battery compete for those slots. No locked roles. Replace mining equipment with cargo capacity for new matches; retire the miner upgrade from the new shop. Leave jamming outside the first simplified ruleset and preserve old replay compatibility rather than deleting historical equipment semantics. Existing rearming can remain unchanged. Treat these shop changes as part of the new rules revision, not a mutation of recorded matches.

## Implementation sequence and parallel ownership

1. **Record the baseline and agree shared contracts.** Save the above live evidence in `RTS-PLAYTEST.md`. Define cargo, interaction aprons, expanded own telemetry and command-job lifecycle centrally. Update conflicting documentation and observation tests explicitly. No new inference is needed for planning.
2. **Start the graphics subagent alongside telemetry/controller work.** Graphics owns `client/city-scene.ts`, lighting/captures in `client/scene.ts`, props in `client/combat-view.ts`, and cargo in `client/drone-model.ts`/`client/drone-visuals.ts`. Use agreed fixtures for stock/cargo until authoritative state lands. Keep geography shared with collision geometry.
3. **Prove flight and collection first.** Gameplay owns `shared/rts.ts`, `shared/types.ts`, `server/rts.ts`, `server/game.ts` and `shared/battlefield.ts`; control owns `server/drone-motion.ts`, local sensor modeling and necessary MAVLink adapter changes. Land assist/telemetry and a complete pickup-return-deposit loop before economy balance work. Remove obsolete active mining tools and update the shared briefing to explain only the new interfaces and rules.
4. **Add the job engine and workspace runtime.** Runtime owns `server/runtime-tools.ts`, `server/runtime.ts`, `server/runtime-mcp.ts` and new focused modules for workspace/interpreter/job execution. Keep both parents mechanical and six clean drone actors. All gameplay actors remain `gpt-5.6-luna / xhigh`.
5. **Integrate team library sharing and replay.** Use `server/network.ts` and native Zenoh for delivered content; preserve network isolation and errors. Extend `shared/replay.ts`, recorder and player UI for cargo, code versions and jobs without exposing player state to drones.
6. **Evaluate in stages.** First run deterministic fixtures and camera QA. Then a bounded single-drone discovery/haul scenario with no supplied resource coordinates; then a three-drone logistics scenario; then a full match. Use the same model settings and explicit trial manifests. Do not launch another full battle just to find out that pickup or flight still fails.

The lead owns shared contracts and integration; subagents should have disjoint editing ownership. These recommendations intentionally replace the previous camera/XYZ-only calibration restriction, ban on private code files, automatic bank-on-mining economy, and part of the shop. Update `AGENTS.md` and affected docs as explicit design changes while preserving the boundary against omniscient world information.

## Acceptance criteria

- **Accounting:** one physical load exists in exactly one place; race-safe reservations and deposit; interrupted pickup/deposit, destruction, stolen dropped cargo, Stop and reset cannot duplicate value. Credits change only for deposits and authorized spending.
- **Navigation:** deterministic replays of the occupied-waypoint failures brake/hold before contact with valid sensors. Test corners, roof edges, downward clearance, moving obstacles, stale sensing and three drones servicing together. No global obstacle map enters actor APIs or scripts.
- **Visuals:** acquired camera views cover low approaches, oblique roof height and overhead, plus behind-building negatives, full/partial/empty depots, carried crates and both bases. Identify an intended useful scouting altitude band empirically; avoid claiming that arbitrary high altitude should reveal everything. Match visible and active apron bounds. Measure six-camera timing before and after shading or resolution changes.
- **Control/jobs:** prove sequential execution, camera/movement coexistence, explicit replacement, accurate feedback, cancellation on every lifecycle boundary and no stale actions after mission/death. Every actual action still uses the authoritative simulator and existing capability checks.
- **Workspace:** prove per-drone/team/match isolation, limits on runaway code, no privileged access, no competing controller writer, no execution after destruction, and no library delivery during a network partition before actual radio receipt.
- **Autonomy:** measure time to first actual discovery, pickup and deposit; delivered loads per minute; collisions versus prevented contacts; charging returns; time from a shared observation to another drone acting on it; and scripts written/reused. These are evaluation metrics, not hidden in-game rewards.
- **Live gate:** first demonstrate an autonomous complete haul from a fresh context with no target coordinates, then repeat it to check it was not a one-off. A team trial must show overlapping useful work and delivered income before tuning central fights or prices. Label any fixture-assisted or incomplete result honestly.
- Run relevant automated tests and the production build for implementation changes. Avoid repeated full-suite runs during small edits; do a broader integration check when shared contracts and runtime behavior have settled. Never claim a graphics fixture proves model perception or a scripted fixture proves emergent strategy.
- Before every live run inspect `/api/state`, preserve other sessions, use an owned free test port and a bounded runner, and stop all owned actors/helpers/server afterward. This plan itself does not require another live launch.

## First instruction for the next session

Implement this plan incrementally in the existing dirty checkout. Begin with baseline preservation, the shared contracts, the graphics workstream and useful own telemetry/local collision assistance. Prove a single complete collection-and-delivery loop before expanding the runtime to reusable scripts and before starting a full competitive match. Preserve exploration, actual peer communication, equal model settings and player/actor isolation. Keep strategy and library contents authored by the drones.
