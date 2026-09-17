# Documentation

- [README](README.md): project overview, demo, quick start and measured results.
- [Operating guide](GUIDE.md): full rules, setup, troubleshooting and evaluation commands.
- [Architecture](ARCHITECTURE.md): application ownership and observation boundaries.
- [Onboard interface](ONBOARD.md) and [prompt sources](DRONE-PROMPT.md): sensors, private scripts, resource limits and briefing composition.
- [Nervelet integration](NERVELET-INTEGRATION.md): pinned dependency, acknowledged bundles, results, waits and optional experiments.
- [Network](NETWORK.md) and [MAVLink](MAVLINK.md): native radio, storage, vehicle messages and coordinate conventions.
- [Cockpit](COCKPIT.md): inspecting the inputs, output and private workspace of a pilot.
- [City](CITY.md), [graphics](GRAPHICS.md) and [geographic sources](CINCINNATI-SOURCES.md): map geometry, asset builds, approximations and attribution.
- [Contributing](CONTRIBUTING.md), [development instructions](AGENTS.md), [security](SECURITY.md) and [third-party notices](THIRD_PARTY_NOTICES.md): contribution, verification and reuse guidance.
- [Media notes](docs/media/README.md): demo provenance.

Development plans, handoffs, QA reports, playtest logs and review notes belong under ignored `artifacts/`. Pull requests summarize relevant checks and limits; maintained documentation describes lasting behavior.

Earlier development reports remain in [the Git snapshot before cleanup](https://github.com/DanMcInerney/DroneRTS/tree/72717d725166f5e4dca1870c55640152ed9e0d49). Links to historical evidence use that fixed revision. Those reports retain their original dates, source hashes and limitations; they do not validate later code. Deterministic fixtures and transport delivery do not establish autonomous perception, teamwork or hardware readiness.
