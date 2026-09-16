import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { FleetGame } from '../server/game.ts';
import { DroneNervelet, NERVELET_CACHE_RESERVE } from '../server/nervelet.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';
import type { ToolResult } from '../shared/types.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FleetMcpServer } from '../server/runtime-mcp.ts';
import { RTS_BRIEFING } from '../shared/mission.ts';

const body = (r: ToolResult): any => JSON.parse(r.content.find(c => c.type === 'text')!.text);
async function fixture(t: TestContext, gate = false) {
  const game = new FleetGame(); game.setConnected(true); game.start(); if (gate) game.awaitFleetLaunch();
  game.state.obstacles = [];
  game.state.drones.forEach((drone, i) => Object.assign(drone, { x: -20 + i * 10, y: 30, z: 0, yaw: 0, pitch: -23 }));
  game.capture = async id => `data:image/jpeg;base64,${Buffer.from(id).toString('base64')}`;
  const pilots = MATCH_DRONE_IDS.map(id => new DroneNervelet(game, id));
  t.after(async () => { game.stop(); await Promise.all(pilots.map(p => p.close())); });
  for (const pilot of pilots) await pilot.call('observe');
  game.queueMission('Exact BLUE received objective.'); game.queueMission('Exact RED received objective.', 'red');
  await game.forwardTeam('blue'); await game.forwardTeam('red');
  const initial = await Promise.all(pilots.map(async p => body(await p.call('observe'))));
  return { game, pilots, initial };
}
async function effect(pilot: DroneNervelet, prior: any, name: string, args: object) {
  return body(await pilot.call(name, { seen: prior.nervelet.id, command_id: prior.nervelet.nextCommandId, mission: prior.nervelet.goal.version, ...args }));
}

test('six real game adapters isolate images, exact goals, workspaces and ack cursors; all objectives gate launch', async t => {
  const { game, pilots, initial } = await fixture(t, true);
  assert.equal(game.launchReady, true);
  assert.equal(new Set(initial.map(b => b.nervelet.epoch)).size, 6);
  initial.forEach((b, i) => {
    assert.equal('camera' in pilots[i].profile.commands, false, 'current-match recovery must not advertise removed optics');
    assert.equal(b.nervelet.goal.text, i < 3 ? 'Exact BLUE received objective.' : 'Exact RED received objective.');
    assert.equal(b.nervelet.loop, 'paused');
    assert.equal(game.inboxes[pilots[i].id].delivered, 0);
    assert.equal(b.protocol, 'fleet-observation/5');
    const recoveredProfile = JSON.parse(b.nervelet.recovery.instructions.split('\n\n').at(-1));
    assert.ok(recoveredProfile.instructions.includes(RTS_BRIEFING));
    assert.ok(Object.values(recoveredProfile.commands).every((command: any) => !command.schema), 'MCP supplies schemas; canonical recovery retains descriptions');
    assert.match(b.nervelet.recovery.instructions, /refresh observations/);
    assert.equal(b.nervelet.aliases, undefined, 'the generated rule is the sole recurring loop reminder');
    assert.equal(b.nervelet.rule, pilots[i].bridge.renderInstructions().rule);
    for (const reference of ['nervelet.id', 'seen', 'nervelet.nextCommandId', 'command_id', 'nervelet.goal.version', 'mission', 'nervelet.generation', 'generation', 'nervelet.results[].data'])
      assert.ok(b.nervelet.rule.includes(reference), reference);
    for (const key of ['obstacles', 'buildings', 'resources', 'opponentTelemetry']) assert.equal(JSON.stringify(b).includes(`"${key}":`), false);
  });
  const rejected = body(await pilots[1].call('observe', { seen: initial[0].nervelet.id }));
  assert.match(rejected.reason, /Unknown or expired/);
  const next = await effect(pilots[0], initial[0], 'workspace', { op: 'write', path: 'private.md', content: 'only blue one' });
  assert.equal(next.nervelet.results.at(-1).status, 'completed');
  assert.throws(() => game.onboardWorkspace('drone-2').read('private.md'), /does not exist/);
  assert.ok(game.inboxes['drone-1'].delivered > 0);
  assert.equal(game.inboxes['drone-2'].delivered, 0);
  assert.ok(game.onboardWorkspace('drone-1').status().logs.usedBytes >= NERVELET_CACHE_RESERVE);
  const image = (await pilots[0].call('observe')).content.find(c => c.type === 'image');
  assert.ok(image?.type === 'image'); assert.equal(Buffer.from(image.data, 'base64').toString(), 'drone-1');
});

