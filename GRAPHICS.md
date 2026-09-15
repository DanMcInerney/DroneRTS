# Blender graphics — first pass

The live renderer loads original Blender assets for the downtown buildings, consumer-style drones, equipment, salvage crates, pallets and service cabinets. The editable sources are `assets/blender/cincinnati.blend` and `assets/blender/drone-kit.blend`; packed PBR façade artwork also lives under `assets/blender/textures/`.

## Visual references

Inspected September 15, 2026:

- [DJI Neo product photos](https://www.outdoorphoto.co.za/products/dji-neo-drone): molded shell, four guarded rotors, motor hubs and front camera. The game's design is original and keeps broad team paint; it is not a scale DJI replica.
- [Queen City Square exterior gallery](https://www.queencitysquare.com/great-american-tower/gat-photo-gallery): glass curtain walls, metal framing and the Great American Tower crown.
- [Carew Tower photo collection](https://www.cincydeco.com/buildings/carew-tower): warm masonry, regular window bays, limestone trim and stepped massing.

Reference photographs are not redistributed or used as textures. The façade tiles are original generated artwork. Geographic attribution remains [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), with source details and approximations in [CINCINNATI-SOURCES.md](CINCINNATI-SOURCES.md).

## Rebuild

```powershell
npm run assets:build
npm run build
```

`scripts/build-graphics.mjs` uses `BLENDER_BIN`, the installed Windows Blender 5.2 path, or `blender` on PATH. The Python authoring script runs inside Blender, including its bundled NumPy. It writes `.blend` sources with packed textures, Meshopt-compressed `.glb` files and `client/assets/manifest.json`. No Blender installation is needed to play. Regeneration overwrites generated assets; change `scripts/build-graphics.py` to retain edits across rebuilds. After geographic source changes, run `node scripts/build-city.mjs` before rebuilding graphics.

## Integration and boundaries

- `client/graphics-assets.ts` loads and validates both GLBs before camera readiness. Failed asset loading keeps launch disabled. Vite bundles the GLBs, while the renderer fingerprint hashes them and the manifest with the other client files.
- City material batches replace the old sparse façade geometry. Mipmapped 512 px tiles contain original window/reveal artwork and roughness/metalness channels. Shared texture images have separately owned GPU texture objects; disposing an instance does not dispose another instance's materials or geometry.
- `client/daylight.ts` provides a gradient sky, filtered environment reflections and a static 2048 px building shadow map. Only opaque building bodies cast shadows, and the shadow map updates when world geometry changes. Display antialiasing and capped device resolution improve spectator views. Actual acquired images remain 512 × 288, with up to four MSAA samples and the existing JPEG encoding and calibration.
- All 107 source building boxes, rotations, tier elevations and the 820 × 660 m extent remain authoritative. Façade and roof marks are flush surface detail. Roads and geographic ground surfaces remain sourced procedural geometry. Current GLBs apply only when the obstacle signature matches their source; historical/custom geometry retains its own renderer.
- Great American Tower still has the simulator's simplified solid stepped crown. Its lattice is surface detail; there is no new fly-through opening. This is an initial materials/asset pass, not a survey-grade Cincinnati reconstruction. Individual storefronts, the sculptural fountain and more accurate landmark silhouettes remain future art work.
- Consumer styling keeps the existing oversized simulator airframe envelope. Cargo, armor, equipment visibility, death and acquisition snapshots remain authoritative; no resource locators, additional sensors, flight dynamics or gameplay changes were added.

## Verification

`tests/graphics-assets.test.ts` checks source/export hashes, map matching, aircraft bounds, team paint, independent disposal and equipment/cargo states. `scripts/verify-graphics.ts` saves skyline, street, aircraft, crate and acquired-camera views, measures production capture/encoding latency, and checks that a failed asset cannot announce camera readiness. `scripts/verify-rts.ts` covers acquisition snapshots, elimination, camera isolation, hauling, rearming and responsive layout without inference.

Keep related checks in one active managed `FLEET_TEST_RUN`. The graphics fixture requires an idle isolated server and defaults to port 4319 (`FLEET_QA_PORT` overrides it). These fixtures establish rendering and deterministic behavior, not autonomous perception or improved model gameplay.

## Navigation lights and cargo-v3 layout

Blender-authored upper/lower rotor-guard light rings use a team-tinted emissive material. They stay on while the airframe is alive, obey ordinary scene occlusion and disappear with the drone. No screen-space marker or sensing capability is added. Both base aprons rotate with their existing rooftops; three street caches use the same rotated footprint in rendering and cargo/service rules. See CITY.md for measured placements.
