import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetGame } from '../server/game.ts';
import { compactObservation } from '../server/observation-format.ts';

test('model sensor format is smaller and losslessly preserves every sample, timestamp, null and coverage radius', async () => {
  const game = new FleetGame(); game.setConnected(true); game.start();
  game.capture = async () => 'data:image/jpeg;base64,AQID';
  try {
    const original = await game.tool('drone-1', 'observe');
    const compact = compactObservation(original);
    const source = JSON.parse(original.content.find(c => c.type === 'text')!.text);
    const value = JSON.parse(compact.content.find(c => c.type === 'text')!.text);
    assert.equal(value.protocol, 'fleet-observation/3');
    for (const path of ['sensors', 'currentTelemetry']) {
      const table = value[path].ranges.proximity;
      assert.equal(table.rows.length, 26);
      value[path].ranges.proximity = table.rows.map(([x,y,z,distance,validity,radius,maxDistance]: any[]) => ({
        direction: { x,y,z }, distance, validity, coverage: { shape: table.shape, radius, maxDistance },
      }));
    }
    value.protocol = source.protocol;
    assert.deepEqual(value, source);
    assert.deepEqual(compact.content.filter(c => c.type === 'image'), original.content.filter(c => c.type === 'image'));
    const originalBytes = Buffer.byteLength(JSON.stringify(original)), compactBytes = Buffer.byteLength(JSON.stringify(compact));
    assert.ok(compactBytes < originalBytes * 0.65, `${compactBytes}/${originalBytes}`);
  } finally { game.stop(); }
});
