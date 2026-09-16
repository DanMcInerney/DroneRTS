import * as THREE from 'three';
import { CITY } from '../shared/city';
import type { CityPoint, CityRoad } from '../shared/city';
import type { Obstacle } from '../shared/types';
import { GROUND, path, randomGenerator, grainPattern, drawPaving, drawMappedSurfaces, drawPlanting, drawWater, drawContextRoofs } from './ground-surfaces';

type GroundContext = CanvasRenderingContext2D;
interface RoadSegment { a: CityPoint; b: CityPoint; length: number; dx: number; dz: number; road: CityRoad }
interface Junction { point: CityPoint; arms: Array<{ dx: number; dz: number; width: number }>; radius: number }

const PALETTE = { concrete: '#bdb7a8', curb: '#d2cabb', asphalt: '#454948', paint: '#dad5bd' };
const TAU = Math.PI * 2;

function stroke(ctx: GroundContext, points: CityPoint[], width: number, color: string) {
  path(ctx, points); ctx.lineWidth = width; ctx.strokeStyle = color; ctx.stroke();
}

function roadGeometry(roads: CityRoad[]) {
  const segments: RoadSegment[] = [];
  const nodes = new Map<string, { point: CityPoint; names: Set<string>; arms: Junction['arms'] }>();
  for (const road of roads) {
    for (let index = 1; index < road.points.length; index++) {
      const a = road.points[index - 1], b = road.points[index];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < .02) continue;
      const dx = (b.x - a.x) / length, dz = (b.z - a.z) / length;
      segments.push({ a, b, length, dx, dz, road });
      if (road.name === 'Skywalk') continue;
      for (const [point, direction] of [[a, 1], [b, -1]] as const) {
        const key = `${point.x.toFixed(3)}:${point.z.toFixed(3)}`;
        let node = nodes.get(key);
        if (!node) { node = { point, names: new Set(), arms: [] }; nodes.set(key, node); }
        node.names.add(road.name.replace(/^(East|West) /, ''));
        if (!node.arms.some(arm => arm.dx * dx * direction + arm.dz * dz * direction > .96)) {
          node.arms.push({ dx: dx * direction, dz: dz * direction, width: road.width });
        }
      }
    }
  }
  const junctions: Junction[] = [...nodes.values()].filter(node => node.names.size > 1 && node.arms.length >= 3)
    .map(node => ({ point: node.point, arms: node.arms, radius: Math.max(...node.arms.map(arm => arm.width)) / 2 }));
  return { segments, junctions };
}

function drawForecourts(ctx: GroundContext, buildings: Obstacle[]) {
  const colors = ['#aea596', '#bbb2a2', '#a7a295', '#c0b6a4', '#aba697'];
  buildings.forEach((building, index) => {
    if ((building.baseY ?? 0) > .05) return;
    ctx.save(); ctx.translate(building.x, building.z); ctx.rotate(-THREE.MathUtils.degToRad(building.rotation ?? 0));
    const w = building.width + .8, d = building.depth + .8;
    ctx.fillStyle = colors[index % colors.length]; ctx.fillRect(-w / 2, -d / 2, w, d);
    ctx.strokeStyle = '#88877d'; ctx.lineWidth = .012;
    // A one-metre border and expansion joints give the exposed sidewalk a human scale.
    ctx.strokeRect(-w / 2 + .12, -d / 2 + .12, w - .24, d - .24);
    for (let x = -w / 2; x < w / 2; x += .5) {
      ctx.beginPath(); ctx.moveTo(x, -d / 2); ctx.lineTo(x, d / 2); ctx.stroke();
    }
    for (let z = -d / 2; z < d / 2; z += .5) {
      ctx.beginPath(); ctx.moveTo(-w / 2, z); ctx.lineTo(w / 2, z); ctx.stroke();
    }
    ctx.restore();
  });
}

