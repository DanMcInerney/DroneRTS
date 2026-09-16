# Nervelet integration

DroneRTS embeds Nervelet **0.2.0**, exact revision `4c5d0c152800ef8575b32a097c0464f8be3607cd`, in its existing Node process. Version 0.2.0 alone does not identify this implementation. `TeamSession` creates one `DroneNervelet` environment/Bridge per authenticated pilot. Codex still owns the two native parents and six clean-context Luna/xhigh children. [Interface QA](NERVELET-INTERFACE-QA.md) records the current pin and checks; [reliability QA](RELIABILITY-QA.md) retains earlier budget and receipt qualification. [Camera-age correction](CAMERA-AGE-POLICY-QA.md) preserves the unresolved native held-wait camera gate; [upgrade qualification](NERVELET-UPGRADE-QA.md) preserves earlier measurements.

## Before and after

| Concern | Before | Now |
| --- | --- | --- |
| Acquisition/control | Simulation, finite sensors, native radio, routes and QuickJS already continued during inference. | Same owners/rates. Nervelet observes current state; it does not inject inputs into private reasoning. |
| Observations | Direct tools/exchanges acquired images and drained inbox slices. | They are Nervelet aliases. `exchange` remains the single batch interface; `wait` accepts optional conditions. Images still arrive in the same role-bound MCP result. |
| Unread events | Included events were consumed while assembling the result. | The existing mailbox is peeked. Only an echoed `seen` bundle ID consumes its included slice and native mail. Lost results redeliver stable IDs. |
| Goal | Mission version and original inbox message. | Exact last received goal and existing version repeat every boundary. Queued objectives and ordinary chat cannot change it. |
| Recovery | Native compaction was logged; later ordinary observations supplied state. | Observed child compaction/resumption gates new effects until a fresh recovery bundle is acknowledged. It repeats vehicle/mission knowledge; MCP supplies the typed command catalog. Valid local jobs continue. Exact active job arguments/source versions remain game-owned. |
| Retries | No general direct-command receipt protocol. | Increasing `cN` IDs deduplicate identical retries, reject changed payloads and refuse expired IDs. Original operation payloads redeliver until their exact resolved revision is seen; uncertainty reconciles against the original execution, never by replay. |
| Waiting | Mail/local event or timeout, up to 30 seconds. | Omitted `until` uses v2 `anyEvent` for any unread event, including an earlier unacknowledged bundle. Typed event, terminal job, cargo and altitude conditions remain. Scoped events/lifecycle signals drive waits; only numeric conditions trigger tick snapshots. This host uses held waits. |
| Tool catalog | Equipment changes requested catalog yield/resume turns. | The current-ruleset advertisement stays stable; `availableTools` and dispatch enforce actual capability. Retirement still revokes the actor's catalog. |
| Stop/ownership | One movement writer and game/native transport guards. | Preserved. Hover/cancel bypass the ordinary lane; late effects recheck generation and game authority. |

## Setup and packaging

The model-facing API deliberately has no separate `step` tool. For example, `wait({seen, until:[{kind:"jobTerminal", id:jobId}], timeout_ms:30000})` waits for a submitted job; omitting `until` waits for any unread event. `exchange` uses one command ID for the whole batch and returns its existing individual operation outcomes. See [simplification measurements](NERVELET-SIMPLIFICATION.md).

Requires **Node 24+**. On a fresh checkout:

```sh
npm run nervelet:setup
npm ci
npm run network:setup
npm run dev
```

Nervelet is unpublished. Direct Git installation omits `dist/`. `scripts/setup-nervelet.mjs` checks out the exact revision in its ignored `.runtime/nervelet-source-<revision-prefix>/` directory, builds/packs it without source patches, and verifies SHA-256 `f49406d9adbd43a1ca1cca5a8a6545dadab4d2e5b64306e42322edf47fbc7206`. The dependency is `.runtime/nervelet-4c5d0c152800ef8575b32a097c0464f8be3607cd.tgz`; the lockfile also pins SHA-512 integrity. [Interface QA](NERVELET-INTERFACE-QA.md) records the exact archive and fresh-install evidence.

