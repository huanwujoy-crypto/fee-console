import test from 'node:test';
import assert from 'node:assert/strict';
import {currentReserve, loadTrustedContext, readSharesightAction, runPrivateReport} from './report.mjs';
import {associationPolicyBlob, associationPolicyText} from '../../scripts/xuan-ib-account-association.mjs';
import {extractNightActionModel} from '../../scripts/xuan-ib-night-action-view.mjs';
import crypto from 'node:crypto';

const now = () => Date.parse('2026-09-30T05:00:00.000Z');
const ledger = {schemaVersion: 1, purpose: 'xuan-etf-owner-declared-pending-calls', entries: [{date: '2026-09-17', usd: 50}]};
const policy = {schemaVersion: 1, policyId: 'ib-primary-7day-pilot-v1', accountAlias: 'IB-HK', basis: 'owner-attested-recurring-v1',
  status: 'active', purpose: 'xuan-ib-read-only-report', editions: ['adhoc', 'am', 'pm'], publisher: 'codex-verified-candidate-v1',
  validFrom: '2026-09-11T13:30:00.000Z', expiresAt: '2026-10-10T13:30:00.000Z'};
const context = () => ({association: {policy: structuredClone(policy), policyCommit: 'a'.repeat(40), policyBlob: associationPolicyBlob(policy),
  checkedAt: new Date(now()).toISOString()}, reserveLedger: structuredClone(ledger), reserveHash: 'b'.repeat(64), previousSourceSha: 'c'.repeat(40), previousHtml: ''});
const holding = (id, group_name, value, code) => ({id, group_name, value, instrument: {code}});
const source = (sourceKey, raw) => ({sourceKey, raw, startedAt: new Date(now()).toISOString(), completedAt: new Date(now()).toISOString()});
const coverage = {origin: 'IBKR', schemaVersion: 1, complete: true, paginationComplete: true, targetTradeDate: '2026-09-29', coveredThroughDate: '2026-09-29', snapshotId: 'synthetic', asOf: new Date(now()).toISOString()};
const ib = () => ({status: 'captured', sources: [
  source('ib.accountSummary', {coverage, currency: 'USD', net_liquidation: 1000, total_cash_value: 100}),
  source('ib.positions', {coverage, positions: [{contract_description: 'EXUS', position: 100, market_price: 10, market_value: 1000, currency: 'USD'}]}),
  source('ib.orders', {coverage, orders: [{order_id: 1, order_status: 'NEW', order_type: 'LIMIT', side: 'BUY', limit_price: '10.50', total_shares_qty: '1',
    cum_shares_qty: '0', remaining_shares_qty: '1', primary_description: 'Buy 1 EXUS', secondary_description: 'description', order_time: '2026-09-20T13:30:00Z'}]}),
  source('ib.trades', {coverage, trades: []}),
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
  assert.equal(receipt.status, 'ready'); assert.equal(receipt.sourceCount, 6);
  assert.equal(receipt.publication, 'none'); assert.equal(receipt.scheduler, 'none');
  assert.equal(h.objects.length, 8); assert.deepEqual(h.calls, ['key', 'context', 'ib', 'context']);
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
  const urls = [];
  const fetchImpl = async url => {urls.push(url); let result;
    if (url.endsWith('/commits/main')) result = {sha: 'a'.repeat(40)};
    else if (url.endsWith('xuan-ib-account-association-v1.json')) return new Response(associationPolicyText(policy));
    else if (url.endsWith('xuan-ib-etf-pending-calls-v1.json')) result = ledger;
    else if (url.endsWith('latest.meta.json')) result = {sourceSha: 'c'.repeat(40), htmlBlob};
    else return new Response(html);
    return new Response(JSON.stringify(result));};
  const c = await loadTrustedContext({fetchImpl, now});
  assert.equal(c.previousHtml, html); assert.equal(c.previousSourceSha, 'c'.repeat(40));
  assert.ok(urls.slice(1).every(url => url.includes('/' + 'a'.repeat(40) + '/')));
});
test('real existing MCP shapes without coverage do not generate action suggestions', async () => {
  const h=harness({captureIb:async()=>{const s=ib();for(const source of s.sources)delete source.raw.coverage;return s;}});
  const receipt=await runPrivateReport(h.options);
  assert.equal(receipt.status,'data-not-ready');assert.equal(receipt.readiness.issues.length,4);
  assert.ok(h.objects.every(x=>!x.name.endsWith('report.html')));
  assert.ok(!JSON.stringify(receipt).includes('net_liquidation'));
});
