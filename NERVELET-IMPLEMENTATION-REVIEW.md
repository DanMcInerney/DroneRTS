# Nervelet implementation review for DroneRTS

**Follow-through:** [NERVELET-UPGRADE-QA.md](NERVELET-UPGRADE-QA.md) records the subsequent isolated upstream fixes (including R3), application upgrade and actual qualification. Findings below describe the reviewed candidate, not the final source.

**Review date: 2026-09-16 UTC. Scope: source/contract review and deterministic checks, not native emergency qualification.**

Reviewed the work from the Codex task **Implement general Nervelet updates**, in `C:/Users/danhm/tools/nervelet`, on branch `codex/bounded-attention-and-readme`. At review time HEAD was `2a806a61b5d9cc2dc48029bb9818bd228c8aba25` with implementation changes in the working tree; PR preparation was still active. Package metadata remains **0.2.0** at the user's request. An earlier task summary called the work 0.3.0; that version bump was withdrawn.

Reviewed source fingerprint: `44d3031123a65e8f4714d0274945a83d36760eda00a8b9fea99f63f6a196c759`. This hashes the sorted per-file SHA-256 records for `src/`, `test/`, `package.json` and `package-lock.json`. Those files were unchanged across the independent validation below. README/PR edits are not part of that fingerprint. A later merge or source edit needs its own pin and checks.