The new interface pin is a **local unmerged commit**. Set `NERVELET_SOURCE` to a clone containing it before setup; the implementation worktree's repository contains that object. Setup otherwise selects `~/tools/nervelet` if available, then GitHub. A selected source must contain the exact pin; no version-only or fallback dependency is substituted. Public reproducibility is pending availability of that commit from the declared upstream source. Review the Nervelet commit first, then the dependent DroneRTS commit. The verified tarball is built locally, not published to npm.

The library supplies configurable byte limits, `retainCommandArguments:false`, `commandDigest`, checked immutable profiles, result reservations and revision-bound acknowledgement. `submission:'host'`, `confirmSubmission(bundleId)` and `failSubmission(bundleId,error)` keep final submission separate from assembly, model acknowledgement and action completion. Reconciliation can invalidate an assembled generation, in which case settlement joins the old native turn before requesting new input. Serial bindings remain optional; normal application installs omit them and Claude SDKs. Escaped 64 KiB files and original execution results remain supported without retaining large command arguments or replaying uncertain effects.

The MCP SDK is pinned exactly to the already qualified **1.30.0**. The small instance `transport.send` wrapper is coupled to that version and checks actual final JSON-RPC output, including formatting additions. Real-client fixtures cover successful submission, post-formatting overflow, disconnect and concurrent request correlation. A successful HTTP response does not substitute for `seen`.

## Results and wait semantics

The profile's `waitFields` entries own numeric identifiers, sampling paths, freshness and concise meanings. Nervelet derives both numeric schema enums and help from them: `altitude` is own local Y in local units, not height above a roof; `cargo` is carried salvage. Profiles without numeric fields omit those branches. [Interface QA](NERVELET-INTERFACE-QA.md) records the correction and checks.

`DRONE_BINDING` beside the adapter's request/output translation supplies aliases to Nervelet's instruction generator. Startup/recovery, tool identity guidance and the recurring `nervelet.rule` share that owner. The domain briefing keeps game rules and vehicle knowledge; [DRONE-PROMPT.md](DRONE-PROMPT.md) points to these sources instead of copying their prompt.

Corrective errors use the shared bounded `{code,message,path?,allowed?}` shape, translating paths such as `/wait/until/0/field` into `/until/0/field`. The existing `reason` field mirrors `error.message` for presentation compatibility. Errors do not infer admission status: an observation failure following hover/cancel retains the actual control result. An error-only response supplies no new observation ID. Individual command and exchange receipts retain their existing admission and completion meanings.

Current state contains freshly acquired observation data and current telemetry. Historical operation output travels only in `nervelet.results[].data = {result, isError}`, associated with its command receipt. `exchange` remains one outer command with its exact individual success/failure outcomes. A workspace read keeps its original content even if that file changes or is deleted. Later observe, identical retry and authoritative reconciliation recover the retained output without repeating any operation; it is never presented as new sensor evidence or replayed as a fresh camera image.

Core and the adapter's original execution promise share one owned immutable payload. Failed acquisition, final formatting or submission does not release it. Late completion after cancellation remains reconcilable through that promise, while effect generation and game authority prevent stale work. `seen` binds to the included result revision: an older `unknown` response cannot consume a later completed payload, and a changed-command ID conflict cannot consume the original receipt. Acknowledging a resolved current revision releases both payload owners; the core keeps its bounded scalar receipt/digest for deduplication. An unresolved receipt remains retained even after it is seen.

Every new command reserves a result slot, retained payload budget and escaped wire budget before dispatch. Insufficient capacity rejects admission explicitly without executing effects or consuming the new command ID. The adapter selects protocol 2 from its first request, so later legacy calls cannot disable reliable result retention. Result slices set `hasMore` when further output remains. Included events alone are acknowledged, preserving the mailbox's 128 KiB FIFO slices.

