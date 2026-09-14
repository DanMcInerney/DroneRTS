# Onboard feedback and execution: review of the Gemini brief

**For the new implementation chat, use [the complete handoff](DRONE-RTS-IMPLEMENTATION-HANDOFF.md).** It includes this execution design plus map graphics, readable road-intersection resources, central-depot contention, pickup/return logistics, equipment/service rules, coordination and replay. This document supplies the technical research and detailed feedback contract without duplicating those gameplay sections.

September 14, 2026. Research and proposed interface refinements for [the implementation handoff](DRONE-RTS-IMPLEMENTATION-HANDOFF.md). No gameplay code, sensor permissions, libraries or model settings were changed. Current `AGENTS.md` describes the active experiment; new sensors/calibration and tool semantics below belong to the proposed rules revision, not current actor inputs.

## Assessment

The brief's strongest recommendation is a continuously running deterministic companion service underneath the agent. Adopt that architecture. Its blanket footprint and frame-rate claims are not established, and its list of Python packages is not a minimal deployment specification.

There are three distinct execution layers: a flight controller handling continuous vehicle control; a companion service handling sensor ingestion, bounded local routines and communication; and an agent making slower decisions. A 10–30 Hz Python image loop is not a complete flight controller. In this game, the authoritative motion simulator stands in for the flight controller; do not claim full autopilot or hard real-time fidelity.

PX4 requires continuing offboard proof-of-life traffic and applies a configured failsafe when that traffic stops. MAVSDK's offboard plugin automatically resends setpoints at 20 Hz. The architectural lesson is to keep this work independent of model calls, not to require the model to emit 20 calls per second. [PX4 offboard](https://docs.px4.io/main/en/flight_modes/offboard), [MAVSDK offboard](https://mavsdk.mavlink.io/main/en/cpp/guide/offboard.html).

## Corrections to library and sensor claims

