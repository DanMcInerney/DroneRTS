# Strategic economy live playtest — September 14, 2026

Status: both matches finished and analyzed. The first reached its time limit; the second ended naturally after 277.181 simulation seconds. Neither team mined salvage. The trial cleanup defect found in the second run is fixed and regression-tested; the resource-evidence issue described below remains to be fixed.

## Scope

Two independent normal-opening matches, each bounded to eight wall-clock minutes, using **gpt-5.6-luna / xhigh** for both mechanical parents and all six clean-context drone actors. The production mission and rules are unchanged between runs. No fixture equipment, extra income, assigned roles, resource coordinates or operator coaching were supplied.

The Codex sidebar browser provided the actual camera images and a watchable view at `http://127.0.0.1:4319`. Port 4317 was unavailable; another checkout's idle server on 4318 was preserved. The focused runner now accepts `RTS_TRIAL_PORT`, defaults to 4318, refuses occupied selected ports and forbids player port 4317. The runner owns and stops its native actors, protocol helpers and server after each trial.

The tested working tree is based on `d4a11e5b46a84c02be37a9766bbd3e8980e8b9d5`, with uncommitted milestones 1–2. Source manifests identify the actual tested files; the base commit alone does not reproduce them.

## First match

Local evidence: `artifacts/focused-trials/2026-09-14T15-18-45-040Z-match/`. Launch manifest SHA-256: `d21ff46c3b24695e830ae70e11f1875a8c13f5436ae866878ee6cf1e56ba30f5`.

- Time limit at **479.986 simulation seconds**, no winner, one survivor per team. **397** delivered camera observations, **55** drone-sent radio messages, no missing camera images, runtime/tool errors or replay warnings.
- Red 3 bought a gun at **27.502 s** and Blue 3 at **32.262 s**. Each exhausted its team's 30-credit opening balance. No further purchases and **zero mined salvage** for either team; all five deposits retained their full combined 1,500 salvage.
- Only two mining attempts: Blue 1 at **380.416 s**, Red 1 at **452.735 s**. Both were outside reach. Across sampled live poses, the nearest any drone came to any resource base center was **26.456 local units**. The central deposit was neither reached nor mined.
- Drones reported yellow resource candidates and exchanged positions, claims and requests to investigate. Saved Blue 2 images at **87.918 s** (`557a9bc5-41af-4f16-aac7-15d650988e69.jpg`) and **391.746 s** (`66154d31-807f-427b-88e3-2637ad2a6545.jpg`) visibly contain yellow clusters. The failure was not simply an absence of visible resources: sightings did not become a successful approach and descent.
- Four autonomous charges completed: Red 1 at **348.321 s**, Blue 3 at **372.029 s**, Blue 1 at **443.759 s**, Red 2 at **455.246 s**. No power-loss deaths occurred. Blue 1/2 collided at **450.675 s**; Red 2/3 collided at **479.817 s**. All four deaths were teammate rams. Successful charging therefore does not establish safe return traffic.
- Red 3 fired twice, at **316.593 s** and **327.719 s**; both projectiles expired without contact. No opponent pair came within 40 local units. There is no evidence of successful combat or a central-resource battle.
- Median camera acquisition-to-delivery was **10 ms**; median delivered-result-to-next-call was **4.379 s**, including native processing, model decisions and tool dispatch. The latter is not an isolated measure of private reasoning.

## Second match

Local evidence: `artifacts/focused-trials/2026-09-14T15-27-31-482Z-match/`. The source manifest is byte-identical to the first match: `d21ff46c3b24695e830ae70e11f1875a8c13f5436ae866878ee6cf1e56ba30f5`.

- Natural **blue victory at 277.181 s**, with all three blue drones surviving. Red 1/3 collided at **174.542 s**; Red 2 hit terrain at **277.181 s**. No shots were fired. This was an elimination through navigation accidents, not successful combat.
- **236** delivered camera observations and **35** drone-sent radio messages; no missing images, recorded gameplay/tool errors or replay warnings. Expected action rejections are distinct from runtime failures. The separate shutdown failure below prevents describing the entire runner as error-free.
- Blue 3 bought a gun at **30.702 s**, Red 3 at **38.465 s**. Three other purchase attempts were rejected for insufficient shared funds. Neither team earned salvage; all deposits remained full. No charges or jamming occurred before the early finish.
- Blue 1 made **five** mining attempts and Blue 2 made one. Blue 1's first four were outside reach. Unlike the first match, Blue 1 then reached the Elm deposit: the first sampled unobstructed pose inside mining reach was **249.370 s**. It stayed in reach through the finish.
- At **255.925 s**, Blue 1 was **1.428 local units from the mining focus**, with clear line of sight, but its fifth mining request still failed. Reconstructing `ResourceVision` from the actual recorded poses, images, FOV and unchanged source shows that the last valid sighting at **248.503 s** was replaced by empty evidence at **251.486 s**. The latter image (`88f9f9b2-fd1c-4d45-a3b2-f44dc94cdf02.jpg`) visibly contains a large portion of the deposit clipped along its bottom edge, while the tested center lies outside the gate's vertical margin. The earlier valid sighting was only **7.422 s old**, inside the nominal 15-second lifetime, but had already been discarded.
- Blue 1 backed away at **262.076 s**, turning its camera away through the movement controller's normal heading behavior. Its last delivered image at **264.870 s** (`b3d72386-8822-4c45-8777-c4e74027c676.jpg`) faces away; it made no further mining call before victory. The nearest sampled distance to a resource base center was **2.060 units**; this differs from the mining-focus distances because that focus is above the resource base.
- Median camera acquisition-to-delivery was **9 ms**, and median delivered-result-to-next-call was **3.781 s**. No central-deposit mining, paid resupply, economic expansion or useful jammer strategy was demonstrated.

