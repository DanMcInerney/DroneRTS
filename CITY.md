# Cincinnati battlefield

The match is a three-versus-three drone battle in downtown Cincinnati. Each team begins on an open approach to Third Street, facing its own service pad, with 30 shared salvage and no visible opening deposit. Four outer deposits and a central mega deposit draw both teams into the skyline's street corridors. The river, parks, stadiums, rotated blocks and tall buildings create recognizable routes, cover and dangerous corners. Resources are finite and have no geographic ownership: either team can collect cargo from any cache it discovers.

## Geographic basis

The checked-in source dataset contains 16 landmarks, 250 background building footprints, 734 OpenStreetMap road ways and four parks/plazas. `scripts/build-city.mjs` projects the coordinates into a local plane, fits minimum-area oriented rectangles, filters background objects whose centers duplicate landmarks, and makes stepped tower and hollow stadium approximations. The resulting scene has 274 collision boxes. The renderer uses those same boxes, including rotation and tier elevation. Roads retain their mapped turns and the downtown grid's angle.

Great American Tower, Carew Tower, Fourth & Vine, Scripps Center and the other documented towers retain their relative heights. Ten landmark heights have independent published sources. Other building heights, street widths, tower setbacks, flat ground and two plaza outlines are approximations. Fountain Square, Piatt Park, Lytle Park, Smale Riverfront Park, both stadiums and the convention center provide geographic context. The sourced CAGIS Ohio River polygon preserves the winding shoreline and island holes.

The match map is downtown Cincinnati and its riverfront. `shared/downtown.json` owns the extent used by generation, spectator controls and flight target validation. Roads, parks and water are clipped to this area; the wider schematic municipality and its overlay are removed. Continuous background ground extends beyond the map for the horizon, without adding walls or changing the sourced geometry's scale. See [CINCINNATI-SOURCES.md](CINCINNATI-SOURCES.md) for provenance and approximations.

The OSM-derived dataset is in `city-research.json`, with original IDs, source URLs and ODbL attribution. `riverfront-source.json` preserves the CAGIS rings and IDs. The UI retains OpenStreetMap attribution. No proprietary basemap imagery or tile textures are used. Run `node scripts/build-city.mjs` to regenerate `shared/city-data.json` without network access. Shared source vertices still produce 113 safe street intersections, excluding bridges, ramps, water and padded buildings; this geographic metadata remains private to the simulator.

## Match layout and observation isolation

`shared/battlefield.ts` owns six starting poses, friendly service aprons, finite caches and spectator focus. `CITY.spawns` derives from that layout. Blue stages near West Third/Plum; red near East Third/Broadway. Four outer caches at Race/Third, Main/Second, Elm/Fifth and Sycamore/Fifth contain 60 salvage each. The central depot in the open forecourt immediately south of Vine/Third contains 600: about 71% of the 840 available salvage. These are game placements, not claims about real salvage resources.

Outer resource footprints are 2.5–3 local units across; the central forecourt apron is four and base footprints are six. Marked service positions fit three separated airframes. Crates/pallets are matte yellow/ochre with broad top/side symbols; base aprons have team paint, pad marks and service cabinets. Stock, empty pallets and carried cargo reflect authoritative state. The opening has no starting resource pile, and outer caches are outside the initial camera views.

The retained world scale produces deliberately large stylized aircraft: the rotor span is approximately 0.53 × 0.49 local units (5.3 × 4.9 meters), and collision radius is 0.38 units (3.8 meters). The closest pair of service marks on the smallest 2.5-unit apron is 1.6 units apart, exceeding the 0.76-unit collision diameter. This audit establishes simulator clearance, not realistic small-quadcopter dimensions or hardware readiness. No geometry was silently rescaled.

The launch groups are approximately 100 simulator units apart. Real route difficulty remains asymmetric because the geographic buildings remain in place. Layout tests compare street access and collision clearance, not just straight-line distance. The downtown map contains the complete match.

Battlefield coordinates, resource/base placement, opponent telemetry and internal geometry stay private. Own vehicle axes, units, camera calibration, actuator limits and finite sensor coverage are now authorized actor knowledge. Drones learn actual scenery from their camera pixels and local anonymous ranges, plus received peer/player messages. The player's full map, resource counts and scores remain separate. Parents do not assign routes or solve the battle.

## Coordinates, collision and visual state

The map origin is near Fountain Square at 39.1015°N, 84.512°W. One game unit represents ten meters; X increases east, Z south and Y up. Map extent is 2.4 × 1.9 km: X [-125,115], Z [-90,100], with vertical limits Y [-5,80]. This includes the sourced downtown core, stadiums and riverfront. Water is clipped at these map extents. Controller target limits and geographic coordinates remain developer data; exposing a vehicle's unit conversion does not reveal battlefield bounds.

Building collisions use swept segments against oriented boxes. Renderer and collision share rotated footprints, tower tiers and stadium openings. The RTS simulator owns drone bodies, terrain impacts, armor, projectile trajectories and destruction. Streets, signs, aprons, crates and cargo props add no unexpected solid collision clutter.

Cargo service uses the horizontal marked apron and the shared 0.6–2.4-local-unit hover band above its surface, with speed at most 0.3 local units/s. Pickup requires three simulation seconds and unloading two. Refitting/rearming uses drone-center occupancy inside the friendly painted base footprint from 0 through 6 local units above its surface; cargo unloading separately requires the low/slow conditions. Current matches have no battery or charging system. The source contracts in `shared/rts.ts` govern both rules and presentation.

City presentation separates asphalt, sidewalks, walls and roofs through broad value/color differences and restrained grounding. Own-drone feeds remain finite 512×288 acquired images with real occlusion. Drone bodies and arms carry broad blue/cyan or red/coral panels. A higher camera can see different surfaces but receives no altitude-triggered resource detector. Watchable spectator views are not proof of recognizable camera pixels.

## Validation

`tests/battlefield.test.ts` checks separated dry spawns, intersection placement, rotated/tiered building clearance, multiple service positions, hidden opening resources and comparable usable street access. `tests/city.test.ts` covers containment, skyline heights, clear intersections and swept building geometry. Cargo/control tests separately check authoritative service and finite-range assistance.

Camera QA should inspect identical acquired low/oblique/overhead poses, behind-building negatives, partial/empty stock, attached cargo, both teams and both bases. A useful recognition altitude and six-feed rendering cost must be measured from the current source rather than inferred from spectator screenshots. Actual route geometry remains asymmetric; balanced competition is not established by map layout alone.

`CITY-PLAYTEST.md` and earlier treasure-hunt reports describe historical revisions. Current cargo recognition and autonomous haul results belong in `RTS-PLAYTEST.md`, with source manifest and fixture boundaries. Live gameplay uses bounded isolated Luna/xhigh actors while preserving the player's active port-4317 session.
