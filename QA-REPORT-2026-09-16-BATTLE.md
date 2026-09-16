# Main-tip battle and UI QA — September 16, 2026

The user-requested normal battle ran for its 600-wall-second limit and stopped at **566.844 simulation seconds**. All six drones survived. There were **zero pickups, deliveries, purchases, shots, collisions or deaths**, so no winner. The runtime and observation pipeline stayed healthy, but this source did not demonstrate a working autonomous battle economy.

## Source and execution

- Fetched `origin/main` before launch and again after analysis. The clean worktree HEAD matched **`debebc27cb78802937872b700d3fdced66b861bd`** both times. No gameplay, prompt, controller, renderer or dependency source was edited.
- Saved manifest: **207 files**, SHA-256 **`6146e649ddc58b580f31baf251d30711339f011184101ad4fe884718f9c0ca24`**. Post-run comparison found no changed manifest files. These documentation additions followed the run.
- Built the exact unpatched Nervelet `54ba0d38e0ee7216212d231020d088da3a3fe435` package using `NERVELET_SOURCE=C:/Users/danhm/tools/nervelet-implementation-20260916`. Archive SHA-256 matched `8f3ea917f4229fec422e414f3349aff08ef51b22816267ef37be22ffccc8f488`; `npm ci`, `network:setup` and the TypeScript/Vite production build succeeded. Vite retained its large-chunk advisory. Node was 24.15.0; the live CLI reported 0.144.0.
- `playtest-focused.ts match`, port **4318**, **600 seconds**, fixed **1×**, six **gpt-5.6-luna / xhigh** children and two mechanical relay parents. The saved fixture explicitly says “Unmodified production opening and missions.” Attention and acoustics were off. No tactical guidance, coordinates or scripts were supplied to pilots.
- Both 4317 and 4318 were unavailable before launch; no player server was restarted. The watchable Codex browser supplied the camera. The first browser control handle became unavailable; a replacement tab was opened on the same host without restarting the match. The audit accepted three connections with one matching renderer fingerprint, with no recorded camera failure.
- Match start was **14:38:09.520 UTC**; cleanup finished **14:48:09.794 UTC**. Runner exit was zero, cleanup was complete, and the final port check found no listeners on 4317/4318. The owned browser tab was closed. Worktree-matching processes left afterward were browser-tool support processes, not gameplay hosts/helpers.

Raw evidence was collected in `artifacts/test-runs/2026-09-16T14-38-03-993Z-focused-match-2d81d53f/`: result, audit, replay/images, native network stores, source manifest, four standard analyzer outputs, `qa-supplement.mjs`/JSON, cleanup check, UI snapshots and screenshots. The subsequent opening/UI repair verification pruned that fully analyzed run under managed retention. This report preserves the measured result; [QA-HANDOFF.md](QA-HANDOFF.md) records the follow-up fixes and retained reproduction inputs. The findings below describe the original battle revision.

## Findings

### Gameplay blocker: visual discoveries did not become successful cargo approaches

All **840 salvage** remained in the original caches. Drones flew and exchanged observations, but none entered successful loading service. Without earned credits, neither team acquired a gun. This is a failed autonomy result, not evidence of a broken cargo or projectile engine.

Blue 2's actual camera at **sim 192.685**, pose `(-5,25,25)`, visibly contains yellow marked aprons. Its subsequent report was tentative and did not identify a reliable world position. Blue 3 later reported approximate sectors `(1,26)` and `(-6,27)` at **sim 273.825**; the blue pilots investigated those positions without reaching a cache. Blue 2's low approach near `(-5,25)` stopped at about **Y 1.688** on obstruction, with no damage or loading. Blue 3 continued estimating positions of later yellow marks, then rejected a rooftop at **sim 546.693** and expanded its search again.

Inspected acquired image files in the replay folder:

| Image | Evidence |
| --- | --- |
| `e17c3364-f7aa-4f66-8e52-e629339a5faa.jpg` | Blue 2, sim 192.685: marked yellow aprons visible among buildings. |
| `8875596a-bc63-4684-a2ff-4affa00f7ade.jpg` | Blue 1, sim 230.176: another actual overhead image containing yellow aprons. |
| `ea18f06d-d9e5-4b79-8082-a1914e3673cc.jpg` | Blue 3, sim 386.156: small yellow apron near the upper edge. |
| `fe899e55-f10f-4b89-8256-17082687bf1d.jpg` | Blue 3, sim 449.639: yellow apron, red base and a red airframe visible; its later report says no enemy drone confirmed. |

These frames support investigating image interpretation and target-position estimation. They do not establish why a particular private decision failed. Keep any repair within permitted camera/calibration/range knowledge; no locator, host pathfinder or supplied route is justified. The nearest sampled enemy pair was **64.715 m** apart. The engagement analyzer found body-center viewing opportunities in 29 images; that geometric proxy alone does not prove recognition.

### P2: long decision gaps remain without compaction

The longest completed-tool-to-next-call interval was **39.043 seconds**, Blue 3, **14:42:37.486–14:43:16.529 UTC**. Only 0.046 sampled simulation seconds contained local work; 38.992 were idle. Blue 1 had a **36.994-second** gap with 36.911 sampled idle seconds. Red 3 had a **30.898-second** gap with 30.887 idle seconds. **No completed or incomplete context compaction was recorded.** Do not label these intervals compaction failures or pure inference time.

