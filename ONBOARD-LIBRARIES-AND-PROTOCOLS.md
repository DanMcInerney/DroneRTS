# Onboard agents: library research and protocol design

**Implementation entry point:** [the consolidated handoff](DRONE-RTS-IMPLEMENTATION-HANDOFF.md) incorporates this research and adds concrete per-drone storage budgets, measured built-in package accounting and an interchangeable simulated onboard-agent boundary. Its latest decisions govern implementation; this addendum preserves the supporting research.

September 14, 2026. Addendum to `DRONE-RTS-NEXT-SESSION-PLAN.md`; its cargo economy, graphics, equipment and staged implementation remain the proposed design. This document refines the onboard architecture and messaging. The player commander is deliberately just a team chat participant, not a new command-system project. Research and documentation only: no packages installed or gameplay implementation changed.

## Realism assessment

**8/10 for the proposed architecture; approximately 4/10 for the current simulator's fidelity.** These are engineering judgments, not measured benchmarks or claims of field-proven autonomous behavior. Assume sufficient local inference compute, as requested. That assumption does not make model decisions instantaneous or infallible.

An onboard application making high-level decisions, reading sensors, running routines and exchanging peer messages is a plausible companion-computer architecture. A separate flight controller should handle continuous stabilization and execution. PX4 documents that division between companion computer and flight controller. [PX4 companion computers](https://docs.px4.io/main/en/companion_computer/).

What currently supports realism: distinct drone actors, actual native peer traffic, durable mail, real MAVLink packet parsing, independent movement between model calls, and private acquired camera images. What limits it: idealized sparse telemetry, no real attitude dynamics, a custom controller rather than an autopilot, loopback links without ordinary radio constraints, and tool decisions spaced seconds apart. The current runtime also hosts model sessions centrally; onboard inference is the simulation's intended abstraction, not its present deployment topology.

The goal is convincing behavior at these boundaries, not copying every aircraft subsystem. Keep the current game-scale physics and simplified weapons while improving the interface and failure semantics.

## The minimal architecture

```text
Each simulated drone
  local agent + private notes / authored libraries
                   |
          role-bound tool interface
                   |
         local vehicle SDK / job runner
          |                     |
  own sensor stream       radio API
  control requests            |
          |               Zenoh peer <--> teammates
  MAVLink adapter                      <--> player chat (blue team)
          |
  continuous flight controller
          |
  authoritative game physics
```

The tool interface is local to the simulated onboard computer. Peer radio carries messages between computers. MAVLink carries the vehicle adapter's control/telemetry exchanges. These are three separate responsibilities; raw sensor acquisition and flight execution do not depend on the team radio being connected.

Sensors are **read-only** to the actor. The actor writes control requests such as waypoints or camera commands, not its own reported position, battery, collision state or opponent state. Simulator authority and role checks remain in force for scripts as well as direct tool calls.

## Open-source shortlist

| Library | Where it belongs | Recommendation and limits |
| --- | --- | --- |
| **Eclipse Zenoh / zenoh-python** | Host radio bridge representing each drone's network peer | Keep the existing implementation. Native pub/sub and peer deployment fit the model. Zenoh is messaging middleware over a network, not a simulated RF channel or proof of physical mesh routing. Upstream uses EPL-2.0 / Apache-2.0 licensing. [Deployment](https://zenoh.io/docs/getting-started/deployment/), [Python project/license](https://github.com/eclipse-zenoh/zenoh-python/blob/main/LICENSE). |
| **quickjs-emscripten / QuickJS** | Private onboard script runtime | Add one runtime per drone, not merely several contexts sharing one runtime. Provides explicit host bindings, memory/stack controls and interruption. The wrapper and engine are MIT licensed. Use the packaged WASM build as the first Windows candidate; verify it locally. Host calls and buffers require their own limits. [Project and embedding API](https://github.com/justjake/quickjs-emscripten), [wrapper license](https://github.com/justjake/quickjs-emscripten/blob/main/LICENSE), [engine license](https://bellard.org/quickjs/quickjs.html#License). |
| **gl-matrix** | Allowlisted JavaScript library inside each guest | Optional small vector/matrix/quaternion toolkit for calculations over permitted observations. MIT licensed. Bundle one pinned API version; no arbitrary npm imports. It supplies math, not an inferred map or navigation policy. Run a guest compatibility smoke test. [Project](https://github.com/toji/gl-matrix), [license](https://github.com/toji/gl-matrix/blob/master/LICENSE.md). |
| **OpenCV.js** | Optional separately bounded image-processing worker, callable through the local SDK | Later, expose selected pixel operations over the drone's acquired frames: resize, masks, contours and similar building blocks. Standard OpenCV.js relies on WebAssembly and is not a drop-in stock QuickJS guest module. Use raw pixel buffers rather than DOM helpers; bound allocations and release Mats. OpenCV 4.5+ uses Apache-2.0. [Image processing](https://docs.opencv.org/4.13.0/d2/df0/tutorial_js_table_of_contents_imgproc.html), [build](https://docs.opencv.org/4.13.0/d4/da1/tutorial_js_setup.html), [Node usage](https://docs.opencv.org/4.13.0/dc/de6/tutorial_js_nodejs.html), [license](https://opencv.org/license/). |
| **pymavlink** | Existing Python vehicle adapter, outside the guest | Keep it. The repository pins `pymavlink==2.4.49`; the latest trial exercised the native bridge. It is a protocol library, not a flight controller. Upstream states LGPL-3.0-or-later for the library and MIT for generated code. [Project/license](https://github.com/ArduPilot/pymavlink#license). |
| **MAVSDK / MAVSDK-Python** | Possible future adapter for a full flight-stack simulation | Useful reference for telemetry and mission API shape, but do not add it alongside pymavlink just for the scratchpad. The Python wrapper uses gRPC and a C++ `mavsdk_server`; both stay outside the JS guest. BSD-3-Clause. Reassess when connecting a compatible SITL endpoint, since the current small MAVLink profile is not a drop-in full autopilot. [Python architecture](https://github.com/mavlink/MAVSDK-Python), [license](https://github.com/mavlink/MAVSDK-Python/blob/main/LICENSE.txt), [missions](https://mavsdk.mavlink.io/main/en/cpp/guide/missions.html). |

Thus the first addition is **QuickJS, optionally gl-matrix**, behind a tiny SDK. Keep Zenoh, pymavlink and the current durable store. Defer OpenCV until actual pixel-processing needs justify it. No ROS 2, replacement messaging framework, or full flight-stack migration is required for this iteration. Upstream documentation is not evidence that these new packages have been installed or tested in this checkout; pin selected versions and verify their compatibility during implementation.

## Local sensors and control

Use a continuously updated local state estimate for the job runner. The model gets a fresh snapshot when it calls tools; it does not need to read every controller tick. Coalesce high-rate state updates while preserving discrete events such as blocked motion, cargo loaded, armor loss and job completion. Include acquisition time, frame/units, sequence, validity and age; an old camera frame must not be paired with an unlabeled newer pose.

Expose the own-state fields in the main plan: position/velocity, heading, measured camera orientation, finite local ranges, charge, cargo and job state. Explicitly model newly added sensors. No hidden resource coordinates or class labels arrive merely because a distance measurement hits something. Supply calibration for the onboard equipment, not scene geometry. MAVSDK's telemetry interface includes position/velocity, attitude and health, which supports this direction. [Telemetry](https://mavsdk.mavlink.io/main/en/cpp/guide/telemetry.html).

The model submits a bounded routine or route; a local controller executes it independently of model latency. Separate accepted, running, completed, blocked, cancelled and failed outcomes. The MAVLink command protocol likewise distinguishes acceptance from physical completion. Its command acknowledgements do not imply that every setpoint message has an ACK. Keep the current setpoint echo documented as this simulator's adapter behavior. [MAVLink command protocol](https://mavlink.io/en/services/command.html).

Keep one movement writer per drone. Both direct commands and scripts go through the same validation, movement limits and lifecycle cancellation. Camera and radio may run concurrently with a route. Each action carries a stable application command ID and the drone's actually received mission version; retries must not repeat purchases, cargo deposits or other side effects. Those fields belong in the application/job layer, not invented MAVLink fields.

Local link health and peer-radio health are distinct. Loss of peer radio leaves the onboard agent, camera and current permitted local job running. Loss of the local controller connection, a stopped job or invalid sensor data triggers the documented local hold/failure behavior. The adapter, not the language model, handles any recurring controller keep-alive traffic. PX4's offboard mode illustrates that continuous interface requirement; it does not require an LLM decision for each update. [PX4 offboard](https://docs.px4.io/main/en/flight_modes/offboard), [MAVLink heartbeat](https://mavlink.io/en/services/heartbeat.html).

## Peer messaging: small, explicit and durable where needed

Keep one isolated network per team, with three drone peers and its existing operator bridge. The player's ordinary chat connects only to blue; red retains its automatic initial-objective bridge and independent actors. The existing operator is already a native peer but subscribes only to ACKs and is restricted to mission broadcasts. Add group/direct reply subscription and receiving callbacks to the blue operator so the player can participate in blue's conversation. No commander hierarchy, voting subsystem, separate dashboard overhaul or central strategy service is needed. A normal player message is ordinary mail; only an explicitly replaced objective should advance the mission version and cancel old work.

Keep the existing sender-bound IDs, per-recipient queues, native transport and deduplication. Extend the message envelope only where missing: protocol version, match/network identity, sender boot identity and sequence, message ID, recipient(s), kind, sent time/expiry, optional reply-to or plan revision, and text/data. A namespace alone is not cryptographic authentication; the local simulator's bound identities should not be described as hardened radio security.

Use three delivery policies:

| Traffic | Behavior |
| --- | --- |
| Chat, instructions and explicit coordination replies | Bounded durable queue, retry with backoff/jitter, recipient receipts, expiry and deduplication. Preserve message IDs across retry. Disconnected recipients do not prevent reachable recipients receiving a broadcast. |
| Agent-selected own-state/status updates | Latest value, short lifetime, old samples replaced rather than replayed after reconnection. Sequence and sample age prevent stale positions becoming current facts. Broadcasting own state is an available agent-authored routine, not automatic sharing of every observation. |
| Shared scripts or larger notes | Bounded lower-priority transfer with chunks, content hash, completion acknowledgement and recipient-controlled import/execution. Transfer only through actual radio. It must not block small messages or controller execution. |

Start with existing JSON payloads and a few optional metadata fields. Do not introduce protobuf, a distributed database or a team consensus algorithm to support three drones. Shared plans remain authored by the drones. A reply may reference the proposal ID so agreement refers to the same version, without prescribing what that proposal should say.

Distinguish four observable milestones: **queued locally; stored by recipient; included in an agent tool bundle; explicitly answered or acted on**. A transport receipt does not prove model comprehension, agreement or task completion. Exactly-once network delivery is not the promise: duplicate transport deliveries can occur, and local deduplication/idempotent effects handle them. Preserve durable unread mail across routine execution and tool-catalog refreshes.

Do not use a single stale-data lifetime for everything. A moving drone's position becomes old much sooner than a code file or a mission. Show age rather than converting expired reports into authoritative state. Record wall time and simulation time separately; define the clock used for TTL and sensor age, and keep first protocol trials at fixed 1× speed without pause until speed/pause semantics are tested.

## How much network simulation is enough?

For the first implementation, keep the real four-peer Zenoh setup and test bounded delay, disconnection and reconnection. Extend ordinary link constraints only after collection and local scripting work. A real P2P messaging library does not make a loopback full mesh a wireless model. Zenoh documents direct peer deployment and separately routed deployment; do not assume an intermediate peer automatically relays every disconnected pair. [Zenoh deployment](https://zenoh.io/docs/getting-started/deployment/).

When adding radio conditions, use a single owned network-emulation layer with controlled endpoints. Start with repeatable connection availability, latency and bandwidth limits. Its internal geometry model may determine link conditions, but actors see only their own received traffic and local link status. All allowed traffic must traverse it; no direct localhost path may bypass a simulated cut.

Apply faults before application receipt/ACK. Delaying or suppressing a message after the receiver has already acknowledged it produces false delivery semantics. With TCP, do not drop arbitrary byte fragments from a stream to imitate wireless packet loss; use controlled delay/bandwidth/disconnect behavior. True packet-loss or multi-hop IP experiments need a corresponding lower-level emulator or explicitly designed routing layer and are deferred. Label application-level fault fixtures honestly.

Once that lower layer exists, relaying and better line of sight can provide additional natural coordination benefits. Do not promise those mechanics from the present whole-peer partition switch. No RF frequency, antenna or detailed propagation model is necessary for this game phase.

## Runtime and protocol checks for the next session

1. Add QuickJS behind the current per-drone role boundary. Test one guest reading its own sensor snapshot, writing a note and completing a neutral bounded route. It must not read another drone's memory or host state.
2. Enforce separate guest and host-operation budgets. QuickJS interruption/memory limits do not bound a slow native callback, image processor, pending Promise queue, radio backlog or leaked host handle. Use a worker/process boundary that can be terminated, explicit handle disposal and controlled Promise scheduling. No filesystem/network/package loader in the guest.
3. Preserve fresh model-facing sensor/mail bundles. The script SDK may use high-rate structured own telemetry without forcing full camera capture for every internal operation; actual image requests still return acquired pixels and provenance. Log routine version and executed SDK calls for replay.
4. Give the blue player endpoint ordinary send/receive support and stop there. Test player-to-blue and blue-to-player delivery, including a disconnected recipient, and verify that ordinary player chat cannot read or message red. Keep red's automatic initial objective. Global app Stop remains host lifecycle cleanup, not a claimed radio transmission.
5. Test duplicate/reordered/expired messages, interrupted script transfer, stale status coalescing, and radio partition while local flight continues. Receipt state must accurately show which recipients have stored a message.
6. Test command retries and cancellation after Stop, death and a newly received objective. No old queued purchase, delivery or action executes afterward. A failed local controller connection must not be mistaken for peer-radio loss.
7. Verify selected dependency versions, licenses and Windows runtime compatibility before adoption. Run focused tests/build for implementation changes; no additional live match is needed merely to validate these research notes.

The rest of the main plan remains unchanged: readable physical depots, finite salvage carried home, shared income, flexible equipment and roles, local obstacle assistance, and staged discovery/haul/team trials before another full competitive battle.
