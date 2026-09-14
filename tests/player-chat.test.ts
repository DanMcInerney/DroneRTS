import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetGame } from '../server/game.ts';
import type { RadioMessage, ToolResult } from '../shared/types.ts';
const value = (result: ToolResult) => JSON.parse((result.content[0] as { type: 'text'; text: string }).text);

test('ordinary blue player chat preserves received objectives/jobs and never reaches red actors', async t => {
  const game = new FleetGame(); game.capture = async () => 'data:image/png;base64,AQID';
  game.setConnected(true); game.start(); t.after(() => game.stop());
  for (const drone of game.state.drones) await game.tool(drone.id, 'observe');
  await game.forwardTeam('blue'); await game.forwardTeam('red');
  const drone = game.state.drones[0];
  const move = value(await game.tool(drone.id, 'act', { mission: 1, kind: 'fly_to', x: drone.x, y: drone.y + 3, z: drone.z }));
  const redCursor = game.inboxes['drone-4'].cursor;
  const chat = await game.sendPlayerChat('Continue your chosen plan.');
  assert.ok(chat.queued); assert.equal(game.receivedMission(drone.id), 1); assert.equal(drone.job?.id, move.job.id);
  assert.equal(drone.job?.state, 'running'); assert.equal(game.inboxes['drone-4'].cursor, redCursor);
  await assert.rejects(game.sendPlayerChat('Wrong destination', 'drone-4'), /only to blue/);
  const envelope: RadioMessage = { protocol: 'fleet-radio/1', sessionId: game.sessionIdentity, sequence: 999, sentAt: new Date().toISOString(),
    id: 'cross-team-player-chat', from: 'player', to: 'all', kind: 'chat', text: 'Wrong network', mission: 1, simTime: 0 };
  game.receiveRadio('drone-4', envelope); assert.equal(game.inboxes['drone-4'].cursor, redCursor);
  const oldRadioCount = game.state.radio.length;
  game.receivePlayerRadio({ ...envelope, from: 'drone-4', to: 'player' }); assert.equal(game.state.radio.length, oldRadioCount);
});
