# Downtown battle QA handoff — 2026-09-14

The braking repair and observation-volume work below have now been implemented in this worktree. Continue with the newest results in [RTS-PLAYTEST.md](RTS-PLAYTEST.md), then the remaining autonomy gates. Favor small changes in the existing module that owns the behavior. Preserve geographic scale, physical contact, finite sensors and independent pilot decisions.

## Latest validation and artifact retention — 2026-09-14

`npm test` and artifact-producing QA/playtest scripts now retain the newest managed run across test kinds in `artifacts/test-runs/`. Failed runs are retained, active processes are protected, and related checks can share an active run using `FLEET_TEST_RUN`. Owned stopped session audits, replay images and network stores are collected together. Cleanup validates directory ownership/confinement and rejects symlinks/junctions. Historical reports stay checked in; finish offline analysis before starting another run.

The final grouped validation passed **392 tests**, **34 control cases**, TypeScript/Vite build and the desktop/mobile browser fixture. Seven new tests cover retention, failure exits, active runs, grouping, interrupted processes, directory boundaries and stopped-session collection. Its source manifest has **167 files**, SHA-256 **`cc6ccfe991a9316bb77b45e340fb6c5dee3d179e2b15b53592dd3e7046331ad0`**. The sole retained managed run is `artifacts/test-runs/2026-09-14T23-40-03-731Z-landmark-core-qa-51ca3c55/`; the preceding managed validation run was removed automatically. No model inference was started.

**Legacy cleanup limitation:** the user authorized removal of older local artifacts. Both the guarded bulk cleanup and a narrower list of explicitly verified paths were rejected by automatic approval review as “blocked by policy,” without a detailed reason. The older **35 top-level entries, 3,452 files, 334,223,376 bytes** outside `artifacts/test-runs/` remain local and ignored. Neither active player state nor a filesystem link caused the rejection: 4317 was unavailable, 4318 idle, and the inventory found no links or paths outside this worktree's artifact root. Do not claim these legacy artifacts were removed or retry through another mechanism to bypass the rejection.

## Current implementation — landmark core and observation 5

The latest user-requested changes supersede the map and observation format in the historical results below. The battlefield is now **820 × 660 m**, **61.3% less area** than the preceding 1.4 × 1.0 km crop, centered on the Fountain Square/tower cluster. Bounds are x `[-32,50]`, z `[-20,46]`; geographic scale and all retained building geometry are unchanged. There are **107 collision boxes, 181 road segments, Fountain Square and 22 safe intersections**. The river falls outside this crop. Bases are now about **676 m** apart, and the former Elm/Fifth cache is at Vine/Fourth. All 840 finite salvage remains, with resource aprons outside initial camera views and clear physical loading/service routes.

`fleet-observation/5` losslessly represents the fixed 26 proximity directions with the fully defined `xyz26` codebook, shares exactly equal values within each column, and retains the schema-4 same-bundle reference for exactly identical fresh tables. Nonstandard directions remain explicit; unfamiliar metadata passes through intact. Sensor precision, separate acquisition metadata, mail and camera content remain unchanged. Re-encoding the preceding battle's **418** bundles passed exact round-trip and image equality checks: all tool-result text falls **25.3%**, from **2,671,369 to 1,996,105 bytes**; sensor/current-telemetry values fall **36.9%**. These are offline byte measurements, not token or model-latency results.

Drone cards now place equipment on one row and cargo beside the collapsed controller, reduce empty radio/footer space, and stack when narrow or controller details are expanded. Camera dimensions and available detail remain unchanged. The deterministic browser fixture passed desktop/mobile, camera provenance, three-drone loading/delivery, rearming/cancellation/refund and reset checks. All **385 tests**, **34 control measurements** and the production build pass. Some old isolated fixture coordinates were translated into the smaller bounds; their relative collision/shot geometry and physical criteria remain.

Validation source manifest: **`c9b770af65ff9ad0d3f16b74ffaf154e9210587e95b2265925ad9d18cc1557b6`** (164 files). Evidence is in `artifacts/landmark-core-validation/`, `artifacts/landmark-core-ui/`, `artifacts/landmark-core-sensor-volume.json` and `artifacts/control-measurements/2026-09-14T23-20-33.413Z/`. The idle preview is available on **4318**; port 4317 was unavailable and untouched. **No fresh model battle has run on this map/schema.** The prior recognition, aiming, repeated/team hauling and context-delay findings remain open; historical runs below prove only their own revisions.

