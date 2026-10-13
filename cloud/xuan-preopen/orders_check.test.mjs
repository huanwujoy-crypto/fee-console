import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {runIbOrdersCheck, ordersCheckCli, loadOrdersAssociation, DIAGNOSTIC_JOB,
  ORDERS_DIAGNOSTIC_PLAN, ORDERS_CHECK_ARGS} from './orders_check.mjs';
import {RESOURCE, TOKEN_ENDPOINT} from './ib_mcp.mjs';
import {safeIbFailure} from './ib_diagnostics.mjs';
import {associationPolicyBlob, associationPolicyText} from '../../scripts/xuan-ib-account-association.mjs';
import {APPROVED_IB_ACCOUNT_ID} from '../../scripts/xuan-ib-run-manifest.mjs';

const canary = 'PRIVATE_ORDERS_CANARY_758129';
const time = Date.parse('2026-10-12T08:00:00.000Z');
const now = () => time;
const id = 'a'.repeat(32);
const policy = {schemaVersion: 1, policyId: 'ib-primary-7day-pilot-v1', accountAlias: 'IB-HK',
  basis: 'owner-attested-recurring-v1', status: 'active', purpose: 'xuan-ib-read-only-report',
  editions: ['adhoc', 'am', 'pm'], publisher: 'codex-verified-candidate-v1',
  validFrom: '2026-10-10T00:00:00.000Z', expiresAt: '2027-10-10T00:00:00.000Z'};
const association = () => ({policy: structuredClone(policy), policyCommit: 'b'.repeat(40),
  policyBlob: associationPolicyBlob(policy), checkedAt: new Date(time).toISOString()});
const row = () => ({order_id: 1, order_status: 'NEW', order_type: 'LIMIT', side: 'BUY',
  limit_price: '10.50', total_shares_qty: '1', cum_shares_qty: '0', remaining_shares_qty: '1',
  primary_description: 'Buy 1 SYNTH', secondary_description: canary, order_time: '2026-10-12T07:00:00Z'});
const tool = () => ({name: 'get_account_orders', inputSchema: {type: 'object', properties: {}, required: []}, description: canary});
const response = value => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});

