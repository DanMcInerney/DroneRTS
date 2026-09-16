/** Browser-only visual fixture; no simulator mutations, actors or inference. */
import * as THREE from 'three';
import { loadGraphicsAssets, graphicsAsset } from '../client/graphics-assets';
import { createCity, disposeGroup } from '../client/city-scene';
import { daylight } from '../client/daylight';
import { makeDrone, positionDrone } from '../client/drone-model';
import { cargoResourceProp, cargoServiceProp } from '../client/cargo-scenery';
import { FleetScene } from '../client/scene';
import { navigationPhase, updateNavigationLights } from '../client/navigation-lights';
import type { WorldState, Pose } from '../client/types';

export async function graphicsFixture(state: WorldState) {
  await loadGraphicsAssets();
  document.body.style.cssText = 'margin:0;background:#d4dbde;overflow:hidden';
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(1440, 900); renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.append(renderer.domElement);
  const scene = new THREE.Scene(), disposeLight = daylight(scene, renderer);
  const world = createCity(state.obstacles); scene.add(world);
  for (const node of state.match?.resources ?? []) world.add(cargoResourceProp(node, true));
  for (const pad of state.match?.servicePads ?? []) world.add(cargoServiceProp(pad, true));
  updateNavigationLights(world, .6);
  const camera = new THREE.PerspectiveCamera(53, 1440/900, .05, 800);
  const shots: Record<string, string> = {};
  const atlas = world.getObjectByName('downtown-paving-and-road-atlas') as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  shots['mapped-ground-atlas'] = (atlas.material.map!.image as HTMLCanvasElement).toDataURL('image/png');
  const shoot = (name: string, from: number[], to: number[]) => {
    camera.position.fromArray(from); camera.lookAt(new THREE.Vector3().fromArray(to));
    renderer.shadowMap.needsUpdate = true; renderer.render(scene, camera);
    shots[name] = renderer.domElement.toDataURL('image/png');
  };
  shoot('cincinnati-skyline', [3, 32, 62], [10, 5, 12]);
  shoot('carew-street', [-2, 2.7, 32], [-12, 8, 7]);
  shoot('queen-city-square', [27, 15, 37], [42, 11, 19]);
  camera.up.set(0, 0, -1);
  shoot('battlefield-overhead', [9, 92, 13], [9, 0, 13]);
  shoot('central-intersection', [8.126, 9, 14.521], [8.126, 0, 14.521]);
  shoot('pg-gardens', [44, 25, -10], [44, 0, -10]);
  shoot('southern-ground', [29, 23, 37], [29, 0, 37]);
  shoot('empty-parking-lots', [-18, 12, 31], [-18, 0, 31]);
  for (const node of state.match?.resources ?? []) {
    shoot(node.id+'-rooftop', [node.x, node.y+9, node.z], [node.x, node.y, node.z]);
  }
  shoot('blue-rooftop-base', [-25.673, 12, 11.541], [-25.673, 1.28, 11.541]);
  shoot('red-rooftop-base', [41.343, 12, 13.161], [41.343, 1.8, 13.161]);
  camera.up.set(0, 1, 0);
  shoot('transparent-wall', [47, 11, 19], [50, 11, 12]);
  shoot('transparent-ceiling', [9, 76, 13], [14, 80, 11]);
  const cityStats = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  scene.remove(world); disposeGroup(world);
  scene.fog = null; scene.getObjectByName('daylight-sky')!.visible = false; scene.background = new THREE.Color('#cbd3d5');
  const drone = makeDrone('drone-1');
  positionDrone(drone, { ...state.drones[0], x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }); scene.add(drone);
  camera.fov = 34; camera.near = .005; camera.updateProjectionMatrix();
  shoot('consumer-drone', [.67,.46,-.79], [0,0,0]);
  const red = makeDrone('drone-4');
  positionDrone(red, { ...state.drones[3], x: .62, y: 0, z: 0, yaw: 0, pitch: 0 });
  scene.add(red); shoot('team-navigation-lights', [1.35, .55, -1.5], [.31, 0, 0]);
  const peak = (2.4 + .216 - navigationPhase('drone-1')) % 2.4;
  updateNavigationLights(drone, peak);
  updateNavigationLights(red, peak);
  shoot('team-navigation-flash-a', [1.35, .55, -1.5], [.31, 0, 0]);
  updateNavigationLights(drone, peak + 1.2);
  updateNavigationLights(red, peak + 1.2);
  shoot('team-navigation-flash-b', [1.35, .55, -1.5], [.31, 0, 0]);
  scene.remove(red); disposeGroup(red);
  drone.visible = false;
  const crate = graphicsAsset('crate')!, pallet = graphicsAsset('pallet')!;
  crate.position.y = .029; scene.add(crate,pallet);
  shoot('salvage-crate', [.40,.34,-.46], [0,.065,0]);
  scene.remove(drone,crate,pallet); disposeGroup(drone); disposeGroup(crate); disposeGroup(pallet);
  disposeLight(); renderer.dispose(); renderer.domElement.remove();

  // Timed images run through the production acquisition path, including JPEG encoding.
  const host = document.createElement('div'); host.style.cssText='width:1440px;height:900px;position:relative';
  const map = document.createElement('div'); map.style.cssText='width:1440px;height:300px';
  host.append(map); document.body.append(host);
  const fleet = new FleetScene(host, [], map); fleet.update(state);
  const poses: Pose[] = [
    {x:3,y:24,z:55,yaw:0,pitch:-23},
    {x:-2,y:3,z:32,yaw:18,pitch:12},
    {x:29,y:12,z:33,yaw:-35,pitch:5},
  ];
  const times: number[] = [];
  for (let n=0;n<33;n++) {
    const begin = performance.now();
    const frame = fleet.capture('drone-1',poses[n%3],state.drones,state.match);
    if(n>=3) times.push(performance.now()-begin);
    if(n<3) shots[`fpv-${n+1}`] = frame;
  }
  for (const node of state.match?.resources ?? []) {
    shots[node.id+'-acquired'] = fleet.capture('drone-1', {x:node.x,y:node.y+8,z:node.z+3,yaw:0,pitch:-68}, state.drones, state.match, .6);
  }
  const opticalDrones = structuredClone(state.drones);
  Object.assign(opticalDrones.find(drone => drone.id === 'drone-4')!, {x:0,y:65,z:12,yaw:0,pitch:0,alive:true});
  const opticalPose = {x:0,y:65,z:20,yaw:0,pitch:0};
  const opticalPeak = (2.4 + .216 - navigationPhase('drone-4')) % 2.4;
  shots['drone-flash-acquired-on'] = fleet.capture('drone-1', opticalPose, opticalDrones, state.match, opticalPeak);
  shots['drone-flash-acquired-off'] = fleet.capture('drone-1', opticalPose, opticalDrones, state.match, opticalPeak+1.2);
  fleet.dispose(); host.remove();
  return { shots, cityStats, captureMs: times.sort((a,b)=>a-b) };
}
