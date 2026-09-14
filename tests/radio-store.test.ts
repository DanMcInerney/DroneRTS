import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const project = resolve(import.meta.dirname, '..');
const venv = resolve(project, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = process.env.FLEET_PYTHON ?? (existsSync(venv) ? venv : process.platform === 'win32' ? 'python' : 'python3');
const execute = promisify(execFile);

async function scenario(source: string) {
  const program = `
import os, sqlite3, sys, tempfile, time
sys.path.insert(0, os.path.join(os.getcwd(), 'network'))
from peer_store import PeerStore, RADIO_BYTES, DATABASE_BYTES, TRANSACTION_BYTES, MAX_QUEUE, MAX_RECORDS, CONTROL_QUEUE, encode

def message(identifier, text='hello', sender='drone-1', kind='radio', sequence=1):
    return dict(id=identifier, text=text, **{'from': sender}, kind=kind, sequence=sequence,
                bootId='boot-one', senderSequence=sequence, sentAt='2026-09-14T20:00:00.000Z')

def rejected(operation, expected='storage-full'):
    try:
        operation()
        raise AssertionError('Expected rejection')
    except ValueError as error:
        assert expected in str(error), str(error)

with tempfile.TemporaryDirectory(prefix='rts-radio-store-') as directory:
    path = os.path.join(directory, 'peer.sqlite')
    store = PeerStore(path, 'drone-2', 'session-one')
    now = time.monotonic()
    try:
${source.split('\n').map(line => '        ' + line).join('\n')}
    finally:
        store.close()
print('verified')
`;
  const { stdout, stderr } = await execute(python, ['-c', program], {
    cwd: project, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  assert.equal(stdout.trim(), 'verified');
  assert.equal(stderr, '');
}

test('durable radio clears consumed payloads, preserves digest tombstones across restart and expires retry state', async () => {
  await scenario(`incoming = message('incoming')
assert store.accept(incoming, now + 100)
assert store.consume(['incoming', 'incoming']) == 1
row = store.db.execute("SELECT message,digest FROM inbox WHERE id='incoming'").fetchone()
assert row['message'] == '' and len(row['digest']) == 64
outgoing = message('outgoing', sender='drone-2')
store.queue(outgoing, ['drone-1', 'drone-3'], now + 100)
assert store.acknowledge('outgoing', 'drone-1', now) is None
assert store.status()['pendingRecipients'] == 1
assert store.acknowledge('outgoing', 'drone-3', now) == ['drone-1', 'drone-3']
assert store.db.execute("SELECT message FROM outbox WHERE id='outgoing'").fetchone()[0] == ''
store.close()
store = PeerStore(path, 'drone-2', 'session-one')
assert not store.accept(incoming, now + 100)
rejected(lambda: store.accept({**incoming, 'text': 'changed'}, now + 100), 'Conflicting')
store.queue(outgoing, ['drone-1', 'drone-3'], now + 100)
rejected(lambda: store.queue({**outgoing, 'text': 'changed'}, ['drone-1', 'drone-3'], now + 100), 'different contents')
assert store.status()['records'] == 2
assert store.status()['tombstones'] == 2
assert store.expire(now + 101) == []
assert store.status()['records'] == 0
rejected(lambda: PeerStore(path, 'drone-3', 'session-one'), 'another drone')`);
});

test('full unread mail rejects admission before receipt and preserves reserved objective capacity', async () => {
  await scenario(`for index in range(MAX_QUEUE):
    assert store.accept(message(str(index)), now + 100)
before = store.unconsumed()
rejected(lambda: store.accept(message('overflow'), now + 100))
rejected(lambda: store.accept(message('transfer', kind='transfer'), now + 100))
rejected(lambda: store.accept(message('fake-control', kind='mission'), now + 100))
assert store.unconsumed() == before
for index in range(CONTROL_QUEUE):
    assert store.accept(message('objective-' + str(index), sender='player', kind='mission'), now + 100)
rejected(lambda: store.accept(message('objective-overflow', sender='player', kind='mission'), now + 100))
store.expire(now + 101)
assert len(store.unconsumed()) == MAX_QUEUE + CONTROL_QUEUE
assert store.consume([item[0]['id'] for item in store.unconsumed()]) == MAX_QUEUE + CONTROL_QUEUE
store.expire(now + 101)
assert store.status()['records'] == 0`);
});

test('radio quotas count actual SQLite pages, Unicode bytes and bounded journal growth', async () => {
  await scenario(`payload = '\\U0001f680' * 3900
rejected(lambda: store.accept(message('too-large', '\\U0001f680' * 5000), now + 100))
accepted = 0
for index in range(MAX_QUEUE):
    try:
        store.accept(message(str(index), payload), now + 100)
        accepted += 1
    except ValueError as error:
        assert 'storage-full' in str(error)
        break
assert 100 < accepted < MAX_QUEUE, accepted
before = store.unconsumed()
rejected(lambda: store.accept(message('no-room', payload), now + 100))
assert store.unconsumed() == before
assert store.accept(message('objective', sender='player', kind='mission'), now + 100)
status = store.status()
actual = sum(os.path.getsize(os.path.join(directory, name)) for name in os.listdir(directory))
assert actual == status['storageBytes']
assert status['storageBytes'] <= RADIO_BYTES
assert os.path.getsize(path) <= DATABASE_BYTES
assert status['journalPeakBytes'] <= TRANSACTION_BYTES
assert status['journalPeakBytes'] > 0
assert not os.path.exists(path + '-wal')
assert not os.path.exists(path + '-shm')
assert not os.path.exists(path + '-journal')
store.consume([item[0]['id'] for item in store.unconsumed()])
store.expire(now + 101)
for index in range(30):
    body = message('reused-' + str(index), payload)
    assert store.accept(body, now + 200)
    assert store.consume([body['id']]) == 1
assert store.status()['storageBytes'] <= RADIO_BYTES
assert store.status()['journalPeakBytes'] <= TRANSACTION_BYTES
assert store.db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'`);
});

test('latest sender status coalesces, refuses reordered updates and does not replay stale status', async () => {
  await scenario(`first = message('status-one', kind='status', sequence=1)
second = message('status-two', kind='status', sequence=2)
third = message('status-three', kind='status', sequence=3)
assert store.accept(first, now + 100)
assert store.accept(third, now + 100)
assert not store.accept(second, now + 100)
assert [item[0]['id'] for item in store.unconsumed()] == ['status-three']
assert store.consume(['status-three']) == 1
assert store.db.execute("SELECT message FROM inbox WHERE id='status-three'").fetchone()[0] == ''
assert not store.accept(second, now + 100)
store.close()
store = PeerStore(path, 'drone-2', 'session-one')
assert not store.accept(second, now + 100)
store.queue(first, ['drone-3'], now + 100)
store.queue(third, ['drone-3'], now + 100)
store.queue(second, ['drone-3'], now + 100)
assert [row['id'] for row in store.due(now)] == ['status-three']
store.expire(now + 6)
assert store.unconsumed() == []
assert store.due(now + 6) == []
assert store.status()['records'] == 0`);
});

test('pending recipients retry independently with bounded backoff and transfer priority', async () => {
  await scenario(`store.queue(message('transfer', kind='transfer'), ['drone-1', 'drone-3'], now + 100)
store.queue(message('chat'), ['drone-1', 'drone-3'], now + 100)
store.queue(message('objective', sender='player', kind='mission'), ['drone-1'], now + 100)
assert [row['id'] for row in store.due(now)] == ['objective', 'chat', 'transfer']
assert store.acknowledge('chat', 'drone-1', now) is None
assert store.acknowledge('chat', 'drone-1', now) is None
assert store.acknowledge('chat', 'unknown', now) is None
assert store.status()['pendingRecipients'] == 4
store.attempted('chat', now)
assert 'chat' not in [row['id'] for row in store.due(now + 0.1)]
assert 'chat' in [row['id'] for row in store.due(now + 0.3)]
store.attempted('chat', now + 0.3)
assert 'chat' not in [row['id'] for row in store.due(now + 0.6)]
expired = store.expire(now + 101)
assert len(expired) == 3
chat = next(row for row in expired if row['id'] == 'chat')
assert chat['receipts'] == '["drone-1"]'
assert store.expire(now + 102) == []`);
});

test('failed SQLite allocation rolls back a status replacement without erasing its previous value', async () => {
  await scenario(`original = message('original-status', kind='status', sequence=1)
assert store.accept(original, now + 100)
page_count = store.db.execute('PRAGMA page_count').fetchone()[0]
store.db.execute('PRAGMA max_page_count=' + str(page_count))
replacement = message('replacement-status', text='x' * 15000, kind='status', sequence=2)
rejected(lambda: store.accept(replacement, now + 100))
assert [item[0]['id'] for item in store.unconsumed()] == ['original-status']
assert not store.accept(original, now + 100)
assert store.db.execute("SELECT COUNT(*) FROM inbox WHERE id='replacement-status'").fetchone()[0] == 0
assert store.db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
assert store.status()['storageBytes'] <= RADIO_BYTES
assert store.status()['journalPeakBytes'] <= TRANSACTION_BYTES`);
});

test('direct own status keeps independent pending destinations', async () => {
  await scenario(`one = {**message('to-one', sender='drone-2', kind='status', sequence=1), 'to': 'drone-1'}
three = {**message('to-three', sender='drone-2', kind='status', sequence=2), 'to': 'drone-3'}
latest = {**message('latest-one', sender='drone-2', kind='status', sequence=3), 'to': 'drone-1'}
store.queue(one, ['drone-1'], now + 5)
store.queue(three, ['drone-3'], now + 5)
store.queue(latest, ['drone-1'], now + 5)
assert [row['id'] for row in store.due(now)] == ['to-three', 'latest-one']
assert store.status()['pendingRecipients'] == 2`);
});

test('short-lived current status keeps its ordering watermark until older retries can no longer arrive', async () => {
  await scenario(`from unittest.mock import patch
with patch('peer_store.time.monotonic', return_value=now):
    first = message('first-long', kind='status', sequence=1)
    missing = message('unseen-middle', kind='status', sequence=2)
    latest = message('latest-short', kind='status', sequence=3)
    assert store.accept(first, now + 5)
    assert store.accept(latest, now + 0.2)
    assert store.consume(['latest-short']) == 1
    assert store.accept(message('unread-short', sender='drone-3', kind='status', sequence=3), now + 0.2)
    destination = {'to': 'drone-1', 'from': 'drone-2'}
    store.queue({**first, **destination}, ['drone-1'], now + 5)
    store.queue({**latest, **destination}, ['drone-1'], now + 0.2)
    expired = store.expire(now + 0.3)
    assert [row['id'] for row in expired] == ['latest-short']
    assert store.expire(now + 0.4) == []
    assert store.unconsumed() == []
    assert store.due(now + 0.3) == []
    for table in ['inbox', 'outbox']:
        head = store.db.execute('SELECT message,status_until FROM ' + table + ' WHERE id=?', ('latest-short',)).fetchone()
        assert head['message'] == ''
        assert head['status_until'] >= now + 5
    store.close()
    store = PeerStore(path, 'drone-2', 'session-one')
    assert not store.accept(missing, now + 5)
    assert not store.accept(message('unseen-other', sender='drone-3', kind='status', sequence=2), now + 5)
    store.queue({**missing, **destination}, ['drone-1'], now + 5)
    assert store.due(now + 0.3) == []
    assert store.unconsumed() == []
    # An independently addressed outgoing stream retains its own ordering.
    store.queue({**missing, **destination, 'id': 'other-destination', 'to': 'drone-3'}, ['drone-3'], now + 5)
    assert [row['id'] for row in store.due(now + 0.3)] == ['other-destination']
    store.expire(now + 6)
    assert store.status()['records'] == 0`);
});
