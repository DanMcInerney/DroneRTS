import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetGame } from '../server/game.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';
import type { RecordedObservation } from '../shared/replay.ts';
import type { MatchEvent } from '../shared/rts.ts';
import type { ToolResult } from '../shared/types.ts';

const body = (result: ToolResult) => JSON.parse((result.content[0] as { text: string }).text);
async function fixture() {
  const game = new FleetGame(); game.setConnected(true); game.start();
  game.state.obstacles = [];
  game.state.drones.forEach((d, i) => Object.assign(d, { x: i * 10, y: 8, z: 20, yaw: 0, pitch: 0 }));
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  for (const id of MATCH_DRONE_IDS) await game.tool(id, 'observe');
  await game.forwardTeam('blue'); await game.forwardTeam('red');
  return game;
}

test('replay records only the final delivered camera after a controller refresh', async () => {
  const game = await fixture(), samples: RecordedObservation[] = [];
  game.on('recorded-observation', sample => samples.push(sample));
  let captures = 0;
  game.capture = async () => {
    if (++captures === 1) {
      for (let i = 0; game.state.drones[0].action && i < 40; i++) game.tick(0.25);
      return 'data:image/jpeg;base64,AQID';
    }
    return 'data:image/png;base64,BAUG';
  };
  try {
    const result = await game.tool('drone-1', 'act', { mission: 1, kind: 'fly_to', x: 1, y: 8, z: 20 });
    const delivered = body(result);
    assert.equal(captures, 2); assert.equal(samples.length, 1);
    assert.equal(samples[0].pose.x, 1);
    assert.equal(samples[0].simTime, delivered.sensors.timestamp.simTime);
    assert.equal(samples[0].capturedAt, delivered.sensors.timestamp.capturedAt);
    assert.deepEqual(samples[0].image, { mimeType: 'image/png', data: 'BAUG' });
    assert.equal(JSON.stringify(delivered).includes('replay'), false);
    const originalX = samples[0].pose.x; game.state.drones[0].x = 999;
    assert.equal(samples[0].pose.x, originalX);
  } finally { game.stop(); }
});

test('replay marks failed cameras without substituting an older image and ignores cancelled delivery', async () => {
  const game = await fixture(), samples: RecordedObservation[] = [];
  game.on('recorded-observation', sample => samples.push(sample));
  try {
    game.capture = async () => { throw new Error('Disconnected'); };
    const unavailable = body(await game.tool('drone-1', 'observe'));
    assert.equal(unavailable.sensors.camera.available, false);
    assert.equal(samples.length, 1); assert.equal(samples[0].image, undefined);
    game.capture = async () => { game.stop(); return 'data:image/jpeg;base64,AQID'; };
    await game.tool('drone-1', 'observe');
    assert.equal(samples.length, 1);
  } finally { game.stop(); }
});

test('player combat events correlate physical shots and impacts without adding hidden hit receipts', async () => {
  const game = await fixture(), events: MatchEvent[] = [];
  game.on('match-event', event => events.push(event));
  try {
    game.state.drones.forEach((d, i) => { d.alive = i === 0 || i === 3; Object.assign(d, { x: 0, y: 8, z: i === 0 ? 20 : 8 }); });
    game.state.drones[0].equipment!.gun = true;
    const result = body(await game.tool('drone-1', 'fire', { mission: 1 }));
    assert.equal(result.fired, true);
    const fired = events.find(e => e.type === 'fired'); assert.ok(fired?.projectileId);
    for (let i = 0; i < 12 && game.state.running; i++) game.tick(0.1);
    const impact = events.find(e => e.type === 'impact'); assert.ok(impact);
    assert.equal(impact.projectileId, fired.projectileId); assert.equal(impact.cause, 'bullet');
    assert.equal(events.find(e => e.type === 'destroyed')?.projectileId, fired.projectileId);
    assert.equal(game.state.match!.winner, 'blue');
    assert.equal(JSON.stringify(result).includes(fired.projectileId), false);
    assert.equal(JSON.stringify(result).includes('impact'), false);
  } finally { game.stop(); }
});
