# Onboard performance evidence — September 14, 2026

The saved single-haul trial has **75 ms p95 camera age at native MCP completion** and **31 ms p95 age for the separately acquired current telemetry**. Both are below the [feedback refinement](ONBOARD-FEEDBACK-REFINEMENT.md)'s initial 250 ms camera and 100 ms telemetry targets in this recorded workload. This does not establish model consumption time, command application latency, controller deadlines, or performance under routine/file-transfer load.

This is an offline audit of existing evidence. No server, inference or new camera trial was launched for this report. Later source changes are not validated by these measurements.

## Recorded workload and method

Source: `artifacts/focused-trials/2026-09-14T18-20-02-511Z-haul-single/`. Six clean-context native actors used **gpt-5.6-luna / xhigh**, actual 512×288 cameras, native Zenoh and MAVLink, at fixed **1×** simulation speed. The explicit fixture assigned one blue hauler and five stationary observers. It ended after its first completed delivery at **295.679 simulation seconds**, before its 450-second wall-time limit. No workspace, routine, transfer or exchange calls occurred. This is a constrained haul workload, not a six-drone battle or a saturated controller benchmark.

The audit contains 2,335 records and 134 drone tool results. Exactly 130 results contain observations; four stopped/unobserved results are excluded from image/telemetry statistics. Each of those 130 observations matches its following same-actor/tool native `mcp-result` before that actor's next request. There are 128 subsequent-request pairs; two observations have no subsequent request in the saved audit and are excluded only from that interval's distribution.

Quantiles use **nearest rank**, `sorted[ceil(p × n) − 1]`, without interpolation. Times below are milliseconds unless stated otherwise. ISO wall timestamps have millisecond resolution. “Native completion” is the app-server's MCP tool-item completion notification, measured at the host; it establishes a response boundary, not when the model read the image or completed private reasoning.

## Observed response timing

| Measured interval | n | p50 | p95 | p99 | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: |
| Camera acquisition → server bundle timestamp | 130 | 25 | 60 | 81 | 101 |
| Camera acquisition → host tool-result audit | 130 | 26 | 61 | 82 | 103 |
| Camera acquisition → native MCP completion | 130 | 40 | 75 | 115 | 133 |
| Current telemetry acquisition → host tool-result audit | 130 | 1 | 2 | 2 | 2 |
| Current telemetry acquisition → native MCP completion | 130 | 9 | 31 | 39 | 40 |
| Host tool-result audit → native MCP completion | 130 | 8 | 29 | 37 | 38 |
| Server bundle → next same-actor tool request, **seconds** | 128 | 4.963 | 10.268 | 14.287 | 25.055 |
| Native MCP completion → next same-actor tool request, **seconds** | 128 | 4.953 | 10.262 | 14.255 | 25.048 |

There were **0/130 camera ages over 250 ms**, **0/130 current-telemetry ages over 100 ms**, zero unavailable/missing camera records, zero false freshness flags, and zero invalid current telemetry records. Two frame-associated position samples exceeded 100 ms at native completion; the current telemetry is a different, newer sample and must remain separately labeled. All 130 observation records retain an image-content marker; the audit redacts image payload bytes, while the actual images belong to the replay evidence.

Two `send` calls were rejected for stale/missing mission versions; their native tool items are marked failed, but both still delivered fresh observation bundles. These are application rejections, not camera/transport failures. The result records zero trial failures/warnings and the audit contains zero transport/trial-error records. Its two runtime warnings concern the configured hook-trust bypass, not timing failures.

The recorded `sensors.camera.ageMs` is calculated before final bundle construction. Its p95 was 59.250 ms, and one result understated bundle-time age by **42.323 ms**. This report therefore uses acquisition/delivery timestamps, not that earlier age field. The monotonic interval from camera acquisition to the later current-telemetry acquisition independently has p50/p95/p99 **24.595/59.901/81.678 ms**, maximum 101.424 ms. Conversely, the bundle timestamp precedes current-telemetry acquisition by 1 ms in 11 records; subtracting those two ISO labels would give a misleading zero/negative telemetry age. The later audit/native-completion markers avoid that ordering problem.

