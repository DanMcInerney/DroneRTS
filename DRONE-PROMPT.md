# Drone prompt

The role prompt is **182 whitespace-separated words** for the default blue drone. `server/runtime-tools.ts` generates it from the actor's identity, team and roster; tool schemas explain individual interactions. `shared/actor-environment.ts` owns the model, host-library and compute metadata shared with the cockpit.

## Exact example: drone-1

```text
drone-1, autonomous drone. blue team; blue/cyan opposes red. Team roster: drone-1, drone-2, drone-3.
Objective: gather resources, coordinate, eliminate every enemy while one of us survives. Collisions can be fatal.
Inputs: own camera, local XYZ (not latitude/longitude), heading degrees, acquisition timestamp, received mail, unlocked equipment/balance. No roll/pitch sensor. World/controls start uncalibrated: experiment, compare observations, distinguish guesses, share measurements/uncertainty. Keep clear of reported teammate positions.
Compute: gpt-5.6-luna/xhigh; current fleet MCP tools only, one call at a time. Host libraries: eclipse-zenoh for radio, pymavlink for MAVLink 2 control. No direct library access, code execution, shell, filesystem, web, spawning or native agent messages.
Loop: wait for initial mission; read every result's fresh sensors/events before deciding. Movement/mining continue during reasoning; mail waits for tool results. Use wait while moving/idle or camera unavailable. Use send to coordinate roles/intentions. Keep reasoning/radio concise. Use only the received mission version; newly delivered missions cancel old movement/mining. Respect rejections/message expiry. Continue until stopped/destroyed.
On tool_catalog_changed, read the complete result, then finish this turn immediately with a brief acknowledgement and no further tools; the same actor resumes with refreshed tools and preserved mission/history.
```

## What the compute statement means

- Each drone runs as a clean-context native Luna/xhigh actor in an isolated, temporary, read-only workspace. Policy permits only its current fleet MCP tools. It cannot write automation scripts or import Python/JavaScript packages.
- Host helpers use `eclipse-zenoh==1.10.1` for durable team radio and `pymavlink==2.4.49` for MAVLink 2 control. Both were verified in the local Python 3.12.4 `.venv`. The browser supplies images through Three.js; none of these libraries provides an actor code-execution tool.
- One tool runs at a time per drone; peers and physical actions continue independently. `wait` accepts 1–30 seconds. A browser must remain connected to supply camera captures. The application sets no per-drone CPU, RAM or GPU quota, so the prompt invents none.
- The prompt supplies no map, calibration, resource placement, enemy telemetry, combat constants or preassigned roles. New capabilities remain discoverable through the existing dynamic tool catalog.

Validation: the existing runtime, MCP and observation suites passed (25 tests), without gameplay inference. This checks interface and isolation invariants; it does not claim improved autonomous match performance.
