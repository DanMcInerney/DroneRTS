import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { CodexFleetRuntime } from '../server/runtime.js';
import { BOOTSTRAP_MESSAGE, MODEL, EFFORT, createParentInstructions, createDroneCatalog, createDroneTools, droneInstructions } from '../server/runtime-tools.js';
import { validateRoster, type FleetRoster } from '../shared/fleet.ts';
import { DEFAULT_AGENT_BACKEND, validateAgentBackend, type AgentBackendConfiguration } from '../server/agent-backend.ts';
import { CARGO_CONFIG } from '../shared/rts.ts';
import { RTS_BRIEFING, RTS_MISSION } from '../shared/mission.ts';
import type { ToolResult } from '../shared/types.ts';

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
  const blue = createDroneCatalog(undefined, 'blue');
  const red = createDroneCatalog(undefined, 'red');
  const to = (tools: typeof blue) => (tools.find(tool => tool.name === 'send')!.inputSchema.properties!.to as any).enum;
  assert.ok(to(blue).includes('player')); assert.ok(!to(red).includes('player'));
  const batch = blue.find(tool => tool.name === 'exchange')!.inputSchema.properties!.operations as any;
  assert.equal(batch.maxItems, 8);
  for (const forbidden of ['wait', 'workspace', 'routine', 'transfer', 'exchange', 'camera']) {
    assert.ok(!batch.items.properties.tool.enum.includes(forbidden), forbidden);
  }
  assert.deepEqual(batch.items.properties.tool.enum, ['act', 'send', 'route', 'buy', 'fire', 'rearm']);
  for (const name of ['buy', 'fire', 'rearm']) assert.ok(blue.some(tool => tool.name === name));
  for (const name of ['camera', 'mine', 'jam', 'recharge']) assert.ok(!blue.some(tool => tool.name === name));
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
  assert.match(RTS_BRIEFING, /send one brief message to your team acknowledging that you are online/);
  assert.match(RTS_BRIEFING, /pursue the objective without waiting for replies/);
  assert.match(RTS_MISSION, /Send your team a brief online acknowledgement/);
  assert.match(RTS_MISSION, /proceed without waiting for replies/);
  for (const instructions of [RTS_BRIEFING, RTS_MISSION]) {
    assert.doesNotMatch(instructions, /Confirm agreement through actual teammate replies|Agree on your opening plan|before departing/);
  }
  assert.doesNotMatch(RTS_BRIEFING, /translucent yellow|automatically mines|miner_upgrade|central depot|scout first|travel north/);
});

test('runtime routes readable native reasoning and summaries, omitting encrypted payloads', () => {
  const { internal, events } = fixture();
  internal.roles.set('thread-drone', 'drone-1');
  internal.onMessage({ method: 'item/completed', params: { threadId: 'thread-drone', item: { type: 'reasoning', id: 'summary-item', summary: ['Visible runtime summary'], content: ['Readable native reasoning'], encryptedContent: 'ciphertext' } } });
  assert.equal(events.find(event => event.type === 'recorded-reasoning').text, 'Readable native reasoning');
  assert.equal(events.find(event => event.type === 'recorded-reasoning-summary').text, 'Visible runtime summary');
  assert.ok(events.every(event => event.role === 'drone-1'));
  assert.equal(events.at(-1).availability, 'both');
  assert.ok(!JSON.stringify(events).includes('ciphertext'));
  internal.onMessage({ method: 'item/completed', params: { threadId: 'thread-drone', item: { type: 'reasoning', id: 'empty', summary: [] } } });
  assert.equal(events.at(-1).availability, 'unavailable');
  assert.match(events.at(-1).text, /No readable reasoning/);
});

