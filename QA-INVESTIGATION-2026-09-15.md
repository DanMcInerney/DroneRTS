# Investigation of the September 14 battle QA

The original [QA report](QA-REPORT-2026-09-14.md) remains historical evidence for source `458f3b72fccfa2825bc25348b6e8003e8baccb3f`. This investigation preserves its conclusions and distinguishes code repairs from remaining autonomy questions.

## Confirmed code defects

- **Trial cockpit:** `scripts/trial-host.ts` omitted both the cockpit router and final MCP/runtime evidence callbacks. A shared `server/cockpit-session.ts` adapter now owns that composition for production and trials, including session isolation, real virtual workspace inspection and keeping streaming text out of persistent audits. Storage, image handling and HTTP validation remain in `server/cockpit.ts`.
- **Destruction presentation:** dead drones previously retained a dark, tilted airframe at the recorded death pose although they were no longer live collision/shot targets. `DroneVisuals` now hides eliminated aircraft in player views and actual acquired snapshots. Living unarmored drones keep their team color; older acquired snapshots retain their own alive state. No wreck physics, target classification or attacker/location feedback was added. The common briefing states this visual distinction.

## Decision pauses: measured context contributions

The existing offline analyzer now measures each pilot's field volumes and the recorded additions between trial start/previous completed compaction and the next compaction start. The original managed battle was analyzed before running new tests, as required by artifact retention.

| Pilot/window | Bundles/images | Tool text bytes | Sensors + current telemetry bytes | Exact duplicated current-state values | Last reported input tokens before compaction |
| --- | ---: | ---: | ---: | ---: | ---: |
| Red 2, first | 23 | 119,859 | 64,348 | 8,749 | 239,911 |
| Red 1 | 39 | 197,593 | 116,656 | 13,633 | 243,509 |
| Red 2, second | 22 | 117,103 | 58,596 | 10,027 | 244,725 |

The three windows end at 01:12:29.094, 01:14:27.170 and 01:16:37.005 UTC on September 15. Red 2's second starts after its previous compaction completed at 01:13:17.647. Emitted summary text totals 1,478 / 1,833 / 1,451 bytes; ordinary emitted output totals 1,419 / 940 / 3,207 bytes. These are emitted summaries, not full private reasoning.

Sensors/current telemetry account for 50.0–59.0% of these text bytes. Exact repeated cargo/logistics/equipment/account/job/ammo/service values account for 6.9–8.6%. Removing that duplication alone has no demonstrated causal effect on the 42–49-second compactions. The runtime sends one final MCP response per boundary; `mcp-result` audit records contain completion metadata rather than a second model response.

Native token reports include backend context whose per-field/image allocation is unavailable. JPEG/text byte counts cannot explain or assign all of the reported tokens. Recorded additions do not reconstruct retained context after compaction. The existing non-compaction pause also remains a separate unresolved delay. No model, context-window, compaction policy, observation schema, image cadence or sensor precision was changed.

## Logistics: separate recognition from physical service

The battle had zero pickups or deliveries and conserved all 840 salvage. Actual emitted opening statements describe gun-first scouting/support choices. Blue 1's emitted summaries only explicitly discuss identifying a yellow crate near the end (01:19:40.932 UTC), and Blue 3's later summaries discuss salvage scans. This supports delayed logistics attention in this sample, without proving what every pilot perceived or establishing a service-engine defect.

The investigation tested autonomous single hauling with normal stock, equipment and camera-based discovery, then a fresh repeat, then team hauling. All three trials used six clean-context Luna/xhigh actors, fixed 1×, stock trial objectives and the same source manifest. Red received a stationary evaluation objective. No solved route, resource location, purchase policy or additional planner was supplied. These are logistics trials rather than battles.

### First fresh single haul: passed

Run `2026-09-15T02-27-58-524Z-focused-haul-single-0567e7f0`, source manifest `2bf300245ad0a486afabb22833533d1896a2d699433e8733135e7baa638b5093`, used a 600-wall-second ceiling at fixed 1× and ended on its first delivery. Blue 1 bought cargo at sim 27.243, picked up 60 at 129.540 and delivered 60 at **181.102**. The runner stopped at 185.998. All six survived with armor intact; zero collisions, lost cargo, runtime failures or replay warnings. Final conservation: 780 stock + 0 aboard + 60 delivered = 840.

