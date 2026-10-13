// Explicit, single-attempt diagnostic. Importing this module performs no I/O.
// No report, Sharesight read, raw-source upload, login or authorization expansion.
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {IbOrdersDiagnosticSession, loadReadCredential, RESOURCE, TOKEN_ENDPOINT} from './ib_mcp.mjs';
import {ibError, inIbPhase, safeIbFailure} from './ib_diagnostics.mjs';
import {privateCloudIo, boundedText, validateIbRotationReceipt} from './cloud_io.mjs';
import {ASSOCIATION_POLICY_PATH, validateAssociationSnapshot} from '../../scripts/xuan-ib-account-association.mjs';
import {APPROVED_IB_ACCOUNT_ID} from '../../scripts/xuan-ib-run-manifest.mjs';
import {ordersOf} from '../../scripts/xuan-ib-night-action-model.mjs';

export const DIAGNOSTIC_JOB = 'xuan-preopen-report';
// One unused attempt and the same-date daily-marker fence. These are source
// bindings, not authorization; changing the window requires a new review.
export const ORDERS_DIAGNOSTIC_PLAN = Object.freeze({
  attemptId: '1b2f15a8164980a7084ea84ff040154d',
  dataDate: '2026-10-13',
  notBefore: '2026-10-12T23:15:00.000Z',
  notAfter: '2026-10-13T15:50:00.000Z',
});
export const ORDERS_CHECK_ARGS = Object.freeze(['--orders-check', '--attempt-id',
  ORDERS_DIAGNOSTIC_PLAN.attemptId, '--claim-attempt', '--with-catalog', '--allow-refresh-save']);
export const DAILY_DIAGNOSTIC_ARGS = Object.freeze(['--ib-orders-check', ...ORDERS_CHECK_ARGS.slice(1)]);
const exactArgs = (args, expected) => Array.isArray(args) && args.length === expected.length
  && expected.every((value, index) => args[index] === value);
export const isDailyDiagnosticArgs = args => exactArgs(args, DAILY_DIAGNOSTIC_ARGS);
const REPO = 'https://api.github.com/repos/huanwujoy-crypto/fee-console';
const RAW = 'https://raw.githubusercontent.com/huanwujoy-crypto/fee-console';
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const fail = (code, phase = 'diagnostic_request', category = 'forbidden') => { throw ibError(code, {phase, category}); };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const gitBlob = bytes => crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');

// Reads only the account-association policy at fixed trusted main, not prior
// financial HTML or the full report context. Nothing comes from a CLI path.
export async function loadOrdersAssociation({fetchImpl = fetch, now = Date.now} = {}) {
  async function read(url, limit) {
    const response = await fetchImpl(url, {redirect: 'error', cache: 'no-store',
      headers: {'User-Agent': 'xuan-preopen-auth-orders-check'}, signal: AbortSignal.timeout(30_000)});
    if (!response.ok) fail('IB_DIAGNOSTIC_ASSOCIATION_INVALID', 'association_validate', 'policy_invalid');
    return boundedText(response, limit);
  }
  try {
    const ref = JSON.parse(await read(`${REPO}/git/ref/heads/main`, 4096));
    if (!plain(ref) || ref.ref !== 'refs/heads/main' || !plain(ref.object) || ref.object.type !== 'commit'
      || !/^[a-f0-9]{40}$/.test(ref.object.sha || '')) fail('IB_DIAGNOSTIC_ASSOCIATION_INVALID', 'association_validate', 'policy_invalid');
    const commit = ref.object.sha;
    const text = await read(`${RAW}/${commit}/${ASSOCIATION_POLICY_PATH}`, 16_384);
    const snapshot = {policy: JSON.parse(text), policyCommit: commit,
      policyBlob: gitBlob(Buffer.from(text)), checkedAt: new Date(now()).toISOString()};
    return validateAssociationSnapshot(snapshot, {now: now(), edition: 'adhoc'});
  } catch (error) { throw inIbPhase(error, 'association_validate', 'IB_DIAGNOSTIC_ASSOCIATION_INVALID', null, 'policy_invalid'); }
}

function nativeIdentity(raw) {
  let present = false, visited = 0;
  function walk(value, depth = 0) {
    if (++visited > 50_000 || depth > 32) fail('IB_DIAGNOSTIC_ACCOUNT_MISMATCH', 'orders_validate', 'contract_invalid');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'account_id' || key === 'accountId') {
        present = true;
        if (child !== APPROVED_IB_ACCOUNT_ID) fail('IB_DIAGNOSTIC_ACCOUNT_MISMATCH', 'orders_validate', 'contract_invalid');
      }
      if (child && typeof child === 'object') walk(child, depth + 1);
    }
  }
  walk(raw);
  return present;
}

