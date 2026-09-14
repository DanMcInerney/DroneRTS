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

test('catalog exposes purchases with team credit access and equipment tools only after attachment', () => {
  const base = createDroneTools().map(tool => tool.name);
  assert.deepEqual(base, ['observe', 'act', 'send', 'wait', 'mine', 'recharge']);
  const shop = createDroneTools(undefined, { shop: true, gun: false, alive: true }).map(tool => tool.name);
  assert.deepEqual(shop, [...base, 'buy']);
  const armed = createDroneTools(undefined, { shop: true, gun: true, alive: true }).map(tool => tool.name);
  assert.deepEqual(armed, [...shop, 'fire', 'rearm']);
  const optics = createDroneTools(undefined, { shop: true, gun: false, optics: true, alive: true }).map(tool => tool.name);
  assert.deepEqual(optics, [...shop, 'camera']);
  const equipped = createDroneTools(undefined, { shop: true, gun: true, optics: true, alive: true });
  assert.deepEqual(equipped.map(tool => tool.name), [...armed, 'camera']);
  assert.deepEqual(equipped.find(tool => tool.name === 'camera')!.inputSchema.required, ['mission', 'mode']);
  assert.deepEqual(equipped.find(tool => tool.name === 'rearm')!.inputSchema.required, ['mission']);
  assert.deepEqual((equipped.find(tool => tool.name === 'buy')!.inputSchema.properties!.replace as any).enum, ['gun', 'miner', 'optics', 'battery', 'jammer']);
  const jammer = createDroneTools(undefined, { shop: true, gun: false, jammer: true, alive: true });
  assert.deepEqual(jammer.map(tool => tool.name), [...shop, 'jam']);
  assert.deepEqual(jammer.find(tool => tool.name === 'jam')!.inputSchema.required, ['mission', 'enabled']);
  assert.deepEqual(jammer.find(tool => tool.name === 'jam')!.inputSchema.properties!.enabled, { type: 'boolean' });
  assert.deepEqual(createDroneTools(undefined, { shop: true, gun: true, alive: false }), []);
  const instructions = droneInstructions('drone-1', undefined, 'blue');
  assert.match(instructions, /blue team/);
  assert.match(instructions, /tool_catalog_changed[\s\S]*finish this turn immediately/);
  assert.doesNotMatch(instructions, /Cincinnati|gun|miner|metres|meters|north|south|treasure/);
});

