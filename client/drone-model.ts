import * as THREE from 'three';
import type { Drone } from './types';
import { dronePresentation } from './drone-presentation';

export function makeDrone(id: string) {
  const group = new THREE.Group(); group.name = id;
  const material = new THREE.MeshLambertMaterial({ color: dronePresentation(id).color });
  const dark = new THREE.MeshLambertMaterial({ color: '#283640' });
  group.add(new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.14, 0.32), material));
  for (const x of [-0.21, 0.21]) for (const z of [-0.19, 0.19]) {
    const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.025, 12), dark);
    rotor.position.set(x, 0.08, z); group.add(rotor);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.33, 0.045, 0.045), material);
    arm.position.set(x / 2, 0, z / 2); arm.rotation.y = x * z > 0 ? -Math.PI / 4 : Math.PI / 4; group.add(arm);
  }
  const camera = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.07, 0.035), dark); camera.position.set(0, 0.045, -0.175); group.add(camera);
  const gun = new THREE.Group(); gun.name = 'gun'; gun.position.y = 0.14;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.029, 0.27, 10), dark);
  barrel.rotation.x = Math.PI / 2; barrel.position.z = -0.14; gun.add(barrel);
  const breech = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.07, 0.1), material); breech.position.z = -0.015; gun.add(breech); group.add(gun);
  const armor = new THREE.Group(); armor.name = 'armor'; armor.position.y = 0.14;
  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(0.38, 1), new THREE.MeshLambertMaterial({ color: '#d1e6f2', transparent: true, opacity: 0.22, depthWrite: false })); armor.add(shell);
  const cage = new THREE.LineSegments(new THREE.EdgesGeometry(shell.geometry), new THREE.LineBasicMaterial({ color: '#b9d7e8', transparent: true, opacity: 0.7 })); armor.add(cage); group.add(armor);
  const miner = new THREE.Group(); miner.name = 'miner'; miner.position.set(0, -0.11, 0);
  const drill = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.19, 8), new THREE.MeshLambertMaterial({ color: '#f6c767' })); drill.rotation.z = Math.PI; drill.position.y = -0.04;
  miner.add(drill, new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.065, 0.2), dark)); group.add(miner);
  return group;
}

export function positionDrone(mesh: THREE.Group, drone: Drone) {
  mesh.userData.drone = drone;
  mesh.position.set(drone.x, drone.y - 0.14, drone.z);
  mesh.rotation.set(0, THREE.MathUtils.degToRad(drone.yaw), drone.alive === false ? 1.1 : 0);
  const gun = mesh.getObjectByName('gun')!; gun.visible = Boolean(drone.equipment?.gun); gun.rotation.x = THREE.MathUtils.degToRad(drone.pitch);
  mesh.getObjectByName('armor')!.visible = drone.alive !== false && Boolean(drone.equipment?.armor);
  mesh.getObjectByName('miner')!.visible = Boolean(drone.equipment?.miner);
  const body = mesh.children[0] as THREE.Mesh<THREE.BoxGeometry, THREE.MeshLambertMaterial>;
  body.material.color.set(drone.alive === false ? '#363b3f' : dronePresentation(drone.id).color);
}
