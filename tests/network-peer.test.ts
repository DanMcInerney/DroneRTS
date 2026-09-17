import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import type { RadioMessage } from '../shared/types.ts';
import { DEFAULT_FLEET } from '../shared/fleet.ts';

const project = resolve(import.meta.dirname, '..');
const python = process.env.FLEET_PYTHON ?? resolve(project, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

async function eventually(predicate: () => boolean | Promise<boolean>, label: string, timeout = 12_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(40);
  }
  assert.fail(`Timed out: ${label}`);
}

/** This harness only writes user RPC requests. It never copies events between peers. */
class Worker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly events: any[] = [];
  readonly requests: string[] = [];
  readonly exited: Promise<void>;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private serial = 0;
  private stderr = '';
  private closed = false;

  constructor(args: string[], queueLimit?: number) {
    const entry = queueLimit === undefined ? [resolve(project, 'network/peer.py')]
      : [resolve(project, 'tests/fixtures/peer-small-queue.py'), String(queueLimit)];
    this.child = spawn(python, ['-u', ...entry, ...args], {
      cwd: project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
    });
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-5000); });
    this.child.stdin.on('error', () => {});
    createInterface({ input: this.child.stdout }).on('line', line => {
      let packet: any;
      try { packet = JSON.parse(line); }
      catch { this.events.push({ event: 'invalid-output', line }); return; }
      if (packet.event) this.events.push(packet);
      else {
        const pending = this.pending.get(packet.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(packet.id);
        if (packet.error) pending.reject(new Error(packet.error));
        else pending.resolve(packet.result);
      }
    });
    this.exited = new Promise(resolveExit => {
      const finish = () => {
        this.closed = true;
        for (const { timer, reject } of this.pending.values()) {
          clearTimeout(timer); reject(new Error(`Worker exited: ${this.stderr}`));
        }
        this.pending.clear(); resolveExit();
      };
      this.child.once('error', error => { this.stderr += error.message; finish(); });
      this.child.once('exit', finish);
    });
  }

  async start() {
    await eventually(() => {
      if (this.closed) throw new Error(`Startup failed: ${this.stderr}`);
      return this.events.some(event => event.event === 'ready');
    }, 'native peer ready');
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Worker is closed'));
    const id = ++this.serial;
    this.requests.push(method);
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`RPC timeout: ${method}. ${this.stderr}`));
      }, 12_000);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  received(id: string) { return this.events.filter(event => event.event === 'received' && event.message.id === id); }
  delivered(id: string, status = 'received') {
    return this.events.find(event => event.event === 'delivery' && event.id === id && event.status === status);
  }

  async stop(crash = false) {
    if (this.closed) return;
    if (crash) this.child.kill('SIGKILL');
    else {
      await this.request('stop').catch(() => {});
      this.child.stdin.end();
    }
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    await this.exited;
    clearTimeout(timer);
  }
}

