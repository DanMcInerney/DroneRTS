import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetGame } from '../server/game.ts';
import { Mailbox } from '../server/mailbox.ts';
import { DRONE_IDS, type ToolResult } from '../shared/types.ts';

const json = (result: ToolResult) => JSON.parse((result.content.find(c => c.type === 'text') as { text: string }).text);
async function ready() {
  const game = new FleetGame(); game.setConnected(true); game.start();
  game.state.obstacles = [];
  game.state.drones.forEach((d, i) => Object.assign(d, { x: (i - 1) * 5, y: 7, z: 23, yaw: 0, pitch: -23 }));
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  for (const id of DRONE_IDS) await game.tool(id, 'observe', { camera: false });
  game.queueMission('Find treasure chests.'); await game.tool('parent', 'forward_next_instruction');
  return game;
}
test('mail arriving before wait remains visible, and independent inbox waits wake separately', async () => {
  const a = new Mailbox(), b = new Mailbox();
  a.push({ type: 'radio', mission: 1 });
  assert.equal((await a.read(0, 0)).events.length, 1);
  const future = b.read(0, 1000);
  a.push({ type: 'arrived', mission: 1 });
  b.push({ type: 'radio', mission: 1 });
  assert.equal((await future).events[0].type, 'radio');
});
test('parent relays exact text and cannot access drone tools; peer identity is bound by caller', async () => {
  const game = await ready();
  const instruction = '  Fly north, then WAIT.  ';
  game.queueMission(instruction); await game.tool('parent', 'forward_next_instruction');
  assert.equal(game.state.radio.at(-1)?.text, instruction);
  assert.equal((await game.tool('parent', 'observe')).isError, true);
  const message = await game.tool('drone-2', 'send', { mission: 2, to: 'all', kind: 'chat', text: 'East is mine', droneId: 'drone-1' });
  assert.equal(message.isError, undefined);
  assert.equal(game.state.radio.at(-1)?.from, 'drone-2');
  assert.equal((await game.tool('drone-1', 'forward_next_instruction')).isError, true);
  game.stop();
});
test('a new instruction hovers drones and rejects delayed commands carrying the old mission', async () => {
  const game = await ready();
  await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 4, y: 7, z: 0 });
  assert.ok(game.state.drones[0].action);
  game.queueMission('Hold position'); await game.tool('parent', 'forward_next_instruction');
  assert.equal(game.state.drones[0].action, undefined);
  assert.equal((await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 9, y: 7, z: 0 })).isError, true);
  assert.equal((await game.tool('drone-1', 'send', { mission: 1, to: 'all', kind: 'claim', text: 'Old task' })).isError, true);
  game.stop();
});
test('local braking prevents a controllable impact, actual unarmored contact destroys, and browser loss pauses simulation', async () => {
  const game = await ready(), drone = game.state.drones[0];
  drone.equipment!.armor = false;
  game.state.obstacles = [{ x: -7, z: 3, width: 4, depth: 5, height: 3 }];
  Object.assign(drone, { x: -7, y: 2, z: 9 });
  await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: -7, y: 2, z: -5 });
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 30; i++) game.tick(0.2);
  assert.equal(drone.alive, true); assert.equal(drone.job?.state, 'blocked');
  Object.assign(drone, { x: -7, y: 2, z: 3 }); // Actual overlap still reaches collision authority.
  game.tick(1 / 120);
  assert.equal(drone.alive, false);
  assert.equal(game.inboxes['drone-1'].events.at(-1)?.type, 'destroyed');
  const simTime = game.state.simTime; game.setConnected(false); game.tick(0.2);
  assert.equal(game.state.simTime, simTime);
  game.stop();
});
test('recorded occupied approach reports a blocked job without contact or a false arrival', async t => {
  for (const dt of [1 / 120, 0.0078]) {
    const game = await ready(); t.after(() => game.stop());
    const [drone, peer] = game.state.drones;
    // Translate the recorded pair together into the current smaller bounds;
    // separation, velocity and the oblique sensor geometry remain identical.
    const target = { x: 25.20000076293945, y: 12, z: 21.5 };
    Object.assign(drone, { x: 21.599998474121094, y: 8, z: 21.899999618530273 });
    Object.assign(peer, target);
    assert.equal((await game.tool(drone.id, 'act', { mission: 1, kind: 'fly_to', profile: 'precision', ...target })).isError, undefined);
    await new Promise(resolve => setImmediate(resolve));
    const jobId = drone.job!.id;
    for (let i = 0; i < 2400; i++) game.tick(dt);
    const bundle = json(await game.tool(drone.id, 'observe'));
    assert.equal(bundle.job.id, jobId);
    assert.equal(bundle.job.state, 'blocked');
    assert.equal(bundle.job.reason, 'coverage-unavailable');
    assert.ok(!bundle.events.some((event: any) => event.type === 'arrived'));
    assert.ok(drone.alive && peer.alive && !drone.equipment!.armor && !peer.equipment!.armor);
    assert.equal(drone.action, undefined);
    assert.deepEqual(drone.velocity, { x: 0, y: 0, z: 0 });
  }
});