## Shutdown defect and evidence recovery

After the natural finish, the actors and native protocol helpers stopped and the complete replay received its terminal record. The runner then stalled in `host.close()`. Port 4319 stopped listening, but a remaining upgraded TCP connection kept HTTP close pending. Closing the temporary browser released the remaining handle; Node exited with an unsettled top-level await before the runner wrote `result.json`.

The second run's `result.json` is explicitly marked as **recovered** from the complete replay, audit and source manifest. Its final drones, economy, time, victory and event history are recorded evidence; the actor roster/model comes from the last runtime audit. Original in-memory sample arrays, the startup preflight object and the complete original final-state object were not recovered. The cleanup failure and reconstruction limits are preserved in the file and downstream analysis. No replay or audit was rewritten, and no replacement inference trial was launched.

The host previously closed Vite before its parent HTTP listener. A browser HMR reconnect could arrive after Vite removed its upgrade handler; an unmatched upgrade was then owned by neither WebSocket server. `closeAllConnections()` does not close upgraded sockets. The fix stops listening before closing Vite, tracks and destroys all owned TCP connections, and makes close idempotent. The runner now saves its original result with `cleanup: pending` before teardown and updates it afterward.

An actual-host regression, without starting gameplay actors, holds both a normal game WebSocket and an unhandled raw upgrade open during shutdown. It verifies bounded close, both client disconnections, repeat/concurrent close, a flushed audit and immediate port reuse. This passed, as did the final TypeScript/production build. Both live trials preceded this cleanup fix; the fix has no claimed additional live-inference validation.

The owned trial server, actors/helpers and temporary browser are closed. The other checkout's 4318 server remained idle at simulation time zero.

## Interpretation and next experiment

The runs demonstrate functioning opening purchases, actual peer traffic, autonomous charging in the first match and a successful physical resource approach in the second. They do **not** demonstrate an expanding economy, strategic item balance, useful jamming or competitive combat. No drone bought optics, a drill, armor, an extra battery or a jammer.

First, fix and test retention of each actually observed resource's recent evidence across subsequent off-center images, retaining expiry, mission isolation, physical reach and line-of-sight checks. The second trial provides a concrete regression case; increasing mining reach or removing camera evidence would not address its cause.

Then run a bounded **gather-and-return trial** with the existing world and a generic resource objective, measuring first candidate sighting, physical approach, successful extraction and pad return. That isolates navigation and service traffic before changing prices or adding weapons. Keep the no-map/no-calibration observation boundary, hidden deposits and central mega deposit intact. The changed objective must be labeled separately from a normal-match success rate. The resource-evidence fix and this next trial are outstanding work, not results of the two matches above.

## Reproduction and verification

Each trial used `RTS_TRIAL_PORT=4319` and `RTS_TRIAL_SECONDS=480` with `node --import tsx scripts/playtest-focused.ts match`. Keep the camera browser open at the printed URL. The runner refuses an existing server on the selected port.

Run `node --import tsx scripts/analyze-trial.ts <trial-directory>` and `node --import tsx scripts/analyze-engagement.ts <trial-directory>` against the recorded calibration. Their `analysis.json` and `engagement-analysis.json` preserve events, commands, acquired-camera references, transport timing and geometric diagnostics. The local `artifacts/strategy-live-audit.mjs` additionally writes `strategy-analysis.json` with purchases, services, deaths and sampled resource distances.

Sampled positions do not prove visual recognition or intent. Camera-frustum/building-occlusion calculations are visibility proxies; actual delivered images remain authoritative. Two runs are diagnostic evidence, not a reliable win-rate or balance estimate. Raw session logs, images and analysis artifacts remain local and excluded from Git.

The final runner changes passed `node --import tsx --test tests/trial-host.test.ts` and `npm run build` (existing bundle-size advisory). Separate no-inference guard checks rejected occupied 4318 and forbidden 4317. Milestones 1–2 previously passed 242 automated tests and 34 deterministic control fixtures; see [ENDURANCE-VERIFICATION.md](ENDURANCE-VERIFICATION.md) for that historical verification scope. The full suite was not rerun for the isolated runner fix.
