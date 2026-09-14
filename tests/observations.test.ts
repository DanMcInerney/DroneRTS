import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetGame } from '../server/game.ts';
import { Mailbox } from '../server/mailbox.ts';
import { DRONE_IDS, type ToolResult } from '../shared/types.ts';
import { droneInstructions, droneTools } from '../server/runtime-tools.ts';

const json = (result: ToolResult) => JSON.parse((result.content.find(c => c.type === 'text') as { text: string }).text);
async function ready() {
  const game = new FleetGame(); game.setConnected(true); game.start();
  game.state.obstacles = [];
  game.state.drones.forEach((d, i) => Object.assign(d, { x: (i - 1) * 5, y: 7, z: 23, yaw: 0, pitch: -23 }));
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  for (const id of DRONE_IDS) await game.tool(id, 'observe');
  game.queueMission('Explore and share observations.'); await game.tool('parent', 'forward_next_instruction');
  return game;
}

test('every drone tool automatically delivers unread events and exactly four sensor fields', async () => {
  const game = await ready();
  const calls: Array<[string, Record<string, unknown>]> = [
    ['observe', {}], ['act', { mission: 1, kind: 'hover' }],
    ['send', { mission: 1, to: 'all', kind: 'chat', text: 'Measurement' }],
    ['wait', {}], ['act', { mission: 0, kind: 'hover' }],
  ];
  for (const [name, args] of calls) {
    game.inboxes['drone-1'].push({ type: 'radio', mission: 1, text: name });
    const result = await game.tool('drone-1', name, args), body = json(result);
    assert.ok(body.events.some((e: any) => e.text === name));
    assert.equal(body.protocol, 'fleet-observation/1');
    assert.deepEqual(Object.keys(body.sensors).sort(), ['camera', 'heading', 'position', 'timestamp']);
    assert.equal(result.content[1].type, 'image');
    assert.ok(Number.isFinite(Date.parse(body.sensors.timestamp.capturedAt)));
    assert.equal(body.sensors.timestamp.simTime, game.state.simTime);
    assert.equal(game.inboxes['drone-1'].drain().events.length, 0);
    for (const key of ['bounds', 'groundPlaneY', 'verticalFovDegrees', 'pads', 'treasures', 'buildings', 'roads', 'obstacles', 'pitch', 'yaw']) {
      assert.equal(JSON.stringify(body).includes(`"${key}":`), false, `Leaked ${key}`);
    }
  }
  game.stop();
});

test('mail received during image capture joins the same bundle while sensors retain one sample time', async () => {
  const game = await ready();
  await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: -5, y: 7, z: 10 });
  const before = game.state.simTime, z = game.state.drones[0].z;
  game.capture = async (_id, pose, simTime, peers) => {
    assert.equal(simTime, before); assert.equal(pose.z, z); assert.equal(peers[0].z, z);
    game.tick(0.25);
    game.inboxes['drone-1'].push({ type: 'radio', mission: 1, text: 'Arrived during render' });
    return 'data:image/jpeg;base64,AQID';
  };
  const body = json(await game.tool('drone-1', 'observe'));
  assert.equal(body.sensors.position.z, z);
  assert.equal(body.sensors.timestamp.simTime, before);
  assert.ok(game.state.drones[0].z < z);
  assert.equal(body.events.at(-1).text, 'Arrived during render');
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

test('camera failure is explicit, keeps position/time, and still delivers messages', async () => {
  const game = await ready();
  game.capture = async () => { throw new Error('Disconnected'); };
  const result = await game.tool('drone-1', 'observe'), body = json(result);
  assert.equal(result.content.length, 1); assert.equal(body.sensors.camera.available, false);
  assert.equal(body.events[0].type, 'player'); assert.equal(body.sensors.position.x, -5);
  game.stop();
});

test('a replaced mission rejects stale actions and is delivered in that error response', async () => {
  const game = await ready();
  await game.tool('drone-1', 'observe');
  game.queueMission('Hold now'); await game.tool('parent', 'forward_next_instruction');
  const result = await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 0, y: 7, z: 0 });
  assert.equal(result.isError, true); assert.equal(game.state.drones[0].action, undefined);
  assert.equal(json(result).events.at(-1).text, 'Hold now'); assert.equal(json(result).mission, 2);
  game.stop();
});