| Pilot | Delivered camera bundles | Sampled path, metres | Median / maximum next-call gap, seconds | Maximum reported input tokens |
| --- | ---: | ---: | ---: | ---: |
| Blue 1 | 65 | 3,091.89 | 6.635 / 36.994 | 204,563 |
| Blue 2 | 66 | 2,052.56 | 5.412 / 21.554 | 198,964 |
| Blue 3 | 59 | 1,659.27 | 6.561 / 39.043 | 179,444 |
| Red 1 | 71 | 1,438.75 | 5.171 / 10.799 | 197,452 |
| Red 2 | 44 | 613.98 | 4.931 / 16.566 | 125,087 |
| Red 3 | 59 | 1,646.39 | 5.316 / 30.898 | 173,642 |

The two teams also spent opening time resolving conflicting purchase proposals. Those were real peer exchanges, not a host-authored plan. Source-specific measurements do not establish a latency improvement over historical runs.

### P2: cockpit Radio outbox omits sends inside exchange batches

At **14:43:53 UTC**, the saved Blue 1 cockpit window contained 256 events, including two `exchange` calls with `send` operations: sequence **250 / op8** at **14:40:14.394** and sequence **278 / op11** at **14:40:45.751**. The cockpit nevertheless showed **“No sends in this window.”** Both messages appear in the live radio transcript and native audit.

`client/cockpit-cards.ts:124–126` filters only calls named `send` in both its change key and rendering. It never inspects `exchange.operations`, the current batching interface. This hides real outgoing communication from a principal inspection surface. Fix the outbox to represent nested send attempts with their outer call/operation provenance while retaining the distinction between attempted send and confirmed delivery.

Evidence: [saved cockpit window](artifacts/test-runs/2026-09-16T14-38-03-993Z-focused-match-2d81d53f/ui/cockpit-blue1.json), [visible empty outbox](artifacts/test-runs/2026-09-16T14-38-03-993Z-focused-match-2d81d53f/ui/10-outbox-missing-batched-sends.png), and `qa-supplement.json.uiOutboxEvidence`.

### P3: cargo-v3 replay still displays “Jammer off”

The live replay inspector displayed “Jammer off” for unequipped cargo-v3 drones. `client/equipment-presentation.ts:42` emits it whenever the legacy boolean exists, without checking the recording's ruleset. Current matches remove jammers. Hide this inactive legacy detail for cargo-v3 while retaining historical recording interpretation. This did not affect gameplay.

## Checks that held

- All six opening objectives appeared in successfully submitted bundles at **sim 0**, between **14:38:39.071 and 14:38:42.724 UTC**. Each was later acknowledged. The first movement admission was after this, at 14:39:22.187.
- **364/364** submitted observation bundles included actual saved images; no missing image IDs/files, unavailable camera bundles or camera timeout errors were found. Image files total **6,364,862 bytes**. Delivered camera age was median **65.9 ms**, p95 **145.1 ms**, maximum **436.4 ms**. The broker separately logged 450 acquisitions, including acquisitions that did not become separate model deliveries; do not equate that count with delivered bundles.
- **53 peer messages**, **103 expected recipient copies**, all **103 included** in actual recipient bundles. **101** copies had an acknowledged bundle before shutdown; two late copies had been included but remained unacknowledged at cutoff. No cross-team peer copy was found. Inclusion is not proof of comprehension.
- Six separate Nervelet epochs; **364 submissions**, **354 bundle acknowledgements**, **181 admissions**. Red 3 twice invented a `seen` identifier by mixing its epoch prefix with part of the session UUID. Both requests were rejected, and the pilot recovered. These were incorrect pilot arguments, not valid IDs expiring prematurely.
- **1,280 replay frames** conserved **840 total salvage**, with zero cargo/loss/delivery and no conservation violations. Eight unique movement jobs were blocked and six failed with explicit flight-controller rejection. No collision occurred; this does not resolve the prior opposing-motion reproducer.
- Replay reached the actual final simulation time and ended with `omittedImages:0`; no replay warnings, tool exceptions, transport errors or runtime failures were recorded. **326 readable reasoning-summary records** were retained, with no raw readable reasoning records. No authored scripts, routines or transfers occurred.
- All four offline analyzers completed successfully against the unchanged recorded source. The additional audit script checked source hashes, image files, exact radio inclusion/acknowledgement, launch delivery, conservation and the outbox discrepancy.

## UI coverage and limits

Visually inspected all six FPV feeds, scores/equipment/cargo/controller states, actual cockpit camera/sensor/inbox cards, bounded readable output, empty private workspaces, Admin health and filters, replay drone selection and Last frame, overhead Fit downtown and God view entry/Escape. Camera delivery continued with Admin/cockpit/God view open. Radio scrollback exposed its Latest control. Flight deck and cockpit were checked at **390 × 844** without horizontal overflow, and the viewport override was restored.

The captured browser log had no JavaScript errors, including the final check after shutdown. The inspected initialization emitted two Three.js environment-blur sample-clipping warnings and one deprecated shadow-map warning. Screenshots and the UI checklist are under `ui/` in the managed run.

The bounded host owns launch and rejects reset/chat/speed mutation; this session therefore does **not** qualify the production Launch/Reset/chat controls. No new unit suite was run for this documentation-only QA; the production build and live/offline checks above are the fresh evidence. No repair was implemented. Repeatable hauling, useful team hauling, armed combat, moving-target hits, native emergency recovery and the known opposing-motion collision remain unqualified on this source.
