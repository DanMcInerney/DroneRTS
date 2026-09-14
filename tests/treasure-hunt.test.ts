import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CITY } from '../shared/city.ts';
import { TreasureHunt, visibleTreasures } from '../server/treasure-hunt.ts';
import { DRONE_IDS, type RadioMessage, type ToolResult } from '../shared/types.ts';
import { FleetGame } from '../server/game.ts';

const json = (result: ToolResult) => JSON.parse((result.content[0] as { text: string }).text);
async function fixture() {
  const game = new FleetGame(); game.setConnected(true); game.start();
  game.state.obstacles = [];
  game.state.treasures = [{ id: 'first', x: 0, y: 0, z: 0, found: false }, { id: 'second', x: 20, y: 0, z: 0, found: false }];
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  for (const id of DRONE_IDS) await game.tool(id, 'observe');
  game.queueMission('Find treasure chests and report finds over radio.'); await game.tool('parent', 'forward_next_instruction');
  Object.assign(game.state.drones[0], { x: 0, y: 2, z: 4, yaw: 0, pitch: -20 });
  return game;
}
const report = (game: FleetGame) => game.tool('drone-1', 'send', { mission: 1, to: 'all', kind: 'found', text: 'I visually confirmed a treasure chest here.' });

test('each treasure layout samples six distinct mapped junctions and avoids the previous layout', () => {
  const snapshot = JSON.stringify(CITY.intersections);
  const hunt = new TreasureHunt(CITY.intersections, () => 0);
  const first = hunt.newMap().treasures;
  const second = hunt.newMap(first).treasures;
  assert.equal(first.length, 6); assert.equal(second.length, 6);
  const positions = (chests: typeof first) => chests.map(chest => `${chest.x},${chest.z}`);
  assert.equal(new Set(positions(first)).size, 6);
  assert.equal(new Set(positions(second)).size, 6);
  assert.equal(positions(first).some(position => positions(second).includes(position)), false);
  for (const chest of [...first, ...second]) {
    assert.equal(chest.found, false); assert.equal(chest.y, 0);
    assert.ok(CITY.intersections.some(point => point.x === chest.x && point.z === chest.z));
  }
  assert.equal(JSON.stringify(CITY.intersections), snapshot);
  assert.notDeepEqual(new TreasureHunt(CITY.intersections, () => 0.99999).newMap().treasures, first);
});

test('treasure recognition requires nearby forward camera view and an unobstructed line of sight', () => {
  const chest = { id: 'test', x: 0, y: 0, z: 0, found: false };
  const pose = { x: 0, y: 2, z: 4, yaw: 0, pitch: -20 };
  assert.deepEqual(visibleTreasures(pose, [chest], []), ['test']);
  assert.deepEqual(visibleTreasures({ ...pose, yaw: 180 }, [chest], []), []);
  assert.deepEqual(visibleTreasures({ ...pose, z: 10 }, [chest], []), []);
  assert.deepEqual(visibleTreasures(pose, [chest], [{ x: 0, z: 2, width: 8, depth: 0.2, height: 4 }]), []);
});

test('finding treasure needs a delivered image and found report; duplicates cannot increase the score', async () => {
  const game = await fixture();
  await game.tool('drone-1', 'observe');
  assert.equal(game.state.treasures[0].found, false);
  const result = await report(game);
  assert.equal(game.state.treasures[0].found, true); assert.equal(game.state.treasures[0].foundBy, 'drone-1');
  assert.equal(game.state.completed, false);
  assert.equal(JSON.stringify(json(result)).includes('treasures'), false);
  await report(game); assert.equal(game.state.treasures.filter(c => c.found).length, 1);
  assert.equal(game.inboxes['drone-2'].events.some(e => ['treasure-found', 'mission_complete'].includes(e.type)), false);
  Object.assign(game.state.drones[0], { x: 20 }); await game.tool('drone-1', 'observe'); await report(game);
  assert.equal(game.state.completed, true);
  game.stop(); game.reset(); assert.equal(game.state.treasures.filter(c => c.found).length, 0);
});