test('receipt timestamp metadata counts toward unread event storage and is released only on acknowledgement', async t => {
  const { game, pilots, initial } = await fixture(t);
  const p = pilots[0];
  await p.call('observe', { seen: initial[0].nervelet.id });
  const box = game.inboxes[p.id];
  box.push({ type: 'local_notice', mission: 1, text: 'retained' });
  const entry = box.events.at(-1)!;
  assert.equal(box.localBytes, Buffer.byteLength(JSON.stringify(entry)) + 16);
  const receivedAt = box.receivedAt(entry.cursor);
  const shown = body(await p.call('observe'));
  assert.equal(shown.events[0].receivedAtMs, receivedAt);
  assert.ok(box.localBytes > 0);
  await p.call('observe', { seen: shown.nervelet.id });
  assert.equal(box.localBytes, 0);
  assert.equal(box.receivedAt(entry.cursor), 0);
});

test('lost bundle redelivers stable event IDs; only echoed included slices consume native mail', async t => {
  const { game, pilots, initial } = await fixture(t);
  const p = pilots[0]; let prior = body(await p.call('observe', { seen: initial[0].nervelet.id }));
  const consumed: string[] = [];
  game.radioTransport = { send: async () => {}, consume: (_id, ids) => consumed.push(...ids) };
  for (let i = 0; i < 60; i++) game.inboxes[p.id].push({ type: 'radio', mission: 1, message: { id: `m${i}`, text: 'x'.repeat(4096) } });
  prior = body(await p.call('observe', { seen: prior.nervelet.id }));
  assert.equal(prior.hasMore, true); assert.equal(consumed.length, 0);
  const again = body(await p.call('observe'));
  assert.equal(again.events[0].nerveletEventId, prior.events[0].nerveletEventId);
  assert.equal(again.events[0].redelivered, true);
  const seen: string[] = [];
  while (prior.events.length) {
    seen.push(...prior.events.map((e: any) => e.message.id));
    prior = body(await p.call('observe', { seen: prior.nervelet.id }));
  }
  assert.deepEqual(seen, Array.from({ length: 60 }, (_, i) => `m${i}`));
  assert.deepEqual(consumed, seen);
});

test('local flight and acquisition continue during thinking; capture-time mail is included with independent timestamps', async t => {
  const { game, pilots, initial } = await fixture(t);
  const p = pilots[0], start = { ...game.state.drones[0] };
  const submitted = await effect(p, initial[0], 'act', { kind: 'fly_to', x: start.x, y: start.y + 4, z: start.z });
  assert.equal(submitted.nervelet.results.at(-1).status, 'accepted');
  for (let i = 0; i < 80; i++) { game.tick(0.05); await delay(1); }
  assert.ok(game.state.drones[0].y > start.y + 1);
  game.capture = async () => {
    game.tick(0.05);
    game.inboxes[p.id].push({ type: 'radio', mission: 1, message: { id: 'during', text: 'Captured during thinking' } });
    return 'data:image/jpeg;base64,AQID';
  };
  const next = body(await p.call('observe', { seen: submitted.nervelet.id }));
  assert.ok(next.events.some((e: any) => e.message?.id === 'during'));
  assert.ok(next.currentTelemetry.simTime > next.sensors.timestamp.simTime);
  assert.equal(next.sensors.camera.framePose.y, next.sensors.position.y);
});

test('three recovery generations restore exact job arguments and preserve local work until a received new objective', async t => {
  const { game, pilots, initial } = await fixture(t);
  const p = pilots[0], d = game.state.drones[0], waypoints = [{ x: d.x, y: d.y + 5, z: d.z }];
  let prior = await effect(p, initial[0], 'route', { op: 'start', waypoints });
  const id = prior.job.id;
  for (let i = 0; i < 3; i++) {
    p.refresh('native-compaction-fixture');
    prior = await effect(p, prior, 'send', { to: 'all', kind: 'chat', text: 'must be gated' });
    assert.equal(prior.nervelet.results.at(-1).reason, 'refresh_required');
    assert.equal(game.state.radio.some(m => m.text === 'must be gated'), false);
    assert.equal(prior.job.id, id);
    assert.deepEqual(prior.nervelet.jobs[0].args.waypoints, waypoints);
    prior = body(await p.call('observe', { seen: prior.nervelet.id }));
    assert.equal(prior.nervelet.loop, 'active');
  }
  await game.sendPlayerChat('ordinary chat');
  assert.equal(game.onboardTelemetry(p.id).job?.id, id);
  game.queueMission('Replacement exactly received'); await game.forwardTeam('blue');
  prior = await effect(p, prior, 'send', { to: 'all', kind: 'chat', text: 'stale effect' });
  assert.equal(prior.nervelet.goal.text, 'Replacement exactly received');
  assert.equal(prior.nervelet.goal.version, 2);
  assert.equal(prior.job.state, 'cancelled');
  assert.equal(game.state.radio.some(m => m.text === 'stale effect'), false);
});

