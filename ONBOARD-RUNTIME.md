# Onboard application runtime

The first onboard package uses pinned QuickJS Emscripten **0.32.0**, with one private QuickJS heap inside a terminable Node worker for each active routine. Guest source is evaluated only by QuickJS. Node `vm`, host filesystem paths, environment variables, subprocesses, sockets, `fetch`, `require` and npm imports are absent from the guest interface. Relative `.js`/`.mjs` imports resolve exclusively against that drone's immutable workspace snapshot. No gameplay strategy or optional mathematical/vision library is preinstalled.

Run `npm run onboard:manifest` to regenerate [ONBOARD-PACKAGE-MANIFEST.json](ONBOARD-PACKAGE-MANIFEST.json). This records actual installed bytes, SHA-256, version and license for each deployed artifact. The original umbrella development install and all variants measured about 9.32 MB and exceeded the 8 MiB ceiling. The production worker instead directly imports `quickjs-emscripten-core`, `@jitl/quickjs-wasmfile-release-sync` and their `@jitl/quickjs-ffi-types` dependency. **All installed files** in those three packages count, including source maps, notices and package metadata; no advertised compressed-size estimate is used. The package also charges the onboard workspace, worker/SDK host bridge, transfer manager and shared contract source. Their exact contents are copied into a versioned `.runtime/onboard-application/` deployment and verified before launching its worker. The complete package, including its manifest, currently measures about **1.60 MB / 8 MiB** on Windows x64, Node 24.15.0; the JSON manifest supplies the exact revision-specific byte count.

