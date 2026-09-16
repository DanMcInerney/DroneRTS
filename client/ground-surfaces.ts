import type { CityPoint } from '../shared/city';
import mapped from './assets/cincinnati-ground.json';

type Brush = CanvasRenderingContext2D;
type Polygon = { points: CityPoint[]; holes?: CityPoint[][] };
type Area = Polygon & { id: string; name: string; kind: string; surface?: string; detail?: string };

/** Geographic artwork is renderer-only; never part of an onboard observation bundle. */
export const GROUND = mapped;

export function randomGenerator(seed: number) {
  return () => { seed = Math.imul(seed ^ seed >>> 15, 1 | seed); seed ^= seed + Math.imul(seed ^ seed >>> 7, 61 | seed); return ((seed ^ seed >>> 14) >>> 0) / 4294967296; };
}

export function path(ctx: Brush, points: CityPoint[], close = false) {
  ctx.beginPath();
  points.forEach((point, index) => index ? ctx.lineTo(point.x, point.z) : ctx.moveTo(point.x, point.z));
  if (close) ctx.closePath();
}

function polygonPath(ctx: Brush, polygon: Polygon) {
  path(ctx, polygon.points, true);
  for (const hole of polygon.holes ?? []) {
    hole.forEach((point, index) => index ? ctx.lineTo(point.x, point.z) : ctx.moveTo(point.x, point.z)); ctx.closePath();
  }
}

function extent(points: CityPoint[]) {
  return { x0: Math.min(...points.map(p => p.x)), x1: Math.max(...points.map(p => p.x)),
    z0: Math.min(...points.map(p => p.z)), z1: Math.max(...points.map(p => p.z)) };
}

/** Canvas pattern includes visible weathering as well as fine aggregate. No aerial pixels. */
export function grainPattern(ctx: Brush, color: string, seed: number, contrast: number) {
  const tile = document.createElement('canvas'); tile.width = tile.height = 256;
  const brush = tile.getContext('2d')!; brush.fillStyle = color; brush.fillRect(0, 0, 256, 256);
  const data = brush.getImageData(0, 0, 256, 256), random = randomGenerator(seed);
  for (let index = 0; index < data.data.length; index += 4) {
    const x = (index / 4) % 256, y = Math.floor(index / 1024);
    const noise = (random() - .5) * contrast + Math.sin(x / 29) * Math.cos(y / 23) * contrast * .22;
    for (let channel = 0; channel < 3; channel++) data.data[index + channel] += noise;
  }
  brush.putImageData(data, 0, 0);
  const pattern = ctx.createPattern(tile, 'repeat')!;
  pattern.setTransform(new DOMMatrix().scale(.016, .016));
  return pattern;
}

/** Neutral areas are jointed hardscape, with paving rather than a blank color. */
export function drawPaving(ctx: Brush, bounds: { x: number[]; z: number[] }) {
  const tile = document.createElement('canvas'); tile.width = tile.height = 512;
  const b = tile.getContext('2d')!, random = randomGenerator(801);
  b.fillStyle = '#756f62'; b.fillRect(0, 0, 512, 512);
  const colors = ['#9c9686', '#aaa18f', '#a49c8b', '#948f80', '#a09986', '#a8a08e'];
  for (let row = 0; row < 16; row++) for (let column = 0; column < 16; column++) {
    b.fillStyle = colors[Math.floor(random() * colors.length)];
    b.fillRect(column * 32 + 1, row * 32 + 1, 31, 31);
    b.fillStyle = '#c4bda324'; b.fillRect(column * 32 + 2, row * 32 + 2, 28, 1);
  }
  const pixels = b.getImageData(0, 0, 512, 512);
  for (let n = 0; n < pixels.data.length; n += 4) {
    const variation = (random() - .5) * 14;
    for (let channel = 0; channel < 3; channel++) pixels.data[n + channel] += variation;
  }
  b.putImageData(pixels, 0, 0);
  const pattern = ctx.createPattern(tile, 'repeat')!;
  pattern.setTransform(new DOMMatrix().rotate(-11).scale(.013, .013));
  ctx.fillStyle = pattern; ctx.fillRect(bounds.x[0], bounds.z[0], bounds.x[1] - bounds.x[0], bounds.z[1] - bounds.z[0]);
}

