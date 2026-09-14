# Independent Cincinnati increment review

Reviewed September 14, 2026 UTC by a fresh reviewer who did not implement the candidate. No repairs or delegated repairs were made. Applied the Review sections of `guidance/code.md`, `guidance/research.md` and `guidance/visual-design.md` through `orch-review`.

**Verdict: no high-impact findings in the reviewed candidate.** The city and treasure objective are suitable for this simple PoC, subject to the exploration coverage below.

## Scope and evidence

- Read `CITY.md`, `CINCINNATI-SOURCES.md`, `CITY-CONTRACT.md`, the source dataset, generated city data and build script, shared types, game/scoring/collision implementation, runtime tool prompts, renderer, city props, UI, styles and changed test coverage. Confirmed the dataset counts: 16 landmarks, 250 background footprints, 734 road ways, four parks/plazas and 274 generated collision boxes.
- Independently ran `node --import tsx --test tests/city.test.ts`: **5/5 passed**. The root supplied the full **46-test pass and successful production build**; this review did not repeat that full suite or run inference.
- Inspected the actual rendered `artifacts/playtest-city/visual/desktop-idle.png` and `mobile390-full.png`. The three FPV feeds, simple skyline, treasure prop, discovery counter, mission form and network controls remain understandable. The narrow view stacks the feeds and controls without material clipping.
- Spot-checked primary evidence: [Thornton Tomasetti's Great American Tower project](https://www.thorntontomasetti.com/project/great-american-tower-queen-city-square), [Skyscraper Center's Carew Tower entry](https://www.skyscrapercenter.com/building/carew-tower/2528), and [the Bengals' stadium history](https://www.bengals.com/stadium/history). Their height/name claims support the corresponding research notes. Other landmark claims were traced to the recorded URLs and qualifications, without independently re-querying every OSM object or every height source.

## Assessment

The generated oriented boxes have one shared source for visible buildings and collision. Local-frame segment intersection prevents tunnelling and handles tower tiers; optical scoring applies matching camera orientation/frustum conventions, range and building occlusion. Chest positions are clear of building interiors and within the playable bounds. The visual massing is deliberately approximate, and the documentation distinguishes sourced heights/footprints from estimated heights, road widths, shoreline, setbacks and flattened terrain.

Discovery requires a previously delivered camera image, a current and recent private sighting, and a `found` report. Duplicate reports cannot increase the count. Missing camera images, stale missions and expired sightings are rejected. Scoring remains private: no chest coordinates, candidate IDs, progress or completion event is inserted into drone tool responses. The existing prompts still prohibit scene assumptions, and the role-bound sensor bundle remains position, heading, timestamp and camera, alongside controller events and peer mail. The change preserves the existing Zenoh/MAVLink integration.

The simple keyword-based `found` rule is accurately disclosed as a gameplay convention; it does not establish semantic visual comprehension. The documentation does not claim that this increment models real downtown terrain or architecture at survey fidelity.

## Coverage limits

The concurrent Luna/xhigh pilot was still running when this review concluded. The inspected screenshots establish rendered presentation, not successful autonomous recovery of all six chests. Consult `CITY-PLAYTEST.md` for the actual live mission outcome. This review did not control either live server, launch actors, test radio hardware, or exhaustively fly every street and rooftop approach.

Potential findings were enumerated and reconsidered for shared causes before reporting. No high-impact code, source-claim, boundary or visual finding remained. There is no requested repair pass from this review.

## Parent repair record from the live trial

The first Luna/xhigh live trial exposed camera timeouts on software WebGL despite readable static screenshots. The visual maker completed one performance repair: removed repeated shadow-map passes, reduced window geometry, simplified lighting, disabled MSAA, and limited player FPV rendering to changed frames at up to 18 fps. Offscreen player feeds are skipped. Sensor captures bypass that display throttle and still render real 512×288 images with the requested pose and peer snapshots. No scoring rule, scene calibration or sensor payload was changed.

The repaired client passes TypeScript checking and the production build. The same Luna/xhigh pilot owns the targeted retry and its measurements in `CITY-PLAYTEST.md`. This is the parent's repair record; the independent reviewer did not re-review it.

The retry is complete: 49/53 audited observations carried camera images, all three drones moved and spoke over radio, and repaired desktop/mobile images were inspected. No chest was confirmed during the 150-second mission, so the report does not claim autonomous treasure completion. Test-server cleanup and final TypeScript checking passed.