All four analyzers passed. All 83 delivered acquisitions have image files. The actual loading image at sim 128.523 (`0945aa3a-71bd-4391-be16-a4acdf3e645b.jpg`) clearly shows two ochre crates and the marked apron. The return image at sim 178.701 (`f0eeb1da-7aa6-43b9-bd00-ae07459f0827.jpg`) shows the blue base apron. Both were inspected, alongside the elevated return view. Blue 1's emitted report identifies the picked-up 60 and planned return; actual service events establish completion.

No scripts or transfers occurred. Blue 1 received 25 model bundles / 125,766 text bytes, reached 62,980 reported input tokens, and had no compaction. Its completed-tool-to-next-call median was 5.177 s and maximum **26.502 s**, almost entirely stationary. This successful haul therefore still exhibits a long non-compaction pause. The whole fleet received 394,219 text bytes and 871,896 JPEG bytes; these remain byte measurements, not token attribution.

Live cockpit validation returned HTTP 200 `fleet-cockpit/1` JSON, an actual session-bound image URL, output/summary/tool events and an available empty real workspace. The sidebar cockpit visibly displayed that evidence while captures continued. A stale file-preview label on the unavailable-to-available transition was found and repaired after the live trials in its existing owner, `client/cockpit-workspace.ts`. The owned tab closed, cleanup completed, and all recorded process identities were absent afterward.

### Fresh single-haul repeat: passed

Run `2026-09-15T02-33-12-495Z-focused-haul-single-9f9b028e` used the **same source manifest**, fresh actors and the same 600-wall-second ceiling. Blue 1 picked up 60 at sim **316.149** and delivered at **396.574**, stopping at 399.008. It chose a different cache and corrected several visual position estimates. All six survived; no collisions, lost salvage, failures or replay warnings. Conservation again ended at 780 stock + 60 delivered = 840. Every recorded source hash still matched after the run.

All four analyzers passed; all **195 acquisitions/images** were retained. Loading (`ca659949-be7c-4d52-a0f1-730ff7e6f7e5.jpg`, sim 313.195) and return (`819df909-0098-450e-bc66-e5953d50ee75.jpg`, sim 395.563) camera files were inspected. Blue 1 received 58 bundles / 274,615 text bytes and reached 125,411 reported input tokens, with no compaction. Its completed-tool gap median was **4.543 s**, maximum **18.038 s**. No authored scripts or transfers occurred. Cleanup completed, the camera tab closed, and no recorded owned process survived.

These two trials establish two independent successful discovery/pickup/return loops, with substantial timing variation. They do not prove repeated cycles within a single match or a battle economy.

### Team haul: useful income, collision still open

Run `2026-09-15T02-41-58-381Z-focused-haul-team-23136e57` used the same manifest and 600-wall-second ceiling, ending at sim **567.283** with all six alive. All three blue pilots delivered: Blue 2 banked **60 at 268.552**, Blue 3 **30 at 359.530**, and Blue 1 **30 at 518.471**. Blue 2 picked up another 60 at 520.700 but did not finish its second return before the limit. Final conservation: **660 stock + 60 aboard + 120 delivered + 0 lost = 840**.

All four analyzers passed; 231 acquisitions had image files, with no runtime failures or replay warnings. Recorded source hashes still matched after the run. Actual loading/return images were inspected for every delivering pilot: Blue 2 `4a031dde-c043-426a-9467-025f34c8d104.jpg` / `6f207b78-c678-4603-a934-698c47f8c0c8.jpg`; Blue 3 `1ec14e04-794b-4b4f-bda5-a26754ca06f1.jpg` / `715b7acd-3fc4-48f3-8ac2-4fbde233e491.jpg`; Blue 1 `d72e9cef-f47c-4731-87df-5aa539193052.jpg` / `0584e36e-7232-48c2-abd6-739553898543.jpg`. Blue 2's second pickup view, `c13573b7-419f-4b0b-91f1-434f4c68154e.jpg`, shows remaining crates and empty pallets at its offset position.

The emitted reports confirm pickup/return intentions and later acknowledgments of armor loss. Actual service events, rather than pilot estimates of peers' cargo, establish delivered income. Multiple blue drones moved concurrently for part of the trial, but no authored scripts, routines or code transfers occurred. This establishes useful contributions from all three pilots, with inefficient timing and incomplete repeated hauling. It does not establish successful battle logistics or useful code reuse.

The fleet received 1,100,840 text bytes and 2,977,308 JPEG bytes, with no compaction. Blue 1/2/3 reported maximum input sizes of 125,704 / 141,210 / 106,911 tokens. Their completed-tool gap medians were 8.381 / 7.006 / 7.225 s and maxima 25.842 / 24.243 / 19.113 s. Shorter logistics samples with no compaction do not demonstrate a latency improvement. Cleanup completed, the owned camera tab closed, and all 37 recorded process identities were absent afterward.

