# Nervelet reliability implementation — September 16, 2026

Implemented from DroneRTS `c23a0c823038995eaae3729e4226b6e4c33e4301` and
Nervelet `ea28137b8c64cfec059cca72060427a10af279c3` in separate `codex/` worktrees.
Original checkouts, local edits and the audited review worktree were preserved.
No inference, native agent session, live match, browser or hardware was used.
The required full suite uses owned local MCP, native protocol and shutdown
fixtures and closes them afterward. Nothing was merged or deployed.

## Dependency and reproduction

Nervelet source: **`54ba0d38e0ee7216212d231020d088da3a3fe435`**, version 0.2.0.
The source was committed clean, built and packed, then installed from the actual
archive. No installed package or staged library source was patched.

- Archive: `.runtime/nervelet-54ba0d38e0ee7216212d231020d088da3a3fe435.tgz`.
- SHA-256: `8f3ea917f4229fec422e414f3349aff08ef51b22816267ef37be22ffccc8f488`.
- SHA-512: `sha512-BN1yMJgl34KNRoCvfQuEJjie0tJpH6lTnplOimM/6IdqlQ20bai7ES0vZYXbNkjQ0Dr1/B+19h+mkS/Gcgp83A==`.
- MCP SDK: **1.30.0**, the already locked version, now exact in both manifests.

Review/publish the Nervelet commit first, then the dependent DroneRTS branch.
Until that commit exists in the selected public upstream, set `NERVELET_SOURCE`
to a local clone containing it. For this implementation the source was
`C:/Users/danhm/tools/nervelet-implementation-20260916`. Run
`npm run nervelet:setup`, `npm ci`, and `npm run network:setup` with Node 24+.
The first two commands succeeded with the declared archive and integrity.
Clean-checkout reproduction is recorded below.

## Accepted scope

| Audit items | Implementation and regression evidence |
| --- | --- |
| N6, stale acknowledgement | Nervelet revision-bound delivery and acknowledged resolved reclamation; receipt pressure, old unknown acknowledgement, conflict IDs, failed submission and legacy/v2 transition tests. |
| N5 / D4 | Generic immutable `Receipt.data`, retained/wire reservation before effects, adapter original execution reconciliation and release hooks. Lost read, changed/deleted file, partial exchange, late completion, failure matrix, maximum file/list, aggregate/record pressure and six-pilot isolation tests. |
| D2 | Pilot-scoped `onboard-change`, explicit `onboard-lifecycle` and numeric tick channel. Actual waiting-adapter tests count telemetry and LocalSensors acquisitions; shared wallet effects remain relevant. |
| N1 | Canonical v2 `anyEvent`, omitted-until alias migration, independent typed floors, literal `*`, backlog, registration-race and deadline tests. |
| N2 / N3 | `Environment.wait`, `ObservationStore.wait`, legacy `waitMs` and `reconcile(command, signal)` remain supported and tested. |
| N4 | Deeply checked `immutableProfile`, default mutation guards, asynchronous replacement tests and measured traversal removal. |
| D3 | Stable ruleset advertisement and exchange enum, dynamic `availableTools` and execution admission; capability, retirement, foreign actor, attention and compaction tests retained. Equipment-only yield/resume removed. |
| D5 | Exact SDK pin; real-client final-output, overflow, disconnect and concurrent request-correlation tests. |
| N7 / N9 / D6 | Touched receipt/wait/adapter transitions are explicit; current contracts and navigation indexes updated without deleting historical evidence. |
| N8 | Attention/acoustics remain independently off by default; no feature expansion. |
| D1 | All existing direct-tool and exchange observation boundaries retain fresh acquisition. |
| D7 / D8 | Launch remains successful-submission based; model `seen` remains separate. One Bridge per pilot, authoritative original executions and individual inner exchange outcomes retained. Shared cancellation remains idempotent. |

## Storage and delivery proof

No application partition grew. Nervelet still reserves **393,216 bytes (384 KiB)**
from diagnostics/cache: **196,608 bytes** for retained result data and the same
amount for profile, instruction, maximum goal, scalar receipt/executor,
delivery-reference and control metadata. Constructor accounting is enforced.
Histories are 16 receipts/executions and eight delivery mappings. This reduces
the old 64/32 maxima to fund explicit reliable storage. Expired bundle IDs fail
explicitly; retained uncertain/unacknowledged results never silently disappear.

| Fixture | Measured charge |
| --- | ---: |
| Default metadata, including maximum 24 KiB goal | 187,048 bytes |
| Metadata with optional acoustic briefing | 189,932 bytes |
| Default maximum metadata + full result pool | 383,656 / 393,216 bytes |
| Acoustic maximum metadata + full result pool | 386,540 / 393,216 bytes |
| Original 65,536-NUL read result | 133,348 retained bytes |
| Same result final JSON-RPC text / wire | 465,160 / 465,172 bytes |
| Full 256-file listing, maximum-length paths | 166,182 retained bytes |
| Same listing final text / wire | 76,406 / 76,418 bytes |

