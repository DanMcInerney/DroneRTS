# Contributing to DroneRTS

DroneRTS is a local simulation and agent experiment. Start with [the README](README.md), [architecture](ARCHITECTURE.md), and [development instructions](AGENTS.md). The [operating guide](GUIDE.md) preserves the full setup, rules, and evaluation commands.

## Local setup and checks

Use Node.js 24+ and Python 3.12+:

```sh
npm run nervelet:setup
npm ci
npm run network:setup
npm test -- --test-concurrency=2
npm run build
```

Setup builds the pinned Nervelet source before installing the local archive. `NERVELET_SOURCE` may select a clone containing that exact commit; do not patch the installed package or change its integrity hash to accept different source. Python dependencies belong in `.venv`.

Tests include native Zenoh and MAVLink processes and require loopback sockets. They do not use model inference or require Codex credentials. The CI workflow runs these checks on Windows and Linux. Actual hosted CI results are the evidence of platform support; a workflow definition alone is not.

For a UI change, also run the relevant deterministic browser fixture documented in [GUIDE.md](GUIDE.md#architecture-and-verification). Install its browser with `npx playwright install chromium` if needed. Before starting or restarting a server, inspect its `/api/state`. Preserve the player's port 4317; use a free isolated port, normally 4318. Live playtests consume Codex usage, require Luna/xhigh and a current camera browser, and must be bounded with owned processes stopped afterward.

## Preserve the experiment

- Give pilots only their own acquired pixels, calibrated local sensors, private state, and delivered messages. Keep spectator maps, opponent state, resource coordinates, and hidden geometry out of tools and files.
- Keep the two teams isolated and parent actors mechanical. The common briefing may explain rules and vehicle calibration; it must not supply tactics or solved routes.
- Preserve finite salvage, atomic spending, bounded storage, explicit cancellation, and native protocol failures. A deterministic fixture proves mechanics, not perception or teamwork.
- Record source identity and actual observations for gameplay claims. Keep historical reports intact and identify the tested revision.

Test runners retain only the newest completed raw run under ignored `artifacts/test-runs/`. Analyze a trial before launching another check. Group related checks using the managed `FLEET_TEST_RUN` mechanism; preserve active runs and player archives.

## Issues and pull requests

For a bug, include the commit, OS, Node/Python versions, reproduction command, expected behavior, and actual behavior. Identify whether the evidence comes from a deterministic fixture or native model play. Share a minimal redacted excerpt; local logs, camera captures, chat, and replay files can contain private data.

Keep changes focused. Explain the behavior that changes, the tests run, and any unqualified claims or remaining limits. Update the owning contract when behavior changes, and preserve geographic attribution when editing the map. New original contributions are provided under the project's MIT license; third-party material retains its own terms.
