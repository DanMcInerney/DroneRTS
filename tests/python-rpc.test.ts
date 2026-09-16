import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { PythonRpc } from '../server/python-rpc.ts';

test('native sample cancellation releases its request and ignores late replies while another sample completes', async () => {
  const rpc = new PythonRpc('unused'), internal = rpc as any, requests: any[] = [];
  internal.child = { killed: false, stdin: { write: (text: string) => requests.push(JSON.parse(text)) } };
  const controller = new AbortController();
  const abandoned = rpc.request('sample', { drone: 'drone-1' }, 10000, controller.signal);
  const peer = rpc.request('sample', { drone: 'drone-2' });
  controller.abort(new Error('turn ended')); await assert.rejects(abandoned, /turn ended/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(internal.pending.size, 1);
  internal.receive({ id: requests[0].id, result: 'late' });
  internal.receive({ id: requests[1].id, result: 'peer' });
  assert.equal(await peer, 'peer'); assert.equal(internal.pending.size, 0);
});
