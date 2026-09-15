// Actor-facing capability facts only; no simulator calibration or world state.
// Host dependency versions match network/requirements.txt, not drone imports.
export const ACTOR_MODEL = 'gpt-5.6-luna';
export const ACTOR_EFFORT = 'xhigh';
export const DRONE_HOST_LIBRARIES = [
  { name: 'eclipse-zenoh', version: '1.10.1', purpose: 'radio' },
  { name: 'pymavlink', version: '2.4.49', purpose: 'MAVLink 2 control' },
] as const;
export const DRONE_COMPUTE = {
  toolAccess: 'fleet-mcp-only',
  sandbox: 'read-only',
  concurrentToolCalls: 1,
  codeExecution: false,
  shell: false,
  filesystem: false,
  libraryImports: false,
  web: false,
  spawning: false,
  nativePeerMessages: false,
} as const;
