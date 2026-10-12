import test from 'node:test';
import assert from 'node:assert/strict';
import {privateCloudIo} from './cloud_io.mjs';
import {runIbOrdersCheck, loadOrdersAssociation} from './orders_check.mjs';
import {RESOURCE, TOKEN_ENDPOINT, loadReadCredential} from './ib_mcp.mjs';
import {safeIbFailure} from './ib_diagnostics.mjs';
import {associationPolicyText} from '../../scripts/xuan-ib-account-association.mjs';

// Exercise the actual adapter and controller together. Only HTTP responses are
// synthetic; no secret/store methods or diagnostic classifiers are stubbed.
const canary = 'SYNTHETIC_ADAPTER_PRIVATE_CANARY_539102';
const time = Date.parse('2026-10-12T08:00:00Z'), now = () => time;
const secret = 'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp';
const policy = {schemaVersion: 1, policyId: 'ib-primary-7day-pilot-v1', accountAlias: 'IB-HK',
  basis: 'owner-attested-recurring-v1', status: 'active', purpose: 'xuan-ib-read-only-report',
  editions: ['adhoc', 'am', 'pm'], publisher: 'codex-verified-candidate-v1',
  validFrom: '2026-10-10T00:00:00.000Z', expiresAt: '2027-10-10T00:00:00.000Z'};
const receipt = () => ({name: `${secret}/versions/15`, state: 'ENABLED'});
const ref = () => ({ref: 'refs/heads/main', object: {type: 'commit', sha: 'b'.repeat(40)}});
const response = (value, status = 200) => new Response(JSON.stringify(value),
  {status, headers: {'content-type': 'application/json'}});
