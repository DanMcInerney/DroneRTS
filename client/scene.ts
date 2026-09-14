import * as THREE from 'three';
import type { Pose, WorldState } from './types';
import { CITY } from '../shared/city';
import { createCity, createTreasure, disposeGroup } from './city-scene';

const DRONE_COLORS = [0xd7ed9e, 0x92c9fa, 0xf1bca9];
const radians = THREE.MathUtils.degToRad;

export class FleetScene {
  private scene = new THREE.Scene();
  private renderer: THREE.WebGLRenderer;
  private cameras = [0, 1, 2].map(() => new THREE.PerspectiveCamera(76, 4 / 3, 0.08, 500));
  private captureCamera = new THREE.PerspectiveCamera(76, 512 / 288, 0.08, 500);
  private captureTarget = new THREE.WebGLRenderTarget(512, 288);
  private worldGroup = new THREE.Group();
  private treasureGroup = new THREE.Group();
  private treasureSignature = '';
  private droneMeshes = new Map<string, THREE.Group>();
  private state?: WorldState;
  private worldSignature = '';
  private stopped = false;
  private observer: ResizeObserver;
  private lastFrameAt = -Infinity;
  private frameDirty = true;
  private poseSignature = '';
  private invalidateFrame = () => { this.frameDirty = true; };

