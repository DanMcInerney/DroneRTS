# Nervelet upgrade implementation and qualification — September 16, 2026 UTC

**Historical policy correction:** [Camera-age qualification](CAMERA-AGE-POLICY-QA.md) supersedes this report's hard two-second emergency camera gate. Age is now reported as evidence; a successfully acquired delayed image is delivered without reacquisition. The measurements and failed strict-policy trials below retain their original meaning.

**Publication update:** [Nervelet PR #4](https://github.com/DanMcInerney/nervelet/pull/4) merged the exact pinned source into upstream main on September 16. The local/unpushed limitation described below is resolved; package integrity is unchanged and setup still builds the tarball locally.

Implemented in the requested `145b/DroneRTS` worktree, preserving its existing uncommitted integration. Application base HEAD is `7379731b4869beb25412ff0cee4d7a0d970b6662`; native evidence records the actual dirty source through SHA-256 manifests, not HEAD alone. Windows x64, Node 24.15.0, Python 3.14.6, Codex CLI 0.144.0. Every native actor used verified **gpt-5.6-luna / xhigh**, with image support and no fallback.

**Enabled:** unpatched pinned library, original-execution reconciliation, canonical recovery before sizing, final MCP submission accounting, cancellation and exact native-turn ownership. **Off by default:** emergency attention and acoustic sensing, independently opt-in with `FLEET_ATTENTION=experimental` and `FLEET_ACOUSTIC=experimental`. Native interruption is demonstrated, but emergency enablement remains gated on camera freshness and the remaining native scenarios. The current single-haul gate is also still open; no repeated/team hauling or battle followed a failed single haul.

## Loop and ownership

Before this upgrade, the local integration patched an older Nervelet source during packaging. It assembled recovery before a final host-output confirmation existed, and native active turns were tracked without joining outstanding HTTP/result work. Cancellation could leave native sampling or browser capture requests alive. Sensors, routes and routines already ran independently of model inference; this upgrade does not claim to introduce that concurrency.

Now each pilot still has one native child, one borrowed Bridge and one movement writer. Ordinary updates wait for tool boundaries. Nervelet owns canonical recovery, receipts, generation, acknowledgement, attention coalescing/budgets and `settleEmergency`. DroneRTS owns factual sensor meaning, episode classification, game authority, local work, quotas and the exact native lifecycle. No supervisor, second model, planner, sensor database or new public batching tool was added; `exchange` remains the sole batch interface.

The final MCP JSON-RPC output is checked after appended catalog/control/error content. HTTP finish confirms submission; failure/disconnect does not. A later `seen` acknowledgement consumes only included FIFO mail. Completed domain action is a third, separate stage. Effect schemas carry the actual originating `generation`; acknowledging fresh recovery cannot authorize stale decisions. `reconcileReceipt` checks retained kind/digest and awaits the original execution promise, never replays a mutation, and cannot evict unresolved records.

Emergency settlement joins a matching terminal event **and** both native tool items and outer request/result work. An interrupt acknowledgement does not prove termination. One continuation owner serializes ordinary endings, catalog refresh and attention. Replacement uses the same session and exact received objective with actual newly acquired image/text. There is one camera reacquisition if attention invalidated capture or the frame is stale; continued failure is explicit. The existing two-second camera freshness limit is enforced before emergency output. Healthy local routes/routines remain valid through model interruption; physical and lifecycle safeguards retain authority.

Acquisition cancellation reaches FleetGame, native Python/MAVLink sampling, CameraChannel, and queued browser capture callbacks. Timers/listeners are removed; late responses cannot supply pixels or overwrite a newer result. Executing synchronous GPU work cannot be interrupted, so late output is discarded. Native compaction recovery uses correlated completed items; late old-turn notifications cannot invalidate a replacement. A native-discovered launch bug was fixed: an actually submitted objective counts for launch even when a concurrent acquisition correctly returns no image. It still does not count as acknowledgement.

## Exact upstream dependency

Reviewed candidate `f0c2de60847ab6889c7cc3b95e646f262697861e` was compared with original Nervelet main `ed11834487d8633c4c58b4114c02080f2b6fe64d`. The newer main's documentation changes did not resolve R3. Generalized fixes were made in the isolated `C:/Users/danhm/tools/nervelet-host-confirmation` worktree, branch `codex/host-submission-confirmation`. The original main checkout remains clean at `ed118344…`.

| Identity | Value |
| --- | --- |
| Final exact source | `4356691bede0e2810cb7d2c453a7f2ec3ff61396` |
| Package | `nervelet@0.2.0`; version alone is insufficient |
| Dependency archive | `.runtime/nervelet-4356691bede0e2810cb7d2c453a7f2ec3ff61396.tgz` |
| Archive SHA-256 | `1d3644d673b5f1d97d72bc0c7a06b88069aac60347b19cb884a4a46bdeeb58b2` |
| Lockfile SHA-512 | `R//N74H2ftJVmoOJecgvfkmieFCJ8yx5s1MJe/aVeV/2vOzkGAtU17T0juBParrkHm+eycSq2DL94vUOd/un4A==` |
| Archive / unpacked package | 113,379 / 385,678 bytes |
| Isolated installed core | 1,683,263 bytes, six packages |

Upstream commits add host submission confirmation/failure (`65558eb`), join after reconciliation invalidates submitted recovery (`d94a1de`), make serial bindings an optional peer (`5b76269`, development build types in `4356691`), and handle failed ordinary output without an attention state (`750d933`). The generic API has no drone or MCP policy. Core defaults remain compatible for hosts not selecting `submission:'host'`.

The source is **local and unpushed**, not a published npm/GitHub release. Setup builds exactly that commit without application-private source patches and verifies archive integrity. `NERVELET_SOURCE` can select another source clone containing it. Another machine cannot retrieve this unpublished commit through the GitHub fallback yet. Generated packages remain ignored; source changes are reviewable in the isolated upstream branch.

## Deterministic, transport and packaging checks

- Final application suite: **463/463 pass**, including real native Zenoh/MAVLink tests without inference. Production TypeScript/Vite build passes; Vite retains its existing large-chunk advisory.
- Final Nervelet suite: **97/97 pass**; typecheck, documentation checks, clean-source build/pack and isolated default package installation pass.
- Fresh application `npm ci`: **143 packages**, no serialport or Claude SDK. Copying the measured local application assets into that install produces an identical artifact manifest.
- Runtime/SDK deployment: **3,546,105 / 8,388,608 bytes**, including manifest, canonical briefing and local transitive adapter/sensor assets. All fixed 16 MiB application partitions remain unchanged. Nervelet reserves 384 KiB and optional acoustics 8 KiB within the existing diagnostics/cache half; unread events retain their separate half.

Coverage includes exact goals, six-actor isolation, actual launch submission, cargo conservation, FIFO/redelivery, escaped maximum-size files, native I/O/camera cancellation, actual MCP disconnect/final-output overflow, stale generations after acknowledgement, admission reconciliation without replay, held waits/captures, reasoning/closing/natural turn endings, pending tool-result joins, catalog/compaction/objective races, Stop/reset/death, urgent evidence behind a full FIFO slice, coalesced bursts, rearm/budgets and stale-frame failure. The 16 application attention fixtures use a mocked native RPC with real game/Bridge ownership; they are not counted as native interruption evidence. Library tests separately cover missing/failed host confirmation, expired evidence and transition budgets.

Failures encountered and corrected are retained in the managed run: obsolete canonical-instruction/test mocks, missing EventEmitter support in ten TeamSession fixture tests, the upstream reconciliation-generation edge, ordinary-output failure without attention, a packaging CRLF integrity mismatch, and missing development-only serial types in a clean source build. A stronger camera test showed that interrupted acquisition could produce a capsule without new pixels; the adapter now reacquires once. The live launch and stale-frame findings below are implementation findings, not dismissed test noise. No quotas, model settings or CPU tests were weakened to pass checks.

## Native trials actually run

All trials inspected `/api/state` on 4317, 4318 and the chosen 4328: all were unavailable. They used an owned isolated Playwright Chromium camera, fixed 1x simulation, native children, two native radio networks and six MAVLink identities. Owned actors/helpers/browser/server were stopped and network stores collected after each run. No player server was restarted.

| Managed subdirectory | Outcome |
| --- | --- |
| `native-haul-single` | First 180-second bounded attempt stalled at sim 0: two objective results had no capture commit after objective receipt cancelled acquisition. Pilots received the text but launch did not count it. Fixed and regression-tested; no salvage or autonomy claim. |
| `native-attention-final` | Before the stricter freshness guard: ordinary synthetic notice and then one synthetic possible-shot measurement during reasoning. Actual matching terminal, same-session image input, acknowledgement and factual radio response succeeded. The replacement image was **3,103 ms old**, so this is **not** successful fresh-emergency qualification. |
| `native-attention-freshness` | Corrected freshness guard. Actual terminal arrived after **23.3 ms**; two capture attempts could not provide valid fresh replacement output. Explicit runtime failure stopped the match at sim **31.277**. No replacement turn was submitted. The planned native held-wait phase was not reached. |
| `native-haul-single-final` | Attention/acoustics off, 300-second bound. Launch opened; the hauler looked, moved and encountered blocked local routes. At sim **248.630**, all six remained alive, **zero pickups/deliveries**, zero cargo, all **840** salvage still in caches, zero loss. No compaction events or turn overlap were observed. **48** acquisition results explicitly timed out after five seconds; **41** successful images were committed, plus two objective-change missing-image results. No browser JavaScript errors or host transport failure was reported. Repeated/team hauling and battle were not attempted. |

Attention evidence was explicitly synthetic, supplied only as one drone's local mailbox measurement; the ordinary notice never requested interruption. Acoustics were disabled in native trials. The interrupted pilot reported uncertainty and took no inferred evasive or targeting action. A saved actual frame shows the cyan rooftop and three pad marks, consistent with its ordinary radio description. The stationary views were similar, so this does not establish novel-image discrimination, moving-target recognition or acoustic accuracy.

Native source manifests:

- Initial haul: `dbe33ad5f971577c552a1b2f482b27fa0b8a086d755852990b6dd2306ab953b7`.
- Initial attention: `8582afda947bcf817cd6bfba5c31e99890c357ebb359f5238d208ff5ab080373`.
- Strict freshness and corrected haul: `638aa2d7b2ee9e4ffd640b16a0b4393a51d3557909e85ae4f92ac145cdfdf225`.

Final tested source manifest: `ef7ad6f7aaec4c03f1666282071e4f76092b2c1f8d87ed7b3394ddc2c94abfa9`. Production sources match the strict native trials; the only subsequent source-manifest change adds the received-objective race regression in `tests/attention.test.ts`.

## Measurements and their limits

For the initial attention trial, ordinary notice receipt to successful submission was **5.538 s** and to a useful radio report **13.202 s**. Emergency detection to request was **1.0 ms**, matching terminal **37.0 ms** (about 36 ms from request), replacement submission **3.157 s**, radio request **12.405 s**, and accepted radio effect **12.430 s**. Replacement image age at that action was about **12.367 s**; the local controller continued independently. The strict run's ordinary notice took **9.230 s** to submission and **15.895 s** to report; its emergency produced no accepted replacement/action.

These are separate single stimuli, not a controlled before/after speedup. The first apparent delivery improvement failed freshness qualification. No end-to-end responsiveness improvement is claimed. There were no non-injected attention requests; this tiny sample with acoustics off cannot estimate a field false-interruption rate. Interrupted useful reasoning, sensor precision/recall and tactical benefit remain unmeasured.

| Measurement | Initial attention | Strict attention | Corrected haul |
| --- | ---: | ---: | ---: |
| Drone final MCP text, median / max bytes | 7,968 / 26,105 | 8,748 / 25,981 | 8,740 / 25,971 |
| Drone final JSON-RPC wire, max bytes | 42,645 | 42,106 | 45,804 |
| Last successful camera age at next call, median / max | 9.077 / 29.475 s | 8.057 / 10.787 s | 19.741 / 235.078 s |
| Host process CPU | 16.547 s | 12.469 s | 43.109 s |
| Host peak RSS | 419.2 MiB | 418.4 MiB | 408.3 MiB |
| Maximum sampled whole owned tree RSS | 1.832 GiB | 1.724 GiB | 1.821 GiB |
| Sum of sampled per-process CPU maxima | 904.9 s | 388.1 s | 3,464.8 s |
| Observed cumulative native tokens, eight actors | 1,400,836 | 772,907 | 5,765,858 |

Wire bytes include encoded pixels; separate decoded-image quotas remain enforced. The emergency `turn/start` input uses the verified fleet result and actual data-URL image, not an MCP output, so it is outside the MCP byte table. Host CPU is from `process.cpuUsage`; tree CPU/RSS comes from 15-second Windows process samples, includes browser/GPU/native helpers, excludes the sampling PowerShell process, and can miss short-lived processes and between-sample peaks. RSS is not application disk use. Token totals include repeated/cached input as reported by the runtime and are not billed-dollar measurements. Host event-loop p95 was 39.4–39.9 ms; maximum was 277.6 ms in the first attention run and 513.5 ms in the corrected haul.

In the corrected haul, motion/equipment requests used a last-successful-camera age median **18.592 s**, maximum **115.146 s**. Later results explicitly lacked images; these figures describe how old the last available image was, not a claim that every current result falsely advertised fresh pixels. Finite local physical controls still operated. This camera throughput issue prevents useful autonomy conclusions from the failed trial.

The isolated acoustic sensor fixture used six receivers and all 107 buildings, with constant RNG to suppress noise/misses. Across 6,000 idle ticks it used **4.183 ms total** (~0.000697 ms/tick). Across 400 pressure steps of 32 simultaneous sources, it performed 76,800 receiver evaluations; median **10.522 ms**, p95 **17.945 ms**, maximum **27.512 ms** per pressure step. These sensor counters measure synchronous elapsed wall duration (`performance.now`), not strict thread CPU. This deliberately saturated sensor workload excludes rendering, transport and inference. It is a nontrivial processing cost, not a hardware rate guarantee. Noise, obstruction, finite delay/range, bounded saturation and gate independence have deterministic checks; calibration and live usefulness remain unqualified.

## Remaining gates and handoff

1. Restore reliable camera acquisition under the native six-actor renderer workload while retaining honest acquisition timestamps and the two-second emergency freshness limit. The strict failure is explicit; do not loosen freshness or substitute an old image to enable attention.
2. Then repeat native emergency qualification, including held waits, in-flight admission and closing/compaction/catalog cases. Those races currently have deterministic coverage, not complete live qualification. Continue measuring useful response latency and false/unhelpful interruptions separately.
3. Calibrate and evaluate `acoustic/1` separately. Its documented sensitivity/noise/obstruction assumptions are experimental; no projectile speed or combat physics was changed.
4. Repeat autonomous single haul before repeated haul, useful team haul and battle. No solved routes, source locators or tactical policies were added to compensate. The pre-existing opposing-motion collision issue remains open.
5. Publish/review the isolated Nervelet source before claiming portable public installation. A local clone containing the pin works today; the commits and tarball are not a release.

Raw evidence is grouped under `artifacts/test-runs/2026-09-16T02-12-59-225Z-nervelet-upgrade-65e4819e/`, with full test/build/package logs, native source manifests, audited traces/replays/images, `analysis.json` per trial, `resource-measurements.json` and the offline analysis/measurement scripts. Managed retention may prune raw evidence on a later run; this report preserves its measured scope. Historical reports remain unchanged in meaning.
