# Drone prompt sources

[shared/mission.ts](shared/mission.ts) owns the exact commander opening, vehicle knowledge, rules and team communication. Mechanical parents relay the opening unchanged.

[server/runtime-tools.ts](server/runtime-tools.ts) owns domain tool descriptions and the pilot's role, compute and sensor-encoding briefing. [server/nervelet.ts](server/nervelet.ts) declares the binding names and canonical wait fields beside request/output translation.

Nervelet's `src/instructions.ts` generates the loop contract for startup/recovery, tool identity guidance and the recurring observation reminder. Its `src/schemas.ts` generates numeric wait choices/help from the DroneRTS profile. See [Nervelet integration](NERVELET-INTEGRATION.md) for the pinned dependency, acknowledgment and result contracts, and [ONBOARD.md](ONBOARD.md) for resource limits.

These sources generate the prompt; this document keeps no prompt copy.