function drawParks(ctx: GroundContext) {
  for (const park of CITY.parks) {
    if (park.points.length < 3) continue;
    ctx.save(); path(ctx, park.points, true); ctx.clip();
    const x0 = Math.min(...park.points.map(point => point.x)), x1 = Math.max(...park.points.map(point => point.x));
    const z0 = Math.min(...park.points.map(point => point.z)), z1 = Math.max(...park.points.map(point => point.z));
    if (park.name !== 'Fountain Square') {
      ctx.fillStyle = grainPattern(ctx, park.color ?? '#73805d', 118, 20); ctx.fillRect(x0, z0, x1 - x0, z1 - z0);
      ctx.restore(); continue;
    }
    // The source plaza polygon, rendered as warm masonry rather than a lawn.
    ctx.fillStyle = '#b9a18a'; ctx.fillRect(x0, z0, x1 - x0, z1 - z0);
    const anchor = park.points[0], edge = park.points[1];
    const angle = Math.atan2(edge.z - anchor.z, edge.x - anchor.x);
    ctx.translate(anchor.x, anchor.z); ctx.rotate(angle);
    const local = park.points.map(point => ({ x: (point.x - anchor.x) * Math.cos(angle) + (point.z - anchor.z) * Math.sin(angle),
      z: -(point.x - anchor.x) * Math.sin(angle) + (point.z - anchor.z) * Math.cos(angle) }));
    const width = Math.max(...local.map(point => point.x)), depth = -Math.min(...local.map(point => point.z));
    const random = randomGenerator(633), colors = ['#bdab92', '#c9b89f', '#b6a58e', '#c4af94', '#b9a48b'];
    for (let z = -depth; z < .25; z += .2) for (let x = 0; x < width + .25; x += .25) {
      ctx.fillStyle = colors[Math.floor(random() * colors.length)]; ctx.fillRect(x + .012, z + .012, .235, .185);
    }
    ctx.strokeStyle = '#92755e'; ctx.lineWidth = .13; ctx.strokeRect(.22, -depth + .22, width - .44, depth - .44);
    for (let x = 1.25; x < width; x += 1.25) {
      ctx.fillStyle = '#a78971'; ctx.fillRect(x, -depth, .06, depth);
    }
    for (let z = -depth + 1.25; z < 0; z += 1.25) {
      ctx.fillStyle = '#a78971'; ctx.fillRect(0, z, width, .06);
    }
    // Flush planting beds and a stone medallion are surface artwork, never new obstacles.
    for (const x of [.6, width - 1.25]) for (const z of [-depth + .45, -1]) {
      ctx.fillStyle = '#7d725c'; ctx.fillRect(x - .06, z - .06, .77, .50);
      ctx.fillStyle = '#566245'; ctx.fillRect(x, z, .65, .38);
      for (let leaf = 0; leaf < 22; leaf++) {
        ctx.fillStyle = leaf % 2 ? '#65724e' : '#72805a';
        ctx.beginPath(); ctx.ellipse(x + random() * .65, z + random() * .38, .055, .035, 0, 0, TAU); ctx.fill();
      }
    }
    ctx.beginPath(); ctx.arc(width * .4, -depth * .34, .4, 0, TAU); ctx.fillStyle = '#b5a58e'; ctx.fill();
    ctx.strokeStyle = '#867762'; ctx.lineWidth = .055; ctx.stroke();
    ctx.beginPath(); ctx.arc(width * .4, -depth * .34, .23, 0, TAU); ctx.stroke();
    ctx.restore();
  }
}

