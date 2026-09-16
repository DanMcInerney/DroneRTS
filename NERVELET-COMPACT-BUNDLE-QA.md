# Compact bundle IDs and completion-wait guidance — 2026-09-16

The [17:05 battle audit](QA-REPORT-2026-09-16-1705-BATTLE.md) found four mistyped bundle IDs and 61 `observe` calls without `seen` from Red 3. Those calls preserved reliable evidence but caused repeated delivery. This change addresses the copying and tool-use guidance in Nervelet, the existing protocol owner.

Bundle IDs use a short sequence and a random per-Bridge scope. The complete ID remains opaque and must be copied exactly; IDs from another pilot or restarted Bridge still fail. The separate epoch, event identities, receipt revisions, recovery gates and explicit acknowledgement mechanism keep their existing meanings.

Generated tool guidance now asks for the last received ID in `seen`, including on `observe` and `wait`. Recovery instructions explain that an error-only result supplies no new bundle ID. Observing without a rejected unknown/expired ID remains a way to recover retained evidence; it does not acknowledge it automatically.

The existing `jobTerminal` condition is recommended when only checking whether a job has ended. Pilots must inspect its actual status: completion, blockage, cancellation and failure are different outcomes. Bounded waits keep local execution running, and pilots can still request observations whenever they need new evidence. The DroneRTS binding supplies tool names; game-specific tactics and extra planning machinery are not introduced.

Fresh camera acquisition at ordinary tool boundaries, result/event retention, fixed storage quotas and actor isolation retain their existing owners. This change does not address the separately recorded shutdown errors or unresolved native held-wait camera qualification.

## Verification

Verification uses Node **24.15.0** on Windows and DroneRTS base `eacc8a26c7e6f8d17ffc83caf3fa619bb910599b` with the accompanying dependency, documentation and test changes.

- Reviewed Nervelet commit: **`6c36b0a4845c72ac2aa9fba85df7ea3d8389ff8c`**, version 0.2.0. It is preserved on upstream `main` through [Nervelet PR #7](https://github.com/DanMcInerney/nervelet/pull/7), merged after its Linux and Windows CI passed. The dependency continues to use this exact source commit rather than the merge commit.
- Nervelet: **141/141 tests**, typecheck, documentation, isolated package and whitespace checks passed. Regressions cover foreign/restarted IDs, exact acknowledgement of included evidence, custom tool aliases and all four terminal job states. Two existing test-only capacity fixtures now derive limits from their generated recovery envelopes while retaining rotation/overflow assertions; no production limit increased.
- `npm run nervelet:setup` rebuilt a clean detached checkout with no private patches. Its archive matches the tested candidate exactly: SHA-256 **`c49c3ded568870692d507f039be7a5a635b07bffa0c7e1ac6e2038dc73060ad7`**. The lockfile pins the archive's SHA-512 separately; fresh `npm ci` succeeded.
- The regenerated [onboard manifest](ONBOARD-PACKAGE-MANIFEST.json) measures **3,603,755 / 8,388,608 bytes** across **694 artifacts**.
- DroneRTS: **527/527 tests** via `npm test -- --test-concurrency=2` and the TypeScript/Vite production build passed in managed run `2026-09-16T17-36-27-297Z-compact-bundles-5616e210`. This includes real native transport fixtures, compact-ID isolation, actual tool/recovery guidance, receipt revisions, image acquisition, waits and unchanged cache-budget checks. The shutdown fixture logged Vite's scan-cancelled-on-close message; the build retains its existing large-chunk advisory. Neither caused a failing check.
- One independent final review found no high-impact issues and independently verified both archive digests, all 694 manifest entries and the recorded DroneRTS test/build results. The four updated current-contract documents passed 69 relative-link checks and balanced-fence checks. No further review or inference was run.

No live inference is part of this change; deterministic checks do not establish fewer model mistakes, better autonomy or lower gameplay latency. Historical battle reports remain at their recorded revisions; raw runs follow the existing single-newest-run retention policy.