function parking(ctx: Brush, area: Area, seed: number) {
  const box = extent(area.points);
  polygonPath(ctx, area); ctx.fillStyle = grainPattern(ctx, '#424845', seed, 22); ctx.fill('evenodd');
  ctx.strokeStyle = '#b9b39d'; ctx.lineWidth = .045; ctx.stroke();
  ctx.save(); polygonPath(ctx, area); ctx.clip('evenodd');
  // Align stalls to the longest sourced lot edge. A 5m bay / 6m aisle fits real vehicles,
  // but all spaces remain empty, as requested.
  let edge = 0, longest = 0;
  area.points.forEach((p, i) => { const next = area.points[(i + 1) % area.points.length], length = Math.hypot(next.x - p.x, next.z - p.z);
    if (length > longest) { longest = length; edge = i; } });
  const a = area.points[edge], b = area.points[(edge + 1) % area.points.length];
  const angle = Math.atan2(b.z - a.z, b.x - a.x);
  const local = area.points.map(p => ({ x: (p.x - a.x) * Math.cos(angle) + (p.z - a.z) * Math.sin(angle),
    z: -(p.x - a.x) * Math.sin(angle) + (p.z - a.z) * Math.cos(angle) }));
  const e = extent(local), random = randomGenerator(seed);
  ctx.translate(a.x, a.z); ctx.rotate(angle);
  for (let z = e.z0 + .12; z < e.z1; z += 1.65) {
    for (const side of [0, 1.1]) {
      ctx.strokeStyle = '#d8d4b8'; ctx.lineWidth = .022;
      ctx.beginPath(); ctx.moveTo(e.x0 + .12, z + side); ctx.lineTo(e.x1 - .12, z + side); ctx.stroke();
      for (let x = e.x0 + .12; x < e.x1; x += .27) {
        ctx.beginPath(); ctx.moveTo(x, z + side); ctx.lineTo(x, z + side + (side ? -.5 : .5)); ctx.stroke();
        ctx.fillStyle = '#c1beab'; ctx.fillRect(x + .06, z + side + (side ? -.075 : .045), .15, .025);
      }
    }
    // Direction arrows in the aisle, flush to the tarmac.
    for (let x = e.x0 + 1; x < e.x1 - .5; x += 2.5) {
      ctx.strokeStyle = '#c0c2ad'; ctx.lineWidth = .025; ctx.beginPath();
      ctx.moveTo(x, z + .8); ctx.lineTo(x + .3, z + .8); ctx.lineTo(x + .21, z + .72);
      ctx.moveTo(x + .3, z + .8); ctx.lineTo(x + .21, z + .88); ctx.stroke();
    }
  }
  ctx.strokeStyle = '#242f2c66'; ctx.lineWidth = .012;
  for (let n = 0; n < (box.x1 - box.x0) * (box.z1 - box.z0); n++) {
    const x = e.x0 + random() * (e.x1 - e.x0), z = e.z0 + random() * (e.z1 - e.z0);
    ctx.beginPath(); ctx.moveTo(x, z); ctx.lineTo(x + .08, z + .13); ctx.lineTo(x + .02, z + .23); ctx.stroke();
  }
  ctx.restore();
}

function grass(ctx: Brush, area: Area, seed: number) {
  const e = extent(area.points), random = randomGenerator(seed);
  ctx.save(); polygonPath(ctx, area); ctx.clip('evenodd');
  ctx.fillStyle = grainPattern(ctx, area.detail === 'garden' ? '#425a2d' : '#4b6632', seed, 24);
  ctx.fillRect(e.x0, e.z0, e.x1 - e.x0, e.z1 - e.z0);
  ctx.save(); ctx.translate(e.x0, e.z0); ctx.rotate(-.19);
  // Broad alternating mowing bands stay readable from the drone cameras.
  ctx.fillStyle = '#8aaa4820';
  const span = Math.hypot(e.x1 - e.x0, e.z1 - e.z0) * 2;
  for (let z = -span; z < span; z += .85) ctx.fillRect(-span, z, span * 2, .4);
  ctx.restore();
  for (let n = 0; n < Math.min(1800, (e.x1 - e.x0) * (e.z1 - e.z0) * 5); n++) {
    ctx.fillStyle = n % 3 ? '#30492014' : '#b0ab6016';
    ctx.beginPath(); ctx.ellipse(e.x0 + random() * (e.x1 - e.x0), e.z0 + random() * (e.z1 - e.z0), .04 + random() * .1, .03 + random() * .08, random() * 6.28, 0, 6.28); ctx.fill();
  }
  ctx.restore(); polygonPath(ctx, area); ctx.lineWidth = .035; ctx.strokeStyle = '#647154'; ctx.stroke();
}

function plaza(ctx: Brush, area: Area) {
  const e = extent(area.points);
  ctx.save(); polygonPath(ctx, area); ctx.clip('evenodd');
  drawPaving(ctx, { x: [e.x0, e.x1], z: [e.z0, e.z1] });
  if (area.name === 'Procter & Gamble Gardens' || area.id === 'osm-39866974') {
    ctx.fillStyle = '#8e524645'; ctx.fillRect(e.x0, e.z0, e.x1 - e.x0, e.z1 - e.z0);
  }
  ctx.strokeStyle = '#685c4870'; ctx.lineWidth = .08;
  ctx.translate(e.x0, e.z0); ctx.rotate(-.19);
  for (let x = -10; x < e.x1 - e.x0 + 10; x += 1.6) { ctx.beginPath(); ctx.moveTo(x, -10); ctx.lineTo(x, e.z1 - e.z0 + 10); ctx.stroke(); }
  ctx.restore();
}

