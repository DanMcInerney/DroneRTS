# Normal battle QA — September 16, 2026, 17:05 UTC

The requested normal battle completed its 600-wall-second limit with six survivors, no winner, no shots and no collisions. All six pilots picked up salvage; five delivered it. Blue banked **90**, red **60**, and Red 3 retained **30** aboard. Four pilots bought guns. The observed economy, camera delivery, radio delivery and Nervelet acknowledgement behavior matched their code contracts. Combat effectiveness and repeat hauling were not demonstrated.

## Source and execution

- DroneRTS: `eacc8a26c7e6f8d17ffc83caf3fa619bb910599b`, clean gameplay source throughout the run.
- Nervelet: unpatched `4c5d0c152800ef8575b32a097c0464f8be3607cd`, built from its source before launch. Archive SHA-256: `f49406d9adbd43a1ca1cca5a8a6545dadab4d2e5b64306e42322edf47fbc7206`.
- Run source manifest SHA-256: `147d4be50264be86fc16a16a9ed14c8d3c87fc4d868eb2813b62e2f4ca855222`.
- Two mechanical parents and six clean-context native pilots, **gpt-5.6-luna / xhigh**, real Zenoh/MAVLink and the in-app browser camera. Normal `match` scenario; no fixture equipment, extra actor instructions, or player intervention. Attention and acoustics explicitly off.
- Owned port **4318**, fixed **1×**. Ports 4317/4318 were unavailable before launch; 4317 was untouched. Server ready at 17:05:37 UTC, trial cleanup finished 17:15:56 UTC. The 600-second trial budget begins after camera connection. The saved pre-cleanup state is sim **570.039**; the final stopped replay frame is **570.211**.

Read the project contracts and the owning implementation before launch: `shared/mission.ts`, `server/team-session.ts`, `server/game.ts`, `server/rts.ts`, `server/nervelet.ts`, runtime/tool dispatch, and pinned Nervelet `core.ts`, `waits.ts`, `results.ts` and instruction generation. This QA changed no gameplay or dependency code.

## Expected versus observed

| Contract and owner | Observed evidence |
|---|---|
| All six opening objectives must reach actual submitted bundles before simulation unlocks (`server/game.ts:215`, `server/launch-gate.ts`). | Every pilot's first mission-1 bundle was submitted at sim 0, between 17:06:23.043 and 17:06:26.029 UTC. All later gameplay used mission 1. |
| Low/slow loading, atomic delivery and finite stock (`server/rts.ts:335–402`). | Six 30-salvage pickups and five deliveries. Every one of **1,179 replay frames** conserves the original 840: final **660 stock + 30 aboard + 150 delivered + 0 lost**. Reservations are part of remaining stock, not added again. |
| Equipment spends delivered shared credits inside friendly service. | Blue 1/2 and Red 1/2 each bought a 30-credit gun with 12 rounds. Final balances: blue 30, red 0. No armor, cargo-module, rearm or firing event. |
| New observations carry actual acquired images; image age is descriptive. | **393 submitted bundles**, all with images, matched **393 replay acquisitions and 393 existing image files**. No missing/omitted image, failed submission, browser JavaScript error or acquisition timeout. Image age at assembly ranged about **17–434 ms**. |
| Radio queueing, inclusion and acknowledgement are separate. | **45 peer-originated sends** implied **85 pilot-recipient copies**; all 85 appeared in submitted recipient bundles. This denominator excludes player recipients. First-inclusion latency: median **5.556 s**, maximum **21.294 s**. Inclusion does not establish understanding. |
| Retained results release only after `seen`; admission is separate from job completion. | **393 assembly/submission pairs**, **326 acknowledgement traces**, **184 admissions**. Completion traces: **71 completed, 7 blocked, 2 failed**. The failures were explicit controller rejections; the blocks reported obstruction. |
| Conditional waits preserve local execution and bounded review. | **106 wait/wake pairs**: 75 job-terminal, 15 review, 12 altitude-threshold, 4 event wakes. No incomplete wait pair remained. |

## Gameplay outcomes

Times below are simulation seconds; each pickup/delivery is 30 salvage.

| Pilot | Pickup | Delivery | Final equipment/cargo |
|---|---:|---:|---|
| Blue 1 | 300.355 | 363.017 | Gun, 12 rounds |
| Blue 2 | 223.663 | 322.274 | Gun, 12 rounds |
| Blue 3 | 477.992 | 560.443 | Empty, no gun |
| Red 1 | 309.347 | 417.222 | Gun, 12 rounds |
| Red 2 | 390.068 | 476.780 | Gun, 12 rounds |
| Red 3 | 566.385 | — | 30 aboard, no gun |

The Atrium cache was exhausted at sim **390.068** after four pickups. Pilots shared discoveries, confirmed pad estimates, loading intentions and spending reports. Blue 1 subsequently loaded at Blue 2's reported apron; this is evidence of actual useful reporting and multiple contributors to income, not proof of an authoritative team plan. Nobody completed a second haul. All six surviving pilots and zero shots mean this run does not qualify targeting, moving-target hits, gunshot wreck visuals in live combat, or last-team-standing autonomy.

