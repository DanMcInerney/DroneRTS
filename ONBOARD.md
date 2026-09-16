# Bounded onboard interface

This revision treats each drone's model as a simulated onboard brain. The inference engine and its weights are exempt from vehicle hardware/storage modeling. Real latency, failure, actor isolation, private script storage and execution budgets still apply. The initial backend is Codex with explicit **gpt-5.6-luna / xhigh**. Unsupported provider/model/effort configurations fail before inference; there is no substitution. Additional providers must satisfy the same role, observation, capability and lifecycle contract in `server/agent-backend.ts`.

A model can use only role-bound fleet tools. QuickJS routines run separately from model thinking through the same game authority. They have no shell, process object, network sockets, host files, arbitrary packages, world lookup or replay access. Player/browser state is not a sensor.

## Observations and continuous control

`shared/onboard.ts` defines the application profile; `server/game.ts` supplies timestamped own state at model boundaries and continuous own telemetry to routines. Acquired pixels retain their capture-time pose, time, sequence and optical mode. Newer live telemetry is separately labeled. Camera failure and stalled/old samples are explicit. Samples are idealized simulator estimates, with no physical noise or drift claim.

Camera `ageMs` includes acquisition/rendering/transfer time up to bundle assembly. Its legacy `fresh` flag marks whether the available connected sample is at most two seconds old; this is descriptive, not an image-delivery or action deadline. Newly acquired pixels remain usable evidence when older, including during emergency recovery, and the pilot receives their honest timestamp and age. The model can think and act while accepted local work continues. Missing/cancelled captures cannot supply cached substitutes; finite range sensors still expire independently for local physical control. See [camera-age qualification](CAMERA-AGE-POLICY-QA.md).

Profile `onboard/2` supports independently opt-in `acoustic/1`. This experiment adds dated, uncertain local impulse/possible-shot events with finite sensitivity, 343 m/s propagation, modeled obstruction, misses and ambient false positives. It supplies no bearing, distance, source/team/projectile identity or targeting intent. Its 32-source queue is finite; acquired measurements use the existing unread-event quota. An 8 KiB per-drone diagnostics/cache reservation and the sensor's code/transitive assets are charged. See [assumptions and attention gates](NERVELET-INTEGRATION.md). The noise claim applies only to this optional synthetic sensor, not existing idealized pose/range estimates.

Coordinates are local east/up/south XYZ, in simulation units; one unit equals ten meters. Heading is clockwise from north; measured camera pitch is separate from body attitude and reaches -90° downward. The 512×288 camera has vertical field of view 76° wide or 32° with zoom. These values are vehicle calibration; resource/base coordinates, world geometry and enemy telemetry remain private.

Local proximity uses 26 fixed axial/diagonal directions. Each has finite four-unit swept-sphere coverage with nominal radius 0.5. If that extra guard shell overlaps an obstruction while the airframe is clear, the measured footprint narrows toward the physical radius 0.38 and reports its actual radius. This preserves near-field coverage for retreat, including between beam directions. The controller certifies the integrated next step and remaining braking corridor, including retained momentum at low speed or during a replacement turn. Insufficient coverage holds the job with `coverage-unavailable`; this does not identify an obstacle. A separate downward pencil range covers 20 units. Readings expose distance, coverage and valid/out-of-range/unavailable state, no object or contact identity. Required coverage expires after 150 monotonic host milliseconds. The controller can brake/hold and mark blocked, but never selects another route. Finite coverage and actual physical braking do not guarantee collision avoidance.

Travel uses maximum speed 3 units/s and acceleration 6 units/s²; precision uses 0.8 and 3. Cargo reduces the speed limit by 20%. One movement writer owns a drone. A route contains 1–32 caller-chosen absolute waypoints and returns acceptance immediately. A waypoint finishes before the next starts. Healthy local execution renews a 500 ms monotonic-host-time controller lease; the model does not emit high-rate keep-alives. Failed execution, stale sensing, lost owner or lease expiry stop further motion requests.