async function fleet(t: { after: (callback: () => Promise<void>) => void }, withOperator = false, playerChat = false, queueLimit?: number) {
  const dir = await mkdtemp(resolve(tmpdir(), 'fleet-zenoh-test-'));
  const session = randomUUID();
  // Reserve all ports at once so the OS cannot assign the same port twice.
  const count = withOperator ? 4 : 3;
  const reservations = await Promise.all(Array.from({ length: count }, async () => {
    const server = createServer();
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    return server;
  }));
  const endpoints = reservations.map(server => `tcp/127.0.0.1:${(server.address() as { port: number }).port}`);
  await Promise.all(reservations.map(server => new Promise<void>(done => server.close(() => done()))));
  const args = (index: number) => ['--drone', index === 3 ? 'operator' : `drone-${index + 1}`, '--session', session,
    '--listen', endpoints[index], '--peers', endpoints.filter((_, i) => i !== index).join(','),
    '--store', resolve(dir, `drone-${index + 1}.sqlite`), '--roster', JSON.stringify(DEFAULT_FLEET), ...(playerChat ? ['--player-chat'] : [])];
  const workers = Array.from({ length: count }, (_, index) => new Worker(args(index), queueLimit));
  t.after(async () => {
    await Promise.all(workers.map(worker => worker.stop()));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await Promise.all(workers.map(worker => worker.start()));
  const connected = () => eventually(async () => (await Promise.all(workers.map(worker => worker.request('status'))))
    .every(status => status.online && status.peers === count - 1 && status.routers === 0), 'all direct native peer connections');
  await connected();
  let sequence = 0;
  const message = (from: string, to: string, text = 'Coordinate from my own observation'): RadioMessage => ({
    protocol: 'fleet-radio/1', sessionId: session, sequence: ++sequence, id: `${session}:${sequence}`,
    from, to, text, kind: 'radio', sentAt: new Date().toISOString(), mission: 1, simTime: 2,
  });
  const restart = async (index: number) => {
    await workers[index].stop(true);
    workers[index] = new Worker(args(index), queueLimit);
    await workers[index].start();
  };
  return { workers, message, connected, restart };
}

// Every scenario owns its ports, namespace, processes and temporary database.
describe('native peer transport', { concurrency: 2 }, () => {
test('three native Zenoh peers deliver group/direct over loopback TCP without parent forwarding', { timeout: 45_000 }, async t => {
  const { workers: [one, two, three], message } = await fleet(t);
  for (const worker of [one, two, three]) {
    const status = await worker.request('status');
    assert.equal(status.transport, 'zenoh-tcp-peer');
    assert.ok(status.links.length >= 2);
    for (const link of status.links) {
      assert.match(link.source, /^tcp\/127\.0\.0\.1:/);
      assert.match(link.destination, /^tcp\/127\.0\.0\.1:/);
      assert.equal(link.streamed, true);
    }
  }
  const group = message('drone-1', 'all');
  assert.deepEqual(await one.request('send', { message: group }), { queued: true, id: group.id });
  await eventually(() => two.received(group.id).length === 1 && three.received(group.id).length === 1 && !!one.delivered(group.id), 'group acknowledged by both recipients');
  assert.deepEqual(one.delivered(group.id).recipients, ['drone-2', 'drone-3']);
  const direct = message('drone-2', 'drone-1');
  await two.request('send', { message: direct });
  await eventually(() => one.received(direct.id).length === 1 && !!two.delivered(direct.id), 'direct acknowledged');
  await delay(350);
  assert.equal(one.received(group.id).length, 0);
  assert.equal(three.received(direct.id).length, 0);
  assert.equal(two.received(direct.id).length, 0);
  const { expiresAt, remainingTtlMs, networkId, bootId, senderSequence, trafficClass, ...directPayload } = one.received(direct.id)[0].message;
  assert.deepEqual(directPayload, direct);
  assert.equal(networkId, direct.sessionId); assert.match(bootId, /^[a-f\d-]{36}$/); assert.equal(senderSequence, 1, 'sequence belongs to this native sender, independent of caller/game sequence'); assert.equal(trafficClass, 'durable');
  assert.match(expiresAt, /^\d{4}-\d{2}-\d{2}T.+Z$/);
  assert.ok(Date.parse(expiresAt) > Date.now());
  assert.ok(remainingTtlMs > 0 && remainingTtlMs <= 120_000);
  assert.deepEqual(three.requests.filter(method => method !== 'status'), []);
  assert.equal([one, two, three].some(worker => worker.events.some(event => event.event === 'invalid-output')), false);
  await assert.rejects(one.request('send', { message: { ...group, from: 'drone-2' } }), /sender/);
  await assert.rejects(one.request('send', { message: { ...group, sessionId: randomUUID() } }), /session/);
  await assert.rejects(one.request('send', { message: { ...group, to: 'drone-1' } }), /Recipient/);
  await assert.rejects(one.request('send', { message: { ...group, text: 'Conflicting ID' } }), /different contents/);
});

test('blue operator participates in native group/direct chat and storage receipts do not replace objectives', { timeout: 45_000 }, async t => {
  const { workers: [one, two, three, operator], message } = await fleet(t, true, true);
  const group = { ...message('drone-1', 'all'), kind: 'chat' };
  await one.request('send', { message: group });
  await eventually(() => !!one.delivered(group.id), 'blue broadcast stored by teammates and player');
  assert.equal(operator.received(group.id).length, 1);
  assert.deepEqual(one.delivered(group.id).recipients, ['drone-2', 'drone-3', 'player']);
  const reply = { ...message('drone-2', 'player', 'I received your suggestion'), kind: 'chat' };
  await two.request('send', { message: reply });
  await eventually(() => !!two.delivered(reply.id), 'direct player reply stored');
  assert.equal(operator.received(reply.id).length, 1); assert.equal(one.received(reply.id).length, 0);
  const instruction = { ...message('player', 'drone-3', 'Please report your own status'), kind: 'chat' };
  await operator.request('send', { message: instruction });
  await eventually(() => !!operator.delivered(instruction.id), 'ordinary direct operator chat');
  assert.equal(three.received(instruction.id)[0].message.kind, 'chat');
  assert.equal(one.received(instruction.id).length, 0); assert.equal(two.received(instruction.id).length, 0);
  assert.ok(operator.events.some(event => event.event === 'delivery' && event.status === 'stored' && event.recipient === 'drone-3'));
  await assert.rejects(one.request('send', { message: { ...message('drone-1', 'all'), kind: 'mission' } }), /Only the operator/);
});

test('status messages queue independently while offline and unsent expired messages do not replay', { timeout: 45_000 }, async t => {
  const { workers: [one, two], message } = await fleet(t);
  await one.request('link', { online: false });
  const old = { ...message('drone-1', 'drone-2', 'Earlier own estimate'), kind: 'status' };
  const latest = { ...message('drone-1', 'drone-2', 'Latest own estimate'), kind: 'status' };
  await one.request('send', { message: old }); await one.request('send', { message: latest });
  assert.equal((await one.request('status')).pending, 2);
  await one.request('link', { online: true });
  await eventually(() => !!one.delivered(latest.id) && !!one.delivered(old.id), 'both status messages transmitted');
  assert.equal(two.received(old.id).length, 1); assert.equal(two.received(latest.id).length, 1);
  await one.request('link', { online: false });
  const expired = { ...message('drone-1', 'drone-2'), kind: 'status' };
  await one.request('send', { message: expired, ttlMs: 50 }); await delay(100);
  await one.request('link', { online: true }); await delay(500);
  assert.equal(two.received(expired.id).length, 0);
});

test('native full mailbox rejects before ACK, keeps unread mail and retries after explicit consumption', { timeout: 30_000 }, async t => {
  const capacity = 4;
  const { workers: [one, two], message } = await fleet(t, false, false, capacity);
  const ids: string[] = [];
  for (let index = 0; index < capacity; index++) {
    const item = message('drone-1', 'drone-2', `Unread bounded record ${index}`); ids.push(item.id);
    await one.request('send', { message: item });
  }
  await eventually(async () => (await two.request('status')).inbox === capacity && (await one.request('status')).pending === 0, 'recipient durable queue reaches bounded capacity');
  const blocked = message('drone-1', 'drone-2', 'Keep this in sender outbox until receiver has room');
  await one.request('send', { message: blocked });
  await eventually(() => one.events.some(event => event.event === 'backpressure' && event.id === blocked.id), 'native negative storage admission');
  assert.equal(two.received(blocked.id).length, 0); assert.equal(one.delivered(blocked.id), undefined);
  assert.equal((await one.request('status')).pendingRecipients, 1);
  assert.equal((await two.request('status')).inbox, capacity);
  await two.request('consume', { ids: [ids[0]] });
  await eventually(() => !!one.delivered(blocked.id), 'sender retries after explicitly freed receiver slot');
  assert.equal(two.received(blocked.id).length, 1);
  const status = await two.request('status');
  assert.equal(status.inbox, capacity); assert.ok(status.storageBytes <= 4 * 1024 * 1024); assert.ok(status.journalPeakBytes <= 256 * 1024);
});

test('partitioned peers persist outbound mail and retry group delivery with receiver deduplication', { timeout: 45_000 }, async t => {
  const { workers: [one, two, three], message, connected } = await fleet(t);
  assert.equal((await three.request('link', { online: false })).online, false);
  const group = message('drone-1', 'all');
  await one.request('send', { message: group, ttlMs: 20_000 });
  await eventually(async () => two.received(group.id).length === 1 && (await two.request('status')).duplicates >= 2, 'real repeated group packets suppressed');
  assert.equal((await one.request('status')).pendingRecipients, 1);
  assert.equal(three.received(group.id).length, 0);
  assert.equal(one.delivered(group.id), undefined);
  const queued = message('drone-3', 'drone-1');
  await three.request('send', { message: queued, ttlMs: 20_000 });
  assert.equal((await three.request('status')).pending, 1);
  await delay(350);
  assert.equal(one.received(queued.id).length, 0);
  await three.request('link', { online: true });
  await connected();
  await eventually(() => !!one.delivered(group.id) && !!three.delivered(queued.id), 'native reconnect drains both durable outboxes');
  assert.equal(three.received(group.id).length, 1);
  assert.equal(two.received(group.id).length, 1);
  assert.equal(one.received(queued.id).length, 1);
  assert.equal(two.received(queued.id).length, 0);
  assert.equal((await one.request('status')).pending, 0);
  assert.equal((await three.request('status')).pending, 0);
  assert.ok((await one.request('status')).retries >= 2);
});

test('expired outboxes never deliver after either endpoint reconnects', { timeout: 45_000 }, async t => {
  const { workers: [one, two, three], message, connected } = await fleet(t);
  await one.request('link', { online: false });
  const offlineSender = message('drone-1', 'drone-2');
  await one.request('send', { message: offlineSender, ttlMs: 180 });
  await eventually(() => !!one.delivered(offlineSender.id, 'expired'), 'sender-side expiry while offline');
  await one.request('link', { online: true });
  await connected();
  await three.request('link', { online: false });
  const offlineRecipient = message('drone-1', 'drone-3');
  await one.request('send', { message: offlineRecipient, ttlMs: 400 });
  await eventually(() => !!one.delivered(offlineRecipient.id, 'expired'), 'expiry after real unacknowledged publications');
  await three.request('link', { online: true });
  await connected();
  await delay(450);
  assert.equal(two.received(offlineSender.id).length, 0);
  assert.equal(three.received(offlineRecipient.id).length, 0);
  assert.equal((await one.request('status')).pending, 0);
  assert.equal(one.delivered(offlineSender.id, 'expired').receivedBy.length, 0);
});

test('committed unconsumed inbox survives abrupt restart and consumed mail stays consumed', { timeout: 45_000 }, async t => {
  const { workers, message, connected, restart } = await fleet(t);
  const durable = message('drone-1', 'drone-2');
  await workers[0].request('send', { message: durable, ttlMs: 1200 });
  await eventually(() => !!workers[0].delivered(durable.id), 'durable receipt before process kill');
  const originalReceived = workers[1].received(durable.id)[0].message;
  assert.ok(Date.parse(originalReceived.expiresAt) > Date.now());
  await delay(Math.max(0, Date.parse(originalReceived.expiresAt) - Date.now()) + 30);
  assert.equal((await workers[1].request('status')).inbox, 1, 'clock expiry retains accepted mail until consume');
  await restart(1);
  await eventually(() => workers[1].received(durable.id).length === 1, 'startup replay of unconsumed inbox');
  await connected();
  const { remainingTtlMs: replayTtl, ...replayed } = workers[1].received(durable.id)[0].message;
  const { remainingTtlMs: originalTtl, ...original } = originalReceived;
  assert.deepEqual(replayed, original); assert.equal(replayTtl, 0); assert.ok(originalTtl > 0);
  assert.ok(Date.parse(originalReceived.expiresAt) <= Date.now());
  assert.equal((await workers[1].request('status')).inbox, 1);
  assert.deepEqual(await workers[1].request('consume', { ids: [durable.id] }), { consumed: 1 });
  await restart(1);
  await connected();
  await delay(350);
  assert.equal(workers[1].received(durable.id).length, 0);
  assert.equal((await workers[1].request('status')).inbox, 0);
});

test('sender outbox survives abrupt restart and peer exits when stdin closes', { timeout: 45_000 }, async t => {
  const { workers, message, connected, restart } = await fleet(t);
  await workers[1].request('link', { online: false });
  const durable = message('drone-1', 'drone-2');
  await workers[0].request('send', { message: durable, ttlMs: 20_000 });
  await eventually(async () => (await workers[0].request('status')).txFrames > 0, 'native publication before sender kill');
  await restart(0);
  assert.equal((await workers[0].request('status')).pending, 1);
  await workers[1].request('link', { online: true });
  await connected();
  await eventually(() => !!workers[0].delivered(durable.id), 'recovered outbox acknowledged');
  assert.equal(workers[1].received(durable.id).length, 1);
  workers[2].child.stdin.end();
  await Promise.race([workers[2].exited, delay(4000, undefined, { ref: false }).then(() => assert.fail('stdin EOF did not stop the worker'))]);
  assert.equal(workers[2].child.exitCode, 0);
});

test('operator mission bridge obeys drone partitions and never receives drone group mail', { timeout: 45_000 }, async t => {
  const { workers: [one, two, three, operator], message, connected } = await fleet(t, true);
  await three.request('link', { online: false });
  const mission = { ...message('player', 'all', 'Inspect the landing areas'), kind: 'mission' };
  await operator.request('send', { message: mission, ttlMs: 20_000 });
  await eventually(() => one.received(mission.id).length === 1 && two.received(mission.id).length === 1, 'connected drones receive player mission over Zenoh');
  await delay(350);
  assert.equal(three.received(mission.id).length, 0);
  assert.equal(operator.delivered(mission.id), undefined);
  assert.equal((await operator.request('status')).pendingRecipients, 1);
  await three.request('link', { online: true });
  await connected();
  await eventually(() => !!operator.delivered(mission.id), 'partitioned drone receives queued mission');
  assert.equal(three.received(mission.id).length, 1);
  assert.deepEqual(operator.delivered(mission.id).recipients, ['drone-1', 'drone-2', 'drone-3']);
  const group = message('drone-1', 'all');
  await one.request('send', { message: group });
  await eventually(() => !!one.delivered(group.id), 'three drone group remains independent of operator');
  assert.deepEqual(one.delivered(group.id).recipients, ['drone-2', 'drone-3']);
  assert.equal(operator.received(group.id).length, 0);
  await assert.rejects(operator.request('send', { message: { ...mission, kind: 'radio' } }), /only broadcast player missions/);
  await assert.rejects(operator.request('send', { message: group }), /sender/);
  await assert.rejects(one.request('send', { message: mission }), /sender/);
});

test('consumed deduplication tombstones survive a restart while group retries continue', { timeout: 45_000 }, async t => {
  const { workers, message, restart } = await fleet(t);
  await workers[2].request('link', { online: false });
  const group = message('drone-1', 'all');
  await workers[0].request('send', { message: group, ttlMs: 20_000 });
  await eventually(() => workers[1].received(group.id).length === 1, 'first group delivery');
  assert.deepEqual(await workers[1].request('consume', { ids: [group.id] }), { consumed: 1 });
  await restart(1);
  await eventually(async () => (await workers[1].request('status')).duplicates >= 1, 'post-restart packet deduplicated using durable tombstone');
  assert.equal(workers[1].received(group.id).length, 0);
  assert.equal((await workers[1].request('status')).inbox, 0);
  // One real post-restart duplicate proves the persisted tombstone. Reconnect and
  // complete group delivery are already covered by the partition/retry scenario.
  assert.equal((await workers[0].request('status')).pendingRecipients, 1);
});
});
