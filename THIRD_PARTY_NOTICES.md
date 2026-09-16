# Third-party notices and source attribution

The [MIT license](LICENSE) covers DroneRTS's original code and artwork. Dependencies and external geographic data retain their own terms; the project license does not replace them.

## Geography and artwork

- **© OpenStreetMap contributors.** `city-research.json` contains OSM-derived footprints and roads with source IDs and URLs. Derived city geometry and artwork using that geography retain the [Open Database License attribution](https://www.openstreetmap.org/copyright). Preserve the in-app credit and source metadata.
- **Cincinnati Area Geographic Information System (CAGIS).** `riverfront-source.json` preserves separately sourced water geometry and identifiers. See [CINCINNATI-SOURCES.md](CINCINNATI-SOURCES.md) for the original services, provenance, and reuse notes.
- Building heights and landmark details use the individual sources in [CINCINNATI-SOURCES.md](CINCINNATI-SOURCES.md). The resulting city is an approximation, not a survey or digital twin.
- Blender models, textures, and street props were authored for this project. [GRAPHICS.md](GRAPHICS.md) records visual references and approximations. Referenced Google imagery is not redistributed as textures.

## Software

JavaScript packages are recorded in `package-lock.json`; native Python requirements are in `network/requirements.txt`. Retain their shipped license and notice files when redistributing dependencies. [ONBOARD-PACKAGE-MANIFEST.json](ONBOARD-PACKAGE-MANIFEST.json) records the measured onboard package and its dependency notices; it is not an inventory of every host tool.

The pinned **Nervelet 0.2.0 source revision `6c36b0a4845c72ac2aa9fba85df7ea3d8389ff8c` declares no license**. Public source availability does not resolve that missing declaration. Obtain an explicit upstream license covering the pinned source, or review and qualify a licensed revision before presenting the complete dependency stack as open source. Do not silently change the pin or its checksums. The exact build contract is in [NERVELET-INTEGRATION.md](NERVELET-INTEGRATION.md).
