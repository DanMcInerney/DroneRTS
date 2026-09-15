import { ONBOARD_PROFILE } from './onboard.ts';

// Public onboard capability facts only; no battlefield geometry or world state.
// Model metadata mirrors the fixed server/agent-backend.ts configuration.
// Host dependency versions match network/requirements.txt, not drone imports.
export const ACTOR_MODEL = 'gpt-5.6-luna';
export const ACTOR_EFFORT = 'xhigh';
export const DRONE_HOST_LIBRARIES = [
  { name: 'eclipse-zenoh', version: '1.10.1', purpose: 'radio' },
  { name: 'pymavlink', version: '2.4.49', purpose: 'MAVLink 2 control' },
] as const;
export const DRONE_GUEST_LIBRARIES: readonly { name: string; version: string; purpose: string }[] = [];
export const DRONE_COMPUTE = {
  toolAccess: 'fleet-mcp-only',
  sandbox: 'read-only host / bounded QuickJS',
  executionEngine: 'QuickJS',
  maxBatchOperations: ONBOARD_PROFILE.maxBatchOperations,
  maxActiveRoutines: ONBOARD_PROFILE.maxActiveRoutines,
  storage: ONBOARD_PROFILE.storage,
  maxFileBytes: ONBOARD_PROFILE.maxFileBytes,
  maxFiles: ONBOARD_PROFILE.maxFiles,
  optionalLibraryBytes: ONBOARD_PROFILE.optionalLibraryBytes,
  codeExecution: true,
  shell: false,
  filesystem: true,
  filesystemScope: 'private-onboard-workspace',
  hostFilesystem: false,
  libraryImports: true,
  importScope: 'relative-own-workspace-modules',
  web: false,
  spawning: false,
  nativePeerMessages: false,
} as const;
