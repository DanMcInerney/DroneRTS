# Blender city graphics and rooftop navigation

The live renderer loads original Blender assets for the downtown buildings, consumer-style drones, equipment, salvage crates, pallets and service cabinets. The editable sources are `assets/blender/cincinnati.blend` and `assets/blender/drone-kit.blend`; packed PBR façade artwork also lives under `assets/blender/textures/`.

## Visual references

Inspected September 16, 2026:

- [Google Maps satellite imagery](https://www.google.com/maps/@39.1003,-84.511,16z/data=!3m1!1e3), at neighborhood and block scale around Fountain Square, Carew and Queen City Square: charcoal streets, pale sidewalks, warm plaza paving, cream/tar/gravel roofs and restrained green planting. This is a visual reference, not a redistributed basemap.
- The ground follow-up inspected [P&G Gardens](https://www.google.com/maps/@39.10265,-84.50765,18z/data=!3m1!1e3) and the [private fountain court south of Government Square](https://www.google.com/maps/@39.10117,-84.51011,19z/data=!3m1!1e3). P&G has distinct lawn panels, brick promenades and tree borders; the private court is paved rather than grass.

Earlier architectural references, inspected September 15, 2026:

- [DJI Neo product photos](https://www.outdoorphoto.co.za/products/dji-neo-drone): molded shell, four guarded rotors, motor hubs and front camera. The game's design is original and keeps broad team paint; it is not a scale DJI replica.
- [Queen City Square exterior gallery](https://www.queencitysquare.com/great-american-tower/gat-photo-gallery): glass curtain walls, metal framing and the Great American Tower crown.
- [Carew Tower photo collection](https://www.cincydeco.com/buildings/carew-tower): warm masonry, regular window bays, limestone trim and stepped massing.

Reference photographs are not redistributed or used as textures. The façade tiles are original generated artwork. Geographic attribution remains [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), with source details and approximations in [CINCINNATI-SOURCES.md](CINCINNATI-SOURCES.md).

## Rebuild

```powershell
npm run assets:build
npm run build
```

Ground geography is generated separately with `.venv/Scripts/python.exe scripts/build-ground.py` using the ignored local OSM XML cache. On a fresh checkout, add `--download --accessed YYYY-MM-DD` to fetch the official extract. The generated `client/assets/cincinnati-ground.json` is checked in; ordinary builds and play require no network or Python. See [source details](CINCINNATI-SOURCES.md#mapped-ground-surface-detail-september-16-2026).

`scripts/build-graphics.mjs` uses `BLENDER_BIN`, the installed Windows Blender 5.2 path, or `blender` on PATH. The Python authoring script and `scripts/graphics-surfaces.py` run inside Blender, including its bundled NumPy. They write `.blend` sources with packed textures, Meshopt-compressed `.glb` files and `client/assets/manifest.json`. Blender Python exceptions fail the build. No Blender installation is needed to play. Regeneration overwrites generated assets; change the authoring scripts to retain edits across rebuilds. After geographic source changes, run `node scripts/build-city.mjs` before rebuilding graphics.

## Integration and boundaries

- `client/graphics-assets.ts` loads and validates both GLBs before camera readiness. Failed asset loading keeps launch disabled. Vite bundles the GLBs, while the renderer fingerprint hashes them and the manifest with the other client files.
- City material batches include storefront bays, masonry pilasters, cornices, belt courses, glass mullions and crown bracing. Mipmapped 512 px tiles contain original window/reveal/reflection artwork and roughness/metalness channels. Three roof finishes include membrane rolls, repairs, drain bands and flush utility-grille artwork. Surface detail does not invent raised roof obstacles. The export has 25 meshes and 22,558 triangles. Shared texture images have separately owned GPU texture objects; disposing an instance does not dispose another instance's resources.
- `client/daylight.ts` provides a gradient sky, filtered environment reflections and a static 2048 px building shadow map. Only opaque building bodies cast shadows, and the shadow map updates when world geometry changes. Display antialiasing and capped device resolution improve spectator views. Actual acquired images remain 512 × 288, with up to four MSAA samples and the existing JPEG encoding and calibration.
- All 107 source building boxes, rotations, tier elevations and the 820 × 660 m extent remain authoritative. Façade and roof marks are surface detail. `client/urban-ground.ts` and `client/ground-surfaces.ts` paint the 4096 × 3297 core atlas plus a 4096 px wider context atlas. The ground uses actual mapped parking/grass/plaza polygons, path connectivity and tree locations, with original asphalt aggregate, empty parking stalls, mowing bands, brick promenades, sidewalks and road markings. Remaining unclassified gaps receive jointed hardscape. The former uniform horizon is replaced by surrounding mapped land cover, streets, flat footprint artwork and river; only the remote extract edge fades into haze. Ground still requires two draws. Surface finishes, individual stalls and planting sizes remain artistic approximations. No cars or people are added. Current GLBs apply only when the building signature matches their source; historical/custom geometry retains its own renderer.
- `shared/battlefield.ts` adds five physical enclosure boxes to new scenes. `client/arena-boundary.ts` renders these separately as nearly transparent walls and ceiling, with a sparse grid that becomes clearer nearby. Collision, bullets and anonymous finite-range sensors use the same volumes. No opaque wall blocks the skyline. Historical/custom scenes without those explicit obstacles remain unenclosed.
- Great American Tower still has the simulator's simplified solid stepped crown. Its lattice is surface detail; there is no new fly-through opening. This is an initial materials/asset pass, not a survey-grade Cincinnati reconstruction. Individual storefronts, the sculptural fountain and more accurate landmark silhouettes remain future art work.
- Consumer styling keeps the existing oversized simulator airframe envelope. Cargo, armor, equipment visibility, death and acquisition snapshots remain authoritative. The authorized layout changes move the three finite caches to supported roofs; economy and service rules remain unchanged. No resource locator or new sensor is added.

## Verification

`tests/graphics-assets.test.ts` checks source/export hashes, map matching, aircraft bounds, team paint, independent disposal and equipment/cargo states. `scripts/verify-graphics.ts` saves skyline, street, aircraft, crate and acquired-camera views, measures production capture/encoding latency, and checks that a failed asset cannot announce camera readiness. `scripts/verify-rts.ts` covers acquisition snapshots, elimination, camera isolation, hauling, rearming and responsive layout without inference.

Keep related checks in one active managed `FLEET_TEST_RUN`. The graphics fixture requires an idle isolated server and defaults to port 4319 (`FLEET_QA_PORT` overrides it). These fixtures establish rendering and deterministic behavior, not autonomous perception or improved model gameplay.

The initial September 16 graphics revision passed **508 tests**, the TypeScript/Vite build and the deterministic RTS browser fixture. The ground follow-up passed **21 relevant city/graphics/boundary/navigation tests**, source geometry validation, the production build and a fresh graphics browser fixture. The final ground atlas, overhead, gardens, parking, southern planting, skyline and 512 × 288 acquired images were inspected. Asset-failure gating and on/off beacon pixels still pass. Across 30 final captures, encoding/rendering was median **159.5 ms**, p95 **195.8 ms**, maximum **229.1 ms** on this host. The city GLB remains **1,871,448 bytes**. The build retains its existing large-JavaScript-chunk advisory. Evidence and limitations are recorded in [RTS-PLAYTEST.md](RTS-PLAYTEST.md).

## Navigation lights and rooftop layout

Blender-authored upper/lower rotor-guard rings and small airframe lenses double-flash in team colors. Eight low perimeter fixtures alternate around each cargo/base apron: amber for cargo, team colors for bases. Local halos retain depth testing, so buildings occlude them. Empty caches retain their apron fixtures; crash drops receive no new beacon. All lights disappear with an eliminated drone. Spectator animation continues while idle; acquired camera snapshots use the request's simulation timestamp and restore display phases afterward.

Both bases and all three 32 m cargo aprons sit on fully supported roofs and rotate with those roofs. The Westin and Atrium One caches hold 120 each; Dixie Terminal North holds 600. Resource IDs are retained for compatibility. See [CITY.md](CITY.md) for measured placements. Historical cargo-v1/v2 scenes keep non-beacon aprons.
