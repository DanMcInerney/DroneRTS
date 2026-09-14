# Protocols in the game

The game now uses native Zenoh and MAVLink 2 on loopback. It does not install an operating-system radio mesh. Its Network lab buttons simulate an entire drone's network partition by closing/reopening that drone's native Zenoh session. Link range, interference, arbitrary per-edge loss, multihop radio routing and bandwidth constraints remain unmodeled.

```text
Player -> relay agent -> operator Zenoh bridge
                            | mission group publication
     drone-1 bridge <----> drone-2 bridge <----> drone-3 bridge
          ^                      ^                     ^
          | role-scoped MCP       |                     |
       drone-1 LLM            drone-2 LLM           drone-3 LLM
          |                      |                     |
          +---------- MAVLink 2 UDP endpoint pairs -----+
                                 |
                          Node world simulation
```

All three drone bridges connect directly to each other; the diagram abbreviates the complete peer graph. The operator publishes instructions and receives their acknowledgements; it does not subscribe to drone group traffic or route peer messages. Native model hosting, physics and browser rendering still share one application. The bridge processes are separate nodes; the LLMs are three native children of the requested Luna/xhigh parent session.

## Setup and scope

Run `npm install`, `npm run network:setup`, then `npm run dev`. Setup creates a project `.venv` and installs pinned `eclipse-zenoh==1.10.1` and `pymavlink==2.4.49`. Tested interpreter: Python 3.12.4. Set `FLEET_PYTHON` to an existing interpreter with these dependencies if using a different environment. Default gameplay requires the protocols; there is no automatic in-memory fallback.

Every bridge opens an OS-assigned loopback TCP port, uses Zenoh `peer` mode, explicit peer endpoints, and no multicast/gossip discovery or central router. Native sessions exchange data even while no model tool is running. See [Zenoh deployment documentation](https://zenoh.io/docs/getting-started/deployment/) and its [Python implementation](https://github.com/eclipse-zenoh/zenoh-python).

Each drone's control/telemetry pair exchanges actual binary MAVLink 2 UDP datagrams. Decoded setpoints determine movement; decoded local position and heading become the permitted sensors. The browser renders the separate camera sample. Frame conversion is private to the adapter and absent from agent instructions. This is a small simulated endpoint profile, not PX4/ArduPilot SITL, and needs no real vehicle. Exact messages and limits are in [MAVLINK.md](MAVLINK.md).

## Delivery rules

`shared/fleet.ts` is the default roster authority. Each `FleetNetwork` instance accepts a validated roster and an optional independent `networkId` UUID, defaulting to its game session ID. Worker membership, broadcast recipients and acknowledgement expectations derive from that roster; Python validates the supplied roster at startup. Future teams can share a game session while using separate network IDs, endpoints and stores. The game still launches the original three-drone team.

Radio publications use `fleet/<networkId>/radio/group` and `fleet/<networkId>/radio/direct/<drone>`, with separate ACK keys. A group peer message targets the other two drones; an operator mission targets all three. Sender identities are bound by each bridge's role. Mesh partitions do not magically deliver player instructions: each drone tracks only its latest received mission. A future-mission peer message waits locally for its associated directive, and obsolete messages/commands are rejected after that directive arrives.

The existing `fleet-radio/1` JSON message is carried in a network envelope with expiry. Outgoing data and per-recipient receipts are stored in that sender's SQLite database. Incoming data is committed to the receiver database before ACK. Retries retain the message ID; duplicate arrivals do not produce duplicate inbox entries. Consumed inbox rows remain as deduplication records. The default deadline is 120 seconds. Operator publications wait for all three receipts; drone group publications wait for both other recipients. A successful send only means queued locally.

The PoC retries pending packets every 250 ms until receipt or expiry; this fixed cadence suits the bounded local test. Backoff/jitter and storage quotas/garbage collection would be needed for a longer-lived deployment. Receipt proves storage, not agent comprehension. Local model handoff is not transactional with model execution. The per-run databases remain in `artifacts/network/<session>/<networkId>/`; starting a new fleet creates a new identity and does not replay old missions. Worker restart durability is tested independently; the app stops on helper failure and does not automatically reconnect model contexts.

Stop terminates all protocol workers and the native agent session. Merely isolating a radio peer leaves its sensors and controller available and its last received mission active. The player's global Stop is an application lifecycle operation, not evidence of an emergency radio command crossing a partition.

## Reuse on hardware

The JSON coordination semantics and native Zenoh bindings can be reused, but this launcher intentionally accepts loopback endpoints only. A deployment adapter would supply actual peer addresses over a tested IP mesh, peer authentication, clock synchronization, bounded durable storage and reconnection policy. An IP mesh such as Linux batman-adv supplies network forwarding beneath Zenoh; Zenoh does not configure the radios. [Linux mesh documentation](https://docs.kernel.org/networking/batman-adv.html)

The simulated MAVLink endpoints would be replaced with actual vehicle endpoints, with autopilot-specific mode negotiation, heartbeat/setpoint streaming, controller limits, timestamp alignment and loss handling. A local controller must run independently of LLM latency. PX4 documents its continuous offboard proof-of-life requirement. [PX4 Offboard](https://docs.px4.io/main/en/flight_modes/offboard)

The simulation is a protocol integration step, not evidence of hardware flight readiness. Models still receive only local position, heading, timestamps and camera pixels. No world axes, scale, map, target coordinates, camera calibration or scoring answers were added to their inputs.

## Evidence

All 41 tests and the TypeScript/Vite production build passed. `npm test` includes real-process Zenoh delivery, partition, retry, expiry, duplicate and restart tests; MAVLink wire/CRC/frame/identity/lifecycle tests; and an integrated game test proving missions do not bypass a partition. These deterministic tests use no inference. Independent review found a telemetry-failure shutdown gap; the repair and its regression are recorded in [NETWORK-REVIEW.md](NETWORK-REVIEW.md).

The single live browser trial used Luna/xhigh and confirmed partition/reconnection, queued mission delivery, replies from all three drones, and the responsive Network lab. It switched missions before two drones completed their first movement experiment, so it did not pass the full three-movement criterion; their stale actions were correctly rejected. See [NETWORK-PLAYTEST.md](NETWORK-PLAYTEST.md) for historical evidence and limits.

Admin now exposes bounded, searchable session audits, including new Zenoh application payload records with topics, envelopes, acknowledgements, direction and byte counts. Logging samples at most 12 payloads per peer per second, recording suppression counts; it is not a TCP framing capture. MAVLink records contain actual CRC-validated datagram hex and decoded fields, with telemetry limited to one sample per message type per second and an overall 20 packets/drone/s logging cap. Transport behavior remains unsampled; these caps affect diagnostics only. Older sessions retain their original publication/receipt and operation records.
