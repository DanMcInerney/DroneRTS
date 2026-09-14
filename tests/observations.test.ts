import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { FleetGame } from '../server/game.ts';
import { Mailbox } from '../server/mailbox.ts';
import { DRONE_IDS, type ToolResult } from '../shared/types.ts';
import { droneInstructions, droneTools, RTS_MISSION } from '../server/runtime-tools.ts';

const json = (result: ToolResult) => JSON.parse((result.content.find(c => c.type === 'text') as { text: string }).text);
async function ready(t: TestContext) {
  const game = new FleetGame(); game.setConnected(true); game.start();
  t.after(() => game.stop());
  game.state.obstacles = [];
  game.state.drones.forEach((d, i) => Object.assign(d, { x: (i - 1) * 5, y: 7, z: 23, yaw: 0, pitch: -23 }));
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  for (const id of DRONE_IDS) await game.tool(id, 'observe');
  game.queueMission('Explore and share observations.'); await game.tool('parent', 'forward_next_instruction');
  return game;
}
function receive(game: FleetGame, text: string, id: string) {
  // Use a valid delivered envelope so expiry, receipt and bundle handling run.
  game.receiveRadio('drone-1', { ...game.state.radio[0], id,
    from: 'drone-2', to: 'drone-1', kind: 'chat', text, mission: 1 });
}

test('every drone tool delivers unread events, calibrated own sensors and current telemetry without battlefield state', async t => {
  const game = await ready(t);
  const calls: Array<[string, Record<string, unknown>]> = [
    ['observe', {}], ['act', { mission: 1, kind: 'hover' }],
    ['send', { mission: 1, to: 'all', kind: 'chat', text: 'Measurement' }],
    ['wait', {}], ['act', { mission: 0, kind: 'hover' }],
  ];
  for (const [index, [name, args]] of calls.entries()) {
    receive(game, name, `boundary-${index}`);
    const result = await game.tool('drone-1', name, args), body = json(result);
    assert.ok(body.events.some((e: any) => e.message?.text === name));
    assert.equal(body.protocol, 'fleet-observation/2');
    assert.equal(body.sensors.frame, 'local-east-up-south');
    assert.equal(body.sensors.units, 'simulation-units');
    assert.equal(body.sensors.metersPerUnit, 10);
    assert.ok(body.sensors.sequence > 0); assert.ok(body.sensors.ageMs >= 0);
    assert.ok(body.sensors.velocity); assert.ok(body.sensors.ranges); assert.ok(body.currentTelemetry);
    assert.equal(body.sensors.cameraOrientation.pitch, game.state.drones[0].pitch);
    assert.equal(result.content[1].type, 'image');
    assert.ok(Number.isFinite(Date.parse(body.sensors.timestamp.capturedAt)));
    assert.equal(body.sensors.timestamp.simTime, game.state.simTime);
    assert.equal(game.inboxes['drone-1'].drain().events.length, 0);
    for (const key of ['bounds', 'groundPlaneY', 'pads', 'treasures', 'buildings', 'roads', 'obstacles', 'resources', 'enemyPositions']) {
      assert.equal(JSON.stringify(body).includes(`"${key}":`), false, `Leaked ${key}`);
    }
  }
  game.stop();
});

test('mail received during image capture joins the same bundle while sensors retain one sample time', async t => {
  const game = await ready(t);
  await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: -5, y: 7, z: 10 });
  const before = game.state.simTime, z = game.state.drones[0].z;
  game.capture = async (_id, pose, simTime, peers) => {
    assert.equal(simTime, before); assert.equal(pose.z, z); assert.equal(peers[0].z, z);
    game.tick(0.25);
    receive(game, 'Arrived during render', 'during-capture');
    return 'data:image/jpeg;base64,AQID';
  };
  const body = json(await game.tool('drone-1', 'observe'));
  assert.equal(body.sensors.position.z, z);
  assert.equal(body.sensors.timestamp.simTime, before);
  assert.ok(game.state.drones[0].z < z);
  assert.equal(body.sensors.camera.framePose.z, z);
  assert.ok(body.currentTelemetry.position.z < z);
  assert.equal(body.currentTelemetry.simTime, game.state.simTime);
  assert.equal(body.events.at(-1).message.text, 'Arrived during render');
  game.stop();
});

