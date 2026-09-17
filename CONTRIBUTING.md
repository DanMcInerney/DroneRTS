# Contributing to DroneRTS

DroneRTS is a local simulation and agent experiment. Start with [the README](README.md), [architecture](ARCHITECTURE.md), and [development instructions](AGENTS.md). The [operating guide](GUIDE.md) preserves the full setup, rules, and evaluation commands.

## Local setup and checks

Use Node.js 24+ and Python 3.12+:

```sh
npm ci
npm run network:setup
npm test
npm run build
```

`npm ci` installs the exact Nervelet npm release pinned by `package.json` and the lockfile's registry URL and integrity checksum. No local source clone or archive build is required. Do not patch installed dependencies or change integrity hashes to accept different contents. Python dependencies belong in `.venv`.

Tests include native Zenoh and MAVLink processes and require loopback sockets. They do not use model inference or require Codex credentials. The CI workflow runs these checks on Windows and Linux. Actual hosted CI results are the evidence of platform support; a workflow definition alone is not.

`npm test` runs up to four test files in parallel, capped by available CPUs, and streams progress while saving the managed log. Native peer scenarios also run two at a time with separate ports, namespaces and databases. Use `npm test -- --test-concurrency=1` when debugging file-level scheduling. Capacity fixtures use smaller test-only quotas to reach their boundaries quickly; production limits and SQLite durability are unchanged.

For a UI change, also run the relevant deterministic browser fixture documented in [GUIDE.md](GUIDE.md#architecture-and-verification). Install its browser with `npx playwright install chromium` if needed. Before starting or restarting a server, inspect its `/api/state`. Preserve the player's port 4317; use a free isolated port, normally 4318. Live playtests consume Codex usage, require Luna/xhigh and a current camera browser, and must be bounded with owned processes stopped afterward.

## Preserve the experiment

- Give pilots only their own acquired pixels, calibrated local sensors, private state, and delivered messages. Keep spectator maps, opponent state, resource coordinates, and hidden geometry out of tools and files.
- Keep the two teams isolated and parent actors mechanical. The common briefing may explain rules and vehicle calibration; it must not supply tactics or solved routes.
- Preserve finite salvage, atomic spending, bounded storage, explicit cancellation, and native protocol failures. A deterministic fixture proves mechanics, not perception or teamwork.
- Record source identity and actual observations for gameplay claims. Keep development reports, plans, handoffs and review notes under ignored `artifacts/`, and summarize validation in the pull request. Update maintained documentation when behavior changes. Earlier reports remain available in Git history and apply only to their tested revision.

Test runners retain only the newest completed raw run under ignored `artifacts/test-runs/`. Analyze a trial before launching another check. Group related checks using the managed `FLEET_TEST_RUN` mechanism; preserve active runs and player archives.

## Issues and pull requests

For a bug, include the commit, OS, Node/Python versions, reproduction command, expected behavior, and actual behavior. Identify whether the evidence comes from a deterministic fixture or native model play. Share a minimal redacted excerpt; local logs, camera captures, chat, and replay files can contain private data.

Keep changes focused. Explain the behavior that changes, the tests run, and any unqualified claims or remaining limits. Update the owning contract when behavior changes, and preserve geographic attribution when editing the map. New original contributions are provided under the project's MIT license; third-party material retains its own terms.