## Continuation status — 2026-09-14

- `server/drone-motion.ts` now checks retained momentum at all nonzero speeds against coverage-only horizons, certifies the integrated next step plus its stopping corridor, and checks the entire final arrival correction. Unsafe progress produces a held job without rerouting or position correction. The portable reproduction now stops at separations **0.765585980 / 0.764876476** for dt=1/120 and 0.0078, with zero velocity, `coverage-unavailable`, no contact and no arrival. New tests cover the recorded case, actual job/bundle outcome, replacement momentum and a tiny unsafe arrival correction. Existing narrow retreats and cargo arrival/service pass. All **385 tests**, the build and all **34** control measurements pass on this repair.
- `fleet-observation/4` shares a proximity table only when both fresh acquisitions contain exactly identical tables in the same bundle. Separate origins, timestamps, sequences, validity, downward ranges, images, mail and accounting remain. Historical battle re-encoding would save **722,131 of 3,284,713 text bytes (22.0%)**; the first live schema-4 single haul saves **222,933 bytes (23.8%)** relative to expanded schema-3 tables. This establishes a text-volume reduction, not a causal latency reduction.
- `scripts/analyze-decision-latency.ts` now records volume by field, actual image bytes, native token reports, tool-gap distributions, compaction boundaries and sampled motion/job/service during long gaps. Optional wall-time windows support comparison without overwriting full reports. The old battle's 54.306/65.001-second compactions and 57.972/73.264-second gaps remain reproducible; no inference-backend or context-window settings were changed.
- The 300-wall-second baseline single haul picked up **60** but timed out during the return, with no delivery. A fresh schema-4 run delivered **60 at sim 198.023**. A 600-wall-second repeat using the final controller loaded **60 at 505.034** but timed out at **575.004** without delivering. All three runs retained six survivors, zero collisions/lost value and completed cleanup; actual loading-apron/base camera files were inspected. Each has its own source manifest. The tiny-arrival hardening followed the successful run and preceded the failed repeat.
- The final repeat saved **432,974 text bytes (23.5%)**, yet Blue 1 still reached **242,868 reported input tokens** and compacted for **47.057 seconds**. Its next-call gap was **50.512 seconds**, including about **14.298 simulation seconds** of sampled local work and **36.201** without motion/job/service work. Local ascent continued during compaction, then waited at its completed waypoint. Representation savings alone have not resolved accumulated-context latency.

**Hauling gate at this checkpoint:** repeatable single hauling remains unpassed; team-haul and full-battle trials were initially deferred. Investigate the pilot's repeated visual approach corrections and remaining context/decision delays using the final repeat's acquired frames and native audit before changing the smallest owning component. Preserve low/slow physical service, independent navigation and exact observation evidence. Useful overlapping team income, empty-cache avoidance, useful code reuse and reliable combat remain unproven. Final repeat evidence: `artifacts/focused-trials/2026-09-14T22-26-15-188Z-haul-single/`, manifest `44d5d38f88becd859a2c30e2a3a45f829ad50a82bf91f84e13cb33addab6fe87`.

**Subsequent user-requested battle:** the user explicitly requested a full match on that same source. `2026-09-14T22-44-52-900Z-match` reached the 600-wall-second limit at **567.491 simulation seconds**: six intact survivors, blue **30 delivered**, red zero, **eight shots all hitting terrain**, no collisions or winner. Blue 3's actual acquired image clearly shows a red drone; Blue 2 visibly recognized salvage, loaded/delivered it and bought the second blue gun. The gunners' later recognition/aiming remained poor: best shot **7.742°** off the nearest enemy center, others **8.833–44.870°** off. The first firing images suggest confusion between the red base apron and an airframe. Prioritize visual centering and maintained target identity before ballistic tuning; repeated/team hauling and useful code reuse are still unproven.

