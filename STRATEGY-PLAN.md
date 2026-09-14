# Strategic economy and simplified drone realism

Status: milestones 1 and 2 implemented and deterministically verified on September 14, 2026. See [STRATEGY-VERIFICATION.md](STRATEGY-VERIFICATION.md) and [ENDURANCE-VERIFICATION.md](ENDURANCE-VERIFICATION.md) for their respective evidence and limits. Milestones 3–4 remain future work.

Two subsequent live matches are documented in [STRATEGY-LIVE-PLAYTEST.md](STRATEGY-LIVE-PLAYTEST.md). Neither produced mining income. The user then selected the simpler cube rules below, superseding the camera-evidence retention proposal and the original manual mining/charging rules in milestones 1–2. Milestones 3–4 remain deferred.

## Current simplification: automatic cube zones

- Grounded translucent yellow cubes contain finite salvage at mapped road intersections. Each cube fills its crossing while clearing corner buildings, with room for all three drones. A living drone mines automatically while its center is inside; no tool call, aiming or camera-evidence gate is required. Leaving stops extraction. Depletion hides the cube without shrinking its active bounds beforehand.
- Friendly service areas use matching translucent blue/cyan or red cubes. Occupancy supplies power and automatically restores 25 charge/second, preserving partial progress when a drone leaves. Charging remains independent of movement and timed rearming. Purchases and rearming use the same visible cube boundary.
- Base battery capacity is 300; the pack doubles it to 600. The user's follow-up tunes hover drain to 0.9/second plus 0.1 during movement, giving 5 minutes of normal continuous flight or 10 minutes with the pack. Mining and jamming use additional power. Refitting supplies capacity without creating charge.
- Existing XYZ/MAVLink values already support decimals. Keep physical scale and collision behavior; verify small adjustments through actual native packets and show three decimal places in player readouts.
- Each drone starts with one free armor charge, preserving the team's 30-credit opening purchase. The first absorbed collision clears motion and sends local collision/armor-loss feedback; a second unprotected impact is lethal. Replacement armor remains a paid purchase at a friendly cube. This provides one recoverable mistake without assigning navigation tactics.
- Keep one resource, 30 starting shared credits, hidden outer deposits and a central 900-salvage deposit. Shift cube footprints into clear space without changing sourced buildings. Cube colors and automatic interactions are allowed agent instructions; locations, dimensions, calibration and hidden opponent information remain unavailable.

The detailed milestone selections below describe the original implementation. Current setup/rules are maintained in [README.md](README.md); historical verification and live reports retain their original tested scope.

## Design intent

Keep one finite resource, shared team income, three independently reasoning drones per team, and discovery through actual camera observations and peer messages. Equipment should make economy, scouting, attack and protection useful activities without assigning classes or tactics. Preserve the mechanical parents, native Zenoh/MAVLink boundaries, six actor identities, physical projectiles, friendly fire, armor and permanent elimination.

The implementation favors reusable drones and resupply. Milestone 1 establishes equipment and ammunition decisions; milestone 2 adds endurance and abstract radio interference. Payload drops and replaceable aircraft need later physics and lifecycle work.

## Milestone 1: opening decisions, exploration and resupply

- Each team begins with 30 shared salvage and an available shop. The starting allowance is available income; it does not count as mined salvage. There is no opening salvage pile at either launch site.
- Gun, mining drill and optics each cost 30. Armor costs 20, so even the cheapest opening leaves too little for a second item. Buying hardware requires physical proximity to a friendly, visible-in-world service pad. Pads provide no passive income.
- Two module slots hold any two of gun, miner and optics. Armor is a separate one-hit protective attachment under the existing rule. A purchase may explicitly replace an equipped module without refund; validation and spending remain atomic. Discarding a drill loses its upgrade; discarding optics returns the camera to wide view.
- Bare mining yields 0.5 salvage/second, a drill yields 1, and a 60-salvage drill upgrade yields 1.5. A base drill needs 60 seconds of actual ordinary-deposit mining to repay its extra production. The upgrade occupies the drill's existing slot.
- Four outer deposits contain 150 salvage each. A central mega deposit contains 900 and permits 1.5 times normal extraction. All deposits remain finite, optically discovered, physically reached and shared by competing miners. Placement must be accessible and have reasonable opening opportunities for both teams without putting a deposit in the initial view.
- A gun includes 12 rounds. Each physical shot consumes one round. An empty gun cannot fire or spend ammunition. Reloading costs 10 salvage for a full magazine and requires eight uninterrupted simulation seconds at a friendly service pad. No full-magazine reloads. Movement, mining, firing, refitting, damage, mission replacement, death or Stop cancels servicing; its reserved payment is refunded exactly once. Looking, observing, radio and waiting may continue. No fractional ammunition is granted.
- Service pads are visible world geometry at both launch areas, not new actor map information. Tools accept no pad IDs or coordinates. Pad proximity is an interaction condition; no pad locator or nearest-pad telemetry is returned.
- Optics enable a wide/zoom camera mode. Zoom changes the actual capture projection, not hidden target data. Private resource evidence must use the projection of the image actually delivered, including capture-time mode. No field-of-view or range calibration enters drone tools.
- The spectator UI shows module slots, ammunition, camera mode, service progress, deposit richness and the central contest. Replay must preserve the added world/drone state and continue to open old recordings.

### Implementation ownership

Parallel workstreams: authoritative economy/combat/service rules and focused tests; game/tool integration and lifecycle tests; camera projection/private evidence; resource layout/service pads; spectator renderer/UI. The lead owns shared contracts, integration, documentation and final verification. Each workstream owns separate files and reports integration requirements.

### Acceptance and verification

