import * as THREE from 'three';
import type { Drone } from './types';
import { dronePresentation } from './drone-presentation';
import { CARGO_CONFIG } from '../shared/rts';
import { salvageCrate } from './salvage-model';

export function makeDrone(id: string) {
  const group = new THREE.Group(); group.name = id;
  const material = new THREE.MeshLambertMaterial({ color: dronePresentation(id).color });
  const dark = new THREE.MeshLambertMaterial({ color: '#283640' });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.29, 0.14, 0.34), material); body.name = 'team-body-panel'; group.add(body);
  for (const x of [-0.19, 0.19]) for (const z of [-0.17, 0.17]) {
    const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.025, 12), dark);
    rotor.position.set(x, 0.08, z); group.add(rotor);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.055, 0.09), material); arm.name = 'team-arm-panel';
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
  const plates = new THREE.Group(); plates.name = 'armor-plates';
  const armorMaterial = new THREE.MeshLambertMaterial({ color: '#b3bdc0' });
  // Opaque fitted strips leave the broad colored body/arms visible.
  for (const x of [-0.15, 0.15]) {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.15, 0.23), armorMaterial); plate.position.set(x, 0, 0); plates.add(plate);
  }
  const bumper = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.04, 0.018), armorMaterial); bumper.position.set(0, 0.03, 0.18); plates.add(bumper); group.add(plates);
  const miner = new THREE.Group(); miner.name = 'miner'; miner.position.set(0, -0.11, 0);
  const drill = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.19, 8), new THREE.MeshLambertMaterial({ color: '#f6c767' })); drill.rotation.z = Math.PI; drill.position.y = -0.04;
  miner.add(drill, new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.065, 0.2), dark)); group.add(miner);
  const upgrade = new THREE.Group(); upgrade.name = 'miner-upgrade';
  for (const x of [-0.11, 0.11]) {
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.1, 8), material); motor.position.set(x, -0.005, 0); upgrade.add(motor);
  }
  miner.add(upgrade);
  const optics = new THREE.Group(); optics.name = 'optics'; optics.position.set(0, 0.03, -0.21);
  const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.14, 12), dark); scope.rotation.x = Math.PI / 2; optics.add(scope);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.047, 12), new THREE.MeshLambertMaterial({ color: '#568b96' })); lens.rotation.y = Math.PI; lens.position.z = -0.071; optics.add(lens); group.add(optics);
  const battery = new THREE.Group(); battery.name = 'battery'; battery.position.set(0, 0.06, 0.19);
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.13, 0.12), dark); battery.add(pack);
  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.025, 0.04), material); strap.position.y = 0.07; battery.add(strap); group.add(battery);
  const jammer = new THREE.Group(); jammer.name = 'jammer'; jammer.position.set(0, 0.12, 0.07);
  const housing = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.055, 0.09), dark); jammer.add(housing);
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.012, 0.2, 6), material); antenna.position.y = 0.12; jammer.add(antenna);
  const crossbar = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.012, 0.012), dark); crossbar.position.y = 0.2; jammer.add(crossbar); group.add(jammer);
  const grip = new THREE.Group(); grip.name = 'cargo-grip';
  for (const x of [-0.105, 0.105]) {
    const claw = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.09, 0.17), dark); claw.position.set(x, -0.105, 0); grip.add(claw);
  }
  group.add(grip);
  const rack = new THREE.Group(); rack.name = 'cargo-module';
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.025, 0.16), dark); rail.position.y = -0.1; rack.add(rail); group.add(rack);
  const cargo = new THREE.Group(); cargo.name = 'carried-cargo';
  for (let i = 0; i < 2; i++) { const crate = salvageCrate(); crate.name = `carried-crate-${i}`; cargo.add(crate); }
  group.add(cargo);
  return group;
}

export function positionDrone(mesh: THREE.Group, drone: Drone) {
  mesh.userData.drone = drone;
  const hauling = drone.cargo !== undefined;
  mesh.position.set(drone.x, drone.y - (hauling ? 0 : 0.14), drone.z);
  mesh.rotation.set(0, THREE.MathUtils.degToRad(drone.yaw), 0);
  const gun = mesh.getObjectByName('gun')!; gun.visible = Boolean(drone.equipment?.gun); gun.rotation.x = THREE.MathUtils.degToRad(drone.pitch); gun.position.y = hauling ? 0.04 : 0.14;
  mesh.getObjectByName('armor')!.visible = !hauling && drone.alive !== false && Boolean(drone.equipment?.armor);
  mesh.getObjectByName('armor-plates')!.visible = hauling && drone.alive !== false && Boolean(drone.equipment?.armor);
  mesh.getObjectByName('miner')!.visible = Boolean(drone.equipment?.miner);
  mesh.getObjectByName('miner-upgrade')!.visible = Boolean(drone.equipment?.miner && drone.equipment.minerUpgrade);
  const optics = mesh.getObjectByName('optics')!; optics.visible = Boolean(drone.equipment?.optics); optics.rotation.x = THREE.MathUtils.degToRad(drone.pitch);
  mesh.getObjectByName('battery')!.visible = Boolean(drone.equipment?.battery);
  mesh.getObjectByName('jammer')!.visible = Boolean(drone.equipment?.jammer);
  mesh.getObjectByName('cargo-grip')!.visible = hauling;
  mesh.getObjectByName('cargo-module')!.visible = hauling && Boolean(drone.equipment?.cargo);
  const cargo = mesh.getObjectByName('carried-cargo')!;
  const amount = drone.alive === false ? 0 : Math.max(0, drone.cargo?.amount ?? 0);
  cargo.visible = amount > 0;
  cargo.children.forEach((crate, index) => {
    const fraction = Math.max(0, Math.min(1, (amount - index * CARGO_CONFIG.crateValue) / CARGO_CONFIG.crateValue));
    crate.visible = fraction > 0; crate.scale.y = fraction;
    crate.position.set(amount > CARGO_CONFIG.crateValue ? index ? 0.12 : -0.12 : 0, -0.25, 0);
  });
}
