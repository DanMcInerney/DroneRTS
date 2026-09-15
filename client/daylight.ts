import * as THREE from 'three';

/** Shared daylight for spectator and acquired cameras; static shadows render once. */
export function daylight(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
  scene.background = new THREE.Color('#c4d4dc');
  scene.fog = new THREE.Fog('#c4d4dc', 95, 300);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { top: { value: new THREE.Color('#658ca9') }, horizon: { value: new THREE.Color('#d8dfe0') } },
    vertexShader: `varying vec3 direction;
      void main(){ direction=position; vec4 clip=projectionMatrix*mat4(mat3(viewMatrix))*vec4(position,1.0);
      gl_Position=clip.xyww; }`,
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; varying vec3 direction;
      void main(){ float h=max(normalize(direction).y,0.0); gl_FragColor=vec4(mix(horizon,top,pow(h,0.6)),1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
  }));
  sky.name = 'daylight-sky'; scene.add(sky);
  // A filtered sky supplies real PBR reflections without external HDR downloads.
  const environmentScene = new THREE.Scene(); environmentScene.add(sky.clone());
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(environmentScene, .06); pmrem.dispose();
  scene.environment = environment.texture; scene.environmentIntensity = .55;
  scene.add(new THREE.HemisphereLight(0xd5e3ef, 0x777362, 1.65));
  const sun = new THREE.DirectionalLight(0xffefd8, 3.1);
  sun.position.set(-45, 85, 52); sun.target.position.set(9, 0, 13);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -66, right: 66, top: 66, bottom: -66, near: 1, far: 220 });
  sun.shadow.bias = -.0008; sun.shadow.normalBias = .06;
  scene.add(sun, sun.target);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  return () => { environment.dispose(); sky.geometry.dispose(); sky.material.dispose(); sun.shadow.dispose(); };
}
