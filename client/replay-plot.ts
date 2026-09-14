import type { DroneId } from '../shared/types';
import { ReplayTimeline, type ReplaySample } from './replay-model';

type Extent = { x: [number, number]; z: [number, number] };
type Point = { x: number; z: number };
export type ReplayExtent = 'battlefield' | 'activity' | 'city';

/** A read-only 2D rendering of the recorded scene. It never touches live sensors or Three.js. */
export class ReplayPlot {
  private ctx: CanvasRenderingContext2D;
  private hits: Array<{ id: DroneId; x: number; y: number }> = [];
  constructor(private canvas: HTMLCanvasElement, private select: (id: DroneId) => void) {
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('click', event => {
      const rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
      const hit = this.hits.findLast(item => Math.hypot(item.x - x, item.y - y) < 18);
      if (hit) this.select(hit.id);
    });
  }

  draw(model: ReplayTimeline, sample: ReplaySample, selected: DroneId | undefined, extent: ReplayExtent) {
    const box = this.canvas.getBoundingClientRect(), w = box.width, h = box.height;
    if (!w || !h) return;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * ratio); this.canvas.height = Math.round(h * ratio);
    const ctx = this.ctx; ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.fillStyle = '#09141c'; ctx.fillRect(0, 0, w, h); this.hits = [];
    const header = model.header;
    if (!header || !sample.frame) {
      ctx.fillStyle = '#8199a6'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Recorded flight paths will appear here', w / 2, h / 2); return;
    }
    const frames = model.window(sample.time), drones = sample.frame.drones;
    const bounds = extent === 'city' ? header.scene.bounds : extent === 'activity' ? this.activity(frames.flatMap(frame => frame.drones), header.scene.focus) : header.scene.focus;
    const scale = Math.min((w - 65) / Math.max(1, bounds.x[1] - bounds.x[0]), (h - 60) / Math.max(1, bounds.z[1] - bounds.z[0]));
    const middleX = (bounds.x[0] + bounds.x[1]) / 2, middleZ = (bounds.z[0] + bounds.z[1]) / 2;
    const xy = (p: Point) => ({ x: (p.x - middleX) * scale + w / 2, y: (p.z - middleZ) * scale + h / 2 });
    const line = (points: Point[], color: string, width = 1, fill?: string) => {
      if (!points.length) return;
      ctx.beginPath(); points.forEach((p, index) => { const at = xy(p); if (!index) ctx.moveTo(at.x, at.y); else ctx.lineTo(at.x, at.y); });
      if (fill) { ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); }
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
    };
    // Screen-space grid keeps the map legible at either municipal or street scale.
    ctx.strokeStyle = '#15252f'; ctx.lineWidth = 1;
    for (let x = w / 2 % 40; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = h / 2 % 40; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    line(header.scene.river, '#234457', 1, '#102d3f');
    for (const road of header.scene.roads) line(road.points, '#283640', Math.max(1, road.width * scale));
    ctx.fillStyle = '#1d303b'; ctx.strokeStyle = '#3c505b';
    for (const obstacle of header.scene.obstacles) {
      const at = xy(obstacle); if (at.x < -100 || at.x > w + 100 || at.y < -100 || at.y > h + 100) continue;
      ctx.save(); ctx.translate(at.x, at.y); ctx.rotate(-(obstacle.rotation ?? 0) * Math.PI / 180);
      ctx.fillRect(-obstacle.width * scale / 2, -obstacle.depth * scale / 2, obstacle.width * scale, obstacle.depth * scale);
      if (scale > 1) ctx.strokeRect(-obstacle.width * scale / 2, -obstacle.depth * scale / 2, obstacle.width * scale, obstacle.depth * scale); ctx.restore();
    }
    const identity = (id: DroneId) => header.roster.find(member => member.id === id);
    const maxGap = Math.max(0.25, header.sampleInterval * 2.5);
    const positions = new Map<DroneId, { point: Point; time: number; alive?: boolean }>();
    const shots = new Map<string, Array<{ point: Point; time: number }>>();
    const shotPoint = (id: string, point: Point, time: number) => { const points = shots.get(id) ?? []; points.push({ point, time }); shots.set(id, points); };
    for (const frame of frames) {
      const currentIds = new Set(frame.drones.map(drone => drone.id));
      for (const id of positions.keys()) if (!currentIds.has(id)) positions.delete(id);
      for (const drone of frame.drones) {
        const prior = positions.get(drone.id);
        if (prior && frame.simTime - prior.time <= maxGap && prior.alive !== false) line([prior.point, drone], `${identity(drone.id)?.color ?? '#cfdfdd'}85`, drone.id === selected ? 2.5 : 1.3);
        positions.set(drone.id, { point: drone, time: frame.simTime, alive: drone.alive });
      }
      for (const shot of frame.match?.projectiles ?? []) shotPoint(shot.id, shot, frame.simTime);
    }
    for (const { event } of sample.events) if (event.projectileId && event.x !== undefined && event.z !== undefined && sample.time - event.simTime <= 8 && ['fired', 'impact', 'projectile_expired'].includes(event.type)) shotPoint(event.projectileId, { x: event.x, z: event.z }, event.simTime);
    for (const points of shots.values()) {
      points.sort((a, b) => a.time - b.time);
      for (let index = 1; index < points.length; index++) if (points[index].time - points[index - 1].time <= maxGap) line([points[index - 1].point, points[index].point], '#f7cf84', 1.8);
    }
    for (const resource of sample.frame.match?.resources ?? []) {
      const at = xy(resource); ctx.fillStyle = resource.remaining > 0 ? '#d9c78f' : '#4c514a'; ctx.save(); ctx.translate(at.x, at.y); ctx.rotate(Math.PI / 4); ctx.fillRect(-3, -3, 6, 6); ctx.restore();
    }
    for (const { event } of sample.events) {
      if (!['impact', 'destroyed', 'armor_consumed'].includes(event.type) || sample.time - event.simTime > 8 || event.x === undefined || event.z === undefined) continue;
      const at = xy({ x: event.x, z: event.z }); ctx.strokeStyle = event.type === 'destroyed' ? '#ff897d' : '#f5cd81'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(at.x - 4, at.y - 4); ctx.lineTo(at.x + 4, at.y + 4); ctx.moveTo(at.x + 4, at.y - 4); ctx.lineTo(at.x - 4, at.y + 4); ctx.stroke();
      ctx.beginPath(); ctx.arc(at.x, at.y, 8, 0, Math.PI * 2); ctx.stroke();
    }
    for (const drone of drones) {
      const member = identity(drone.id), at = xy(drone), color = member?.color ?? '#d7ed9e';
      if (drone.action?.target && drone.id === selected && drone.alive !== false) { ctx.setLineDash([4, 5]); line([drone, drone.action.target], '#c7d5d1', 1); ctx.setLineDash([]); }
      ctx.save(); ctx.translate(at.x, at.y); ctx.rotate(-drone.yaw * Math.PI / 180); ctx.fillStyle = drone.alive === false ? '#687078' : color;
      ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(5, 5); ctx.lineTo(0, 2); ctx.lineTo(-5, 5); ctx.closePath(); ctx.fill(); ctx.restore();
      if (drone.id === selected) { ctx.strokeStyle = '#e6f2d0'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(at.x, at.y, 12, 0, Math.PI * 2); ctx.stroke(); }
      ctx.font = '10px monospace'; ctx.textAlign = 'left'; ctx.fillStyle = color; ctx.fillText((member?.label ?? drone.id) + (drone.alive === false ? ' ×' : ''), at.x + 15, at.y + 3);
      this.hits.push({ id: drone.id, ...at });
    }
    ctx.font = '10px monospace'; ctx.textAlign = 'left'; ctx.fillStyle = '#9ab2be'; ctx.fillText('N ↑', 16, 25);
    ctx.fillText(`8s trails · frame ${sample.frame.simTime.toFixed(2)}s`, 16, h - 16);
    if (sample.time - sample.frame.simTime > maxGap) { ctx.fillStyle = '#f5cd81'; ctx.textAlign = 'right'; ctx.fillText('RECORDING GAP · last known frame', w - 16, 25); }
  }

  private activity(points: Point[], fallback: Extent): Extent {
    if (!points.length) return fallback;
    const xs = points.map(point => point.x), zs = points.map(point => point.z);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const pad = Math.max(8, (Math.max(maxX - minX, maxZ - minZ)) * 0.14);
    return { x: [minX - pad, maxX + pad], z: [minZ - pad, maxZ + pad] };
  }
}