function harness({due = false, raw = {orders: [row()]}, pages = [{tools: [tool()]}], markers = new Map(),
  save = async () => ({name: 'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/15', state: 'ENABLED'}),
  fetchOverride, loadOverride, associationOverride, claimOverride} = {}) {
  const calls = [], state = {loads: 0, saves: 0, claims: 0, associationReads: 0, refresh: 0};
  const options = {attemptId: id, allowAttemptMarker: true, allowRefreshSave: false, withCatalog: false, now,
    io: {ibStore: {
      load: async () => {state.loads++; calls.push('load'); return loadOverride ? loadOverride() :
        {client_id: 'synthetic-client', access_token: canary, refresh_token: canary, token_type: 'Bearer',
          scope: 'mcp.read', resource: RESOURCE, expires_at: time + (due ? 1000 : 3_600_000)};},
      save: async value => {state.saves++; calls.push('save'); return save(value);},
    }, savePrivate: async (name, value) => {
      state.claims++; calls.push('claim');
      assert.match(name, /^report-check\/auth-orders-[a-f0-9]{32}\/attempt.json$/);
      assert.equal(JSON.stringify(value).includes(canary), false);
      if (claimOverride) return claimOverride(name, value);
      if (markers.has(name)) throw new Error('CLOUD_HTTP_412');
      markers.set(name, structuredClone(value));
      return {generation: '1', sha256: crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')};
    }},
    loadAssociation: async () => {state.associationReads++; calls.push('association');
      return associationOverride ? associationOverride(state.associationReads) : association();},
    fetchImpl: async (url, opts) => {
      assert.equal(opts.method, 'POST'); assert.equal(opts.redirect, 'error');
      if (url === TOKEN_ENDPOINT) {
        state.refresh++; calls.push('refresh');
        assert.equal(opts.body.get('scope'), 'mcp.read'); assert.equal(opts.body.get('resource'), RESOURCE);
        if (fetchOverride) return fetchOverride(url, opts);
        return response({access_token: canary, refresh_token: canary, token_type: 'Bearer', scope: 'mcp.read', expires_in: 3600});
      }
      assert.equal(url, RESOURCE);
      const request = JSON.parse(opts.body); calls.push(request.method);
      if (fetchOverride) return fetchOverride(url, opts, request);
      if (request.method === 'initialize') return response({jsonrpc: '2.0', id: request.id,
        result: {protocolVersion: '2025-03-26', capabilities: {tools: {}}}});
      if (request.method === 'notifications/initialized') return new Response(null, {status: 202});
      if (request.method === 'tools/list') {
        const page = request.params.cursor === undefined ? 0 : Number(request.params.cursor);
        return response({jsonrpc: '2.0', id: request.id, result: pages[page]});
      }
      assert.deepEqual(request.params, {name: 'get_account_orders', arguments: {}});
      return response({jsonrpc: '2.0', id: request.id, result: {structuredContent: raw}});
    }};
  return {options, calls, state, markers};
}
async function failure(options) {
  try { await runIbOrdersCheck(options); assert.fail('Expected bounded failure'); }
  catch (error) {
    const out = safeIbFailure(error); assert.equal(JSON.stringify(out).includes(canary), false); return out;
  }
}

test('import has no IO; local CLI/runtime refusal precedes any capability creation', async () => {
  const url = new URL('./orders_check.mjs', import.meta.url).href;
  const script = `let calls=0;globalThis.fetch=()=>{calls++;throw Error('OFFLINE_ONLY')};await import(${JSON.stringify(url)});if(calls!==0)process.exit(9);`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8'}), '');
  let made = 0;
  for (const args of [[], ['--orders-check', '--attempt-id', id, '--claim-attempt']]) {
    const out = await ordersCheckCli(args, {env: {}, ioFactory: () => {made++;}});
    assert.equal(out.status, 'failed');
  }
  assert.equal(made, 0);
});

const cliEnv = () => ({CLOUD_RUN_JOB: DIAGNOSTIC_JOB, CLOUD_RUN_EXECUTION: `${DIAGNOSTIC_JOB}-test`,
  CLOUD_RUN_TASK_COUNT:'1',CLOUD_RUN_TASK_INDEX:'0',CLOUD_RUN_TASK_ATTEMPT:'0'});
const cliNow = () => Date.parse('2026-10-12T23:30:00.000Z');
test('CLI binds the existing report runtime, single task and original fixed attempt', async () => {
  const env = cliEnv();
  let options;
  const result = await ordersCheckCli([...ORDERS_CHECK_ARGS],
    {env, now:cliNow, ioFactory: () => ({}), run: async o => {options = o; return {status: 'checked'};}});
  assert.equal(result.status, 'checked'); assert.equal(options.withCatalog, true); assert.equal(options.allowRefreshSave, true);
  assert.equal(options.mode,'orders_check'); assert.equal(options.attemptId,ORDERS_DIAGNOSTIC_PLAN.attemptId);
  assert.equal(options.now,cliNow);
});
test('CLI rejects another job, execution, task, missing runtime or retry before I/O', async () => {
  for (const change of [{CLOUD_RUN_JOB:'xuan-preopen-auth-orders-check'}, {CLOUD_RUN_EXECUTION:'other-test'},
    {CLOUD_RUN_EXECUTION:`${DIAGNOSTIC_JOB}-`}, {CLOUD_RUN_TASK_COUNT:'2'}, {CLOUD_RUN_TASK_COUNT:1},
    {CLOUD_RUN_TASK_INDEX:'1'}, {CLOUD_RUN_TASK_ATTEMPT:'1'}, {CLOUD_RUN_TASK_ATTEMPT:undefined}]) {
    const out=await ordersCheckCli([...ORDERS_CHECK_ARGS],{env:{...cliEnv(),...change},now:cliNow,
      ioFactory:()=>assert.fail('No IO'),run:()=>assert.fail('No run')});
    assert.equal(out.code,'IB_DIAGNOSTIC_RUNTIME_REQUIRED');
  }
});
test('CLI refuses altered attempt, auth-only, reordered, missing or extended arguments before I/O', async () => {
  for (const args of [undefined,null,[],['--auth-check',...ORDERS_CHECK_ARGS.slice(1)],
    ['--orders-check','--attempt-id',id,...ORDERS_CHECK_ARGS.slice(3)],ORDERS_CHECK_ARGS.slice(0,-1),
    [...ORDERS_CHECK_ARGS,'--secret',canary], [...ORDERS_CHECK_ARGS,'--claim-attempt'],
    [ORDERS_CHECK_ARGS[0],...ORDERS_CHECK_ARGS.slice(2),ORDERS_CHECK_ARGS[1]]]) {
    const out=await ordersCheckCli(args,{env:cliEnv(),now:cliNow,ioFactory:()=>assert.fail('No IO')});
    assert.equal(out.code,'IB_DIAGNOSTIC_REQUEST_INVALID');
  }
});
test('queued or expired starts fail before I/O; window starts inclusive and ends exclusive', async () => {
  const start=Date.parse(ORDERS_DIAGNOSTIC_PLAN.notBefore),end=Date.parse(ORDERS_DIAGNOSTIC_PLAN.notAfter);
  for (const value of [start-1,end,end+1,NaN,Infinity,'2026-10-12']) {
    const out=await ordersCheckCli([...ORDERS_CHECK_ARGS],{env:cliEnv(),now:()=>value,
      ioFactory:()=>assert.fail('No IO'),run:()=>assert.fail('No run')});
    assert.equal(out.code,'IB_DIAGNOSTIC_REQUEST_INVALID');
  }
  for (const value of [start,end-1]) {
    let made=0;
    const out=await ordersCheckCli([...ORDERS_CHECK_ARGS],{env:cliEnv(),now:()=>value,
      ioFactory:()=>{made++;return {};},run:async()=>({status:'checked'})});
    assert.equal(out.status,'checked');assert.equal(made,1);
  }
  assert.equal(new Date(start+8*3600000).toISOString().slice(0,10),ORDERS_DIAGNOSTIC_PLAN.dataDate);
  assert(end<=Date.parse('2026-10-13T16:00:00Z')-600000);
});

test('one nonempty orders read validates report rows without any financial output/upload', async () => {
  const h = harness(); const out = await runIbOrdersCheck(h.options);
  assert.equal(out.ordersReadSucceeded, true); assert.equal(out.orderRowsContractValid, true);
  assert.equal(out.nonemptySchemaObserved, true); assert.equal(out.nativeIdentityUnavailable, true);
  assert.equal(out.nativeIdentifiersMatch, false); assert.equal(out.ownerAssociationValid, true);
  assert.equal(out.refreshAttempted, false); assert.equal(out.rotationSaved, false);
  assert.deepEqual(h.calls, ['claim', 'association', 'load', 'initialize', 'notifications/initialized', 'tools/call', 'association']);
  assert.equal(h.state.claims, 1); assert.equal(h.markers.size, 1);
  const text = JSON.stringify(out); for (const secret of [canary, 'limit_price', 'order_id', 'access_token', 'account_id']) assert.equal(text.includes(secret), false);
});

test('empty orders and missing native identity are explicit, not proof of a nonempty schema', async () => {
  const h = harness({raw: {orders: []}}); const out = await runIbOrdersCheck(h.options);
  assert.equal(out.ordersResponseValid, true); assert.equal(out.nonemptySchemaObserved, false);
  assert.equal(out.nativeIdentityUnavailable, true); assert.equal(out.nativeIdentifiersMatch, false);
});

test('auth-only mode calls no financial tool even with catalog discovery', async () => {
  const h = harness(); const out = await runIbOrdersCheck({...h.options, mode: 'auth_check', withCatalog: true});
  assert.equal(out.authenticationSucceeded, true); assert.equal(out.ordersReadSucceeded, false);
  assert.equal(out.orderRowsContractValid, false); assert.equal(h.calls.includes('tools/call'), false);
  assert.equal(h.calls.filter(c => c === 'tools/list').length, 1);
});

test('refresh and same-store rotation happen exactly once, before any MCP request', async () => {
  const h = harness({due: true}); const out = await runIbOrdersCheck({...h.options, allowRefreshSave: true, withCatalog: true});
  assert.equal(out.refreshAttempted, true); assert.equal(out.rotationSaved, true);
  assert.equal(h.state.refresh, 1); assert.equal(h.state.saves, 1); assert.equal(h.state.loads, 1);
  assert(h.calls.indexOf('save') < h.calls.indexOf('initialize'));
});

test('unapproved refresh or missing save capability cannot submit a credential', async () => {
  const h = harness({due: true}); const out = await failure(h.options);
  assert.equal(out.code, 'IB_REFRESH_NOT_AUTHORIZED'); assert.equal(h.state.refresh, 0); assert.equal(h.state.saves, 0);
  const other = harness({due: true}); delete other.options.io.ibStore.save;
  assert.equal((await failure({...other.options, allowRefreshSave: true})).code, 'IB_DIAGNOSTIC_CAPABILITY_REQUIRED');
  assert.equal(other.state.loads, 0); assert.equal(other.state.claims, 0);
});

test('repeated attempt is consumed durably before credentials, policy and financial reads', async () => {
  const markers = new Map(); const first = harness({markers}); await runIbOrdersCheck(first.options);
  const repeat = harness({markers}); const out = await failure(repeat.options);
  assert.equal(out.code, 'IB_DIAGNOSTIC_ATTEMPT_CONSUMED'); assert.deepEqual(repeat.calls, ['claim']);
  assert.equal(repeat.state.loads, 0); assert.equal(markers.size, 1);
});

test('concurrent same-attempt invocations cannot both pass the create-only claim', async () => {
  const markers = new Map(); const a = harness({markers}), b = harness({markers});
  const results = await Promise.allSettled([runIbOrdersCheck(a.options), runIbOrdersCheck(b.options)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(a.state.loads + b.state.loads, 1); assert.equal(markers.size, 1);
});

test('a previous Hong Kong date claim remains consumed on the new date before credential I/O', async () => {
  const markers = new Map(), attemptId = ORDERS_DIAGNOSTIC_PLAN.attemptId;
  const previous = harness({markers});
  await runIbOrdersCheck({...previous.options, attemptId});
  const key = `report-check/auth-orders-${attemptId}/attempt.json`;
  const original = JSON.stringify(markers.get(key));
  assert.equal(new Date(time + 8 * 3600000).toISOString().slice(0, 10), '2026-10-12');
  for (const current of [Date.parse(ORDERS_DIAGNOSTIC_PLAN.notBefore) + 60_000,
    Date.parse('2026-10-13T10:00:00Z')]) {
    assert.equal(new Date(current + 8 * 3600000).toISOString().slice(0, 10), ORDERS_DIAGNOSTIC_PLAN.dataDate);
    const repeat = harness({markers});
    const out = await failure({...repeat.options, attemptId, now: () => current});
    assert.equal(out.code, 'IB_DIAGNOSTIC_ATTEMPT_CONSUMED');
    assert.deepEqual(repeat.calls, ['claim']);
    assert.equal(repeat.state.loads, 0); assert.equal(repeat.state.saves, 0);
    assert.equal(repeat.state.associationReads, 0); assert.equal(repeat.state.refresh, 0);
    assert.equal(markers.size, 1); assert.equal(JSON.stringify(markers.get(key)), original);
  }
});

test('an unused fixed attempt can be claimed once when UTC and Hong Kong dates differ', async () => {
  const current = Date.parse(ORDERS_DIAGNOSTIC_PLAN.notBefore) + 60_000;
  assert.equal(new Date(current).toISOString().slice(0, 10), '2026-10-12');
  assert.equal(new Date(current + 8 * 3600000).toISOString().slice(0, 10), ORDERS_DIAGNOSTIC_PLAN.dataDate);
  const h = harness({raw: {orders: []},
    loadOverride: () => ({client_id: 'synthetic-client', access_token: canary,
      refresh_token: canary, token_type: 'Bearer', scope: 'mcp.read', resource: RESOURCE,
      expires_at: current + 3_600_000}),
    associationOverride: () => ({...association(), checkedAt: new Date(current).toISOString()})});
  const out = await ordersCheckCli([...ORDERS_CHECK_ARGS], {env: cliEnv(), now: () => current,
    ioFactory: () => h.options.io,
    run: options => runIbOrdersCheck({...h.options, ...options})});
  assert.equal(out.status, 'checked'); assert.equal(out.ordersReadSucceeded, true);
  assert.equal(out.refreshAttempted, false); assert.equal(h.state.claims, 1);
  assert.equal(h.state.loads, 1); assert.equal(h.state.refresh, 0); assert.equal(h.state.saves, 0);
  const key = `report-check/auth-orders-${ORDERS_DIAGNOSTIC_PLAN.attemptId}/attempt.json`;
  assert.deepEqual([...h.markers.keys()], [key]);
  assert.equal(h.markers.get(key).startedAt, new Date(current).toISOString());
});

test('a queued start after the next Hong Kong midnight refuses before any capability I/O', async () => {
  const midnight = Date.parse(`${ORDERS_DIAGNOSTIC_PLAN.dataDate}T16:00:00Z`);
  assert.equal(new Date(midnight + 8 * 3600000).toISOString().slice(0, 10), '2026-10-14');
  let made = 0, runs = 0;
  for (const current of [midnight, midnight + 60_000]) {
    const out = await ordersCheckCli([...ORDERS_CHECK_ARGS], {env: cliEnv(), now: () => current,
      ioFactory: () => {made++; return {};}, run: () => {runs++;}});
    assert.equal(out.code, 'IB_DIAGNOSTIC_REQUEST_INVALID');
  }
  assert.equal(made, 0); assert.equal(runs, 0);
});

test('unknown claim result stops before loading any credential and never retries', async () => {
  for (const claimOverride of [async () => {throw new Error(canary);}, async () => ({}), () => new Promise(() => {})]) {
    const h = harness({claimOverride}); const out = await failure({...h.options, timeoutMs: 15});
    assert.equal(out.phase, 'attempt_claim'); assert.equal(h.state.claims, 1); assert.equal(h.state.loads, 0);
  }
});

test('denied or unknown save consumes one refresh and cannot continue or repeat', async () => {
  for (const save of [async () => {throw new Error('CLOUD_HTTP_403');}, async () => {throw new Error(canary);}]) {
    const h = harness({due: true, save}); const out = await failure({...h.options, allowRefreshSave: true});
    assert.equal(out.phase, 'credential_save'); assert.equal(h.state.refresh, 1); assert.equal(h.state.saves, 1);
    assert.equal(h.calls.includes('initialize'), false);
    assert.equal((await failure({...h.options, allowRefreshSave: true})).code, 'IB_DIAGNOSTIC_ATTEMPT_CONSUMED');
    assert.equal(h.state.refresh, 1); assert.equal(h.state.saves, 1);
  }
});

test('controller refuses an unconfirmed injected store receipt before MCP', async () => {
  const h = harness({due: true, save: async () => ({})});
  const out = await failure({...h.options, allowRefreshSave: true});
  assert.equal(out.code, 'IB_TOKEN_ROTATION_OUTCOME_UNKNOWN');
  assert.equal(out.phase, 'credential_save'); assert.equal(h.state.saves, 1);
  assert.equal(h.calls.includes('initialize'), false);
});

test('save timeout is unknown and late resolution never starts MCP or a second save', async () => {
  let resolveSave; const pending = new Promise(resolve => {resolveSave = resolve;});
  const h = harness({due: true, save: () => pending});
  const out = await failure({...h.options, allowRefreshSave: true, timeoutMs: 20});
  assert.equal(out.code, 'IB_TOKEN_ROTATION_OUTCOME_UNKNOWN'); assert.equal(out.phase, 'credential_save');
  resolveSave(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.calls.includes('initialize'), false); assert.equal(h.state.refresh, 1); assert.equal(h.state.saves, 1);
});

test('refresh timeout aborts the attempt and a late refresh result cannot save or read', async () => {
  let resolveRefresh; const pending = new Promise(resolve => {resolveRefresh = resolve;});
  const h = harness({due: true, fetchOverride: () => pending});
  const out = await failure({...h.options, allowRefreshSave: true, timeoutMs: 20});
  assert.equal(out.phase, 'oauth_refresh');
  resolveRefresh(response({access_token: canary, refresh_token: canary, token_type: 'Bearer', expires_in: 3600}));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.state.refresh, 1); assert.equal(h.state.saves, 0); assert.equal(h.calls.includes('initialize'), false);
});

test('credential-load timeout retains its stage and cannot later submit a refresh', async () => {
  let resolveLoad; const pending = new Promise(resolve => {resolveLoad = resolve;});
  const h = harness({due: true, loadOverride: () => pending});
  const out = await failure({...h.options, allowRefreshSave: true, timeoutMs: 20});
  assert.equal(out.phase, 'credential_load');
  resolveLoad({client_id: 'synthetic-client', access_token: canary, refresh_token: canary, token_type: 'Bearer',
    scope: 'mcp.read', resource: RESOURCE, expires_at: time + 1000});
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.state.refresh, 0); assert.equal(h.state.saves, 0); assert.equal(h.calls.includes('initialize'), false);
});

test('MCP initialized notification timeout retains its exact substage and stops orders', async () => {
  const h = harness({fetchOverride: async (_, options, request) => {
    if (request.method === 'initialize') return response({jsonrpc: '2.0', id: request.id,
      result: {protocolVersion: '2025-03-26', capabilities: {tools: {}}}});
    return new Promise(() => {});
  }});
  const out = await failure({...h.options, timeoutMs: 20});
  assert.equal(out.phase, 'mcp_initialized'); assert.equal(h.calls.includes('tools/call'), false);
});

test('a hanging refresh body times out and a late body cannot persist or continue', async () => {
  let stream;
  const body = new ReadableStream({start(controller) {stream = controller;}});
  const h = harness({due: true, fetchOverride: async () => new Response(body, {headers: {'content-type': 'application/json'}})});
  const out = await failure({...h.options, allowRefreshSave: true, timeoutMs: 20});
  assert.equal(out.phase, 'oauth_refresh');
  stream.enqueue(new TextEncoder().encode(JSON.stringify({access_token: canary, refresh_token: canary,
    token_type: 'Bearer', scope: 'mcp.read', expires_in: 3600}))); stream.close();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.state.saves, 0); assert.equal(h.calls.includes('initialize'), false);
});

