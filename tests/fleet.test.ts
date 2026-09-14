import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FLEET, DRONE_IDS, validateRoster, fleetMember, isDroneId, droneAgentType, droneIdFromAgentType } from '../shared/fleet.ts';

test('fleet configuration owns immutable membership, presentation and wire identities', () => {
  assert.deepEqual(DRONE_IDS, ['drone-1', 'drone-2', 'drone-3']);
  const input = [{ id: 'drone-17', label: 'Scout', color: '#aaccee', systemId: 42 }];
  const roster = validateRoster(input);
  input[0].systemId = 7;
  assert.equal(fleetMember('drone-17', roster)?.systemId, 42);
  assert.equal(isDroneId('drone-17'), false);
  assert.equal(isDroneId('drone-17', roster), true);
  assert.equal(isDroneId('drone-1', roster), false);
  assert.equal(droneAgentType('drone-17'), 'drone_17');
  assert.equal(droneIdFromAgentType('drone_17', roster), 'drone-17');
  assert.equal(droneIdFromAgentType('drone_017', roster), undefined);
  assert.ok(Object.isFrozen(roster) && Object.isFrozen(roster[0]));
});

test('invalid fleet membership fails explicitly rather than using a default', () => {
  for (const input of [[], null, [DEFAULT_FLEET[0], DEFAULT_FLEET[0]],
    [{ ...DEFAULT_FLEET[0], id: 'drone-0' }], [{ ...DEFAULT_FLEET[0], id: 'drone-01' }],
    [{ ...DEFAULT_FLEET[0], id: 'drone-9007199254740992' }],
    [{ ...DEFAULT_FLEET[0], systemId: 255 }], [{ ...DEFAULT_FLEET[0], systemId: 1.5 }],
    [DEFAULT_FLEET[0], { ...DEFAULT_FLEET[1], systemId: 1 }],
    [{ ...DEFAULT_FLEET[0], color: 'url(script)' }]]) {
    assert.throws(() => validateRoster(input), /Fleet|fleet/);
  }
});
