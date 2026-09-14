import * as THREE from 'three';
import type { Pose, WorldState } from './types';
import { cameraFovFor, DRONE_CAMERA } from '../shared/camera-profile';
import { createCity, createTreasure, disposeGroup } from './city-scene';
import { PoseBuffer } from './pose-buffer';
import { Explorer } from './explorer';
import { OverheadMap } from './overhead-map';
import { DroneVisuals } from './drone-visuals';
import { CombatView } from './combat-view';
import type { MatchState } from '../shared/rts';

export type DroneViewport = { droneId: string; view: HTMLElement };
const radians = THREE.MathUtils.degToRad;
const droneCamera = () => new THREE.PerspectiveCamera(DRONE_CAMERA.fov, DRONE_CAMERA.width / DRONE_CAMERA.height, DRONE_CAMERA.near, DRONE_CAMERA.far);

/** Composes viewer passes and truthful sensor captures into one WebGL renderer. */
export class FleetScene {
  private scene = new THREE.Scene();
  private renderer: THREE.WebGLRenderer;
  private cameras = new Map<string, THREE.PerspectiveCamera>();
  private views: DroneViewport[] = [];
  private captureCamera = droneCamera();
  private captureTarget = new THREE.WebGLRenderTarget(DRONE_CAMERA.width, DRONE_CAMERA.height);
  private worldGroup = new THREE.Group();
  private treasureGroup = new THREE.Group();
  private treasureSignature = '';
  private drones = new DroneVisuals(this.scene);
  private combat = new CombatView(this.scene);
  private combatSignature = '';
  private state?: WorldState;
  private worldSignature = '';
  private stopped = false;
  private observer: ResizeObserver;
  private lastFrameAt = -Infinity;
  private frameDirty = true;
  private poseSignature = '';
  private invalidateFrame = () => { this.frameDirty = true; };
  private poses = new PoseBuffer();
  private overview: OverheadMap;
  private explorer: Explorer;
  private abort = new AbortController();
  private lastAnimation = 0;

  constructor(private container: HTMLElement, views: DroneViewport[], mapView: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    // Vertex lighting avoids a separate shadow pass for every camera.
    this.renderer.shadowMap.enabled = false;
    this.renderer.domElement.className = 'world-canvas';
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    this.container.prepend(this.renderer.domElement);
    this.captureTarget.texture.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color('#b9dce9');
    this.scene.fog = new THREE.Fog('#b9dce9', 140, 400);
    this.scene.add(new THREE.HemisphereLight(0xdbeaff, 0x646444, 2.5));
    const sun = new THREE.DirectionalLight(0xffeed2, 3.1);
    sun.position.set(-90, 160, 90); this.scene.add(sun);
    this.scene.add(this.worldGroup, this.treasureGroup);
    this.explorer = new Explorer(active => {
      (active ? this.explorer.view : this.container).prepend(this.renderer.domElement);
      this.container.inert = active; this.resize();
    });
    this.overview = new OverheadMap(mapView, this.invalidateFrame, (x, z, altitude) => this.explorer.enter(x, z, altitude));
    window.addEventListener('resize', () => this.resize(), { signal: this.abort.signal });
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(container);
    window.addEventListener('scroll', this.invalidateFrame, { passive: true, signal: this.abort.signal });
    document.addEventListener('visibilitychange', this.invalidateFrame, { signal: this.abort.signal });
    this.setViews(views); this.resize(); requestAnimationFrame(time => this.render(time));
  }

  setViews(views: DroneViewport[]) {
    this.views = views;
    const ids = new Set(views.map(({ droneId }) => droneId));
    for (const id of this.cameras.keys()) if (!ids.has(id)) this.cameras.delete(id);
    for (const id of ids) if (!this.cameras.has(id)) this.cameras.set(id, droneCamera());
    this.invalidateFrame();
  }

  update(state: WorldState) {
    if (this.state?.running !== state.running || state.simTime < (this.state?.simTime ?? 0)) this.frameDirty = true;
    this.state = state; this.poses.push(state, performance.now());
    const signature = JSON.stringify(state.obstacles);
    if (signature !== this.worldSignature) {
      this.worldSignature = signature;
      disposeGroup(this.worldGroup); this.worldGroup.add(createCity(state.obstacles)); this.frameDirty = true;
    }
    const treasureSignature = JSON.stringify(state.treasures);
    if (treasureSignature !== this.treasureSignature) {
      this.treasureSignature = treasureSignature; disposeGroup(this.treasureGroup);
      state.treasures.forEach(treasure => this.treasureGroup.add(createTreasure(treasure))); this.frameDirty = true;
    }
    const poses = JSON.stringify(state.drones.map(({ id, x, y, z, yaw, pitch, action }) => [id, x, y, z, yaw, pitch, action]));
    if (poses !== this.poseSignature) { this.poseSignature = poses; this.frameDirty = true; }
    this.drones.reconcile(state.drones);
    const combatSignature = JSON.stringify([state.match?.resources, state.match?.servicePads, state.match?.projectiles, state.drones.map(drone => [drone.alive, drone.equipment, drone.mining, drone.cameraMode, drone.jamming, drone.radioJammed])]);
    if (combatSignature !== this.combatSignature) { this.combatSignature = combatSignature; this.combat.update(state.match); this.frameDirty = true; }
  }

  private poseCamera(camera: THREE.PerspectiveCamera, pose: Pose) {
    camera.position.set(pose.x, pose.y, pose.z); camera.rotation.order = 'YXZ';
    camera.rotation.set(radians(pose.pitch), radians(pose.yaw), 0); camera.updateMatrixWorld();
  }

