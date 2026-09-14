Independent network review — 2026-09-13

Reviewed the current network increment under the Review sections of `guidance/code.md` and `guidance/research.md`, using the `orch-review` independent-review assignment. No implementation files were changed and no repairs were delegated. Verdict: one P2 finding requires repair.

- **[P2] Account for telemetry failures before deciding whether the fleet can continue.** In `server/game.ts:174–182`, `completeTool` counts errors from `dispatch` and resets the consecutive-error count for a successful dispatch before it calls `withObservation`. The new MAVLink telemetry request at `server/game.ts:191` can then reject outside that accounting. `server/runtime.ts:130–134` converts the rejection into an MCP error, but emits no `tool-error` event. The stop guard at `server/index.ts:181–184` therefore never sees these failures. A UDP receive timeout or socket error is returned as an ordinary RPC error by `network/mavlink.py:257–259`; the helper remains alive, so the fatal-process callback does not cover this path either. Repeated failed `observe` or `wait` calls can keep the fleet and inference running indefinitely without usable observations, contrary to the integration contract's transport-failure stop behavior. Route telemetry failures through the fleet failure path, or account for failure of the complete tool response without trying to collect another observation recursively. Preserve explicit failure rather than substituting simulator sensor values.

The finding was reproduced with an isolated `FleetGame` instance, a stub camera, and a `vehicleTransport.sample` method throwing the native helper's receive-timeout error. Five consecutive `observe` calls produced:

```json
{"rejectedObservations":5,"toolErrorEvents":0,"fleetStillRunning":true}
```

This probe verifies failure propagation at the game boundary; it did not inject loss into the live UDP helper. A repair regression should verify that repeated telemetry failures reach the configured shutdown/error handling and cannot silently reset the consecutive-failure count. Normal command rejection by the flight-controller limits should retain its existing nonfatal behavior.

The review covered `NETWORK.md`, `NETWORK-CONTRACT.md`, `MAVLINK.md`, the network/Python RPC/MAVLink adapters, server integration and game delivery paths, the Python peer/store/transport and MAVLink implementations, the browser network controls, and the network/MAVLink tests. Relevant runtime, mailbox, observation tests and model-facing instructions were also inspected. A second pass grouped possible issues by shared cause; no other high-impact finding was confirmed. Native Zenoh transport, durable commit-before-ACK, stable retry IDs, restart tombstones, per-drone mission checks, future-mission deferral, expiry filtering, and binary MAVLink decoding are present in the inspected implementation. The documentation distinguishes loopback node partitions and simulated vehicle endpoints from a radio mesh or a real autopilot.

The full test suite, browser playtest, inference, and ports 4317/4318 were left to the parent task. Their results are not claimed as independently executed here. Hardware behavior and hostile-network authentication are outside the stated PoC scope.

Reviewed source identities (SHA-256):

```text
server/game.ts       EABB9DA540DF7302BB2875D8D5E80D79B149E88A52C84535CCC1CAE521BD1225
server/index.ts      D2CBAD84D1C8955CE3A6448DC371C09119C49C1A44EC42C5B09964BF6BE95DC1
server/mavlink.ts    D04679E8B2DEC4B75C2D77CE9739FD4B0C039782D59D5CE010A1CD343C38BB67
network/mavlink.py   A368E24B8A2000B59D8F4A622CB5A075F97AABA6580EF12D9A359B6BCAA651E6
```

## Parent repair record

The one repair pass now treats failure to assemble MAVLink telemetry as a terminal observation transport failure. `FleetGame.completeTool` stops the game, emits `transport-error`, and returns an explicit stopped response without substituting simulator sensor values. The server routes that event through the shared runtime/network/vehicle teardown and retains the error state. Subsequent calls do not attempt telemetry again. Expected controller rejections remain nonfatal.

The added regression injects a telemetry receive failure, verifies the stop event on the first call, then verifies that three later calls make no additional telemetry requests. All 41 tests and the TypeScript/Vite production build passed after this repair. This is the parent's repair and verification record; the independent reviewer did not re-review it. The separate live browser trial exercises the normal transport path on the pre-repair server instance, not this injected-failure path.
