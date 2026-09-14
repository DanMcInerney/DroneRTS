# Independent review

Review completed 13 September 2026 against the source state before the parent’s repair pass. The review applied the code and visual-design review guidance, read `BUILD-CONTRACT.md`, `README.md`, runtime notes, tests, runtime spike evidence, and the rendered playtest artifacts. Source files were left unchanged.

## Findings

### P1 — Future mailbox cursors fail immediately and can livelock an actor

`server/game.ts:138-143` rejects a supplied `wait.after` when it is greater than that actor’s current mailbox cursor (`server/game.ts:141`). The model can legitimately carry a peer or otherwise future cursor because each drone has a separate mailbox. That response is returned as `isError: true` immediately, so an event wait becomes a fast retry loop instead of waiting for the next event. The runtime audit currently records the MCP item as completed with `error: null`, which makes this failure harder to diagnose.

This is reproducible without inference: after forwarding one mission, drone-1 has cursor 1; `game.tool('drone-1', 'wait', { after: 5, timeout_ms: 30000 })` returns immediately with `{"error":"Invalid event cursor"}` and `isError: true`. The approved isolated browser run shows the same pattern in the session tool log: drone-3 repeatedly called `wait` with `after: 5` at `00:19:16`, `00:19:27`, and `00:19:42` while its own mailbox had not reached that cursor, then continued with `after: 6`. The run accumulated 1,569,977 reported tokens, never completed mission 1, and was stopped manually. See `artifacts/playtest/playtest-result.json`, `artifacts/playtest/state-history.jsonl`, and `artifacts/session-2026-09-14T00-17-58-339Z.jsonl`.

The smallest shared fix is to treat the model cursor as a hint: normalize it against the mailbox’s server-owned delivered cursor and current cursor, clamping future hints to the current cursor and stale hints forward to the delivered cursor. Then enter the normal bounded asynchronous wait. Add a regression test that a future hint waits or times out and does not return a tool error, while preserving unread events. Keep `isError` visible in the audit or use it in a bounded fail-fast policy so a different repeated tool failure cannot consume unbounded inference.

### P2 — Runtime failure teardown runs concurrently through two owners

On a runtime failure, `server/runtime.ts:229-233` calls `this.stop(false)` from `failRuntime()` after invoking `onStatus`. The server callback in `server/index.ts:72-79` also starts `stopFleet()`, and `stopFleet()` calls the same `runtime.stop()` at `server/index.ts:41-50`. `CodexFleetRuntime.cleanup()` at `server/runtime.ts:244-259` has no in-flight guard, so both paths can operate concurrently on `rpc`, active turn interrupts, MCP connections, the HTTP server, and the temporary run directory. `AppServerRpc.stop()` is partly idempotent, but the enclosing cleanup and status updates are not serialized.

The failure path therefore has nondeterministic teardown ordering: duplicate interrupt/close work can overlap, and the final runtime status can race between the error and stopped updates. This was not triggered in the completed static test suite, but the ownership overlap is direct in the code and affects policy, process, and child-turn failures. Serialize `stop()`/cleanup behind one in-flight promise or designate one owner for failure teardown, and add a test that a failure callback performs one cleanup and preserves the error message after teardown.

## Evidence that passed

- `npm test`: 10 tests passed, including mailbox wakeup, parent relay isolation, mission replacement and stale command rejection, movement/collision, camera result shape, objective scoring, stop wakeup, restart isolation, bootstrap policy, native-tool policy, and startup cancellation.
- `npm run build`: TypeScript check and Vite production build passed. Vite emitted only the existing large-chunk warning.
- Static runtime inspection: parent is limited to the relay tool; child routes bind role identity server-side; child MCP configurations use separate random capability URLs; only the fixed Luna/xhigh model is configured; child hook enforcement is explicitly documented as unavailable in the installed runtime.
- `runtime-spike-evidence.json`: bounded native sensor spike observed the parent and all three children, with the requested `gpt-5.6-luna` / `xhigh` configuration and distinct synthetic image content. This is sensor/runtime evidence, not a game mission.
- Rendered screenshots (`artifacts/playtest/desktop-idle.png`, `mobile-controls-idle.png`, `isolated-idle.png`, `launch-starting.png`, `mission-queued.png`, `mission-radio-progress.png`, and `final-browser-state.png`) show a coherent hierarchy, readable controls, responsive mobile stacking, and no visible clipping at the captured sizes. The Three.js deprecation warning is non-blocking.

## Live playtest status

The approved isolated Luna/xhigh browser run connected all three native drones and forwarded mission 1. It produced 21 camera observations and 12 radio messages, but mission 1 did not complete: the final recorded state was `completed: false`, with drones at approximately `(8.5,7,1.8)`, `(-17,3,-8)`, and `(2,3,10)`. The generated result records `threeDronesConnected: true`, the correct model/effort, and failure after the fleet was stopped. The first live mission is therefore a failed acceptance run, not evidence of completion. `PLAYTEST.md` still says live gameplay is pending and should be reconciled with the generated result after the repair and retest.

No additional high-impact defect was found in the second static pass. This report covers the pre-repair state only; the parent’s subsequent changes require a fresh review if they need independent sign-off.
# Repair record

After the independent review, the builder changed mailbox delivery to use a server-owned acknowledged cursor. Future hints cannot skip unread events, stale hints cannot replay acknowledged events, and empty waits remain asynchronous. Tool errors are now logged explicitly; four consecutive failed game tools stop the fleet. Runtime Stop and cleanup share in-flight promises and retain the underlying failure status.

The revised deterministic suite passes 14 tests, including the future-cursor reproduction, unread-message preservation and overlapping error/UI shutdown. The TypeScript check and production build pass. These are builder verification results, not a second independent review. Live retest results are recorded separately in PLAYTEST.md.
