import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexFleetRuntime } from '../server/runtime.js';
import { BOOTSTRAP_MESSAGE, MODEL, EFFORT, createParentInstructions, createDroneTools, droneInstructions } from '../server/runtime-tools.js';
import { validateRoster, type FleetRoster } from '../shared/fleet.ts';
import { DEFAULT_AGENT_BACKEND, validateAgentBackend, type AgentBackendConfiguration } from '../server/agent-backend.ts';
import { CARGO_CONFIG } from '../shared/rts.ts';
import { RTS_BRIEFING } from '../shared/mission.ts';

function fixture(roster?: FleetRoster) {
  const events: any[] = [];
  const runtime = new CodexFleetRuntime({ projectDir: process.cwd(), roster, onStatus: event => events.push(event), onEvent: event => events.push(event), toolHandler: async () => ({ content: [] }) });
  return { runtime, internal: runtime as any, events };
}

test('backend configuration is explicit and fails closed before inference for unsupported providers or models', () => {
  assert.deepEqual(fixture().runtime.configuration, DEFAULT_AGENT_BACKEND);
  assert.ok(Object.isFrozen(validateAgentBackend()));
  for (const configuration of [
    { ...DEFAULT_AGENT_BACKEND, provider: 'other' },
    { ...DEFAULT_AGENT_BACKEND, model: 'other' },
    { ...DEFAULT_AGENT_BACKEND, effort: 'high' },
  ]) assert.throws(() => validateAgentBackend(configuration as AgentBackendConfiguration), /fallback/);
});

test('onboard catalog bounds batches and exposes blue commander chat without red access', () => {
  const blue = createDroneTools(undefined, undefined, 'blue');
  const red = createDroneTools(undefined, undefined, 'red');
  const to = (tools: typeof blue) => (tools.find(tool => tool.name === 'send')!.inputSchema.properties!.to as any).enum;
  assert.ok(to(blue).includes('player')); assert.ok(!to(red).includes('player'));
  const batch = blue.find(tool => tool.name === 'exchange')!.inputSchema.properties!.operations as any;
  assert.equal(batch.maxItems, 8);
  for (const forbidden of ['wait', 'workspace', 'routine', 'transfer', 'exchange', 'fire', 'camera']) {
    assert.ok(!batch.items.properties.tool.enum.includes(forbidden), forbidden);
  }
  const armed = createDroneTools(undefined, { shop: true, gun: true, optics: true, alive: true });
  const allowed = (armed.find(tool => tool.name === 'exchange')!.inputSchema.properties!.operations as any).items.properties.tool.enum;
  assert.ok(allowed.includes('fire')); assert.ok(allowed.includes('camera'));
  const surface = JSON.stringify(blue);
  assert.doesNotMatch(surface, /owner_token|resourceId|padId|enemyId/);
});

test('cargo briefing follows authoritative service calibration without injecting routes or resource locations', () => {
  assert.ok(RTS_BRIEFING.includes(`between ${CARGO_CONFIG.hoverMin} and ${CARGO_CONFIG.hoverMax} local units`));
  assert.ok(RTS_BRIEFING.includes(`${CARGO_CONFIG.pickupDuration} simulation seconds`));
  assert.match(RTS_BRIEFING, /credit your shared team account only on completion/);
  assert.match(RTS_BRIEFING, /Confirm agreement through actual teammate replies/);
  assert.doesNotMatch(RTS_BRIEFING, /translucent yellow|automatically mines|miner_upgrade|central depot|scout first|travel north/);
});

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

test('actor activity identifies compaction and pending tool intervals without retaining private content or changing control', () => {
  const { runtime, internal, events } = fixture();
  internal.roles.set('child', 'drone-1');
  const catalog = runtime.toolsForRole('drone-1');
  for (const activity of ['reasoning', 'contextCompaction', 'mcpToolCall']) {
    for (const phase of ['started', 'completed']) {
      internal.onMessage({ method: `item/${phase}`, params: { threadId: 'child', turnId: 'turn-1', item: {
        type: activity, id: `item-${activity}`, content: ['PRIVATE'], encryptedContent: 'SECRET', arguments: { hidden: 'PRIVATE' },
      } } });
    }
  }
  const activity = events.filter(event => event.type === 'actor-activity');
  assert.equal(activity.length, 6);
  assert.deepEqual(activity.map(event => event.phase), ['started', 'completed', 'started', 'completed', 'started', 'completed']);
  assert.ok(activity.every(event => event.role === 'drone-1' && event.threadId === 'child' && event.turnId === 'turn-1' && Number.isFinite(event.observedAtMs)));
  internal.onMessage({ method: 'item/reasoning/textDelta', params: { threadId: 'child', delta: 'PRIVATE' } });
  internal.onMessage({ method: 'thread/compacted', params: { threadId: 'child', turnId: 'turn-1', content: 'PRIVATE' } });
  assert.equal(events.at(-1).type, 'actor-context-compacted');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|SECRET/);
  assert.deepEqual(runtime.toolsForRole('drone-1'), catalog);
  assert.equal(internal.activeTurns.size, 0); assert.equal(internal.resumptions.size, 0);
});

