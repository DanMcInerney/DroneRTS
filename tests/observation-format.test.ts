import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetGame } from '../server/game.ts';
import { compactObservation } from '../server/observation-format.ts';

const decode = (body: any) => {
  const value = structuredClone(body);
  if (value.currentTelemetry?.ranges?.proximity.sameAs === 'sensors.ranges.proximity') {
    value.currentTelemetry.ranges.proximity = structuredClone(value.sensors.ranges.proximity);
  }
  for (const path of ['sensors', 'currentTelemetry']) {
    const table = value[path]?.ranges?.proximity;
    if (!table?.directions) continue;
    const directions = table.directions === 'xyz26' ? [-1,0,1].flatMap(x => [-1,0,1].flatMap(y =>
      [-1,0,1].filter(z => x || y || z).map(z => { const n = Math.hypot(x,y,z); return [x/n,y/n,z/n]; }))) : table.directions;
    const at = (field: string, index: number) => Array.isArray(table[field]) ? table[field][index] : table[field];
    value[path].ranges.proximity = directions.map(([x,y,z]: number[], i: number) => ({
      direction: { x,y,z }, distance: at('distance', i), validity: at('validity', i),
      coverage: { shape: table.shape, radius: at('radius', i), maxDistance: at('maxDistance', i) },
    }));
  }
  value.protocol = 'fleet-observation/2';
  return value;
};

test('model sensor format is smaller and losslessly preserves every sample, timestamp, null and coverage radius', async () => {
  const game = new FleetGame(); game.setConnected(true); game.start();
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  try {
    const original = await game.tool('drone-1', 'observe');
    const compact = compactObservation(original);
    const source = JSON.parse(original.content.find(c => c.type === 'text')!.text);
    const value = JSON.parse(compact.content.find(c => c.type === 'text')!.text);
    assert.equal(value.protocol, 'fleet-observation/5');
    assert.equal(value.sensors.ranges.proximity.directions, 'xyz26');
    assert.deepEqual(value.currentTelemetry.ranges.proximity, { sameAs: 'sensors.ranges.proximity' });
    assert.notEqual(value.sensors.ranges.acquiredAtMs, value.currentTelemetry.ranges.acquiredAtMs);
    assert.deepEqual(decode(value), source);
    assert.deepEqual(compact.content.filter(c => c.type === 'image'), original.content.filter(c => c.type === 'image'));
    const originalBytes = Buffer.byteLength(JSON.stringify(original)), compactBytes = Buffer.byteLength(JSON.stringify(compact));
    assert.ok(compactBytes < originalBytes * 0.65, `${compactBytes}/${originalBytes}`);
  } finally { game.stop(); }
});

test('only exactly equal tables share within a bundle; changed returns, radii and unavailable sensing remain lossless', async t => {
  const game = new FleetGame(); game.setConnected(true); game.start(); t.after(() => game.stop());
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  const result = await game.tool('drone-1', 'observe');
  const source = JSON.parse(result.content.find(c => c.type === 'text')!.text);
  for (const change of ['distance', 'validity', 'radius', 'direction', 'maxDistance', 'extra', 'empty', 'no-current', 'no-ranges'] as const) {
    const body = structuredClone(source);
    const reading = body.currentTelemetry.ranges.proximity[0];
    if (change === 'distance') reading.distance = 0;
    if (change === 'validity') { reading.validity = 'unavailable'; reading.distance = null; }
    if (change === 'radius') reading.coverage.radius = .38000123456789;
    if (change === 'direction') reading.direction.x += .00000000000001;
    if (change === 'maxDistance') reading.coverage.maxDistance = 3.999999999999;
    if (change === 'extra') reading.calibration = { arbitraryFutureMetadata: true };
    if (change === 'empty') body.currentTelemetry.ranges.proximity = [];
    if (change === 'no-current') delete body.currentTelemetry;
    if (change === 'no-ranges') delete body.currentTelemetry.ranges;
    const input = { ...result, content: [{ type: 'text' as const, text: JSON.stringify(body) }, ...result.content.filter(c => c.type === 'image')] };
    const before = structuredClone(input), packed = compactObservation(input);
    const actual = JSON.parse(packed.content.find(c => c.type === 'text')!.text);
    assert.deepEqual(input, before, 'formatting does not mutate game evidence');
    assert.equal(actual.currentTelemetry?.ranges?.proximity?.sameAs, undefined);
    assert.deepEqual(decode(actual), body, change);
    assert.deepEqual(packed.content.filter(c => c.type === 'image'), input.content.filter(c => c.type === 'image'));
  }
  const again = compactObservation(result);
  assert.equal(JSON.parse(again.content.find(c => c.type === 'text')!.text).sensors.ranges.proximity.directions, 'xyz26',
    'every new result remains self-contained');
});