After this audit, `server/game.ts` was corrected to recompute camera/range ages and freshness after assembling feedback, acquire current telemetry before the final delivery stamps, expose current-telemetry age, and keep unavailable cameras non-fresh. The integration owner reports 23 focused observation/exchange/onboard tests and the build passing. The ongoing team trial had already loaded the earlier timestamp implementation. Neither it nor the distributions above validate timing under the corrected implementation; the historical calculations remain unchanged.

The multi-second next-request interval includes native response handling, model/backend processing and tool dispatch. A preceding explicit `wait` has already completed when this interval begins. It is not a direct reasoning timer, nor time until physical arrival.

## Camera fixture comparison

The saved `artifacts/cargo-camera/baseline-profile/result.json` and `final/result.json` each contain eight batches of six independent observer-camera requests. Both use the requested drone identity, identical spawn poses/current fixture state, and no inference; all 48 requests per comparison completed. The historical renderer was reconstructed from Git revision `25a74f78ec0a08c33fcb35a58a76b98e3e66193a`. This compares rendering under a common current world state, not two historical gameplay runs.

| End-to-end six-camera batch | n | p50 ms | p95 ms | p99 ms | Failed batches |
| --- | ---: | ---: | ---: | ---: | ---: |
| Historical renderer | 8 | 41.220 | 53.656 | 53.656 | 0 |
| Current renderer fixture | 8 | 40.437 | 46.361 | 46.361 | 0 |

With eight samples, p95 and p99 both select the maximum. The fixture's saved `medianSixCameraBatchMs` uses the upper middle sample, yielding 41.782/42.127 ms; this report consistently uses the stated nearest-rank p50 instead. These are the same raw samples, not a rerun. The timings include host/WebSocket work, rendering, readback, JPEG encoding and return; they are not renderer FPS or a 10–15 FPS vision benchmark. No sustained-load or confidence-interval claim follows from eight batches. Earlier fixtures with a fixed observer identity are excluded from this comparison.

## Current controller evidence

The controller owner supplied a **provisional stdout measurement** from `node --import tsx --test tests/local-control.test.ts tests/mavlink.test.ts tests/camera-profile.test.ts`: 300 iterations of six-drone sensing/control over all 274 city buildings, p50/p95/p99 **0.320/0.568/0.701 ms**. Each timed iteration acquires the finite local sensors and calls `motion.step` for all six spawn-position drone snapshots. It excludes cameras, native transport, inference and the rest of the game loop; computed positions are not applied to these snapshots. No warm-up samples are removed, and other test files run concurrently.

This measurement uses sorted zero-based indices 150/285/297, **not** this report's nearest-rank convention. The raw 300 durations, maximum, deadline-miss count, machine specification and run-time source hashes were not archived, so those cannot be reconstructed. All 20 tests passed, including the p95-under-50-ms assertion; zero test failures does not establish zero deadline misses. The method is retained in `tests/local-control.test.ts`. This small isolated computation cost supports further loaded profiling but does not establish a 50 Hz service rate or end-to-end control latency.

The separately saved `artifacts/control-measurements/2026-09-14T18-44-15.489Z/summary.json` contains **34 completed deterministic cases**, 17 scenarios each at 50 ms and 200 ms caller ticks, on Node v24.15.0. All 17 paired comparisons have identical final positions, living/dead outcomes, job outcomes and event types. Protected wall approaches now assert an obstruction block before contact; physical armor/contact damage remains independently tested. These are synthetic-camera, scripted control/ballistic fixtures with simulation-time metrics, not actor or native-transport trials. The artifact records base Git revision and dirty filenames, but lacks a per-source content manifest, so its exact dirty implementation cannot be reconstructed from that metadata alone.

## Targets still unmeasured

