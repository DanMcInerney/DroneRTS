# Reusable offline audit layer

Status: implementation plan, September 16, 2026. No implementation or new qualification is claimed by this document.

## Purpose and scope

Make a saved trial produce a reproducible integrity report without a separate, handwritten audit for each battle. The reusable abstraction is an evidence pipeline: decode recorded facts, correlate their lifecycle stages, evaluate explicit checks, and render findings with source references and coverage limits.

This plan implements the offline audit recommendation discussed after the [15-minute battle](QA-REPORT-2026-09-16-1806-BATTLE.md). The separate proposal to standardize runtime operation outcomes is deferred. This work does not change gameplay, actor tools, prompts, Nervelet, compaction, camera policy, transport semantics, or the live operation lifecycle.

Success means another developer can run one command on a stopped trial and determine which contracts the evidence supports, which it contradicts, and which cannot be decided. A healthy report must never be inferred merely from an empty error array.

## Current code and demonstrated gaps

| Existing owner | Current behavior and reuse |
| --- | --- |
| `scripts/analyze-trial.ts` | Shot/flight analysis and calibration guard; parses the first content item as an observation and has a broad error filter. Preserve its physical diagnostics and historical calibration protection. |
| `scripts/analyze-haul.ts` | Logistics, final conservation and radio summaries; separately parses the first text item. Expand integrity coverage through shared helpers, without redefining its gameplay metrics. |
| `scripts/analyze-engagement.ts`, `scripts/analyze-decision-latency.ts` | Existing perception-opportunity and timing reports. Preserve their limitations and output contracts. |
| `scripts/analysis-boundaries.ts` | Finds observation text among multiple MCP content blocks; pairs native completions by per-role/tool FIFO. Reuse and strengthen this boundary logic rather than creating a second competing join. |
| `scripts/trial-host.ts`, `scripts/playtest-focused.ts` | Record redacted audit, replay and final trial metadata; the host closes its log after owned runtime/renderer cleanup. Suitable for a post-close audit hook. |
| `server/diagnostics.ts`, `shared/replay.ts`, `server/replay-recorder.ts` | Define redaction and recorded evidence. Redaction/truncation and bounded replay omissions are evidence limitations, not proof of absent events. |
| `scripts/test-artifacts.ts` | Owns run registration, collection and pruning. The auditor must not become another artifact lifecycle owner. |

The September 16 battle needed `audit-battle.mjs`, `battle-protocol-qa.json` and supplemental checks inside its ignored run directory. These reconciled 529 submitted camera bundles, 1,799 conservation frames, living radio recipients, receipt appearances and actor retirement. The older error filters missed nested `agent/mcp-result.error`. Three transport completions during shutdown needed lifecycle interpretation. These are the concrete reasons for this work.

The run-local script is a reference for observed facts, not a ready-made reusable implementation: it assumes complete files, a single known run format, convenient identifiers and simple joins. Do not copy those assumptions into the new contract.

## Architecture and module boundaries

Keep the implementation under `scripts/`; the live server, client and actor packages must not import it. Use existing dependencies and Node APIs. No service, database, plugin system or new runtime package is needed.

Suggested ownership, with adjacent small modules combined where that makes the implementation clearer:

| Module | Responsibility |
| --- | --- |
| `scripts/audit/types.ts` | Versioned report, evidence references, coverage, join and check result types. |
| `scripts/audit/load-run.ts` | Validate paths; read result, manifest, audit and replay; hash inputs; retain record positions; identify missing, malformed, truncated or changing inputs. |
| `scripts/audit/decode.ts` | Pure adapters from recorded formats into typed facts. Decode MCP text blocks, nested result errors, Nervelet traces, camera metadata, replay records and lifecycle evidence. |
| `scripts/audit/correlate.ts` | Session/actor-scoped indices and explicit joins for bundles, receipts, images, radio copies and lifecycle boundaries. Preserve ambiguity and unmatched records. |
| `scripts/audit/checks/` | Small pure checks grouped by provenance/coverage, observations/receipts, radio, conservation, lifecycle and errors. Each declares its evidence requirements. |
| `scripts/audit/report.ts` | Deterministic JSON and concise Markdown from the same report model; bounded evidence examples with total counts. |
| `scripts/audit-run.ts` | CLI only: parse arguments, load, evaluate, write the two outputs and choose exit status. |

