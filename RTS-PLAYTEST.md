# RTS verification — September 14, 2026

This report covers the working implementation on `codex/cincinnati-rts`, based on merged PR #3 (`7e664d6`, God view and Admin). Testing used Windows, the installed Codex CLI 0.144.0, real local Zenoh/MAVLink helpers and the Codex sidebar browser. All inference actors used **gpt-5.6-luna / xhigh**. The original idle service on port 4317 was preserved during development; live trials used port 4318.

The exact 86-file source manifest is saved locally in `artifacts/rts-source-manifest.json` (SHA-256 `ada03f9e189945bc69848ec1ae05c93e96d18ffbd456abb9ba1851a9d63fb8ad`). It covers code, styles, HTML, configuration and data used for the final checks, excluding prose reports and local session artifacts.

## Deterministic game and browser checks

`npm test` passed **121/121 tests** after the runtime repair. `npm run build` passed TypeScript and produced the production bundle; Vite reports the existing large-bundle advisory. Tests cover swept moving-drone contacts, armor consumption and separation, building/ground collision, physical projectile travel and gravity, cover, friendly fire, mining reach and depletion, miner acceleration, atomic shared purchases, simultaneous victory/draw and reset. Observation tests cover camera evidence, unavailable images, mission versions, cross-team isolation, death during acquisition, immutable render snapshots, own mining feedback and absence of opponent economy notifications. Integration tests use actual Zenoh and MAVLink helper processes without inference.

`node --import tsx scripts/verify-rts.ts` passed using a browser fixture attached to the real renderer and `FleetGame`, with inference explicitly blocked. It captured six actual 512×288 sensor images, exercised God view and Admin while sensor acquisition continued, and completed an earning → purchase → camera aim → physical shot → kill → victory sequence. The mobile layout at 390 pixels had no horizontal overflow, reset restored all six drones, and there were no page errors. This fixed duel proves the simulator and interface path, not autonomous targeting skill.

Local evidence: `artifacts/rts-ui/result.json`, the six `drone-*-initial.jpg` images, `armed-camera.jpg`, `projectile.png`, `victory.png`, `desktop.png` and `mobile.png`. Full-page screenshots can show blank offscreen FPV panels because the renderer only draws visible viewports; `live-feeds.png` records the visible feed layout, and the individual sensor images verify camera output directly.

## Live trial 1 — initial opening

`artifacts/playtest-rts/2026-09-14T05-13-35-466Z/result.json`

Six native drones started, received their team missions, acquired their own images and communicated over radio. The match ended naturally after about 195 simulation seconds: red won with drones 5 and 6 surviving. Four drones died in terrain collisions. Neither team mined. The trial reported no runtime failure and stopped its test fleet.

This exposed a weak opening: agents spent their early turns exploring away from salvage without discovering mining. The starting positions were moved within safe mining reach with cameras facing each team's opening deposit, and the drone prompt was simplified to remove prescribed coordination conventions. No map coordinates, movement calibration or resource explanation were added to actor instructions.

## Live trial 2 — mining and a discovered runtime defect

`artifacts/playtest-rts/2026-09-14T05-19-19-331Z/result.json`

The revised opening produced actual resource discovery and mining by red drone 5, earning the team's full 80-credit opening deposit. Its peers received the shared account state. One blue drone crashed.

The actors then reported that `buy` appeared in their controller response but was absent from their callable tool namespace. A prior native MCP inventory preflight had shown a changed catalog, but had not proved that a running model turn could call it. The trial was deliberately stopped at about 180 seconds to repair this. Its recorded “Match stopped early” failure is that intentional diagnostic abort; this trial is not presented as a passing complete match.

The repair keeps each drone's identity and history. A completed tool response carries the full fresh sensor/inbox bundle plus a transport-only request to end that turn. After natural completion, the runtime queues a supported MCP configuration reload, reads the refreshed tool inventory and starts a new turn for the same actor. Expected catalog changes do not consume the accidental-completion recovery budget. Death and Stop suppress resumption. The runtime never interrupts private reasoning to install the newly unlocked tool.

## Native tool-discovery proof

`artifacts/runtime-catalog-native-smoke.json` and `artifacts/runtime-catalog-native-smoke-events.json`

A bounded native Luna/xhigh protocol actor called `observe`, then `buy({mission:1,item:'gun'})`, then `fire({mission:1})` across two natural turn transitions in the same native thread. Both later tools were absent from its initial callable catalog. CLI 0.144.0 required the configuration reload as well as the idle child's inventory read; merely notifying or listing tools was insufficient. The smoke completed at 05:31:03 UTC and cleaned its temporary actor/runtime.

This fixture supplied synthetic sensors and explicit protocol-test tasks. It proves that the model itself can call newly discovered equipment tools; it is separate from an autonomous match and does not prove visual targeting or tactical competence. Production drone instructions contain an explicit exception permitting this transport-only temporary yield.

## Final live trial — repaired production runtime

`artifacts/playtest-rts/2026-09-14T05-32-30-728Z/result.json`

The full six-drone production match ran for its bounded ten-minute window and stopped automatically at 05:42:32 UTC. Its audit contains **470 camera observations, 41 peer radio messages, five purchases and seven gunshots**, with no recorded runtime or tool errors. All six native children were verified as Luna/xhigh, and the two parents remained mechanical relays.

Blue discovered and exhausted its opening deposit, earning 80 shared credits. The drones independently coordinated and purchased two guns, two armor charges and one miner, spending exactly the available income. The newly discovered tools worked across five natural catalog refreshes involving three concurrent production actors. Red continued its own visual exploration and mining experiments but did not recover salvage during this run.

Both armed blue drones fired while tracking perceived red contacts. No projectile hit was recorded. Live collisions exercised the requested survival rules: blue drone 1 consumed armor against terrain, and blue drone 2 survived contact with unarmored blue drone 3, consuming its armor while drone 3 was destroyed. Drone 1 later died in another terrain collision after losing its protection. At the time limit, drone 2 and all three red drones survived. There was **no natural winner** in this final bounded trial; the time limit stopped the trial without assigning a victory.

This proves live mining, shared spending, all three attachments, model-called firing, asynchronous radio, collision consequences and cleanup. It does not prove reliable autonomous aiming, successful contested-deposit mining, or balanced competitive strategy. The earlier natural victory and deterministic gun-kill victory remain separate evidence.

The test fleet stopped successfully. The isolated port-4318 server was shut down afterward, and the idle normal service on port 4317 was refreshed to the new six-drone RTS, ready for the player to launch a fresh match. No player match was interrupted.

## Interpretation

The game exposes a complete RTS ruleset, but agent strategy is learned during each match. Testing must distinguish deterministic physics success, native tool-protocol success and autonomous game performance. Terrain deaths, mistaken experiments and poor spending choices can be legitimate outcomes for fresh actors. None of the tests justify claiming consistently skilled autonomous gunfights or balanced competitive play.

Raw session records and screenshots are local ignored artifacts. Earlier treasure-hunt playtest/review documents describe older revisions and are not evidence for this implementation.