async function checkCatalog(session) {
  let cursor;
  const seen = new Set();
  for (let page = 0; page < 2; page++) {
    const result = await session.request('tools/list', cursor === undefined ? {} : {cursor});
    if (!plain(result) || !Array.isArray(result.tools) || result.tools.length > 10_000
      || result.tools.some(tool => !plain(tool) || typeof tool.name !== 'string' || !tool.name || tool.name.length > 256))
      fail('IB_DIAGNOSTIC_CATALOG_INVALID', 'mcp_tools_list', 'contract_invalid');
    const next = result.nextCursor;
    if (next !== undefined && (typeof next !== 'string' || !next || next.length > 1024 || seen.has(next)))
      fail('IB_DIAGNOSTIC_CATALOG_INVALID', 'mcp_tools_list', 'contract_invalid');
    const targets = result.tools.filter(tool => tool.name === 'get_account_orders');
    if (targets.length > 1) fail('IB_DIAGNOSTIC_CATALOG_INVALID', 'mcp_tools_list', 'contract_invalid');
    if (targets.length === 1) {
      const schema = targets[0].inputSchema;
      // A closed subset proves that {} is accepted. Unknown root keywords,
      // including const/enum and references, stop before any financial call.
      const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'minProperties',
        'maxProperties', '$schema', 'title', 'description', '$comment', 'default', 'examples',
        'deprecated', 'readOnly', 'writeOnly']);
      const dialects = ['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft-07/schema#',
        'https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema'];
      if (!plain(schema) || schema.type !== 'object'
        || Object.keys(schema).some(key => !allowed.has(key))
        || (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length !== 0))
        || (schema.properties !== undefined && (!plain(schema.properties)
          || Object.values(schema.properties).some(value => typeof value !== 'boolean' && !plain(value))))
        || (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean')
        || (schema.minProperties !== undefined && schema.minProperties !== 0)
        || (schema.maxProperties !== undefined && (!Number.isSafeInteger(schema.maxProperties) || schema.maxProperties < 0))
        || (schema.$schema !== undefined && !dialects.includes(schema.$schema))
        || ['title', 'description', '$comment'].some(key => Object.hasOwn(schema, key) && typeof schema[key] !== 'string')
        || (schema.examples !== undefined && !Array.isArray(schema.examples))
        || ['deprecated', 'readOnly', 'writeOnly'].some(key => Object.hasOwn(schema, key) && typeof schema[key] !== 'boolean'))
        fail('IB_DIAGNOSTIC_ORDERS_SCHEMA_UNSUPPORTED', 'mcp_tools_list', 'contract_invalid');
      return;
    }
    if (next === undefined) fail('IB_DIAGNOSTIC_ORDERS_TOOL_MISSING', 'mcp_tools_list', 'contract_invalid');
    seen.add(next); cursor = next;
  }
  fail('IB_DIAGNOSTIC_CATALOG_INCOMPLETE', 'mcp_tools_list', 'contract_invalid');
}

/** Capabilities are explicit injection seams for offline tests, never flags for
 * arbitrary secrets/endpoints/accounts. The live CLI supplies only existing IO.
 * A create-only, non-financial marker consumes this attempt before any secret
 * load. It is deliberately never removed or resumed, even after an unknown save.
 */