| Brief claim | Assessment and simulator decision |
| --- | --- |
| pymavlink has virtually zero memory footprint and is the lowest-overhead choice | It is a useful low-level Python protocol library, with an interpreter, generated dialects, buffers and supporting code. No zero-footprint or universal fastest-Python claim is supported. Keep the existing adapter; measure it before replacing it. Generated MAVLink C is a separate candidate for a later measured embedded deployment. [Python documentation](https://mavlink.io/en/mavgen_python/), [C documentation](https://mavlink.io/en/mavgen_c/). |
| mavsdk-python is just a slightly heavier alternative | Its high-level API is useful, but it also uses a C++ server and gRPC. Relative footprint depends on the build and dependencies. Borrow API semantics; defer adding another adapter until a compatible full autopilot endpoint is actually needed. [MAVSDK-Python](https://github.com/mavlink/MAVSDK-Python). |
| Headless OpenCV makes the complete stack fit in 100–150 MB | Headless removes GUI dependencies, not the whole vision library. As checked on this date, the published 5.0.0.93 Linux ARM64 wheels alone are 36.5/39.6 MB depending on platform tag; these are compressed distribution files, not installed totals, and exclude the rest of the environment. A full-stack ceiling requires a pinned deployment manifest and measurement. [Published package files](https://pypi.org/project/opencv-python-headless/). |
| Farneback or Lucas–Kanade runs at 20–30 FPS even on weak CPUs | Unsupported without board, resolution, algorithm parameters and concurrent-load measurements. Dense Farneback and sparse feature tracking are different workloads. Benchmark a bounded low-resolution candidate only if a task needs it. Optical flow is apparent image motion, not automatically metric depth or forward clearance. [OpenCV optical flow](https://docs.opencv.org/4.13.0/d4/dee/tutorial_optical_flow.html). |
| Optical flow supplies collision distance | Flow can support motion/approach estimates under assumptions. Rotation, scene motion, texture and image conditions matter; scale needs additional information. PX4's documented flow setup uses a downward camera plus a distance sensor for velocity estimation. Do not relabel flow as a reliable universal obstacle-distance sensor. [PX4 optical flow](https://docs.px4.io/main/en/sensor/optical_flow). |
| ArUco provides marker pose and distance | Useful when the marker is actually visible and the system knows its physical size and camera calibration. Detection is not guaranteed at every distance/angle. A printed base landing marker is a plausible later experiment; no invisible marker lookup or automatic resource locator. AprilTag's small C implementation is another candidate if marker processing alone is needed. Neither is installed by default. [ArUco pose estimation](https://docs.opencv.org/4.13.0/d5/dae/tutorial_aruco_detection.html), [AprilTag](https://github.com/AprilRobotics/apriltag). |
| INT8 models guarantee cheap inference | Specialized runtimes can reduce deployment overhead, but model weights, buffers, operator support and target hardware still matter. ONNX Runtime explicitly notes that quantization can fail to improve speed or make older devices slower. Do not exempt optional vision networks under the language-model hardware exemption. [ONNX quantization](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html). |
| SciPy/Shapely/skspatial make a lightweight collision stack | They are optional algorithms with transitive dependencies, not free sensing. Our small vector SDK is enough initially. Shapely is planar and ignores the third coordinate in geometric analysis. A KD-tree of observed points is not complete obstacle geometry; unsampled space is not proven clear. Never populate an agent's map from authoritative hidden building boxes. [Shapely manual](https://shapely.readthedocs.io/en/stable/manual.html). |
| An emergency-brake tool instantly makes the vehicle safe | It can request prompt braking, but stopping has physical dynamics, and real hold modes require appropriate estimates. A single forward range beam does not prove the entire vehicle's swept path is clear. Specify finite sensing coverage, braking behavior and invalid-estimate behavior; do not promise instantaneous hover or collision immunity. |

The previous 16 MiB application quota is an intentional bounded programming profile, not the total storage capacity of a cheap companion computer. For comparison, Raspberry Pi specifies 512 MB RAM and a microSD slot for Zero 2 W. Small hardware does not imply tiny total disk. Keep authored files and imports small, but evaluate the fixed software image separately using installed bytes, RAM, CPU, startup time and deadline behavior. Do not claim a bill of materials or board performance from the simulator host's measurements. [Raspberry Pi Zero 2 W](https://www.raspberrypi.com/products/raspberry-pi-zero-2-w/).

## What the current code already does

- `server/index.ts` advances the game with a 50 ms timer: a nominal 20 Hz host loop, with simulation substeps in `server/game.ts`. Browser disconnect still pauses the experiment. This is not a hard real-time scheduler.
- `server/game.ts` serializes each drone's entire model tool boundary through `toolTurns`. Commands execute before the post-call sensor bundle is constructed. `act` starts asynchronous movement; returning from it does not mean arrival.
- `completeTool` / `withObservation` return acquired camera/telemetry and drain unread events after capture, including mail arriving during capture. That is already the basic automatic delivery behavior the user proposed.
- `runtime-tools.ts` instructs actors to use one tool at a time. There is no command batch or authored routine runtime yet. A waiting or slow capture operation can occupy that drone's serialized tool boundary; it does not stop the other drones' physics.
- `runtime.ts` can resume completed actor turns and refresh catalogs. A reasoning-item completion notification is not an API boundary at which arbitrary new observations are guaranteed to enter ongoing inference. Preserve that distinction.

## Proposed execution contract

### A. Continuous local services

Sensor acquisition, the controller, radio reception and a permitted active routine continue while the model is thinking. Separate their scheduling and budgets from inference, graphics encoding, logging and file transfer. A camera failure must not silently become a fabricated frame. Under a future revised sensor policy, fast controller responses may report camera unavailability explicitly; until that revision lands, preserve the current fresh-camera boundary.

Keep a latest-value own-telemetry slot and a small bounded camera ring in RAM. Keep durable discrete messages/events separately. Avoid writing every telemetry tick to SQLite. Bound history and every queue; under load replace obsolete telemetry and frames instead of building an increasingly delayed video feed. Preserve unread discrete events according to the storage policy. Any diagnostic host archive remains inaccessible to actors.

Use a single authoritative simulation/controller schedule. If targeting 50 Hz local control, move the relevant physics/sensing work consistently; emitting 50 copies of a 20 Hz state is not higher-rate sensing. Measure timing under all six drones, camera rendering and script-transfer load before changing rates. Keep simulation-time and wall-time semantics explicit.

### B. Batched submission with explicit results

Provide a small application-level `exchange`/batch tool, initially capped at eight operations, returning one fresh aggregate observation/inbox bundle. This is an SDK feature and does not require a provider to support JSON-RPC batching or parallel function calls.

A batch may submit one movement/route job, a compatible camera request and a radio send without an intervening inference round trip. Admission is quick; long movement runs as a job. Reject competing movement writers. Preserve one operation ID/result per entry: accepted/rejected/queued is distinct from physical completion. A radio send cannot undo an already accepted movement if it later fails. Do not advertise distributed all-or-nothing execution. Validate before admission, then revalidate asynchronous side effects at execution.

Dependent actions must be encoded as an explicitly ordered job or routine, not as a set of concurrent calls. Keep ordinary direct tools available. Serialize authoritative mutations briefly; do not hold the control-admission lock across a long `wait`, image encoding, radio receipt wait or file transfer. A cancellation/local stop path must be able to wake a wait and invalidate queued work without waiting for its timeout. Return an explicit cancellation result rather than losing the waiting tool response. The agent still cannot issue a new call during private thinking unless its backend has reached a supported boundary.

For batches, deliver inbox events once with an aggregate cursor after the admitted operations, rather than draining the same inbox independently for each parallel operation. For independent concurrent read interfaces, define cursor ownership explicitly; do not silently consume an event that never appears in model context.

### C. Feedback at every supported agent boundary

After a tool or aggregate batch, attach current own telemetry, new discrete events, actual received mail, job state, storage/capability changes and timestamped camera evidence. At an idle/finished-turn boundary, the scheduler may start the next inference step with a fresh bundle when there is work to deliver. `wait` should return on a relevant event or timeout, without busy polling.

Do not claim automatic mid-thought input insertion. A model finishing a reasoning item is not necessarily yielding control to the application. Each backend must expose and test its actual input boundaries; use tool results and supported next-turn input as the portable baseline. Transport notifications alone do not prove model consumption. All messages preserve queued/stored/bundled/answered/completed distinctions.

Latest telemetry is a snapshot, not a transcript of every high-rate sample. Images keep their capture-time pose and age; newer live pose is separately labeled. An optional future fast-response mode can attach the newest frame within a specified age budget instead of forcing a new render for every trivial action, but that changes the current per-tool fresh-camera contract and must be versioned and tested. Start by preserving one newly acquired image per model batch; internal routine ticks need no model image encoding.

### D. Guard against decisions based on old observations

Each command identifies its mission version, originating snapshot/event cursor and current control-owner token. On admission and actual execution, check that the drone is alive, the mission/capability/owner are valid and required local sensing is usable. Critical invalidation during thinking returns a specific rejection and fresh evidence. Normal new telemetry alone must not invalidate every slow model decision; waypoints can remain meaningful across many sensor updates.

Local assist evaluates the latest permitted range observations continuously. A routine rechecks its own conditions during execution. A raw velocity request has a finite command lease and bounded duration; do not keep repeating the last nonzero vector forever because the model stopped responding. The local routine/controller renews permitted setpoints while healthy; the model does not have to renew a subsecond lease itself. A bounded waypoint job may continue independently until complete/blocked/cancelled. On routine failure, stale required sensors or lost control-owner lease, stop issuing motion and apply the documented physical braking/hold behavior.

The controller can reject or stop locally invalid motion; it must not silently choose an alternative tactical destination. Radio loss alone does not cancel valid local work. Ordinary peer/player chat does not replace a mission; an explicit new objective takes effect when received by that drone.

### E. Avoid sensor and capability inflation

`get_forward_clearance` is only legitimate as a reading from explicitly modeled finite-range hardware or a labeled estimate computed from that drone's actual images. It must include coverage, acquisition time and validity. It cannot query the nearest hidden object in any direction. Navigation libraries may operate on an agent's own observed/estimated geometry, never a privileged world map. Keep any marker or image-processing helper within the declared package/CPU budget and operate on acquired pixels.

## Performance targets to measure, not advertise as achieved

Start at fixed 1x simulation speed. The following are proposed simulator engineering targets; they do not assert Raspberry Pi performance or hard real-time guarantees.

| Path | Initial target or experiment |
| --- | --- |
| Authoritative local control / proximity reactions | Evaluate 50 Hz after profiling the current nominal 20 Hz loop; measure deadline misses and physical stopping outcomes |
| Own structured telemetry | 20–50 Hz to local routines, bounded latest-value storage, model snapshots at supported boundaries |
| Optional continuous local vision | Benchmark 10–15 FPS at a declared resolution only when a routine needs a stream; no promise that dense flow fits this budget |
| Command admission to first controller application | p95 below 100 ms, excluding model thinking but including local queueing and native adapter work |
| Structured telemetry age at application/tool delivery | p95 below 100 ms under the declared sensing profile |
| Model-facing acquired camera age at delivery | p95 below 250 ms; report stale/unavailable frames and queueing honestly |
| Local event to availability in the agent inbox | Within one service iteration; actual model reading still waits for an input boundary |

Record p50/p95/p99 and failures, not only averages. Separate sensor capture, native telemetry decode, image encoding, admission wait, controller application, network receipt, model availability, model decision time and physical completion. A higher nominal frame rate with older delivered frames is worse feedback. Actual dropped/expired samples and deadline misses belong in reports.

Meaningful fixtures: a several-second fake thinking delay while a routine continues and brakes for a newly sensed obstruction; mail arriving during thinking appears at the next supported boundary; a batch admits compatible operations with partial failure represented honestly; a pending wait/camera transfer cannot block cancellation; expired velocity ownership cannot coast indefinitely; radio partitions leave local control working; full mail/code queues do not starve the controller. These deterministic fixtures need no model inference. They complement, rather than replace, the handoff's autonomy trials.

## Stack decision

Keep the current Zenoh/pymavlink integration and add the narrow QuickJS SDK, local jobs and bounded state/event buffers. Measure before adding numerical/vision frameworks. For a later physical software-image experiment, native MAVLink C and native QuickJS are plausible small components to benchmark against the Python/WASM simulator adapters; do not rewrite the current stack merely on an unmeasured footprint claim. PX4/SITL would be a separate fidelity milestone with its own compatible adapter, not a prerequisite for fixing model feedback latency.

The immediate improvement is coherent continuous control and efficient agent boundaries. The commander remains simple blue chat, and the cargo/graphics design remains unchanged.
