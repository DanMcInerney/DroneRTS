import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RtsRules } from '../server/rts.ts';
import { emptyEquipment } from '../shared/rts.ts';
import type { Drone, GameState } from '../shared/types.ts';
import { FleetGame } from '../server/game.ts';
import { MATCH_DRONE_IDS } from '../shared/fleet.ts';

function fixture() {
  const rules = new RtsRules();
  const drones: Drone[] = ['drone-1', 'drone-4'].map((id, index) => ({
    id: id as Drone['id'], team: index ? 'red' : 'blue', x: 0, y: 5, z: index ? 0 : 5,
    yaw: 0, pitch: 0, alive: true, online: true, observations: 0, status: '', equipment: emptyEquipment(),
    cargo: { amount: 0 }, ammo: 0,
  }));
  const state: GameState = { simTime: 0, mission: 1, running: true, speed: 1, completed: false,
    drones, obstacles: [], treasures: [], radio: [], runtime: { status: 'idle', message: '', model: '', effort: '' },
    match: rules.newMatch([]) };
  rules.begin(state); drones[0].equipment!.gun = true; drones[0].ammo = 12;
  const tick = (seconds: number) => {
    for (let i = 0; i < Math.ceil(seconds / .05); i++) { state.simTime += .05; rules.step(state, .05); }
  };
  return { rules, state, shooter: drones[0], victim: drones[1], tick };
}

test('a lethal gunshot records one actual death pose while death, cargo and victory resolve immediately', () => {
  const { rules, state, shooter, victim, tick } = fixture();
  victim.cargo!.amount = 30; victim.yaw = 72;
  rules.fire(state, shooter); tick(.3);
  assert.equal(victim.alive, false); assert.equal(victim.online, false); assert.equal(victim.ammo, 0);
  assert.equal(state.completed, true); assert.equal(state.match!.winner, 'blue');
  assert.throws(() => rules.fire(state, victim), /destroyed/);
  assert.equal(victim.cargo!.amount, 0);
  assert.equal(state.match!.resources.reduce((sum, node) => sum + node.remaining, 0) + state.match!.salvageLost!, 30);
  const death = state.match!.events.find(event => event.type === 'destroyed')!;
  assert.deepEqual(state.match!.wrecks, [{ drone: victim.id, x: 0, y: 5, z: 0, yaw: 72, startedAt: death.simTime }]);
  victim.x = 40; tick(3);
  assert.equal(state.match!.wrecks!.length, 1); assert.equal(state.match!.wrecks![0].x, 0, 'seed must own its actual death pose');
  rules.begin(state); assert.deepEqual(state.match!.wrecks, [], 'a new match cannot retain debris or smoke');
});

test('armor absorption and terrain deaths do not create gunshot wreck effects', () => {
  const { rules, state, shooter, victim, tick } = fixture();
  victim.equipment!.armor = true;
  rules.fire(state, shooter); tick(.3);
  assert.equal(victim.alive, true); assert.equal(victim.equipment!.armor, false);
  assert.deepEqual(state.match!.wrecks, []);
  rules.terrainCollision(state, victim, victim, { ...victim, y: -1 });
  assert.equal(victim.alive, false); assert.deepEqual(state.match!.wrecks, []);
});

test('historical rules preserve their disappearance semantics', () => {
  const { rules, state, shooter, victim, tick } = fixture(); state.match!.rulesVersion = 'cargo-v2';
  rules.fire(state, shooter); tick(.3);
  assert.equal(victim.alive, false); assert.deepEqual(state.match!.wrecks, []);
});

test('death seeds reach the camera renderer but never enter actor telemetry', async () => {
  const game = new FleetGame(); game.setConnected(true); game.start();
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  try {
    for (const id of MATCH_DRONE_IDS) await game.tool(id, 'observe');
    await game.forwardTeam('blue'); await game.forwardTeam('red');
    const seed = { drone: 'drone-4' as const, startedAt: 0, x: 21.23456789, y: 15, z: 28, yaw: 42 };
    game.state.match!.wrecks = [seed];
    let rendered = false;
    game.capture = async (_role, _pose, _time, _peers, match) => {
      assert.deepEqual(match?.wrecks, [seed]); rendered = true;
      return 'data:image/jpeg;base64,AQID';
    };
    const result = await game.tool('drone-1', 'observe');
    const text = result.content.filter(part => part.type === 'text').map(part => part.text).join('');
    assert.equal(rendered, true);
    assert.equal(text.includes('"wrecks":'), false);
    assert.equal(text.includes('21.23456789'), false, 'a physical smoke effect cannot become a coordinate locator');
  } finally { game.stop(); }
});
