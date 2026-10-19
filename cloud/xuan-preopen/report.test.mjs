import test from 'node:test';
import assert from 'node:assert/strict';
import {currentReserve, loadTrustedContext, readSharesightAction, runPrivateReport} from './report.mjs';
import {associationPolicyBlob, associationPolicyText} from '../../scripts/xuan-ib-account-association.mjs';
import {extractNightActionModel} from '../../scripts/xuan-ib-night-action-view.mjs';
import crypto from 'node:crypto';
import {createOwnerFailureEvidence} from './cloud_io.mjs';

const now = () => Date.parse('2026-09-30T05:00:00.000Z');
const ledger = {schemaVersion: 1, purpose: 'xuan-etf-owner-declared-pending-calls', entries: [{date: '2026-09-17', usd: 50}]};
const policy = {schemaVersion: 1, policyId: 'ib-primary-7day-pilot-v1', accountAlias: 'IB-HK', basis: 'owner-attested-recurring-v1',
  status: 'active', purpose: 'xuan-ib-read-only-report', editions: ['adhoc', 'am', 'pm'], publisher: 'codex-verified-candidate-v1',
  validFrom: '2026-09-11T13:30:00.000Z', expiresAt: '2026-10-10T13:30:00.000Z'};
const context = () => ({association: {policy: structuredClone(policy), policyCommit: 'a'.repeat(40), policyBlob: associationPolicyBlob(policy),
  checkedAt: new Date(now()).toISOString()}, reserveLedger: structuredClone(ledger), reserveHash: 'b'.repeat(64), previousSourceSha: 'c'.repeat(40), previousHtml: ''});
