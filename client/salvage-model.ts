import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** These are non-solid cargo props; the vehicle collision sphere is unchanged. */
export const SALVAGE_VISUAL = Object.freeze({ width: 0.22, height: 0.12, depth: 0.22, ochre: '#bd8c27', ink: '#171b1d', pallet: '#30363a' });

/** A broad black X, rendered as ordinary opaque paint, with no text/overlay. */
export function cargoSymbol(size: number, color: string = SALVAGE_VISUAL.ink): THREE.Mesh {
  const pieces = [-Math.PI / 4, Math.PI / 4].map(angle => {
    const geometry = new THREE.PlaneGeometry(size, size * 0.23);
    geometry.rotateZ(angle); return geometry;
  });
  const geometry = mergeGeometries(pieces)!;
  pieces.forEach(piece => piece.dispose());
  const symbol = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
  symbol.name = 'cargo-symbol'; return symbol;
}

/** Identical matte crate shape/markings in stock and beneath a carrying drone. */
export function salvageCrate() {
  const group = new THREE.Group(); group.name = 'crate';
  const { width, height, depth, ochre } = SALVAGE_VISUAL;
  const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), new THREE.MeshLambertMaterial({ color: ochre }));
  body.position.y = height / 2; body.name = 'crate-body'; group.add(body);
  const markSize = width * 0.72;
  const marks: THREE.BufferGeometry[] = [];
  // Merge all five broad painted faces into one draw; the lower face is hidden.
  for (const [x, y, z, rx, ry] of [
    [0, height + 0.001, 0, -Math.PI / 2, 0],
    [0, height / 2, depth / 2 + 0.001, 0, 0],
    [0, height / 2, -depth / 2 - 0.001, 0, Math.PI],
    [width / 2 + 0.001, height / 2, 0, 0, Math.PI / 2],
    [-width / 2 - 0.001, height / 2, 0, 0, -Math.PI / 2],
  ]) {
    const symbol = cargoSymbol(markSize);
    if (rx === 0) symbol.scale.y = height / width;
    symbol.position.set(x, y, z); symbol.rotation.set(rx, ry, 0); symbol.updateMatrix();
    marks.push(symbol.geometry.clone().applyMatrix4(symbol.matrix));
    symbol.geometry.dispose(); (symbol.material as THREE.Material).dispose();
  }
  const geometry = mergeGeometries(marks)!; marks.forEach(mark => mark.dispose());
  const paint = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color: SALVAGE_VISUAL.ink, side: THREE.DoubleSide }));
  paint.name = 'crate-markings'; group.add(paint);
  return group;
}

export function salvagePallet() {
  const pallet = new THREE.Mesh(new THREE.BoxGeometry(0.29, 0.025, 0.29), new THREE.MeshLambertMaterial({ color: SALVAGE_VISUAL.pallet }));
  pallet.name = 'pallet'; pallet.position.y = 0.0125; return pallet;
}