Tool/job state distinguishes accepted, running, blocked, completed, cancelled and failed. Replacement is explicit. Stop/reset, destruction, received objective changes and invalid capabilities cancel affected work and revalidate after awaited adapter calls. Ordinary chat and radio partitions do not change objectives or invalidate otherwise healthy local jobs.

## Model batches and inbox ownership

**Current native path:** [Nervelet](NERVELET-INTEGRATION.md) wraps these boundaries. Echo `nervelet.id` in `seen`; effects also use `nervelet.nextCommandId` as `command_id`. Included events remain unread until that acknowledgement, with stable IDs for uncertain redelivery. `seen` also acknowledges only the result revisions included in that bundle. Original operation output lives in `nervelet.results[].data = {result, isError}`, including individual exchange outcomes and exact workspace-read content; it is not copied into current telemetry. Observing or retrying an identical unacknowledged command can recover it without replay. A resolved acknowledgement releases the payload and preserves bounded scalar deduplication. Received goals repeat exactly; native recovery gates new effects until an acknowledged recovery bundle. Conditional waits are bounded to 30 seconds; omitted `until` matches any unread retained event, while typed events keep their delivered-floor semantics. The direct `FleetGame.tool` fixture/SDK seam retains its original consumption behavior. This supersedes the older assembly-time consumption description below for native pilots.

`exchange({mission,operations})` admits up to eight compatible operations. Each entry is `{id,tool,args}` with a unique bounded ID; inner arguments inherit the received objective version. At most one movement writer is admitted. Each entry gets its own result, and a later rejection does not undo earlier side effects. Dependent actions belong in an ordered route or authored routine. Waits, files, routine execution, transfers and nested batches are not batch operations.

Admission is separate from movement completion, waits and camera encoding. Each direct call or aggregate batch receives one fresh camera/telemetry/inbox bundle. Model-facing `fleet-observation/5` encodes proximity as a column object. `directions:"xyz26"` represents all triples from [-1,0,1], ordered X then Y then Z, skipping [0,0,0], each normalized by `Math.hypot(x,y,z)`. The runtime briefing gives that exact codebook. Any nonstandard direction vector is sent explicitly without rounding. Each `distance`, `validity`, `radius` and `maxDistance` is a scalar when every beam has exactly that value, otherwise a full array in direction order. Unknown shapes or additional reading metadata remain in native named-object arrays. If the two fresh column objects are exactly equal, current telemetry uses `{sameAs:"sensors.ranges.proximity"}` within this bundle. Both acquisitions retain their own sequence, timestamp, origin, freshness and downward reading. No earlier bundle is reused. Internal telemetry and routine SDK objects keep their named fields; camera payloads are unchanged. Offline round trips of all 418 results from the prior battle preserve every field exactly while reducing sensor text by 36.9% and all result text by 25.3% versus schema 4. These byte savings do not prove live latency gains or eliminate compaction. The aggregate delivery cut drains the next unread event slice with a 128 KiB budget, including eligible mail arriving during capture. `hasMore:true` preserves remaining unread events; only included mail is consumed. Cancellation wakes pending waits and invalidates queued commands. Inputs reach models through tool results and supported next-turn input; private reasoning cannot be interrupted to inject mail.

Optional `observation_sequence` and `event_cursor` reference input actually delivered to that drone. Normal newer telemetry alone does not invalidate every slow decision. Mission/capability/owner state is checked at submission and execution. A transport receipt means stored, not read or understood; actual bundle delivery, an explicit reply and completed action are separate evidence.

## Private workspace and accounting

Each drone gets a private virtual application disk with the following fixed partition limits. This is a simulator storage abstraction, not a claim about the total hardware image.

