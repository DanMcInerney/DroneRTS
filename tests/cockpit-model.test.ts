import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COCKPIT_EVENT_LIMIT, mergeCockpitEvents, outgoingSendAttempts, outputRows } from '../client/cockpit-model.ts';
import type { CockpitEvent } from '../shared/cockpit.ts';

const event = (sequence: number, extra: Partial<CockpitEvent> = {}): CockpitEvent => ({ sequence, at: '2026-09-14T12:00:00Z', kind: 'call', name: 'observe', ...extra });

test('radio outbox includes standalone and every batched send with original call and operation provenance', () => {
  const direct = { to: 'all', kind: 'status', text: 'Online.' };
  const first = { to: ['drone-2', 'drone-3'], kind: 'chat', text: 'A visible apron.' };
  const second = { to: 'drone-3', kind: 'chat', text: 'My observed cargo is empty.' };
  const events = [event(1, { name: 'send', data: { arguments: direct } }), event(2, { name: 'exchange', data: { arguments: {
    command_id: 'c2', operations: [{ id: 'look', tool: 'act', args: { kind: 'look' } },
      { id: 'mail-a', tool: 'send', args: first }, { id: 'mail-b', tool: 'send', args: second }],
  } } }), event(3, { kind: 'result', name: 'exchange', data: { rejected: true } })];
  assert.deepEqual(outgoingSendAttempts(events), [
    { sequence: 1, at: events[0].at, arguments: direct, source: { tool: 'send' } },
    { sequence: 2, at: events[1].at, arguments: first, source: { tool: 'exchange', commandId: 'c2', operationIndex: 2, operationId: 'mail-a' } },
    { sequence: 2, at: events[1].at, arguments: second, source: { tool: 'exchange', commandId: 'c2', operationIndex: 3, operationId: 'mail-b' } },
  ]);
  assert.equal(events[1].name, 'exchange');
});

test('radio outbox ignores non-call evidence and malformed batches while retaining historical argument wrappers', () => {
  const args = { to: 'all', text: 'Historical send.' };
  const sends = outgoingSendAttempts([
    event(1, { name: 'send', data: { args } }), event(2, { name: 'send', data: args }),
    event(3, { kind: 'result', name: 'send', data: { arguments: args } }),
    event(4, { name: 'observe', data: { operations: [{ tool: 'send', args }] } }),
    event(5, { name: 'exchange', data: { arguments: { operations: 'omitted' } } }),
    event(6, { name: 'exchange', data: { arguments: { operations: [null, 1, {}, { tool: 'observe' }, { tool: 'send', args }] } } }),
    event(7, { name: 'exchange' }),
  ]);
  assert.deepEqual(sends.map(send => send.sequence), [1, 2, 6]);
  assert.ok(sends.every(send => send.arguments === args));
  assert.deepEqual(sends[2].source, { tool: 'exchange', operationIndex: 5 });
});

test('cockpit retry windows deduplicate sequence IDs and retain newest bounded evidence', () => {
  const previous = Array.from({ length: COCKPIT_EVENT_LIMIT }, (_, index) => event(index));
  const merged = mergeCockpitEvents(previous, [event(COCKPIT_EVENT_LIMIT), event(5), event(COCKPIT_EVENT_LIMIT + 1)]);
  assert.equal(merged.events.length, COCKPIT_EVENT_LIMIT);
  assert.equal(merged.events[0].sequence, 2);
  assert.equal(merged.events.at(-1)?.sequence, COCKPIT_EVENT_LIMIT + 1);
  assert.equal(merged.trimmed, true);
});

test('stream completion replaces cumulative output without losing intervening tool events', () => {
  const input = [event(1, { kind: 'output', itemId: 'a', delta: false, text: 'Hel' }), event(2), event(3, { kind: 'output', itemId: 'a', delta: false, text: 'Hello' })];
  const result = outputRows(input);
  assert.equal(result.length, 2);
  assert.equal(result[0].text, 'Hello');
  assert.equal(result[1].sequence, 2);
  assert.equal(input[0].text, 'Hel');
});

test('incremental output appends until completion and isolates different reasoning items', () => {
  const result = outputRows([
    event(1, { kind: 'output', itemId: 'shared-id', delta: true, text: 'A' }),
    event(2, { kind: 'summary', itemId: 'shared-id', delta: true, text: 'Summary' }),
    event(3, { kind: 'output', itemId: 'shared-id', delta: true, text: 'B' }),
    event(4, { kind: 'output', itemId: 'shared-id', delta: false, text: 'Complete' }),
  ]);
  assert.deepEqual(result.map(row => row.text), ['Complete', 'Summary']);
});

test('native reasoning replaces cumulative text while carrying streaming completion state', () => {
  const start = event(1, { kind: 'reasoning', itemId: 'r1', delta: false, streaming: true, text: 'Inspect' });
  const update = event(2, { kind: 'reasoning', itemId: 'r1', delta: false, streaming: true, text: 'Inspect the observation.' });
  const live = outputRows([start, update]);
  assert.equal(live.length, 1);
  assert.equal(live[0].text, 'Inspect the observation.');
  assert.equal(live[0].streaming, true);
  assert.equal(live[0].delta, false);
  const done = event(3, { kind: 'reasoning', itemId: 'r1', delta: false, streaming: false, text: 'Inspect the observation, then wait.' });
  const completed = outputRows([start, update, done]);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].text, done.text);
  assert.equal(completed[0].streaming, false);
  assert.equal(start.text, 'Inspect');
  assert.equal(update.streaming, true);
});

test('same native item keeps reasoning, summary, availability and output in separate rows', () => {
  const input = [
    event(1, { kind: 'reasoning', itemId: 'r1', text: 'Readable runtime text', streaming: true }),
    event(2, { kind: 'summary', itemId: 'r1', text: 'Brief summary', streaming: false }),
    event(3, { kind: 'reasoning-status', itemId: 'r1', text: 'Awaiting readable text', data: { readable: false } }),
    event(4, { kind: 'output', itemId: 'r1', text: 'Agent message', streaming: false }),
    event(5, { kind: 'reasoning-status', itemId: 'r1', text: 'Readable text recorded', streaming: false, data: { readable: true } }),
    event(6, { kind: 'reasoning', itemId: 'r2', text: 'A separate item', streaming: true }),
  ];
  const rows = outputRows(input);
  assert.deepEqual(rows.map(row => row.kind), ['reasoning', 'summary', 'reasoning-status', 'output', 'reasoning']);
  assert.equal(rows[2].text, 'Readable text recorded');
  assert.deepEqual(rows[2].data, { readable: true });
  assert.equal(rows[2].streaming, false);
  assert.deepEqual(input[2].data, { readable: false });
});

test('reasoning events without native item IDs remain independent evidence', () => {
  const rows = outputRows([
    event(1, { kind: 'reasoning', text: 'First record' }),
    event(2, { kind: 'reasoning', text: 'Second record' }),
    event(3, { kind: 'reasoning-status', text: 'Availability record' }),
  ]);
  assert.deepEqual(rows.map(row => row.text), ['First record', 'Second record', 'Availability record']);
});
