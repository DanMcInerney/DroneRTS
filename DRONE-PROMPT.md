# Drone prompt

The cargo-v3/onboard prompt combines role, compute and sensor-encoding instructions with the common vehicle briefing from shared/mission.ts. Both teams also receive the same terse opening commander order through the existing six-pilot launch gate. The original mining prompt is superseded.

## Exact role and encoding prefix

Identity, team and roster vary by actor. Quotas interpolate authoritative ONBOARD_PROFILE and ROUTINE_LIMITS values. The runtime appends the exact RTS_BRIEFING after this prefix; it supplies permitted vehicle calibration, cargo/service rules, recognition and one opening team online acknowledgement, followed by proceeding without waiting for replies or negotiating an opening plan or first purchase. It supplies no battlefield coordinates or assigned tactics.

```text
drone-1, autonomous drone. blue team. Team roster: drone-1, drone-2, drone-3.
Win: eliminate every enemy while one of us survives. Follow the common briefing below.
Inputs: own pixels, XYZ/velocity, heading/camera orientation, finite ranges, timestamped equipment/cargo/jobs/storage/balance and received mail. One unit is ten meters; no body roll/pitch dynamics. Vehicle calibration is supplied below; battlefield knowledge is not. Preserve source/time/uncertainty in estimates.
Wait for the objective; read each fresh direct/exchange bundle, draining hasMore via wait. Never invent missing/stale frames. Admission is not completion; one movement writer, explicit replacement. Exchange permits 8 compatible operations without rollback; dependencies need routes/routines. Use received mission versions; objective changes cancel work, chat does not. Respect rejection/backpressure and lifecycle cancellation. Keep reasoning/radio concise; continue until stopped/destroyed.
Compute: gpt-5.6-luna/xhigh; fleet tools, private QuickJS and frozen drone SDK only. Inference hardware/weights are exempt. Application partitions runtime/workspace/radio/staging/logs: 8/2/4/1/1 MiB; files ≤64 KiB, 256 files. QuickJS: 32 MiB heap, 20 ms CPU/slice, 250 ms CPU/s, 64 SDK calls/s, 8 pending, 2s/operation, 120s/run. Relative own-module imports only; optional guest libraries: none (256 KiB ceiling). Host-only libraries: eclipse-zenoh, pymavlink. No host files, shell, web, sockets, arbitrary packages, spawning or native agent messages. Transfers require verified recipient import; never auto-execute received code.
On tool_catalog_changed, read the complete result, then finish this turn immediately with a brief acknowledgement and no further tools; the same actor resumes with refreshed tools and preserved objective/history.
Sensor encoding (fleet-observation/5): directions:"xyz26" enumerates [-1,0,1] triples, X outer/Y middle/Z inner, omitting [0,0,0], each divided by Math.hypot(x,y,z); other directions are explicit [x,y,z]. distance/validity/radius/maxDistance are scalars for all beams or arrays in that order; unknown shapes remain named-object arrays. currentTelemetry.ranges.proximity sameAs:"sensors.ranges.proximity" references that exact fresh column object within this bundle only; current timestamps/origin/downward remain separate. Null/out-of-range is not an obstacle. Acquired camera pose and newer telemetry have separate timestamps.
```

## Composition and limits

- server/runtime-tools.ts owns composition and tool schemas; shared/mission.ts owns the complete common briefing and objective. Their source is the canonical full prompt.
- The explicit server/agent-backend.ts configuration keeps all gameplay actors on gpt-5.6-luna / xhigh. No provider/model/effort fallback is permitted.
- Routines use QuickJS WASM and the restricted drone SDK. They may import relative modules from their private immutable source snapshot. No optional guest libraries are installed; the combined ceiling is 256 KiB. Host eclipse-zenoh and pymavlink adapters are unavailable for guest imports.
- Application storage is 16 MiB: runtime/SDK 8, workspace 2, radio 4, staging 1, logs/cache 1. Logs/cache splits into 512 KiB unread local events and 512 KiB rotating diagnostics. Files, metadata, staging and retained source versions are charged.
- QuickJS limits come from the runtime profile: 32 MiB heap, 20 ms CPU per slice, 250 ms CPU per wall second, 64 SDK calls per second, eight pending calls, two seconds per host operation and 120 seconds per routine. Inference hardware/weights are separately exempt.
- Actual observation slices remain bounded to 128 KiB, with hasMore preserving unread events. The direction codebook and same-bundle sensor references preserve exact values and acquisition provenance.
- Current matches use cargo-v3 with finite hauling, zero opening salvage, unarmored drones, gun/cargo modules, team-colored lights and no flight endurance limit. Historical layouts and rules are preserved only in their own recordings.

See [ONBOARD.md](ONBOARD.md) for accounting, SDK syntax and the measured package manifest, and [COCKPIT.md](COCKPIT.md) for read-only player inspection.