export async function runIbOrdersCheck({mode = 'orders_check', attemptId, allowAttemptMarker = false,
  allowRefreshSave = false, withCatalog = false, io, loadAssociation = loadOrdersAssociation,
  fetchImpl = fetch, now = Date.now, timeoutMs = 30_000} = {}) {
  if (!['auth_check', 'orders_check'].includes(mode) || typeof attemptId !== 'string' || !/^[a-f0-9]{32}$/.test(attemptId)
    || allowAttemptMarker !== true || typeof allowRefreshSave !== 'boolean' || typeof withCatalog !== 'boolean'
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 || !Number.isSafeInteger(now()))
    fail('IB_DIAGNOSTIC_REQUEST_INVALID');
  if (!io?.ibStore || typeof io.ibStore.load !== 'function' || typeof io.savePrivate !== 'function'
    || (allowRefreshSave && typeof io.ibStore.save !== 'function') || typeof loadAssociation !== 'function' || typeof fetchImpl !== 'function')
    fail('IB_DIAGNOSTIC_CAPABILITY_REQUIRED');
  const startedAt = new Date(now()).toISOString();
  const counts = {load: 0, save: 0, refresh: 0, initialize: 0, initialized: 0, catalog: 0, orders: 0};
  let closed = false, rotationSaved = false, activePhase = 'diagnostic_request';
  const abort = new AbortController();
  const guard = () => { if (closed) fail('IB_DIAGNOSTIC_LIMIT_EXCEEDED', 'diagnostic_request', 'counter_limit'); };
  const consume = (key, max) => { guard(); if (++counts[key] > max) fail('IB_DIAGNOSTIC_LIMIT_EXCEEDED', 'diagnostic_request', 'counter_limit'); };
  async function step(phase, operation, unknownCode = 'IB_DIAGNOSTIC_TIMEOUT', category = 'timeout') {
    guard(); activePhase = phase;
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
        timer = setTimeout(() => {
          closed = true; abort.abort();
          const saving = activePhase === 'credential_save';
          reject(ibError(saving ? 'IB_TOKEN_ROTATION_OUTCOME_UNKNOWN' : unknownCode,
            {phase: activePhase, category: saving ? 'save_outcome_unknown' : category}));
        }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  const fetchIb = async (url, options) => {
    guard();
    if (options?.method !== 'POST' || options.redirect !== 'error') fail('IB_DIAGNOSTIC_REQUEST_INVALID');
    if (url === TOKEN_ENDPOINT) {
      activePhase = 'oauth_refresh';
      if (!allowRefreshSave || !(options.body instanceof URLSearchParams)
        || options.body.get('grant_type') !== 'refresh_token' || options.body.get('scope') !== 'mcp.read'
        || options.body.get('resource') !== RESOURCE) fail('IB_DIAGNOSTIC_REQUEST_INVALID');
      consume('refresh', 1);
    } else if (url === RESOURCE) {
      let request;
      try { request = JSON.parse(options.body); } catch { fail('IB_DIAGNOSTIC_REQUEST_INVALID'); }
      if (request.method === 'initialize') { activePhase = 'mcp_initialize'; consume('initialize', 1); }
      else if (request.method === 'notifications/initialized') { activePhase = 'mcp_initialized'; consume('initialized', 1); }
      else if (request.method === 'tools/list' && withCatalog) { activePhase = 'mcp_tools_list'; consume('catalog', 2); }
      else if (request.method === 'tools/call' && mode === 'orders_check'
        && request.params?.name === 'get_account_orders' && plain(request.params.arguments)
        && Object.keys(request.params.arguments).length === 0) { activePhase = 'mcp_orders_read'; consume('orders', 1); }
      else fail('IB_DIAGNOSTIC_REQUEST_INVALID');
    } else fail('IB_DIAGNOSTIC_REQUEST_INVALID');
    return fetchImpl(url, {...options, signal: AbortSignal.any([options.signal, abort.signal])});
  };
  const store = {
    async load() { consume('load', 1); return step('credential_load', () => io.ibStore.load()); },
    async save(value) {
      if (!allowRefreshSave) fail('IB_REFRESH_NOT_AUTHORIZED', 'credential_save');
      consume('save', 1);
      const receipt = await step('credential_save', () => io.ibStore.save(value), 'IB_TOKEN_ROTATION_OUTCOME_UNKNOWN', 'save_outcome_unknown');
      guard();
      validateIbRotationReceipt(receipt);
      rotationSaved = true;
    },
  };
  try {
    const marker = {schemaVersion: 1, purpose: 'ib-auth-orders-check', mode, attemptId,
      startedAt, withCatalog, allowRefreshSave};
    let claim;
    try { claim = await step('attempt_claim', () => io.savePrivate(`report-check/auth-orders-${attemptId}/attempt.json`, marker),
      'IB_DIAGNOSTIC_ATTEMPT_OUTCOME_UNKNOWN', 'attempt_outcome_unknown'); }
    catch (error) {
      if (error?.message === 'CLOUD_HTTP_412') fail('IB_DIAGNOSTIC_ATTEMPT_CONSUMED', 'attempt_claim', 'attempt_consumed');
      throw inIbPhase(error, 'attempt_claim', 'IB_DIAGNOSTIC_ATTEMPT_FAILED', null, 'attempt_outcome_unknown');
    }
    if (claim?.sha256 !== hash(marker) || typeof claim.generation !== 'string' || !/^\d{1,30}$/.test(claim.generation))
      fail('IB_DIAGNOSTIC_ATTEMPT_OUTCOME_UNKNOWN', 'attempt_claim', 'attempt_outcome_unknown');
    const association = await step('association_validate', () => loadAssociation({now}));
    try { validateAssociationSnapshot(association, {now: now(), edition: 'adhoc'}); }
    catch { fail('IB_DIAGNOSTIC_ASSOCIATION_INVALID', 'association_validate', 'policy_invalid'); }
    const credential = await step('oauth_refresh', () => loadReadCredential(store,
      {fetchImpl: fetchIb, now, allowRefresh: allowRefreshSave}));
    const session = new IbOrdersDiagnosticSession(credential, {fetchImpl: fetchIb});
    await step('mcp_initialize', () => session.initialize());
    if (withCatalog) await step('mcp_tools_list', () => checkCatalog(session));
    let present = false, nonempty = false;
    if (mode === 'orders_check') {
      const source = await step('mcp_orders_read', () => session.read('get_account_orders'));
      present = nativeIdentity(source.raw);
      try { ordersOf(source.raw, {positions: []}, {dataDate: new Date(now() + 8 * 3_600_000).toISOString().slice(0, 10), previousHtml: ''}); }
      catch { fail('IB_DIAGNOSTIC_ORDERS_INVALID', 'orders_validate', 'contract_invalid'); }
      nonempty = source.raw.orders.length > 0;
    }
    const current = await step('association_validate', () => loadAssociation({now}));
    try { validateAssociationSnapshot(current, {now: now(), edition: 'adhoc'}); }
    catch { fail('IB_DIAGNOSTIC_ASSOCIATION_INVALID', 'association_validate', 'policy_invalid'); }
    if (current.policyBlob !== association.policyBlob) fail('IB_DIAGNOSTIC_ASSOCIATION_CHANGED', 'association_validate', 'policy_invalid');
    return {schemaVersion: 1, status: 'checked', mode, startedAt, completedAt: new Date(now()).toISOString(),
      authenticationSucceeded: true, scopeReadOnly: true, ownerAssociationValid: true,
      nativeIdentityPresent: mode === 'orders_check' ? present : null, nativeIdentifiersMatch: mode === 'orders_check' ? present : null,
      nativeIdentityUnavailable: !present, ordersReadSucceeded: mode === 'orders_check',
      ordersResponseValid: mode === 'orders_check', orderRowsContractValid: mode === 'orders_check',
      nonemptySchemaObserved: nonempty, catalogChecked: withCatalog, catalogToolPresent: withCatalog ? true : null,
      refreshAttempted: counts.refresh === 1, rotationSaved, publication: 'none', scheduler: 'none'};
  } finally { closed = true; abort.abort(); }
}

export async function ordersCheckCli(args, {env = process.env, ioFactory = privateCloudIo, run = runIbOrdersCheck,
  now = Date.now} = {}) {
  try {
    if (!exactArgs(args, ORDERS_CHECK_ARGS)) fail('IB_DIAGNOSTIC_REQUEST_INVALID');
    if (env.CLOUD_RUN_JOB !== DIAGNOSTIC_JOB
      || !new RegExp(`^${DIAGNOSTIC_JOB}-[a-z0-9-]{1,100}$`).test(env.CLOUD_RUN_EXECUTION || '')
      || env.CLOUD_RUN_TASK_COUNT !== '1' || env.CLOUD_RUN_TASK_INDEX !== '0'
      || env.CLOUD_RUN_TASK_ATTEMPT !== '0') fail('IB_DIAGNOSTIC_RUNTIME_REQUIRED');
    const time = now();
    if (!Number.isFinite(time) || time < Date.parse(ORDERS_DIAGNOSTIC_PLAN.notBefore)
      || time >= Date.parse(ORDERS_DIAGNOSTIC_PLAN.notAfter)) fail('IB_DIAGNOSTIC_REQUEST_INVALID');
    return await run({mode: 'orders_check', attemptId: ORDERS_DIAGNOSTIC_PLAN.attemptId,
      allowAttemptMarker: true, withCatalog: true, allowRefreshSave: true, io: ioFactory(), now});
  } catch (error) { return {...safeIbFailure(error, {execution: env.CLOUD_RUN_EXECUTION}), scheduler: 'none'}; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await ordersCheckCli(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status === 'failed') process.exitCode = 1;
}
