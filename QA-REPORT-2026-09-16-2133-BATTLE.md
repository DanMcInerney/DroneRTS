# Normal battle QA — September 16, 2026, 21:33 UTC

The requested **600-wall-second** normal battle trial ended at its time limit at **554.614 simulation seconds**, with six survivors, no shots and no winner. Red's three pilots each loaded and delivered 30 salvage. Blue delivered none. Red bought two guns and one armor upgrade, leaving 10 credits. No unexpected runtime failure or browser error was recorded. The offline audit is **inconclusive**, with no failed checks: its decoder excludes two recorded startup recovery bundles, and optional receipt/execution checks lack the required trace fields.

## Execution and evidence

- DroneRTS source: `0908252cd6430d16eaee1ebb778edc42e78e4382`; exact public npm `nervelet@0.2.0`.
- All **238** source-manifest file hashes matched after the run. Manifest SHA-256: `4388d93c63b27d47c4cbb00c0eebeb64dc19f560f18c69cdce056a4d0a6a14a9`.
- Standard `match`, six clean-context **gpt-5.6-luna / xhigh** pilots, two mechanical parents, real isolated Zenoh teams and six MAVLink identities. Fixed **1×**, attention/acoustics off, no fixture equipment or player intervention.
- Isolated port **4318**; 4317 was unused and untouched. The wall-clock budget includes pilot startup and the initial objective gate, explaining the shorter simulation duration. Run metadata starts at 21:33:42.005 UTC; cleanup completed at 21:43:52.841 UTC.
- Watched all six live feeds in the in-app browser, saved four screenshots and periodic state snapshots, and inspected actual 512×288 acquired images. No gameplay or dependency code changed.
- Raw evidence: `artifacts/test-runs/2026-09-16T21-33-41-932Z-focused-match-4db4c6b1/`, subject to newest-run retention. Includes the replay/images, audit, source manifest, four offline analyses and `live-qa-*` evidence.

## Outcomes

Times are simulation seconds. Each pickup/delivery was 30 salvage.

| Pilot | Pickup | Delivery | Final equipment |
| --- | ---: | ---: | --- |
| Blue 1–3 | — | — | None |
| Red 1 | 278.209 | 487.943 | None |
| Red 2 | 407.391 | 477.229 | Gun, armor, 12 rounds |
| Red 3 | 329.900 | 467.758 | Gun, 12 rounds |

Red pilots crowded the same apron. Several obstruction/coverage stops delayed departure, but they separated without intervention and all delivered. Blue shared visual sightings and revised inaccurate pad estimates, then held above the area after spotting red drones. It resumed approaching later but had not loaded at cutoff. No pilot completed a second haul; Red 1 had started returning for another load.

Actual acquired images support the reported sightings: Red 2's `b9eb0951-144b-47db-baf4-ccc55c24c62b.jpg` (sim 129.651) contains a distant yellow apron; Red 1's `9a8beae9-2cb1-4a7a-836c-6b7cfe4a2b29.jpg` (276.564) shows the loading pad; Blue 3's `3deda3ca-bf20-4d31-9a3b-8ed26a195ce7.jpg` (376.269) shows three red airframes beside the pad before its threat report at 388.021. Red 3's `6b6bb6fd-0d08-4a18-914f-dc18789a7cd2.jpg` (473.729) shows its base after delivery. These files are in the run's replay directory.

## QA findings

**The audit decoder misses legitimate startup recovery envelopes.** Audit lines 619 and 628 contain Red 1/2's text-only `goal_changed` recovery results, including the objective, current telemetry, events and Nervelet IDs. Assembly/submission traces are at 618/621 and 627/630; subsequent acknowledgement traces are at 771/811. These envelopes lack the normal observation `protocol`/`sensors` fields and are excluded by the observation decoder. Consequently, it counts 413 submissions but 411 observation bodies, four rather than six opening-objective bodies, and two `seen` calls unmatched by the auditor (the calls at lines 770/810 were actually acknowledged at 771/811). This is an audit coverage problem, not evidence of lost delivery or a broken opening gate. Keep the saved aggregate verdict inconclusive; supporting these recovery envelopes is a focused follow-up for the auditor.

**Gameplay progress was limited.** Twelve movement jobs blocked (seven obstruction, five coverage-unavailable); the visible red-pad congestion recovered. One Blue 3 job correctly failed because it requested `z=-25`, outside the map's `z >= -20` limit. Blue 3 also made one invalid exchange using nonexistent tool `status` instead of `send`. These are explicit rejected/blocked operations, not crashes. No demonstrated deadlock or collision bug follows from this run. The absence of shots means combat effectiveness, moving-target hits and victory autonomy remain unqualified.

**No QuickJS routines were exercised.** There were no workspace writes, routine submissions or transfers. This battle therefore adds no live evidence for the preceding heap and Windows CPU fixes; their focused regression tests and Windows/Linux CI remain separate evidence.

## Checks and limits

- **411** recorded camera acquisitions matched **411** submitted images and existing hashed files, with no omissions. Acquisition-to-delivery age was at most **1.075 s**. The two recovery envelopes above are separate from image-bearing observations.
- All **89 expected pilot-recipient radio copies** were stored, included and acknowledged. This verifies delivery stages, not understanding. No repeated radio appearances were reported.
- All **1,173 replay frames** conserve **840 salvage**: final **750 stock + 90 cumulative delivered + 0 aboard + 0 lost**. Red spent 80 of its 90 delivered credits.
- The audit recorded **80 completed, 12 blocked and one failed** movement job. Its error classifier found one domain rejection and four shutdown cancellations, with zero unexpected or unclassified failures. The two pending pilot waits and two parent waits ended when the trial closed.
- Longest completed-tool-to-next-call gap: **35.789 s**; no recorded compaction. These gaps include backend/transport time and are not measurements of private reasoning.
- Three required audit checks are inconclusive because of the recovery-envelope joins. Optional exact receipt revisions and exactly-once execution remain unproven because consumed-revision lists and execution identities are absent. The built-in process snapshot check is also inconclusive; it does not consume the separate manual cleanup evidence.
- Browser: no errors; two Three.js environment-blur clipping warnings and one shadow-map deprecation warning at startup. The six feeds continued rendering.
- Runner cleanup is complete. Subsequent OS checks found no trial host/native helper processes and no listeners on 4318 or either actor MCP port; 4317 remained unused. The owned browser tab was closed. See `live-qa-cleanup.json` for the scope/time of this check.
- The normal runner's automatic audit exited **2** for inconclusive evidence, not a failed gameplay check. All four offline analyzers completed successfully. No further inference or test run was launched, and the saved source hashes remained unchanged.
