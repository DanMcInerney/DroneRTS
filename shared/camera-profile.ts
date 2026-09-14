/** Own vehicle calibration; the onboard interface may expose this profile. */
export const DRONE_CAMERA = Object.freeze({
  fov: 76,
  width: 512,
  height: 288,
  near: 0.08,
  far: 500,
});

/** Shared by rendered views, captured evidence and the onboard calibration. */
export function cameraFovFor(drone: { cameraMode?: 'wide' | 'zoom'; equipment?: { optics?: boolean } }): number {
  return drone.equipment?.optics && drone.cameraMode === 'zoom' ? 32 : DRONE_CAMERA.fov;
}
