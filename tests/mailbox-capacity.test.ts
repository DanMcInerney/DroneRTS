import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../server/mailbox.ts';
import { OnboardWorkspace } from '../server/onboard-workspace.ts';

test('bounded bundles preserve undispatched mail for the next actual boundary', () => {
  const box = new Mailbox();
  for (let i = 0; i < 80; i++) box.push({ type: 'radio', mission: 1, message: { id: i, text: 'x'.repeat(4096) } });
  const delivered: unknown[] = [];
  let result = box.drain();
  assert.equal(result.hasMore, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result.events)) < 129 * 1024);
  delivered.push(...result.events.map(event => (event.message as { id: number }).id));
  while (result.hasMore) { result = box.drain(); delivered.push(...result.events.map(event => (event.message as { id: number }).id)); }
  assert.deepEqual(delivered, Array.from({ length: 80 }, (_, i) => i));
});
test('local unread events and rotating diagnostics share one MiB and overflow preserves unread events', () => {
  const box = new Mailbox(), workspace = new OnboardWorkspace({ eventBytes: () => box.localBytes });
  let overflows = 0; box.onOverflow = partition => { assert.equal(partition, 'events'); overflows++; };
  for (let i = 0; i < 100; i++) { box.push({ type: 'job', mission: 1, text: 'x'.repeat(16 * 1024), serial: i }); workspace.appendLog({ diagnostic: 'y'.repeat(8000) }); }
  assert.equal(overflows, 1);
  assert.ok(box.localBytes <= 512 * 1024);
  assert.ok(workspace.status().logs.usedBytes <= 1024 ** 2);
  assert.ok(workspace.status().logs.usedBytes > box.localBytes);
  const pending = box.events.map(event => event.serial);
  const delivered: unknown[] = []; let more = true;
  while (more) { const result = box.drain(); more = result.hasMore; delivered.push(...result.events.map(event => event.serial)); }
  assert.deepEqual(delivered, pending);
  assert.equal(box.localBytes, 0);
});
