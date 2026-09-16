# Nervelet integration

DroneRTS embeds Nervelet **0.2.0**, exact revision `4356691bede0e2810cb7d2c453a7f2ec3ff61396`, in its existing Node process. Version 0.2.0 alone does not identify this implementation. `TeamSession` creates one `DroneNervelet` environment/Bridge per authenticated pilot. Codex still owns the two native parents and six clean-context Luna/xhigh children. See [camera-age correction](CAMERA-AGE-POLICY-QA.md) for current behavior and [upgrade qualification](NERVELET-UPGRADE-QA.md) for earlier measurements and remaining gates.

## Before and after

| Concern | Before | Now |
| --- | --- | --- |
| Acquisition/control | Simulation, finite sensors, native radio, routes and QuickJS already continued during inference. | Same owners/rates. Nervelet observes current state; it does not inject inputs into private reasoning. |
| Observations | Direct tools/exchanges acquired images and drained inbox slices. | They are Nervelet aliases. `exchange` remains the single batch interface; `wait` accepts optional conditions. Images still arrive in the same role-bound MCP result. |
| Unread events | Included events were consumed while assembling the result. | The existing mailbox is peeked. Only an echoed `seen` bundle ID consumes its included slice and native mail. Lost results redeliver stable IDs. |
| Goal | Mission version and original inbox message. | Exact last received goal and existing version repeat every boundary. Queued objectives and ordinary chat cannot change it. |
| Recovery | Native compaction was logged; later ordinary observations supplied state. | Observed child compaction/resumption gates new effects until a fresh recovery bundle is acknowledged. It repeats vehicle/mission knowledge; MCP supplies the typed command catalog. Valid local jobs continue. Exact active job arguments/source versions remain game-owned. |
| Retries | No general direct-command receipt protocol. | Increasing `cN` IDs deduplicate identical retries, reject changed payloads and refuse expired IDs. Uncertain admission reconciles against the original execution, never by replay. |
| Waiting | Mail/local event or timeout, up to 30 seconds. | Also event type, terminal job, cargo and altitude conditions. Only numeric conditions trigger snapshots on simulation ticks; ordinary waits wake on events. This host uses held waits, not managed parking. |
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

Nervelet is unpublished. Direct Git installation omits `dist/`. `scripts/setup-nervelet.mjs` checks out the exact revision in ignored `.runtime/nervelet-source-4356691bede0/`, builds/packs it without source patches, and verifies SHA-256 `1d3644d673b5f1d97d72bc0c7a06b88069aac60347b19cb884a4a46bdeeb58b2`. The dependency is `.runtime/nervelet-4356691bede0e2810cb7d2c453a7f2ec3ff61396.tgz`; the lockfile also pins SHA-512 integrity.

