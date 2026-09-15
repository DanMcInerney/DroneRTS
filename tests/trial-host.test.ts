import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, connect } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createTrialHost } from '../scripts/trial-host.ts';

test('trial shutdown closes unhandled upgrades, preserves its audit and releases its port without inference', { timeout: 15_000 }, async () => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(done => probe.close(() => done()));
  assert.notEqual(port, 4317); assert.notEqual(port, 4318);
  const directory = await mkdtemp(join(tmpdir(), 'fleet-trial-close-'));
  const host = await createTrialHost(resolve(import.meta.dirname, '..'), directory, 'match', port);
  const raw = connect(port, '127.0.0.1');
  const gameSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  let closing: Promise<void> | undefined;
  try {
    await once(gameSocket, 'message');
    assert.equal(host.game.state.running, false);
    assert.equal(host.game.state.runtime.status, 'idle');
    const response = await fetch(`http://127.0.0.1:${port}/api/cockpit/drone-2`);
    assert.match(response.headers.get('content-type')!, /application\/json/);
    const cockpit = await response.json();
    assert.equal(cockpit.protocol, 'fleet-cockpit/1');
    assert.equal(cockpit.droneId, 'drone-2');
    assert.equal(cockpit.sessionId, null);
    assert.equal(cockpit.lastDelivery, null);
    assert.equal(cockpit.workspace.available, false);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/cockpit/unknown`)).status, 404);
    host.game.emit('tool', { drone: 'drone-1', name: 'observe', args: {} });
    if (raw.connecting) await once(raw, 'connect');
    raw.write(`GET /unclaimed-upgrade HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    await delay(50); // Let the real HTTP server dispatch the deliberately unclaimed upgrade.
    const rawClosed = once(raw, 'close'), gameClosed = once(gameSocket, 'close');
    closing = host.close();
    assert.equal(host.close(), closing);
    const deadline = AbortSignal.timeout(3000);
    await Promise.race([
      Promise.all([closing, rawClosed, gameClosed]),
      new Promise((_, reject) => deadline.addEventListener('abort', () => reject(new Error('Trial cleanup stalled on an open upgrade')), { once: true })),
    ]);
    await host.close();
    probe.listen(port, '127.0.0.1'); await once(probe, 'listening');
    await new Promise<void>(done => probe.close(() => done()));
    assert.equal(host.game.state.running, false);
    const audit = JSON.parse((await readFile(join(directory, host.sessionId), 'utf8')).trim());
    assert.equal(audit.type, 'tool');
    assert.deepEqual(audit.value, { drone: 'drone-1', name: 'observe', args: {} });
  } finally {
    raw.destroy(); gameSocket.terminate();
    await (closing ?? host.close());
    const target = resolve(directory), parent = resolve(tmpdir());
    assert.ok(target.startsWith(parent + sep) && target !== parent);
    await rm(target, { recursive: true, force: true });
  }
});