test('actor activity identifies compaction and pending tool intervals without retaining private content or changing control', () => {
  const { runtime, internal, events } = fixture();
  internal.roles.set('child', 'drone-1');
  internal.ownTurn('child', 'turn-1');
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
  internal.onMessage({ method: 'item/completed', params: { threadId: 'child', turnId: 'old', item: { type: 'contextCompaction', id: 'late' } } });
  assert.equal(events.filter(event => event.type === 'actor-context-compacted').length, 1, 'only the current correlated completion refreshes recovery');
  assert.doesNotMatch(JSON.stringify(events.filter(event => event.type === 'actor-activity' || event.type === 'actor-context-compacted')), /PRIVATE|SECRET/);
  assert.doesNotMatch(JSON.stringify(events), /SECRET/);
  assert.deepEqual(runtime.toolsForRole('drone-1'), catalog);
  assert.equal(internal.activeTurns.size, 1); assert.equal(internal.resumptions.size, 0);
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

test('dynamic availability exposes purchases with team credit access and equipment tools only after attachment', () => {
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
  assert.deepEqual((equipped.find(tool => tool.name === 'buy')!.inputSchema.properties!.replace as any).enum, ['gun', 'cargo']);
  const jammer = createDroneTools(undefined, { shop: true, gun: false, jammer: true, alive: true });
  assert.deepEqual(jammer.map(tool => tool.name), shop, 'historical equipment must not reactivate deferred tools');
  assert.deepEqual(createDroneTools(undefined, { shop: true, gun: true, alive: false }), []);
  const instructions = droneInstructions('drone-1', undefined, 'blue');
  assert.doesNotMatch(instructions, /battery|recharge|power loss/i);
  assert.match(instructions, /blue team/);
  assert.match(instructions, /availableTools reports your current permissions/);
  assert.doesNotMatch(instructions, /tool_catalog_changed|finish this turn immediately/);
  assert.doesNotMatch(instructions, /Cincinnati|Smale|Fountain Square|chest-1|Vine Street/);
  assert.match(instructions, /ten meters/);
});

test('destroying one native child interrupts only that child and revokes all its tools', async () => {
  const { runtime, internal, events } = fixture(); internal.stopped = false;
  const requests: unknown[] = [];
  internal.rpc = { request: async (...args: unknown[]) => { requests.push(args); return {}; } };
  internal.roles.set('parent-thread', 'parent'); internal.ownTurn('parent-thread', 'parent-turn');
  internal.roles.set('dead-thread', 'drone-1'); internal.ownTurn('dead-thread', 'dead-turn');
  internal.roles.set('live-thread', 'drone-2'); internal.ownTurn('live-thread', 'live-turn');
  await runtime.retireDrone('drone-1');
  assert.deepEqual(requests, [['turn/interrupt', { threadId: 'dead-thread', turnId: 'dead-turn' }, 2000]]);
  assert.deepEqual(runtime.toolsForRole('drone-1'), []);
  assert.ok(runtime.toolsForRole('drone-2').some(tool => tool.name === 'observe'));
  internal.onMessage({ method: 'turn/completed', params: { threadId: 'dead-thread', turn: { id: 'dead-turn', status: 'interrupted' } } });
  for (let i = 0; i < 5; i++) assert.equal(internal.policy({ model: MODEL, tool_name: 'mcp__fleet_drone_1__observe', session_id: 'dead-thread' }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(internal.stopped, false);
  assert.equal(events.some(event => event.status === 'error'), false);
  assert.equal(internal.activeTurns.get('live-thread').id, 'live-turn');
});

test('an early child completion resumes the same actor with fixed model and no new mission', async () => {
  const { internal, events } = fixture(); internal.stopped = false;
  const requests: Array<{ method: string; params: any }> = [];
  internal.rpc = { request: async (method: string, params: unknown) => { requests.push({ method, params }); return { turn: { id: 'resumed-turn' } }; } };
  internal.roles.set('child', 'drone-2');
  internal.ownTurn('child', 'initial-turn');
  internal.onMessage({ method: 'turn/completed', params: { threadId: 'child', turn: { id: 'initial-turn', status: 'completed' } } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests.length, 1); assert.equal(requests[0].method, 'turn/start');
  assert.equal(requests[0].params.threadId, 'child'); assert.equal(requests[0].params.model, MODEL); assert.equal(requests[0].params.effort, EFFORT);
  assert.equal(requests[0].params.summary, 'auto');
  assert.doesNotMatch(requests[0].params.input[0].text, /Cincinnati|resource|enemy|sector/);
  assert.equal(events.some(event => event.status === 'error'), false);
});

test('policy binds known native session identity to its advertised tools; game admission owns capabilities', () => {
  const { internal } = fixture(); internal.stopped = false;
  internal.roles.set('child', 'drone-1');
  assert.equal(internal.policy({ model: MODEL, session_id: 'child', tool_name: 'mcp__fleet_drone_2__observe' }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(internal.policy({ model: MODEL, session_id: 'child', tool_name: 'mcp__fleet_parent__forward_next_instruction' }).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(internal.policy({ model: MODEL, session_id: 'child', tool_name: 'mcp__fleet_drone_1__buy' }), {});
  assert.deepEqual(internal.policy({ model: MODEL, session_id: 'child', tool_name: 'mcp__fleet_drone_1__fire' }), {});
  assert.deepEqual(internal.policy({ model: MODEL, session_id: 'child', tool_name: 'mcp__fleet_drone_1__rearm' }), {});
  assert.deepEqual(internal.policy({ model: MODEL, session_id: 'child', tool_name: 'mcp__fleet_drone_1__workspace' }), {});
  assert.equal(internal.policy({ model: MODEL, session_id: 'child', tool_name: 'mcp__fleet_drone_1__mine' }).hookSpecificOutput.permissionDecision, 'deny');
});

test('equipment changes preserve the advertised MCP catalog and fresh result without ending the native turn', async t => {
  let gun = false;
  const events: any[] = [], requests: any[] = [];
  const sensors = { position: { x: 1, y: 2, z: 3 }, heading: { degrees: 10 }, timestamp: { capturedAt: 'captured', simTime: 7 }, camera: 'image' };
  const unreadEvents = [{ id: 'durable-mail', type: 'radio' }];
  const pixels = Buffer.from('camera-pixels').toString('base64');
  const runtime = new CodexFleetRuntime({ projectDir: process.cwd(), onStatus: () => {}, onEvent: event => events.push(event),
    toolHandler: async (_role, name) => {
      if (name === 'buy') gun = true;
      return { content: [
        { type: 'text', text: JSON.stringify({ sensors, events: unreadEvents, availableTools: createDroneTools(undefined, { shop: true, gun, alive: true }).map(tool => tool.name) }) },
        { type: 'image', data: pixels, mimeType: 'image/png' },
      ] };
    },
  });
  const internal = runtime as any; internal.stopped = false;
  internal.rpc = { request: async (method: string, params: any) => { requests.push({ method, params }); return {}; }, stop: async () => {} };
  internal.roles.set('same-child', 'drone-1');
  internal.ownTurn('same-child', 'initial-turn');
  const endpoint = await internal.startMcp();
  const client = new Client({ name: 'stable-catalog-test', version: '1' });
  t.after(async () => { await client.close(); await runtime.stop(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp/${endpoint.tokens['drone-1']}`)));
  const initialCatalog = (await client.listTools()).tools;
  let notifications = 0;
  let notified!: () => void;
  const retirementNotification = new Promise<void>(resolve => { notified = resolve; });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notifications++; notified(); });
  for (const name of ['observe', 'buy']) {
    const result = await client.callTool({ name, arguments: name === 'buy' ? { mission: 1, item: 'gun' } : {} }) as ToolResult;
    assert.equal(result.content.length, 2, 'equipment changes append no yield instruction');
    const body = JSON.parse((result.content[0] as { text: string }).text);
    assert.deepEqual(body.sensors, sensors);
    assert.deepEqual(body.events, unreadEvents);
    assert.equal(body.availableTools.includes('fire'), name === 'buy');
    assert.equal(body.availableTools.includes('rearm'), name === 'buy');
    assert.deepEqual(result.content[1], { type: 'image', data: pixels, mimeType: 'image/png' });
    assert.deepEqual((await client.listTools()).tools, initialCatalog);
  }
  gun = false;
  await runtime.refreshTools();
  assert.deepEqual((await client.listTools()).tools, initialCatalog);
  assert.equal(notifications, 0);
  assert.equal(requests.length, 0, 'equipment changes neither interrupt nor restart the actor');
  assert.equal(internal.activeTurns.get('same-child').id, 'initial-turn');
  assert.equal(internal.resumptions.size, 0);
  assert.ok(!events.some(event => event.type === 'catalog-yield-requested'));
  await runtime.retireDrone('drone-1');
  await Promise.race([retirementNotification, new Promise((_, reject) => setTimeout(() => reject(new Error('Missing retirement notification')), 3000).unref())]);
  assert.equal(notifications, 1, 'MCP catalog notifications still revoke retired actors');
  assert.deepEqual((await client.listTools()).tools, []);
  assert.equal((await client.callTool({ name: 'observe' })).isError, true);
  assert.deepEqual(requests.map(request => request.method), ['turn/interrupt']);
});

test('retirement while terminal tool work settles cancels the pending ordinary continuation', async () => {
  const { runtime, internal } = fixture(); internal.stopped = false;
  const requests: string[] = [];
  internal.rpc = { request: async (method: string) => { requests.push(method); return { turn: { id: 'unexpected' } }; } };
  internal.roles.set('child', 'drone-1');
  internal.ownTurn('child', 'closing-turn');
  const ticket = internal.beginTool('drone-1');
  internal.onMessage({ method: 'turn/completed', params: { threadId: 'child', turn: { id: 'closing-turn', status: 'completed' } } });
  const resume = internal.resumeActor('child', 'drone-1');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests.length, 0, 'terminal notification alone does not settle outstanding tool work');
  await runtime.retireDrone('drone-1');
  assert.equal(ticket.signal.aborted, true);
  ticket.settled(); await resume;
  assert.ok(!requests.includes('turn/start'));
  assert.ok(!requests.includes('turn/interrupt'));
  assert.equal(internal.activeTurns.get('child').settled, true);
  assert.deepEqual(runtime.toolsForRole('drone-1'), []);
  assert.deepEqual(runtime.toolsForRole('drone-99'), []);
});

test('terse common opening states the empty loadout and lights without exposing map geometry', () => {
  assert.ok(RTS_MISSION.length < 700);
  assert.match(RTS_MISSION, /no salvage, no armor/); assert.match(RTS_MISSION, /lights in their team color/);
  assert.match(RTS_BRIEFING, /starts unarmored/); assert.match(RTS_BRIEFING, /rooftops/);
  assert.doesNotMatch(RTS_MISSION + RTS_BRIEFING, /optics|zoom|Vine|Walnut|Main Street|Paycor|Queen City|halfway|middle|central/i);
});