test('invalid pre-read policy blocks credentials and changing policy fails final acceptance', async () => {
  const h = harness({associationOverride: () => {const a = association(); a.policy.status = 'revoked'; a.policyBlob = associationPolicyBlob(a.policy); return a;}});
  assert.equal((await failure(h.options)).code, 'IB_DIAGNOSTIC_ASSOCIATION_INVALID'); assert.equal(h.state.loads, 0);
  const changed = harness({associationOverride: count => {const a = association();
    if (count === 2) {a.policy.expiresAt = '2027-10-09T00:00:00.000Z'; a.policyBlob = associationPolicyBlob(a.policy);} return a;}});
  assert.equal((await failure(changed.options)).code, 'IB_DIAGNOSTIC_ASSOCIATION_CHANGED');
});

test('native account contradiction anywhere fails, while no identifier stays unavailable', async () => {
  for (const raw of [{orders: [], account_id: canary}, {orders: [], other: {accountId: null}}, {orders: [], other: {accountId: canary}}]) {
    const h = harness({raw}); assert.equal((await failure(h.options)).code, 'IB_DIAGNOSTIC_ACCOUNT_MISMATCH');
  }
  const valid = harness({raw: {orders: [], account_id: APPROVED_IB_ACCOUNT_ID}});
  const out = await runIbOrdersCheck(valid.options); assert.equal(out.nativeIdentifiersMatch, true); assert.equal(out.nativeIdentityUnavailable, false);
});

