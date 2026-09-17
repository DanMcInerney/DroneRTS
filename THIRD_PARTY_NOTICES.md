# Third-party notices and source attribution

The [MIT license](LICENSE) covers DroneRTS's original code and artwork. Dependencies and external geographic data retain their own terms; the project license does not replace them.

## Geography and artwork

- **© OpenStreetMap contributors.** `city-research.json` contains OSM-derived footprints and roads with source IDs and URLs. Derived city geometry and artwork using that geography retain the [Open Database License attribution](https://www.openstreetmap.org/copyright). Preserve the in-app credit and source metadata.
- **Cincinnati Area Geographic Information System (CAGIS).** `riverfront-source.json` preserves separately sourced water geometry and identifiers. See [CINCINNATI-SOURCES.md](CINCINNATI-SOURCES.md) for the original services, provenance, and reuse notes.
- Building heights and landmark details use the individual sources in [CINCINNATI-SOURCES.md](CINCINNATI-SOURCES.md). The resulting city is an approximation, not a survey or digital twin.
- Blender models, textures, and street props were authored for this project. [GRAPHICS.md](GRAPHICS.md) records visual references and approximations. Referenced Google imagery is not redistributed as textures.

## Software

JavaScript packages are recorded in `package-lock.json`; native Python requirements are in `network/requirements.txt`. Retain their shipped license and notice files when redistributing dependencies. [ONBOARD-PACKAGE-MANIFEST.json](ONBOARD-PACKAGE-MANIFEST.json) records the measured onboard package and its dependency notices; it is not an inventory of every host tool.

The pinned **[Nervelet 0.2.0 npm release](https://www.npmjs.com/package/nervelet/v/0.2.0) is MIT licensed**, copyright 2026 Dan McInerney. Its package includes `LICENSE`, which is measured and retained in the onboard deployment. The registry URL and integrity are pinned in `package-lock.json`; [Nervelet integration](NERVELET-INTEGRATION.md) and [npm qualification](https://github.com/DanMcInerney/DroneRTS/blob/72717d725166f5e4dca1870c55640152ed9e0d49/NERVELET-NPM-QA.md) record the dependency identity and validation. Earlier reports describing an unlicensed source archive are historical.