Flow: saved files -> validated records -> normalized facts with references -> correlated evidence -> checks -> JSON/Markdown. Keep gameplay-specific checks separate from general parsing/correlation utilities. Avoid a universal event model that erases differences between acquisition, admission, submission, acknowledgement and execution.

Retain `analysis-boundaries.ts` as a compatible facade if its implementation moves. Gradually migrate the four existing analyzers to the shared loader/observation decoder/error extraction where applicable. Preserve their command lines, filenames, existing field meanings, calibration guards and tested timing behavior. Additional fields may be additive; corrections to measured values need an explicit explanation and regression test.

## Evidence contract

1. Every normalized fact retains its relative source file and one-based JSONL line or JSON pointer. Preserve audit and replay file order independently. A globally sorted timestamp list cannot reconstruct equal-time causality across files.
2. Keep simulation seconds, wall-clock timestamps and any recorded monotonic values separate. Monotonic values are comparable only within a known clock origin. Label wall-clock durations and anomalies; do not clamp impossible negative intervals into plausible latency.
3. Distinguish decoded/assembled observation, submitted bundle, native MCP completion, echoed acknowledgement and actual gameplay execution. An audit `tool-result` alone is not proof of final submission or model understanding. Define each metric's actual boundary.
4. Scope identifiers by session and actor, adding mission/generation where recorded. Retain receipt revisions. Repeated command IDs across actors must not collide. Repeated result payloads are appearances, not repeated side effects.
5. Prefer explicit IDs. For current recordings, use documented per-actor/tool FIFO only when the sequence permits an unambiguous pairing. Error-only completions occupy their own slot. Missing records, overlapping same-tool calls or incompatible order leave an ambiguous/unmatched join; never silently shift a completion onto a later observation. Report the join method and evidence limits. Existing source does not provide an end-to-end native call ID on every event; v1 does not add one.
6. Match camera evidence by recorded identity where available, otherwise by a unique actor/acquisition-time/simulation-time tuple with the fallback labeled. Preserve multiplicity; a Set membership test cannot prove one-to-one delivery. Extra aborted acquisitions and terminal unsubmitted work require separate classification.
7. Parse all applicable MCP text blocks, safely handling ordinary text, JSON scalars, error-only results and multiple candidate observations. An ambiguous body or truncation marker is a diagnostic, not permission to select the convenient first object. Never evaluate archived source or tool arguments.
8. Handle known observation/replay versions explicitly. Unknown versions or missing fields make dependent checks inconclusive. Do not interpret historical cube/battery recordings with current cargo rules. Legacy analyzer support must not regress merely because the new aggregate audit has a stricter current-format profile.

## Report contract and CLI

Proposed command:

```sh
node --import tsx scripts/audit-run.ts <saved-trial-directory>
```

Write new `audit-report.json` and `audit-report.md` in that directory. Preserve `result.json`, raw evidence, existing analysis files and historical checked-in reports. An `audit:run` npm alias is optional convenience, not a separate code path. Do not introduce a live browser requirement.

The JSON schema is `fleet-offline-audit/1`, with:

- Run identity: scenario, session, recorded source revision/manifest, rules/protocol versions, recorded roster, trial wall budget and covered simulation interval.
- Analyzer identity: implementation version and a manifest/hash of the audit implementation and shared analysis helpers. Keep this distinct from the recorded game source identity. A changed checkout is expected when analyzing a historical run.
- Input identity: relative filenames, byte lengths and SHA-256 hashes for consumed metadata/logs. Camera checks must state whether files were merely present or also hashed; existence never proves pixel fidelity. Missing inputs have explicit entries.
- Coverage: parsed/invalid/unknown records, truncation and omission indicators, replay coverage/end summary, clock anomalies, unmatched/ambiguous joins and completeness by check family.
- Checks: stable check ID, status, impact/severity, applicable rules, summary, measured counts/units, prerequisite coverage, bounded evidence references and limitations.
- Metrics: factual battle and protocol counts, separately labeled from integrity verdicts. No inference of intentions or strategic skill.
- Findings: deduplicated lifecycle/error incidents with all linked raw appearances. Raw appearance counts remain available separately.

