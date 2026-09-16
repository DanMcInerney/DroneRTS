# Camera timeout investigation — September 16, 2026 UTC

The missing pixels reported in [camera-age QA](CAMERA-AGE-POLICY-QA.md) were a real acquisition failure. Raising the image-age threshold cannot repair it. The follow-up isolates a backlog of replaceable spectator state packets on the WebSocket shared with camera requests. The server's two-megabyte socket-buffer guard did not measure messages already queued for the browser.

The production and trial hosts now use `StateChannel`: one numbered spectator snapshot may be unacknowledged per browser. The browser acknowledges after applying it; intervening broadcasts collapse into a pending flag, and the next send reads current state. Acknowledgements must match the connection's outstanding sequence. Camera requests, results and cancellation remain independent of this flow control. Simulation, replay sampling and actor inbox receipts retain their existing behavior. Capture deadlines, pixel content/resolution, honest timestamps, physical range expiry and native model settings are unchanged.

## Diagnosis

The baseline native run used merged DroneRTS `c23a0c823038995eaae3729e4226b6e4c33e4301`, before this fix. It completed both synthetic attention episodes on this attempt, demonstrating the earlier failure is intermittent, but four other tool acquisitions hit the five-second deadline. Its 35 committed images reached 4,979 ms age. Browser capture execution had a 55.8 ms median; after warmup it did not show the same growing delay. Renderer programs/geometries/textures stayed at 18/55/23. Native vehicle sampling added only a few milliseconds in the matched request/delivery records.

A no-inference reproduction repeatedly requested all six cameras while broadcasting state every 50 ms. Adding 24 synthetic radio entries to the spectator UI reproduced growing delays. Instrumented request timestamps showed most of that delay before the browser's capture handler; a separate animation-frame coalescing experiment reduced DOM work but did not solve it and was discarded. The renderer was Chromium ANGLE/SwiftShader on this machine. The evidence supports bounding the shared message backlog; it does not establish that every renderer/GPU performs identically.

| No-inference fixture | Images delivered | Median / maximum complete observation call |
| --- | ---: | ---: |
| Empty radio UI, 75 seconds, original stream | 138/138 | 0.950 / 1.647 s |
| Populated radio UI, 35 seconds, original stream | 42/42 | 2.651 / 3.775 s |
| Populated radio UI, 75 seconds, DOM coalescing only (discarded) | 90/90 | 2.802 / 4.499 s |
| Populated radio UI, 75 seconds, acknowledged state stream | 162/162 | 0.476 / 1.561 s |

These are individual bounded runs, not statistical benchmarks. In the fixed run, request-to-browser-handler delay had a 45 ms median and 562 ms maximum. The final six complete observation calls took 120–597 ms; latency no longer accumulated across the run. The image render/readback itself is still real work.

## Native verification

The fixed run lasted **05:34:40–05:36:44 UTC**, with a 180-second cap, fixed 1x simulation, real camera browser, six **gpt-5.6-luna / xhigh** pilots, two mechanical parents, Zenoh and MAVLink. Preflight found 4317/4318 unavailable; the owned trial used 4318. Only the optional attention experiment was enabled; acoustics was off. The stationary qualification objective and synthetic notices do not demonstrate autonomous combat or sound classification.

| Measurement | Before fix | With fix |
| --- | ---: | ---: |
| Committed camera observations | 35 | 55 |
| Camera age median / p95 / maximum | 1,295 / 4,959 / 4,979 ms | 165 / 683 / 738 ms |
| Tool outputs missing pixels due to 5-second acquisition limit | 4 | 0 |
| Goal-change cancellation outputs without pixels | 1 | 2 |
| Reasoning emergency: event to replacement submission | 1,901 ms | 455 ms |
| Held-wait emergency: event to recovery submission | 4,692 ms | 388 ms |

The before/after native workloads have different model timing and duration; these are observed results, not a controlled model-speed comparison. Goal-change cancellations are expected lifecycle outcomes and are not counted as successful images or timeouts.

In the fixed reasoning episode, the exact old turn terminated after **23 ms**. The same pilot session received actual replacement pixels after **455 ms**, echoed that bundle on its next observation after **18.635 s**, and subsequently reported the synthetic event without inventing an attacker. During a held wait, the existing tool boundary delivered actual recovery pixels after **388 ms**, and the pilot echoed the bundle after **8.226 s**. No overlapping turns were observed. The model's later response is distinct from the time needed to acquire and submit its image.

The run ended normally at sim **73.737**, all six alive, with no browser errors or runtime failures. Its 58 camera requests included cancelled work; 57 browser captures are not interchangeable with 55 committed observations. Fifty-six final MCP outputs had median/max text **7,770 / 26,464 bytes**, maximum wire payload **43,908 bytes**. Host CPU was **17.672 s**, peak host RSS **371.5 MiB**, maximum sampled owned-tree RSS **1.699 GiB**. Native cumulative reported usage was **3,227,858 tokens**, including cached/repeated input, not a billing figure. Resource sampling can miss peaks.

## Checks and remaining gates

**469/469 tests pass**, including native Zenoh/MAVLink tests without inference. Four new regressions cover bounded pending snapshots, latest-state delivery, connection/sequence ownership, slow-peer independence, transport congestion and camera/cancel bypass. TypeScript and production build pass (existing bundle-size advisory). The deterministic production-browser fixture passes six actual cameras, snapshot/occlusion/death rendering, UI isolation, cargo/service and reset checks. Runtime/SDK assets are unchanged at **3,546,848 / 8,388,608 bytes**.

This repairs the reproduced backlog and passes the previously failing held-wait path on the measured revision. Emergency attention and acoustics remain independently opt-in: native compaction/race coverage, field false-interruption rates, acoustic calibration, autonomy and the separate opposing-motion collision issue are not qualified here. No haul or battle inference was launched for this investigation. All owned trial actors/helpers/browser/server were stopped; no player session was restarted.

Fixed native source manifest (SHA-256 of compact JSON): `deaca50158c57648c1e11a81924aeb7a482b3aa4e526b48f5af17159bfe4487c`. Raw evidence, diagnostic source copies, per-trial analyses, browser fixture, test/build logs and cleanup verification are grouped under `artifacts/test-runs/2026-09-16T05-16-39-109Z-camera-timeout-1e9aea36/`. Managed retention may prune this run later. Before-fix native manifest was `b7c1c12ad97e03992b35e418fc66e1ebe55e401c044cad6bc67c0bb616b933f0`; earlier reports retain their historical meanings.
