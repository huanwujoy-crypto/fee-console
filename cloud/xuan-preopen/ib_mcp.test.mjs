import assert from 'node:assert/strict';
import test from 'node:test';
import { RESOURCE, validateCredential, loadReadCredential, IbReadSession } from './ib_mcp.mjs';

const credential = () => ({ client_id: 'test-client', access_token: 'test-access', refresh_token: 'test-refresh',
  token_type: 'Bearer', scope: 'mcp.read', resource: RESOURCE, expires_at: 1_000_000 });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status,
  headers: { 'content-type': 'application/json' } });

test('write scopes and alternate resources are rejected before network use', () => {
  for (const scope of ['mcp.write', 'mcp.read mcp.write', 'mcp.orders.submit'])
    assert.throws(() => validateCredential({ ...credential(), scope }), /READ_ONLY_CREDENTIAL_REQUIRED/);
  assert.throws(() => validateCredential({ ...credential(), resource: 'https://example.com' }), /READ_ONLY_CREDENTIAL_REQUIRED/);
});

test('rotated refresh token is saved and all refresh requests are scoped read-only', async () => {
  let saved;
  const loaded = await loadReadCredential({ load: async () => credential(), save: async value => { saved = value; } },
    { now: () => 950_000, fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.ibkr.com/oauth2/api/v1/token');
      assert.equal(options.redirect, 'error');
      assert.equal(options.body.get('scope'), 'mcp.read');
      assert.equal(options.body.get('resource'), RESOURCE);
      return response({ access_token: 'next-access', refresh_token: 'next-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'mcp.read' });
    } });
  assert.equal(saved.refresh_token, 'next-refresh');
  assert.equal(loaded.access_token, 'next-access');
  assert.equal(loaded.expires_at, 4_550_000);
});

test('a broader refresh response or unsaved rotation cannot continue', async () => {
  const store = { load: async () => credential(), save: async () => { throw new Error('private secret'); } };
  const options = { now: () => 950_000, fetchImpl: async () => response({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 }) };
  await assert.rejects(loadReadCredential(store, options), /^Error: IB_TOKEN_ROTATION_NOT_SAVED$/);
  await assert.rejects(loadReadCredential(store, { ...options, fetchImpl: async () => response({ access_token: 'a',
    token_type: 'Bearer', expires_in: 3600, scope: 'mcp.read mcp.write' }) }), /IB_REFRESH_SCOPE_INVALID/);
});

test('forbidden tools never reach the HTTP transport', async () => {
  let calls = 0;
  const session = new IbReadSession(credential(), { fetchImpl: async () => { calls++; return response({}); } });
  session.initialized = true;
  await assert.rejects(session.read('create_order_instruction'), /IB_MCP_TOOL_FORBIDDEN/);
  await assert.rejects(session.request('tools/call', { name: 'get_account_orders', arguments: { account: 'another' } }), /IB_MCP_TOOL_FORBIDDEN/);
  assert.equal(calls, 0);
});

test('real-time source HTTP failure hides upstream financial diagnostics', async () => {
  const session = new IbReadSession(credential(), { fetchImpl: async () => response({ error: 'test-private-value' }, 401) });
  session.initialized = true;
  await assert.rejects(session.read('get_account_orders'), /^Error: IB_REAUTHORIZE_REQUIRED$/);
});

test('trade transport requires explicit seven-day period and forbids default TODAY or account overrides', async () => {
  const requests = [];
  const session = new IbReadSession(credential(), { fetchImpl: async (_, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    return response({ jsonrpc: '2.0', id: request.id,
      result: { structuredContent: { trades: [] } } });
  } });
  session.initialized = true;
  for (const args of [{}, { period: 'TODAY' }, { period: 'DAYS_7', account: 'another' }])
    await assert.rejects(session.request('tools/call', { name: 'get_account_trades', arguments: args }), /TOOL_FORBIDDEN/);
  await session.read('get_account_trades');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].params.arguments, { period: 'DAYS_7' });
});

test('JSON and SSE handshakes preserve the server session ID', async () => {
  const requests = [];
  const session = new IbReadSession(credential(), { fetchImpl: async (_, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    if (request.method === 'initialize') return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: request.id,
      result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } } })}\n\n`,
      { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'test-session' } });
    assert.equal(options.headers['Mcp-Session-Id'], 'test-session');
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return response({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ orders: [] }) }] } });
  } });
  await session.initialize();
  const result = await session.read('get_account_orders');
  assert.equal(result.sourceKey, 'ib.orders');
  assert.deepEqual(result.raw, { orders: [] });
  assert.deepEqual(requests.map(value => value.method), ['initialize', 'notifications/initialized', 'tools/call']);
});
