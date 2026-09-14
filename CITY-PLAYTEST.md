# Cincinnati playtest

Runs: `artifacts/playtest-city/run-2026-09-14T03-11-15-324Z/` (baseline) and `artifacts/playtest-city/run-2026-09-14T03-18-56-484Z/` (authorized retry)

I inspected the actual isolated Playwright Chromium render at 1280×720 and 390×844 with `--use-angle=swiftshader --enable-unsafe-swiftshader`. The desktop composition keeps all three FPV feeds, skyline/streets, chest props, treasure progress, and mission controls readable. At 390px the feeds stack without horizontal overflow and Mission Control, radio, and Network Lab remain reachable. No high-impact visual blocker was found. The side feeds show partial chest props while the center feed shows one chest fully; this is camera composition.

The baseline live trial used `gpt-5.6-luna` / `xhigh` on `http://127.0.0.1:4318`. Launch reached three online native drones, runtime `running`, and network `online`. The exact default treasure mission was forwarded as mission 1. Each drone emitted a radio claim, but drone 2 and drone 3 explicitly reported camera unavailable; the audit has four observation records per drone, with camera metadata present for drone 1 only. No `found` radio was sent, no chest was scored, and no drone moved from its starting position before the requested early Stop. The audit has no runtime/tool errors and the browser had no console/page errors. Stop was confirmed with all drones offline and runtime `stopped`.

The authorized retry reset the world through the UI, then ran one unchanged mission for the full 150-second bound under the same Luna/xhigh runtime. The three synthetic capture requests in the preflight each returned an actual capture result within a 210.2 ms response window (offsets 0, 108.7, and 210.2 ms; see the timing note in `playtest-result.json`). Camera delivery was materially restored: final state observations were 15, 19, and 22, while the session audit recorded camera metadata in 11/13, 18/19, and 20/21 observation bundles for drones 1–3. All three drones moved and sent radio messages. No chest was scored because no `found` radio report was emitted. The concrete radio trail has drone-3 reporting a possible chest-like orange object at simTime 123.11 and approaching to verify, followed by no confirmation; drone-2 later reported a west sweep with no chest and a blocked waypoint. This is an uncompleted autonomous search within the bound, rather than a rejected found report. The retry audit has no runtime/tool errors and the browser had no console/page errors. Stop was confirmed with all drones offline and runtime `stopped`.

Evidence:

- Result: `artifacts/playtest-city/run-2026-09-14T03-11-15-324Z/playtest-result.json`
- Audit summary: `artifacts/playtest-city/run-2026-09-14T03-11-15-324Z/audit-summary.json`
- State history: `artifacts/playtest-city/run-2026-09-14T03-11-15-324Z/state-history.jsonl`
- Captures: `desktop-idle.png`, `desktop-three-online.png`, `mobile390-three-online.png`, `mission-one-sent.png`, `bounded-trial-end.png`, `stopped.png`
- Retry result: `artifacts/playtest-city/run-2026-09-14T03-18-56-484Z/playtest-result.json`
- Retry audit: `artifacts/playtest-city/run-2026-09-14T03-18-56-484Z/audit-summary.json`
- Retry state history: `artifacts/playtest-city/run-2026-09-14T03-18-56-484Z/state-history.jsonl`
- Retry captures: `desktop-three-online.png`, `mobile390-three-online.png`, `mission-one-sent.png`, `bounded-trial-end.png`, `stopped.png`