This battle had **no compaction**, a **19.794-second** maximum completed-tool-to-next-call gap, and **21.6%** text savings from schema 4. That single sample does not resolve the preceding same-source compaction failure. All **418** delivered acquisitions/images and all **105** expected recipient copies of **58** peer messages were retained; four provenance mistakes were explicitly rejected and recovered. Source fingerprints, conservation and all four offline analyzers passed. Details and exact source/image evidence are in the newest [RTS-PLAYTEST.md](RTS-PLAYTEST.md) section. All owned trial services and camera tabs are stopped; ports 4317 and 4318 were unavailable at final inspection.

The sections below preserve the original battle evidence and acceptance criteria. Statements about a failing reproducer or zero live pickups refer to that original revision, not the continuation above.

## Checkout and evidence

- Last merged implementation: [PR #10](https://github.com/DanMcInerney/DroneRTS/pull/10), `a005bff66d672ca214a2da5e8cf913faf93d96d9` on `main`. It removed the wider municipality view and fixed renderer provenance, peer status retention, cargo arrival, launch readiness, replay coverage and completed-job display. Batteries were removed in the preceding revision; do not restore them.
- This handoff accompanies a further **1.4 × 1.0 km downtown crop**, implemented after that battle. Check `git status` and preserve the current changes. The battle below used the preceding **2.4 × 1.9 km** map; it does not validate autonomy on the smaller crop.
- Read [AGENTS.md](AGENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [CITY.md](CITY.md), [NETWORK.md](NETWORK.md), [MAVLINK.md](MAVLINK.md) and [ONBOARD.md](ONBOARD.md). [RTS-PLAYTEST.md](RTS-PLAYTEST.md#merged-downtown-battle-retest--2026-09-14) contains the detailed measured report. Preserve historical results and their source revisions.
- Raw evidence is local and ignored: `artifacts/focused-trials/2026-09-14T21-18-27-598Z-match/`. Source-manifest SHA-256: `e6603fc226bead1701d30695552c945746f5d12707b209715e42727bda7760fc`. It may be absent in another checkout; the repository collision reproducer below is independent of those files.

The normal Luna/xhigh match ran for a 600-wall-second limit, including readiness, at fixed 1x. It stopped at **565.093 simulation seconds**, with **six survivors, no winner, no pickups or deliveries, and two red shots hitting terrain**. Both teams spent their opening 30 on one gun; four drones remained unarmed. All 840 resource salvage remained in caches, with none aboard or lost. Red 1 and Red 3 lost armor in a collision. No tool exceptions, runtime errors or runner failures occurred. Owned actors, protocol helpers, server and camera tab were cleaned up.

## 1. P1: A precision approach can creep into a stationary teammate

**Observed:** At sim **114.220**, Red 1 (`drone-4`) hit stationary Red 3 (`drone-6`). Red 3 had sent its actual position; Red 1 chose that occupied center as a waypoint. Both armor charges were consumed, their movement stopped, and they later resumed. The pilot chose an unsafe destination, but the controller also failed to stop before physical contact despite fresh local sensing.

**Portable reproduction:**

```powershell
node --import tsx scripts/reproduce-braking-contact.ts
```

The script uses current production `DroneMotion`, `LocalSensors` and `sphereContact`, with the recorded start `(51.599998474121094, 8, 21.899999618530273)` and stationary peer/target `(55.20000076293945, 12, 21.5)`. It has no buildings, inference, network traffic or inputs to live pilots. It prints diagnostics instead of asserting that a defect must remain present.

Current result: contact at **6.081978 s** with dt=1/120 and **6.082496 s** with dt=0.0078; `blocked:null`, `arrived:false`, final separation about **0.759970** against a **0.76** collision diameter. Velocity becomes small but never safely settles before contact. The original detailed tail is in `ram-reproduction.json` in the raw trial folder.

**Likely mechanism:** `server/local-sensors.ts:measuredFootprint` narrows the guard footprint toward the physical radius as a peer gets close. `server/drone-motion.ts:clearance` selects the longest certified beam coverage and distinguishes an axial obstruction from a radial coverage limit. Near this oblique approach, the selected limit can remain coverage-only. The target-speed limit shrinks, but actual trapezoidal integration and retained velocity still cross physical contact. This is not the final-position snap fixed in PR #10: the target is about 0.76 units away, far outside the 0.004 arrival threshold.

**Implementation boundary:** Keep geometry access inside the simulated sensor. Make allowed motion conservative against the currently certified coverage and actual integrated momentum, with an explicit blocked/hold outcome when progress cannot be made safely. Do not special-case a teammate ID or this coordinate, teleport to a safe position, add collision immunity, inflate global sensor access or choose a detour for the pilot.

**Acceptance:** Add this recorded oblique approach to `tests/local-control.test.ts`; require no swept contact, stopped motion and a truthful job outcome at both timesteps. Retain existing tests for arbitrary clear flight, loaded/profile speed, moving obstructions, stale/absent sensors, near-ground/roof retreat, two peers separating from overlapping sensing guards, and replacement with existing momentum. Preventing approach must not reintroduce an all-direction deadlock during a physically clear retreat. Run cargo arrival/service regressions too; stopping changes must not create load/unload speed spikes. A deterministic fixture proves control mechanics, not model navigation.

## 2. P2: Context growth still produces long decision pauses

| Pilot | Completed compaction, wall seconds | Completed-tool-to-next-call gap |
| --- | ---: | ---: |
| Red 2 | 54.306 | 57.972 |
| Red 3 | 65.001 | 73.264 |

Both hovered at already completed waypoints during those pauses. Blue 1 began another compaction immediately before the time limit, so its duration is unknown. Those pilots reached maximum reported input sizes of 241,437–242,616 tokens. Blue 3 also paused 58.000 seconds without a compaction boundary. Do not attribute every delay to compaction.

`server/observation-format.ts` already losslessly packs all 26 ranges into `fleet-observation/3`. Re-encoding the earlier battle reduced text bytes by 39.6%; that is not evidence of a corresponding inference-latency reduction. All 407 acquisitions in the new battle used the compact schema. Camera acquisition-to-delivery was median 15 ms and maximum 959 ms, much shorter than the measured compactions.

Inspect `actor-progress.json`, `final-assessment.json` and native audit metadata before changing `server/runtime*.ts` or the observation boundary. Measure repeated text/image/event contributions and distinguish ongoing local work from idle awaiting a new decision. Prefer removing representational duplication over adding a second planner or backend-specific orchestration. Preserve fresh acquired images, required sensor values and timestamps, unread mail, job provenance, cancellation and quota accounting. Keep gameplay **gpt-5.6-luna / xhigh** with no fallback. Do not promise input injection during private reasoning or unlimited context.

Acceptance needs measured token/byte volume and tool-gap distributions under the same bounded scenario, plus lossless observation and responsive cancellation tests. A single battle with fewer compactions cannot establish causality.

## 3. Gameplay QA: Hauling, recognition and aiming remain unproven

The two teams agreed on a gun-first recon plan but never generated income. They chose their own plans through delivered peer replies; no host assigned roles or routes. The nearest sampled opposing centers were still 20.764 local units apart, about 208 m. The map crop reduces available exploration space, but does not move the bases closer, rescale buildings or prove better behavior.

Red 2's first shot at sim 252.129 was 1.833 degrees from stationary Blue 2, range 25.934; the frozen-target ballistic diagnostic misses by 1.003 units. Its preceding acquisition was 6.174 simulation seconds old. At the second shot, sim 377.142, all blue drones were over 99 degrees from the firing axis; the acquisition was 8.332 seconds old. Both actual pre-shot images were inspected. Distant silhouettes/building features are not proof of confirmed enemy recognition. No moving-target hit was demonstrated.

Keep these evaluation failures separate from a projectile-engine bug. Use real acquired camera files and the corresponding delivered observations; projection-only visibility is a diagnostic, not something the pilot saw or understood. Do not feed player maps, cache coordinates, opponent poses, exact ballistics, a target locator or an automatic pathfinder to the pilots. Recognition/rules/calibration belong in `shared/mission.ts`, without prescribed purchases, roles, exploration patterns or routes.

After the controller gate, run the existing autonomous single-haul, repeated-haul and useful-team-haul scenarios from README before another normal full battle. Inspect whether pilots actually recognize pallets/aprons, enter the low/slow bands, deliver cargo, avoid revisiting empty caches and use received reports. Test failure cases without silently supplying a solved mission. Changing briefings or visuals requires fresh camera evidence and a separate source manifest.

## 4. First live program succeeded; useful reuse did not occur

Red 3 voluntarily wrote the 279-byte `sdk_probe.js`, ran it and read its JSON output. Write: sim 423.937; routine accepted: 428.763; completed: 429.058; output read: 437.137. Source hash: `47fe0e0f893c8ce1f3cd63e40a17887bc661f16d92d581fe6f8a0c5ee3cbb785`. The code enumerated the permitted SDK and wrote a private file. `supplementary-qa.json` preserves the actual returned content and lifecycle.

This updates the old “agents have never used code” finding. It proves voluntary authoring, execution and result inspection, with no demonstrated mission benefit. There was no reuse or transfer. Keep private workspaces empty at launch and received code inert until explicit import/run. Do not preload useful scripts merely to make a helper-use metric pass.

## Repairs that held, and limits of this evidence

- Opening objectives reached every drone in an actual bundle at sim 0 before movement or purchases.
- All 58 peer messages reached every expected drone recipient: 103 actual inclusions, including 47 copies of 28 status messages; no expiry notices. Storage receipts remain distinct from inclusion, replies and completed actions.
- One renderer fingerprint was accepted; the actual startup acquisition showed the current flat base apron. No camera failures occurred.
- Replay covered the entire 565.093 seconds and retained all 407 acquisitions and image files, using 10,927,519 JSONL bytes and 7,596,824 image bytes within unchanged limits. Final totals matched the audit.
- One opening send from Red 1 referenced observation sequence 4 after receiving sequence 2. It was correctly rejected and recovered. Do not weaken provenance validation to hide this pilot input error.
- No cargo service happened, so this battle did not exercise the repaired arrival/service interaction. Keep the deterministic regression evidence; do not claim live service validation from zero attempts.

The three committed analyzers (`analyze-trial.ts`, `analyze-haul.ts`, `analyze-engagement.ts`) can process the raw trial with its matching source. The additional `actor-progress.json`, `final-assessment.json`, `downtown-qa.json` and `supplementary-qa.json` are local evidence exports. Do not use an old analyzer's raw `step + 1` check to resurrect the fixed HUD overflow; display now clamps completed progress.

## Smaller map delivered with this handoff

`shared/downtown.json` now owns X **[-70,70]**, Z **[-40,60]**, Y **[-5,80]**: **1.4 × 1.0 km**, 69.3% less horizontal area than the previous map. The origin, axes and ten-meters-per-unit scale remain fixed. All six starts, both complete service aprons and five finite deposits keep their previous positions and stock.

`scripts/build-city.mjs` clips roads/parks/water and removes building boxes wholly outside the crop. Intersecting boxes remain whole, with their original position, rotation, tiers and dimensions shared by rendering/collision. Some edge geometry extends beyond the flight bounds; the boundary is not a physical wall. The regenerated scene has **192 building volumes, 448 road ways, four clipped parks and 64 safe intersections**. Source data and OSM attribution are retained. Regenerate with `node scripts/build-city.mjs`; do not manually edit the generated JSON or introduce a second copy of the extent. Historical replay headers retain their original bounds/geometry.

Validation: all **380 tests passed**, the TypeScript/Vite build passed, and `verify-rts.ts` passed on owned port 4322 without inference. The actual fitted map was visually inspected; all six cameras, complete aprons, clear mapped routes, simultaneous fixture hauling, equipment/rearm, responsive UI and reset passed. Regeneration is byte-for-byte deterministic and every retained building's pose/dimensions matches the prior generated scene. Evidence: `artifacts/compact-downtown-qa/`; source-manifest SHA-256 `69ea7218a7eed744c49dd009b4b347d53dc9ca04bf24bfc53e4bd5dcd2ec0853`. Vite retains its existing large-bundle warning. These checks do not cover the known failing approach, which the reproduction still demonstrates.

Map validation and any future live results belong in the newest section of `RTS-PLAYTEST.md`. The map and this handoff are separate from the still-unfixed braking defect.

## Resuming safely and efficiently

Run relevant deterministic checks and `npm run build`; convert the reproducer into a meaningful regression before changing control. Inspect `/api/state` before restarting anything. Preserve an active player session on 4317. Use a free isolated port (normally 4318), a current matching camera browser and a bounded Luna/xhigh trial. Set `RTS_TRIAL_PORT` and `RTS_TRIAL_SECONDS` explicitly; verify the exact scenario commands in README. Stop only the actors/helpers/server/browser you own, and save source identity, actual acquisition evidence, final totals and coverage before claiming success.
