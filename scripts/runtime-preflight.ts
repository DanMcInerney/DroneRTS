// No model inference: exercise the app-server's real tool and config plumbing.
import { CodexFleetRuntime } from '../server/runtime.js';
import assert from 'node:assert/strict';
import { REASONING_CONFIG } from '../server/runtime-reasoning.ts';
process.env.FLEET_RUNTIME_PREFLIGHT = '1';
const runtime = new CodexFleetRuntime({ projectDir: process.cwd(), onStatus: e => console.log(JSON.stringify(e)), onEvent: e => console.log(JSON.stringify(e)), toolHandler: async (role, name) => ({ content: [{ type: 'text', text: JSON.stringify({ role, name, preflight: true }) }] }) });
try {
  await runtime.start();
  const internal = runtime as any;
  const config = await internal.rpc.request('config/read', {});
  const reasoning = Object.fromEntries(Object.keys(REASONING_CONFIG).map(key => [key, config.config[key]]));
  assert.deepEqual(reasoning, REASONING_CONFIG, 'Native runtime must accept the requested reasoning capture settings.');
  console.log(JSON.stringify({ type: 'reasoning-config-preflight', ...reasoning, inference: false }));
  console.log(JSON.stringify({ type: 'config-preflight', features: config.config.features, parentApproval: config.config.mcp_servers?.fleet_parent?.default_tools_approval_mode, hooks: Object.keys(config.config.hooks ?? {}) }));
  const result = await internal.rpc.request('mcpServer/tool/call', { threadId: internal.threadId, server: 'fleet_parent', tool: 'forward_next_instruction', arguments: {} }, 10000);
  console.log(JSON.stringify({ type: 'preflight-tool-result', result }));
} finally { await runtime.stop(); }