export function drawMappedSurfaces(ctx: Brush) {
  // Parks before explicit lawn panels, with genuine holes retained for paved paths.
  const priority = (area: Area) => area.kind === 'plaza' ? 0 : area.kind === 'parking' ? 3 : area.detail === 'lawn' ? 2 : 1;
  const areas = [...GROUND.areas].sort((a, b) => priority(a) - priority(b));
  for (const [index, area] of areas.entries()) {
    if (area.kind === 'parking') parking(ctx, area, index + 127);
    else if (area.kind === 'grass') grass(ctx, area, index + 185);
    else plaza(ctx, area);
  }
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const p of GROUND.paths) {
    path(ctx, p.points); ctx.lineWidth = p.width + .045; ctx.strokeStyle = '#c7bd9e'; ctx.stroke();
    ctx.lineWidth = p.width; ctx.strokeStyle = p.kind === 'service' ? '#686b62' : '#c1b59b'; ctx.stroke();
  }
}

/** Mapped planting is surface art, so it creates no unmodeled solid obstacles. */
export function drawPlanting(ctx: Brush) {
  for (const [index, tree] of GROUND.trees.entries()) {
    const random = randomGenerator(index + 313), radius = .17 + random() * .11;
    ctx.fillStyle = '#2339214f'; ctx.beginPath(); ctx.ellipse(tree.x + .08, tree.z - .05, radius * 1.2, radius, 0, 0, 6.28); ctx.fill();
    for (let n = 0; n < 12; n++) {
      const a = random() * 6.28, r = random() * radius;
      ctx.fillStyle = ['#34522d', '#456635', '#56743b', '#6b8546'][n % 4];
      ctx.beginPath(); ctx.arc(tree.x + Math.cos(a) * r, tree.z + Math.sin(a) * r, radius * (.27 + random() * .28), 0, 6.28); ctx.fill();
    }
  }
  // P&G's satellite-visible tree belts border the separate lawn panels.
  // Placement inside the mapped garden outline is an approximate surface motif.
  for (const garden of GROUND.areas.filter(area => area.name === 'Procter & Gamble Gardens')) {
    ctx.save(); polygonPath(ctx, garden); ctx.clip('evenodd');
    polygonPath(ctx, garden); ctx.strokeStyle = '#3c4b2f'; ctx.lineWidth = .7; ctx.stroke();
    const random = randomGenerator(498);
    garden.points.forEach((a, i) => {
      const b = garden.points[(i + 1) % garden.points.length], length = Math.hypot(b.x - a.x, b.z - a.z);
      for (let distance = .2; distance < length; distance += .42) {
        const x = a.x + (b.x - a.x) * distance / length, z = a.z + (b.z - a.z) * distance / length;
        for (let leaf = 0; leaf < 14; leaf++) {
          ctx.fillStyle = ['#2f4a29', '#405b2d', '#516d36', '#657d40'][leaf % 4];
          ctx.beginPath(); ctx.arc(x + (random() - .5) * .42, z + (random() - .5) * .42, .06 + random() * .13, 0, 6.28); ctx.fill();
        }
      }
    });
    ctx.restore();
  }
}

export function drawWater(ctx: Brush) {
  for (const water of GROUND.water) {
    polygonPath(ctx, water); ctx.fillStyle = grainPattern(ctx, '#547775', 29, 12); ctx.fill('evenodd');
    ctx.lineWidth = .12; ctx.strokeStyle = '#789184'; ctx.stroke();
  }
}

/** Context footprints are painted only outside the flight enclosure, never as phantom roofs inside it. */
export function drawContextRoofs(ctx: Brush, bounds: { x: number[]; z: number[] }) {
  ctx.save(); ctx.beginPath();
  ctx.rect(GROUND.bounds.x[0], GROUND.bounds.z[0], GROUND.bounds.x[1] - GROUND.bounds.x[0], GROUND.bounds.z[1] - GROUND.bounds.z[0]);
  ctx.rect(bounds.x[0], bounds.z[0], bounds.x[1] - bounds.x[0], bounds.z[1] - bounds.z[0]); ctx.clip('evenodd');
  GROUND.roofs.forEach((roof, index) => {
    const e = extent(roof.points);
    ctx.save(); path(ctx, roof.points, true); ctx.clip();
    ctx.fillStyle = ['#b4aa96', '#888f86', '#a19b8b', '#bab5a4'][index % 4]; ctx.fillRect(e.x0, e.z0, e.x1 - e.x0, e.z1 - e.z0);
    ctx.strokeStyle = '#626960'; ctx.lineWidth = .09; ctx.stroke();
    const random = randomGenerator(index + 425);
    for (let n = 0; n < Math.min(15, (e.x1 - e.x0) * (e.z1 - e.z0)); n++) {
      ctx.fillStyle = n % 2 ? '#737f77' : '#c8c5b4';
      ctx.fillRect(e.x0 + random() * (e.x1 - e.x0), e.z0 + random() * (e.z1 - e.z0), .15 + random() * .25, .15 + random() * .4);
    }
    ctx.restore();
  });
  ctx.restore();
}