test('conditional altitude and terminal-job waits wake from continuous updates without model polling', async t => {
  const { game, pilots, initial } = await fixture(t);
  const p = pilots[0], d = game.state.drones[0];
  const prior = await effect(p, initial[0], 'act', { kind: 'fly_to', x: d.x, y: d.y + 1, z: d.z });
  const timer = setInterval(() => game.tick(0.05), 10); t.after(() => clearInterval(timer));
  const next = body(await p.call('wait', { seen: prior.nervelet.id, until: [{ kind: 'threshold', field: 'altitude', op: 'gt', value: 30.2 }], timeout_ms: 3000 }));
  assert.equal(next.nervelet.wait.reason, 'threshold');
  const complete = body(await p.call('wait', { seen: next.nervelet.id, until: [{ kind: 'jobTerminal', id: prior.job.id }], timeout_ms: 3000 }));
  assert.equal(complete.nervelet.wait.reason, 'jobTerminal');
  assert.equal(complete.job.state, 'completed');
});

test('numeric wait advertisement and corrective errors derive from the profile with outer argument paths', async t => {
  const { game, pilots, initial } = await fixture(t);
  const p = pilots[0], expected = Object.keys(p.profile.waitFields!).sort();
  const wait = p.tools().find(tool => tool.name === 'wait')!;
  const branches = (wait.inputSchema.properties!.until as any).items.oneOf;
  for (const kind of ['threshold', 'change']) {
    const field = branches.find((branch: any) => branch.properties.kind.const === kind).properties.field;
    assert.deepEqual(field.enum, expected);
    assert.match(field.description, /local Y/);
    assert.match(field.description, /not height above a roof/);
    assert.match(field.description, /Carried salvage/);
  }
  assert.match(wait.description!, /jobTerminal.*blocked.*cancelled.*failed/);
  const delivered = game.inboxes[p.id].delivered;
  for (const condition of [{ kind: 'threshold', field: 'currentTelemetry.position.y', op: 'gt', value: 32 },
    { kind: 'change', field: 'cargo.amount', deadband: 1 }]) {
    const result = await p.call('wait', { seen: initial[0].nervelet.id, until: [condition], timeout_ms: 1000 });
    const value = body(result);
    assert.equal(result.isError, true);
    assert.deepEqual(value.error.allowed, expected);
    assert.equal(value.error.code, 'invalid_wait_field');
    assert.equal(value.error.path, '/until/0/field');
    assert.equal(value.nervelet, undefined, 'an error cannot invent an observation');
    assert.equal(value.rejected, undefined, 'an error carries no enclosing effect classification');
    assert.equal(game.inboxes[p.id].delivered, delivered, 'validation does not consume supplied seen evidence');
  }
  const missing = body(await p.call('workspace', { mission: 1, op: 'list' }));
  assert.equal(missing.error.path, '/command_id');
  const corrected = body(await p.call('wait', { seen: initial[0].nervelet.id, until: [{ kind: 'threshold', field: 'altitude', op: 'gt', value: 0 }], timeout_ms: 1000 }));
  assert.equal(corrected.nervelet.wait.reason, 'threshold');
});

