import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { FleetMcpServer } from '../server/runtime-mcp.ts';
import { createDroneTools } from '../server/runtime-tools.ts';

test('real MCP connections discover unlocked tools, notify peers and reject guessed or retired capabilities', async () => {
  let shop = false, alive = true, gun = false, optics = false, jammer = false;
  const calls: Array<{ role: string; name: string }> = [];
  const server = new FleetMcpServer({ roles: ['drone-1', 'drone-2'], active: () => true,
    tools: role => createDroneTools(undefined, { shop, gun, optics, jammer, alive: role === 'drone-1' ? alive : true }),
    call: async (role, name) => { calls.push({ role, name }); return { content: [{ type: 'text', text: JSON.stringify({ ownObservation: role }) }] }; },
    policy: () => ({}), onEvent: () => {},
  });
  const endpoint = await server.start();
  const first = new Client({ name: 'drone-test-1', version: '1' });
  const peer = new Client({ name: 'drone-test-2', version: '1' });
  try {
    await first.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp/${endpoint.tokens['drone-1']}`)));
    await peer.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp/${endpoint.tokens['drone-2']}`)));
    assert.deepEqual((await first.listTools()).tools.map(tool => tool.name), ['observe', 'act', 'send', 'wait', 'recharge', 'route', 'workspace', 'routine', 'transfer', 'exchange']);
    const rejected = await first.callTool({ name: 'buy', arguments: { mission: 1, item: 'gun' } });
    assert.equal(rejected.isError, true);
    assert.deepEqual(calls, [{ role: 'drone-1', name: 'observe' }]);
    assert.match(JSON.stringify(rejected), /ownObservation/);
    let notify!: () => void;
    const notification = new Promise<void>(resolve => { notify = resolve; });
    peer.setNotificationHandler(ToolListChangedNotificationSchema, () => { notify(); });
    shop = true;
    await server.refreshTools();
    await Promise.race([notification, new Promise((_, reject) => setTimeout(() => reject(new Error('No tools/list_changed notification')), 3000).unref())]);
    assert.ok((await peer.listTools()).tools.some(tool => tool.name === 'buy'));
    await first.callTool({ name: 'buy', arguments: { mission: 1, item: 'gun' } });
    assert.deepEqual(calls.at(-1), { role: 'drone-1', name: 'buy' });
    gun = true; optics = true; jammer = true; await server.refreshTools();
    const equipped = (await first.listTools()).tools.map(tool => tool.name);
    for (const name of ['fire', 'rearm', 'camera']) assert.ok(equipped.includes(name));
    await first.callTool({ name: 'camera', arguments: { mission: 1, mode: 'zoom' } });
    assert.deepEqual(calls.at(-1), { role: 'drone-1', name: 'camera' });
    assert.equal((await first.callTool({ name: 'jam', arguments: { mission: 1, enabled: true } })).isError, true);
    assert.deepEqual(calls.at(-1), { role: 'drone-1', name: 'observe' });
    gun = false; optics = false; jammer = false; await server.refreshTools();
    const removed = (await first.listTools()).tools.map(tool => tool.name);
    for (const name of ['fire', 'rearm', 'camera', 'jam']) {
      assert.equal(removed.includes(name), false);
      assert.equal((await first.callTool({ name, arguments: { mission: 1 } })).isError, true);
      assert.equal(calls.at(-1)?.name, 'observe', 'revoked commands return only a fresh observation');
    }
    alive = false; await server.refreshTools();
    assert.deepEqual((await first.listTools()).tools, []);
    const previous = calls.length;
    assert.equal((await first.callTool({ name: 'observe' })).isError, true);
    assert.equal(calls.length, previous);
    assert.ok((await peer.listTools()).tools.length > 0);
  } finally { await Promise.allSettled([first.close(), peer.close()]); await server.stop(); }
});

test('MCP actor session IDs cannot be reused with another actor bearer URL', async () => {
  const server = new FleetMcpServer({ roles: ['drone-1', 'drone-2'], active: () => true, tools: () => createDroneTools(), call: async () => ({ content: [] }), policy: () => ({}), onEvent: () => {} });
  const endpoint = await server.start();
  const client = new Client({ name: 'isolation-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}/mcp/${endpoint.tokens['drone-1']}`));
  try {
    await client.connect(transport);
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/mcp/${endpoint.tokens['drone-2']}`, { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-session-id': transport.sessionId! }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }) });
    assert.equal(response.status, 404);
  } finally { await client.close(); await server.stop(); }
});
