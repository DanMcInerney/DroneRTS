# Nervelet integration and QA — September 15, 2026

**Follow-up:** [Nervelet simplification](NERVELET-SIMPLIFICATION.md) consolidates the model interface, trims recovery text and removes idle tick polling. The live results below describe the initial integration and do not qualify the later changes.

Implemented the user's local Nervelet library in the six native DroneRTS pilots. The integration and deterministic checks pass. A live hauling trial exercised the bridge successfully but **did not pick up or deliver salvage**. This is protocol validation, not a successful autonomy qualification.

## Before and after

| Before | Now |
| --- | --- |
| Physics, finite-range sensing, radio, routes and QuickJS already ran while a pilot thought. Camera images were acquired at tool boundaries. | These remain independent of inference. Each pilot has an embedded Nervelet environment/Bridge; each normal result still acquires an actual image and current own telemetry. |
| Direct tools/exchanges drained included inbox events during result assembly. A lost result had no general acknowledgement protocol. | Pilots echo the previous bundle ID as `seen`. Only its included events are consumed; an unacknowledged slice is redelivered with stable event IDs. |
| Direct commands lacked a common retry receipt mechanism. | Increasing `command_id` values deduplicate identical retries and reject changed payloads. Uncertain effects are reconciled against their original execution. |
| Native compaction/resumption was observed but had no explicit recovery acknowledgement gate. | The next result carries the exact received objective, own state and active job arguments/source versions. New effects wait for acknowledgement; valid local work continues. |
| Waits woke for mail/events or timeout. | `step` additionally supports event, terminal-job, cargo and altitude conditions, driven by simulation notifications. Compatible batches remain bounded to eight operations. |

The backend is still **gpt-5.6-luna / xhigh**, with two mechanical native relay parents, six isolated native pilots, two real Zenoh networks and six MAVLink identities. Nervelet does not introduce a planner, hidden sensor, extra inference scheduler, camera history, or a way to inject inputs into private reasoning. This implementation uses held waits of at most 30 seconds. API/Claude Code drivers and managed parking are not enabled.

Implementation and setup details: [NERVELET-INTEGRATION.md](NERVELET-INTEGRATION.md).

## Validation

Environment: Windows x64, Node **24.15.0**, Python **3.14.6** in the worktree `.venv`, eclipse-zenoh **1.10.1**, pymavlink **2.4.49**. Nervelet is pinned to **0.2.0 / `2a806a61b5d9cc2dc48029bb9818bd228c8aba25`**. The user's `~/tools/nervelet` checkout was not changed.

- **438/438 tests passed**, including real native transport tests. Twelve adapter tests cover six-role isolation, actual MCP image content, received-goal launch gating, lost-result redelivery, bounded inbox slices, receipt metadata accounting, duplicate command IDs, escaped 64 KiB files, conditional waits, three synthetic recovery generations, responsive cancellation, reset and a goal arriving during native command latency. Fixture images in these tests are synthetic; browser/live evidence supplies actual pixels.
- **TypeScript and production build passed.** Vite retains the existing 857.88 kB client chunk warning. Nervelet runs on the server and is not added to the browser bundle.
- **Deterministic browser QA passed** on owned port 4318: six real cameras, renderer provenance, team-light death/occlusion, zero starting funds/armor, absent optics, player-camera isolation, simultaneous cargo loading/delivery, purchases/refit/rearm, responsive layout and reset. Desktop and acquired camera files were visually inspected.
- **Clean `npm ci` passed** after building the pinned tarball. Runtime accounting measures **3,400,091 / 8,388,608 bytes**, covering 667 artifacts including Nervelet/Ajv/transitive dependencies. The preceding manifest measured 1,601,079 bytes. No partition was enlarged. A 384 KiB reservation comes from the existing diagnostics/cache allocation; unread timestamp metadata is charged to its inbox partition.

### Live trial

The bounded `haul-single` trial used production cargo-v3 stock, loadouts and geometry, fixed 1×, six fresh native pilots and an actual sidebar camera browser. Its existing trial objective designated one blue hauler and five stationary observers; it supplied no resource coordinates, solved route or authored routine. Port 4317 was unavailable and untouched. The 360-wall-second trial reached **326.909 simulation seconds** and ended at its time limit.

| Measurement | Result |
| --- | --- |
| Runtime/transport failures; replay warnings | **0; 0** |
| Survivors; collisions; lost salvage | **6; 0; 0** |
| Pickups; deliveries | **0; 0** |
| Conservation | **840 stock + 0 aboard + 0 delivered + 0 lost = 840** |
| Delivered bundles / acquired image files | **117 / 117**, none missing; all reported fresh |
| Pilot bundle counts, Blue 1–3 / Red 1–3 | **40, 23, 21 / 11, 11, 11** |
| Separate bridge epochs | **6** |
| Acknowledgements / command admissions | **115 / 41** |
| Calls missing `seen` after their first call; effects missing command IDs | **0; 0** |
| Wait admissions / normal wakes | **61 / 57**; four pending waits cancelled at shutdown |
| Native compactions | **0** |
| Camera acquisition age at delivery, all pilots | p50 **21.7 ms**, p95 **44.7 ms**, max **428.6 ms** |
| Current own telemetry age at delivery | p50 **1.28 ms**, max **2.96 ms** |
| Hauler's completed-tool-to-next-call gap | p50 **5.639 s**, p95 **16.188 s**, max **29.264 s** |
| Delivered text / saved JPEG bytes | **984,698 / 1,990,618** |