test('destroying one native child interrupts only that child and revokes all its tools', async () => {
  const { runtime, internal, events } = fixture(); internal.stopped = false;
  const requests: unknown[] = [];
  internal.rpc = { request: async (...args: unknown[]) => { requests.push(args); return {}; } };
  internal.roles.set('parent-thread', 'parent'); internal.activeTurns.set('parent-thread', 'parent-turn');
  internal.roles.set('dead-thread', 'drone-1'); internal.activeTurns.set('dead-thread', 'dead-turn');
  internal.roles.set('live-thread', 'drone-2'); internal.activeTurns.set('live-thread', 'live-turn');
  await runtime.retireDrone('drone-1');
  assert.deepEqual(requests, [['turn/interrupt', { threadId: 'dead-thread', turnId: 'dead-turn' }, 2000]]);
  assert.deepEqual(runtime.toolsForRole('drone-1'), []);
  assert.ok(runtime.toolsForRole('drone-2').some(tool => tool.name === 'observe'));
  internal.onMessage({ method: 'turn/completed', params: { threadId: 'dead-thread', turn: { status: 'interrupted' } } });
  for (let i = 0; i < 5; i++) assert.equal(internal.policy({ model: MODEL, tool_name: 'mcp__fleet_drone_1__observe', session_id: 'dead-thread' }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(internal.stopped, false);
  assert.equal(events.some(event => event.status === 'error'), false);
  assert.equal(internal.activeTurns.get('live-thread'), 'live-turn');
});

test('an early child completion resumes the same actor with fixed model and no new mission', async () => {
  const { internal, events } = fixture(); internal.stopped = false;
  const requests: Array<{ method: string; params: any }> = [];
  internal.rpc = { request: async (method: string, params: unknown) => { requests.push({ method, params }); return { turn: { id: 'resumed-turn' } }; } };
  internal.roles.set('child', 'drone-2');
  internal.onMessage({ method: 'turn/completed', params: { threadId: 'child', turn: { status: 'completed' } } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests.length, 1); assert.equal(requests[0].method, 'turn/start');
  assert.equal(requests[0].params.threadId, 'child'); assert.equal(requests[0].params.model, MODEL); assert.equal(requests[0].params.effort, EFFORT);
  assert.doesNotMatch(requests[0].params.input[0].text, /Cincinnati|resource|enemy|sector/);
  assert.equal(events.some(event => event.status === 'error'), false);
});

test('policy binds known native session identity to its own capabilities', () => {
  const { internal } = fixture(); internal.stopped = false;
  internal.roles.set('child', 'drone-1');
  assert.equal(internal.policy({ model: MODEL, session_id: 'child', tool_name: 'mcp__fleet_drone_2__observe' }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(internal.policy({ model: MODEL, session_id: 'child', tool_name: 'mcp__fleet_parent__forward_next_instruction' }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(internal.policy({ model: MODEL, session_id: 'child', tool_name: 'mcp__fleet_drone_1__buy' }).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(internal.policy({ model: MODEL, session_id: 'child', tool_name: 'mcp__fleet_drone_1__mine' }), {});
});

test('catalog changes yield only at a completed tool boundary and preserve every sensor and event', async () => {
  let shop = false;
  const events: any[] = [], requests: any[] = [];
  const runtime = new CodexFleetRuntime({ projectDir: process.cwd(), toolsForRole: () => createDroneTools(undefined, { shop, gun: false, alive: true }), onStatus: () => {}, onEvent: event => events.push(event), toolHandler: async () => ({ content: [] }) });
  const internal = runtime as any; internal.stopped = false;
  internal.rpc = { request: async (method: string, params: any) => { requests.push({ method, params }); return { turn: { id: 'next-turn' } }; } };
  internal.roles.set('same-child', 'drone-1');
  internal.recordToolsListed('drone-1', runtime.toolsForRole('drone-1'));
  shop = true;
  await runtime.refreshTools();
  assert.equal(requests.length, 0, 'a catalog notification must not interrupt private reasoning');
  const sensors = { position: { x: 1, y: 2, z: 3 }, heading: { degrees: 10 }, timestamp: { capturedAt: 'captured', simTime: 7 }, camera: 'image' };
  const original = { content: [{ type: 'text' as const, text: JSON.stringify({ sensors, events: [{ id: 'durable-mail', type: 'radio' }] }) }, { type: 'image' as const, data: 'camera-pixels', mimeType: 'image/png' }] };
  const boundary = internal.catalogBoundary('drone-1', original);
  assert.deepEqual(boundary.content.slice(0, 2), original.content);
  assert.match(boundary.content[2].text, /tool_catalog_changed/);
  assert.equal(requests.length, 0, 'the actor must finish naturally after reading the fresh bundle');
  internal.onMessage({ method: 'turn/completed', params: { threadId: 'same-child', turn: { status: 'completed' } } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(requests.map(request => request.method), ['config/mcpServer/reload', 'mcpServerStatus/list'], 'resumption waits for native MCP discovery acknowledgement');
  internal.recordToolsListed('drone-1', runtime.toolsForRole('drone-1'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests.length, 3); assert.equal(requests[2].method, 'turn/start');
  assert.equal(requests[2].params.threadId, 'same-child'); assert.equal(requests[2].params.model, MODEL); assert.equal(requests[2].params.effort, EFFORT);
  assert.doesNotMatch(requests[2].params.input[0].text, /gun|armor|buy|mine|location|enemy/);
  assert.equal(internal.resumptions.size, 0, 'expected catalog yields do not consume failure recovery allowance');
  assert.deepEqual(internal.catalogBoundary('drone-1', original), original);
  assert.ok(events.some(event => event.type === 'catalog-turn-resumed'));
});

test('retirement during catalog discovery cancels the pending continuation', async () => {
  let shop = false;
  const runtime = new CodexFleetRuntime({ projectDir: process.cwd(), toolsForRole: () => createDroneTools(undefined, { shop, gun: false, alive: true }), onStatus: () => {}, onEvent: () => {}, toolHandler: async () => ({ content: [] }) });
  const internal = runtime as any; internal.stopped = false;
  const requests: string[] = [];
  internal.rpc = { request: async (method: string) => { requests.push(method); return { turn: { id: 'unexpected' } }; } };
  internal.recordToolsListed('drone-1', runtime.toolsForRole('drone-1'));
  shop = true; internal.catalogBoundary('drone-1', { content: [] });
  const resume = internal.resumeActor('child', 'drone-1', true);
  await new Promise(resolve => setTimeout(resolve, 0));
  await runtime.retireDrone('drone-1'); await resume;
  assert.ok(!requests.includes('turn/start'));
  assert.ok(!requests.includes('turn/interrupt'));
  assert.equal(internal.catalogWaiters.size, 0);
});
