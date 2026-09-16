# Camera age and emergency recovery — September 16, 2026 UTC

The two-second hard emergency camera gate was an unjustified application restriction. It reused an existing descriptive freshness flag as a validity requirement: a newly requested image taking three seconds to render could be discarded and requested again before the pilot ever saw it. This increased delay without establishing that the second image would be more useful.

The corrected path accepts actual newly acquired pixels regardless of that descriptive age threshold. It delivers their original acquisition timestamp, pose and age so the pilot can reason from the evidence as soon as it arrives. Age is not reset when encoding completes, and the model has no two-second thinking deadline. Healthy accepted flight and scripts continue independently. This change does not claim older pictures depict the current scene.

Nervelet's image `valid` now describes successful capture from a connected simulator, separately from camera `fresh`. Both interrupted-turn replacement and open-tool-result recovery accept delayed images. An absent or invalid capture is retried once without repeating commands; a second failure remains explicit. Cached pixels are never used as a replacement. Five-second bounded acquisition, the attention transition deadline, exact turn/result ownership, generation checks and Stop/reset/death cancellation remain in force. Finite range samples retain their independent 150 ms local-control limit.

This is a DroneRTS adapter/runtime and briefing change. The Nervelet dependency remains the unpatched exact source `4356691bede0e2810cb7d2c453a7f2ec3ff61396`; no upstream change or new service/store is needed. Emergency attention and acoustic sensing remain independently off by default pending their broader qualification.

## Verification

Focused attention, camera and Nervelet tests: **34/34 pass**. Two regressions hold actual capture completion beyond two seconds, one during reasoning interruption and one during a held tool wait. Both prove one capture, actual image delivery, honest age over 2,000 ms, descriptive `fresh:false`, valid non-reused image metadata and successful host submission. Missing-image, capture-cancellation, exact-terminal, stale-generation and lifecycle fixtures also pass.

Full application suite: **465/465 pass**, including native Zenoh/MAVLink integration without inference. TypeScript and the production Vite build pass, with the existing large-chunk advisory. The measured runtime/SDK package is **3,546,848 / 8,388,608 bytes**. Quotas and model settings are unchanged.

## Native qualification

One trial ran from **05:04:24 to 05:06:09 UTC**, with a 240-second maximum, actual Chromium cameras, six Luna/xhigh native pilots, two mechanical parents and native Zenoh/MAVLink. Preflight found ports 4317 and 4318 unavailable; the owned trial used 4318 at fixed 1x. Attention was explicitly enabled only for qualification; acoustic sensing was off. Synthetic local notices tested the protocol, not acoustic accuracy or autonomous combat.

The reasoning-interruption path succeeded. After a synthetic possible-shot event, the matching old turn ended after **26.4 ms**, and the same child session received replacement text and actual newly acquired image after **2.288 s**. The image's recorded age was **2,256 ms** at output assembly (`fresh:false`, `available:true`), about **2,260 ms** at host submission. The capture was delivered without an age-triggered retry. The pilot acknowledged that bundle on its next observation request after **12.875 s**, then reported the uncertain synthetic sound and its separately timestamped camera view after **20.730 s**. It did not infer an attacker or maneuver. These are receipt-to-event latencies, not measurements of private thinking alone.

The ordinary notice took **5.699 s** to submission and **10.545 s** to a radio report. These single, different stimuli are not a controlled latency comparison. The demonstrated improvement is narrower: a completed real capture over two seconds old now reaches the pilot instead of being rejected by the host.

The later held-wait emergency did **not** pass native qualification. Attention invalidated the in-flight acquisition, producing no image, and the one allowed reacquisition still returned no pixels after approximately **5.007 s**, reaching the configured five-second acquisition bound. Both assemblies recorded zero image bytes. The match stopped explicitly with `Emergency recovery could not acquire camera content`; no cached image was substituted and no second replacement turn was started. The failure occurred at sim **70.077**, with all six drones alive. This is a capture-availability problem, not another rejection of completed pixels based on their age. There were no browser JavaScript errors or observed overlapping native turns. All owned actors/helpers/browser/server stopped; a post-run PID/port check found none remaining.

Final MCP outputs: 49 measured drone outputs, median/max text **7,886 / 26,469 bytes**, maximum wire payload **42,838 bytes**. Host CPU was **16.281 s**, peak host RSS **412.2 MiB**, maximum sampled owned-tree RSS **1.762 GiB**. Native reported cumulative usage was **2,263,896 tokens** across eight actors; this includes repeated/cached input and is not a billing figure. Fifteen-second process samples can miss short-lived processes or peaks. No field false-interruption rate, novel-image recognition or gameplay benefit is established by this stationary fixture.

## Remaining scope and evidence

Keep emergency attention and acoustics independently opt-in. The deterministic held-wait delayed-image path passes, but reliable native capture under the six-actor renderer workload and the remaining native race scenarios still need qualification. The prior failed single haul and opposing-motion collision remain separate open issues; no hauling or battle trial was rerun for this camera-policy correction. Do not restore a two-second image gate to address missing pixels, and do not relax the physical range-sensor limit.

Native and tested production source manifest (SHA-256 of compact JSON): `b7c1c12ad97e03992b35e418fc66e1ebe55e401c044cad6bc67c0bb616b933f0`. Raw logs, source manifest, audit/replay/images, per-trial `analysis.json`, analysis script and cleanup check are in `artifacts/test-runs/2026-09-16T05-01-56-994Z-camera-age-policy-766374cd/`. Managed retention may prune them after a later completed run. Earlier reports preserve their original source-specific findings.
