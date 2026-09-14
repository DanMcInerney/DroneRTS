import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const source = JSON.parse(await readFile(new URL('city-research.json', root), 'utf8'));
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
const river = [...source.river.northBank.map(project), { x: 105, z: 125 }, { x: -115, z: 125 }];
const blocked = (x, y, z, padding = 0.8) => buildings.some(b => y >= (b.baseY ?? 0) - 0.2 && y < (b.baseY ?? 0) + b.height + 0.2 && inside(x, z, b, padding));
function freeGround(x, z) {
  for (let ring = 0; ring <= 8; ring++) for (let a = 0; a < 16; a++) {
    const px = x + ring * 0.5 * Math.cos(a * Math.PI / 8), pz = z + ring * 0.5 * Math.sin(a * Math.PI / 8);
    if (!blocked(px, 0.55, pz)) return { x: px, y: 0, z: pz };
  }
  throw new Error('Chest has no clear placement');
}
const roof = id => {
  const b = buildings.find(box => box.id === id);
  if (!b) throw new Error(`Missing rooftop ${id}`);
  return { x: b.x, y: (b.baseY ?? 0) + b.height, z: b.z };
};
const treasures = [freeGround(0, 64), freeGround(-5, -0.3), freeGround(-27, -31), freeGround(69, 4),
  roof('convention-center'), roof('great-american-tower-crown')].map((p, i) => ({ id: `chest-${i + 1}`, ...p, found: false }));
const spawns = [-4, 0, 4].map((x, i) => ({ x, y: 3, z: 69, yaw: [12, 0, -12][i], pitch: -16 }));
if (spawns.some(p => blocked(p.x, p.y, p.z))) throw new Error('Spawn overlaps a building');
const city = { name: 'Downtown Cincinnati', sourceNote: 'OpenStreetMap streets and footprints · researched skyline heights · simplified cubes',
  bounds: { x: [-108, 100], y: [0.6, 40], z: [-85, 85] }, spawns, buildings, roads, parks, river, treasures };
const json = JSON.stringify(city, (_key, value) => typeof value === 'number' ? round(value) : value);
await writeFile(new URL('shared/city-data.json', root), json + '\n');
console.log(`Generated ${buildings.length} collision boxes, ${roads.length} road ways, ${parks.length} parks, ${treasures.length} chests: ${fileURLToPath(new URL('shared/city-data.json', root))}`);
