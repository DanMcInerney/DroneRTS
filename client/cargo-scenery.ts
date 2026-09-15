import * as THREE from 'three';
import { apronServicePositions, CARGO_CONFIG, resourceZoneSize, serviceZoneSize, type ResourceNode, type ServicePad } from '../shared/rts';
import { cargoSymbol, salvageCrate, salvagePallet, SALVAGE_VISUAL } from './salvage-model';
import { graphicsAsset } from './graphics-assets';

const paint = (color: THREE.ColorRepresentation) => new THREE.MeshLambertMaterial({ color });

function groundMark(width: number, depth: number, color: THREE.ColorRepresentation, x = 0, z = 0, y = 0.068) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), paint(color));
  mesh.rotation.x = -Math.PI / 2; mesh.position.set(x, y, z); return mesh;
}

/** Horizontal paint matches the whole usable footprint; service height is SDK calibration. */
function apron(id: string, x: number, y: number, z: number, size: number, color: string, service: boolean) {
  const group = new THREE.Group(); group.name = id; group.position.set(x, y, z);
  const surface = groundMark(size, size, service ? color : '#bda766', 0, 0, 0.062);
  surface.name = 'apron-surface'; group.add(surface);
  const inset = groundMark(size - 0.16, size - 0.16, service ? new THREE.Color(color).multiplyScalar(0.45) : '#4b5050', 0, 0, 0.064);
  inset.name = 'apron-inset'; group.add(inset);
  const positions = new THREE.Group(); positions.name = 'service-positions';
  for (const point of apronServicePositions({ x: 0, y: 0, z: 0 }, size)) {
    const mark = new THREE.Group(); mark.name = 'service-position'; mark.position.set(point.x, 0, point.z);
    const radius = Math.min(0.4, size * 0.155);
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.04, radius, 64), paint(service ? '#dce5dc' : '#bda766'));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.068; mark.add(ring);
    const symbol = cargoSymbol(radius * 1.1, service ? '#dce5dc' : '#bda766');
    symbol.rotation.x = -Math.PI / 2; symbol.position.y = 0.069; mark.add(symbol); positions.add(mark);
  }
  group.add(positions); return group;
}

function stockPositions(count: number, size: number) {
  if (count <= 4) return Array.from({ length: count }, (_, index) => ({ x: (index - (count - 1) / 2) * 0.34, z: size * 0.04 }));
  const perSide = Math.ceil(count / 4), edge = size * 0.39;
  return Array.from({ length: count }, (_, index) => {
    const along = ((index % perSide + 0.5) / perSide - 0.5) * size * 0.58;
    switch (Math.floor(index / perSide)) {
      case 0: return { x: along, z: -edge };
      case 1: return { x: edge, z: along };
      case 2: return { x: -along, z: edge };
      default: return { x: -edge, z: -along };
    }
  });
}

export function cargoResourceProp(node: ResourceNode) {
  const size = resourceZoneSize(node);
  const group = apron(node.id, node.x, node.y, node.z, size, SALVAGE_VISUAL.ochre, false);
  group.rotation.y = THREE.MathUtils.degToRad(node.rotation ?? 0);
  const pallets = new THREE.Group(); pallets.name = 'pallets';
  const stock = new THREE.Group(); stock.name = 'stock';
  const count = Math.ceil(node.capacity / CARGO_CONFIG.crateValue);
  const slots = stockPositions(size < 2.2 ? Math.ceil(count / 2) : count, size);
  for (let index = 0; index < count; index++) {
    const stacked = slots.length < count;
    const point = slots[stacked ? Math.floor(index / 2) : index];
    // Higher stock indices disappear first; keep each upper crate after its support.
    const layer = stacked ? index % 2 : 0;
    if (layer === 0) {
      const pallet = salvagePallet(); pallet.position.set(point.x, 0.066, point.z); pallets.add(pallet);
    }
    const crate = salvageCrate(); crate.name = `stock-crate-${index}`;
    crate.position.set(point.x, 0.088 + layer * 0.125, point.z); stock.add(crate);
  }
  group.add(pallets, stock); return group;
}

/** Pending reservations remain visible until the authority completes pickup. */
export function updateCargoStock(group: THREE.Group, node: ResourceNode) {
  const stock = group.getObjectByName('stock');
  if (!stock) return;
  stock.visible = node.remaining > 0;
  stock.children.forEach((crate, index) => {
    const amount = Math.max(0, Math.min(CARGO_CONFIG.crateValue, node.remaining - index * CARGO_CONFIG.crateValue));
    crate.visible = amount > 0; crate.scale.y = amount / CARGO_CONFIG.crateValue;
  });
}

export function cargoServiceProp(pad: ServicePad) {
  const size = serviceZoneSize(pad), color = pad.team === 'blue' ? '#2799ba' : '#bc5147';
  const group = apron(pad.id, pad.x, pad.y, pad.z, size, color, true);
  group.rotation.y = THREE.MathUtils.degToRad(pad.rotation ?? 0);
  const asset = graphicsAsset('service-cabinet', color);
  if (asset) { asset.position.set(size * 0.35, 0.067, size * 0.4); group.add(asset); return group; }
  // A low service cabinet is a non-solid interaction prop, below even the lowest
  // service-hover body envelope. It adds no obstacle or approach restriction.
  const cabinet = new THREE.Group(); cabinet.name = 'service-cabinet'; cabinet.position.set(size * 0.35, 0.067, size * 0.4);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.14, 0.24), paint('#3b4144')); body.position.y = 0.07; cabinet.add(body);
  const top = groundMark(0.43, 0.20, color, 0, 0, 0.141); cabinet.add(top);
  const stripe = groundMark(0.055, 0.17, '#dce5dc', 0, 0, 0.143); cabinet.add(stripe);
  group.add(cabinet); return group;
}
