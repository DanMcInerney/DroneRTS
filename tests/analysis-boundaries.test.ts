import test from 'node:test';
import assert from 'node:assert/strict';
import { extractObservationBoundaries } from '../scripts/analysis-boundaries.ts';

const wallTime = (milliseconds: number) => new Date(Date.UTC(2026, 8, 16) + milliseconds).toISOString();
const row = (milliseconds: number, value: Record<string, unknown>) => ({
  type: 'agent', wallTime: wallTime(milliseconds), value: { role: 'drone-1', ...value },
});
const observation = (sequence: number) => ({ protocol: 'fleet-observation/5', sensors: { sequence } });
const result = (body: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });

test('only the first next call consumes each observation, including calls returning errors', () => {
  const { deliveries, gaps } = extractObservationBoundaries([
    row(10, { type: 'tool-result', name: 'observe', result: result(observation(1)) }),
    row(20, { type: 'mcp-result', tool: 'observe' }),
    row(100, { type: 'tool', name: 'wait' }),
    row(110, { type: 'tool-result', name: 'wait', result: { ...result({ error: 'invalid field' }), isError: true } }),
    row(120, { type: 'mcp-result', tool: 'wait' }),
    row(200, { type: 'tool', name: 'wait' }),
    row(210, { type: 'tool-result', name: 'wait', result: result(observation(2)) }),
    row(220, { type: 'mcp-result', tool: 'wait' }),
    row(250, { type: 'tool', name: 'send', role: 'commander' }),
    row(300, { type: 'tool', name: 'act' }),
    row(310, { type: 'tool-result', name: 'act', result: result(observation(3)) }),
    row(320, { type: 'mcp-result', tool: 'act' }),
  ]);
  assert.equal(deliveries.length, 3); // The terminal observation has no next call.
  assert.deepEqual(gaps.map(gap => ({ sequence: gap.from.body.sensors.sequence, tool: gap.nextTool,
    milliseconds: gap.callMs - gap.from.completedMs! })), [
    { sequence: 1, tool: 'wait', milliseconds: 80 },
    { sequence: 2, tool: 'act', milliseconds: 80 },
  ]);
});

test('interleaved pilots and error-only native completions preserve their own delivery boundaries', () => {
  const extraTexts = ['not JSON', 'null', '[]', '123', JSON.stringify(observation(2))];
  const { deliveries, gaps } = extractObservationBoundaries([
    row(10, { type: 'tool-result', name: 'observe', result: result(observation(1)) }),
    row(20, { type: 'tool-result', role: 'drone-2', name: 'observe', result: result({ error: 'unavailable' }) }),
    row(30, { type: 'tool-result', role: 'drone-2', name: 'observe', result: { content: [
      ...extraTexts.map(text => ({ type: 'text', text })), { type: 'image', data: 'omitted' },
    ] } }),
    row(40, { type: 'mcp-result', role: 'drone-2', tool: 'observe' }),
    row(50, { type: 'mcp-result', role: 'drone-2', tool: 'observe' }),
    row(60, { type: 'tool', role: 'drone-2', name: 'act' }),
    row(70, { type: 'tool', name: 'send' }),
  ]);
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].completedMs, undefined);
  assert.equal(deliveries[1].completedMs, Date.parse(wallTime(50)));
  assert.equal(deliveries[1].textBytes, extraTexts.reduce((sum, text) => sum + Buffer.byteLength(text), 0));
  assert.equal(deliveries[1].imageCount, 1);
  assert.deepEqual(gaps.map(gap => [gap.role, gap.from.body.sensors.sequence, gap.nextTool]), [
    ['drone-2', 2, 'act'], ['drone-1', 1, 'send'],
  ]);
});
