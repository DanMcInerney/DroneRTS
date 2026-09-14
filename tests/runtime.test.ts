import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexFleetRuntime } from '../server/runtime.js';
import { BOOTSTRAP_MESSAGE, MODEL, EFFORT, createParentInstructions, createDroneTools, droneInstructions } from '../server/runtime-tools.js';
import { validateRoster, type FleetRoster } from '../shared/fleet.ts';

function fixture(roster?: FleetRoster) {
  const events: any[] = [];
  const runtime = new CodexFleetRuntime({ projectDir: process.cwd(), roster, onStatus: event => events.push(event), onEvent: event => events.push(event), toolHandler: async () => ({ content: [] }) });
  return { runtime, internal: runtime as any, events };
}

test('runtime records only provided reasoning summaries, never hidden reasoning contents', () => {
  const { internal, events } = fixture();
  internal.roles.set('thread-drone', 'drone-1');
  internal.onMessage({ method: 'item/completed', params: { threadId: 'thread-drone', item: { type: 'reasoning', id: 'summary-item', summary: ['Visible runtime summary'], content: ['hidden model reasoning'], encryptedContent: 'ciphertext' } } });
  assert.equal(events.at(-1).type, 'recorded-reasoning-summary');
  assert.deepEqual(events.at(-1).summary, ['Visible runtime summary']);
  assert.ok(!JSON.stringify(events).includes('hidden model reasoning')); assert.ok(!JSON.stringify(events).includes('ciphertext'));
  internal.onMessage({ method: 'item/completed', params: { threadId: 'thread-drone', item: { type: 'reasoning', summary: [] } } });
  assert.match(events.at(-1).availability, /No reasoning summary/);
});

test('runtime prompts, permissions and readiness use the configured roster without leaking wire metadata', () => {
  const roster = validateRoster([
    { id: 'drone-7', label: 'Scout', color: '#aaccee', systemId: 42 },
    { id: 'drone-11', label: 'Support', color: '#eeccee', systemId: 87 },
  ]);
  const { internal, events } = fixture(roster); internal.stopped = false;
  const parent = createParentInstructions(roster);
  assert.match(parent, /exactly 2 native subagents, agent types drone_7, drone_11/);
  assert.match(parent, /never receive or interpret mission contents/);
  const instructions = droneInstructions('drone-7', roster);
  assert.match(instructions, /drone-7, drone-11/);
  assert.doesNotMatch(instructions, /Scout|Support|systemId|aaccee|42|87/);
  const send = createDroneTools(roster).find(tool => tool.name === 'send')!;
  assert.deepEqual((send.inputSchema.properties!.to as { enum: string[] }).enum, ['all', 'drone-7', 'drone-11']);
  assert.deepEqual(internal.policy({ model: MODEL, tool_name: 'mcp__fleet_drone_11__observe' }), {});
  assert.equal(internal.policy({ model: MODEL, tool_name: 'mcp__fleet_drone_1__observe' }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(internal.policy({ model: MODEL, tool_name: 'spawn_agent', tool_input: { agent_type: 'drone_7' } }).hookSpecificOutput.updatedInput.agent_type, 'drone_7');
  internal.onMessage({ method: 'thread/started', params: { thread: { id: 'unknown', agentRole: 'drone_1' } } });
  assert.equal(internal.roles.has('unknown'), false);
  for (const role of ['drone_7', 'drone_11']) internal.onMessage({ method: 'thread/started', params: { thread: { id: role, agentRole: role } } });
  assert.equal(events.findLast(event => event.children)?.status, 'running');
  assert.equal(events.findLast(event => event.children)?.children.length, 2);
});

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