All six pilots received their exact role-appropriate objective through the bridge. Blue exchanged explicit opening agreements. The hauler made nine flight submissions, travelled about **658.9 m** in sampled replay poses and had **61.294 seconds** of sampled movement. One movement job reported `obstruction`; the pilot subsequently chose new commands. The final acquired view at sim **317.017** visibly includes yellow intersection aprons, but no physical service occurred. These observations establish flight and fresh input delivery, not successful recognition or navigation.

The three existing offline analyzers (`analyze-trial`, `analyze-haul`, `analyze-decision-latency`) completed, alongside an additional audit summary retained as `nervelet-analysis.json`. All owned actors, network helpers, server and camera tab were stopped.

## Problems found

| Finding | Resolution / status |
| --- | --- |
| Nervelet's Git dependency installs without `dist/`, although exports require it. | **Worked around:** `npm run nervelet:setup` builds the pinned source into an ignored tarball before `npm ci`. A published build or Git prepare hook would make installation simpler. |
| Hardcoded 16 KiB request / 4 KiB command limits reject valid DroneRTS 64 KiB workspace files, especially JSON escapes. | **Fixed in the private build:** optional configurable ceilings, preserving upstream defaults. The application permits escaped maximum-sized files without changing file quotas. |
| Retained command records otherwise copy large workspace-write arguments. | **Fixed in the private build:** optional omission of retained arguments; hashes still validate retries and reconciliation uses the original execution by ID. Domain jobs retain their own recovery arguments. |
| Adding receipt timestamps to legacy alert payloads broke four exact-field tests. | **Fixed:** receipt time is private mailbox metadata and appears only in the Nervelet envelope. The final suite passes. |
| An objective can change while a native command is awaiting completion. | **Covered and fixed:** authority is rechecked after native latency; cancelled/uncertain admission reconciles without replay or a spurious whole-match stop. |
| Final review found uncharged receipt timestamps and a removed optics command in the immutable recovery profile. | **Fixed after the live trial:** timestamp storage counts toward inbox capacity and current cargo-v3 recovery omits optics. All 438 tests and the build passed afterward. The live source fingerprint below predates only these final adapter hardening changes. |
| Windows held `esbuild.exe` open during clean install. | **Resolved:** stopped the owned validation helper holding it, then `npm ci` succeeded. No player process was stopped. |
| A pilot supplied a nonexistent originating observation sequence (`20815`). | **Expected guard rejection:** Blue 2's `c5` was rejected, and `c6` recovered using valid implicit provenance. No command-ID conflict, unknown receipt or recovery-gate failure occurred live. |
| Parked Blue 2/3 repeatedly acknowledged each other's unchanged no-findings reports. | **Open gameplay finding:** messages were delivered correctly but did not produce useful hauling progress. No prescribed radio schedule or tactics were added. |
| Single-haul trial timed out without collecting anything. | **Open autonomy gate:** current cargo-v3/Nervelet has not passed autonomous single haul, repeated haul, useful team haul or battle validation. Historical successes used earlier equipment/map presentation and are not a controlled before/after comparison. |
| Model decision gaps remain long. | **Open:** the 29.264 s longest gap included about 29.183 sampled idle seconds and no compaction. Nervelet cannot itself remove model/transport/dispatch delay. No causal latency improvement is claimed. |

Nervelet declares no upstream license; the package manifest records that fact and retains dependency notices. Its new compatibility options are local patches, so future upgrades must deliberately review them. The existing opposing-motion collision reproduction remains open; this integration does not repair it. Repeated real native compactions, long-duration storage pressure, API/Claude Code operation, code transfers/routines during live play and useful conditional-wait selection by live pilots remain unqualified. No live pilot selected `step` in this run; those conditions were exercised deterministically.

## Reproduction and evidence

Base revision: `7379731b4869beb25412ff0cee4d7a0d970b6662`, with this worktree's integration changes. Live source manifest: **`08ed1cc5124ee1ccdda38d67aa736fd3e796f52e30a90b56d0e4fd1d3d11fdaf`**. Final adapter hardening was validated separately by the final full suite/build, without another inference run. The final 195-file source manifest is **`d6fd8f8f9690e3e9ad28ea3339b760eba788e742dd7600c248c9f87065743f93`** (`final-source-manifest.json` and `final-validation.json`).

Grouped raw evidence is local and ignored:

`artifacts/test-runs/2026-09-15T22-53-43-995Z-nervelet-edb47296/`

It contains the final suite/build logs, `rts-ui/`, and `focused-haul-single/` with audit, source hashes, replay images, native stores and offline analyses. Managed retention may prune it after the next completed test run; this report preserves the recorded findings.

```powershell
npm run nervelet:setup
npm ci
npm run network:setup
npm test
npm run build
# Before inference, inspect /api/state and choose a free isolated trial port.
$env:RTS_TRIAL_PORT = '4318'
$env:RTS_TRIAL_SECONDS = '360'
node --import tsx scripts/playtest-focused.ts haul-single
# Connect the sidebar camera browser to the runner's URL within 60 seconds.
```

Keep related checks under an active managed `FLEET_TEST_RUN`; analyze a stopped trial before starting another. The historical reports remain unchanged below their new current summaries.