test('camera result pairs requested pose with image and does not disclose target locations', async () => {
  const game = await ready();
  const observations = game.state.drones[0].observations;
  game.capture = async (_id, pose) => { assert.equal(pose.x, -5); return 'data:image/jpeg;base64,AQID'; };
  const result = await game.tool('drone-1', 'observe', { camera: true });
  assert.equal(result.content[1].type, 'image'); assert.equal(json(result).pads, undefined);
  assert.equal(json(result).sensors.position.x, -5); assert.equal(game.state.drones[0].observations, observations + 1);
  game.stop();
});
test('Stop resolves event waits and prevents motion', async () => {
  const game = await ready();
  const inbox = game.inboxes['drone-1'];
  const waiting = game.tool('drone-1', 'wait', { after: inbox.cursor, timeout_ms: 1000 });
  game.stop();
  assert.equal(json(await waiting).stopped, true);
  assert.equal(json(await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 0, y: 4, z: 0 })).stopped, true);
});
test('a restarted fleet gets clean inboxes and cannot replay a stopped mission', async () => {
  const game = await ready(); game.queueMission('Old queued instruction'); game.stop(); game.start();
  assert.equal(game.state.mission, 0);
  const events = json(await game.tool('drone-1', 'wait', { after: 0, timeout_ms: 0 }));
  assert.deepEqual(events.events, []);
  assert.equal(events.stopped, false);
  assert.equal(game.state.radio.length, 0);
  game.stop();
});
test('future and stale cursor hints cannot skip unread mail or replay delivered messages', async () => {
  const inbox = new Mailbox();
  inbox.push({ type: 'player', mission: 1 });
  const first = await inbox.read(999, 0);
  assert.equal(first.events[0].type, 'player');
  assert.equal(first.cursorRecovered, true);
  assert.equal((await inbox.read(0, 0)).events.length, 0);
  const waiting = inbox.read(999, 1000);
  inbox.push({ type: 'radio', mission: 1 });
  assert.equal((await waiting).events[0].type, 'radio');
});
test('a guessed future drone cursor waits for real mail instead of returning a retry error', async () => {
  const game = await ready();
  await game.tool('drone-1', 'wait', { after: 999, timeout_ms: 1000 });
  let returned = false;
  const waiting = game.tool('drone-1', 'wait', { after: 999, timeout_ms: 30_000 }).then(result => { returned = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(returned, false);
  await game.tool('drone-2', 'send', { mission: 1, to: 'drone-1', kind: 'chat', text: 'New real message' });
  const result = await waiting;
  assert.equal(result.isError, undefined);
  assert.equal(json(result).events[0].message.text, 'New real message');
  game.stop();
});
test('tool failures emit inspectable error events and success resets the consecutive count', async () => {
  const game = await ready(); const errors: Array<{ consecutive: number; message: string }> = [];
  game.on('tool-error', error => errors.push(error));
  await game.tool('drone-1', 'act', { mission: 0, kind: 'hover' });
  await game.tool('drone-1', 'act', { mission: 0, kind: 'hover' });
  assert.equal(errors.at(-1)?.consecutive, 2);
  assert.match(errors.at(-1)!.message, /Stale/);
  await game.tool('drone-1', 'observe', { camera: false });
  await game.tool('drone-1', 'act', { mission: 0, kind: 'hover' });
  assert.equal(errors.at(-1)?.consecutive, 1);
  game.stop();
});

test('look turns through the shortest arc with bounded yaw and pitch rates', async () => {
  const game = await ready(), drone = game.state.drones[0];
  Object.assign(drone, { yaw: 179, pitch: 0 });
  await game.tool('drone-1', 'act', { mission: 1, kind: 'look', heading: 179, pitch: 50 });
  assert.equal(drone.yaw, 179); assert.equal(drone.pitch, 0);
  let yawTravel = 0, pitchTravel = 0;
  for (let i = 0; i < 120; i++) {
    const yaw = drone.yaw, pitch = drone.pitch;
    game.tick(0.05);
    const yawDelta = ((drone.yaw - yaw + 540) % 360) - 180;
    assert.ok(yawDelta >= -0.001 && yawDelta <= 180 * 0.05 + 0.001);
    assert.ok(Math.abs(drone.pitch - pitch) <= 120 * 0.05 + 0.001);
    yawTravel += yawDelta; pitchTravel += drone.pitch - pitch;
  }
  assert.ok(Math.abs(yawTravel - 2) < 0.001);
  assert.equal(pitchTravel, 50); assert.equal(drone.yaw, -179);
  game.stop();
});

test('waypoint translation accelerates, brakes, and arrives once without a pose snap', async () => {
  const game = await ready(), drone = game.state.drones[0];
  for (const peer of game.state.drones.slice(1)) peer.z += 20;
  await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 1, y: 7, z: 23 });
  assert.equal(drone.x, -5); assert.equal(drone.yaw, 0);
  const distances: number[] = [];
  for (let i = 0; i < 240 && drone.action; i++) {
    const x = drone.x;
    game.tick(0.05);
    distances.push(drone.x - x);
  }
  assert.ok(distances[0] > 0 && distances[0] < 0.02);
  assert.ok(distances[4] > distances[0] * 3);
  assert.ok(Math.max(...distances) <= 0.15 + 1e-8);
  assert.ok(distances.at(-1)! < 0.01);
  assert.equal(drone.x, 1); assert.equal(drone.action, undefined);
  assert.equal(game.inboxes['drone-1'].events.filter(event => event.type === 'arrived').length, 1);
  game.stop();
});