  private resize() {
    const host = this.explorer?.active ? this.explorer.view : this.container;
    this.renderer.setSize(host.clientWidth, host.clientHeight, false); this.frameDirty = true;
  }

  fitOverview(downtown = false) { this.overview.fit(downtown); }

  private render(time: number) {
    if (this.stopped) return;
    requestAnimationFrame(nextTime => this.render(nextTime));
    const dt = Math.min(0.05, (time - (this.lastAnimation || time)) / 1000); this.lastAnimation = time; this.explorer.tick(dt);
    // UI feeds may drop frames; sensor captures always render immediately.
    if (document.hidden || (!this.frameDirty && !this.poses.pending(time) && !this.explorer.active) || time - this.lastFrameAt < 1000 / 60) return;
    this.lastFrameAt = time; this.frameDirty = false;
    const displayed = this.poses.sample(time), displayedById = new Map<string, WorldState['drones'][number]>(displayed.map(drone => [drone.id, drone]));
    this.drones.pose(displayed);
    const box = (this.explorer.active ? this.explorer.view : this.container).getBoundingClientRect();
    this.renderer.setScissorTest(false); this.renderer.setClearColor(0x000000, 0); this.renderer.clear();
    if (this.explorer.active) {
      this.drones.hideObserver();
      const camera = this.explorer.camera; camera.aspect = box.width / box.height; camera.updateProjectionMatrix();
      this.renderer.setViewport(0, 0, box.width, box.height); this.renderer.render(this.scene, camera); return;
    }
    this.renderer.setScissorTest(true);
    for (const { droneId, view } of this.views) {
      const drone = displayedById.get(droneId), camera = this.cameras.get(droneId);
      if (!drone || !camera) continue;
      const bounds = view.getBoundingClientRect();
      if (bounds.width < 1 || bounds.height < 1 || bounds.bottom <= 0 || bounds.top >= window.innerHeight || bounds.right <= 0 || bounds.left >= window.innerWidth) continue;
      this.poseCamera(camera, drone); camera.fov = cameraFovFor(drone); camera.aspect = bounds.width / bounds.height; camera.updateProjectionMatrix(); this.drones.hideObserver(droneId);
      const x = bounds.left - box.left, y = box.bottom - bounds.bottom;
      this.renderer.setViewport(x, y, bounds.width, bounds.height); this.renderer.setScissor(x, y, bounds.width, bounds.height); this.renderer.render(this.scene, camera);
    }
    this.drones.hideObserver();
    const map = this.overview.view.getBoundingClientRect();
    if (map.width > 0 && map.bottom > 0 && map.top < window.innerHeight) {
      this.overview.configure();
      this.renderer.setViewport(map.left - box.left, box.bottom - map.bottom, map.width, map.height);
      this.renderer.setScissor(map.left - box.left, box.bottom - map.bottom, map.width, map.height);
      const fog = this.scene.fog, background = this.scene.background;
      try { this.scene.fog = null; this.scene.background = new THREE.Color('#17252b'); this.renderer.render(this.scene, this.overview.camera); }
      finally { this.scene.fog = fog; this.scene.background = background; }
      this.overview.renderMarkers(displayed, this.state?.drones ?? [], this.state?.match);
    }
  }

  capture(droneId: string, pose: Pose, drones = this.state?.drones ?? [], match: MatchState | undefined = this.state?.match): string {
    this.poseCamera(this.captureCamera, pose);
    // The requested world snapshot owns both optics and geometry. A later live
    // camera toggle must not change the projection of an earlier acquisition.
    const previousFov = this.captureCamera.fov;
    this.captureCamera.fov = cameraFovFor(drones.find(drone => drone.id === droneId) ?? {});
    this.captureCamera.updateProjectionMatrix();
    const { width, height } = DRONE_CAMERA;
    const previousTarget = this.renderer.getRenderTarget(), previousViewport = this.renderer.getViewport(new THREE.Vector4());
    const previousScissor = this.renderer.getScissor(new THREE.Vector4()), previousTest = this.renderer.getScissorTest();
    const pixels = new Uint8Array(width * height * 4);
    try {
      this.combat.withSnapshot(match, () => this.drones.withSnapshot(droneId, drones, () => {
        this.renderer.setRenderTarget(this.captureTarget); this.renderer.setScissorTest(false); this.renderer.setViewport(0, 0, width, height);
        this.renderer.render(this.scene, this.captureCamera); this.renderer.readRenderTargetPixels(this.captureTarget, 0, 0, width, height, pixels);
      }));
    } finally {
      this.renderer.setRenderTarget(previousTarget); this.renderer.setViewport(previousViewport);
      this.renderer.setScissor(previousScissor); this.renderer.setScissorTest(previousTest);
      this.captureCamera.fov = previousFov; this.captureCamera.updateProjectionMatrix();
    }
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('Camera capture unavailable: no 2D canvas context.');
    const image = context.createImageData(width, height), row = width * 4;
    for (let y = 0; y < height; y++) image.data.set(pixels.subarray((height - y - 1) * row, (height - y) * row), y * row);
    context.putImageData(image, 0, 0); return canvas.toDataURL('image/jpeg', 0.82);
  }

  dispose() {
    this.stopped = true; this.explorer.dispose(); this.overview.dispose(); this.abort.abort(); this.observer.disconnect();
    disposeGroup(this.worldGroup); disposeGroup(this.treasureGroup); this.drones.dispose(); this.combat.dispose();
    this.cameras.clear(); this.captureTarget.dispose(); this.renderer.dispose(); this.renderer.domElement.remove();
  }
}