test('row key/status/type/quantity failures cannot be passed as successful orders reads', async () => {
  for (const mutate of [r => {r.extra = canary;}, r => {r.order_status = 'FILLED';}, r => {r.order_type = 'MARKET';},
    r => {r.remaining_shares_qty = '2';}, r => {r.limit_price = 10.5;}, r => {r.side = 'UNKNOWN';}]) {
    const value = row(); mutate(value); const h = harness({raw: {orders: [value]}});
    assert.equal((await failure(h.options)).code, 'IB_DIAGNOSTIC_ORDERS_INVALID');
  }
});

test('catalog is at most two pages and never concludes absence from incomplete pagination', async () => {
  const found = harness({pages: [{tools: [], nextCursor: '1'}, {tools: [tool()]}]});
  assert.equal((await runIbOrdersCheck({...found.options, withCatalog: true})).catalogToolPresent, true);
  assert.equal(found.calls.filter(c => c === 'tools/list').length, 2);
  const incomplete = harness({pages: [{tools: [], nextCursor: '1'}, {tools: [], nextCursor: '2'}]});
  assert.equal((await failure({...incomplete.options, withCatalog: true})).code, 'IB_DIAGNOSTIC_CATALOG_INCOMPLETE');
  assert.equal(incomplete.calls.filter(c => c === 'tools/list').length, 2); assert.equal(incomplete.calls.includes('tools/call'), false);
});

