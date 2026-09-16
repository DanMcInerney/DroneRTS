# Offline audit implementation QA

Implementation qualification, September 16, 2026. This is offline evidence work; no model inference or live match was launched.

## Baseline captured before tests

The September 16 battle remains in the sibling `d947/DroneRTS` checkout, under its original managed run `2026-09-16T18-06-38-453Z-focused-match-3fb32c85`. It has not been copied or exempted from retention. Source revision `e496116a55dc981c977aef69e494613e054539b4`; recorded manifest digest `5a98ef6ae00dae63f99c2fdc30a354b1e7771c0b06a63b7ed0fcdcf484658e65`.

Independent raw inspection counted 529 assembly traces, 529 submission traces, 529 replay acquisitions, 522 acknowledgement traces, 1,799 frames, 57 peer sends, nine shots and two bullet deaths. Audit size: 14,598,988 bytes; replay size: 14,747,332 bytes. Final replay summary: sim 866.1186967000299, stock 630, aboard 30, cumulative delivered 180, lost zero, total 840. The saved host reports complete cleanup. Its separate process snapshot records 38 captured owned processes and zero still alive at that historical check.

Three nested native MCP completions failed at shutdown. Current traces carry bundle identity/generation but omit consumed receipt revisions. Original result appearances do not independently prove exactly-once execution. The two parents have team-scoped identities and no per-parent control trace. The completed auditor also decodes their matching `forward_next_instruction` results: both explicitly contain `stopped:true` before their native transport failures. This operation-specific evidence supports lifecycle cancellation; shutdown timing alone would not.

The worktree being implemented starts with a clean status and the existing 600-second focused-trial cap. The sibling checkout's 900-second cap and historical reports are preserved in place; this offline change does not alter gameplay trial duration.

## Ownership

All implementation stays under `scripts/`. Nervelet remains an unchanged general library at pin `6c36b0a4845c72ac2aa9fba85df7ea3d8389ff8c`. Its exact package was rebuilt, verifying SHA-256 `c49c3ded568870692d507f039be7a5a635b07bffa0c7e1ac6e2038dc73060ad7`. DroneRTS owns the recorded-format adapters and cargo/radio/lifecycle policy. `analysis-boundaries.ts` remains the sole native observation/completion join; `test-artifacts.ts` remains the sole retention owner.

## Retained battle comparison

The new command ran against the original stopped directory. It wrote only its two new report files; existing analysis, raw evidence and historical reports were preserved. All required recorded-profile checks pass. Exact result-revision consumption and exactly-once execution remain optional, explicitly **inconclusive** checks.

Two consecutive evaluations of the final implementation produced report ID **`3806c3279a494bdf547f3a2f1cdda20daabd3a7458dfc6c8f96283669cb07485`**, analyzer manifest digest **`c576fed9336f0849468068f32da783b1281c0b1d52cb15dd9bd925743a4086c4`**, and 535 consumed input identities. The report contains 15 passing required checks, a passing optional historical process snapshot and the two optional evidence gaps above. Identical inputs/code produced identical content and ordering.

| Evidence | New auditor |
| --- | --- |
| Assembly / host submission / decoded camera bundle | 529 / 529 / 529 |
| Replay acquisitions / hashed image files | 529 / 529; no unmatched acquisition or missing image |
| Honest completed images over two seconds old | 4; accepted with `fresh:false` |
| Conservation | All 1,799 frames; maximum deviation 0; final 630 + 30 + 180 + 0 = 840 |
| Peer sends / nominal copies | 57 / 111 |
| Stored / included / acknowledged recipient copies | 110 / 110 / 108; one nominal recipient already dead |
| Acknowledgement traces / echoed seen calls | 522 / 522 |
| Original-result appearances / recovery repeats | 285 / 3; no fabricated duplicate execution |
| Completed / blocked / failed jobs | 108 / 10 / 4; blocked/rejected work is descriptive |
| Shots / bullet kills | 9 / 2 |
| Failed native MCP completions | 3, linked to the matching held-wait control or parent stopped result |
| Deduplicated error incidents | 3 domain rejections and 3 lifecycle cancellations |
| Death authority / retirement | Two deaths, both retired, no subsequent new call or recorded effect |

Native completions are per actor/tool FIFO only when anchored by nonoverlapping calls. Missing completions poison ambiguous joins instead of shifting onto later observations. Parents are scoped by team. Equal timestamps preserve file order. Replay acquisitions may be persisted after newer frames while retaining their earlier acquisition time; this is not a simulation-clock regression.

## Compatibility and deliberate corrections

