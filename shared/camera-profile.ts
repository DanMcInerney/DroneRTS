/** Renderer/simulator calibration. Never include this profile in agent tools or prompts. */
export const DRONE_CAMERA = Object.freeze({
  fov: 76,
  width: 512,
  height: 288,
  near: 0.08,
  far: 500,
});

/** Shared by rendered views and private evidence; never return this calibration to actors. */
export function cameraFovFor(drone: { cameraMode?: 'wide' | 'zoom'; equipment?: { optics?: boolean } }): number {
  return drone.equipment?.optics && drone.cameraMode === 'zoom' ? 32 : DRONE_CAMERA.fov;
}