test('failed, expired and previous-mission observations cannot become treasure finds', async () => {
  const game = await fixture();
  game.capture = async () => { throw new Error('No camera'); }; await game.tool('drone-1', 'observe'); await report(game);
  assert.equal(game.state.treasures[0].found, false);
  game.capture = async () => 'data:image/jpeg;base64,AQID'; await game.tool('drone-1', 'observe');
  game.state.simTime += 31; await report(game); assert.equal(game.state.treasures[0].found, false);
  game.queueMission('Replacement'); await game.tool('parent', 'forward_next_instruction');
  assert.equal((await report(game)).isError, true); assert.equal(game.state.treasures[0].found, false);
  game.stop();
});

test('objective evidence is private to each observer, and only a matching radio report credits it', () => {
  const hunt = new TreasureHunt([]);
  const treasures = [{ id: 'test', x: 0, y: 0, z: 0, found: false }];
  hunt.recordObservation({ drone: 'drone-1', pose: { x: 0, y: 2, z: 4, yaw: 0, pitch: -20 },
    mission: 4, simTime: 10, imageAvailable: true }, treasures, []);
  const message: RadioMessage = { protocol: 'fleet-radio/1', sessionId: 'test', sequence: 1, sentAt: new Date().toISOString(),
    id: 'report', from: 'drone-1', to: 'all', kind: 'found', text: 'A treasure chest is visible.', simTime: 10, mission: 4 };
  const base = { drone: 'drone-1' as const, message, mission: 4, simTime: 10 };
  assert.equal(hunt.report({ ...base, drone: 'drone-2', message: { ...message, from: 'drone-2' } }, treasures), undefined);
  assert.equal(hunt.report({ ...base, message: { ...message, from: 'drone-2' } }, treasures), undefined);
  assert.equal(hunt.report({ ...base, message: { ...message, kind: 'chat' } }, treasures), undefined);
  assert.equal(hunt.report({ ...base, message: { ...message, text: 'I arrived here.' } }, treasures), undefined);
  assert.equal(hunt.report({ ...base, mission: 5 }, treasures), undefined);
  assert.equal(hunt.report({ ...base, mission: 5, message: { ...message, mission: 5 } }, treasures), undefined);
  assert.equal(hunt.report({ ...base, simTime: 40.01 }, treasures), undefined);
  assert.equal(treasures[0].found, false);
  assert.deepEqual(hunt.report({ ...base, simTime: 40 }, treasures), {
    event: { id: 'test', drone: 'drone-1', simTime: 40 }, completed: true,
  });
  assert.deepEqual(treasures[0], { id: 'test', x: 0, y: 0, z: 0, found: true, foundBy: 'drone-1', foundAt: 40 });
  assert.equal(hunt.report(base, treasures), undefined);
});

test('failed captures and fleet restarts invalidate otherwise valid visual evidence', () => {
  const hunt = new TreasureHunt([]);
  let treasures = [{ id: 'test', x: 0, y: 0, z: 0, found: false }];
  const sample = { drone: 'drone-1' as const, pose: { x: 0, y: 2, z: 4, yaw: 0, pitch: -20 },
    mission: 1, simTime: 10, imageAvailable: true };
  const message: RadioMessage = { protocol: 'fleet-radio/1', sessionId: 'test', sequence: 1, sentAt: new Date().toISOString(),
    id: 'report', from: 'drone-1', to: 'all', kind: 'found', text: 'A treasure chest is visible.', simTime: 10, mission: 1 };
  const report = { drone: 'drone-1' as const, message, mission: 1, simTime: 10 };
  hunt.recordObservation(sample, treasures, []);
  hunt.recordObservation({ ...sample, imageAvailable: false }, treasures, []);
  assert.equal(hunt.report(report, treasures), undefined);
  hunt.recordObservation(sample, treasures, []);
  treasures = hunt.restart(treasures).treasures;
  assert.equal(hunt.report(report, treasures), undefined);
  hunt.recordObservation(sample, treasures, []);
  assert.equal(hunt.report(report, treasures)?.completed, true);
});