| Partition | Limit | Charged content |
| --- | ---: | --- |
| Read-only runtime/SDK | 8 MiB | Deployed QuickJS/WASM, loader/glue, selected dependencies, SDK/runner assets, licenses and manifest. |
| Writable workspace | 2 MiB | Authored/imported bytes, names/metadata and source versions retained by active routines. |
| Durable radio | 4 MiB | Native SQLite mail payloads, receipts, deduplication, indexes and persistent delivery metadata. |
| Staging/transactions | 1 MiB | Transfers, atomic replacement copies, verification peaks and reserved native transaction space. |
| Logs/cache | 1 MiB | 512 KiB reserved for unread local events and 512 KiB for rotating diagnostics. Only diagnostics rotate. |

`workspace` offers `list/read/write/delete/stat`. Files are at most 64 KiB, with at most 256 files including retained source versions; relative names are capped at 128 UTF-8 bytes. Ordinary notes/modules are UTF-8 text. Byte limits count UTF-8 bytes rather than characters or tokens. There is no writable guest package manager. Optional guest libraries would share a combined 256 KiB ceiling; none is installed in this revision.

Writes preflight final workspace allocation and temporary staging peaks. Failure preserves the old file. Identical bytes may reuse an existing owned version; deleted/replaced source remains charged while a running snapshot retains it. A new match is empty. Destruction revokes access and cancels workers/transfers. Native turns preserve the current match's files. The virtual workspace is backed by bounded process memory, not an unbounded directory or a crash-recovery guarantee.

Nervelet reserves 384 KiB inside the existing diagnostics/cache half: 192 KiB for immutable original result payloads and 192 KiB for conservatively charged profiles, instructions, goals, scalar receipts, execution records, delivery mappings and control metadata. Histories are bounded to 16 receipts/execution records and eight delivery mappings so metadata fits that fixed reservation. Payload accounting charges UTF-16 data plus containers, property keys and slots; core and executor share one owned frozen result. It does not retain an extra JSON string or workspace version for a read. Overwrite/delete therefore cannot change an outstanding read result. Acknowledging the resolved revision releases both owners' payload references.

Encoded output has a separate bounded transient budget. A 64 KiB file containing 65,536 NUL characters expands to 393,216 bytes of JSON content before framing, so the 400 KiB command-input ceiling and maximum-size file support remain. Read-result storage and escaped delivery are reserved before dispatch; several large outstanding results can reject new admission with explicit backpressure until `seen` releases capacity. No new mutation executes if its result reservation cannot be guaranteed. [Reliability QA](RELIABILITY-QA.md) records maximum-result, aggregate-pressure and metadata evidence; fixed application partitions are unchanged.

Storage status exposes own use/free bytes and partition-specific errors. `logs.usedBytes` combines the current local-event backlog with rotating workspace diagnostics; it does not grant either half access to the other's reservation. Exhausting the unread local-event buffer stops the host explicitly and preserves the already admitted unread events. Ordinary workspace cleanup is agent-chosen; authored files or unread mail are not silently evicted. Native radio retains its separate 4 MiB quota, actual bounded SQLite backing-store limits, rollback-journal accounting and reserved control capacity; see [NETWORK.md](NETWORK.md). Shared staging reserves 256 KiB for native transactions. Platform/replay archives cannot be read to refill actor memory.

## QuickJS routines

A routine is a `.js` or `.mjs` workspace module with top-level `await`. `routine({mission,op:"start",path,input?,replace?})` snapshots its own source versions and returns a job ID promptly. `status` and `cancel` can select the retained job ID. Worker termination can briefly report `cleanupPending`; retry admission after cleanup rather than running two workers. Relative imports resolve only within the immutable own-workspace module snapshot. Global `input` contains caller JSON; global `drone` is the frozen SDK.

The SDK includes `telemetry()`, `camera()`, `act(args)`, `send(args)`, `buy(args)`, `fire(args)`, `rearm(args)`, `cameraMode(args)`, `events()`, `sleep(ms)` and `files.list/read/write/delete/stat/status`. Equipment calls have the same dynamic capability checks as direct tools. Camera reads use actual acquired pixels with acquisition metadata, never invented images or hidden geometry. Routine ticks do not force model-image encoding.

This neutral example saves the caller's own current sample:

