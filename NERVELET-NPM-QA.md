# Nervelet npm qualification — September 16, 2026

This update replaces the local source archive used by DroneRTS `2a7eded` with the published **`nervelet@0.2.0`** package. Runtime behavior, model configuration, transport requirements and storage limits are unchanged.

## Package identity and review

- Registry archive: `https://registry.npmjs.org/nervelet/-/nervelet-0.2.0.tgz`.
- Lockfile integrity: `sha512-XbW1PPndc7AOULGL7ZhIl1Mr+LhVSI1tAtYRmL5GNOldnGRjxoBWX+wBp1KuBgRQYlGyycTm2fwq/XJw2YUJXg==`.
- Archive SHA-256: `55e9e3bb49062700d5d9a0de5c56e81c4522354d5e70edb162eac43e7fb342cc`.
- The package declares MIT and ships `LICENSE`, copyright 2026 Dan McInerney. Release preparation is recorded in [Nervelet PR #8](https://github.com/DanMcInerney/nervelet/pull/8).
- All **56 compiled JavaScript and type declaration files** match the previous qualified package byte for byte. Their hashes also match the checked-in onboard manifest from before this change. The earlier source revision is `6c36b0a4845c72ac2aa9fba85df7ea3d8389ff8c`; the published archive has its own identity above.

`package.json` pins `0.2.0` exactly; `package-lock.json` pins the registry URL and integrity. The source-build script, `nervelet:setup` command and CI source-clone step are removed. Historical reports keep their source identities, with links to the removed bootstrap pointing at its historical commit.

## Verification

Local Windows x64, Node **24.15.0**, Python **3.14.6**:

| Check | Result |
| --- | --- |
| `npm ci` using the updated lockfile | Passed; installed Nervelet 0.2.0 with MIT metadata and license file. |
| Separate fresh consumer containing only package/lock files | `npm ci` and importing the exported `Bridge` passed without a source clone or local archive. |
| Dependency isolation | No `file:` lock entries; optional serialport and Claude SDK peers remain absent. |
| `npm run network:setup` | Passed with the pinned native Zenoh and MAVLink helpers. |
| `npm test -- --test-concurrency=1` | **535 passed, 0 failed, 0 cancelled, 0 skipped**, including real native Zenoh/MAVLink integration. |
| `npm run build` | TypeScript and production bundle passed; the existing Vite large-chunk advisory remains. |
| `npm run onboard:manifest` | **3,605,376 / 8,388,608 bytes**, 696 measured artifacts, including the shipped Nervelet MIT license. |
| npm dependency audit | Zero known vulnerabilities reported during installation. |

The manifest no longer exempts Nervelet from license validation. The deployment test checks that its MIT license is included; existing deployment verification checks measured bytes and hashes. CI now installs directly from npm on both Windows and Linux before building and running the full suite.

The first hosted attempts exposed timing-sensitive routine fixtures: a `guest_slice_deadline` in the six-worker isolation check and two bounded routine-admission waits. An unchanged retry passed Linux but repeated the six-worker failure on Windows. The isolation fixture now starts workers one at a time, holds their first sensor calls until all six are running, then releases all six for concurrent work. It verifies eight sensor calls and the correct private file for every worker in each of three rounds. Production slice, CPU, startup, host-call and storage limits remain unchanged; no test is skipped or retried inside the suite.

A subsequent Windows run passed the worker checks but exposed a radio-expiry fixture that allowed only 200 ms for several durable SQLite commits. That fixture now uses a controlled monotonic clock for admission and explicit time advances for expiry, and additionally checks that admission rejects an already-expired deadline. Its focused local test passed after the full local run recorded above. Real database writes and production expiry behavior remain unchanged; the hosted suites check the combined revision.

No model inference or live gameplay was launched for this packaging change. These checks do not resolve the [native held-wait camera qualification gate](CAMERA-AGE-POLICY-QA.md) or establish new autonomous gameplay results. Earlier protocol and gameplay reports retain their original scope.

## Combined main verification

The npm migration was merged in [PR #26](https://github.com/DanMcInerney/DroneRTS/pull/26) after both hosted platforms passed all 535 tests. Concurrent offline-audit work also reached main; the combined `ceb1757` revision passed the production build and **565/565 tests locally and on hosted Linux**. Hosted Windows passed 564 tests but exhausted the 30-second subprocess allowance while filling the real SQLite quota fixture. That capacity fixture now has the same bounded 90-second subprocess and 120-second test allowance as the adjacent full-mailbox fixture. Its quota, Unicode, journal-growth and integrity assertions are unchanged, as are all production limits.