Check status is `pass`, `fail`, `inconclusive` or `not-applicable`. A pass requires positive evidence and sufficient coverage of that check's stated scope. Missing evidence is inconclusive; not-applicable requires an explicit reason such as an incompatible ruleset or a scenario without that operation. Ordinary rejected inputs and blocked movement are metrics unless they violate a contract.

The aggregate verdict uses a declared set of required checks appropriate to the recorded scenario/protocol: any confirmed violation is a failure; otherwise an inconclusive required check makes the result inconclusive; only complete passing required checks permit a pass. Unsupported profiles cannot accidentally produce a pass through an empty check set. Optional evidence limits remain visible.

CLI exit codes: `0` = supported profile passes required checks and has no confirmed integrity violations; `1` = at least one confirmed integrity violation; `2` = otherwise incomplete/unsupported evidence, invalid invocation, or analysis/write failure. Print a concise reason and report path. A valid report should still be written for partial readable evidence; fatal path/I/O failures must not overwrite an existing report with an empty placeholder.

Write outputs via temporary files and atomic replacement. Give both formats the same content-derived report ID so interrupted publication is detectable. Identical inputs and analyzer code produce identical report content, ordering and IDs; omit current wall time from the deterministic payload. Bound displayed examples while retaining exact total counts and an explicit examples-omitted count.

## First implementation checks

| Check family | Required interpretation |
| --- | --- |
| Provenance and completeness | Verify the existing recorded manifest digest using its actual serialization convention. Record input/analyzer identities separately. Treat a mismatch as a violation; missing identity as unavailable. Verify relevant calibration only for a check that needs current source constants. Do not require the entire historical source manifest to match the current checkout. |
| Opening objective | For applicable normal matches, identify every recorded pilot's submitted opening objective and the launch gate evidence. Check the observed gate boundaries, reporting startup coverage. An assembled bundle is insufficient. |
| Camera delivery | Reconcile assembly, submission, observed MCP image blocks and replay acquisitions/files. Report orphan/duplicate/omitted evidence by stage. Check timestamp/age/freshness consistency where the recorded schema defines it. Completed images older than two seconds with honest age and `fresh:false` are valid; retain physical range-sensor expiry as a separate policy. |
| Acknowledgements and receipts | Match `seen` to that actor's submitted bundle and exact included result revisions when traces expose them. Separate repeated appearances, recovery redelivery, acknowledgement and execution. Do not assert exactly-once effects solely from a deduplicated list of receipts; checks requiring execution evidence are inconclusive without it. |
| Radio | Expand each accepted send into recorded-team recipient copies, excluding sender/player as appropriate. Distinguish queue/storage receipt, bundle inclusion and acknowledgement. Classify already-dead recipients, death before inclusion, expiry/rejection and run-end censoring separately. “Alive at send” alone does not guarantee an inclusion before cutoff. Do not fail a delayed/censored copy without a recorded contract violation. Use authoritative lifecycle order when available; sampled liveness is labeled approximate. |
| Cargo conservation | For supported cargo rules, check every available frame: resource stock + cargo aboard + cumulative team earned + cumulative lost equals the initial total. Reservations remain in stock; recoverable drops must not be counted twice; spending does not subtract from cumulative earned. Include the initial frame's earned/lost values, not an assumed zero. Report first/max deviation, checked coverage and final values. Unsupported rules remain explicit. |
| Death and retirement | Link death and retirement evidence by actor. Check for new tool invocations/admissions/executed effects after death, distinguishing late completion logs of already-in-flight calls. Check confirmed retirement separately from immediate authority revocation; missing terminal coverage is inconclusive. |
| Errors and cancellation | Extract top-level tool/transport/trial errors, MCP `isError`, nested `agent/mcp-result.error`/failed status and structured Nervelet/result errors. Group only with supported correlation. Preserve domain rejection, expected lifecycle cancellation, unexpected failure and unclassified error as distinct categories. A string containing “session ended” or proximity to EOF is insufficient to excuse a failure: cite the relevant recorded death/stop/control boundary and matching actor/operation. Unrelated shutdown-adjacent failures remain visible. |
| Recording and cleanup | Report replay end/status, omission counts, coverage and final summary consistency. Separate host-reported cleanup, recorded owned-process checks and current machine state. A saved report cannot prove that today's port is free, or that every historical PID exited, without the corresponding saved evidence. Missing optional process/browser check files must not be fabricated as successes. |

