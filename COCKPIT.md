# Drone cockpit

Click a drone feed card, or open `#cockpit/drone-1`, to inspect its latest received evidence. Switch drones with the selector; Back or Escape returns to the flight deck. The game and camera renderer stay mounted. Opening a cockpit never captures a new observation or consumes mail.

Production and focused trials use the same `server/cockpit-session.ts` adapter for the HTTP router, final tool evidence and runtime output. Trial cockpits therefore expose the same acquired images and real private workspace inspection as production. The trial's existing mutation restrictions still apply.

## Cards

- **Last image seen:** actual pixels from the last MCP image response, with acquisition and delivery timestamps. If a later response has no image, the previous frame is explicitly marked. Images are served separately from JSON and remain outside audit exports.
- **Position & heading:** the last acquired sensor object, including camera pose, own velocity/orientation, finite ranges and validity. The `fleet-observation/5` column encoding remains lossless; newer current telemetry has separate acquisition metadata. No spectator position is substituted.
- **Last inbox batch:** every event in the latest returned 128 KiB-bounded slice, including empty slices. `hasMore` means unread events remain for later tool results. Received messages stay distinct from messages merely queued for delivery.
- **Last tool exchange:** latest request arguments and latest returned content. A pending request labels the previous receipt. Credential redaction, separately served images and size omissions are disclosed.
- **Radio outbox:** retained `send` requests; a request does not establish peer delivery.
- **Files & automations:** read-only inspection of the selected drone's actual private virtual workspace, including authored/imported notes and JavaScript. Empty means no retained files; unavailable/revoked access is explicit. Inspecting source neither runs a routine nor imports transferred code.
- **Tools & libraries:** dynamically available tools, Luna/xhigh, bounded QuickJS execution, private file quotas and guest/host library boundaries. Own relative modules may be imported; optional guest libraries are absent. Zenoh and pymavlink are host adapters outside guest imports.

The bottom feed shows tool activity, emitted agent output, **Native reasoning** and **Reasoning summary** entries. Streaming output updates appear as their text arrives. Pause the feed to inspect entries; resume to follow new activity. Evidence is recorded when the final MCP response is constructed; the native client does not acknowledge when the model has read it.

## Reasoning visibility