test('unread backlog is not silently truncated after 500 messages', async () => {
  const inbox = new Mailbox();
  for (let i = 0; i < 750; i++) inbox.push({ type: 'radio', mission: 1, index: i });
  assert.equal((await inbox.read(9999, 0)).events.length, 750);
  inbox.push({ type: 'radio', mission: 1, index: 750 });
  assert.equal(inbox.events.length, 1);
  assert.equal((await inbox.read(0, 0)).events[0].index, 750);
});

test('camera failure is explicit, keeps position/time, and still delivers messages', async t => {
  const game = await ready(t);
  game.capture = async () => { throw new Error('Disconnected'); };
  const result = await game.tool('drone-1', 'observe'), body = json(result);
  assert.equal(result.content.length, 1); assert.equal(body.sensors.camera.available, false);
  assert.equal(body.sensors.camera.fresh, false);
  assert.equal(body.events[0].type, 'player'); assert.equal(body.sensors.position.x, -5);
  game.stop();
});

test('bundle ages include post-capture assembly and delivery follows current telemetry acquisition', async t => {
  const game = await ready(t);
  let clock = 1000;
  t.mock.method(performance, 'now', () => clock);
  // Simulate costly synchronous quota/metadata assembly after camera capture.
  const internals = game as unknown as { storageStatus(id: string): unknown };
  const status = internals.storageStatus.bind(game);
  t.mock.method(internals, 'storageStatus', (id: string) => { const result = status(id); clock += 200; return result; });
  const body = json(await game.tool('drone-1', 'observe'));
  assert.equal(body.sensors.camera.ageMs, body.deliveredAtMs - body.sensors.camera.acquiredAtMs);
  assert.ok(body.sensors.camera.ageMs >= 400, 'Both post-capture storage passes count toward delivered image age');
  assert.equal(body.sensors.ranges.fresh, false);
  assert.equal(body.currentTelemetry.ageMs, body.deliveredAtMs - body.currentTelemetry.acquiredAtMs);
  assert.equal(body.currentTelemetry.ranges.fresh, false);
  assert.ok(Date.parse(body.deliveredAt) >= Date.parse(body.currentTelemetry.acquiredAt));
});

test('a replaced mission rejects stale actions and is delivered in that error response', async t => {
  const game = await ready(t);
  await game.tool('drone-1', 'observe');
  game.queueMission('Hold now'); await game.tool('parent', 'forward_next_instruction');
  const result = await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 0, y: 7, z: 0 });
  assert.equal(result.isError, true); assert.equal(game.state.drones[0].action, undefined);
  assert.equal(json(result).events.at(-1).text, 'Hold now'); assert.equal(json(result).mission, 2);
  game.stop();
});

test('radio claims cannot award victory and radio envelopes carry unique session identities', async t => {
  const game = await ready(t);
  const first = game.state.radio[0];
  assert.equal(first.protocol, 'fleet-radio/1'); assert.ok(Date.parse(first.sentAt));
  Object.assign(game.state.drones[0], { x: -5, y: 2, z: 23, yaw: 0, pitch: -23 });
  await game.tool('drone-1', 'observe');
  await game.tool('drone-1', 'send', { mission: 1, to: 'all', kind: 'done', text: 'I eliminated all enemies.' });
  assert.equal(game.state.completed, false);
  for (const id of DRONE_IDS) assert.equal(game.inboxes[id].events.some(e => e.type === 'mission_complete'), false);
  game.stop(); game.start();
  for (const id of DRONE_IDS) await game.tool(id, 'observe');
  game.queueMission('Next'); await game.tool('parent', 'forward_next_instruction');
  assert.notEqual(game.state.radio[0].sessionId, first.sessionId); game.stop();
});