Actual 512×288 acquisitions were inspected, including distant yellow aprons, Red 1's readable CARGO pad, Blue 2 over the loading apron and friendly base, and Red 2 over the depleted apron. Selected files in the replay directory:

- `48b157f1-361b-4350-bb9a-f4a8c3d45f08.jpg`: Red 1, sim 142.828; readable CARGO marking before its discovery report.
- `6247ecae-3ad1-4501-9c49-43626732e73c.jpg`: Blue 2, sim 232.231; loading apron after pickup.
- `7274db16-43f8-4eb2-a314-bdb58899ffdc.jpg`: Blue 2, sim 329.582; friendly base after delivery.
- `c17f19cd-5896-4e15-b832-3cc85b2f0fca.jpg`: Red 2, sim 407.103; emptied loading apron after the fourth pickup.

## Findings and interpretation

**Bundle-ID handling added avoidable failures and repeated context.** Red 3 transposed `84af0cde` into `84afc0de` in four `seen` values at 17:06:23.820, 17:06:33.044, 17:06:59.717 and 17:07:13.671 UTC. Nervelet correctly returned `unknown_bundle`; fresh observation and corrected IDs restored progress. Its **61 observe calls all omitted `seen`**. Its 102 submitted bundles contained **154 event appearances representing 81 distinct events**, and **58 original-result payload appearances representing 24 command IDs**. The other five pilots had no repeated event or original-result-payload appearances. These are correct redeliveries following omitted acknowledgements, not duplicate execution. The interaction is a usability concern for the pilot/API boundary; this sample does not establish that changing ID format would improve outcomes.

**Valid admission did not guarantee a valid waypoint.** Red 2's command `c9` requested X=65 and Red 3's `c8` requested X=60, beyond the simulator's X maximum of 50. They became explicitly failed jobs at 17:08:12.924 and 17:09:18.332 UTC (`server/game.ts:927`). Their accepted Nervelet receipts describe job admission. The current job and local events carried the later failure. No boundary geometry or coordinates were supplied to pilots by this QA.

**Decision/context cost remains substantial without a compaction failure.** No completed or unfinished native compaction was recorded. Maximum completed-tool-to-next-call gap was **32.034 s** (Blue 2). Such gaps include backend, transport and dispatch time, not just private reasoning. Red 3 reached **242,417** reported input tokens versus **143,027–180,048** for the other pilots and received 102 bundles versus 56–61. Its extra observation/acknowledgement pattern contributes repeated material, but this run does not isolate its causal token or latency cost. Millisecond gaps in Red 3's sequential multi-call activity must not be interpreted as independent reasoning decisions.

Blue 1 also attempted `c1` before acknowledging the changed-goal recovery and received `not_executed: refresh_required`; it later proceeded normally. There were no unknown receipts, ID-conflict, result-backpressure or receipt-backpressure, and no runtime/transport failures before shutdown. At **17:15:56.237 UTC**, all six pilots recorded confirmed lifecycle controls. At **17:15:56.254–255**, both parents' pending `forward_next_instruction` calls and Red 3's `observe` logged failed HTTP transport results as connections closed (audit lines 10837, 10841, 10844). Red 3 also returned `operation_failed: Drone session ended`. These are shutdown cancellations, not healthy-match failures, and all owned processes exited. Ordinary operation did not exercise loss/retry deduplication, native compaction recovery, exchanges, workspace/routines/transfers, emergency attention, or acoustic sensing.

## Verification and retained evidence

The pinned dependency setup, application dependency/native-helper installation and TypeScript/Vite build passed. The build retained its large-chunk advisory. Browser warnings were limited to sky-blur sample clipping and deprecated soft-shadow selection; no JavaScript errors were recorded. All four existing offline analyzers completed successfully, and the run-local audit separately joined actual Nervelet submissions, acknowledgements, original results, distinct mail copies, image files and conservation across every recorded frame. The existing analyzers' error filters omit nested `agent/mcp-result.error`; the supplemental audit retains all three such records and classifies them against the six-pilot shutdown boundary. Analyzer completion alone is not a claim that every gameplay acceptance gate passed. Independent review confirmed the central measurements and identified this shutdown-error qualification, which was corrected in the report and supplemental audit.

All **38 captured owned processes** had exited by the cleanup check; port 4318, the camera tab, both native sessions and protocol helpers were closed. No active player session was restarted. Raw artifacts remain in the single newest managed run:

`artifacts/test-runs/2026-09-16T17-05-37-555Z-focused-match-4254b4f5/`

Key files: `result.json`, `source-manifest.json`, `analysis.json`, `haul-analysis.json`, `engagement-analysis.json`, `decision-latency.json`, `battle-protocol-qa.json`, reproducible `audit-battle.mjs`, `source-and-receipt-check.json`, `nervelet-notes.md`, `cleanup-check.json`, the session audit, native network stores, and `replays/session-match-2026-09-16T17-05-37-650Z/`. Managed retention can prune this raw run after a later completed test; this report preserves its source-specific findings.