  constructor(private container: HTMLElement, private views: HTMLElement[]) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    // Vertex lighting keeps the cube city readable without a separate shadow pass
    // for each FPV feed and every camera observation on software WebGL.
    this.renderer.shadowMap.enabled = false;
    this.renderer.domElement.className = 'world-canvas';
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    this.container.prepend(this.renderer.domElement);
    this.captureTarget.texture.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color('#b9dce9');
    this.scene.fog = new THREE.Fog('#b9dce9', 140, 400);
    this.scene.add(new THREE.HemisphereLight(0xdbeaff, 0x646444, 2.5));
    const sun = new THREE.DirectionalLight(0xffeed2, 3.1);
    sun.position.set(-90, 160, 90);
    this.scene.add(sun);
    this.scene.add(this.worldGroup, this.treasureGroup);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    window.addEventListener('scroll', this.invalidateFrame, { passive: true });
    document.addEventListener('visibilitychange', this.invalidateFrame);
    this.resize();
    requestAnimationFrame(time => this.render(time));
  }

  update(state: WorldState) {
    this.state = state;
    const signature = JSON.stringify(state.obstacles);
    if (signature !== this.worldSignature) {
      this.worldSignature = signature;
      this.rebuildWorld(state);
      this.frameDirty = true;
    }
    const treasureSignature = JSON.stringify(state.treasures);
    if (treasureSignature !== this.treasureSignature) {
      this.treasureSignature = treasureSignature;
      disposeGroup(this.treasureGroup);
      state.treasures.forEach(treasure => this.treasureGroup.add(createTreasure(treasure)));
      this.frameDirty = true;
    }
    const poses = JSON.stringify(state.drones.map(({ id, x, y, z, yaw, pitch }) => [id, x, y, z, yaw, pitch]));
    if (poses !== this.poseSignature) { this.poseSignature = poses; this.frameDirty = true; }
    state.drones.forEach((drone, index) => {
      let mesh = this.droneMeshes.get(drone.id);
      if (!mesh) {
        mesh = this.makeDrone(DRONE_COLORS[index] ?? DRONE_COLORS[0]);
        this.droneMeshes.set(drone.id, mesh);
        this.scene.add(mesh);
      }
      mesh.position.set(drone.x, drone.y - 0.14, drone.z);
      mesh.rotation.y = radians(drone.yaw);
    });
  }

  private rebuildWorld(state: WorldState) {
    disposeGroup(this.worldGroup);
    this.worldGroup.add(createCity(state.obstacles));
  }

  private makeDrone(color: number) {
    const group = new THREE.Group();
    const material = new THREE.MeshLambertMaterial({ color });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.15, 0.48), material);
    body.castShadow = true;
    group.add(body);
    for (const x of [-0.32, 0.32]) for (const z of [-0.28, 0.28]) {
      const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.025, 8), new THREE.MeshLambertMaterial({ color: 0x333e42 }));
      rotor.position.set(x, 0.1, z);
      group.add(rotor);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.43, 0.055, 0.06), material);
      arm.position.set(x / 2, 0, z / 2);
      arm.rotation.y = x * z > 0 ? -Math.PI / 4 : Math.PI / 4;
      group.add(arm);
    }
    return group;
  }

  private poseCamera(camera: THREE.PerspectiveCamera, pose: Pose) {
    camera.position.set(pose.x, pose.y, pose.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(radians(pose.pitch), radians(pose.yaw), 0);
    camera.updateMatrixWorld();
  }

  private resize() {
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight, false);
    this.frameDirty = true;
  }

  private render(time: number) {
    if (this.stopped) return;
    requestAnimationFrame(nextTime => this.render(nextTime));
    // UI feeds may drop frames; sensor captures below always render immediately.
    if (document.hidden || !this.frameDirty || time - this.lastFrameAt < 1000 / 18) return;
    this.lastFrameAt = time;
    this.frameDirty = false;
    const box = this.container.getBoundingClientRect();
    this.renderer.setScissorTest(false);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.setScissorTest(true);
    this.views.forEach((view, i) => {
      const bounds = view.getBoundingClientRect();
      if (bounds.width < 1 || bounds.height < 1 || bounds.bottom <= 0 || bounds.top >= window.innerHeight || bounds.right <= 0 || bounds.left >= window.innerWidth) return;
      const camera = this.cameras[i];
      const drone = this.state?.drones[i];
      const pose = drone ?? CITY.spawns[i];
      this.poseCamera(camera, pose);
      camera.aspect = bounds.width / bounds.height;
      camera.updateProjectionMatrix();
      this.droneMeshes.forEach((mesh, id) => { mesh.visible = id !== drone?.id; });
      const x = bounds.left - box.left;
      const y = box.bottom - bounds.bottom;
      this.renderer.setViewport(x, y, bounds.width, bounds.height);
      this.renderer.setScissor(x, y, bounds.width, bounds.height);
      this.renderer.render(this.scene, camera);
    });
    this.droneMeshes.forEach(mesh => { mesh.visible = true; });
  }

  capture(droneId: string, pose: Pose, drones?: WorldState['drones']): string {
    this.poseCamera(this.captureCamera, pose);
    const previousTarget = this.renderer.getRenderTarget();
    const previousViewport = this.renderer.getViewport(new THREE.Vector4());
    const previousScissor = this.renderer.getScissor(new THREE.Vector4());
    const previousTest = this.renderer.getScissorTest();
    const meshPoses = [...this.droneMeshes.values()].map(mesh => ({ mesh, position: mesh.position.clone(), rotation: mesh.rotation.clone() }));
    drones?.forEach(drone => {
      const mesh = this.droneMeshes.get(drone.id);
      if (mesh) { mesh.position.set(drone.x, drone.y - 0.14, drone.z); mesh.rotation.y = radians(drone.yaw); }
    });
    this.droneMeshes.forEach((mesh, id) => { mesh.visible = id !== droneId; });
    this.renderer.setRenderTarget(this.captureTarget);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, 512, 288);
    this.renderer.render(this.scene, this.captureCamera);
    const pixels = new Uint8Array(512 * 288 * 4);
    this.renderer.readRenderTargetPixels(this.captureTarget, 0, 0, 512, 288, pixels);
    this.renderer.setRenderTarget(previousTarget);
    this.renderer.setViewport(previousViewport);
    this.renderer.setScissor(previousScissor);
    this.renderer.setScissorTest(previousTest);
    meshPoses.forEach(({ mesh, position, rotation }) => { mesh.position.copy(position); mesh.rotation.copy(rotation); });
    this.droneMeshes.forEach(mesh => { mesh.visible = true; });
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 288;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Camera capture unavailable: no 2D canvas context.');
    const image = context.createImageData(512, 288);
    const row = 512 * 4;
    for (let y = 0; y < 288; y++) image.data.set(pixels.subarray((287 - y) * row, (288 - y) * row), y * row);
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.82);
  }

  dispose() {
    this.stopped = true;
    this.observer.disconnect();
    window.removeEventListener('scroll', this.invalidateFrame);
    document.removeEventListener('visibilitychange', this.invalidateFrame);
    disposeGroup(this.worldGroup);
    disposeGroup(this.treasureGroup);
    this.droneMeshes.forEach(mesh => disposeGroup(mesh));
    this.captureTarget.dispose();
    this.renderer.dispose();
  }
}
