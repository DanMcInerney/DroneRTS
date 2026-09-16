# Documentation and evidence

Current contracts and setup:

- [README](README.md): project overview, demo, quick start and measured results.
- [Operating guide](GUIDE.md) and [development instructions](AGENTS.md): full rules, setup, source requirements and verification entrypoints.
- [Contributing](CONTRIBUTING.md), [security](SECURITY.md) and [third-party notices](THIRD_PARTY_NOTICES.md): public contribution and reuse boundaries.
- [Public release preparation](PUBLIC-RELEASE.md): dated verification and remaining launch items.
- [Architecture](ARCHITECTURE.md), [onboard interface](ONBOARD.md), [network](NETWORK.md), [MAVLink](MAVLINK.md) and [city](CITY.md): application owners and boundaries.
- [Offline audit QA](OFFLINE-AUDIT-QA.md) and [authorized audit design](OFFLINE-AUDIT-DESIGN.md): deterministic saved-trial reports, integrity checks, source references and coverage limits.
- [Nervelet integration](NERVELET-INTEGRATION.md): current exact pin, result retention, waits, catalog and submission contract.
- [Compact bundle QA](NERVELET-COMPACT-BUNDLE-QA.md): shorter scoped IDs, explicit acknowledgement guidance and completion-only waits.
- [Interface QA](NERVELET-INTERFACE-QA.md): generated wait arguments, corrective errors, protocol ownership and corrected offline timing checks.
- [Reliability QA](RELIABILITY-QA.md): previous dependency qualification, bounded-storage evidence and performance measurements.
- [Camera-age QA](CAMERA-AGE-POLICY-QA.md): current image-age policy and the unresolved native held-wait acquisition gate. Its measurements apply to its recorded revision.

Historical material remains at its original paths, with original dates, source hashes, measurements and unresolved gates:

- [Original integration QA](NERVELET-QA.md), [simplification measurements](NERVELET-SIMPLIFICATION.md) and [upgrade QA](NERVELET-UPGRADE-QA.md).
- [Boundary design](NERVELET-BOUNDARY-DESIGN.md), [implementation review](NERVELET-IMPLEMENTATION-REVIEW.md), [upgrade plan](DRONERTS-NERVELET-UPGRADE.md), [implementation handoff](DRONE-RTS-IMPLEMENTATION-HANDOFF.md) and [execution refinement](ONBOARD-FEEDBACK-REFINEMENT.md).
- [Gameplay results](RTS-PLAYTEST.md), [QA handoff](QA-HANDOFF.md) and [September 15 investigation](QA-INVESTIGATION-2026-09-15.md).

The current contracts supersede older proposed behavior where implementation has changed. Historical tests, deterministic protocol fixtures and successful transport delivery do not establish native camera reliability, repeated real compaction, image understanding, autonomous gameplay or calibrated hardware sensing. Attention and acoustic sensing remain independently off by default.
