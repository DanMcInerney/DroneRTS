/** Simulator experiment calibration, not a measured microphone specification. */
export const ACOUSTIC_PROFILE = Object.freeze({ version: 'acoustic/1', maxDistanceMeters: 150,
  propagationMetersPerSecond: 343, obstructionTransmission: 0.15, sensitivity: 0.12,
  possibleShotThreshold: 0.25, missProbability: 0.1, noiseAmplitude: 0.08,
  ambientImpulsesPerSecond: 0.015, maxStimuli: 32, cacheBytes: 8 * 1024 });