test('a bad acknowledgement after responsive hover preserves the actual control result and effect', async t => {
  const { game, pilots, initial } = await fixture(t);
  const p = pilots[0], drone = game.state.drones[0];
  const flight = await effect(p, initial[0], 'act', { kind: 'fly_to', x: drone.x, y: drone.y + 5, z: drone.z });
  assert.equal(flight.nervelet.results.at(-1).status, 'accepted');
  const result = await p.call('act', { kind: 'hover', mission: 1, seen: 'not-a-received-bundle' });
  assert.equal(result.isError, true);
  const value = body(result);
  assert.equal(value.error.code, 'unknown_bundle');
  assert.equal(value.error.path, '/seen');
  for (const key of ['rejected', 'not_executed', 'admission', 'executed']) assert.equal(value[key], undefined);
  assert.equal(value.nervelet, undefined);
  const control = result.content.filter(item => item.type === 'text').map(item => JSON.parse(item.text)).find(item => item.control)?.control;
  assert.ok(control, 'the actual control output survives the following observation error');
  assert.equal(game.onboardTelemetry(p.id).job?.state, 'cancelled');
  const recovered = body(await p.call('observe'));
  assert.ok(recovered.nervelet.id);
  assert.equal(recovered.job.state, 'cancelled');
});

test('64 KiB files remain usable; duplicate command IDs cannot repeat a mutation and changed payloads are rejected', async t => {
  const { game, pilots, initial } = await fixture(t);
  const p = pilots[0], first = initial[0];
  const args = { mission: 1, seen: first.nervelet.id, command_id: first.nervelet.nextCommandId, op: 'write', path: 'large.txt', content: '\u0000'.repeat(65536) };
  let next = body(await p.call('workspace', args));
  assert.equal(next.nervelet.results.at(-1).status, 'completed');
  const version = game.onboardWorkspace(p.id).stat('large.txt').version;
  next = body(await p.call('workspace', { ...args, seen: next.nervelet.id }));
  assert.equal(game.onboardWorkspace(p.id).stat('large.txt').version, version);
  const conflict = body(await p.call('workspace', { ...args, seen: next.nervelet.id, content: 'changed' }));
  assert.equal(conflict.nervelet.results.at(-1).reason, 'id_conflict');
  const read = await effect(p, conflict, 'workspace', { op: 'read', path: 'large.txt' });
  assert.equal(read.nervelet.results.at(-1).data.result.workspace.content.length, 65536);
  assert.equal(read.workspace, undefined, 'historical command data stays outside current telemetry');
});

test('responsive hover cancels a blocked capture promptly; its late completion cannot replace newer evidence', async t => {
  const { game, pilots, initial } = await fixture(t);
  const p = pilots[0]; let release!: () => void, captured!: () => void;
  const started = new Promise<void>(r => { captured = r; });
  const gate = new Promise<void>(r => { release = r; });
  let count = 0;
  game.capture = async () => { if (++count === 1) { captured(); await gate; } return 'data:image/jpeg;base64,AQID'; };
  const pending = p.call('observe', { seen: initial[0].nervelet.id }); await started;
  const at = performance.now();
  const held = body(await p.call('act', { kind: 'hover', mission: 1 }));
  assert.ok(performance.now() - at < 1000);
  assert.equal(body(await pending).cancelled, true);
  assert.ok(held.sensors.camera.available); const sequence = held.sensors.sequence;
  release(); await delay(10);
  const next = body(await p.call('observe', { seen: held.nervelet.id }));
  assert.ok(next.sensors.sequence > sequence);
});

test('invalid waits and incompatible batches have no side effects; valid partial batches report individual outcomes', async t => {
  const { game, pilots, initial } = await fixture(t);
  const p = pilots[0], prior = initial[0];
  const command = { id: 'send', tool: 'send', args: { to: 'all', kind: 'chat', text: 'valid effect' } };
  const invalid = body(await p.call('wait', { seen: prior.nervelet.id, until: [], timeout_ms: 30001 }));
  assert.ok(invalid.error.code); assert.equal(game.state.radio.some(m => m.text === 'valid effect'), false);
  const refused = await effect(p, prior, 'exchange', { operations: [command,
    { id: 'one', tool: 'act', args: { kind: 'fly_to', x: 0, y: 30, z: 0 } },
    { id: 'two', tool: 'act', args: { kind: 'fly_to', x: 1, y: 30, z: 0 } }] });
  assert.equal(refused.nervelet.results.at(-1).status, 'rejected');
  assert.equal(game.state.radio.some(m => m.text === 'valid effect'), false);
  const args = { seen: refused.nervelet.id, command_id: refused.nervelet.nextCommandId, mission: 1,
    operations: [command, { id: 'purchase', tool: 'buy', args: { item: 'gun' } }] };
  const result = body(await p.call('exchange', args));
  const original = result.nervelet.results.at(-1).data.result;
  assert.equal(original.atomic, false);
  assert.equal(typeof original.outcomes[0].result.sent, 'string');
  assert.equal(original.outcomes[1].result.rejected, true);
  await p.call('exchange', { ...args, seen: result.nervelet.id });
  assert.equal(game.state.radio.filter(m => m.text === 'valid effect').length, 1);
});

