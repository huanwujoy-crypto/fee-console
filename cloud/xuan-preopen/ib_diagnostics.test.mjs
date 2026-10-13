import test from 'node:test';
import assert from 'node:assert/strict';
import {ibError, safeIbFailure, bearerError} from './ib_diagnostics.mjs';
import {loadReadCredential, IbReadSession, IbOrdersDiagnosticSession, RESOURCE} from './ib_mcp.mjs';

const canary = 'PRIVATE_DIAGNOSTIC_CANARY_928471';
const credential = () => ({client_id: 'synthetic-client', access_token: canary, refresh_token: canary,
  token_type: 'Bearer', scope: 'mcp.read', resource: RESOURCE, expires_at: 1_000_000});
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value),
  {status, headers: {'content-type': 'application/json', ...headers}});
async function failure(operation) {
  try { await operation(); assert.fail('Expected fixed diagnostic failure'); }
  catch (error) { return safeIbFailure(error); }
}
function noLeak(value) { assert.equal(JSON.stringify(value).includes(canary), false); }

test('serializer rejects arbitrary uppercase messages, forged details and raw error members', () => {
  const error = new Error(canary); error.diagnostic = {phase: canary, category: canary, httpStatus: 401};
  error.cause = {access_token: canary}; error.body = canary; error.stack = canary;
  const out = safeIbFailure(error, {execution: canary, dataDate: '2026-02-30', sourceDate: canary});
  assert.deepEqual(out, {status: 'failed', code: 'IB_DIAGNOSTIC_FAILED', phase: 'unknown',
    category: 'unknown', httpStatus: null, publication: 'none'}); noLeak(out);
  const typed = safeIbFailure(ibError('IB_MCP_HTTP_FAILED', {phase: 'mcp_orders_read', category: 'service_error', httpStatus: 503}));
  assert.equal(typed.httpStatus, 503); assert.equal(typed.phase, 'mcp_orders_read');
});

for (const [status, error, category] of [[400, 'invalid_grant', 'invalid_grant'], [400, 'invalid_client', 'invalid_client'],
  [400, 'invalid_scope', 'invalid_scope'], [401, canary, 'authentication_rejected'], [403, canary, 'permission_denied'],
  [429, canary, 'rate_limited'], [500, canary, 'service_error'], [503, canary, 'service_error']]) {
  test(`refresh HTTP ${status}/${category} is bounded, distinct and never proves expiry`, async () => {
    let calls = 0, saves = 0;
    const out = await failure(() => loadReadCredential({load: async () => credential(), save: async () => {saves++;}},
      {now: () => 950000, fetchImpl: async () => {calls++; return response({error, error_description: canary}, status);}}));
    assert.equal(out.code, 'IB_REFRESH_HTTP_FAILED'); assert.equal(out.phase, 'oauth_refresh');
    assert.equal(out.httpStatus, status); assert.equal(out.category, category);
    assert.equal(calls, 1); assert.equal(saves, 0); noLeak(out);
  });
}

test('unknown, oversized, invalid-UTF8 and malformed OAuth bodies disclose only status/category', async () => {
  for (const make of [() => new Response('not json '+canary, {status: 400}),
    () => response({error: canary, padding: canary.repeat(1000)}, 400),
    () => new Response(Uint8Array.from([0xff, 0xfe]), {status: 400}),
    () => response({error: {secret: canary}}, 400)]) {
    const out = await failure(() => loadReadCredential({load: async () => credential(), save: async () => assert.fail('No rotation')},
      {now: () => 950000, fetchImpl: async () => make()}));
    assert.equal(out.category, 'http_error'); assert.equal(out.httpStatus, 400); noLeak(out);
  }
});

test('refresh needs explicit permission and save capability before token submission', async () => {
  let calls = 0;
  const options = {now: () => 950000, fetchImpl: async () => {calls++;}};
  assert.equal((await failure(() => loadReadCredential({load: async () => credential(), save: async () => {}},
    {...options, allowRefresh: false}))).code, 'IB_REFRESH_NOT_AUTHORIZED');
  assert.equal((await failure(() => loadReadCredential({load: async () => credential()}, options))).code, 'IB_TOKEN_ROTATION_NOT_SAVED');
  assert.equal(calls, 0);
});

test('malformed success responses cannot save credentials or echo private values', async () => {
  for (const value of [null, {}, {access_token: canary, token_type: 42, expires_in: 3600},
    {access_token: canary, token_type: 'Bearer', expires_in: 3600, refresh_token: null},
    {access_token: canary, token_type: 'Bearer', expires_in: 3600, scope: 'mcp.write'}]) {
    let saves = 0;
    const out = await failure(() => loadReadCredential({load: async () => credential(), save: async () => {saves++;}},
      {now: () => 950000, fetchImpl: async () => response(value)}));
    assert.equal(out.code, 'IB_REFRESH_SCOPE_INVALID'); assert.equal(out.phase, 'oauth_refresh'); assert.equal(saves, 0); noLeak(out);
  }
});

test('network and timeout errors retain phase without copying cause/stack', async () => {
  for (const [name, category] of [['TypeError', 'network'], ['TimeoutError', 'timeout'], ['AbortError', 'timeout']]) {
    const upstream = new Error(canary); upstream.name = name; upstream.cause = canary;
    const out = await failure(() => loadReadCredential({load: async () => credential(), save: async () => {}},
      {now: () => 950000, fetchImpl: async () => {throw upstream;}}));
    assert.equal(out.category, category); assert.equal(out.phase, 'oauth_refresh'); noLeak(out);
  }
});