Timestamp lengths can change final wire counts slightly. The maximum NUL file's
content alone expands to 393,216 JSON bytes; the 400 KiB command-input limit is
preserved. A read reserves 144 KiB retained and 480 KiB escaped delivery before
dispatch; a listing reserves 180 KiB retained. Aggregate byte pressure and the
17th unseen result reject before mutation without consuming the command ID.
Acknowledgement releases original payload references in both core and executor.

The retained charge is an explicit storage abstraction, not measured V8 RSS:
UTF-16 value strings, pooled property names, containers and slots are charged.
The core and authoritative execution promise share one immutable payload. No
workspace version is pinned for read redelivery; the original copied string is
charged to the result pool, so deletion/replacement cannot invalidate it.
Current telemetry contains no historical operation output; receipt data carries
`{result,isError}` and never retains camera pixels as a fresh observation.

One ordinary call per pilot bounds transient input/serialization/acquisition:
512 KiB request, 400 KiB command, 512 KiB ordinary / 640 KiB recovery text, and one
512 KiB decoded image. Encoded JSON may temporarily coexist with decoded objects;
those wire buffers are separate from persistent result storage. Unknown execution
keeps its reservation and gates further effects until authoritative reconciliation.

## Work avoided

The audited waiting pilot did 15 telemetry reads and 15 LocalSensors acquisitions
for 15 other-pilot movements. The new real-adapter fixture performs 15 peer
movements, five looks, ten workspace operations, 15 other inbox pushes and 30
spaced UI changes: **zero extra waiter telemetry reads and zero sensor
acquisitions**. Idle waits also avoid snapshot work on ticks. Physical simulation
sensing continues; numeric conditions still receive tick updates. Own mail/jobs,
shared wallet changes and explicit Stop/reset/replacement/death/disconnect
signals retain their appropriate wake/abort behavior, without polling.

Actual profile root traversals at observe/workspace/look/two-look exchange were
**0 / 0 / 0 / 0**, versus audited **1 / 3 / 4 / 7**. The 22,239-byte current
profile's isolated mutable check measured 93.469 μs median; immutable identity
checks measured 0.00383 μs, after a 0.491 ms construction proof. Tiny identity
timings are JIT/timer-sensitive. This is neither a camera-timeout fix nor a
measurement of model latency. See Nervelet's `docs/reliability.md` for packing
and benchmark reproduction.

## Validation

One independent final review found two library edge cases. The repair adds
revision/identity checks after awaited reconciliation, preventing stale results
from recharging evicted records or changing recovery. It also reserves 2,048
escaped bytes for default scalar results before reliable admission, preventing
an effect from creating an undeliverable receipt. Five added library regressions
cover those paths, explicit scalar bounds and legacy compatibility. The final
application checks below use the repaired clean package, not the earlier pin.

Windows x64; Node **24.15.0**; isolated Python **3.14.6**, Zenoh **1.10.1** and
pymavlink **2.4.49** installed through `network:setup`.

| Check | Result |
| --- | --- |
| Nervelet `npm ci`, `npm test` | Pass, **129/129** |
| Nervelet typecheck / docs / package / diff | Pass; clean commit package consumer and optional-peer isolation verified |
| DroneRTS `nervelet:setup`, `npm ci`, `network:setup` | Pass |
| New original-result/storage suite | **15/15 pass** |
| Final-pin focused integration / results / waits / runtime / MCP / attention / notifications | **87/87 pass**, including all five real MCP tests |
| Full DroneRTS `npm test` | **499/499 pass**, including actual native protocol fixtures |
| TypeScript + production build | Pass; existing Vite large-chunk advisory |
| Onboard manifest | **3,589,679 / 8,388,608 bytes**, 694 measured artifacts |
| Documentation targets and fences | Seven current files, 79 local links and five fences checked |
| `git diff --check` | Pass |

Fresh-checkout verification cloned application commit
`b1410a57f53040855e6144736d2e8f75186faf8f` into the ignored
`.runtime/final-fresh-install/` directory. With the local `NERVELET_SOURCE` above,
`nervelet:setup`, `npm ci`, the production build and manifest generation all
passed. The rebuilt 124,409-byte archive matched both hashes above; the complete
manifest was identical. All **29/29** result and wait tests passed in that clone.
The subsequent commit adds only this evidence record. Public upstream setup
remains unqualified until the pinned Nervelet commit is published there.

The shutdown fixture can emit Vite's closed-server dependency-scan diagnostics
while it deliberately closes its owned server; all assertions and port cleanup
passed. Full raw test output is retained by the managed artifact runner. No
previous suite count is treated as evidence for this revision.
The final managed run is
`artifacts/test-runs/2026-09-16T14-14-41-783Z-tests-c7b15ee1/`; related focused,
setup, build, manifest and fresh-checkout logs are grouped there.

## Remaining qualification

The earlier real native held-wait camera acquisition failure remains open; see
[camera-age QA](CAMERA-AGE-POLICY-QA.md). These tests do not establish repeated
real native compaction, image understanding, autonomous hauling/combat, acoustic
calibration or hardware readiness. Completed images keep honest acquisition
timestamps; missing images remain explicit. No two-second hard image gate was
restored, and no sensor permissions, quotas, gameplay or tactics were expanded.