### Newly reproduced opposing-motion contact

At sim **392.331**, Blue 1 and Blue 2 collided above the central loading apron at x −3, z 35.600. Blue 1 was ascending with 30 cargo under the precision profile; Blue 2 was descending empty under the travel profile. Their centers were y **4.731 / 5.491**, with retained vertical velocities approximately **+0.103 / −0.804**. Both jobs had already reported `blocked: obstruction`. Each lost its initial armor charge; both survived with the cargo preserved.

`node --import tsx scripts/reproduce-closing-contact.ts` isolates the same kind of vertical encounter, load and profiles, replacing the horizontal approach with deterministic acceleration from rest. It uses the production finite sensors, sequential acquisition/integration order, controller and swept contact test, with no buildings or inference. It reproduces contact at **4.934 s with dt=1/120**, and **4.938 s with dt=0.0078**. The descending drone first blocks with roughly 0.911/0.915 units of physical gap; the ascending drone blocks only around 0.142/0.150. Both are braking before contact. The script reports the defect without asserting that it must remain present.

**Cause boundary:** the controller certifies its own stopping corridor against instantaneous anonymous ranges. It does not reserve the gap needed while the other body keeps approaching. This differs from the repaired slow oblique approach to a stationary peer. A blocked job correctly cancels further commanded work, but does not imply momentum has vanished or certify safety against another moving body.

**Open repair:** keep any response in `DroneMotion` using permitted finite sensor history and own vehicle state; keep geometry in `LocalSensors`. Do not add a team coordinator, expose peer velocity/IDs, teleport either drone or silently reroute. A future repair should prevent this closing encounter at both timesteps while retaining clear retreat, moving-obstruction, stale-sensor, profile/load, arrival and cargo service checks. No controller change is included here. Further battle inference was deferred after this reproducible failure.

## Validation

- **421/421 tests pass** with `npm test -- --test-concurrency=2`. The first broad run caught an incorrect setup in the new cockpit test (fixed) and a QuickJS test in which the CPU deadline fired before the expected pending-call limit. The runtime limits were not relaxed; the complete lower-concurrency rerun passed.
- **Production build passes**, with the existing large-bundle advisory.
- **Deterministic browser fixture passes** on an owned 4318 host, with no inference. Besides existing camera, cargo/service, UI and reset checks, it captures identical armored/unarmored/destroyed poses at 110 m. All three acquired JPEGs were inspected, including a nearest-neighbor center crop. The eliminated target's frame is byte-identical to an acquisition with that target absent; living unarmored pixels differ. This proves rendering, not live recognition.
- Deterministic source manifest: `2bf300245ad0a486afabb22833533d1896a2d699433e8733135e7baa638b5093`. Managed run: `2026-09-15T02-24-16-893Z-qa-investigation-db94408c`, with `tests/tests.log` and `rts-ui/`. Its owned host/browser closed; 4317 and 4318 were initially unavailable.
- All three live hauling trials and their offline analyses are complete. Their exact manifest predates the final workspace-label correction and added offline reproducer. Managed retention prunes preceding completed raw runs; historical reports and the measured conclusions here remain.

### Final checks after the small UI correction

Managed run `2026-09-15T03-03-17-094Z-qa-investigation-final-aed31a2d`, **184 source files**, manifest **`8133a701c6053b8a156069687f92dd5887c8d5c08cd432b85f8b042e64ac3e30`**:

- **16/16 focused cockpit/rendering/trial-host tests passed**. The complete 421-test suite had already passed before the final label-only production change.
- An isolated Playwright fixture used the shared cockpit API, real `FleetGame` virtual storage and actual `CockpitWorkspaceView`. It verified the same-session unavailable → available empty-workspace transition, real version/hash-bound file preview, preserved selection on refresh, clearing on destruction and no consumed mail or browser errors. It started **no inference** and closed its browser/ephemeral HTTP/Vite server.
- Both portable collision reproductions ran. The old stationary-peer case remains contact-free and stops; the new closing-motion case still contacts at both timesteps. See `stationary-contact.json` and `closing-contact.json`.
- Final **`npm run build` passed**, with only the existing bundle-size advisory. `git diff --check` passed.
- Ports 4317/4318 were unavailable before the final fixture. The final managed run contains `result.json`, `focused-tests.log`, both reproducer outputs, `workspace-file.png` and its source manifest. It is the sole retained managed raw run after prior trial evidence was analyzed and documented.