The pinned source is merged into upstream main through [Nervelet PR #4](https://github.com/DanMcInerney/nervelet/pull/4), preserving exact commit `4356691bede0e2810cb7d2c453a7f2ec3ff61396`. Setup clones `NERVELET_SOURCE` when set, otherwise `~/tools/nervelet` if available, then GitHub. A selected local clone must contain the pin; set `NERVELET_SOURCE=https://github.com/DanMcInerney/nervelet.git` to select the public source explicitly. No version-only or fallback dependency is substituted. The verified tarball is built locally, not published to npm.

The reviewed upstream includes configurable byte limits and `retainCommandArguments:false`. The additional generalized upstream contract is `submission:'host'`, `confirmSubmission(bundleId)` and `failSubmission(bundleId,error)`: assembly alone cannot complete open-boundary emergency settlement. Confirmation is successful host submission, not model acknowledgement or action completion. Reconciliation can invalidate an assembled generation, in which case settlement joins the old native turn before requesting new input. Serial bindings are an optional peer and development dependency, so normal application installs omit them and Claude SDKs. Escaped 64 KiB files and original execution receipts remain supported without retaining large arguments or replaying uncertain effects.

## Optional attention and acoustic sensing

Both experiments are **off by default**, independently selected at process launch by `FLEET_ATTENTION=experimental` and `FLEET_ACOUSTIC=experimental`. Ordinary sensor/radio updates still wait for tool boundaries. The attention policy accepts only the drone's retained local armor-loss or uncertain possible-shot event. It does not infer an attacker or choose motion. Valid accepted routes/routines continue; existing collision, lease, Stop, objective and death safeguards still apply.

The native runtime owns exact thread/turn IDs plus native tool items and outer HTTP requests/results. Only a matching terminal event and settled work resolve the old turn. `turn/interrupt` acknowledgement is insufficient. One continuation promise serializes emergency, catalog and ordinary resumption. Emergency replacement uses the same child session, exact goal and freshly acquired text/image; it does not increment recovery again afterward. Correlated completed compaction items trigger recovery; late old-turn notifications cannot replace current ownership.

Actual final JSON-RPC output is measured after error/control/catalog additions: at most 640 KiB text, one 512 KiB decoded image. HTTP finish confirms submission; disconnect/formatting failures fail it and preserve unread events. Camera cancellation reaches native sampling, broker timers/listeners and queued browser work; executing synchronous GPU work can finish, but late images are discarded. A cancelled attention capture is reacquired once without replaying a command. Submitted objectives count for launch even when the result explicitly has no image; acknowledgement still requires `seen`.

Emergency recovery requires a successful new capture, not a maximum image age. A delayed capture remains valid and is delivered immediately with its original acquisition timestamp, pose and measured age. The existing camera `fresh` flag describes the two-second age threshold; it neither blocks delivery nor forces reacquisition. Missing or invalid pixels get one bounded retry and then an explicit failure, with no cached substitute. The five-second acquisition timeout, finite transition budget and 150 ms range-sensor braking limit retain their separate purposes.

Effect tools accept the pilot's actual `generation`. Attention requires it, and acknowledging new recovery cannot authorize an old-generation command. Responsive hover/cancel retains its current-mission authority. Attention permits six transitions and four interrupts per bridge, a 15-second settlement budget, 20-second maximum evidence age, 1 KiB evidence capsules and a five-second cooldown. Rearming requires acknowledged recovery and a new domain episode (new damage or sound after at least two seconds of quiet); time alone cannot rearm it. The native owner also caps total turns at 128 per team runtime.

`acoustic/1` measures finite local impulse detections after 343 m/s propagation, a 150 m maximum range, normalized distance attenuation, 0.15 straight-path transmission through any obstructing building, bounded noise and a 10% miss probability. Local ambient impulses occur at 0.015/s per drone and can produce false positives. These are uncalibrated simulator assumptions, not microphone performance. Events contain local acquisition/simulation time, uncertainty and a possible-shot flag; no coordinates, bearing, range, identity, team or trajectory cross the boundary. The model represents impulsive muzzle sound; projectile physics remains unchanged and no supersonic crack is assumed.

## Boundaries and accounting

`server/nervelet.ts` uses narrow `FleetGame` seams for own telemetry, acquisition, execution, stopping and acknowledged mail. No shell, host files, extra guest library, opponent telemetry or hidden sensor is exposed. The immutable profile uses canonical fleet command schemas; available tools remain dynamic and capabilities are rechecked at execution. Batches allow at most eight compatible entries; dependent actions need ordered jobs/routines.

The bridge retains 64 receipts and 32 delivery mappings. Original execution records are bounded to 64 and unresolved entries cannot be evicted. A conservative **384 KiB reservation** comes from the existing 512 KiB diagnostics/cache allocation; optional acoustic sensing adds **8 KiB** per drone there. The other 512 KiB remains for unread local events, including acoustic observations. The private world-stimulus queue is bounded to 32 with saturation counters; acquired evidence is never silently evicted. Sensor CPU/detection counters are player-only and reset with a match. The 128 KiB inbox slice, 4 MiB radio, 2 MiB workspace and 1 MiB staging limits remain unchanged. Ordinary/recovery text caps remain 512/640 KiB; one decoded image is bounded to 512 KiB.

`ONBOARD-PACKAGE-MANIFEST.json` measures Nervelet, Ajv, their required dependencies, notices and adapter code. Node/Python and the original native transports retain their existing platform boundary. Nervelet declares no license; the manifest records that explicitly. Ajv's `fast-uri` dependency retains its BSD-3-Clause notice.

## Evidence limits

See [upgrade QA](NERVELET-UPGRADE-QA.md) and `RTS-PLAYTEST.md`; `NERVELET-QA.md` records the earlier integration. Synthetic recovery tests establish gating, not successful repeated real native compaction. Image delivery does not establish recognition. Nervelet cannot eliminate model thinking latency, make finite-range braking collision-proof, or supply autonomous tactics.

## Proposed follow-up

[Nervelet and DroneRTS boundary design](NERVELET-BOUNDARY-DESIGN.md) assigns reusable efficiency and emergency-interruption changes to the library, and sensor/physical policy to DroneRTS. It is a design proposal, not implemented behavior.

The [implementation review](NERVELET-IMPLEMENTATION-REVIEW.md) and [upgrade plan](DRONERTS-NERVELET-UPGRADE.md) are the reviewed inputs. The implementation above supersedes their unimplemented-status statements; required qualification and acoustic calibration remain separate gates.
