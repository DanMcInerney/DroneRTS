import * as THREE from 'three';
import type { MatchState } from '../shared/rts';
import { PROJECTILE_SMOKE, projectileSmoke, projectileTrails, type ProjectileTrail } from './projectile-trail-model';

/** One fixed-capacity draw: white smoke capsules face each actual render camera. */
export class ProjectileTrailView {
  private mesh: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private trails: ProjectileTrail[] = [];

  constructor(private scene: THREE.Scene) {
    const capacity = PROJECTILE_SMOKE.maxTrails * PROJECTILE_SMOKE.segmentsPerTrail;
    const geometry = new THREE.PlaneGeometry(1, 1);
    for (const [name, size] of [['trailStart', 3], ['trailEnd', 3], ['trailStyle', 3]] as const) {
      const attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
      attribute.setUsage(THREE.DynamicDrawUsage); geometry.setAttribute(name, attribute);
    }
    const material = new THREE.ShaderMaterial({
      transparent: true, depthTest: true, depthWrite: false, fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { tint: { value: new THREE.Color('#f3f5f4') } }]),
      vertexShader: `#include <common>
        #include <fog_pars_vertex>
        attribute vec3 trailStart; attribute vec3 trailEnd; attribute vec3 trailStyle;
        varying vec2 cloudUv; varying float puffOpacity; varying float puffSeed; varying float aspect;
        void main() {
          vec4 a=modelViewMatrix*vec4(trailStart,1.0), b=modelViewMatrix*vec4(trailEnd,1.0);
          vec2 delta=b.xy-a.xy; float span=length(delta), radius=trailStyle.x;
          vec2 axis=span>0.00001 ? delta/span : vec2(1.0,0.0);
          vec4 mvPosition=mix(a,b,0.5);
          mvPosition.xy+=axis*position.x*(span+2.0*radius)+vec2(-axis.y,axis.x)*position.y*2.0*radius;
          mvPosition.z=mix(a.z,b.z,clamp(position.x+0.5,0.0,1.0));
          aspect=span/(2.0*radius); cloudUv=vec2(position.x*2.0*(aspect+1.0),position.y*2.0);
          puffOpacity=trailStyle.y; puffSeed=trailStyle.z;
          gl_Position=projectionMatrix*mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `#include <common>
        #include <fog_pars_fragment>
        uniform vec3 tint; varying vec2 cloudUv; varying float puffOpacity; varying float puffSeed; varying float aspect;
        void main() {
          float r=length(vec2(max(abs(cloudUv.x)-aspect,0.0),cloudUv.y));
          float cloud=0.82+0.1*sin(cloudUv.x*2.7+puffSeed+sin(cloudUv.y*5.0))+0.08*cos(cloudUv.y*8.0+puffSeed);
          gl_FragColor=vec4(tint,(1.0-smoothstep(0.05,1.0,r))*cloud*puffOpacity);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.name = 'projectile-white-smoke'; this.mesh.count = 0; this.mesh.visible = false; this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  setSnapshot(match: MatchState | undefined, time: number) { this.trails = projectileTrails(match, time); }

  animate(time: number) {
    const start = this.mesh.geometry.getAttribute('trailStart') as THREE.InstancedBufferAttribute;
    const end = this.mesh.geometry.getAttribute('trailEnd') as THREE.InstancedBufferAttribute;
    const style = this.mesh.geometry.getAttribute('trailStyle') as THREE.InstancedBufferAttribute;
    let count = 0;
    for (const trail of this.trails) for (const segment of projectileSmoke(trail, time)) {
      start.setXYZ(count, segment.start.x, segment.start.y, segment.start.z);
      end.setXYZ(count, segment.end.x, segment.end.y, segment.end.z);
      style.setXYZ(count, segment.radius, segment.opacity, segment.seed); count++;
    }
    this.mesh.count = count; this.mesh.visible = count > 0;
    for (const attribute of [start, end, style]) {
      attribute.clearUpdateRanges(); if (count) attribute.addUpdateRange(0, count * 3); attribute.needsUpdate = true;
    }
  }

  dispose() { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.trails = []; }
}