const holding = (id, group_name, value, code) => ({id, group_name, value, instrument: {code}});
const source = (sourceKey, raw) => ({sourceKey, raw, startedAt: new Date(now()).toISOString(), completedAt: new Date(now()).toISOString()});
const ib = () => ({status: 'captured', sources: [
  source('ib.accountSummary', {currency: 'USD', net_liquidation: 1000, total_cash_value: 100}),
  source('ib.positions', {positions: [{contract_description: 'EXUS', position: 100, market_price: 10, market_value: 1000, currency: 'USD'}]}),
  source('ib.orders', {orders: [{order_id: 1, order_status: 'NEW', order_type: 'LIMIT', side: 'BUY', limit_price: '10.50', total_shares_qty: '1',
    cum_shares_qty: '0', remaining_shares_qty: '1', primary_description: 'Buy 1 EXUS', secondary_description: 'description', order_time: '2026-09-20T13:30:00Z'}]}),
]});
const sharesight = () => [
  source('sharesight.ibGroupedPerformance', {report: {portfolio_id: 936247, currency: {code: 'USD'}, grouping: 'custom_group_category',
    custom_group: {id: 83569, name: '资产类别'}, end_date: '2026-09-29', holdings: [holding(1, '美国底仓', 450, 'CSPX'), holding(2, '美国底仓', 50, 'USSC'),
      holding(3, '美国科技', 250, 'GOOG'), holding(4, '非美发达', 180, 'EXUS'), holding(5, '新兴市场', 70, 'EIMI'), holding(6, '防御资产', 90, 'TLT')], cash_accounts: []}}),
  source('sharesight.noahPerformance', {report: {portfolio_id: 936238, currency: {code: 'USD'}, end_date: '2026-09-29', cash_accounts: [{value: 50}]}}),
];
function harness(overrides = {}) {
  const objects = [], calls = [];
  const io = {ibStore: {}, loadGatewayToken: async () => {calls.push('key'); return 'test-read-key';},
    savePrivate: async (name, value) => {objects.push({name, value}); return {sha256: 'f'.repeat(64), generation: '1'};}};
  return {objects, calls, options: {sourceDate: '2026-09-29', io, now,
    loadContext: async () => {calls.push('context'); return context();},
    captureIb: async () => {calls.push('ib'); return ib();}, readSharesight: async () => sharesight(), ...overrides}};
}
test('five sources produce only a private deterministic four-card artifact', async () => {
  const h = harness(), receipt = await runPrivateReport(h.options);
  assert.equal(receipt.status, 'ready'); assert.equal(receipt.sourceCount, 5);
  assert.equal(receipt.publication, 'none'); assert.equal(receipt.scheduler, 'none');
  assert.equal(h.objects.length, 7); assert.deepEqual(h.calls, ['key', 'context', 'ib', 'context']);
  const html = h.objects.find(item => item.name.endsWith('report.html')).value;
  const model = extractNightActionModel(html);
  assert.equal(model.cash.pool, 150); assert.equal(model.cash.callApplied, 25);
  assert.equal(model.cash.orderReserve, 10.5); assert.equal(model.cash.planning, 114.5);
  assert.equal(model.cash.cashLike.total, 90); assert.equal(model.schemaVersion, 5);
  assert.ok(!JSON.stringify(receipt).includes('test-read-key')); assert.ok(!JSON.stringify(receipt).includes('market_price'));
});
test('gateway permission failure precedes any IB access or persistence', async () => {
  const h = harness(); h.options.io.loadGatewayToken = async () => {throw new Error('CLOUD_HTTP_403');};
  await assert.rejects(runPrivateReport(h.options), /CLOUD_HTTP_403/);
  assert.deepEqual(h.calls, []); assert.deepEqual(h.objects, []);
});
test('an expired account association cannot call either financial source', async () => {
  const h = harness({loadContext: async () => {const c = context(); c.association.policy.expiresAt = '2026-09-29T13:30:00.000Z';
    c.association.policyBlob = associationPolicyBlob(c.association.policy); return c;}});
  await assert.rejects(runPrivateReport(h.options), /expired/); assert.deepEqual(h.calls, ['key']); assert.equal(h.objects.length, 0);
});
test('source-day mismatch saves no artifact and never reuses an old amount', async () => {
  const h = harness({readSharesight: async () => {const s = sharesight(); s[1].raw.report.end_date = '2026-09-28'; return s;}});
  await assert.rejects(runPrivateReport(h.options), /SOURCE_DATE_NOT_READY/); assert.equal(h.objects.length, 0);
});
test('missing or duplicate sources cannot pass completeness', async () => {
  for (const sources of [ib().sources.slice(0, 2), [ib().sources[0], ib().sources[0], ib().sources[2]]]) {
    const h = harness({captureIb: async () => ({status: 'captured', sources})});
    await assert.rejects(runPrivateReport(h.options), /ACTION_SOURCES_INCOMPLETE/); assert.equal(h.objects.length, 0);
  }
});
test('a changed base or reserve is rejected on independent trusted-main recheck', async () => {
  for (const field of ['previousSourceSha', 'reserveHash']) {
    let count = 0;
    const h = harness({loadContext: async () => {const c = context(); if (++count === 2) c[field] = 'd'.repeat(field === 'reserveHash' ? 64 : 40); return c;}});
    await assert.rejects(runPrivateReport(h.options), /REPORT_BASE_CHANGED/); assert.equal(h.objects.length, 0);
  }
});
test('private upload failure cannot return a successful receipt', async () => {
  const h = harness(); h.options.io.savePrivate = async () => {throw new Error('CLOUD_HTTP_403');};
  await assert.rejects(runPrivateReport(h.options), /CLOUD_HTTP_403/);
});
test('source-date scope cannot become today, future, malformed or nonexistent', async () => {
  for (const sourceDate of ['2026-09-30', '2026-10-01', '2026-02-30', undefined, 'yesterday']) {
    const h = harness({sourceDate}); await assert.rejects(runPrivateReport(h.options), /COMPLETED_SOURCE_DATE_REQUIRED/); assert.equal(h.calls.length, 0);
  }
});
test('reserve lookup keeps the last effective ledger entry and refuses absent values', () => {
  assert.equal(currentReserve(ledger, '2026-09-30'), 50);
  assert.throws(() => currentReserve(ledger, '2026-09-01'), /UNAVAILABLE/);
  assert.throws(() => currentReserve({...ledger, entries: [{date: '2026-09-17', usd: -1}]}, '2026-09-30'), /INVALID/);
});
test('Sharesight transport fixes both GET scopes and requests the exact classification', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {requests.push({url: String(url), options}); return new Response(JSON.stringify({mode: 'read_only', source: 'Sharesight User API', report: {}}));};
  const result = await readSharesightAction('2026-09-29', 'test-token', {fetchImpl, now});
  assert.equal(result.length, 2);
  assert.deepEqual(requests.map(r => new URL(r.url).searchParams.get('portfolio')), ['IB-HK', 'NOAH-HK']);
  assert.deepEqual(requests.map(r => new URL(r.url).searchParams.get('grouping')), ['83569', 'investment_type']);
  assert.ok(requests.every(r => r.options.method === undefined && new URL(r.url).pathname === '/v1/performance' && r.options.redirect === 'error'));
});
test('gateway validation failure remains a failure, not default or direct-OAuth fallback', async () => {
  await assert.rejects(readSharesightAction('2026-09-29', 'test-token', {fetchImpl: async () => new Response('invalid', {status: 422}), now}), /HTTP_422/);
  await assert.rejects(readSharesightAction('2026-09-29', 'test-token', {fetchImpl: async () => new Response(JSON.stringify({mode: 'write'})), now}), /SCOPE_INVALID/);
});
test('trusted context is pinned to current main and checks the previous published HTML blob', async () => {
  const html = '<html>verified previous report</html>', bytes = Buffer.from(html);
  const htmlBlob = crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
  const urls = [],signals=[],controller=new AbortController();
  const fetchImpl = async (url,options) => {urls.push(url);signals.push(options.signal);assert.equal(options.signal.aborted,false);let result;
    if (url.endsWith('/commits/main')) result = {sha: 'a'.repeat(40)};
    else if (url.endsWith('xuan-ib-account-association-v1.json')) return new Response(associationPolicyText(policy));
    else if (url.endsWith('xuan-ib-etf-pending-calls-v1.json')) result = ledger;
    else if (url.endsWith('latest.meta.json')) result = {sourceSha: 'c'.repeat(40), htmlBlob};
    else return new Response(html);
    return new Response(JSON.stringify(result));};
  const c = await loadTrustedContext({fetchImpl, now,signal:controller.signal});
  assert.equal(c.previousHtml, html); assert.equal(c.previousSourceSha, 'c'.repeat(40));
  assert.ok(urls.slice(1).every(url => url.includes('/' + 'a'.repeat(40) + '/')));
  assert.equal(signals.length,5);controller.abort();assert.ok(signals.every(signal=>signal.aborted));
});