```js
const sample = await drone.telemetry();
await drone.files.write("sample.json", JSON.stringify(sample));
```

This teaches syntax only. No scouting, hauling, targeting, role assignment or solved navigation routine is preloaded.

| Execution bound | Limit |
| --- | ---: |
| QuickJS heap | 32 MiB |
| Uninterrupted guest slice | 20 ms of worker-thread CPU |
| Rolling guest execution budget | 250 ms of worker-thread CPU per wall second |
| SDK calls | 64 per second |
| Pending SDK calls | 8 |
| Host operation deadline | 2 seconds |
| Worker heartbeat deadline | 750 ms |
| Routine total wall duration | 120 seconds |
| Guest sleep | 1–1000 ms per call |

The worker and host enforce independent request/response byte bounds, startup/heartbeat watchdogs and termination. Routines require Node 22.19+ (or 24+) for `process.threadCpuUsage`; CPU budgets measure worker execution rather than elapsed scheduling delay. Heartbeat, host-operation and whole-routine deadlines remain monotonic wall time. A failed/expired host operation cannot commit a stale action after cancellation. The worker is separate from the simulator's event loop. These are simulator resource bounds; they do not establish hard real-time or embedded-board performance.

## Package manifest

`npm run onboard:manifest` measures the selected deployed package and writes [ONBOARD-PACKAGE-MANIFEST.json](ONBOARD-PACKAGE-MANIFEST.json). Each artifact records path, package/version, license, SHA-256 and installed bytes; manifest metadata is charged too. The worker actually runs from the matching measured deployment under ignored `.runtime/onboard-application/`.

The deployed profile uses pinned `quickjs-emscripten-core` and `@jitl/quickjs-wasmfile-release-sync` 0.32.0, including their transitive runtime artifacts. The umbrella development package and debug/asyncify variants exceed the allowance when all are included, so the deployed application contains only the selected synchronous release profile. No OpenCV or optional vector library is supplied. Consult the manifest's current hashes/bytes; editing application sources requires regenerating it.

Host Node/Python/OS, the renderer, Zenoh/pymavlink vehicle/network bridges, developer tools and replay archives are fixed simulator infrastructure outside guest imports. Inference infrastructure is separately exempt. This boundary does not claim that a complete Python/OS hardware image fits 8 or 16 MiB. An optional host-backed drone library would need its actual implementation/dependencies charged, rather than a zero-cost SDK facade.

## Native peer transfers and player chat

`transfer` offers `offer/list/status/import/cancel`. An offer selects one actual teammate and an existing own UTF-8 Markdown/JSON/text/JS module of at most 64 KiB. The host sends announced bytes/path/hash and automatically bounded chunks of at most 4096 UTF-8 bytes through native low-priority mail. Senders cannot spoof identity or target opponents.

Receiver staging remains inert while incomplete and must match the advertised size/hash. A completion receipt means verified storage only. Import requires the recipient's explicit transfer ID and chosen destination path, workspace capacity and atomic replacement budget. Import does not run code. There is no shared team directory, archive/compression support, automatic import or automatic execution. Copies count on each recipient; cancelled/expired transfers release staging.

Blue drones can send ordinary chat to `player`, and the commander can send direct/group blue chat. Red cannot address the blue operator. Objective changes remain explicit and take effect only when actually received. Link partitions are implemented through native sessions, not a silent local delivery path.

## Evidence limits

Deterministic tests exercise quotas, Unicode byte counts, atomic failure, source retention, import identity, runaway code, slow host calls, stale jobs, partitions and real protocol storage. [RTS-PLAYTEST.md](RTS-PLAYTEST.md) records autonomous evidence and its tested source revisions. Camera and autonomy reports must record current source hashes separately. A working neutral routine or fixture haul is not proof that a fresh model can recognize a cache, deliver cargo or coordinate. Performance targets in the [execution refinement](ONBOARD-FEEDBACK-REFINEMENT.md) remain measurement targets until current timing evidence establishes them.