test('catalog repeated cursors, bad schemas and missing tools stop without an orders read', async () => {
  for (const [pages, expected] of [
    [[{tools: [], nextCursor: '1'}, {tools: [], nextCursor: '1'}], 'IB_DIAGNOSTIC_CATALOG_INVALID'],
    [[{tools: []}], 'IB_DIAGNOSTIC_ORDERS_TOOL_MISSING'],
    [[{tools: [{name: 'get_account_orders', inputSchema: {type: 'object', required: ['account']}}]}], 'IB_DIAGNOSTIC_ORDERS_SCHEMA_UNSUPPORTED'],
    [[{tools: [{name: 'get_account_orders', inputSchema: {type: 'object', oneOf: []}}]}], 'IB_DIAGNOSTIC_ORDERS_SCHEMA_UNSUPPORTED'],
    [[{tools: [tool(), tool()]}], 'IB_DIAGNOSTIC_CATALOG_INVALID'],
  ]) {
    const h = harness({pages}); assert.equal((await failure({...h.options, withCatalog: true})).code, expected);
    assert.equal(h.calls.includes('tools/call'), false);
  }
});

test('MCP 401 rejects once and never refreshes an otherwise unexpired credential', async () => {
  const h = harness({fetchOverride: async () => new Response(canary, {status: 401})});
  const out = await failure({...h.options, allowRefreshSave: true});
  assert.equal(out.code, 'IB_MCP_AUTHENTICATION_REJECTED'); assert.equal(out.phase, 'mcp_initialize');
  assert.equal(h.state.refresh, 0); assert.equal(h.state.saves, 0); assert.equal(h.calls.filter(c => c === 'initialize').length, 1);
});

test('trusted policy loader uses two fixed public reads and validates exact canonical blob', async () => {
  const calls = [];
  const snapshot = await loadOrdersAssociation({now, fetchImpl: async url => {calls.push(url);
    return url.endsWith('/git/ref/heads/main')
      ? response({ref: 'refs/heads/main', object: {type: 'commit', sha: 'b'.repeat(40)}})
      : new Response(associationPolicyText(policy));}});
  assert.equal(snapshot.policyBlob, associationPolicyBlob(policy)); assert.equal(calls.length, 2);
  assert(calls[0].startsWith('https://api.github.com/repos/huanwujoy-crypto/fee-console/'));
  assert(calls[1].endsWith('/claude/xuan-ib-account-association-v1.json'));
  const out = await (async () => {try {await loadOrdersAssociation({now, fetchImpl: async () => new Response(canary, {status: 403})});}
    catch (error) {return safeIbFailure(error);}})();
  assert.equal(out.code, 'IB_DIAGNOSTIC_ASSOCIATION_INVALID'); assert.equal(JSON.stringify(out).includes(canary), false);
});