test('heading and measured camera orientation report the sampled turn before reaching the command', async t => {
  const game = await ready(t);
  const body = json(await game.tool('drone-1', 'act', { mission: 1, kind: 'look', heading: 90, pitch: -40 }));
  assert.equal(body.sensors.heading.degrees, 0);
  assert.equal(game.state.drones[0].yaw, 0);
  game.tick(0.1);
  const turning = json(await game.tool('drone-1', 'observe'));
  assert.ok(turning.sensors.heading.degrees > 0 && turning.sensors.heading.degrees < 90);
  for (let i = 0; i < 30; i++) game.tick(0.2);
  assert.equal(json(await game.tool('drone-1', 'observe')).sensors.heading.degrees, 90);
  assert.equal(game.state.drones[0].yaw, -90);
  assert.equal(body.sensors.cameraOrientation.pitch, -23);
  assert.equal(json(await game.tool('drone-1', 'observe')).sensors.cameraOrientation.pitch, -40); game.stop();
});

test('agent-facing instructions contain no battlefield coordinates or task solution', () => {
  const surface = RTS_MISSION + droneInstructions('drone-1') + JSON.stringify(droneTools);
  for (const hint of ['-30..30', 'groundPlaneY', 'white H', 'Cincinnati', 'Smale', 'chest-1']) {
    assert.equal(surface.includes(hint), false, hint);
  }
});

test('legitimate rejected calibration experiments do not trip fleet error shutdown', async t => {
  const game = await ready(t);
  game.on('tool-error', error => { if (error.consecutive >= 4) game.stop(); });
  for (const y of [-1e6, -1e5, 1e5, 1e6]) {
    const result = await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: -5, y, z: 23 });
    assert.equal(result.isError, undefined); assert.equal(json(result).accepted, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(game.state.drones[0].job?.state, 'failed');
    assert.match(game.state.drones[0].job?.reason ?? '', /flight controller/);
    assert.equal(result.content[1].type, 'image');
    assert.equal(game.state.running, true);
  }
  const camera = await game.tool('drone-1', 'act', { mission: 1, kind: 'look', pitch: 100 });
  assert.equal(json(camera).rejected, true); assert.equal(camera.isError, undefined); game.stop();
});

test('arrival during capture refreshes the frame once and timestamps the controller event', async t => {
  const game = await ready(t); let captures = 0;
  game.capture = async () => {
    if (++captures === 1) {
      await new Promise(resolve => setImmediate(resolve));
      for (let step = 0; game.state.drones[0].action && step < 40; step++) game.tick(0.25);
    }
    return 'data:image/jpeg;base64,AQID';
  };
  const body = json(await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: -4, y: 7, z: 23 }));
  assert.equal(captures, 2); assert.equal(body.sensors.position.x, -4);
  const arrival = body.events.find((e: any) => e.type === 'arrived');
  assert.ok(arrival); assert.ok(Date.parse(arrival.occurredAt));
  assert.ok(body.sensors.timestamp.simTime >= arrival.simTime);
  assert.equal(body.currentAction, null); game.stop();
});

test('mission change during capture refreshes sensors but preserves the command receipt epoch', async t => {
  const game = await ready(t); let captures = 0;
  game.capture = async () => {
    if (++captures === 1) { game.queueMission('Replacement'); await game.tool('parent', 'forward_next_instruction'); }
    return 'data:image/jpeg;base64,AQID';
  };
  const body = json(await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: -4, y: 7, z: 23 }));
  assert.equal(captures, 2); assert.equal(body.commandMission, 1); assert.equal(body.mission, 2);
  assert.equal(body.events.at(-1).text, 'Replacement'); assert.equal(body.currentAction, null); game.stop();
});
