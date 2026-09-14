# MAVLink bridge scope

The live RTS starts one local Python helper containing six simulated vehicle/controller endpoint pairs, one per match drone. `shared/fleet.ts` owns membership and MAVLink system IDs; `TeamSession` passes `MATCH_FLEET` to the adapter, and the helper validates that roster at its process boundary. Blue system IDs are 1–3 and red IDs are 4–6; vehicle component ID is 1. Every endpoint binds an operating-system-assigned UDP port on `127.0.0.1`. The controller uses system 255/component 190. Each pair pins its expected UDP source address as well as MAVLink source and target identities. The reusable adapter's default roster remains the blue three-member fleet; a full match explicitly supplies all six.

This is a real MAVLink 2 wire bridge around the existing Node simulation. It is **not PX4 or ArduPilot SITL**, an autopilot implementation, or hardware flight control. No aircraft is connected, and no host mesh interface is changed. Physics, collision handling and actuator limits remain in the game. There is no arming, offboard-mode negotiation, heartbeat/failsafe implementation, link signing, hardware authentication or real-time flight guarantee.

The implementation imports the reference `pymavlink.dialects.v20.common` dialect from pinned `pymavlink==2.4.49`. Its generated serializer creates binary MAVLink 2 datagrams; a separate receiving socket reads each datagram and a fresh reference parser validates its checksum, including the dialect's CRC extra. A datagram contains exactly one unsigned frame. Unsupported framing/flags, CRC errors, unexpected source addresses, system/component IDs, sequence numbers and message IDs are discarded with a bounded receive deadline. Semantic target/frame/mask errors reject the request. A failed wire operation returns no simulation command.

# Standard message mapping

| Game action | Controller → simulated endpoint | Endpoint → controller | Accepted result |
| --- | --- | --- | --- |
| `fly_to(x,y,z)` | `SET_POSITION_TARGET_LOCAL_NED` (84), `MAV_FRAME_LOCAL_NED`, position-only mask `0x0DF8` | `POSITION_TARGET_LOCAL_NED` (85), echoing the received setpoint | Position decoded from the returned binary echo determines the actual game waypoint. |
| `hover` | `SET_POSITION_TARGET_LOCAL_NED` (84), local NED, velocity-only mask `0x0DC7`, all three velocities zero | `POSITION_TARGET_LOCAL_NED` (85) | The decoded zero-velocity hold cancels the waypoint and brakes smoothly to a hover. This is not an absolute position setpoint. |
| `look(heading)` | `COMMAND_LONG` (76), `MAV_CMD_CONDITION_YAW` (115), absolute compass angle, default turn rate and shortest direction | `COMMAND_ACK` (77), accepted and addressed to controller | The endpoint's decoded angle is released only after its matching ACK. |
| `look(pitch)` | `COMMAND_LONG` (76), `MAV_CMD_DO_GIMBAL_MANAGER_PITCHYAW` (1000), pitch angle, pitch-lock flag; yaw and angular rates are NaN/unset | `COMMAND_ACK` (77) | The endpoint's decoded camera pitch is released only after its matching ACK. It is an actuator command, not telemetry. |

When a `look` specifies both angles, both wire exchanges must succeed before Node receives the combined action. With neither angle specified, the bridge sends the current heading as a no-op yaw command. The endpoint accepts this deliberately small profile, including exact masks and supported command parameters; it does not claim broad autopilot compatibility.

Mining, purchases, armor and firing are game-layer actions in `server/rts.ts`; they do not invent new MAVLink messages. A gun uses the current camera aim reached through the accepted vehicle controls. Projectile travel, gravity, swept hits, collision damage and team elimination belong to the authoritative simulator. These physical parameters are not passed to drone agents.

The simulator axes are east/up/south. The private conversion is NED north = `-sim.z`, east = `sim.x`, down = `-sim.y`; compass heading = `-sim.yaw mod 360`. MAVLink positions and angles use float32 precision, which intentionally carries through to accepted commands and observations.

Mission numbers stay in the TypeScript pending request closure. They are restored to the result after the wire operation. They are **not encoded in MAVLink**, and this bridge does not invent a MAVLink mission-epoch field. IPC request IDs and MAVLink sequence numbers are different concepts.

# Observation boundary

For a requested observation, the simulated vehicle sends `LOCAL_POSITION_NED` (32) and `ATTITUDE` (30) across its UDP pair. The bridge validates the source and matching `time_boot_ms` values, reverses the frame conversion, and returns exactly:

```json
{"position":{"x":0,"y":7,"z":23},"heading":{"degrees":0},"simTime":1.234}
```

The timestamp has millisecond precision; this proof of concept rejects times outside the unsigned 32-bit millisecond interval rather than silently wrapping at about 49.7 days. `ATTITUDE` body roll, pitch and rates are zero in this simulation; the bridge returns only its yaw-derived heading. Camera/gimbal pitch never enters telemetry or the model's sensor output. The browser supplies the separate camera image. No pad coordinates, obstacle geometry, peer poses, hidden world labels, extra telemetry fields or transport diagnostics enter this sensor result.

# Lifecycle and verification

`MavlinkAdapter` uses the shared JSON-lines `PythonRpc` helper launcher. The helper exits and closes every endpoint socket on `stop` or stdin EOF: twelve sockets for the six-drone match. Stop also cancels startup; a stopped adapter cannot restart and a new session constructs a new instance. Receive operations are bounded. Eliminated drones lose controller/tool access, and match completion stops the helper along with both native actor sessions. Only local sockets are used, so these checks do not establish hostile-network security or radio reliability.

After `npm run network:setup`, run `node --import tsx --test tests/mavlink.test.ts`. The tests use no browser or model inference. They exercise roster identities, actual float32 wire values, NED and compass-heading conversions, waypoint/zero-velocity hold/yaw/gimbal commands, the restricted sensor result, malformed and CRC-corrupt datagrams, wrong UDP/MAVLink identities and targets, frame/mask rejection, recovery, closed transport, startup cancellation and stdin-EOF cleanup. The full suite adds six-drone match composition. Bounded real RTS trials use `scripts/playtest-rts.ts` on isolated port 4318 with Luna/xhigh and an open camera browser; `scripts/verify-rts.ts` checks the browser deterministically without inference. Current results belong in [RTS-PLAYTEST.md](RTS-PLAYTEST.md), separate from older network/treasure reports.

Primary protocol references: [common message definitions](https://mavlink.io/en/messages/common.html), [packet serialization and checksum](https://mavlink.io/en/guide/serialization.html), and the [pymavlink reference implementation](https://github.com/ArduPilot/pymavlink). The installed v2 common dialect was inspected for the exact message signatures and gimbal/yaw parameter definitions used here.