Timing and compaction remain descriptive metrics in the existing latency analyzer. This implementation neither fixes compaction nor uses one battle's timing as a regression threshold. Target recognition, moving-target combat, useful coordination and perception still require the existing qualified analyses and actual image review.

## Input safety, size and artifact lifecycle

- Resolve the run directory explicitly; do not trust `result.directory`. Validate the recorded session basename and every derived replay/image/manifest path. Reject traversal and symlink/junction escapes. Do not read arbitrary paths listed in a hostile manifest or use them to run commands.
- Stream JSONL with documented record/file/index limits chosen against current writer limits and measured saved-run sizes. Inspect images as files without loading all base64/JPEG content into memory. Limit evidence examples, not counted input records silently. If an input limit is reached, emit an explicit incomplete-coverage result.
- Preserve malformed-record locations. A truncated final line makes dependent checks inconclusive; interior corruption remains a reported integrity problem. Neither may silently disappear from the denominator. Redaction may also hide records or nested payload fields, even when outer JSON is valid.
- Audit only stable stopped inputs. Honor active managed-run markers and writer state; reject standalone analysis of an active run. Check input identity before/after reading to detect changes. A post-close runner invocation may use its own still-active managed directory after all writers have closed; that exception belongs to the runner's library call, not a user-facing bypass flag.
- Standalone offline analysis must not call `createArtifactRun`, `finish`, `pruneTestRuns`, collect/move archives, start actors, or contact the network. It creates only its derived reports.
- Retain the existing newest-run policy. Before implementation tests can prune the current battle, analyze its raw evidence and save the comparison in a checked-in implementation QA document; extract small sanitized regression cases where needed. Do not preserve the full raw battle in Git or copy old raw runs elsewhere to evade retention. If the raw run is already gone, use checked-in facts and fixtures and state that full replay comparison was unavailable.

## Implementation sequence

1. **Baseline before tests.** Read repository instructions and current analyzers/tests. Inspect the retained battle if present; record expected facts and capture small fixtures for the failure modes below. Preserve all existing working-tree changes. Do not launch inference.
2. **Shared decoding and references.** Implement safe loading, supported format adapters, typed facts and provenance. Move shared observation/error parsing behind tested helpers; retain compatible exports for existing boundary consumers.
3. **Correlations and checks.** Implement scoped joins, completeness tracking and independent checks. Add explicit ambiguous/missing cases before assigning pass/fail. Derive counts from evidence rather than hardcoding the battle's roster, totals or IDs.
4. **CLI and report.** Add JSON/Markdown rendering, deterministic identity, exit statuses and failure-safe writes. Re-run against the retained battle before running a new managed test suite that can prune it. Save aggregate comparisons and any honest limitations in `OFFLINE-AUDIT-QA.md`.
5. **Analyzer migration.** Adopt the shared loader/decoder/error and boundary helpers in the four analyzers where relevant. Keep specialized gameplay computations in their current owners. Existing analysis tests must continue to pass; document intentionally corrected counts.
6. **Focused-runner integration.** After `host.close()` succeeds, collection completes and final `result.json` is written, call the audit library on the owned closed run before artifact finalization/pruning. Save audit status separately from gameplay outcome. Preserve prior trial failure exit status; otherwise surface audit exit `1`/`2`. If cleanup did not close writers, skip automatic reading, report why, and preserve the runner failure. Never let an audit exception prevent cleanup or archival. No live trial is required to test this integration.
7. **Verification and documentation.** Run meaningful focused tests, the existing suite (`npm test`, without inference) and `npm run build`. Keep related checks in an active managed `FLEET_TEST_RUN` where supported by existing tooling. Update README commands, architecture ownership and the documentation index. Record actual results and limits in the new QA document without rewriting historical reports.

Adding lifecycle telemetry or an end-to-end correlation ID could improve future evidence, but it is a separate follow-up if the offline implementation identifies an actual blind spot. This plan accepts honest inconclusive results rather than expanding runtime scope to force a green report.

## Required regression coverage and acceptance

