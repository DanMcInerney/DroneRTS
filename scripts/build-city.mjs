import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const source = JSON.parse(await readFile(new URL('city-research.json', root), 'utf8'));
const riverSource = JSON.parse(await readFile(new URL('riverfront-source.json', root), 'utf8'));
const round = n => Math.round(n * 1000) / 1000;
const project = p => ({ x: (p.lon - source.origin.lon) * source.projection.metersPerDegreeLongitude * 0.1,
  z: (source.origin.lat - p.lat) * source.projection.metersPerDegreeLatitude * 0.1 });

function fit(item) {
  const points = item.footprint.map(project);
  let best;
  // Minimum-area enclosing rectangle over polygon-edge orientations; flattening is intentional.
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x, dz = points[i].z - points[i - 1].z;
    if (Math.hypot(dx, dz) < 0.1) continue;
    const theta = Math.atan2(dz, dx), c = Math.cos(theta), s = Math.sin(theta);
    const u = points.map(p => p.x * c + p.z * s), v = points.map(p => -p.x * s + p.z * c);
    const width = Math.max(...u) - Math.min(...u), depth = Math.max(...v) - Math.min(...v);
    const cx = (Math.max(...u) + Math.min(...u)) / 2, cz = (Math.max(...v) + Math.min(...v)) / 2;
    if (!best || width * depth < best.area) best = { x: cx * c - cz * s, z: cx * s + cz * c,
      width, depth, rotation: -theta * 180 / Math.PI, area: width * depth };
  }
  if (!best) throw new Error(`No usable footprint: ${item.id}`);
  const { area, ...box } = best;
  return { ...box, height: item.heightM * 0.1, id: item.id, name: item.name, color: item.color };
}
function inside(x, z, box, padding = 0) {
  const a = (box.rotation ?? 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return Math.abs(c * (x - box.x) - s * (z - box.z)) <= box.width / 2 + padding
    && Math.abs(s * (x - box.x) + c * (z - box.z)) <= box.depth / 2 + padding;
}
function localBox(parent, id, width, depth, x, z, height, baseY = 0) {
  const a = parent.rotation * Math.PI / 180;
  return { ...parent, id: `${parent.id}-${id}`, x: parent.x + x * Math.cos(a) + z * Math.sin(a),
    z: parent.z - x * Math.sin(a) + z * Math.cos(a), width, depth, height, baseY };
}
const landmarkBoxes = source.landmarks.map(fit);
const palette = ['#adbec3', '#d2c6b2', '#a8b5bb', '#baa995', '#b6c4c7', '#c3b5a4', '#d5cec0'];
const buildings = source.buildings.map(fit).filter(box => Math.abs(box.x) < 104 && box.z > -81 && box.z < 82
  && !landmarkBoxes.some(landmark => inside(box.x, box.z, landmark, 0.25)))
  .map((box, i) => ({ ...box, color: palette[i % palette.length] }));
for (let i = 0; i < landmarkBoxes.length; i++) {
  const b = landmarkBoxes[i], record = source.landmarks[i];
  if (record.kind === 'stadium') {
    const wall = Math.min(b.width, b.depth) * 0.18;
    buildings.push(localBox(b, 'north', b.width, wall, 0, -(b.depth - wall) / 2, b.height),
      localBox(b, 'south', b.width, wall, 0, (b.depth - wall) / 2, b.height * 0.65),
      localBox(b, 'east', wall, b.depth - 2 * wall, (b.width - wall) / 2, 0, b.height * 0.85),
      localBox(b, 'west', wall, b.depth - 2 * wall, -(b.width - wall) / 2, 0, b.height * 0.85));
  } else if (['carew-tower', 'fourth-vine-tower', 'great-american-tower'].includes(b.id)) {
    // Three solid box tiers approximate the skyline; tiers share render and collision geometry.
    const base = b.height * 0.63, middle = b.height * 0.24, crown = b.height - base - middle;
    buildings.push(localBox(b, 'base', b.width, b.depth, 0, 0, base),
      localBox(b, 'middle', b.width * 0.76, b.depth * 0.76, 0, 0, middle, base),
      localBox(b, 'crown', b.width * 0.48, b.depth * 0.48, 0, 0, crown, base + middle));
  } else buildings.push(b);
}
const roads = source.roads.map(road => ({ name: road.name, width: road.widthM * 0.1, points: road.points.map(project) }));
const parks = source.parks.map(park => ({ name: park.name, points: park.points.map(project), color: park.id === 'fountain-square' ? '#d8d1bb' : '#94ad7b' }));
const northBank = riverSource.northBank.map(project).sort((a, b) => a.x - b.x);
const blocked = (x, y, z, padding = 0.8) => buildings.some(b => y >= (b.baseY ?? 0) - 0.2 && y < (b.baseY ?? 0) + b.height + 0.2 && inside(x, z, b, padding));
const cityBoundary = riverSource.cityBoundary.map(ring => ring.map(([lon, lat]) => project({ lon, lat })));
const cityPoints = cityBoundary.flat();
const west = Math.floor(Math.min(...cityPoints.map(p => p.x)) / 10) * 10 - 40;
const east = Math.ceil(Math.max(...cityPoints.map(p => p.x)) / 10) * 10 + 40;
const south = Math.ceil(Math.max(...cityPoints.map(p => p.z)) / 10) * 10 + 100;
const north = Math.floor(Math.min(...cityPoints.map(p => p.z)) / 10) * 10 - 40;
// Follow the municipality's unequal geographic extents. These are distant
// controller limits; the renderer uses continuous terrain with no cube walls.
// Below-ground waypoints are accepted so terrain contact can crash a drone.
const bounds = { x: [west, east], y: [-5, 80], z: [north, south] };
// Clip distant water geometry at the geographic extent, retaining the winding
// shore and islands. The southern margin preserves the complete riverfront.
function clipRing(ring) {
  for (const [axis, edge, direction] of [['x', bounds.x[0], 1], ['x', bounds.x[1], -1], ['z', bounds.z[0], 1], ['z', bounds.z[1], -1]]) {
    const result = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length], b = ring[i];
      const inA = (a[axis] - edge) * direction >= 0, inB = (b[axis] - edge) * direction >= 0;
      if (inA !== inB) { const t = (edge - a[axis]) / (b[axis] - a[axis]); result.push({ x: a.x + t * (b.x - a.x), z: a.z + t * (b.z - a.z) }); }
      if (inB) result.push(b);
    }
    ring = result;
  }
  return ring;
}
const waterRings = riverSource.waterRings.map(ring => clipRing(ring.map(([lon, lat]) => project({ lon, lat })))).filter(ring => ring.length > 2);
const river = waterRings[0], riverHoles = waterRings.slice(1);
function shorelineZ(x) {
  for (let i = 1; i < northBank.length; i++) {
    const a = northBank[i - 1], b = northBank[i];
    if (x >= a.x && x <= b.x) return a.z + (b.z - a.z) * (x - a.x) / (b.x - a.x);
  }
  return x < northBank[0].x ? northBank[0].z : northBank.at(-1).z;
}
// Exact shared source vertices preserve mapped connectivity. Geometric line crossings
// would incorrectly create junctions beneath elevated roads that do not connect.
const junctions = new Map();
for (const road of source.roads) {
  if (!road.name || /(?:motorway|trunk|_link)/.test(road.kind) || /bridge|viaduct|ramp/i.test(road.name)) continue;
  road.points.forEach((point, index) => {
    const key = `${point.lat.toFixed(7)},${point.lon.toFixed(7)}`;
    const projected = project(point);
    const junction = junctions.get(key) ?? { ...projected, streets: new Set(), directions: [] };
    junction.streets.add(road.name);
    for (const neighbour of [road.points[index - 1], road.points[index + 1]]) {
      if (!neighbour) continue;
      const near = project(neighbour), angle = Math.atan2(near.z - projected.z, near.x - projected.x);
      if (Math.hypot(near.x - projected.x, near.z - projected.z) < 0.02) continue;
      if (!junction.directions.some(other => Math.abs(Math.atan2(Math.sin(angle - other), Math.cos(angle - other))) < Math.PI / 12)) {
        junction.directions.push(angle);
      }
    }
    junctions.set(key, junction);
  });
}
const intersections = [...junctions.values()].filter(point => point.streets.size >= 2 && point.directions.length >= 3
  && point.x > bounds.x[0] + 2 && point.x < bounds.x[1] - 2 && point.z > bounds.z[0] + 2 && point.z < bounds.z[1] - 2
  && point.z < shorelineZ(point.x) - 2 && !blocked(point.x, 0.55, point.z, 1))
  .sort((a, b) => a.x - b.x || a.z - b.z)
  .filter((point, index, all) => !all.slice(0, index).some(other => Math.hypot(point.x - other.x, point.z - other.z) < 2.3))
  .map((point, index) => ({ id: `intersection-${index + 1}`, x: point.x, z: point.z, streets: [...point.streets].sort() }));
if (intersections.length < 12) throw new Error('Need at least twelve safe street intersections to randomize each reset');
const city = { name: 'Cincinnati · Ohio River', sourceNote: 'OpenStreetMap streets and footprints · CAGIS city boundary and Ohio River · researched skyline heights · simplified terrain and architecture',
  bounds, buildings, roads, parks, river, riverHoles, cityBoundary, intersections };
const json = JSON.stringify(city, (_key, value) => typeof value === 'number' ? round(value) : value);
await writeFile(new URL('shared/city-data.json', root), json + '\n');
console.log(`Generated ${buildings.length} collision boxes, ${roads.length} road ways, ${parks.length} parks, ${intersections.length} safe intersections: ${fileURLToPath(new URL('shared/city-data.json', root))}`);