All four analyzers use the same bounded loader/decoder or native boundary helper. Their CLI arguments, output filenames, shot geometry, timing calculations and historical calibration guards remain. The trial analyzer's error list now includes nested native failures and structured result errors previously missed by its broad filter. Error-only objects remain available to its rejection metrics without becoming observations. The haul analyzer adds `recordedErrors`; its existing `errors` field still means runner failures. Its conservation delta now subtracts the initial cumulative earned/lost counters as well as initial stock/aboard, verified by a fixture starting with nonzero counters.

## Safety and limits

The loader streams JSONL with 128 MiB per-file, 2 MiB per-record and 100,000-record index limits; metadata is capped at 16 MiB. Replay's current writer limits are 32 MiB JSONL, a 2 MiB header and 1 MiB ordinary records. The retained battle's audit and replay each measured about 14.7 MB. Images are streamed for SHA-256, at most 512 KiB each and a 64 MiB aggregate budget. Limit exhaustion is visible incomplete coverage. Images are never decoded or loaded as base64 by the auditor.

Every consumed input has a byte count/hash; files are checked and rehashed after reading. Paths are confined, links/junctions rejected, manifest entries never opened, active managed markers and recording status respected. Standalone auditing owns no test registration, pruning, process launch or network access. JSON and Markdown are staged and replaced atomically per file; their shared content-derived ID reveals an interrupted pair. Current wall time and absolute checkout paths are excluded from report identity.

Camera joins use unique actor/acquisition-time/simulation-time tuples because the formats lack a shared camera identity. File hashing does not prove byte-for-byte equality with redacted MCP pixels. Submitted mail does not imply acknowledgement, understanding or action; censored copies are inconclusive rather than failures. Sampled conservation is checked at every available frame, not continuously between samples. Finite-range expiry is not inferred from descriptive camera freshness. Saved process checks describe their historical snapshot and do not inspect current ports/PIDs.

The stricter aggregate profile supports the recorded cargo rules and focused scenarios. Unknown protocols, malformed/truncated evidence, missing fields and ambiguous joins cannot yield a required-check pass. Current traces do not expose acknowledged receipt revisions, and replay gameplay commands do not expose native command IDs; those gaps remain explicit rather than expanding runtime telemetry to make the report green.

## Verification

Initial focused run: **28/28 tests passed**, including the existing shot, engagement and decision-latency regressions. The first full `npm test` run passed **562/562**, including real native Zenoh/MAVLink tests; TypeScript and the production build passed.

After adding the missing-frame regression, a default-concurrency rerun passed **561/563**. The two failures were existing `onboard-routine.test.ts` cases: six workers performing asynchronous sensor work and sequential SDK-rate admission. Both received `guest_slice_deadline`; the latter expected `sdk_rate_exceeded`. They passed in the preceding full run, and every offline-audit test passed in this rerun. No runtime, worker deadline, test assertion or library behavior was changed. The failure evidence was inspected before retention pruning. Final verification uses two test files at a time to reduce unrelated concurrent CPU pressure; its result is recorded below.

Both production builds completed with Vite's existing large-chunk advisory. No model inference was launched. Related checks use a managed `FLEET_TEST_RUN`, and older managed raw evidence is pruned by the existing owner.

Final `npm test -- --test-concurrency=2`: **563/563 passed**, including the two earlier routine failures, in 75.9 seconds. Final `npm run build`: **passed**. A subsequent **33/33 focused analysis tests passed** after the last bounded-read/image-budget hardening; these include changed inputs, missing/oversized images, malformed shapes, truncated/interior JSONL, active runs, junction escapes, interrupted-output protection, deterministic IDs, all exit statuses, nonzero conservation baselines and post-close runner ordering. This does not establish that the existing routine tests are stable at default concurrency.

Newest local verification evidence: `artifacts/test-runs/2026-09-16T19-21-10-796Z-offline-audit-final-c389f969/`, containing `tests.log`, `tests/tests.log`, `build.log`, `final-focused.log` and the two stopped native-test network stores. No Node/Python process with this checkout in its command line remained at cleanup inspection. The full default-concurrency failure and its source interpretation are recorded above before its managed raw run was pruned. The original battle remains subject to its own checkout's retention policy.

Automatic approval review rejected deletion of four older, stopped suite network stores with `blocked by policy`, including a retry using explicit verified paths. These ignored residual directories remain under this checkout's `artifacts/network/`: `0cf4d0d0-128b-4365-a4fb-1f923c6d7dbe`, `384819b6-311f-41aa-9fd0-9ec3d90f7369`, `3e93add1-d542-4afa-aaef-b8a565fbee7f` and `d6d10f34-c302-434d-a3d2-88f4fe28695e`. The newest managed run was retained normally; no player session or sibling-checkout evidence was moved or deleted.