| Refinement target/path | What this evidence can establish |
| --- | --- |
| Admission → first controller application, p95 <100 ms | Unmeasured. Tool-start and packet records lack a reliably paired application timestamp/command identity. Queueing, native decode and controller application cannot be separated. |
| Local control/proximity service; evaluate 50 Hz | The recorded `server/index.ts` uses a nominal 50 ms/20 Hz host timer with simulation substeps. The isolated controller sample above omits whole-loop scheduling. No host-iteration trace, deadline-miss count or loaded 50 Hz measurement is saved. |
| Own telemetry to routines at 20–50 Hz | Model-facing snapshot age is measured above. This trial ran no routines; it does not measure a continuous routine telemetry rate. |
| Local event → inbox availability within one service iteration | Unmeasured. Event and later model-bundle records do not independently timestamp mailbox admission. Actual model availability must not be substituted for mailbox insertion latency. |
| Optional continuous vision at 10–15 FPS | Unmeasured; no continuous vision routine or image-processing workload ran. |
| Cancellation under load / native network receipt / transfer starvation | Deterministic functional tests cover behavior elsewhere. This saved haul has no latency distributions under partitions, full queues, simultaneous routines or code transfers. |

The saved `artifacts/cargo-mechanics/result.json` records one prescribed geometry-aware fixture arriving at 14.750, picking up at 17.750 and depositing at 35.700 **simulation seconds**. Its synthetic camera and supplied routes prove physical mechanics, not wall-clock scheduling or model performance. The historical 34-case `artifacts/control-measurements/2026-09-14T12-22-08.578Z/summary.json` referenced in [RTS-PLAYTEST.md](RTS-PLAYTEST.md) is absent in this checkout; its raw timing distribution cannot be recomputed here.

## Source fingerprints and reproduction

The trial's base Git revision is `25a74f78ec0a08c33fcb35a58a76b98e3e66193a`, with additional worktree changes identified by its launch manifest. Its recorded compact-JSON manifest fingerprint is verified as **`073aa6fabeb200085bde0387bbeef32a8445ef0993d769bbafbc7dc515c9c248`**. The pretty-printed manifest file has a different byte hash by construction.

| Evidence | SHA-256 |
| --- | --- |
| Trial audit JSONL | `4756d508ac7e53568a4f6c40655fe614fbf034261d6750e813172db56674b6bc` |
| Trial result JSON | `fdb3c43e02bfae7a62657868a1ab56743272daec8493faa2a9c1d483137c0aaf` |
| Recorded `server/game.ts` | `6f67eef3aa5937e3fae47a746f8027716241b711859bfb09ab03f08e2e64e066` |
| Recorded `server/index.ts` | `06852d20f46b178a75d87da2a59ced0d5d6f798e947d53d7bbc349c67c668782` |
| Recorded `server/runtime.ts` | `f0117bc8116be8582a0aedc590fe9a20d8a0991fafbf2e22cffa514a869cbd36` |
| Historical-renderer manifest | `f27fb5f49994bcd1f647331efe12e7ccc522d8ad9124282a25c977ced99febe1` |
| Historical camera-profile result | `4df674e38d6b9016e6bb5479e7436e14579c9dfdbac040801eb1990f6ce8d90c` |
| Current camera-fixture result | `5b54175d59fda81c180b83844ed010a05d470b03998dc61965d0dad4a10a751b` |
| Current 34-case control summary | `34ada32807acff4dfd1e72d92df56d9171db320ef94705ccc82713447e1f9993` |

The local offline analyzer is `artifacts/performance-audit/analyze.mjs` (SHA-256 `242fc64ed7e857f158d6174f202690b9d926d009f562dfaf84c4dd3732cab9fe`). Run `node artifacts/performance-audit/analyze.mjs` from the repository to reproduce `artifacts/performance-audit/result.json`, including per-observation values, per-drone quantiles, input hashes, source comparisons and the current deterministic-control summary. Raw artifacts and this local analysis helper are intentionally ignored by Git and may be absent in a fresh clone. At audit time, the recorded game, local-sensor and motion hashes differed from the working checkout; the measured runtime, host timer, native MAVLink adapter and camera-renderer hashes still matched. These results belong to the recorded source manifest.
