import * as THREE from 'three';
import type { MatchState } from '../shared/rts';
import type { Obstacle } from '../shared/types';
import { graphicsAsset } from './graphics-assets';
import { disposeGroup } from './city-scene';
import { WRECK_VISUALS, wreckPose, wreckSmoke, wreckTrajectory, type WreckTrajectory } from './wreck-model';

function charredAirframe() {
  const body = graphicsAsset('airframe', '#272a2c') ?? new THREE.Group();
  if (!body.children.length) {
    const material = new THREE.MeshStandardMaterial({ color: '#272a2c', roughness: .95 });
    body.add(new THREE.Mesh(new THREE.BoxGeometry(.29, .14, .34), material));
    for (const x of [-.19, .19]) for (const z of [-.17, .17]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(.31, .055, .09), material);
      arm.position.set(x / 2, 0, z / 2); arm.rotation.y = x * z > 0 ? -Math.PI / 4 : Math.PI / 4;
      const rotor = new THREE.Mesh(new THREE.CylinderGeometry(.075, .075, .025, 10), material); rotor.position.set(x, .08, z);
      body.add(arm, rotor);
    }
  }
  body.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of [object.material].flat() as THREE.MeshStandardMaterial[]) {
      material.color?.set('#272a2c'); material.emissive?.set(0); material.emissiveIntensity = 0;
      material.roughness = .95; material.metalness = .1; material.toneMapped = true;
    }
  });
  body.userData.wreckBounds = new THREE.Box3().setFromObject(body);
  return body;
}

/** One instanced, camera-facing smoke draw, with ordinary depth occlusion and fog. */
function smokeMesh(capacity: number) {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.setAttribute('smokeOpacity', new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1));
  geometry.setAttribute('smokeAngle', new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1));
  const material = new THREE.ShaderMaterial({
    transparent: true, depthTest: true, depthWrite: false, fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { tint: { value: new THREE.Color('#414346') } }]),
    vertexShader: `#include <common>
      #include <fog_pars_vertex>
      attribute float smokeOpacity; attribute float smokeAngle;
      varying vec2 puffUv; varying float puffOpacity;
      void main() {
        float c=cos(smokeAngle), s=sin(smokeAngle);
        puffUv=mat2(c,-s,s,c)*(uv-0.5)*2.0; puffOpacity=smokeOpacity;
        vec4 mvPosition=modelViewMatrix*instanceMatrix*vec4(0.0,0.0,0.0,1.0);
        mvPosition.xy+=position.xy*vec2(length(instanceMatrix[0].xyz),length(instanceMatrix[1].xyz));
        gl_Position=projectionMatrix*mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `#include <common>
      #include <fog_pars_fragment>
      uniform vec3 tint; varying vec2 puffUv; varying float puffOpacity;
      void main() {
        float r=length(puffUv);
        float cloud=0.76+0.12*sin(puffUv.x*8.0+sin(puffUv.y*5.0))+0.12*cos(puffUv.y*9.0+puffUv.x*4.0);
        float alpha=(1.0-smoothstep(0.18,1.0,r))*cloud*puffOpacity;
        gl_FragColor=vec4(tint,alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = 'gun-wreck-smoke'; mesh.count = 0; mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return mesh;
}

/** Death visuals never mutate drone state, collision geometry, cargo or actor tools. */
export class WreckView {
  private root = new THREE.Group();
  private smoke = smokeMesh(WRECK_VISUALS.maxWrecks * WRECK_VISUALS.particlesPerDrone);
  private bodies: THREE.Group[] = [];
  private trajectories: WreckTrajectory[] = [];
  private signature = '';
  private current?: MatchState;
  private obstacles: readonly Obstacle[] = [];
  private time = 0;
  private transform = new THREE.Object3D();
  private bounds = new THREE.Box3();

  constructor(private scene: THREE.Scene) { this.root.name = 'gun-wrecks'; this.root.add(this.smoke); scene.add(this.root); }

  update(match: MatchState | undefined, obstacles: readonly Obstacle[], time: number) {
    this.current = match; this.obstacles = obstacles;
    const seeds = match?.rulesVersion === 'cargo-v3' ? (match.wrecks ?? []).slice(0, WRECK_VISUALS.maxWrecks) : [];
    const signature = JSON.stringify([seeds, seeds.length ? obstacles : []]);
    if (signature !== this.signature) {
      this.signature = signature; this.trajectories = seeds.map(seed => wreckTrajectory(seed, obstacles));
      while (this.bodies.length > seeds.length) {
        const body = this.bodies.pop()!; this.root.remove(body); disposeGroup(body);
      }
      while (this.bodies.length < seeds.length) { const body = charredAirframe(); this.bodies.push(body); this.root.add(body); }
      this.bodies.forEach((body, index) => { body.name = `gun-wreck-${seeds[index].drone}`; });
    }
    this.animate(time);
  }

  animate(time: number) {
    this.time = time;
    const opacity = this.smoke.geometry.getAttribute('smokeOpacity') as THREE.InstancedBufferAttribute;
    const angle = this.smoke.geometry.getAttribute('smokeAngle') as THREE.InstancedBufferAttribute;
    let count = 0;
    this.trajectories.forEach((trajectory, index) => {
      const pose = wreckPose(trajectory, time), body = this.bodies[index];
      body.visible = Boolean(pose);
      if (!pose) return;
      body.position.set(pose.x, pose.y, pose.z); body.rotation.set(pose.pitch, pose.yaw, pose.roll);
      // A tumbling arm must not cut through the contacted roof before settling.
      body.updateMatrix(); this.bounds.copy(body.userData.wreckBounds as THREE.Box3).applyMatrix4(body.matrix);
      body.position.y += Math.max(0, trajectory.floor - WRECK_VISUALS.clearance + .015 - this.bounds.min.y);
      for (const puff of wreckSmoke(trajectory, time)) {
        this.transform.position.set(puff.x, puff.y, puff.z); this.transform.scale.setScalar(puff.radius * 2); this.transform.updateMatrix();
        this.smoke.setMatrixAt(count, this.transform.matrix); opacity.setX(count, puff.opacity); angle.setX(count, puff.angle); count++;
      }
    });
    this.smoke.count = count; this.smoke.visible = count > 0;
    this.smoke.instanceMatrix.needsUpdate = true; opacity.needsUpdate = true; angle.needsUpdate = true;
  }

  withSnapshot<T>(match: MatchState | undefined, obstacles: readonly Obstacle[], time: number, render: () => T): T {
    const previous = this.current, previousObstacles = this.obstacles, previousTime = this.time;
    try { this.update(match, obstacles, time); return render(); }
    finally { this.update(previous, previousObstacles, previousTime); }
  }

  dispose() { this.scene.remove(this.root); disposeGroup(this.root); this.bodies = []; this.trajectories = []; }
}
