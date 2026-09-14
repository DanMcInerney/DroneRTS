import * as THREE from 'three';
import { CITY } from '../shared/city';
import type { Drone } from './types';
import { dronePresentation } from './drone-presentation';
import type { MatchState } from '../shared/rts';
import { BATTLEFIELD } from '../shared/battlefield';

/** Owns overhead projection, map input and ID-keyed annotations. */
export class OverheadMap {
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20000);
  private center = new THREE.Vector2();
  private span = 1;
  private markerLayer = document.createElement('div');
  private lines = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  private markers = new Map<string, HTMLElement>();
  private resources = new Map<string, HTMLElement>();
  private abort = new AbortController();

  constructor(readonly view: HTMLElement, private invalidate: () => void, enter: (x: number, z: number, altitude: number) => void) {
    this.camera.up.set(0, 0, -1);
    this.markerLayer.className = 'map-markers';
    this.lines.classList.add('map-lines'); this.lines.setAttribute('aria-hidden', 'true');
    this.view.append(this.lines, this.markerLayer);
    const enterAt = (x: number, y: number) => {
      this.configure();
      const box = view.getBoundingClientRect(), ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((x - box.left) / box.width * 2 - 1, 1 - (y - box.top) / box.height * 2), this.camera);
      const point = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
      if (!point || point.x < CITY.bounds.x[0] || point.x > CITY.bounds.x[1] || point.z < CITY.bounds.z[0] || point.z > CITY.bounds.z[1]) return;
      const roof = CITY.buildings.filter(b => Math.hypot(b.x - point.x, b.z - point.z) < Math.max(b.width, b.depth)).reduce((max, b) => Math.max(max, b.height + (b.baseY ?? 0)), 0);
      enter(point.x, point.z, Math.max(8, roof + 5));
    };
    const options = { signal: this.abort.signal };
    view.addEventListener('click', event => enterAt(event.clientX, event.clientY), options);
    view.addEventListener('keydown', event => {
      if (event.key === '+' || event.key === '=' || event.key === '-') {
        event.preventDefault(); this.span = THREE.MathUtils.clamp(this.span * (event.key === '-' ? 1.2 : 1 / 1.2), 25, 18000); this.invalidate(); return;
      }
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault(); const box = view.getBoundingClientRect(); enterAt(box.left + box.width / 2, box.top + box.height / 2);
    }, options);
    view.addEventListener('wheel', event => {
      if (Math.abs(event.deltaY) < 1) return;
      event.preventDefault(); this.span = THREE.MathUtils.clamp(this.span * Math.exp(Math.sign(event.deltaY) * 0.15), 25, 18000); this.invalidate();
    }, { ...options, passive: false });
    this.fit();
  }

  fit(downtown = false) {
    const minX = downtown ? BATTLEFIELD.focus.x[0] : CITY.bounds.x[0], maxX = downtown ? BATTLEFIELD.focus.x[1] : CITY.bounds.x[1];
    const minZ = downtown ? BATTLEFIELD.focus.z[0] : CITY.bounds.z[0], maxZ = downtown ? BATTLEFIELD.focus.z[1] : CITY.bounds.z[1];
    this.center.set((minX + maxX) / 2, (minZ + maxZ) / 2);
    this.span = Math.max(maxX - minX, maxZ - minZ) * 1.06; this.invalidate();
  }

  configure() {
    const box = this.view.getBoundingClientRect(), aspect = box.width / Math.max(1, box.height);
    const halfX = this.span / 2 * Math.max(1, aspect), halfZ = this.span / 2 / Math.min(1, aspect);
    Object.assign(this.camera, { left: -halfX, right: halfX, top: halfZ, bottom: -halfZ });
    this.camera.position.set(this.center.x, 9000, this.center.y); this.camera.lookAt(this.center.x, 0, this.center.y);
    this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld();
  }

  renderMarkers(displayed: readonly Drone[], current: readonly Drone[], match?: MatchState) {
    const box = this.view.getBoundingClientRect();
    const project = (x: number, z: number) => {
      const p = new THREE.Vector3(x, 0, z).project(this.camera); return [(p.x + 1) / 2 * box.width, (1 - p.y) / 2 * box.height];
    };
    const paths: SVGElement[] = [];
    const path = (points: number[][], color: string, close = false) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      node.setAttribute('d', points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ') + (close ? 'Z' : ''));
      node.setAttribute('stroke', color); node.setAttribute('stroke-width', close ? '1' : '1.5'); node.setAttribute('fill', close ? '#597e4620' : 'none');
      node.setAttribute('stroke-dasharray', close ? '3 3' : '5 4'); paths.push(node);
    };
    if (this.span > 500) CITY.cityBoundary.forEach(ring => path(ring.map(p => project(p.x, p.z)), '#4e705c', true));
    const currentById = new Map(current.map(drone => [drone.id, drone]));
    for (const shot of match?.projectiles ?? []) {
      path([project(shot.x - shot.vx * 0.07, shot.z - shot.vz * 0.07), project(shot.x, shot.z)], shot.team === 'blue' ? '#c3f5ff' : '#ffb092');
      paths.at(-1)!.setAttribute('stroke-dasharray', 'none'); paths.at(-1)!.setAttribute('stroke-width', '2');
    }
    const resourceIds = new Set(match?.resources.map(node => node.id) ?? []);
    for (const [id, marker] of this.resources) if (!resourceIds.has(id)) { marker.remove(); this.resources.delete(id); }
    for (const [index, node] of (match?.resources ?? []).entries()) {
      let marker = this.resources.get(node.id);
      if (!marker) {
        marker = document.createElement('div'); marker.className = 'map-resource'; marker.dataset.resourceId = node.id;
        marker.innerHTML = '<span>◆</span><b></b>'; this.resources.set(node.id, marker); this.markerLayer.append(marker);
      }
      const [x, y] = project(node.x, node.z);
      marker.style.left = `${x}px`; marker.style.top = `${y}px`; marker.hidden = x < 0 || x > box.width || y < 0 || y > box.height;
      marker.classList.toggle('depleted', node.remaining <= 0); marker.querySelector('b')!.textContent = `${String(index + 1).padStart(2, '0')} · ${Math.ceil(node.remaining)}`;
    }
    const displayedIds = new Set<string>(displayed.map(drone => drone.id));
    for (const [id, marker] of this.markers) if (!displayedIds.has(id)) { marker.remove(); this.markers.delete(id); }
    for (const drone of displayed) {
      const identity = dronePresentation(drone.id), target = currentById.get(drone.id)?.action?.target;
      if (target) path([project(drone.x, drone.z), project(target.x, target.z)], identity.color);
      let marker = this.markers.get(drone.id);
      if (!marker) {
        marker = document.createElement('div'); marker.className = `map-marker map-${drone.id}`;
        marker.dataset.droneId = drone.id; marker.style.color = identity.color; marker.title = drone.id;
        const direction = document.createElement('span'); direction.className = 'map-direction'; direction.textContent = '▲';
        const label = document.createElement('span'); label.className = 'map-drone-label'; label.textContent = identity.shortLabel;
        marker.append(direction, label); this.markers.set(drone.id, marker); this.markerLayer.append(marker);
      }
      const [x, y] = project(drone.x, drone.z);
      marker.classList.toggle('eliminated', drone.alive === false);
      marker.hidden = x < 0 || x > box.width || y < 0 || y > box.height;
      marker.style.left = `${x}px`; marker.style.top = `${y}px`;
      (marker.firstElementChild as HTMLElement).style.transform = `rotate(${-drone.yaw}deg)`;
    }
    this.lines.replaceChildren(...paths);
  }

  dispose() { this.abort.abort(); this.markerLayer.remove(); this.lines.remove(); this.markers.clear(); this.resources.clear(); }
}
