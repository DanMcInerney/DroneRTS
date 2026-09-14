# Downtown Cincinnati treasure hunt

The valley/pad objective has been replaced with a compact, flat downtown Cincinnati built from simple cuboids. The default player instruction asks the fleet to inspect treasure chests, report discoveries over its existing peer radio, and coordinate the search. Six deliberately oversized brown-and-gold chests are scattered across parks, a plaza and rooftops. The player sees a found/total counter; discovered chests change their physical appearance.

## Geographic basis

The checked-in source dataset contains 16 landmarks, 250 background building footprints, 734 OSM road ways and four parks/plazas. `scripts/build-city.mjs` projects the coordinates into a local plane, fits minimum-area oriented rectangles, filters background objects whose centres duplicate landmarks, and makes stepped tower and hollow stadium approximations. The resulting scene has 274 collision boxes. The renderer uses those same boxes, including their rotation and tier elevation. Roads preserve mapped turns and the downtown grid's angle.

Great American Tower, Carew Tower, Fourth & Vine, Scripps Center and the other documented towers preserve their total relative heights. The Ohio River, Fountain Square, Piatt Park, Lytle Park, the stadiums and the convention center provide geographic context. Ten landmark heights have independent published sources. Other building heights, street widths, tower setbacks, flat ground, two plaza outlines and the river shoreline are approximations. This is a recognizable game setting, not a survey or full architectural reconstruction. See [CINCINNATI-SOURCES.md](CINCINNATI-SOURCES.md) for per-landmark citations and confidence.

The OSM-derived dataset is available in `city-research.json`, with OSM IDs, source URLs and ODbL attribution. The UI links to OpenStreetMap copyright. No proprietary basemap imagery or tile textures are used. To regenerate the deterministic scene, run `node scripts/build-city.mjs`; it writes `shared/city-data.json` without accessing the network.

## Discovery and isolation

A successful optical observation records nearby, forward-facing chest candidates privately in the scorer. The camera image must be available and the sightline must not cross any building volume. A later `found` radio message mentioning a chest or treasure can credit the nearest still-unfound candidate from that drone's latest observation. One report credits at most one chest. Duplicate reports cannot increase the count. Observations from an older mission, an unavailable camera or more than 30 simulation seconds ago cannot score. The scorer uses a 5.5-unit range and an inset optical frustum; these are developer-only thresholds.

Seeing a chest alone does not score; the drone must report its discovery. Radio wording is checked by the `found` convention and a chest/treasure keyword, not by a semantic vision judge. This is a simple gameplay rule, not proof of model comprehension. The source of truth is local observation and the report; the receipt of that report by every other peer is not required for player scoring. Native Zenoh still carries peer traffic, and MAVLink still carries vehicle control and telemetry.

No chest IDs, locations, candidate lists, city map, height table, progress count or completion events are returned by drone tools. Agents still get only position, heading, timestamp and camera pixels, plus their own controller feedback and actual messages. System prompts remain world-agnostic. Physical street signs and opened chests can be learned from the camera like other scene objects. Mission text is supplied by the player interface and forwarded unchanged; there is no hidden planner or allocation of search areas.

Drone movement uses swept segment collisions against expanded oriented boxes, so a fast simulation step cannot tunnel through a narrow wall. Towers, rooftop tiers and stadium openings share their visible collision geometry. Ground is flat and drone-to-drone collision/aerodynamics are still outside this PoC. Chests and street signs are visual props, not solid flight obstacles.

## Developer coordinates and validation

The map origin is near Fountain Square at 39.1015°N, 84.512°W. One game unit represents ten metres; X increases east, Z south, Y up. The playable horizontal area is approximately 2.08 × 1.70 km, with a scenic river extension. These facts live only in renderer/simulator files and developer documentation, outside the isolated model runtime. Drones start above the riverfront looking toward the skyline. Reset restores the starting positions and all chests. Starting a new fleet also clears discovery progress; replacing its instruction retains that run's discoveries.

The 46 automated checks cover city placement and skyline heights, clear launch/chest positions, rotated/swept collision, camera occlusion, discovery requirements and duplicates, sensor isolation, and the existing network/runtime behavior. They use no inference. TypeScript checking and the production build pass. A separate Luna/xhigh browser trial is recorded in `CITY-PLAYTEST.md`; its coverage is limited to a short treasure-search mission, not exhaustive exploration of all six locations.

The first live trial exposed slow camera delivery under software WebGL. The performance repair removes dynamic shadows, uses simpler lighting and fewer window polygons, and renders changed player views at at most 18 fps. Camera-tool requests bypass that UI throttle and keep their actual 512×288 image output. The retry evidence is recorded separately; the display cap does not change physics speed or the timestamped sensor contract.

The targeted Luna/xhigh retry improved image availability from 1 of 12 audited observations to 49 of 53. All three drones moved and sent peer radio messages. They did not issue a `found` report or score a chest during the 150-second search; successful autonomous treasure recovery remains unproven by that bounded trial. The scorer's positive and negative cases pass automated checks. Desktop/mobile renders were inspected again after the performance repair. The test fleet and its server were stopped, and the updated user server remains available on port 4317.