**Merge update:** [PR #2](https://github.com/DanMcInerney/nervelet/pull/2) merged during this review as `f0c2de60847ab6889c7cc3b95e646f262697861e`. The source fingerprint still matched after the merge. This commit is the upgrade candidate. The other task then continued documentation-only edits on `codex/fix-mermaid-sequences`; those edits do not change the validated source.

## Conclusion

The implementation respects the intended seam. Core attention evidence is generic; acquisition, emergency classification, physical behavior and domain jobs remain with the consumer. It adds no required drone fields, auxiliary model, sensor store or competing actor supervisor.

Proceed with a staged DroneRTS migration. Packaging, reconciliation and presentation can be adopted before emergency attention. Keep attention disabled for gameplay until actor lifecycle, final tool delivery and native interruption have been qualified. This is not a drop-in package replacement.

The application plan is [DRONERTS-NERVELET-UPGRADE.md](DRONERTS-NERVELET-UPGRADE.md).

## What was verified

- Independently ran the three source test files `attention.test.ts`, `packing.test.ts` and `native-interruption.test.ts`: **32/32 passed**.
- Ran three small consumer probes covering argument-free reconciliation, required command generation, and assembly versus host submission.
- Reviewed core admission/acknowledgement, attention settlement, presentation/handlers, exports and supervisor behavior against the existing DroneRTS adapter/runtime.
- Upstream records **89/89 tests**, build, typecheck, documentation and independent package-install checks passing. Those broader checks are upstream evidence, not a second full-suite run by this review.
- No live harness, inference, simulator server or device was started. DroneRTS runtime code and Nervelet source were not changed by this review.

Raw independent evidence is in `artifacts/test-runs/2026-09-16T01-58-34-672Z-nervelet-review-8d6def20/`: source manifests, focused test log, probe results and summary. Managed retention may prune these raw files after a newer run; this report preserves the result. The first invocation of the review helper failed before testing because Windows ESM imports needed file URLs; the corrected invocation produced the results above.

## Findings and adoption requirements

### R1 — Migrate reconciliation before replacing the package

**Confirmed consumer incompatibility, not an upstream defect.** DroneRTS sets `retainCommandArguments: false` but implements only `reconcile(command)`. The private old build retained an empty argument object, so that callback still ran. Upstream now deliberately refuses to fabricate arguments and requires `reconcileReceipt({id, kind, digest}, signal)` when the original command is omitted.

The independent probe returned the expected unsupported-reconciliation error with the old shape. Adding `reconcileReceipt` resolved the original receipt with exactly one execution. DroneRTS must map this method to its existing original-execution records and preserve unresolved outcomes. Do not work around this by fabricating arguments or replaying commands.

### R2 — Forward the new generation field from the first attention-enabled command

**Confirmed consumer incompatibility.** An attention-enabled Bridge requires a command generation even before the first emergency. Existing DroneRTS tools expose `seen`, `command_id` and `mission`, and its adapter forwards no generation.

The probe showed `stale_generation` for the current request shape and successful admission after forwarding a fresh returned generation. Add the top-level field to fleet effect tools and translate it to `StepRequest.generation`. Do not put it inside command arguments or manufacture it from the bridge's mutable current state. A host-supplied `effectGeneration` is only appropriate when bound to the actual originating decision.

### R3 — Assembly is not final tool delivery

**Confirmed limitation of the borrowed-host seam.** `Bridge.bundle` marks attention as delivered when it assembles a bundle. `settleEmergency` can then return `boundary` after `Bridge.whenIdle()`, before an embedding host has formatted or submitted that result. The independent probe withheld the result and still obtained `boundary` with zero interruptions.

This does not acknowledge the unseen events or enable effects by itself; `seen` still protects the recovery gate. It does mean the helper's `boundary` result is not proof that the active harness has received the emergency. DroneRTS has additional formatting, launch/mail evidence, catalog handling and MCP work after `Bridge.step`.

Before enabling that optimization, establish a bounded final-result submission contract. If a generic helper change is needed to wait for host confirmation or handle failed boundary delivery, implement it in Nervelet; do not duplicate emergency sequencing in DroneRTS. Submission still is not model acknowledgement. A failed/lost result must remain recoverable and cannot silently strand emergency attention.

### R4 — Existing DroneRTS turn bookkeeping is insufficient for emergency restarts

**Application change required.** `FleetRuntime` currently deletes the active turn on a `turn/completed` notification by thread ID and resumes the actor without checking that the completed turn is the currently owned turn. It also treats ordinary resumptions as unexpected endings with a small failure allowance.

An emergency path must correlate exact thread/turn IDs, settle outstanding tool work, distinguish intentional restart from unexpected ending, and suppress the old generic autoresume path while one owner settles the emergency. A late completion from an old turn must not clear or resume a replacement turn. Nervelet's driver fixtures exercise terminal correlation, but DroneRTS uses its own runtime, not those drivers.

### R5 — The custom fleet envelope still needs its own final byte check

**Application obligation.** The new library can budget its JSON or standard tool-result representation plus wrapper reserve. DroneRTS transforms the bundle into `fleet-observation/5`, adds available tools and delivery metadata, and may append error/control/catalog text. Therefore a core byte check is not a complete bound on DroneRTS's final output.

Generate instructions before sizing, reserve bounded host overhead, and verify the actual final result. Preserve unread mail and current recovery if a result cannot fit. Keep actual decoded pixels under their separate media ceiling. Do not claim that `textEncoding: 'tool-result'` understands an arbitrary application transformation.

### R6 — Version and install identity must be explicit

**Packaging constraint.** The new and old code both report 0.2.0, and there is no published new release. Use an exact reviewed commit plus package integrity, not `nervelet@0.2.0` alone. The successful pack/install check establishes an installable archive; it does not prove that installing an arbitrary Git URL will build missing exports.

Remove the two source patches. Retain a small deterministic build/pack bootstrap until there is an immutable built distribution the project can reference directly. Pin the eventual merged commit after reviewing any difference from this fingerprint.

### R7 — Native emergency behavior remains unqualified

**Enablement gate.** The Codex and Claude tests use protocol fixtures. They do not establish actual tool/result pairing, terminal correlation, image ingestion or reliable resumed behavior in live native sessions. The API driver explicitly reports active-turn emergency interruption unsupported; that is an honest limitation, not a reason for DroneRTS to add a fallback provider.

Qualify DroneRTS's actual Codex child path under its required Luna/xhigh configuration. Claude qualification belongs to Nervelet's separate harness work; DroneRTS does not need another backend to adopt these improvements.

## Useful implementation choices to retain

| Choice | Assessment |
| --- | --- |
| Optional generic attention evidence, no domain fields | Correct ownership boundary |
| Explicit transition/interrupt/deadline/evidence budgets | Bounded, with application-specific values |
| One fixed capsule, ordinary reliable events retained separately | Avoids an out-of-order acknowledgement redesign |
| Existing supervisor plus exported `settleEmergency` | Allows an application to preserve its single actor owner |
| No generation changes for coalesced requests | Avoids repeatedly invalidating the replacement decision |
| Argument omission with identity/digest reconciliation | Safer than the private empty-argument workaround |
| Incremental event packing with final verification | General optimization with unchanged event semantics |
| No new wait-snapshot API without measurement | Appropriate restraint |

The upstream 94.17% reduction in serialized-byte work is a fixture result, not an inference-latency or mission-success claim. Current DroneRTS hauling and collision qualification gaps remain unchanged.
