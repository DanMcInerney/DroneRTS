# Drone communication plan

This document records the original architecture recommendation. **The local Zenoh and MAVLink integration is now implemented; see [NETWORK.md](NETWORK.md) for the current contract, tested behavior and remaining limits.** A real radio mesh and hardware autopilot integration remain future work. The remainder preserves the original proposal and should not be read as current implementation status. Primary documentation was checked on 2026-09-13.

## What the PoC actually represents

The runtime launches exactly three real drone subagents, each using `gpt-5.6-luna` with `xhigh` reasoning. A separate parent relays the player's instruction verbatim. Each drone has an identity-bound MCP endpoint and its own inbox, but all message delivery occurs in one Node process. Group sends copy a packet into the other two inboxes; individual sends select one. This demonstrates independent agent decisions and asynchronous mail, not independent network nodes. See [runtime configuration](server/runtime.ts), [tool contract](server/runtime-tools.ts), [game transport](server/game.ts) and [mailbox](server/mailbox.ts).

The simulator provides local XYZ coordinates, not GPS. Its world state belongs to the simulator and player interface; drones must learn about the world through their own camera and explicit peer reports. The communication layer must not distribute hidden targets, bounds, scoring rules, a shared map, or inferred teammate state.

## Three separate layers

| Layer | Responsibility | Proposed implementation |
| --- | --- | --- |
| Radio and mesh | Carry packets between reachable devices, including through intermediate radio nodes. | Begin on ordinary Wi-Fi LAN. Later use a tested IP-capable mesh; Linux batman-adv is one option. |
| Drone messages | Route group and individual publications into each drone's local inbox. | A small native Rust bridge using the Zenoh crate in `peer` mode on each companion computer. |
| Vehicle control | Read local position/heading and execute motion continuously. | A local controller adapter communicating with the flight controller over MAVLink; the LLM issues bounded goals. |

