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

async function scenario(source: string, timeout = 30_000) {
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
    cwd: project, windowsHide: true, timeout, maxBuffer: 1024 * 1024,
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

// This fixture commits every admitted row durably; it does not benchmark disk speed.
test('full unread mail rejects admission before receipt and preserves reserved objective capacity', { timeout: 120_000 }, async () => {
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
assert store.status()['records'] == 0`, 90_000);
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

test('received status messages persist in receipt order across expiry and restart until consumed', async () => {
  await scenario(`first = message('status-one', kind='status', sequence=1)
second = message('status-two', kind='status', sequence=2)
third = message('status-three', kind='status', sequence=3)
assert store.accept(first, now + 100)
assert store.accept(third, now + 100)
assert store.accept(second, now + 100)
assert [item[0]['id'] for item in store.unconsumed()] == ['status-one', 'status-three', 'status-two']
assert store.consume(['status-three']) == 1
assert not store.accept(second, now + 100)
store.close()
store = PeerStore(path, 'drone-2', 'session-one')
assert not store.accept(second, now + 100)
store.queue(first, ['drone-3'], now + 100)
store.queue(third, ['drone-3'], now + 100)
store.queue(second, ['drone-3'], now + 100)
assert [row['id'] for row in store.due(now)] == ['status-one', 'status-three', 'status-two']
store.expire(now + 101)
assert [item[0]['id'] for item in store.unconsumed()] == ['status-one', 'status-two']
assert store.due(now + 101) == []
assert store.consume(['status-one', 'status-two']) == 2
store.expire(now + 102)
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

test('failed SQLite allocation preserves all previously received messages', async () => {
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
assert [row['id'] for row in store.due(now)] == ['to-one', 'to-three', 'latest-one']
assert store.status()['pendingRecipients'] == 3`);
});

test('transmission expiry removes pending status copies without deleting received text', async () => {
  await scenario(`from unittest.mock import patch
first = message('first', kind='status', sequence=1)
latest = message('latest', kind='status', sequence=2)
# Admission and expiry share a fixture clock; durable writes need not finish in 200 ms.
with patch('peer_store.time.monotonic', return_value=now):
    assert store.accept(first, now + 5)
    assert store.accept(latest, now + 0.2)
    store.queue(first, ['drone-1'], now + 5)
    store.queue(latest, ['drone-1'], now + 0.2)
with patch('peer_store.time.monotonic', return_value=now + 0.3):
    rejected(lambda: store.queue(message('expired'), ['drone-1'], now + 0.2), 'deadline already expired')
assert [row['id'] for row in store.expire(now + 0.3)] == ['latest']
assert [row['id'] for row in store.due(now + 0.3)] == ['first']
assert [item[0]['id'] for item in store.unconsumed()] == ['first', 'latest']
store.expire(now + 6)
assert store.due(now + 6) == []
assert [item[0]['id'] for item in store.unconsumed()] == ['first', 'latest']
assert store.consume(['first', 'latest']) == 2
store.expire(now + 7)
assert store.status()['records'] == 0`);
});
