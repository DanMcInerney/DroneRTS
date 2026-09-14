# Cincinnati battlefield source notes

Research collected September 14, 2026 UTC (September 13 in Cincinnati). The accompanying `city-research.json` is a deliberately simple geographic scene dataset, not a survey or digital twin.

## Geometry and placement

The building and street coordinates are a fresh extract of **OpenStreetMap ways**, retrieved from the [Kumi Overpass endpoint](https://overpass.kumi.systems/api/interpreter). Every mapped object contains its original OSM way ID, a direct source URL and its latitude/longitude polygon or polyline. The extract covers downtown between 39.094–39.1085°N and 84.524–84.501°W: approximately 1.61 km north–south and 1.99 km east–west. The initial query extended north to 39.111; retained objects were cropped to the smaller downtown area.

There are **16 landmarks, 250 background building footprints, 734 named road segments and four parks/plazas**. Background selection favors the 250 largest mapped envelopes, excluding landmark IDs. This is a useful city massing sample rather than every building. Road entries preserve OSM segmentation at crossings; repeated street names are intentional. Short gaps at the outer crop are possible because segments crossing the boundary were omitted. Road widths are schematic unless a width tag was available.

Use the supplied footprint polygons to fit rotated cuboids or extrude simple shapes. The `widthM` and `depthM` convenience fields on landmarks are axis-aligned bounding envelopes, **not** fitted rectangles. Stretching those envelopes onto axis-aligned boxes can intrude into streets. Minimum-area oriented rectangles, slightly inset, preserve the downtown grid much better; large irregular complexes should be split into a few boxes. Stadium site polygons should become low hollow bowls, with an open field.

The downtown grid is rotated from true compass axes: numbered streets run east–west with a slight northeasterly slant, while Vine, Walnut, Main, Sycamore, Broadway, Race and Elm provide the north–south corridors. Keep their mapped geometry rather than imposing a Manhattan grid. Fountain Square lies north of Fifth and east of Vine; Fifth Third Center is at its east/northeast edge, Carew Tower southwest, Fourth & Vine farther south, Scripps near Third and Walnut, and Great American Tower southeast near the Fourth/Broadway block. The convention center occupies a broad, low footprint west of the tower cluster. These relationships come directly from the linked OSM footprints and centerlines in the dataset.

The two stadium outlines, [Great American Ball Park](https://www.openstreetmap.org/way/24587940) and [Paycor Stadium](https://www.openstreetmap.org/way/210540615), place the sports landmarks southeast and southwest of the central towers. The [Reds' venue facts](https://www.mlb.com/reds/ballpark/information/facts) confirm the ballpark's Ohio River setting. The [Bengals' stadium history](https://www.bengals.com/stadium/history) confirms the current Paycor name.

## Landmark heights

Architectural heights include architectural crowns, but do not necessarily include flagpoles or antennas. Ten landmark heights are documented by an engineering/project source or the Council on Vertical Urbanism's Skyscraper Center database. The latter historically used the name CTBUH.

| Landmark | Height used | Source |
| --- | ---: | --- |
| Great American Tower | 202.7 m / 665 ft | [Structural engineer Thornton Tomasetti](https://www.thorntontomasetti.com/project/great-american-tower-queen-city-square), [Skyscraper Center](https://www.skyscrapercenter.com/building/great-american-tower-at-queen-city-square/1636) |
| Carew Tower | 175 m | [Skyscraper Center](https://www.skyscrapercenter.com/building/carew-tower/2528) |
| Fourth & Vine Tower, historic PNC Tower | 150.9 m | [Skyscraper Center](https://www.skyscrapercenter.com/building/pnc-tower/3949) |
| Scripps Center | 142.7 m | [Skyscraper Center](https://www.skyscrapercenter.com/building/scripps-center/10533) |
| Fifth Third Center | 129 m | [Skyscraper Center](https://www.skyscrapercenter.com/building/fifth-third-center/10534) |
| Center at 600 Vine | 127.4 m | [Skyscraper Center city data](https://www.skyscrapercenter.com/city/cincinnati) |
| Chemed Center / First Financial Center at 255 Fifth | 125 m | [Skyscraper Center city data](https://www.skyscrapercenter.com/city/cincinnati), [mapped current name and footprint](https://www.openstreetmap.org/way/46703730) |
| Hilton Cincinnati Netherland Plaza | 113.4 m | [Skyscraper Center](https://www.skyscrapercenter.com/building/hilton-cincinnati-netherland-plaza/21078) |
| Columbia Plaza / Chiquita Center | 112.2 m | [Skyscraper Center city data](https://www.skyscrapercenter.com/city/cincinnati), [mapped current name](https://www.openstreetmap.org/way/28719627) |
| PNC Center | 108 m | [Skyscraper Center city data](https://www.skyscrapercenter.com/city/cincinnati) |

Great American Tower's engineering [project sheet](https://thornton.s3.amazonaws.com/content_files/689/GreatAmericanTower_Project_Sheet.pdf) gives a 130-foot-tall crown. For simple recognition, make the main prism about 163 m tall and add a pale, stepped/open crown reaching the documented total. Carew should use a tan stepped form. These are artistic simplifications, not architectural reconstruction instructions.

The convention center, Freedom Center, P&G Tower, Heritage Bank Center and stadium heights are **estimates**. The convention center's 24 m comes from an OSM tag; the others use simple visual massing estimates. No claim is made that these are measured heights. Background heights likewise remain `estimated`, even when an OSM height tag is present, because they were not independently corroborated. When only floor count is mapped, the explicit fallback is `levels × 3.6 m + 2 m`; absent both height and floor count, the fallback is 12–18 m depending on type. Each record states which method was used.

The convention venue is now named **First Financial Center**, which the [current operator website](https://thefirstfinancialcenter.com/) verifies. Its familiar former name, Duke Energy Convention Center, is retained in the scene label for recognition. This is a different building from the tower at 255 Fifth.

## Parks, river and coordinate assumptions

[Piatt Park](https://www.openstreetmap.org/way/34230762) and [Lytle Park](https://www.openstreetmap.org/way/31009000) use mapped OSM polygons. Fountain Square's surface is a small schematic polygon consistent with the [operator's Fifth and Vine location](https://myfountainsquare.wordpress.com/about/). Smale's polygon is a simplified terrace band informed by the [city's park map and feature description](https://www.cincinnati-oh.gov/cincyparks/visit-a-park/find-a-parkfacility/smale-riverfront-park/smale-park-map-with-features/). These two surface outlines remain **estimated**.

The initial estimated river polyline has been replaced by [CAGIS Countywide Water Bodies](https://services.arcgis.com/JyZag7oO4NteHGiq/ArcGIS/rest/services/Open_Data_Feature_Collection/FeatureServer/23), feature 3817, marked `2024AERIAL`, acquired September 14, 2026. Its geographic polygon rings include the Ohio River and connected waterways; the renderer clips them to the geographic extent and retains enclosed island holes. [CAGIS Cincinnati City Boundary](https://services.arcgis.com/JyZag7oO4NteHGiq/ArcGIS/rest/services/Open_Data_Feature_Collection/FeatureServer/28), feature 1, determines the full-city extent. Raw source coordinates and provenance are preserved in `riverfront-source.json`. The southern edge lies beyond the boundary's southernmost latitude, 39.05207°N, with a one-kilometer margin. The resulting 30.6 × 20.4 km unequal extent encloses the full municipality; detailed building/road reconstruction remains confined to the existing downtown OSM dataset. Continuous ground replaces the former square slab. The faint municipal terrain tint indicates the sourced jurisdiction boundary, not measured land use. Flat terrain, polygon clipping and local projection are game approximations, not survey-grade geography.

Use the local origin 39.1015°N, 84.512°W near Fountain Square. The file supplies a local equirectangular projection: X east, Z south, height up. The suggested game scale is 0.1 world units per metre. Ground elevation is flattened, so the riverfront's real terraces, ramps and downtown slopes are not reproduced. Keep this metadata and scene geometry inaccessible to the agents: the research supports rendering and collision, not a map or movement calibration in their prompts.

The RTS starting positions and five salvage deposits are designed game placements on unobstructed mapped street approaches. They are not source-data claims. Their finite capacities, team access and camera-facing layout are defined in `shared/battlefield.ts` and validated independently of source regeneration. All six actors must discover their surroundings through their own cameras and local sensors.

## Attribution and reuse

Display **“Map data © OpenStreetMap contributors”** in the game with a link to [OpenStreetMap copyright and license](https://www.openstreetmap.org/copyright). The OSM-derived geographic dataset is under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). This JSON preserves object provenance and includes those license links. No proprietary basemap imagery or downloaded map tiles are used.
