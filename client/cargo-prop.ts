import * as THREE from 'three';
import type { ResourceNode } from '../shared/rts';

const material = (color: string) => new THREE.MeshLambertMaterial({ color });

/** Printed cargo markings are ordinary opaque surfaces in the physical scene. */
function marking(text: string, pad = false) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = pad ? 512 : 160;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#152925'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#d7ff79'; ctx.lineWidth = 12;
  ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);
  ctx.fillStyle = '#e4ff93'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (pad) {
    // Four approach arrows and a stack of ingots make this a collection pad,
    // recognizable from above even before its printed instruction can be read.
    for (let turn = 0; turn < 4; turn++) {
      ctx.save(); ctx.translate(256, 256); ctx.rotate(turn * Math.PI / 2);
      ctx.beginPath(); ctx.moveTo(-22, -200); ctx.lineTo(22, -200);
      ctx.lineTo(22, -150); ctx.lineTo(46, -150); ctx.lineTo(0, -108);
      ctx.lineTo(-46, -150); ctx.lineTo(-22, -150); ctx.closePath(); ctx.fill(); ctx.restore();
    }
    ctx.fillStyle = '#ffce43';
    for (const [x, y] of [[190, 236], [266, 236], [228, 183]]) {
      ctx.beginPath(); ctx.moveTo(x, y + 36); ctx.lineTo(x + 10, y);
      ctx.lineTo(x + 52, y); ctx.lineTo(x + 62, y + 36); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = '#f5ffdd'; ctx.font = '900 52px Arial'; ctx.fillText(text, 256, 310, 340);
  } else {
    ctx.font = '900 87px Arial'; ctx.fillText(text, 256, 83, 472);
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: texture });
}

function box(group: THREE.Group, size: [number, number, number], position: [number, number, number], surface: THREE.Material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), surface);
  mesh.position.set(...position); group.add(mesh); return mesh;
}

/** Cargo geometry is independent of simulation rules and player UI cards. */
export function createCargoProp(node: ResourceNode): THREE.Group {
  const group = new THREE.Group(); group.position.set(node.x, node.y, node.z);
  const large = node.capacity >= 240, width = large ? 3.2 : 2.1, half = width / 2;
  const steel = material('#243936'), ribs = material('#758a7d'), gold = material('#ffc949');
  const orange = material('#ffb52e');
  // Forklift pockets, reinforced edges and exposed gold stock read as cargo.
  for (const x of [-half * 0.72, half * 0.72]) box(group, [width * 0.18, 0.16, width], [x, -0.25, 0], steel);
  box(group, [width, 0.18, width], [0, -0.1, 0], ribs);
  const bodyHeight = large ? 0.7 : 0.5;
  box(group, [width, bodyHeight, width], [0, bodyHeight / 2, 0], steel);
  for (const x of [-half + 0.07, half - 0.07]) for (const z of [-half + 0.07, half - 0.07]) {
    box(group, [0.14, bodyHeight + 0.1, 0.14], [x, bodyHeight / 2, z], orange);
  }
  const loaded = new THREE.Group(); loaded.name = 'loaded';
  const empty = new THREE.Group(); empty.name = 'empty';
  const labelWidth = width - 0.28, labelHeight = bodyHeight * 0.78;
  const fullLabel = marking('SALVAGE'), emptyLabel = marking('EMPTY');
  for (let side = 0; side < 4; side++) {
    const angle = side * Math.PI / 2;
    for (const [holder, surface] of [[loaded, fullLabel], [empty, emptyLabel]] as const) {
      const label = new THREE.Mesh(new THREE.PlaneGeometry(labelWidth, labelHeight), surface);
      label.position.set(Math.sin(angle) * (half + 0.005), bodyHeight / 2, Math.cos(angle) * (half + 0.005));
      label.rotation.y = angle; holder.add(label);
    }
  }
  // The unobstructed middle is a visible approach/collection surface. This does
  // not add a landing requirement or collision volume to the mining operation.
  for (const [holder, text] of [[loaded, 'COLLECT'], [empty, 'EMPTY']] as const) {
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(width * 0.76, width * 0.76), marking(text, true));
    pad.rotation.x = -Math.PI / 2; pad.position.y = bodyHeight + 0.006; holder.add(pad);
  }
  const stock = new THREE.Group(); stock.name = 'stock';
  const count = large ? 16 : 8;
  for (let index = 0; index < count; index++) {
    const corner = index % 4, layer = Math.floor(index / 4), size = large ? 0.38 : 0.28;
    const ingot = box(stock, [size, 0.18, size * 0.65], [
      (corner < 2 ? -1 : 1) * (half - size * 0.6), bodyHeight + 0.1 + layer * 0.18,
      (corner % 2 ? -1 : 1) * (half - size * 0.6),
    ], gold);
    ingot.rotation.y = layer % 2 ? Math.PI / 2 : 0;
  }
  group.add(loaded, empty, stock); updateCargoProp(group, node); return group;
}

export function updateCargoProp(group: THREE.Group, node: ResourceNode) {
  const stocked = node.remaining > 0;
  group.getObjectByName('loaded')!.visible = stocked;
  group.getObjectByName('empty')!.visible = !stocked;
  const stock = group.getObjectByName('stock')!;
  const visibleCount = Math.ceil(stock.children.length * Math.max(0, Math.min(1, node.remaining / Math.max(1, node.capacity))));
  stock.children.forEach((ingot, index) => { ingot.visible = index < visibleCount; });
}
