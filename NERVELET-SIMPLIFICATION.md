# Nervelet simplification — September 16, 2026 UTC

This is the historical pre-upgrade measurement. [NERVELET-UPGRADE-QA.md](NERVELET-UPGRADE-QA.md) records the newer canonical instructions, exact source/package and native outcomes; byte savings below are not a current end-to-end latency claim.

The first integration had avoidable duplication in its model interface and idle work. This pass removes that duplication while keeping acknowledgement, cancellation, actor isolation and recovery guarantees.

## Changes

- **One batching interface.** Removed the new model-facing `step` tool; the existing `exchange` remains the batch tool. Conditional event/job/cargo/altitude waits now use optional `until` on `wait`. The adapter no longer needs its own second batch-validation loop or an array of per-command results; the game owns batch execution/outcomes as before. Nervelet's internal `Bridge.step` still drives each boundary.
- **One command catalog.** Recovery returns the full drone/vehicle briefing, exact goal and active job data. It no longer repeats JSON tool schemas already supplied by MCP. Host-specific wording replaces generic Nervelet statements that only `step` refreshes inputs and that parked pilots should end their turn; neither described this host.
- **Event-driven idle waits.** Ordinary waits no longer rebuild a complete model snapshot on every simulation tick. Mail, controller events and lifecycle changes still wake them. Only numeric cargo/altitude conditions subscribe to tick-driven evaluations. Physics, sensing and local jobs keep their existing cadence.
- **Less radio repetition.** The common briefing now says that acknowledging a message does not itself require another acknowledgement. Initial agreement still requires actual peer replies; no route, role, radio format or schedule is prescribed.

## Measured effect

A before/after host fixture used the same synthetic image and received objective, with one pilot and 300 idle ticks. It did not run model inference.

| Measurement | Before | After |
| --- | ---: | ---: |
| Model tools at the fixture's initial unlocked loadout | 11 | 10 |
| Tool catalog JSON | 16,271 bytes | 14,757 bytes |
| Recovery instructions | 23,130 bytes | 8,539 bytes |
| Complete recovery text | 28,170 bytes | 12,595 bytes |
| Extra snapshots during 300 idle ticks | 300 | 0 |

Recovery text is **55.3% smaller**, and its instructions are **63.1% smaller**. These are UTF-8 byte measurements, not token counts. Idle snapshots are an exact work-count reduction. The short fixture's CPU/wall timings are noisy and do not establish an end-to-end speedup. Actual gameplay latency and hauling need a fresh live trial before claiming improvement.

## Validation

All **439 tests**, TypeScript checking and the Vite production build passed. Thirteen focused adapter tests cover the revised interface, full briefing retention, isolated MCP images/acknowledgements, batch partial results and duplicate retries, conditional wakeups, event-driven idle waits, destruction, recovery and cancellation. Runtime packaging is **3,398,425 / 8,388,608 bytes**; no quota changed. The existing browser bundle size warning remains.

The first full suite had one `guest_slice_deadline` failure in the existing three-round/six-worker QuickJS test. Its file then passed in isolation and the entire suite passed unchanged on retry. The worker implementation and CPU limits were not changed. This intermittent resource-limit failure remains a QA observation, not a repaired defect.

No inference or new browser gameplay ran during this simplification pass. The earlier failed haul remains the latest live evidence. The communication wording and leaner recovery bundle have not yet been qualified with native pilots.

Source manifest: `7af105aebf3d4897ebffc5fff338e6fb552a0250f4edbdddce5b5d7f20f8952d`. Retained grouped evidence: `artifacts/test-runs/2026-09-16T00-18-41-768Z-nervelet-simplify-c41fbcab/`, including before/after measurements, the first failing suite log, final passing suite/build logs and source hashes. The managed run completed and prior raw runs were pruned after analysis; historical reports remain.

## What remains worth simplifying

The largest remaining installation burden is the custom Nervelet tarball build with two source patches. An upstream release with built exports, configurable input byte limits and optional omission of retained arguments would let DroneRTS use an ordinary pinned package dependency. This pass leaves the user's Nervelet checkout unchanged.

Model calls dominated the preceding live delay: the hauler had a 5.639-second median and 29.264-second maximum completed-tool-to-next-call gap. The reduced catalog/recovery text may help context overhead, but that has not been measured live. More camera polling or another background model would add work without addressing that evidence.

The six isolated native actors, real Zenoh/MAVLink, finite sensors and bounded QuickJS are deliberate experiment requirements. Their removal would change the experiment. No new broker, scheduler, provider or service was introduced.