test('usage and retry diagnostics retain actor identity and numeric context size without copying payloads', () => {
  const { internal, events } = fixture();
  internal.roles.set('child', 'drone-2');
  internal.onMessage({ method: 'thread/tokenUsage/updated', params: { threadId: 'child', turnId: 'turn-2', tokenUsage: {
    total: { totalTokens: 100 }, last: { inputTokens: 70, outputTokens: 30, reasoningOutputTokens: 20, private: 'PRIVATE' }, modelContextWindow: 1000,
  } } });
  const usage = events.find(event => event.type === 'actor-usage');
  assert.equal(usage.role, 'drone-2'); assert.equal(usage.lastInputTokens, 70); assert.equal(usage.modelContextWindow, 1000);
  assert.equal(events.at(-1).usage, 100, 'existing aggregate accounting is preserved');
  internal.onMessage({ method: 'error', params: { threadId: 'child', turnId: 'turn-2', willRetry: true, error: { message: 'Retrying request', additionalDetails: 'PRIVATE' } } });
  assert.equal(events.at(-1).role, 'drone-2'); assert.equal(events.at(-1).turnId, 'turn-2'); assert.equal(events.at(-1).willRetry, true);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
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
  assert.deepEqual(base, ['observe', 'act', 'send', 'wait', 'route', 'workspace', 'routine', 'transfer', 'exchange']);
  const shop = createDroneTools(undefined, { shop: true, gun: false, alive: true }).map(tool => tool.name);
  assert.deepEqual(shop, [...base.slice(0, -1), 'buy', 'exchange']);
  const armed = createDroneTools(undefined, { shop: true, gun: true, alive: true }).map(tool => tool.name);
  assert.deepEqual(armed, [...shop.slice(0, -1), 'fire', 'rearm', 'exchange']);
  const optics = createDroneTools(undefined, { shop: true, gun: false, optics: true, alive: true }).map(tool => tool.name);
  assert.deepEqual(optics, [...shop.slice(0, -1), 'camera', 'exchange']);
  const equipped = createDroneTools(undefined, { shop: true, gun: true, optics: true, alive: true });
  assert.deepEqual(equipped.map(tool => tool.name), [...armed.slice(0, -1), 'camera', 'exchange']);
  assert.deepEqual(equipped.find(tool => tool.name === 'camera')!.inputSchema.required, ['mission', 'mode']);
  assert.deepEqual(equipped.find(tool => tool.name === 'rearm')!.inputSchema.required, ['mission']);
  assert.deepEqual((equipped.find(tool => tool.name === 'buy')!.inputSchema.properties!.replace as any).enum, ['gun', 'cargo', 'optics']);
  const jammer = createDroneTools(undefined, { shop: true, gun: false, jammer: true, alive: true });
  assert.deepEqual(jammer.map(tool => tool.name), shop, 'historical equipment must not reactivate deferred tools');
  assert.deepEqual(createDroneTools(undefined, { shop: true, gun: true, alive: false }), []);
  const instructions = droneInstructions('drone-1', undefined, 'blue');
  assert.doesNotMatch(instructions, /battery|recharge|power loss/i);
  assert.match(instructions, /blue team/);
  assert.match(instructions, /tool_catalog_changed[\s\S]*finish this turn immediately/);
  assert.doesNotMatch(instructions, /Cincinnati|Smale|Fountain Square|chest-1|Vine Street/);
  assert.match(instructions, /ten meters/);
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
  assert.deepEqual(internal.policy({ model: MODEL, session_id: 'child', tool_name: 'mcp__fleet_drone_1__workspace' }), {});
  assert.equal(internal.policy({ model: MODEL, session_id: 'child', tool_name: 'mcp__fleet_drone_1__mine' }).hookSpecificOutput.permissionDecision, 'deny');
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