Omitted `until` means `[{kind:'anyEvent'}]`, matching every unread retained event regardless of type. Typed `{kind:'event',type:...}` keeps its delivered floor; `type:'*'` is literal. An empty `until` has no event/job/numeric predicate but still respects review deadlines and recovery/fault/lifecycle exits. `onboard-change` signals own mail, jobs/routines, workspace/capability changes and genuinely shared visible account changes. Unrelated pilots' movement, look, workspace/inbox operations and idle ticks add no event-wait telemetry or sensor work. Explicit `onboard-lifecycle` covers Stop, reset, session replacement, destruction and connection changes. Numeric waits alone subscribe to continuous `onboard-tick` evaluation; no polling interval is added.

## Optional attention and acoustic sensing

Both experiments are **off by default**, independently selected at process launch by `FLEET_ATTENTION=experimental` and `FLEET_ACOUSTIC=experimental`. Ordinary sensor/radio updates still wait for tool boundaries. The attention policy accepts only the drone's retained local armor-loss or uncertain possible-shot event. It does not infer an attacker or choose motion. Valid accepted routes/routines continue; existing collision, lease, Stop, objective and death safeguards still apply.

The native runtime owns exact thread/turn IDs plus native tool items and outer HTTP requests/results. Only a matching terminal event and settled work resolve the old turn. `turn/interrupt` acknowledgement is insufficient. One continuation promise serializes emergency and ordinary resumption. Equipment changes no longer require catalog yield/resume. Emergency replacement uses the same child session, exact goal and freshly acquired text/image; it does not increment recovery again afterward. Correlated completed compaction items trigger recovery; late old-turn notifications cannot replace current ownership.

Actual final JSON-RPC output is measured after error/control/catalog additions: at most 640 KiB text, one 512 KiB decoded image. HTTP finish confirms submission; disconnect/formatting failures fail it and preserve unread events. Camera cancellation reaches native sampling, broker timers/listeners and queued browser work; executing synchronous GPU work can finish, but late images are discarded. A cancelled attention capture is reacquired once without replaying a command. Submitted objectives count for launch even when the result explicitly has no image; acknowledgement still requires `seen`.

Emergency recovery requires a successful new capture, not a maximum image age. A delayed capture remains valid and is delivered immediately with its original acquisition timestamp, pose and measured age. The existing camera `fresh` flag describes the two-second age threshold; it neither blocks delivery nor forces reacquisition. Missing or invalid pixels get one bounded retry and then an explicit failure, with no cached substitute. The five-second acquisition timeout, finite transition budget and 150 ms range-sensor braking limit retain their separate purposes.

Effect tools accept the pilot's actual `generation`. Attention requires it, and acknowledging new recovery cannot authorize an old-generation command. Responsive hover/cancel retains its current-mission authority. Attention permits six transitions and four interrupts per bridge, a 15-second settlement budget, 20-second maximum evidence age, 1 KiB evidence capsules and a five-second cooldown. Rearming requires acknowledged recovery and a new domain episode (new damage or sound after at least two seconds of quiet); time alone cannot rearm it. The native owner also caps total turns at 128 per team runtime.

`acoustic/1` measures finite local impulse detections after 343 m/s propagation, a 150 m maximum range, normalized distance attenuation, 0.15 straight-path transmission through any obstructing building, bounded noise and a 10% miss probability. Local ambient impulses occur at 0.015/s per drone and can produce false positives. These are uncalibrated simulator assumptions, not microphone performance. Events contain local acquisition/simulation time, uncertainty and a possible-shot flag; no coordinates, bearing, range, identity, team or trajectory cross the boundary. The model represents impulsive muzzle sound; projectile physics remains unchanged and no supersonic crack is assumed.

## Boundaries and accounting