1. Exactly one initial purchase can succeed per team; shared-wallet races and failed/refit transactions cannot overspend, create ammo, lose unrelated gear or leak hidden state.
2. Mining is finite and fair at ordinary/rich deposits; rates, upgrade payback and forced expansion are covered by deterministic tests.
3. Service completion, cancellation/refund, mission changes, Stop/reset/death, gun removal, insufficient funds and leaving the pad are covered. Dead drones cannot mine, reload or act.
4. Zoom captures and private evidence agree, including changes during capture; only existing sensor fields and own equipment/account interaction feedback reach actors.
5. Run the full automated suite and TypeScript/production build. Use deterministic browser QA with no inference on an owned isolated port after inspecting `/api/state` on ports 4317 and 4318. Prefer 4318; if another checkout owns it, use an available port and set `FLEET_QA_PORT` for the deterministic verification scripts. Preserve other sessions and stop owned test services afterward.
6. Record current verification separately from historical playtests. Do not claim autonomous strategies or competitive balance from deterministic fixtures.

## Milestone 2: endurance and radio interference

Add an individual battery meter, free timed recharge at service pads and an extra-battery module. Define low-charge and empty-charge behavior before implementation so model latency does not silently strand matches. Battery is not another resource currency. Model active drone radio jamming through explicit native-network partitions with durability/expiry preserved, including interference with friendly messages. Local camera, controller and private reasoning continue; no fake camera blackout. Add jammer energy cost and truthful own operational feedback. Test lifecycle and radio partition interactions before gameplay trials.

### Selected rules

- Start with 100 charge. A battery module costs 30 salvage and raises capacity to 150, using one of the two module slots. Equipping it does not create charge; removing it caps stored charge at the smaller capacity.
- Hovering uses 0.2 charge per simulation second. Actual translation adds 0.1, active mining adds 0.15 and an enabled jammer adds 0.8. Battery drain pauses with the simulation and during valid pad servicing. These are game tuning values, not aircraft specifications.
- `recharge` starts 12 seconds of free stationary service at a friendly pad and restores full capacity on completion. It shares the existing service slot and interruption rules with rearming. Interrupted charging grants no partial charge; it never changes salvage.
- Crossing 20% charge produces a local warning. Empty charge destroys the aircraft through a power-loss crash; armor cannot replace power. There is no automatic return route, extra life or indefinite powerless hover. This is a deliberately simple flight-end abstraction.
- A jammer module costs 45 salvage and uses one slot. `jam` toggles it. An enabled jammer interrupts every live drone's peer-radio connection within 18 local units, including its own and friendly connections. Its range is a game abstraction; no frequencies, physical RF propagation or real targeting are modeled. Effects from multiple jammers combine.
- Service, module removal, damage, a newly received mission, Stop and destruction turn the affected drone's jammer off. Moving and mining can continue with a jammer enabled. Starting a jammer during servicing is rejected. Turning one off remains a local action during a partition.
- A single serialized transport reconciler combines interference, manual Network lab isolation and destruction before closing/reopening native Zenoh sessions. Clearing interference must never undo manual isolation or reconnect a dead drone. Queued messages retain their existing expiry and deduplication rules; network failures remain explicit.
- Own battery charge/capacity, jammer state and interference indication are equipment feedback outside the existing four sensor fields. No jammer source, affected-drone list, radius, pad locator or enemy telemetry enters actor tools. Replays and spectator UI preserve the new optional state while retaining legacy recordings.

Parallel ownership: rules and lifecycle; game/tool integration; native radio reconciliation; spectator UI/replay; lead integration, documentation and deterministic browser verification.

## Milestone 3: differentiated reusable weapons

Add a limited-payload dropper with physical gravity/collision and visible effects, useful against stationary low-hover miners. Tune the existing aimed gun toward reusable interception through game-scale range and ammunition constraints. Retain visual acquisition and physical hits; no target-ID aiming, hidden hit receipts or scripted combat strategy. Validate the new weapon physics deterministically before bounded Luna/xhigh actor trials.

## Milestone 4: longer attrition matches (separate design decision)

Consider at most three active drones per team with salvage-funded replacement airframes and lost equipment. This requires an explicit replacement actor/mission policy and a workshop-based victory condition; it must not be slipped into last-team-standing. One-way attack equipment and forward service construction should be evaluated with that lifecycle. Keep this milestone deferred until the reusable-drone economy has measured outcomes.

## Research basis and limits

These sources motivate broad gameplay abstractions, not real-world weapon parameters. Announced or tested equipment does not establish widespread deployment or reliable fully independent swarm strategy.

- [RUSI field research on reconnaissance and combined operations](https://www.rusi.org/explore-our-research/publications/insights-papers/emergent-approaches-combined-arms-manoeuvre-ukraine).
- [KSE Institute, Ukrainian defense technology market, March 2026](https://institute.kse.ua/wp-content/uploads/2026/03/the-ukrainian_defense_technology_market_eng_march_2026.pdf).
- [Ukrainian MoD, reusable bomber trials, 30 March 2026](https://mod.gov.ua/news/minoboroni-testuye-nove-pokolinnya-droniv-bomberiv-iz-zahishhenim-zv-yazkom-ta-zbilshenoyu-dalnistyu).
- [Ukrainian MoD, autonomous interceptor announcement, 8 June 2026](https://mod.gov.ua/en/news/next-generation-interceptors-ukrainian-drones-already-autonomously-take-down-shahed-type-ua-vs).
- [RUSI, layered counter-drone defense](https://www.rusi.org/explore-our-research/publications/occasional-papers/protecting-force-uncrewed-aerial-systems).
- [Ukraine, faster interceptor development, 3 September 2026](https://www.president.gov.ua/en/news/virobnictvo-perehoplyuvachiv-reaktivnih-shahediv-maye-prisko-106237).
