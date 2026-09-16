import * as THREE from 'three';

/** Ordinary, opaque roof paint. Large shapes survive the 512×288 onboard camera. */
export function apronPaint(service: boolean, teamColor: string) {
  const yellow = '#ffd52a', ink = '#171b1d';
  const material = new THREE.MeshLambertMaterial({ color: service ? teamColor : yellow });
  if (typeof document === 'undefined') return material;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = service ? teamColor : yellow; ctx.fillRect(0, 0, 1024, 1024);
  ctx.strokeStyle = ink; ctx.lineWidth = 28; ctx.strokeRect(14, 14, 996, 996);
  if (service) {
    ctx.fillStyle = new THREE.Color(teamColor).multiplyScalar(.45).getStyle();
    ctx.fillRect(58, 58, 908, 908);
  } else {
    // Broad hazard bars and a single crate pictogram, not fine hatch detail.
    ctx.fillStyle = ink;
    for (const edge of [30, 930]) for (let y = 56; y < 980; y += 140) ctx.fillRect(edge, y, 64, 72);
    ctx.lineWidth = 32; ctx.lineJoin = 'round'; ctx.strokeRect(352, 352, 320, 320);
    ctx.beginPath(); ctx.moveTo(366, 366); ctx.lineTo(658, 658);
    ctx.moveTo(658, 366); ctx.lineTo(366, 658); ctx.stroke();
  }
  // Labels stay on the physical surface; they never face the camera.
  ctx.fillStyle = service ? '#ffffff' : ink;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const angle of service ? [0] : [0, Math.PI]) {
    ctx.save(); ctx.translate(512, 512); ctx.rotate(angle);
    ctx.font = `900 ${service ? 158 : 132}px Arial, sans-serif`;
    ctx.fillText(service ? 'BASE' : 'CARGO', 0, service ? 0 : -292, 790);
    ctx.font = 'bold 56px Arial, sans-serif'; ctx.fillText(service ? 'UNLOAD' : 'LOAD', 0, service ? 116 : -205, 620);
    ctx.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
  material.color.set('#ffffff'); material.map = texture;
  return material;
}
