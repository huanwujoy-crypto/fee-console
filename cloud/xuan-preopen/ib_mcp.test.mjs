import assert from 'node:assert/strict';
import test from 'node:test';
import { RESOURCE, validateCredential, loadReadCredential, IbReadSession,captureCloudIbFull,captureCloudIbAction } from './ib_mcp.mjs';

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
  await assert.rejects(session.read('get_account_orders'), error => {
    assert.equal(error.message, 'IB_MCP_ACCESS_TOKEN_REJECTED');
    assert.deepEqual(error.diagnostic, { phase: 'mcp', httpStatus: 401, oauthError: 'not_applicable' });
    assert.ok(!JSON.stringify(error).includes('test-private-value'));
    return true;
  });
});

for (const [status, oauthError, code] of [
  [400, 'invalid_grant', 'IB_REFRESH_INVALID_GRANT'],
  [400, 'invalid_client', 'IB_REFRESH_CLIENT_REJECTED'],
  [400, 'unauthorized_client', 'IB_REFRESH_CLIENT_REJECTED'],
  [400, 'invalid_scope', 'IB_REFRESH_SCOPE_REJECTED'],
  [400, 'invalid_target', 'IB_REFRESH_SCOPE_REJECTED'],
  [400, 'invalid_request', 'IB_REFRESH_HTTP_FAILED'],
  [401, undefined, 'IB_REFRESH_HTTP_FAILED'],
  [429, undefined, 'IB_REFRESH_TRANSIENT_FAILED'],
  [500, 'invalid_grant', 'IB_REFRESH_TRANSIENT_FAILED'],
  [503, 'server_error', 'IB_REFRESH_TRANSIENT_FAILED'],
  [400, 'temporarily_unavailable', 'IB_REFRESH_TRANSIENT_FAILED'],
  [400, 'unknown-private-error', 'IB_REFRESH_HTTP_FAILED'],
]) test(`refresh ${status}/${oauthError || 'no OAuth category'} is classified without retry or persistence`, async () => {
  let fetches = 0, saves = 0;
  const store = { load: async () => credential(), save: async () => { saves++; } };
  await assert.rejects(loadReadCredential(store, { now: () => 950_000, fetchImpl: async () => {
    fetches++;
    return response({ error: oauthError, error_description: 'private-description', access_token: 'private-token' }, status);
  } }), error => {
    assert.equal(error.message, code);
    assert.deepEqual(error.diagnostic, { phase: 'refresh', httpStatus: status,
      oauthError: oauthError === undefined || oauthError === 'unknown-private-error' ? 'unknown' : oauthError });
    assert.ok(Object.isFrozen(error.diagnostic));
    assert.ok(!String(error).includes('private'));
    assert.ok(!JSON.stringify(error).includes('private'));
    return true;
  });
  assert.equal(fetches, 1);
  assert.equal(saves, 0);
});

test('malformed or oversized OAuth errors remain unknown and do not expose bodies', async () => {
  for (const body of ['private-invalid-json', JSON.stringify({ error: 'invalid_grant', error_description: 'private'.repeat(3000) })]) {
    await assert.rejects(loadReadCredential({ load: async () => credential(), save: async () => assert.fail('must not save') },
      { now: () => 950_000, fetchImpl: async () => new Response(body, { status: 400 }) }), error => {
      assert.equal(error.message, 'IB_REFRESH_HTTP_FAILED');
      assert.deepEqual(error.diagnostic, { phase: 'refresh', httpStatus: 400, oauthError: 'unknown' });
      assert.ok(!JSON.stringify(error).includes('private'));
      return true;
    });
  }
});

test('MCP forbidden and server failures are distinct and never trigger refresh', async () => {
  for (const [status, code] of [[403, 'IB_MCP_ACCESS_FORBIDDEN'], [503, 'IB_MCP_HTTP_FAILED']]) {
    let calls = 0;
    const session = new IbReadSession(credential(), { fetchImpl: async url => {
      assert.equal(url, RESOURCE); calls++;
      return response({ error: 'private-financial-data' }, status);
    } });
    session.initialized = true;
    await assert.rejects(session.read('get_account_orders'), error => {
      assert.equal(error.message, code);
      assert.deepEqual(error.diagnostic, { phase: 'mcp', httpStatus: status, oauthError: 'not_applicable' });
      assert.ok(!JSON.stringify(error).includes('private'));
      return true;
    });
    assert.equal(calls, 1);
  }
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
test('full capture reads five fixed tools after at most one saved read-only refresh; legacy capture stays three',async()=>{
 for(const [capture,count]of [[captureCloudIbFull,5],[captureCloudIbAction,3]]){let refresh=0,saves=0;const tools=[];const fetchImpl=async(url,options)=>{if(url.includes('/token')){refresh++;return response({access_token:'next',token_type:'Bearer',expires_in:3600,scope:'mcp.read'});}const q=JSON.parse(options.body);if(q.method==='initialize')return response({jsonrpc:'2.0',id:q.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}}}});if(q.method==='notifications/initialized')return new Response(null,{status:202});tools.push(q.params);const data={get_account_summary:{currency:'USD',net_liquidation:100,total_cash_value:100},get_account_positions:{positions:[]},get_account_orders:{orders:[]},get_account_balances:{balances:[]},get_account_trades:{trades:[]}}[q.params.name];return response({jsonrpc:'2.0',id:q.id,result:{content:[{type:'text',text:JSON.stringify(data)}]}});};const r=await capture({load:async()=>credential(),save:async()=>{saves++;}},{now:()=>950000,fetchImpl});assert.equal(r.sources.length,count);assert.equal(refresh,1);assert.equal(saves,1);assert.equal(tools.length,count);for(const t of tools)assert.deepEqual(t.arguments,t.name==='get_account_trades'?{period:'DAYS_7'}:{});}
});
test('trade defaults and alternate periods/account arguments cannot bypass the fixed full capture',async()=>{let calls=0;const s=new IbReadSession(credential(),{fetchImpl:async()=>{calls++;}});s.initialized=true;for(const args of [{},{period:'TODAY'},{period:'DAYS_7',account:'other'}])await assert.rejects(s.request('tools/call',{name:'get_account_trades',arguments:args}),/FORBIDDEN/);assert.equal(calls,0);});