`server/nervelet.ts` uses narrow `FleetGame` seams for own telemetry, acquisition, execution, stopping and acknowledged mail. No shell, host files, extra guest library, opponent telemetry or hidden sensor is exposed. `immutableProfile` validates, copies and deeply freezes canonical fleet command schemas once, including wait fields/resources/instructions, then checks replacement by identity. The library's default mutable-profile guards remain available to other adapters. A shallow freeze or unchecked getter cannot select this fast path.

`tools()` advertises stable current-ruleset schemas, including exchange's allowed operation names; current matches exclude historical optics/camera tools. `availableTools`, dispatch and each exchange operation still enforce actual capability and actor/mission/generation ownership. Batches allow at most eight compatible entries; dependent actions need ordered jobs/routines. Actor retirement retains catalog revocation. The game cancels affected work immediately upon receiving a goal; the serialized Bridge goal transition repeats an idempotent Stop. Shared cancellation preserves exactly-once refunds and standalone Bridge stopping behavior.

A conservative **384 KiB reservation** remains inside the existing 512 KiB diagnostics/cache allocation: **192 KiB** for immutable result payloads and **192 KiB** for charged profile/instructions/goals, scalar receipt/executor records, delivery mappings and control overhead. Histories are now **16 receipts/execution records and eight delivery mappings**, reduced from 64/32 so the explicit metadata charge fits without enlarging any quota. Unknown or unacknowledged v2 results cannot be silently evicted; expired bundle IDs fail explicitly. The adapter guards the complete metadata charge at construction, including the maximum goal and per-delivery result references.

An individual read reserves 144 KiB retained data and 480 KiB escaped result delivery; the shared payload pool remains 192 KiB. The 65,536-NUL maximum file still fits, despite JSON content expanding to 393,216 bytes before framing. Multiple large results may require acknowledgement/backpressure. Lists, transfers, exchanges and other operations have their own conservative preflight bounds in `server/nervelet-results.ts`. Retained representation and transient encoded wire bytes are distinct; see [the measured budget record](RELIABILITY-QA.md).

Optional acoustics still reserves **8 KiB** per drone in diagnostics/cache. The other 512 KiB remains for unread local events, including acoustic observations. The private world-stimulus queue is bounded to 32 with saturation counters; acquired evidence is never silently evicted. Sensor CPU/detection counters are player-only and reset with a match. The 128 KiB inbox slice, 4 MiB radio, 2 MiB workspace and 1 MiB staging limits remain unchanged. Ordinary/recovery text caps remain 512/640 KiB, command input 400 KiB, and one decoded image 512 KiB. Fresh observation bundles remain at every direct fleet-tool boundary.

`ONBOARD-PACKAGE-MANIFEST.json` measures Nervelet, Ajv, their required dependencies, notices and adapter code. Node/Python and the original native transports retain their existing platform boundary. Nervelet declares no license; the manifest records that explicitly. Ajv's `fast-uri` dependency retains its BSD-3-Clause notice.

## Evidence limits

See [reliability QA](RELIABILITY-QA.md) for new deterministic/package checks, [camera-age QA](CAMERA-AGE-POLICY-QA.md) for native camera limits and [the documentation index](DOCUMENTATION.md) for historical upgrade/gameplay evidence. Native held-wait camera acquisition remains unresolved. Synthetic recovery tests establish gating, not successful repeated real native compaction. Image delivery does not establish recognition. Nervelet cannot eliminate model thinking latency, make finite-range braking collision-proof, or supply autonomous tactics.

## Historical design inputs

[Nervelet and DroneRTS boundary design](NERVELET-BOUNDARY-DESIGN.md) records the original division between reusable library behavior and application sensor/physical policy. Its proposed status is historical; this current contract identifies implemented behavior.

The [implementation review](NERVELET-IMPLEMENTATION-REVIEW.md) and [upgrade plan](DRONERTS-NERVELET-UPGRADE.md) are the reviewed inputs. The implementation above supersedes their unimplemented-status statements; required qualification and acoustic calibration remain separate gates.
