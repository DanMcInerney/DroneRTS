# Independent sensor and communication review

Reviewed on 13 September 2026 against the candidate identified below. Applied the Review sections of `guidance/code.md` and `guidance/research.md`. This reviewer did not make or repair the implementation, start inference, open a browser, or interact with ports 4317/4318. The separate live trial is outside this report.

## Finding

### P2 — Ordinary controller experiments can terminate the entire fleet

`server/game.ts:225` and `server/game.ts:231` throw tool errors for camera actuator limits and rejected waypoints. `server/game.ts:134-141` counts every such rejection toward the same consecutive-error counter used for operational failures. At four errors, `server/index.ts:148-152` stops all four actors.

This conflicts with the revised agent contract in `server/runtime-tools.ts:20`: the agents receive no bounds or calibration, must learn using controlled experiments, and are told that a rejected command is controller feedback. Four different, well-formed experiments can therefore kill the session even while every response supplies useful new observations and the other drones are working normally. The cutoff does not distinguish repeated identical requests from changing experiments. The fourth rejection also bypasses the sensor wrapper because the synchronous error listener has already stopped the game.

**Reproduction, without inference:** create a connected, started `FleetGame`, supply a stub camera, mark all drones ready and forward mission 1. Register the same `consecutive >= 4` stop condition used by `index.ts`. For drone-1, issue four `fly_to` commands with `mission: 1`, `x: -5`, `z: 23`, and successive `y` values `0`, `0.25`, `0.5`, `0.75`. All four are well-formed controller probes; the hidden lower Y limit rejects them. Observed counters are `[1,2,3,4]`, the fleet ends with `running: false`, and only the first three responses contain sensors. No command moves a drone.

**Smallest shared fix:** classify expected waypoint and actuator rejections as ordinary command results, for example `accepted: false` with a generic controller reason, and still append the common sensor/inbox bundle. Keep the operational failure guard for actual malformed or unavailable tool operations. Add one focused regression that several distinct controller rejections leave the session running and each returns fresh sensors and unread mail. Do not reveal the numerical limits to solve this failure.

## Evidence and limits

- Independently ran `npm test`: all 22 tests passed. These tests do not cover the controller-feedback interaction with the server's fleet-wide error cutoff.
- An additional in-memory concurrency check passed: one drone's held camera capture blocks its second tool while another drone's `send` completes; mail and a replacement player mission arriving during that capture appear in its response; the queued old-mission action is then rejected with a fresh bundle and never starts movement.
- The response wrapper exposes only `position`, `heading`, `timestamp`, and `camera` as sensors. Sampled own pose and peer poses are passed together to capture. The browser applies those peer poses for the capture and restores its display state. Tilt, hidden target geometry, scoring, speed and calibration are absent from the agent-facing bundle/instructions inspected. Controller acknowledgements and peer-authored messages are separate from sensor data.
- The mailbox drains after capture, preserves every unread event, and treats client cursors as hints. The radio sender comes from the endpoint role and the local envelope includes session UUID, sequence and UTC. Scoring is only put in the player's radio log, not agent inboxes.
- Reviewed the listed candidate source files and the runtime boundary/configuration for context. I did not rerun the build, render browser images, or establish live mission completion. The parent reported an earlier successful build and owns the separate browser trial.

Before reporting, a second pass grouped the controller rejection, fleet termination and missing fourth sensor bundle under their shared error-classification cause. No additional high-impact finding was established in the reviewed scope.

## Documentation claims

The README and communication plan clearly distinguish the implemented single-process, in-memory relay from proposed Zenoh bridges, mesh networking, persistence and the hardware adapter. They identify local XYZ as simulator coordinates, qualify idealized motion, and do not claim completed network or hardware trials. No material overclaim was found in those distinctions.

The communication plan's central technical claims agree with the inspected primary sources: application peers require reachable connections and peer topology differs from router forwarding ([Zenoh deployment](https://zenoh.io/docs/getting-started/deployment/)); batman-adv provides layer-2 bridging ([Linux kernel documentation](https://docs.kernel.org/networking/batman-adv.html)); the current Rust reliability flag is not itself retransmission ([Zenoh PublisherBuilder](https://docs.rs/zenoh/latest/zenoh/pubsub/struct.PublisherBuilder.html#method.reliability)); Advanced Pub/Sub provides sample recovery and heartbeat support ([Zenoh release announcement](https://zenoh.io/blog/2025-04-14-zenoh-gozuryu/#advanced-pubsub-heartbeat)); MAVLink's local NED frame and global position/heading fields require explicit adapter conversion ([MAVLink messages](https://mavlink.io/en/messages/common.html#LOCAL_POSITION_NED)); and PX4 requires continuous offboard proof-of-life independent of LLM latency ([PX4 Offboard](https://docs.px4.io/main/en/flight_modes/offboard)). These source checks support the plan, not evidence that its proposed system has been implemented.

## Reviewed candidate identity

SHA-256 hashes captured before this report and before the parent's repair pass:

| File | SHA-256 |
| --- | --- |
| `server/game.ts` | `4F3A4CA47C1C9E3746F45AA08B327D4400D17CAD5F11824B73A428E132DD3DDB` |
| `server/mailbox.ts` | `BDC2AB5A9CAA6E095DE7004AEDB129A1A0F00B1EFB8FA7B23E1200F9DB1D0D77` |
| `server/runtime-tools.ts` | `0DCB8D5E48E9C743ECB87B7319F0A4BBB083B315B2CDCC2237D3A92B1F7B7143` |
| `server/index.ts` | `AF0AA614AFB2576EB3B6B0EFDFE5AD1E9B28517CFB80F9F1EF08D24A3B3FC144` |
| `client/main.ts` | `5127986D39C984CA9A47D53B64296602EF158D3AC64A955F1F4739B69B6E21E1` |
| `client/scene.ts` | `A07CA122D4B252C5B149DDA27A7474AEBF2EA989AE6844467D8DE15E8AB61ABB` |
| `shared/types.ts` | `A43E11BF72971410B0F0F7F632F39B6A4EDE667D5AB89B818887B29A0B9BD739` |
| `tests/observations.test.ts` | `45D944521019B375BB930AFB9430DDF72E47DA593D88C0BD708436DFB801A651` |
| `README.md` | `C10036E08152FBBAA4A630EF6F9C8A5B2CCDC3A8BF4835F71F0036E00F5E495B` |
| `COMMUNICATION-PLAN.md` | `888605B520AB3BCDB6BF14CF26966E7E205C08FE3A22EB0834D00B1E81D62D62` |
# Repair record

After this independent review, the coordinator made one repair pass. Expected waypoint and camera actuator-limit rejections now return `accepted:false` / `rejected:true` as ordinary controller feedback, with the full observation bundle; they no longer increment fatal tool-error counters. Regression coverage exercises four distinct rejected movement experiments and a rejected camera command without fleet shutdown.

The live trial separately exposed an arrival-during-image-encoding case. The bridge now refreshes once after an action completion or mission change during capture, timestamps controller events and delivery, and retains the command's original mission in its receipt. Deterministic tests exercise both races. All 25 tests and the TypeScript/production build pass after repairs. No second independent review or further inference trial was run.