test('ordinary event waits avoid idle telemetry work and still wake on mail and destruction', async t => {
  const { game, pilots, initial } = await fixture(t); const p = pilots[0];
  const ready = body(await p.call('observe', { seen: initial[0].nervelet.id }));
  const original = game.onboardTelemetry.bind(game); let reads = 0;
  game.onboardTelemetry = id => { reads++; return original(id); };
  const waiting = p.call('wait', { seen: ready.nervelet.id, timeout_ms: 30000 });
  await delay(5); const before = reads;
  for (let i = 0; i < 30; i++) { game.tick(0.01); await delay(0); }
  assert.equal(reads, before, 'idle simulation ticks must not poll full model snapshots');
  game.inboxes[p.id].push({ type: 'mail_notice', mission: 1 });
  const delivered = body(await waiting);
  assert.ok(delivered.events.some((e: any) => e.type === 'mail_notice'));
  const ended = p.call('wait', { seen: delivered.nervelet.id, timeout_ms: 30000 });
  await delay(5); game.state.drones[0].y = -1; game.tick(0.01);
  const result = await Promise.race([ended, delay(1000).then(() => undefined)]);
  assert.ok(result, 'destroyed drone must leave the held wait promptly');
  assert.equal(body(result).stopped, true);
});

test('stop during a held wait releases promptly and resets never reactivate an old bridge', async t => {
  const { game, pilots, initial } = await fixture(t); const p = pilots[0];
  const before = body(await p.call('observe', { seen: initial[0].nervelet.id }));
  const pending = p.call('wait', { seen: before.nervelet.id, timeout_ms: 30000 });
  await delay(20); game.stop();
  assert.equal(body(await pending).stopped, true);
  game.reset(); game.start();
  assert.equal(body(await p.call('observe')).stopped, true);
});

test('real role-bound MCP transports deliver Nervelet images and acknowledge only that drone', async t => {
  const { pilots, game } = await fixture(t);
  const server = new FleetMcpServer({ roles: ['drone-1', 'drone-2'], active: () => game.state.running,
    tools: role => pilots.find(p => p.id === role)!.tools(),
    call: (role, name, args) => pilots.find(p => p.id === role)!.call(name, args), policy: () => ({}), onEvent: () => {} });
  const endpoint = await server.start(), client = new Client({ name: 'nervelet-game-qa', version: '1' });
  t.after(async () => { await client.close(); await server.stop(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp/${endpoint.tokens['drone-1']}`)));
  const tools = (await client.listTools()).tools;
  assert.equal(tools.some(tool => tool.name === 'step'), false);
  assert.ok(tools.some(tool => tool.name === 'exchange'));
  assert.ok(tools.find(tool => tool.name === 'wait')!.inputSchema.properties?.until);
  const result = await client.callTool({ name: 'observe', arguments: {} }) as ToolResult;
  const first = body(result); assert.equal(result.content[1].type, 'image');
  const second = body(await client.callTool({ name: 'observe', arguments: { seen: first.nervelet.id } }) as ToolResult);
  assert.equal(second.nervelet.loop, 'active');
  assert.ok(game.inboxes['drone-1'].delivered > 0); assert.equal(game.inboxes['drone-2'].delivered, 0);
});

test('received objective during native command latency prevents stale MAVLink effects', async t => {
  const { pilots, game, initial } = await fixture(t); const p = pilots[0];
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  game.vehicleTransport = { sample: async (_id, pose, simTime) => ({ position: pose, heading: { degrees: 0 }, simTime }),
    command: async (_id, args) => { entered(); await gate; return args; } };
  const priorPitch = game.state.drones[0].pitch;
  const pending = effect(p, initial[0], 'act', { kind: 'look', pitch: -80 }); await started;
  game.queueMission('New native receipt'); await game.forwardTeam('blue');
  release(); await pending; await delay(10);
  assert.equal(game.state.drones[0].pitch, priorPitch);
  assert.equal(game.state.drones[0].action, undefined);
  assert.equal(game.state.running, true, 'a reconciled objective interruption must not stop the match');
});
