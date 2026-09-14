import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CITY } from '../shared/city.ts';
import { DRONE_IDS, type ToolResult } from '../shared/types.ts';
import { FleetGame } from '../server/game.ts';
import { intersectsBuilding, visibleTreasures } from '../server/world-geometry.ts';

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

test('Cincinnati scene retains mapped massing and skyline heights, with clear spawns and reachable chests', () => {
  assert.ok(CITY.buildings.length > 200); assert.ok(CITY.roads.length > 500);
  assert.equal(CITY.treasures.length, 6);
  const top = (prefix: string) => Math.max(...CITY.buildings.filter(b => b.id?.startsWith(prefix)).map(b => b.height + (b.baseY ?? 0)));
  assert.ok(Math.abs(top('great-american-tower') - 20.27) < 0.002);
  assert.ok(Math.abs(top('carew-tower') - 17.5) < 0.002);
  for (const spawn of CITY.spawns) assert.equal(CITY.buildings.some(b => intersectsBuilding(spawn, spawn, b, 0.3)), false);
  for (const chest of CITY.treasures) {
    const centre = { x: chest.x, y: chest.y + 0.55, z: chest.z };
    assert.equal(CITY.buildings.some(b => intersectsBuilding(centre, centre, b, 0.2)), false, chest.id);
    for (const axis of ['x', 'y', 'z'] as const) assert.ok(centre[axis] >= (axis === 'y' ? 0 : CITY.bounds[axis][0]) && centre[axis] < CITY.bounds[axis][1]);
  }
});

test('rotated collision volumes block crossing segments, allow rooftops, and respect elevated tiers', () => {
  const tower = { x: 0, z: 0, width: 1, depth: 5, height: 10, rotation: 45 };
  assert.equal(intersectsBuilding({ x: -9, y: 2, z: 0 }, { x: 9, y: 2, z: 0 }, tower, 0.3), true);
  assert.equal(intersectsBuilding({ x: -9, y: 11, z: 0 }, { x: 9, y: 11, z: 0 }, tower, 0.3), false);
  assert.equal(intersectsBuilding({ x: -9, y: 2, z: 0 }, { x: 9, y: 2, z: 0 }, { ...tower, baseY: 5 }), false);
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
