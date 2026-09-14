# Protocols in the game

The game uses native Zenoh and MAVLink 2 on loopback. It does not install an operating-system radio mesh. Network lab buttons and in-game jammers simulate an entire drone's network partition by closing/reopening that drone's native Zenoh session. Jammer proximity is a simple game rule; physical RF propagation, ordinary link range, arbitrary per-edge loss, multihop radio routing and bandwidth constraints remain unmodeled.

```text
Player blue instructions          Fixed initial red objective
           |                                  |
  blue mechanical parent             red mechanical parent
           |                                  |
 blue operator Zenoh bridge          red operator Zenoh bridge
           |                                  |
 blue drone-1 / drone-2 / drone-3     red drone-4 / drone-5 / drone-6
       native peer graph                 native peer graph
           |                                  |
           +------ six MAVLink 2 UDP pairs ---+
                              |
                     Node RTS simulation
```

Within each team, all three drone bridges connect directly to each other; the diagram abbreviates each complete peer graph. There is no radio edge between teams. Each operator publishes its team's instructions and receives acknowledgements; it does not subscribe to drone group traffic or route peer messages. Native hosting, physics and browser rendering share one application. The six drone LLMs are clean-context native children of two separate Luna/xhigh mechanical parent sessions. Both teams receive the same initial goal; subsequent player UI instructions go to blue only.

## Setup and scope

Run `npm ci`, `npm run network:setup`, then `npm run dev`. Setup creates a project `.venv` and installs pinned `eclipse-zenoh==1.10.1` and `pymavlink==2.4.49`. Tested interpreter: Python 3.12.4. Set `FLEET_PYTHON` to an existing interpreter with these dependencies if using a different environment. Default gameplay requires the protocols; there is no automatic in-memory fallback.