The included package notices cover the MIT-licensed Emscripten binding and QuickJS engine. Upstream documents isolated runtimes, explicit host bindings, heap/stack limits, interrupt handlers and pending-job execution; those are exercised by the actual installed Windows package. [QuickJS Emscripten documentation](https://github.com/justjake/quickjs-emscripten).

Node/Python/OS, the renderer, existing simulation and native Zenoh/pymavlink bridges remain fixed host/vehicle/network infrastructure. They are not guest-importable libraries, nor are their full deployments claimed to fit this application partition. Model inference remains separately exempt. Development dependencies and historical runtime deployment directories are host artifacts, never an actor's additional workspace. This is a simulated application-storage profile, not a complete aircraft computer image.

## Storage

Each match creates private byte-accounted virtual stores. Workspaces survive model turns and catalog refreshes. A new match erases access to the previous stores; destruction revokes the destroyed drone's store. These bounded virtual files are held in memory and do not produce an unbounded host backing file. They are not preserved across a host process restart.

| Partition | Limit and accounting |
| --- | --- |
| Read-only application | 8 MiB; actual deployed package and manifest |
| Workspace | 2 MiB; UTF-8 contents, serialized names/inodes and every retained immutable version |
| Radio | 4 MiB; native persisted mail accounting supplied by the radio manager |
| Staging | 1 MiB; 256 KiB reserved for bounded native database transactions, remaining 768 KiB shared by atomic replacement peaks and inert transfers |
| Logs/events | 1 MiB; separate 512 KiB diagnostic-log and 512 KiB unread-local-event sublimits |

Files are limited to 64 KiB each and 256 files including retained versions. Relative filenames are at most 128 UTF-8 bytes. Writes preflight final workspace allocation and simultaneous staging allocation. A failure leaves the original file intact. An active routine pins the current script versions; replacing or deleting those paths cannot modify its code, and the old allocation remains charged until its worker terminates. There are no persistent compiled caches.

Transfers announce bounded size and a SHA-256 hash, expire within five monotonic host minutes, and remain inert through bounded indexed chunks. Hash verification does not import or execute code. The recipient explicitly chooses an import path; the atomic workspace write succeeds before staging is released. A failed import retains the transfer for a later recipient decision. Incoming data, verification copies, text conversions and temporary workspace replacement allocation are charged at their temporary peak. Native mail and code-transfer quotas and receipts are covered by the radio tests separately.

Diagnostic logs may rotate; authored files and unread events do not. Storage status includes each partition's usage, hard limit and free bytes. Staging reports the reserved native transaction allowance even while its actual journal is empty. No partition borrows from another.

## Execution and SDK

Routines use top-level `await` and the frozen `drone` SDK. `input` is the caller's JSON object, limited to 16 KiB. This neutral example saves the caller's own sensor sample:

```js
const sample = await drone.telemetry();
await drone.files.write('sample.json', JSON.stringify(sample));
```

`drone.telemetry()` reads the current own-state estimate. `drone.camera()` returns the latest actual model-acquired frame with age/validity; it does not request a new renderer capture. `drone.events()` reads the bounded routine event stream; it cannot consume unread messages from the model's separate next-boundary inbox. `drone.act`, `send`, `buy`, `fire`, `rearm` and `cameraMode` delegate to the same authoritative permissions as direct actor tools. `drone.files` provides `list`, `read`, `write`, `delete`, `stat` and storage `status`. `drone.sleep(ms)` yields for 1–1000 monotonic wall milliseconds. New events and telemetry do not interrupt model reasoning.

Default limits are a 32 MiB QuickJS heap, 256 KiB guest stack, **20 ms uninterrupted thread CPU**, **250 ms thread CPU in a rolling wall second**, 64 SDK admissions per wall second, eight outstanding host calls, 72 KiB per request, 256 KiB per response, two wall seconds per host call and 120 wall seconds per routine. Whole-worker startup/heartbeat watchdogs remain independent of guest interruption. Worker V8 memory is separately bounded. Limits may be reduced for fixtures but cannot silently exceed the configured ceilings.

CPU accounting uses the current worker's native `process.threadCpuUsage()`; other drones and operating-system scheduling pauses are not charged as that guest's execution. This requires **Node 22.19+ or 24+** with working thread CPU accounting and is checked before replacing existing work. Earlier Node versions fail explicitly. The initial elapsed-wall proxy caused ordinary six-worker work to fail under load and was replaced; no budget was increased. [Node thread CPU API](https://nodejs.org/api/process.html#processthreadcpuusagepreviousvalue).

Start returns an accepted job immediately after bounded preflight. The worker later reports running/completed/failed; cancellation invalidates callbacks and aborts outstanding host operations. The authoritative adapter must revalidate mission, capability and writer ownership after asynchronous wire operations. Ordinary chat or radio loss does not cancel healthy local code. Objective receipt, Stop, death and explicit control replacement do. The runner keeps at most one active worker and one terminating predecessor during replacement; further starts report `routine_cleanup_pending` until cleanup completes. `cleanupPending` in status explains that transient state. Retained code charges are released only after actual worker termination.

## Verified evidence

`node --import tsx --test --test-timeout=20000 tests/onboard-storage.test.ts tests/onboard-routine.test.ts tests/onboard-game.test.ts` passed **27 tests** on Windows x64 / Node 24.15.0. The checks cover byte/file quotas, failed atomic replacements, retained versions, inert imports and expiry, log/event sublimits, deployed artifact hashes, real QuickJS module execution, absent host access, hostile error getters, heap and CPU exhaustion, SDK rate/fanout limits, slow host cancellation, inert-promise wall deadlines, and three repeated rounds of six simultaneous isolated workers. The three six-worker rounds took about 622 ms in that run; this is a neutral host fixture, not renderer or hardware performance evidence.

Six integrated game checks use deterministic camera placeholders and real production QuickJS workers. They verify own telemetry persistence, one camera capture per model boundary, direct-control versus routine ownership, cancellation upon actual objective receipt, Stop/new-match/death isolation and preservation of model-unread peer events after a routine reads its event stream. These tests use no model inference, native helper claims or autonomy evidence. The broader native network tests and autonomous haul reports have separate scopes.