test('trusted source cancellation stops before fetch or reaches an already pending fetch without retry',async()=>{
  const before=new AbortController();before.abort();let calls=0;
  await assert.rejects(loadTrustedContext({now,signal:before.signal,fetchImpl:()=>{calls++;assert.fail('pre-aborted fetch');}}));assert.equal(calls,0);
  const parent=new AbortController();let enter;const entered=new Promise(resolve=>{enter=resolve;});
  const pending=loadTrustedContext({now,signal:parent.signal,fetchImpl:async(url,{signal})=>{calls++;enter(signal);return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  const child=await entered;assert.equal(child.aborted,false);parent.abort();await assert.rejects(pending,/REPORT_SOURCE_NETWORK_FAILED/);assert.equal(child.aborted,true);assert.equal(calls,1);
  const optional=new AbortController(),html='synthetic optional cancellation',bytes=Buffer.from(html);const htmlBlob=crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
  await assert.rejects(loadTrustedContext({now,signal:optional.signal,fetchImpl:async(url,{signal})=>{
    if(url.endsWith('/commits/main'))return new Response(JSON.stringify({sha:'a'.repeat(40)}));
    if(url.endsWith('xuan-ib-etf-pending-calls-v1.json')){queueMicrotask(()=>optional.abort());return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}
    if(url.endsWith('xuan-ib-account-association-v1.json'))return new Response(associationPolicyText(policy));
    if(url.endsWith('latest.meta.json'))return new Response(JSON.stringify({sourceSha:'c'.repeat(40),htmlBlob}));
    if(url.endsWith('latest.html'))return new Response(html);assert.fail('unexpected synthetic context URL');
  }}));

});
test('trusted-main network failure retains its finite original origin and fixed 30-second read facts',async()=>{
  let calls=0,clockCalls=0;
  const original=Object.assign(new TypeError('SYNTHETIC_PRIVATE_URL_CREDENTIAL'),{cause:{code:'ETIMEDOUT'}});
  await assert.rejects(loadTrustedContext({now:()=>{clockCalls++;return now();},fetchImpl:async()=>{calls++;throw original;}}),error=>{
    assert.equal(error.message,'REPORT_SOURCE_NETWORK_FAILED');assert.equal(error.safeCode,'REPORT_SOURCE_NETWORK_FAILED');
    const evidence=createOwnerFailureEvidence(error);
    assert.equal(evidence.origin.type,'TypeError');assert.equal(evidence.origin.causeCode,'ETIMEDOUT');
    assert.deepEqual(evidence.read.origin,evidence.origin);assert.equal(evidence.read.requestClass,'github-main');
    assert.equal(evidence.read.readStage,'fetch');assert.equal(evidence.read.httpStatus,null);
    assert.equal(evidence.read.observedBodyBytes,null);assert.equal(evidence.read.bodyLimitBytes,8000000);assert.equal(evidence.read.timeoutMs,30000);
    assert.ok(!JSON.stringify(evidence).includes('PRIVATE'));return true;
  });
  assert.equal(calls,1);assert.equal(clockCalls,0);
});
test('trusted-main HTTP and malformed JSON retain the original error outcome plus finite read facts',async()=>{
  for(const malformed of [false,true]){
    let calls=0;const bytes=Uint8Array.of(239,187,191,123);
    await assert.rejects(loadTrustedContext({now,fetchImpl:async()=>{calls++;return malformed?new Response(bytes):new Response('SYNTHETIC_PRIVATE_BODY',{status:503});}}),error=>{
      assert.equal(error.message,malformed?'REPORT_SOURCE_JSON_INVALID':'REPORT_SOURCE_HTTP_503');
      const evidence=createOwnerFailureEvidence(error);
      assert.equal(evidence.read.requestClass,'github-main');assert.equal(evidence.read.readStage,malformed?'body':'http');
      assert.equal(evidence.read.httpStatus,malformed?200:503);assert.equal(evidence.read.observedBodyBytes,malformed?4:null);
      assert.equal(evidence.read.bodyLimitBytes,8000000);assert.equal(evidence.read.timeoutMs,30000);
      if(malformed)assert.equal(evidence.read.origin.type,'SyntaxError');
      assert.ok(!JSON.stringify(evidence).includes('PRIVATE'));return true;
    });
    assert.equal(calls,1);
  }
});
test('body error and hostile status or diagnostic getters cannot be replaced by diagnostic collection',async()=>{
  let traps=0,calls=0;const forbidden=()=>{traps++;throw Error('SYNTHETIC_PRIVATE_TRAP');};
  const original=Object.defineProperties(new TypeError('SYNTHETIC_BODY_SECRET'),{ownerReadDiagnostics:{get:forbidden,configurable:true},safeOrigin:{get:forbidden},cause:{get:forbidden}});
  const response={ok:true,body:{getReader:()=>({read:async()=>{throw original;},cancel:async()=>{}})}};
  Object.defineProperty(response,'status',{get:forbidden});
  await assert.rejects(loadTrustedContext({now,fetchImpl:async()=>{calls++;return response;}}),error=>{
    assert.equal(error,original);assert.equal(createOwnerFailureEvidence(error).read.readStage,'body');return true;
  });
  const proxy=new Proxy({}, {get:forbidden,getOwnPropertyDescriptor:forbidden,getPrototypeOf:forbidden,defineProperty:forbidden});
  await assert.rejects(loadTrustedContext({now,fetchImpl:async()=>{throw proxy;}}),error=>error.message==='REPORT_SOURCE_NETWORK_FAILED');
  assert.equal(calls,1);assert.equal(traps,0);
});
