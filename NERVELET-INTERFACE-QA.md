# Nervelet interface correction — 2026-09-16

The interface now derives numeric wait arguments and help from `DroneNervelet.profile.waitFields`. `altitude` means own local Y, not height above a roof; `cargo` means carried salvage. Both numeric branches advertise these identifiers. Corrective errors reuse Nervelet's bounded serializer, with request paths translated to the fleet tool shape (for example `/until/0/field`).

`DRONE_BINDING` in [server/nervelet.ts](server/nervelet.ts) supplies the aliases used by translation and Nervelet's instruction generator. Startup/recovery, tool identity guidance and the recurring `nervelet.rule` come from that generator. The competing alias paragraph and prompt copy are removed. Domain descriptions and the common briefing no longer claim that mere inclusion consumes mail. The commander opening and parent relay are unchanged.

A response error carries no inferred admission status. The existing responsive hover/cancel path retains its actual control output when the following observation rejects `seen`. Historical operation output remains in `nervelet.results[].data`; exact receipt revisions, acknowledgments, independent exchange outcomes, image acquisition times, cancellation and quotas retain their existing owners.

## Offline timing correction

[scripts/analysis-boundaries.ts](scripts/analysis-boundaries.ts) now owns observation-to-first-next-call joins for both timing analyzers. Error-only output does not create an observation or let later calls reuse the same prior delivery. This helper is offline only.

Read-only analysis of the retained rooftop battle reproduced all **326** canonical intervals exactly, correcting engagement's previous **337**. The median was **6,411.5 ms**, p95 **21,338.25 ms**, and maximum **39,988 ms**. These are historical measurements, not evidence that the new interface improves model latency or gameplay.

## Verification

Verification used Node **24.15.0** and one managed run, `2026-09-16T16-39-08-527Z-interface-c5f5561c`, after analysis of the retained battle.

- Reviewed Nervelet commit: **`4c5d0c152800ef8575b32a097c0464f8be3607cd`**, package version 0.2.0. A clean source checkout produced the same archive as the tested candidate. SHA-256: `f49406d9adbd43a1ca1cca5a8a6545dadab4d2e5b64306e42322edf47fbc7206`. Setup verifies that digest; `package-lock.json` pins SHA-512 separately. The pinned commit is now preserved on upstream `main` through [Nervelet PR #6](https://github.com/DanMcInerney/nervelet/pull/6).
- Nervelet: `npm ci`, **138/138** tests, typecheck, documentation and package checks passed. Compact generated wording fits the existing recovery/history budgets; no limits were raised.
- DroneRTS: `nervelet:setup`, updated-lockfile `npm ci`, `network:setup`, **527/527** tests via `npm test -- --test-concurrency=2`, and the TypeScript/Vite production build passed. The existing Vite large-chunk advisory remains.
- The full parallel runs intermittently hit existing QuickJS `guest_slice_deadline` assertions. Limiting concurrent test files resolved contention while retaining all runtime budgets and the six-worker isolation fixture. An initial custom wrapper also passed the grouping variable into temporary-directory retention fixtures; the final run used the repository's standard runner, which isolates that variable correctly.
- The regenerated [onboard manifest](ONBOARD-PACKAGE-MANIFEST.json) measures **3,602,090 / 8,388,608 bytes** across 694 artifacts. Cache, receipt, image, cancellation, native network/vehicle and isolation regressions pass. Relative documentation links, fenced blocks and whitespace checks pass.
- One independent review found the adapter's TypeScript array-narrowing error. Nonmutating path-prefix translation fixed it; final build and outer-path/control-effect regressions passed afterward. No additional review was run.

No live gameplay inference or player-service restart is part of these deterministic checks. Native comparison remains separate: hold the opening constant, use clean Luna/xhigh contexts at fixed 1×, and qualify bounded single haul, repeated haul and useful team haul before another battle.