function harness({due = true, load, save, schema = {type: 'object'}, refResponse} = {}) {
  const counts = {metadata: 0, marker: 0, ref: 0, policy: 0, secret: 0, refresh: 0, save: 0,
    initialize: 0, initialized: 0, catalog: 0, orders: 0};
  const markers = new Set();
  const credential = {client_id: 'synthetic-client', access_token: canary, refresh_token: canary,
    token_type: 'Bearer', scope: 'mcp.read', resource: RESOURCE, expires_at: time + (due ? 1000 : 3_600_000)};
  const fetchImpl = async (input, options = {}) => {
    const url = String(input);
    assert.equal(options.redirect, 'error');
    if (url.startsWith('http://metadata.google.internal/')) {
      assert.equal(url, 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token');
      counts.metadata++; return response({access_token: canary});
    }
    if (url.startsWith('https://storage.googleapis.com/upload/')) {
      counts.marker++;
      const target = new URL(url), name = target.searchParams.get('name');
      assert.equal(target.origin + target.pathname,
        'https://storage.googleapis.com/upload/storage/v1/b/family-portfolio-gateway-xuan-preopen-private/o');
      assert.equal(options.method, 'POST'); assert.equal(target.searchParams.get('ifGenerationMatch'), '0');
      assert.equal(JSON.stringify(JSON.parse(options.body)).includes(canary), false);
      if (markers.has(name)) return response({}, 412);
      markers.add(name); return response({name, size: String(options.body.length), generation: '1'});
    }
    if (url === 'https://api.github.com/repos/huanwujoy-crypto/fee-console/git/ref/heads/main') {
      counts.ref++; return refResponse ? refResponse() : response(ref());
    }
    if (url === `https://raw.githubusercontent.com/huanwujoy-crypto/fee-console/${'b'.repeat(40)}/claude/xuan-ib-account-association-v1.json`) {
      counts.policy++; return new Response(associationPolicyText(policy));
    }
    if (url === `https://secretmanager.googleapis.com/v1/${secret}/versions/latest:access`) {
      counts.secret++;
      return load ? load() : response({payload: {data: Buffer.from(JSON.stringify(credential)).toString('base64')}});
    }
    if (url === `https://secretmanager.googleapis.com/v1/${secret}:addVersion`) {
      counts.save++; assert.equal(options.method, 'POST');
      return save ? save() : response({...receipt(), providerPrivateField: canary});
    }
    if (url === TOKEN_ENDPOINT) {
      counts.refresh++; assert.equal(options.method, 'POST');
      assert.equal(options.body.get('scope'), 'mcp.read'); assert.equal(options.body.get('resource'), RESOURCE);
      return response({access_token: canary, refresh_token: canary, token_type: 'Bearer', scope: 'mcp.read', expires_in: 3600});
    }
    assert.equal(url, RESOURCE); assert.equal(options.method, 'POST');
    const q = JSON.parse(options.body);
    if (q.method === 'initialize') {
      counts.initialize++; return response({jsonrpc: '2.0', id: q.id,
        result: {protocolVersion: '2025-03-26', capabilities: {tools: {}}}});
    }
    if (q.method === 'notifications/initialized') {counts.initialized++; return new Response(null, {status: 202});}
    if (q.method === 'tools/list') {
      counts.catalog++; return response({jsonrpc: '2.0', id: q.id,
        result: {tools: [{name: 'get_account_orders', inputSchema: schema, description: canary}]}});
    }
    assert.deepEqual(q.params, {name: 'get_account_orders', arguments: {}});
    counts.orders++; return response({jsonrpc: '2.0', id: q.id, result: {structuredContent: {orders: []}}});
  };
  const io = privateCloudIo({fetchImpl});
  const options = {attemptId: 'a'.repeat(32), allowAttemptMarker: true, allowRefreshSave: true,
    withCatalog: true, now, io, fetchImpl, loadAssociation: () => loadOrdersAssociation({fetchImpl, now})};
  return {options, counts, io};
}
async function failure(options) {
  try {await runIbOrdersCheck(options); assert.fail('Expected bounded failure');}
  catch (error) {
    const out = safeIbFailure(error); assert.equal(JSON.stringify(out).includes(canary), false); return out;
  }
}

test('actual cloud adapter confirms one same-secret rotation before the only orders read', async () => {
  const h = harness(), out = await runIbOrdersCheck(h.options);
  assert.equal(out.rotationSaved, true); assert.equal(out.ordersReadSucceeded, true);
  assert.equal(JSON.stringify(out).includes(canary), false);
  assert.deepEqual(h.counts, {metadata: 1, marker: 1, ref: 2, policy: 2, secret: 1, refresh: 1,
    save: 1, initialize: 1, initialized: 1, catalog: 1, orders: 1});
});

test('fixed numeric-project version names are accepted without payload readback', async () => {
  const h = harness({save: () => response({name: 'projects/860729177589/secrets/xuan-preopen-ib-mcp/versions/16', state: 'ENABLED'})});
  assert.equal((await runIbOrdersCheck(h.options)).rotationSaved, true); assert.equal(h.counts.secret, 1);
});

for (const [label, value] of [
  ['empty', {}], ['null', null], ['wrong-project', {...receipt(), name: 'projects/another/secrets/xuan-preopen-ib-mcp/versions/15'}],
  ['wrong-secret', {...receipt(), name: 'projects/family-portfolio-gateway/secrets/another/versions/15'}],
  ['disabled', {...receipt(), state: 'DISABLED'}], ['missing-state', {name: receipt().name}],
  ['latest-alias', {...receipt(), name: `${secret}/versions/latest`}], ['zero-version', {...receipt(), name: `${secret}/versions/0`}],
]) test(`actual cloud adapter stops on ${label} 2xx save acknowledgement and never repeats`, async () => {
  const h = harness({save: () => response(value)}), out = await failure(h.options);
  assert.equal(out.code, 'IB_TOKEN_ROTATION_OUTCOME_UNKNOWN'); assert.equal(out.phase, 'credential_save');
  assert.equal(out.category, 'save_outcome_unknown');
  assert.equal(h.counts.refresh, 1); assert.equal(h.counts.save, 1); assert.equal(h.counts.initialize, 0); assert.equal(h.counts.orders, 0);
  assert.equal((await failure(h.options)).code, 'IB_DIAGNOSTIC_ATTEMPT_CONSUMED');
  assert.equal(h.counts.secret, 1); assert.equal(h.counts.refresh, 1); assert.equal(h.counts.save, 1);
});

for (const [status, category] of [[401, 'authentication_rejected'], [403, 'permission_denied'],
  [429, 'rate_limited'], [503, 'service_error']]) test(`actual cloud adapter preserves secret HTTP ${status}`, async () => {
  const h = harness({load: () => response({error: canary}, status)}), out = await failure(h.options);
  assert.equal(out.phase, 'credential_load'); assert.equal(out.httpStatus, status); assert.equal(out.category, category);
  assert.equal(h.counts.secret, 1); assert.equal(h.counts.refresh, 0); assert.equal(h.counts.save, 0); assert.equal(h.counts.orders, 0);
});

for (const [label, load] of [
  ['invalid-secret-json', () => response({payload: {data: Buffer.from(canary).toString('base64')}})],
  ['invalid-response-json', () => new Response(canary)], ['missing-payload', () => response({})],
]) test(`actual cloud adapter classifies ${label} as response failure`, async () => {
  const h = harness({load}), out = await failure(h.options);
  assert.equal(out.phase, 'credential_load'); assert.equal(out.category, 'response_invalid');
  assert.equal(h.counts.refresh, 0); assert.equal(h.counts.orders, 0);
});

for (const [name, category] of [['TypeError', 'network'], ['TimeoutError', 'timeout']])
  test(`actual cloud adapter preserves ${category} without private error text`, async () => {
    const h = harness({load: () => {const e = new Error(canary); e.name = name; throw e;}}), out = await failure(h.options);
    assert.equal(out.phase, 'credential_load'); assert.equal(out.category, category); assert.equal(out.httpStatus, null);
    assert.equal(h.counts.refresh, 0); assert.equal(h.counts.orders, 0);
  });

test('an unclassified store error stays unknown rather than asserting a network cause', async () => {
  let out;
  try {await loadReadCredential({load: async () => {throw new Error(canary);}});}
  catch (error) {out = safeIbFailure(error);}
  assert.equal(out.category, 'unknown'); assert.equal(JSON.stringify(out).includes(canary), false);
});

for (const [status, category] of [[403, 'save_failed'], [503, 'save_outcome_unknown']])
  test(`actual cloud adapter stops after one save HTTP ${status}`, async () => {
    const h = harness({save: () => response({error: canary}, status)}), out = await failure(h.options);
    assert.equal(out.phase, 'credential_save'); assert.equal(out.httpStatus, status); assert.equal(out.category, category);
    assert.equal(out.code, status === 403 ? 'IB_TOKEN_ROTATION_NOT_SAVED' : 'IB_TOKEN_ROTATION_OUTCOME_UNKNOWN');
    assert.equal(h.counts.refresh, 1); assert.equal(h.counts.save, 1); assert.equal(h.counts.initialize, 0);
  });

test('actual cloud adapter treats malformed 2xx save JSON as unknown without continuing', async () => {
  const h = harness({save: () => new Response(canary)}), out = await failure(h.options);
  assert.equal(out.phase, 'credential_save'); assert.equal(out.category, 'save_outcome_unknown');
  assert.equal(out.code, 'IB_TOKEN_ROTATION_OUTCOME_UNKNOWN');
  assert.equal(h.counts.save, 1); assert.equal(h.counts.initialize, 0); assert.equal(h.counts.orders, 0);
});

test('actual cloud adapter late save acknowledgement cannot restart the closed attempt', async () => {
  let resolveSave;
  const pending = new Promise(resolve => {resolveSave = resolve;});
  const h = harness({save: () => pending}), options = {...h.options, timeoutMs: 20};
  const out = await failure(options);
  assert.equal(out.code, 'IB_TOKEN_ROTATION_OUTCOME_UNKNOWN'); assert.equal(out.phase, 'credential_save');
  resolveSave(response(receipt())); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.counts.save, 1); assert.equal(h.counts.initialize, 0); assert.equal(h.counts.orders, 0);
  assert.equal((await failure(options)).code, 'IB_DIAGNOSTIC_ATTEMPT_CONSUMED');
  assert.equal(h.counts.refresh, 1); assert.equal(h.counts.save, 1);
});

