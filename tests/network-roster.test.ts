import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FleetNetwork } from '../server/network.ts';
import { validateRoster } from '../shared/fleet.ts';
import type { DroneId, RadioMessage } from '../shared/types.ts';

const projectDir = resolve(import.meta.dirname, '..');
const roster = validateRoster([
  { id: 'drone-7', label: 'Scout', color: '#aaccee', systemId: 42 },
  { id: 'drone-11', label: 'Support', color: '#eeccee', systemId: 87 },
]);

async function eventually(predicate: () => boolean, label: string) {
  const end = Date.now() + 12_000;
  while (Date.now() < end) {
    if (predicate()) return;
    await delay(40);
  }
  assert.fail(`Timed out: ${label}`);
}

test('radio instances use supplied members and keep same-session team namespaces isolated', { timeout: 30_000 }, async t => {
  const sessionId = randomUUID();
  const failures: string[] = [];
  function domain() {
    const inbox: Array<{ recipient: DroneId; message: RadioMessage }> = [];
    const events: any[] = [];
    const networkId = randomUUID();
    const network = new FleetNetwork({ projectDir, sessionId, networkId, roster,
      onReceive: (recipient, message) => inbox.push({ recipient, message }),
      onState: () => {}, onEvent: event => events.push(event), onFailure: message => failures.push(message) });
    return { network, networkId, inbox, events };
  }
  // Overlapping actor IDs and the same game session intentionally make isolation
  // depend on the network domain, not on the contents of a player mission.
  const blue = domain(), red = domain();
  t.after(async () => {
    await Promise.all([blue.network.stop(), red.network.stop()]);
    await rm(resolve(projectDir, 'artifacts/network', sessionId), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await Promise.all([blue.network.start(), red.network.start()]);
  await eventually(() => [blue, red].every(({ network }) => network.state.peers.every(peer => peer.online && peer.peers === 2)), 'two independent native peer groups connected');
  assert.deepEqual(blue.network.state.peers.map(peer => peer.id), ['drone-7', 'drone-11']);
  let sequence = 0;
  const message = (from: string, to: string, text: string): RadioMessage => ({
    protocol: 'fleet-radio/1', sessionId, sequence: ++sequence, id: `${sessionId}:${sequence}`,
    from, to, text, kind: from === 'player' ? 'mission' : 'chat', sentAt: new Date().toISOString(), mission: 1, simTime: 0,
  });
  const blueMission = message('player', 'all', 'Blue mission');
  await blue.network.send(blueMission);
  await eventually(() => blue.inbox.length === 2, 'configured members receive their own mission');
  const redRadio = message('drone-7', 'all', 'Red local observation');
  await red.network.send(redRadio);
  await eventually(() => red.inbox.length === 1, 'custom peer ID broadcasts through real Zenoh');
  await delay(300);
  assert.ok(blue.inbox.every(item => item.message.id === blueMission.id));
  assert.deepEqual(red.inbox.map(item => [item.recipient, item.message.id]), [['drone-11', redRadio.id]]);
  for (const group of [blue, red]) {
    const payloads = group.events.filter(event => event.event === 'payload');
    assert.ok(payloads.length > 0);
    assert.ok(payloads.every(event => event.topic.startsWith(`fleet/${group.networkId}/`)));
  }
  assert.throws(() => blue.network.send(message('drone-1', 'all', 'Unknown sender')), /identity/);
  assert.throws(() => blue.network.send(message('drone-7', 'drone-1', 'Other domain')), /identity/);
  const worker = (blue.network as any).workers.get('drone-7');
  await assert.rejects(worker.request('send', { message: message('drone-7', 'drone-1', 'Bypass Node guard') }), /Recipient/);
  assert.deepEqual(failures, []);
});