function drawRoads(ctx: GroundContext, roads: CityRoad[], segments: RoadSegment[], junctions: Junction[]) {
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const road of roads) stroke(ctx, road.points, road.width + .76, '#817f72');
  for (const road of roads) stroke(ctx, road.points, road.width + .68, PALETTE.concrete);
  for (const segment of segments) {
    const { a, dx, dz, length, road } = segment;
    for (let along = .15; along < length; along += .48) {
      const x = a.x + dx * along, z = a.z + dz * along, half = road.width / 2 + .35;
      stroke(ctx, [{ x: x - dz * half, z: z + dx * half }, { x: x + dz * half, z: z - dx * half }], .014, '#969387');
    }
  }
  for (const road of roads) stroke(ctx, road.points, road.width + .07, PALETTE.curb);
  const asphalt = grainPattern(ctx, PALETTE.asphalt, 62184, 17);
  for (const road of roads) {
    path(ctx, road.points); ctx.lineWidth = road.width; ctx.strokeStyle = road.name === 'Skywalk' ? '#a79f8d' : asphalt; ctx.stroke();
  }
  const random = randomGenerator(47843);
  for (const segment of segments) {
    const { a, dx, dz, length, road } = segment;
    if (road.name === 'Skywalk') continue;
    ctx.save(); ctx.translate(a.x, a.z); ctx.rotate(Math.atan2(dz, dx));
    // Low-contrast resurfacing and aggregate prevent an immaculate dark ribbon.
    for (let along = .4; along < length - .7; along += 1.6 + random() * 1.6) {
      const width = .2 + random() * .35, across = (random() - .5) * (road.width - width - .12);
      ctx.fillStyle = random() > .5 ? '#4c504e' : '#404542';
      ctx.fillRect(along, across - width / 2, .35 + random() * .35, width);
    }
    // Recessed storm-drain marks sit by the curb; they are baked surface details.
    if (length > 2.5) for (const side of [-1, 1]) {
      ctx.fillStyle = '#303835'; ctx.fillRect(length * .55, side * (road.width / 2 - .07) - .04, .15, .07);
      for (let slot = 0; slot < 4; slot++) { ctx.fillStyle = '#65685b'; ctx.fillRect(length * .55 + .018 + slot * .032, side * (road.width / 2 - .07) - .033, .012, .055); }
    }
    ctx.restore();
    if (road.width < 1.5 || road.name.includes('Government Square')) continue;
    const offsets = road.width >= 2.2 ? [-.6, 0, .6] : [-.3, .3];
    for (let along = .15; along + .32 < length; along += .98) {
      const x = a.x + dx * along, z = a.z + dz * along;
      if (junctions.some(junction => Math.hypot(x - junction.point.x, z - junction.point.z) < junction.radius + 1.05)) continue;
      for (const offset of offsets) stroke(ctx, [
        { x: x - dz * offset, z: z + dx * offset },
        { x: x + dx * .32 - dz * offset, z: z + dz * .32 + dx * offset },
      ], .023, PALETTE.paint);
    }
  }
  ctx.lineCap = 'butt';
  for (const junction of junctions) for (const arm of junction.arms) {
    const offset = junction.radius + .38;
    ctx.save(); ctx.translate(junction.point.x, junction.point.z); ctx.rotate(Math.atan2(arm.dz, arm.dx));
    ctx.fillStyle = PALETTE.paint;
    for (let across = -arm.width / 2 + .15; across < arm.width / 2 - .1; across += .145) ctx.fillRect(offset - .22, across, .44, .065);
    ctx.fillRect(offset + .39, -arm.width / 2 + .1, .05, arm.width - .2);
    ctx.fillStyle = '#b4a171';
    for (const side of [-1, 1]) ctx.fillRect(offset - .16, side * (arm.width / 2 + .11) - .055, .32, .11);
    ctx.restore();
  }
}

/** Satellite-informed, original surface art. All marks are flush and camera-visible. */
export function createUrbanGround(buildings: Obstacle[]): THREE.Group {
  const group = new THREE.Group(); group.name = 'cincinnati-urban-ground';
  // One continuous geographic atlas retains roads/parks beyond the arena boundary.
  // The core is overlaid at 20cm per texel for ground-level and acquired-camera detail.
  const makeAtlas = (bounds: { x: number[]; z: number[] }, pixels: number, name: string, y: number, context: boolean) => {
    const [x0, x1] = bounds.x, [z0, z1] = bounds.z, width = x1 - x0, depth = z1 - z0;
    const canvas = document.createElement('canvas'); canvas.width = pixels; canvas.height = Math.round(pixels * depth / width);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(canvas.width / width, canvas.height / depth); ctx.translate(-x0, -z0);
    drawPaving(ctx, bounds); drawForecourts(ctx, buildings);
    drawMappedSurfaces(ctx); drawParks(ctx);
    const roads = GROUND.roads.filter(road => !['corridor', 'bus_stop', 'pedestrian'].includes(road.kind));
    const { segments, junctions } = roadGeometry(roads);
    drawRoads(ctx, roads, segments, junctions); drawPlanting(ctx); drawWater(ctx);
    if (context) {
      drawContextRoofs(ctx, CITY.bounds);
      // Fade only the remote edge of the 2km source extract into atmospheric haze.
      // The whole flight arena and its adjacent city blocks remain fully opaque.
      ctx.globalCompositeOperation = 'destination-out';
      const margin = 18;
      for (const [ax, az, bx, bz] of [[x0, z0, x0 + margin, z0], [x1, z0, x1 - margin, z0],
        [x0, z0, x0, z0 + margin], [x0, z1, x0, z1 - margin]]) {
        const fade = ctx.createLinearGradient(ax, az, bx, bz); fade.addColorStop(0, '#000'); fade.addColorStop(1, '#0000');
        ctx.fillStyle = fade; ctx.fillRect(x0, z0, width, depth);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.name = name; texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), new THREE.MeshStandardMaterial({ map: texture, roughness: .96, metalness: 0, transparent: context, depthWrite: !context }));
    ground.name = name; ground.rotation.x = -Math.PI / 2;
    ground.position.set((x0 + x1) / 2, y, (z0 + z1) / 2); ground.receiveShadow = true;
    return ground;
  };
  group.add(makeAtlas(GROUND.bounds, 4096, 'cincinnati-surrounding-ground', .008, true));
  group.add(makeAtlas(CITY.bounds, 4096, 'downtown-paving-and-road-atlas', .019, false));
  return group;
}