for (const [label, schema] of [
  ['const', {type: 'object', const: {required_argument: canary}}],
  ['enum', {type: 'object', enum: [{required_argument: canary}]}],
  ['dynamic-ref', {type: 'object', $dynamicRef: canary}],
  ['dependencies', {type: 'object', dependencies: {argument: ['another']}}],
  ['unknown-keyword', {type: 'object', customConstraint: true}],
  ['invalid-max', {type: 'object', maxProperties: -1}],
  ['custom-dialect', {type: 'object', $schema: canary}],
]) test(`closed empty-argument schema rejects ${label} before orders dispatch`, async () => {
  const h = harness({due: false, schema}), out = await failure(h.options);
  assert.equal(out.code, 'IB_DIAGNOSTIC_ORDERS_SCHEMA_UNSUPPORTED'); assert.equal(h.counts.orders, 0);
  assert.equal(h.counts.catalog, 1); assert.equal(h.counts.refresh, 0);
});

test('supported schema proves an empty object is accepted without broadening arguments', async () => {
  const h = harness({due: false, schema: {type: 'object', properties: {optional: {type: 'string'}}, required: [],
    additionalProperties: false, minProperties: 0, maxProperties: 0,
    $schema: 'https://json-schema.org/draft/2020-12/schema', description: canary}});
  assert.equal((await runIbOrdersCheck(h.options)).catalogToolPresent, true); assert.equal(h.counts.orders, 1);
});

for (const [label, value] of [
  ['wrong-ref', {...ref(), ref: 'refs/heads/another'}],
  ['noncommit', {...ref(), object: {type: 'tag', sha: 'b'.repeat(40)}}],
  ['invalid-sha', {...ref(), object: {type: 'commit', sha: canary}}],
  ['oversized', {...ref(), padding: 'x'.repeat(4096)}],
]) test(`fixed main-ref validation rejects ${label} before credential access`, async () => {
  const h = harness({refResponse: () => response(value)}), out = await failure(h.options);
  assert.equal(out.phase, 'association_validate'); assert.equal(h.counts.ref, 1); assert.equal(h.counts.policy, 0);
  assert.equal(h.counts.secret, 0); assert.equal(h.counts.refresh, 0);
});
