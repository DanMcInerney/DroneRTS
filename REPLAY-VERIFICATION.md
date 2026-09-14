# Admin replay verification

Date: 2026-09-14. This change follows RTS checkpoint `cdf8d7d`. It adds player-only recording and playback; it does not change actor instructions, team isolation, movement tuning, equipment prices or damage rules.

## Automated evidence

- `npm test`: 142 tests passed, including actual Zenoh and MAVLink helper integration without inference. Twenty-one replay tests cover immutable sampled state, late camera delivery and bounded refresh, unavailable images, cancelled observations, physical shot/impact IDs, past-only timeline state, cursor-relative metrics, recording budgets, write backpressure, complete-line byte paging, storage failures and local path validation.
- `npm run build`: TypeScript and Vite production bundle passed. Vite reports the existing large JavaScript chunk warning; this is not a build failure.
- `node --import tsx scripts/verify-replay.ts`: passed against an idle isolated server on port 4318. The fixture created 245 records through the actual recorder, used a separate temporary HTTP diagnostics/replay store, and captured real images through the game's browser renderer. No Codex agents or model inference were launched.

The browser fixture mines 22 credits, equips a gun and produces one physical hit and a blue victory. It verifies live recording append, scrub/play controls, event navigation, all six actor options, past attachments and death state, and shot/hit totals. It compares an archived camera file byte-for-byte with the image delivered by the tool. A live observation while replay is at time zero retains its current acquisition time and camera. Missing actor observations and legacy sessions display unavailable evidence explicitly. Desktop and mobile views were visually inspected, with no horizontal page overflow or browser exceptions.

Local evidence is under ignored `artifacts/replay-ui/`: `result.json`, `replay-desktop.png`, `replay-mobile.png`, `replay-mobile-controls.png`, and an isolated `store-<uuid>/` fixture directory. These fixture records do not enter the player's normal session list. Raw evidence is intentionally local and may be absent in a fresh clone.

## Ownership and practical limits

One fresh independent code review found a default-capacity issue: six simultaneous drone observations could lose two images because the queue held only four. The repair raises the image queue capacity to six while retaining the 4 MiB byte budget; a regression test verifies a complete match-roster burst without omissions. The review found no other blocking correctness or ownership issue. This was one review followed by its repair and checks.

The simulator owns combat events; the final observation boundary owns acquired camera evidence; one recorder owns serialization, sampling and budgets. The store owns bounded reads, the pure timeline owns time selection and metrics, and the separate canvas owns playback drawing. The replay viewer cannot mutate the live scene.

World frames are sampled at 10 Hz of simulation time. The viewer holds the last recorded state, marks gaps and draws eight-second trails; it does not manufacture missing trajectories or camera images. Exact event endpoints may fall between sampled world frames. Per-session limits are 32 MiB of JSONL, 64 MiB of camera files and 512 KiB per image. Queue pressure or limits are explicit, and old sessions need manual retention cleanup. Old audit logs alone cannot reconstruct replay.

This deterministic verification demonstrates the recording and playback path. It does not establish that autonomous agents can consistently aim or win. Historical live evidence remains in `RTS-PLAYTEST.md`; focused Luna/xhigh flight and aiming trials are still the next gameplay evaluation.
