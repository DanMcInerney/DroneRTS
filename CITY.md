# Cincinnati battlefield

The match is a three-versus-three drone battle in downtown Cincinnati. Each team begins on an open approach to Third Street, with its cameras already facing a small nearby salvage deposit. The opening deposits provide equal income; larger shared deposits draw both teams into the skyline's street corridors. The river, parks, stadiums, rotated blocks and tall buildings create recognizable routes, cover and dangerous corners. Resources are finite and have no geographic ownership: either team can mine any deposit it finds.

## Geographic basis

The checked-in source dataset contains 16 landmarks, 250 background building footprints, 734 OpenStreetMap road ways and four parks/plazas. `scripts/build-city.mjs` projects the coordinates into a local plane, fits minimum-area oriented rectangles, filters background objects whose centers duplicate landmarks, and makes stepped tower and hollow stadium approximations. The resulting scene has 274 collision boxes. The renderer uses those same boxes, including rotation and tier elevation. Roads retain their mapped turns and the downtown grid's angle.

Great American Tower, Carew Tower, Fourth & Vine, Scripps Center and the other documented towers retain their relative heights. Ten landmark heights have independent published sources. Other building heights, street widths, tower setbacks, flat ground and two plaza outlines are approximations. Fountain Square, Piatt Park, Lytle Park, Smale Riverfront Park, both stadiums and the convention center provide geographic context. The sourced CAGIS Ohio River polygon preserves the winding shoreline and island holes.

The geographic viewing extent follows Cincinnati's unequal municipal dimensions. Continuous terrain extends beyond that extent: the city no longer sits on a visible square slab or inside cube walls. A subtle ground tint and the player's full-city boundary overlay show the sourced municipality outline. Neighborhoods outside the downtown source extract remain schematic flat terrain; they are not a reconstructed full-city road/building network. See [CINCINNATI-SOURCES.md](CINCINNATI-SOURCES.md) for provenance and approximations.

The OSM-derived dataset is in `city-research.json`, with original IDs, source URLs and ODbL attribution. `riverfront-source.json` preserves the CAGIS rings and IDs. The UI retains OpenStreetMap attribution. No proprietary basemap imagery or tile textures are used. Run `node scripts/build-city.mjs` to regenerate `shared/city-data.json` without network access. Shared source vertices still produce 113 safe street intersections, excluding bridges, ramps, water and padded buildings; this geographic metadata remains private to the simulator.

## Match layout and observation isolation

`shared/battlefield.ts` owns the six starting poses, finite resource deposits and player camera focus. `CITY.spawns` derives from that layout for renderer compatibility. The blue team stages at West Third/Plum; red stages at East Third/Broadway. Their starting deposits each contain 80 salvage. The contested deposits contain 220 at Walnut/Third, 180 near Fountain Square at Walnut/Fifth, and 180 at Walnut/Eighth. This is a deliberately placed game economy, not a claim that these locations contain real salvage resources.

The launch groups are approximately 100 simulator units apart. Each drone starts 5–7 units from its deposit and has a clear view and approach. The larger deposits are within 95 units of both teams, with less than 15 units of difference in straight-line access. Real route difficulty is asymmetric because the buildings remain geographic. The match occupies the detailed downtown core; the player overhead initially fits that area, while God view can explore the wider municipality.

These layout coordinates and all calibration values are renderer/simulator data. They must never appear in drone prompts or tool responses. Drones learn through their camera pixels, their own simulator-local position and heading, controller feedback, and actual player/peer messages. Physical signs and salvage props are visible world evidence. The player's omniscient map, resources, opponent state and score remain outside actor observations. The mechanical parents forward instructions without assigning search routes or planning the battle.

## Developer coordinates and collision

The map origin is near Fountain Square at 39.1015°N, 84.512°W. One game unit represents ten meters; X increases east, Z south and Y up. The geographic extent is 30.6 × 20.4 km: X [-1780,1280], Z [-1380,660]. Its southern edge preserves at least a kilometer of margin beyond the municipality. Water polygons are clipped only at these distant outer extents. The controller permits Y [-5,80], including below-ground targets so a mistaken descent can cause a terrain collision. These values remain outside the isolated actor runtime.

Building collisions use swept segments against oriented boxes so a fast step cannot tunnel through a narrow wall. Visual tower tiers and stadium openings share the collision geometry. Drone bodies, terrain impacts, armor consumption, projectile ballistics and match elimination are managed by the RTS simulator. Street signs, park surfaces, resource props and lane paint are scenery; their interaction rules are explicit simulator operations rather than extra invisible obstacle volumes.

The renderer uses instanced buildings, windows and streets, simple lighting and no dynamic shadows. Player views can interpolate motion; tool captures retain the actual timestamped pose and 512×288 camera output. God view has altitude-sensitive travel speed for both street inspection and city traversal. Player overlays never appear in drone captures.

## Validation

`tests/battlefield.test.ts` checks six separated, dry, unobstructed spawns; correct camera aim and safe approaches to starting deposits; finite resources outside buildings/water with multiple mining approaches; comparable travel distances; and unequal city extents that permit terrain contact. `tests/city.test.ts` covers city containment, mapped skyline heights, clear intersections and rotated/swept building geometry. The full RTS test suite additionally exercises combat, resource economy, sensor isolation and native networking.

`CITY-PLAYTEST.md` and earlier treasure-hunt reports describe their historical revisions. They do not establish successful RTS play or validate changes made after those trials. New live gameplay must use the authorized Luna/xhigh actors and a bounded isolated server, preserving the player's active port-4317 session.