test('retarget and hover preserve motion continuity, then settle without an old arrival', async () => {
  const game = await ready(), drone = game.state.drones[0];
  await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 15, y: 7, z: 23 });
  for (let i = 0; i < 20; i++) game.tick(0.05);
  const before = { x: drone.x, yaw: drone.yaw };
  const replacement = await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: -15, y: 7, z: 23, replace: true });
  assert.equal(json(replacement).accepted, true);
  assert.equal(drone.x, before.x); assert.equal(drone.yaw, before.yaw);
  game.tick(0.05);
  assert.ok(drone.x > before.x, 'An opposite waypoint must brake existing velocity before reversing');
  await game.tool('drone-1', 'act', { mission: 1, kind: 'hover' });
  const hoverX = drone.x;
  game.tick(0.05);
  assert.ok(drone.x > hoverX, 'Hover eases the current velocity to zero');
  for (let i = 0; i < 40; i++) game.tick(0.05);
  const settled = { x: drone.x, yaw: drone.yaw };
  game.tick(0.25);
  assert.equal(drone.x, settled.x); assert.equal(drone.yaw, settled.yaw);
  assert.equal(drone.action, undefined);
  assert.equal(game.inboxes['drone-1'].events.some(event => event.type === 'arrived'), false);
  game.stop();
});

test('new missions and fleet restarts clear pending flight and orientation targets', async () => {
  const game = await ready(), drone = game.state.drones[0];
  await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 15, y: 7, z: 23 });
  game.tick(0.1);
  game.queueMission('Hold'); await game.tool('parent', 'forward_next_instruction');
  const held = { x: drone.x, yaw: drone.yaw, pitch: drone.pitch };
  game.tick(0.25);
  assert.deepEqual({ x: drone.x, yaw: drone.yaw, pitch: drone.pitch }, held);
  await game.tool('drone-1', 'act', { mission: 2, kind: 'look', heading: 90, pitch: 50 });
  game.tick(0.1); game.stop(); game.start();
  const restarted = { x: drone.x, yaw: drone.yaw, pitch: drone.pitch };
  game.tick(0.25);
  assert.equal(drone.x, restarted.x); assert.ok(Math.abs(drone.yaw - restarted.yaw) < 1e-10); assert.equal(drone.pitch, restarted.pitch);
  game.stop();
});

test('reset and launch replenish deposits, clear equipment and restore all six spawn poses', () => {
  const game = new FleetGame();
  const chosen = structuredClone(game.state.match!.resources);
  assert.equal(game.state.drones.length, 6);
  game.state.match!.resources[0].remaining = 0;
  game.reset();
  assert.deepEqual(game.state.match!.resources, chosen);
  const initialX = game.state.drones[0].x;
  game.state.drones[0].x += 2;
  game.state.drones[0].alive = false;
  game.state.drones[0].equipment!.gun = true;
  game.setConnected(true); game.start();
  assert.deepEqual(game.state.match!.resources, chosen);
  assert.equal(game.state.drones[0].x, initialX);
  assert.equal(game.state.drones[0].alive, true);
  assert.equal(game.state.drones[0].equipment!.gun, false);
  game.stop();
});
