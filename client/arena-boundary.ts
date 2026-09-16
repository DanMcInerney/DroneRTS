import * as THREE from 'three';
import type { Obstacle } from '../shared/types';

export const isArenaBoundary = (obstacle: Obstacle) => /^arena-(wall-(west|east|north|south)|ceiling)$/.test(obstacle.id ?? '');

/** Render only the enclosure volumes actually present in this world snapshot. */
export function createArenaBoundary(obstacles: Obstacle[]) {
  const group = new THREE.Group(); group.name = 'transparent-flight-enclosure';
  const surface = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.FrontSide,
    uniforms: { tint: { value: new THREE.Color('#9ebbc0') } },
    vertexShader: `varying vec3 worldPoint;
      void main(){ vec4 world=modelMatrix*vec4(position,1.0); worldPoint=world.xyz;
        gl_Position=projectionMatrix*viewMatrix*world; }`,
    fragmentShader: `uniform vec3 tint; varying vec3 worldPoint;
      void main(){
        vec3 grid=abs(fract(worldPoint/8.0-0.5)-0.5)*8.0;
        // Two varying surface axes form a sparse grid; the thin normal axis
        // never contributes a solid fill at integer-aligned boundary planes.
        vec3 extent=fwidth(worldPoint);
        vec3 line=vec3(1.0)-smoothstep(vec3(0.006),max(extent*1.2,vec3(0.018)),grid);
        line*=step(vec3(0.0001),extent);
        float nearWall=1.0-smoothstep(3.0,22.0,distance(cameraPosition,worldPoint));
        float ink=max(line.x,max(line.y,line.z));
        gl_FragColor=vec4(tint,0.006+nearWall*(0.012+ink*0.11));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const edge = new THREE.LineBasicMaterial({ color: '#92b4bb', transparent: true, opacity: .13, depthWrite: false });
  for (const obstacle of obstacles.filter(isArenaBoundary)) {
    const geometry = new THREE.BoxGeometry(obstacle.width, obstacle.height, obstacle.depth);
    // Interior faces are visible while the outer surface remains transparent.
    const mesh = new THREE.Mesh(geometry, surface); mesh.material.side = THREE.DoubleSide;
    mesh.name = obstacle.id ?? 'arena-boundary';
    mesh.position.set(obstacle.x, (obstacle.baseY ?? 0) + obstacle.height / 2, obstacle.z);
    mesh.rotation.y = THREE.MathUtils.degToRad(obstacle.rotation ?? 0);
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edge);
    mesh.add(outline); group.add(mesh);
  }
  // Avoid retaining unused GPU materials in custom/historical unbounded scenes.
  if (!group.children.length) { surface.dispose(); edge.dispose(); }
  return group;
}