test('credential-store denial and rotation-save ambiguity retain their own phase', async () => {
  const denied = await failure(() => loadReadCredential({load: async () => {throw new Error('CLOUD_HTTP_403');}}));
  assert.equal(denied.phase, 'credential_load'); assert.equal(denied.httpStatus, 403);
  for (const [message, category, status] of [['CLOUD_HTTP_403', 'save_failed', 403], [canary, 'save_outcome_unknown', null]]) {
    let calls = 0, saves = 0;
    const out = await failure(() => loadReadCredential({load: async () => credential(), save: async () => {saves++; throw new Error(message);}},
      {now: () => 950000, fetchImpl: async () => {calls++; return response({access_token: canary, refresh_token: canary,
        token_type: 'Bearer', expires_in: 3600, scope: 'mcp.read'});}}));
    assert.equal(out.phase, 'credential_save'); assert.equal(out.category, category); assert.equal(out.httpStatus, status);
    assert.equal(calls, 1); assert.equal(saves, 1); noLeak(out);
  }
});

for (const [method, phase] of [['initialize', 'mcp_initialize'], ['notifications/initialized', 'mcp_initialized'],
  ['tools/list', 'mcp_tools_list'], ['tools/call', 'mcp_orders_read']]) {
  for (const [status, code, category] of [[401, 'IB_MCP_AUTHENTICATION_REJECTED', 'invalid_token'],
    [403, 'IB_MCP_PERMISSION_DENIED', 'insufficient_scope']]) {
    test(`${method} ${status} retains exact stage and safe Bearer category without retry`, async () => {
      let calls = 0;
      const session = new IbOrdersDiagnosticSession(credential(), {fetchImpl: async () => {
        calls++; return response({error: canary}, status, {'www-authenticate': `Bearer error="${category}", error_description="${canary}"`});
      }}); session.initialized = true;
      const params = method === 'tools/call' ? {name: 'get_account_orders', arguments: {}} : method === 'tools/list' ? {} : undefined;
      const out = await failure(() => session.request(method, params, method === 'notifications/initialized'));
      assert.equal(out.phase, phase); assert.equal(out.httpStatus, status); assert.equal(out.category, category);
      assert.equal(out.code, code); assert.equal(calls, 1); noLeak(out);
    });
  }
}

test('production method/tool whitelist stays fixed while diagnostic session forbids extra financial tools', async () => {
  let calls = 0; const options = {fetchImpl: async () => {calls++;}};
  const normal = new IbReadSession(credential(), options); normal.initialized = true;
  assert.equal((await failure(() => normal.request('tools/list', {}))).code, 'IB_MCP_METHOD_FORBIDDEN');
  const diagnostic = new IbOrdersDiagnosticSession(credential(), options); diagnostic.initialized = true;
  for (const tool of ['get_account_summary', 'get_account_positions', 'create_order_instruction'])
    assert.equal((await failure(() => diagnostic.read(tool))).code, 'IB_MCP_TOOL_FORBIDDEN');
  assert.equal((await failure(() => diagnostic.request('tools/call', {name: 'get_account_orders', arguments: {account: canary}}))).code, 'IB_MCP_TOOL_FORBIDDEN');
  assert.equal(calls, 0);
});

test('RPC/SSE/wrapper failures remain static with phase and never expose tool messages', async () => {
  const cases = [q => response({jsonrpc: '2.0', id: q.id, error: {code: -32602, message: canary}}),
    () => new Response('data: {invalid '+canary+'}\n\n', {headers: {'content-type': 'text/event-stream'}}),
    q => new Response(`data: ${JSON.stringify({jsonrpc: '2.0', id: q.id, result: {}})}\n\ndata: ${JSON.stringify({jsonrpc: '2.0', id: q.id, result: {}})}\n\n`, {headers: {'content-type': 'text/event-stream'}}),
    q => response({jsonrpc: '2.0', id: q.id, result: {isError: true, content: [{type: 'text', text: canary}]}}),
    q => response({jsonrpc: '2.0', id: q.id, result: {content: [{type: 'text', text: canary}]}})];
  for (const make of cases) {
    const session = new IbReadSession(credential(), {fetchImpl: async (_, options) => make(JSON.parse(options.body))}); session.initialized = true;
    const out = await failure(() => session.read('get_account_orders'));
    assert.equal(out.phase, 'mcp_orders_read'); noLeak(out);
  }
});

test('Bearer parser permits only one exact standard error enum, not arbitrary challenges', () => {
  for (const header of [`Bearer error="${canary}"`, 'Basic error="invalid_token"',
    'Bearer error="invalid_token", error="insufficient_scope"', 'Bearer '+canary.repeat(1000)])
    assert.equal(bearerError(new Headers({'www-authenticate': header})), null);
});

test('MCP malformed UTF8 and excessive transport are bounded before source decoding', async () => {
  for (const make of [() => new Response(Uint8Array.from([255, 254])),
    () => new Response('x'.repeat(8_000_001), {headers: {'content-type': 'application/json'}})]) {
    const session = new IbReadSession(credential(), {fetchImpl: async () => make()}); session.initialized = true;
    const out = await failure(() => session.read('get_account_orders'));
    assert.equal(out.phase, 'mcp_orders_read'); assert.equal(out.category, 'response_invalid'); noLeak(out);
  }
});