batman-adv forwards at layer 2 and exposes a virtual Ethernet interface, allowing higher protocols to operate above it. Zenoh does not configure radios or replace that forwarding. [Linux kernel documentation](https://docs.kernel.org/networking/batman-adv.html)

Zenoh peers discover and connect to each other; explicit peer endpoints can bootstrap connectivity when multicast is unavailable. Configure all three known endpoints for this small fleet. Application peer connections must have end-to-end IP reachability, even if the mesh carries them over several radio hops. Peer mode does not mean an otherwise unreachable peer will automatically be relayed by another application's peer session. Zenoh's application routing mode is a separate option for a later topology. [Zenoh deployment documentation](https://zenoh.io/docs/getting-started/deployment/)

The resulting path is `LLM ↔ local MCP bridge ↔ Zenoh/TCP ↔ mesh IP ↔ peer bridge ↔ peer LLM`. The operator can publish mission instructions as an additional endpoint; it need not broker drone-to-drone traffic or assign tasks. Hosted model inference still needs its own connectivity; mesh connectivity alone does not make the model run offline.

## Group and individual messages

Use these proposed key expressions, with a configured fleet ID and stable drone identities:

| Key | Subscribers |
| --- | --- |
| `fleet/<fleet>/group` | All three drone bridges; suppress the sender's own copy. |
| `fleet/<fleet>/direct/<drone>` | The named drone bridge. |
| `fleet/<fleet>/ack/<drone>` | The original sender's bridge. |

Start with JSON and short text packets over TCP. Keep camera frames local to their drone's sensor bundle by default; sending an observation to a teammate is an explicit message. A topic name selects recipients; it is not an authorization mechanism. Provision peer identities and bind each bridge's sender identity rather than accepting a model-supplied `from`.

The PoC now versions its local radio object as `fleet-radio/1`, with session UUID, unique ID, sequence, sender, destination, kind, mission, UTC `sentAt` and `simTime`. The network envelope below extends that contract with fleet identity, sender boot identity and expiry; it is proposed, not a claimed interoperable implementation:

```json
{
  "version": 1,
  "fleet": "demo",
  "missionEpoch": "operator-session-uuid:17",
  "id": "message-uuid",
  "from": "drone-1",
  "bootId": "sender-process-uuid",
  "seq": 42,
  "to": "all",
  "kind": "chat",
  "sentAtUtc": "2026-09-13T18:00:00.000Z",
  "expiresAtUtc": "2026-09-13T18:00:30.000Z",
  "text": "I will inspect the object ahead."
}
```

`to` may instead name one drone. The bridge assigns IDs, sender identity, timestamps and monotonically increasing sequence numbers; retries preserve the original envelope. Scope sequence numbers to `(from, bootId, destination channel)`. Directed traffic on another channel then does not look like a missing group message. A restart gets a new `bootId`; a new operator session cannot accidentally reuse an old mission epoch. The authenticated mission source advances the epoch; peer claims cannot advance it.

## Reception while the model thinks

Each bridge runs an independent subscriber loop. It validates packets, deduplicates them and queues incoming mail immediately, even while its LLM is reasoning or a movement is underway. A waiting `wait` call wakes on new mail. Otherwise the next tool result carries queued messages. This does not require another LLM or a planning coordinator.

Every drone tool result should carry one common bundle: its tool outcome, pending inbox messages, and a newly acquired local sensor snapshot. Apply the same wrapper to `observe`, `act`, `send`, `wait`, and recoverable errors. The sensor allowlist is **position, HDG, acquisition timestamp and camera**. Action acknowledgements and inbox receipts are separate tool metadata. Do not add tilt, pitch, roll, velocity or world knowledge as sensors.

In the implemented simulator bundle, position is identified as `local`; heading is a local compass reading, not a geographic bearing. The controller's world-axis mapping, scale and camera geometry are withheld from agents for the user's exploration experiment. Acquisition UTC (`capturedAt`) and `simTime` describe the snapshot used to render the image, including the peer poses visible in it. Image encoding or response time does not replace acquisition time. If capture fails, the camera is unavailable rather than an old frame relabeled as fresh. Real telemetry and camera acquisition may differ in time, so a hardware adapter must retain their individual acquisition times and report excessive skew. Real GPS has defined coordinates and units: knowing its documented format is normal on hardware, while hidden maps, target positions and predicted images remain excluded.

Sensors and messages need different retention rules. A latest-value sensor slot may replace an older sample. An unread message must remain queued until delivered, explicitly expired, or rejected with a visible reason. Sensor refresh must never clear inbox mail. Avoid silent oldest-message eviction when an inbox fills: use bounded durable storage and explicit overflow/backpressure. Retention and queue limits are application policy, not model decisions.

Tool-result delivery is a boundary, not mid-thought interruption. A message arriving during reasoning cannot change the arguments of a tool call already issued. The bridge must reject obsolete mission actions before executing them, and the model must reassess new peer messages when it resumes. A radio acknowledgement confirms bridge receipt; it does not prove the model understood or acted on the message.

The PoC refreshes a snapshot once if its own action completes or the mission changes during image encoding. It timestamps controller events and delivery separately from acquisition, and retains the command's mission in its receipt. This addresses an observed live-trial timing edge case without pretending all mesh messages and sensor samples share a global instantaneous state.

## Partitions and recovery

The following are proposed application rules, not guarantees supplied by a `send` call:

- Persist outgoing packets until every intended recipient has acknowledged receipt or the packet expires. Snapshot the recipient set at send time; group completion means both teammates acknowledged.
- A receiver acknowledges only after durable inbox acceptance. Retransmitted duplicates receive another acknowledgement without a second inbox insertion. Keep deduplication state through the packet's retry lifetime, including restarts.
- Retry unacknowledged messages with bounded backoff and jitter. Report `queued`, `received`, `expired` or `rejected` per recipient; a successful publish alone means only local transport acceptance.
- Validate mission epochs and expiry before accepting a packet and again before acting on it. Discard obsolete actions and claims after a mission replacement. Use monotonic local time for retry timers; remote UTC expiry requires measured clock synchronization. If age cannot be established, request reconfirmation before treating stale coordination as current.
- During a partition, keep local sensing and control running and mark peer knowledge stale. Recovery exchanges current mission and acknowledgement state, then retries only valid pending packets. Do not replay old camera frames as current observations or unacknowledged old movement as a new command.

TCP is a useful transport baseline, but it is not durable inbox delivery across a process restart or long partition. The current Zenoh Rust API explicitly says its `reliability` setting alone does not cause wire retransmission. [PublisherBuilder documentation](https://docs.rs/zenoh/latest/zenoh/pubsub/struct.PublisherBuilder.html#method.reliability) Zenoh Advanced Pub/Sub offers sample sequencing, caching and recovery, including heartbeat-assisted loss detection; it can replace some retry mechanics later, but application receipt, expiry and mission semantics still need an owner. [Zenoh Advanced Pub/Sub announcement](https://zenoh.io/blog/2025-04-14-zenoh-gozuryu/#advanced-pubsub-heartbeat)

There is no automatic global truth or leader. Each agent has its own observations and messages received so far. Claims and conflict rules are agent agreements. A deterministic tie-break can reconcile competing claims once messages arrive; it cannot guarantee exclusive ownership while peers are partitioned. Require explicit peer confirmation before work that depends on exclusivity, or tolerate duplicate work in that mission.

## Connection to a real flight controller

Keep MAVLink at the local vehicle boundary. `LOCAL_POSITION_NED` uses north/east/down coordinates; `GLOBAL_POSITION_INT` provides global position and a heading field. A real adapter must declare origins, units and heading reference and convert frames explicitly. Simulator XYZ cannot be renamed GPS, and separate local estimator origins cannot be assumed equal. The model-facing allowlist can remain narrow even when the controller internally consumes more telemetry. [MAVLink common messages](https://mavlink.io/en/messages/common.html#LOCAL_POSITION_NED)

A deterministic controller must maintain setpoints independently of model latency. PX4 Offboard requires a continuous proof-of-life stream and invokes its configured offboard-loss response when that stream stops. Therefore an LLM tool loop must not itself be the flight-control timing loop. [PX4 Offboard documentation](https://docs.px4.io/main/en/flight_modes/offboard)

## Practical next increments

1. **Simulator contract (implemented):** automatic sensor/inbox bundles on every drone tool result; acquisition timestamps; sensor allowlist; mission rejection; no hidden world hints. Versioning the local radio envelope adds neither networking nor persistence.
2. **Three-process network trial:** replace direct inbox insertion with three independent native Zenoh bridges on one LAN. Prove directed delivery, group receipt, reception during model thinking, and continued delivery with the operator endpoint disconnected. Keep simulator sensing initially.
3. **Fault trial:** drop a recipient, duplicate/reorder packets, restart a bridge, overflow a queue, and replace a mission while disconnected. Verify preserved unread mail, duplicate suppression, visible expiry and rejection of stale actions. Then repeat on the actual mesh, including an intermediate radio node failure.
4. **Vehicle integration:** add the explicit MAVLink frame adapter and local controller, then validate sensor timing and controller behavior separately from mission reasoning.

These are proposed validation steps. This document records source inspection and architecture reasoning; it does not claim a mesh, packet-loss, or hardware flight trial occurred.
