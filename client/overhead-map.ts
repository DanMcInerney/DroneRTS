import * as THREE from 'three';
import { CITY } from '../shared/city';
import type { Drone } from './types';
import { dronePresentation } from './drone-presentation';

/** Owns overhead projection, map input and ID-keyed annotations. */
export class OverheadMap {
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20000);
  private center = new THREE.Vector2();
  private span = 1;
  private markerLayer = document.createElement('div');
  private lines = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  private markers = new Map<string, HTMLElement>();
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
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault(); const box = view.getBoundingClientRect(); enterAt(box.left + box.width / 2, box.top + box.height / 2);
    }, options);
    this.fit();
  }

  fit(downtown = false) {
    const objects = downtown ? [...CITY.buildings, ...CITY.spawns] : [];
    const xs = objects.map(item => item.x), zs = objects.map(item => item.z);
    const minX = downtown ? Math.min(...xs) - 12 : CITY.bounds.x[0], maxX = downtown ? Math.max(...xs) + 12 : CITY.bounds.x[1];
    const minZ = downtown ? Math.min(...zs) - 12 : CITY.bounds.z[0], maxZ = downtown ? Math.max(...zs) + 12 : CITY.bounds.z[1];
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

  renderMarkers(displayed: readonly Drone[], current: readonly Drone[]) {
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
      marker.hidden = x < 0 || x > box.width || y < 0 || y > box.height;
      marker.style.left = `${x}px`; marker.style.top = `${y}px`;
      (marker.firstElementChild as HTMLElement).style.transform = `rotate(${-drone.yaw}deg)`;
    }
    this.lines.replaceChildren(...paths);
  }

  dispose() { this.abort.abort(); this.markerLayer.remove(); this.lines.remove(); this.markers.clear(); }
}