Use small synthetic fixtures under the existing test harness, generated data where clearer, and sanitized real-format fragments only where needed. Fixtures must remain inert and must not depend on retained raw artifacts, native actors or external services.

- Mixed MCP content: ordinary text before JSON, scalars, multiple candidates, redaction/truncation, image metadata, error-only calls and nested native errors.
- Interleaved actors sharing compact IDs; receipt revisions; successful recovery redelivery; actual duplicate execution evidence; missing submissions/acknowledgements; concurrent or missing native completions without incorrect FIFO repair.
- Equal timestamps with different file order; post-fire acquisitions; cancelled captures; duplicate camera tuples; missing images and honest old-image freshness. Preserve existing boundary tests.
- Broadcast copies to living, already-dead and subsequently-dead recipients; player copies; undelivered terminal/expired copies; separate inclusion and acknowledgement counts.
- Conservation across reservations, cancelled loading, partial loads, delivery, spending, recoverable drops and permanent loss; missing frames and non-cargo historical rules.
- Lifecycle-confirmed cancellation versus the same error during gameplay; unrelated failures at shutdown; post-death new effects versus late completion; absent cleanup proof.
- Empty/partial/unsupported logs, malformed interior and trailing records, manifest mismatch, changed current checkout, path escapes, output preservation, stable report identity and all exit statuses.
- A focused-runner harness proves auditing occurs only after writers close, preserves primary failures, and cannot prevent cleanup. Existing analyzers retain their interfaces and calibration guards.

When the saved September 16 run is available, compare independently with its recorded facts: 529 submissions and camera files, 1,799 conserved frames, 57 peer sends, 111 nominal teammate copies with 110 included living-recipient copies and one already-dead recipient, 522 acknowledgement traces, nine shots/two kills, and three failed native MCP completions at shutdown. These are regression expectations for that artifact only, not universal acceptance thresholds. Report any newly discovered ambiguity rather than forcing every check to pass. Repeated receipt appearances must not become fabricated duplicate effects.

Acceptance requires a single offline command, deterministic referenced reports, honest missing-evidence handling, demonstrated extraction of the previously missed nested errors, compatibility tests for existing analyzers, and no changes to actor-visible behavior or historical evidence. No new autonomous gameplay or hardware claim follows from this work.

## Prompt for a new implementation session

```text
Implement the reusable offline audit layer described in OFFLINE-AUDIT-DESIGN.md in the DroneRTS repository. Treat that document as the scoped implementation plan and carry it through implementation, tests, build and an OFFLINE-AUDIT-QA.md report.

Read AGENTS.md and its required documents, then inspect the current working tree. Preserve existing changes, including the 900-second trial cap and September 16 battle reports. Read QA-REPORT-2026-09-16-1806-BATTLE.md and the existing analyzer/boundary tests. Before starting tests that prune artifacts, inspect and analyze the retained battle if available, record its baseline and extract only small sanitized fixtures; do not commit or preserve full raw runs outside the retention policy.

Build shared offline decoding/correlation helpers, explicit coverage-aware integrity checks, and scripts/audit-run.ts producing deterministic audit-report.json and audit-report.md with evidence references. Handle nested MCP errors, lifecycle cancellation, submission versus acknowledgement, recovery redelivery, camera provenance, radio recipient lifecycle, all-frame conservation and incomplete evidence. Follow the plan's report/exit contracts. Migrate duplicated parsing in the four existing analyzers without breaking their interfaces or historical calibration guards. Integrate the auditor after owned focused-trial cleanup and final evidence writes, without allowing audit failures to interfere with cleanup.

Keep this offline and modular. Do not change gameplay, actor tools/prompts, Nervelet, compaction, camera freshness policy, inference configuration, runtime outcome contracts or logging protocols. Do not launch a live battle or model inference. Use inconclusive results for evidence gaps instead of changing the runtime to make checks pass. Never execute archived code or route replay knowledge into actors.

Verify with focused regression tests, npm test and npm run build; compare with the saved battle before it can be pruned, if available. Update README, ARCHITECTURE.md and DOCUMENTATION.md, and write OFFLINE-AUDIT-QA.md with actual checks, corrected interpretations and remaining limits. Finish with a concise summary of changes, validation and anything still inconclusive. Proceed without another design-approval step.
```