test('scoring never enters agent inboxes and radio envelopes carry unique session identities', async () => {
  const game = await ready();
  const first = game.state.radio[0];
  assert.equal(first.protocol, 'fleet-radio/1'); assert.ok(Date.parse(first.sentAt));
  game.state.treasures = [{ id: 'test-chest', x: -5, y: 0, z: 20, found: false }];
  Object.assign(game.state.drones[0], { x: -5, y: 2, z: 23, yaw: 0, pitch: -23 });
  await game.tool('drone-1', 'observe');
  await game.tool('drone-1', 'send', { mission: 1, to: 'all', kind: 'found', text: 'A treasure chest is in my camera view.' });
  assert.equal(game.state.completed, true);
  for (const id of DRONE_IDS) assert.equal(game.inboxes[id].events.some(e => e.type === 'mission_complete'), false);
  game.stop(); game.start();
  for (const id of DRONE_IDS) await game.tool(id, 'observe');
  game.queueMission('Next'); await game.tool('parent', 'forward_next_instruction');
  assert.notEqual(game.state.radio[0].sessionId, first.sessionId); game.stop();
});

test('heading command matches heading sensor without revealing camera tilt', async () => {
  const game = await ready();
  const body = json(await game.tool('drone-1', 'act', { mission: 1, kind: 'look', heading: 90, pitch: -40 }));
  assert.equal(body.sensors.heading.degrees, 90);
  assert.equal(game.state.drones[0].yaw, -90);
  assert.equal(JSON.stringify(body).includes('pitch'), false); game.stop();
});

test('agent-facing instructions contain no world calibration or task solution', () => {
  const surface = droneInstructions('drone-1') + JSON.stringify(droneTools);
  for (const hint of ['Y is up', 'faces -Z', '3.25', 'y=2', '-30..30', 'groundPlaneY', 'white H', '3 world units', 'Cincinnati', 'Smale', '5.5', 'chest-1']) {
    assert.equal(surface.includes(hint), false, hint);
  }
});

test('legitimate rejected calibration experiments do not trip fleet error shutdown', async () => {
  const game = await ready();
  game.on('tool-error', error => { if (error.consecutive >= 4) game.stop(); });
  for (const y of [-1, 0, 0.25, 0.5]) {
    const result = await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: -5, y, z: 23 });
    assert.equal(result.isError, undefined); assert.equal(json(result).accepted, false);
    assert.equal(json(result).rejected, true); assert.equal(result.content[1].type, 'image');
    assert.equal(game.state.running, true);
  }
  const camera = await game.tool('drone-1', 'act', { mission: 1, kind: 'look', pitch: 100 });
  assert.equal(json(camera).rejected, true); assert.equal(camera.isError, undefined); game.stop();
});

test('arrival during capture refreshes the frame once and timestamps the controller event', async () => {
  const game = await ready(); let captures = 0;
  game.capture = async () => {
    if (++captures === 1) { game.tick(0.25); game.tick(0.25); }
    return 'data:image/jpeg;base64,AQID';
  };
  const body = json(await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: -4, y: 7, z: 23 }));
  assert.equal(captures, 2); assert.equal(body.sensors.position.x, -4);
  const arrival = body.events.find((e: any) => e.type === 'arrived');
  assert.ok(arrival); assert.ok(Date.parse(arrival.occurredAt));
  assert.ok(body.sensors.timestamp.simTime >= arrival.simTime);
  assert.equal(body.currentAction, null); game.stop();
});

test('mission change during capture refreshes sensors but preserves the command receipt epoch', async () => {
  const game = await ready(); let captures = 0;
  game.capture = async () => {
    if (++captures === 1) { game.queueMission('Replacement'); await game.tool('parent', 'forward_next_instruction'); }
    return 'data:image/jpeg;base64,AQID';
  };
  const body = json(await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: -4, y: 7, z: 23 }));
  assert.equal(captures, 2); assert.equal(body.commandMission, 1); assert.equal(body.mission, 2);
  assert.equal(body.events.at(-1).text, 'Replacement'); assert.equal(body.currentAction, null); game.stop();
});
