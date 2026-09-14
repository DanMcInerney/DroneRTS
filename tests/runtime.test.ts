import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexFleetRuntime } from '../server/runtime.js';
import { BOOTSTRAP_MESSAGE, MODEL, EFFORT } from '../server/runtime-tools.js';

function fixture() {
  const events: any[] = [];
  const runtime = new CodexFleetRuntime({ projectDir: process.cwd(), onStatus: event => events.push(event), onEvent: event => events.push(event), toolHandler: async () => ({ content: [] }) });
  return { runtime, internal: runtime as any, events };
}

test('bootstrap policy replaces all parent fields with a fixed Luna drone prompt', () => {
  const { internal } = fixture(); internal.stopped = false;
  const result = internal.policy({ model: MODEL, tool_name: 'spawn_agent', tool_input: { agent_type: 'drone_1', message: 'Assign a secret mission', model: 'wrong-model', fork_context: true, fork_turns: 'all', items: ['hidden plan'] } });
  assert.deepEqual(result.hookSpecificOutput.updatedInput, { agent_type: 'drone_1', message: BOOTSTRAP_MESSAGE, model: MODEL, reasoning_effort: EFFORT, fork_context: false });
  const duplicate = internal.policy({ model: MODEL, tool_name: 'spawn_agent', tool_input: { agent_type: 'drone_1' } });
  assert.equal(duplicate.hookSpecificOutput.permissionDecision, 'deny');
});

test('policy permits only fleet tools and blocks native peer messaging', () => {
  const { internal } = fixture(); internal.stopped = false;
  assert.deepEqual(internal.policy({ model: MODEL, tool_name: 'mcp__fleet_parent__forward_next_instruction' }), {});
  assert.deepEqual(internal.policy({ model: MODEL, tool_name: 'mcp__fleet_drone_2__observe' }), {});
  assert.equal(internal.policy({ model: MODEL, tool_name: 'send_input' }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(internal.policy({ model: MODEL, tool_name: 'Bash' }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(internal.policy({ model: 'wrong-model', tool_name: 'mcp__fleet_drone_2__observe' }).hookSpecificOutput.permissionDecision, 'deny');
});

test('Stop during startup cancels before any runtime inference and removes private run state', async () => {
  const { runtime, internal, events } = fixture();
  const starting = runtime.start();
  const rejection = assert.rejects(starting, /cancelled/);
  await runtime.stop();
  await rejection;
  assert.equal(internal.runDir, undefined);
  assert.equal(internal.rpc, undefined);
  assert.equal(events.some(event => event.type === 'model-verified'), false);
  assert.equal(events.at(-1).status, 'stopped');
});
test('overlapping failure and UI shutdown share one cleanup and retain the error status', async () => {
  const { runtime, internal, events } = fixture();
  let closes = 0;
  let release!: () => void;
  const closed = new Promise<void>(resolve => { release = resolve; });
  internal.stopped = false;
  internal.rpc = { request: async () => ({}), stop: async () => { closes++; await closed; } };
  internal.failRuntime('Simulated actor failure');
  const first = runtime.stop();
  const second = runtime.stop();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(closes, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(internal.rpc, undefined);
  assert.equal(events.at(-1).status, 'error');
});