Newly launched actors keep **gpt-5.6-luna / xhigh** and set `model_reasoning_summary = "auto"` plus `show_raw_agent_reasoning = true`. The first requests summaries; the second surfaces raw text when the active model emits it. These are documented in the [Codex configuration reference](https://developers.openai.com/codex/config-reference).

| Feed label | Recorded source |
| --- | --- |
| Native reasoning | `item/reasoning/textDelta` and readable plaintext in completed `reasoning.content`. |
| Reasoning summary | `item/reasoning/summaryTextDelta` and completed `reasoning.summary`. |

The native and summary streams remain separate, following the [app-server item-delta contract](https://learn.chatgpt.com/docs/app-server#item-deltas). An availability indicator reports **waiting**, **native**, **summary**, **both** or **no readable text** from the selected actor's recorded evidence. A missing stream is never synthesized from the other one.

Only readable text emitted by the native runtime is displayed. Encrypted payloads are neither decoded nor treated as readable output, and the display does not promise the model's full internal reasoning. Live Luna support for these streams has not yet been confirmed; protocol tests and the synthetic fixture validate handling without inference. The settings apply to the next launched actors. Existing actors must be relaunched to use them, and previously discarded text cannot be recovered from this recorder.

`server/runtime-reasoning.ts` aggregates bounded multipart streams by actor/item, applies completed content without duplicating its deltas and flushes unfinished streams as explicitly partial records on interruption. Streaming updates go only to the bounded cockpit; sanitized completed and partial records persist in the session audit. Thus an interrupted actor can retain the readable text it already emitted without presenting it as a completed reasoning item.

## Ownership and extension

| Layer | Owner | Extension point |
| --- | --- | --- |
| Runtime environment facts | `shared/actor-environment.ts` | Model, compute restrictions and host libraries, shared with the compact prompt. |
| Evidence contract | `shared/cockpit.ts` | Versioned player-only snapshots, calls, responses, images and output events. |
| Acquisition | `server/runtime-mcp.ts` | Optional callback after constructing the final MCP result, including errors and catalog-refresh instructions. Never add cockpit fields to actor responses. |
| Reasoning adapter | `server/runtime-reasoning.ts` | Separate native/summary streams, bounded multipart aggregation, completed items, availability and interrupted partial records. |
| Storage and HTTP | `server/cockpit.ts` | Bounded per-drone memory, cursor-based updates, validated image access, credential redaction. |
| Composition | `server/index.ts`, `server/team-session.ts` | Match lifecycle and runtime callbacks. New matches/reset clear cockpit evidence; stopped matches retain their final evidence until reset. Late events from an old session are ignored. |
| Cards | `client/cockpit-cards.ts` | Add/remove/reorder entries in `COCKPIT_CARDS`; each defines its evidence key and renderer. |
| Feed model | `client/cockpit-model.ts` | Event identity, bounds and merging text deltas/completions. |
| Page | `client/cockpit.ts`, `client/cockpit.css` | Navigation, polling, cancellation, responsive layout and output feed. |

The workspace view reads the existing onboard service through a pure inspection path. It grants no host-directory access, consumes no inbox events, does not expire/import transfers and cannot write files or execute code. Authored files and immutable versions belong to the actor's 2 MiB workspace, with 64 KiB/file and 256-file limits. The complete application split and QuickJS heap/CPU/SDK/deadline limits are documented in [ONBOARD.md](ONBOARD.md); guest libraries have a combined 256 KiB ceiling and none is currently installed. New matches start empty, while destruction revokes actor access.

## HTTP and retention

`GET /api/cockpit/:droneId?session=<id>&after=<cursor>` returns the latest snapshot plus newer events. Session changes or invalidated cursors reset the viewer; omitted earlier events are flagged. ETags permit unchanged responses to return 304. Images use the session-bound URL supplied in `lastImage.url`; the two most recent images remain available to tolerate an image update during a request. Older URLs and images from a reset session return 404.

Per drone, the server retains up to 256 events and 256 KB of event JSON, 24 KB of output text per runtime item, one tool response up to 2 MB and two images each up to 2 MB of base64. The browser retains 240 events. Oversized results and missing evidence are labeled. This is a live cockpit, not a complete historical transcript; use Admin/replay for separately recorded session history. A server restart clears live cockpit memory.

## Verification

Run `npm test` and `npm run build`. The cockpit tests exercise real MCP responses, empty/error bundles, exact image bytes, per-drone/session isolation, credential redaction and retention limits without model inference. Reasoning protocol tests cover native versus summary text, multipart deltas, completions, interrupted partials and absent readable text; they do not establish live Luna support.

For watchable UI checks, run `node --import tsx scripts/cockpit-fixture.ts`. It starts a developer-controlled match on an ephemeral loopback port, prints its URL and stops after ten minutes. It uses the production camera channel, compact observation schema and managed test-artifact lifecycle, without creating model actors. Open the URL in a current browser to supply real camera captures. Its `POST /api/fixture` actions include `bootstrap`, `mail`, `observe`, `output`, `reasoning-complete`, `workspace`, `cargo`, `camera-off`, `camera-on` and `reset`. `output` streams explicitly synthetic native reasoning and a summary; `workspace` creates explicitly synthetic private-file evidence through the onboard service. Cargo indices refer to the current five-cache layout. Stop with Ctrl+C after checking. Ports 4317 and 4318 are untouched.

`node --import tsx scripts/runtime-preflight.ts` checks that the installed native runtime accepts all three reasoning settings and can call its parent MCP tool. It starts no model inference and does not establish which readable reasoning streams Luna will emit.