Every bridge opens an OS-assigned loopback TCP port, uses Zenoh `peer` mode, explicit peer endpoints, and no multicast/gossip discovery or central router. Native sessions exchange data even while no model tool is running. See [Zenoh deployment documentation](https://zenoh.io/docs/getting-started/deployment/) and its [Python implementation](https://github.com/eclipse-zenoh/zenoh-python).

Each drone's control/telemetry pair exchanges actual binary MAVLink 2 UDP datagrams. Decoded setpoints determine movement; decoded local position and heading become the permitted sensors. The browser renders the separate camera sample. Frame conversion is private to the adapter and absent from agent instructions. This is a small simulated endpoint profile, not PX4/ArduPilot SITL, and needs no real vehicle. Exact messages and limits are in [MAVLINK.md](MAVLINK.md).

## Delivery rules

`shared/fleet.ts` owns the explicit blue/red and combined match rosters. `server/team-session.ts` creates two `FleetNetwork` instances with separate random `networkId` UUIDs under the same match session. Worker membership, broadcast recipients and acknowledgement expectations derive from each team's roster; Python validates it at startup. Namespaced topics, endpoints and SQLite stores remain separate. MCP tool destinations and game receive checks also reject opposing-team roles. `DEFAULT_FLEET` is still the three-member blue roster for reusable single-network adapters; `MATCH_FLEET` is the complete six-drone match.

Radio publications use `fleet/<networkId>/radio/group` and `fleet/<networkId>/radio/direct/<drone>`, with separate ACK keys. A group peer message targets the other two drones; an operator mission targets all three. Sender identities are bound by each bridge's role. Mesh partitions do not magically deliver player instructions: each drone tracks only its latest received mission. A future-mission peer message waits locally for its associated directive, and obsolete messages/commands are rejected after that directive arrives.

The existing `fleet-radio/1` JSON message is carried in a network envelope with expiry. Outgoing data and per-recipient receipts are stored in that sender's SQLite database. Incoming data is committed to the receiver database before ACK. Retries retain the message ID; duplicate arrivals do not produce duplicate inbox entries. Consumed inbox rows remain as deduplication records. The default deadline is 120 seconds. Operator publications wait for all three receipts; drone group publications wait for both other recipients. A successful send only means queued locally.

The PoC retries pending packets every 250 ms until receipt or expiry; this fixed cadence suits the bounded local test. Backoff/jitter and storage quotas/garbage collection would be needed for a longer-lived deployment. Receipt proves storage, not agent comprehension. Local model handoff is not transactional with model execution. The per-run databases remain in `artifacts/network/<session>/<networkId>/`; starting a new fleet creates a new identity and does not replay old missions. Worker restart durability is tested independently; the app stops on helper failure and does not automatically reconnect model contexts.

Stop terminates both native sessions and all protocol workers. Match completion also shuts them down. Destroying a drone retires its model actor, revokes tool access and disconnects its radio peer. Merely isolating a live peer leaves its sensors and controller available and its last received mission active. The player's global Stop is an application lifecycle operation, not evidence of an emergency radio command crossing a partition. Mining, attachments and firing are local simulator operations; peer coordination still travels through native radio.

Jammers apply the same native partition mechanism automatically to nearby drones, including the emitter and its allies. `TeamSession` serializes link transitions and combines the current interference flag with manual isolation, actor retirement and destruction. A newer desired state is reconciled after an in-flight native transition completes; clearing interference never overrides another reason for isolation. A radio send waits for pending reconciliation before queueing through the native sender. Packets already in flight before a transition may have arrived; the system does not erase delivered mail or claim instantaneous physical RF behavior. Link failures use the existing explicit session-failure path. Simulation ticks and camera capture do not wait on radio reconnection.

## Reuse on hardware

The JSON coordination semantics and native Zenoh bindings can be reused, but this launcher intentionally accepts loopback endpoints only. A deployment adapter would supply actual peer addresses over a tested IP mesh, peer authentication, clock synchronization, bounded durable storage and reconnection policy. An IP mesh such as Linux batman-adv supplies network forwarding beneath Zenoh; Zenoh does not configure the radios. [Linux mesh documentation](https://docs.kernel.org/networking/batman-adv.html)

The simulated MAVLink endpoints would be replaced with actual vehicle endpoints, with autopilot-specific mode negotiation, heartbeat/setpoint streaming, controller limits, timestamp alignment and loss handling. A local controller must run independently of LLM latency. PX4 documents its continuous offboard proof-of-life requirement. [PX4 Offboard](https://docs.px4.io/main/en/flight_modes/offboard)

The simulation is a protocol integration step, not evidence of hardware flight readiness. Models still receive only local position, heading, timestamps and camera pixels. No world axes, scale, map, target coordinates, camera calibration or scoring answers were added to their inputs.

## Evidence

`npm test` includes real-process Zenoh delivery, partition, retry, expiry, duplicate, restart and namespace-isolation tests; MAVLink wire/CRC/frame/identity/lifecycle tests; and integrated game/runtime tests for team routing and delayed missions. These deterministic tests use no inference. The older telemetry-failure shutdown repair is recorded in [NETWORK-REVIEW.md](NETWORK-REVIEW.md); that report applies to its historical revision.

The historical single-team Luna/xhigh browser trial confirmed partition/reconnection, queued mission delivery and replies from all three drones, but did not complete its three-movement criterion. [NETWORK-PLAYTEST.md](NETWORK-PLAYTEST.md) records those limits. Current RTS browser QA uses `scripts/verify-rts.ts` without inference and `scripts/playtest-rts.ts` for bounded real two-team trials, both on isolated port 4318 after checking `/api/state`. See [RTS-PLAYTEST.md](RTS-PLAYTEST.md) for current evidence. Preserve active player sessions on port 4317.

Admin now exposes bounded, searchable session audits, including new Zenoh application payload records with topics, envelopes, acknowledgements, direction and byte counts. Logging samples at most 12 payloads per peer per second, recording suppression counts; it is not a TCP framing capture. MAVLink records contain actual CRC-validated datagram hex and decoded fields, with telemetry limited to one sample per message type per second and an overall 20 packets/drone/s logging cap. Transport behavior remains unsampled; these caps affect diagnostics only. Older sessions retain their original publication/receipt and operation records.
