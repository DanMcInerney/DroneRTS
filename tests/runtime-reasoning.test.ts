import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeReasoning, REASONING_CONFIG, REASONING_CONFIG_TOML, REASONING_LIMITS, type ReasoningEvent } from '../server/runtime-reasoning.ts';

function fixture() {
  const events: ReasoningEvent[] = [];
  const capture = new RuntimeReasoning(event => events.push(event));
  const send = (method: string, params: Record<string, unknown>) => capture.accept(method, { threadId: 'thread', ...params });
  return { capture, events, send };
}
test('multipart reasoning is ordered and completed text replaces streaming drafts', () => {
  const { send, events } = fixture();
  send('item/started', { item: { type: 'reasoning', id: 'r' } });
  assert.equal(events.at(-1)!.availability, 'waiting');
  send('item/reasoning/textDelta', { itemId: 'r', contentIndex: 1, delta: 'second' });
  send('item/reasoning/textDelta', { itemId: 'r', contentIndex: 0, delta: 'fi' });
  send('item/reasoning/textDelta', { itemId: 'r', contentIndex: 0, delta: 'rst' });
  assert.equal(events.at(-1)!.text, 'first\nsecond');
  assert.equal(events.at(-1)!.delta, false);
  send('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'summary' });
  assert.equal(events.at(-1)!.availability, 'both');
  send('item/completed', { item: { type: 'reasoning', id: 'r', content: [{ text: 'final first' }, 'final second'], summary: ['final summary'] } });
  assert.equal(events.findLast(event => event.type === 'recorded-reasoning')!.text, 'final first\nfinal second');
  assert.equal(events.findLast(event => event.type === 'recorded-reasoning-summary')!.text, 'final summary');
  assert.equal(events.at(-1)!.streaming, false);
});
test('completion with empty fields retains streamed text and cannot decode opaque content', () => {
  const { send, events } = fixture();
  send('item/reasoning/textDelta', { itemId: 'r', delta: 'emitted text' });
  send('item/completed', { item: { type: 'reasoning', id: 'r', summary: [], content: [], encryptedContent: 'opaque-secret' } });
  assert.equal(events.find(event => event.type === 'recorded-reasoning')!.text, 'emitted text');
  send('item/completed', { item: { type: 'reasoning', id: 'opaque', summary: [{ text: { secret: 'nested-secret' } }], content: [], encrypted_content: 'opaque-secret' } });
  assert.equal(events.at(-1)!.availability, 'unavailable');
  assert.doesNotMatch(JSON.stringify(events), /opaque-secret|nested-secret|encrypted/);
});
test('summary-only responses identify their availability without inventing raw text', () => {
  const { send, events } = fixture();
  send('item/completed', { item: { type: 'reasoning', id: 's', summary: ['summary only'] } });
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'recorded-reasoning-summary');
  assert.equal(events[1].availability, 'summary');
});
test('interrupted items flush partial text once and identical item IDs remain thread-local', () => {
  const { capture, send, events } = fixture();
  send('item/reasoning/textDelta', { itemId: 'r', delta: 'first drone' });
  send('item/reasoning/textDelta', { threadId: 'other', itemId: 'r', delta: 'second drone' });
  capture.flush('thread'); capture.flush('thread');
  const first = events.filter(event => event.type === 'recorded-reasoning');
  assert.equal(first.length, 1); assert.equal(first[0].text, 'first drone'); assert.equal(first[0].incomplete, true);
  capture.flush();
  assert.equal(events.filter(event => event.type === 'recorded-reasoning').at(-1)!.text, 'second drone');
});
test('capture bounds malformed/large parts and flushes overflow items instead of growing indefinitely', () => {
  const { capture, send, events } = fixture();
  send('item/reasoning/textDelta', { itemId: 'large', contentIndex: -1, delta: 'negative' });
  send('item/reasoning/textDelta', { itemId: 'large', contentIndex: 10000, delta: 'out of range' });
  send('item/reasoning/textDelta', { itemId: 'large', delta: 'x'.repeat(REASONING_LIMITS.text * 2) });
  for (let index = 0; index < REASONING_LIMITS.items; index++) send('item/started', { item: { type: 'reasoning', id: String(index) } });
  const large = events.find(event => event.type === 'recorded-reasoning')!;
  assert.equal(large.incomplete, true); assert.match(large.text, /capture truncated/);
  assert.ok(large.text.length < REASONING_LIMITS.text + 100);
  assert.doesNotMatch(large.text, /negative|out of range/);
  capture.flush();
  assert.equal(events.filter(event => event.type === 'reasoning-availability' && !event.streaming).length, REASONING_LIMITS.items + 1);
});
test('native capture requests automatic summaries and emitted raw text explicitly', () => {
  assert.equal(REASONING_CONFIG.model_reasoning_summary, 'auto');
  assert.equal(REASONING_CONFIG.show_raw_agent_reasoning, true);
  assert.equal(REASONING_CONFIG.hide_agent_reasoning, false);
  assert.match(REASONING_CONFIG_TOML, /^model_reasoning_summary = "auto"\nshow_raw_agent_reasoning = true\nhide_agent_reasoning = false\n$/);
});
