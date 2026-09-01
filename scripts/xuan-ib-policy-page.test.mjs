import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { policyFingerprint, renderPolicyPage, renderPolicySection, validatePolicy, validatePolicyPage } from './xuan-ib-policy-page.mjs';

const policyPath = new URL('../claude/xuan-ib-policy-v2.json', import.meta.url);
const pagePath = new URL('../xuan-ib/policy.html', import.meta.url);
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
const checkedInPage = fs.readFileSync(pagePath, 'utf8');

test('approved policy has the exact allocation and read-only boundary', () => {
  assert.equal(validatePolicy(policy), policy);
  assert.deepEqual(policy.allocation.total, { us: .65, developedExUs: .23, emergingMarkets: .12 });
  assert.equal(policy.allocation.us.smallValue, .05);
  assert.deepEqual(policy.allocation.us.aiGrowthTilt, { minimum: 0, initialAfterValidation: .08, maximum: .08 });
  assert.deepEqual(policy.allocation.us.largeCapCore, { formula: '0.60 - aiGrowthTilt', minimum: .52, maximum: .60 });
  assert.equal(policy.status, 'approved-not-implemented');
  assert.equal(policy.mode, 'read-only-planning');
  assert.deepEqual(policy.benchmark.metrics, ['after-tax-return', 'max-drawdown', 'ai-participation', 'us-situs-share', 'call-coverage']);
  assert.equal(policy.benchmark.minimumCompleteQuartersForRanking, 4);
  assert.deepEqual([policy.controls.allowOrders, policy.controls.allowOrderChanges, policy.controls.allowTransfers], [false, false, false]);
});

test('CALL ledger is incomplete and cannot be turned into a zero or deployable amount', () => {
  assert.deepEqual({ status: policy.callReserve.status, gate: policy.callReserve.gate }, { status: 'incomplete', gate: 'fail-closed' });
  for (const key of ['verified90dCallsUsd', 'approvedBufferUsd', 'fxOpsBufferUsd']) assert.equal(policy.callReserve[key], null);
  for (const patch of [
    { status: 'complete' },
    { gate: 'open' },
    { verified90dCallsUsd: 0 },
    { approvedBufferUsd: 0 },
    { fxOpsBufferUsd: 0 },
  ]) assert.throws(() => validatePolicy({ ...policy, callReserve: { ...policy.callReserve, ...patch } }), /CALL ledger/);
});

test('unknown, changed or live fields fail closed', () => {
  assert.throws(() => validatePolicy({ ...policy, nav: 5000000 }), /schema/);
  assert.throws(() => validatePolicy({ ...policy, status: 'implemented' }), /not implemented/);
  assert.throws(() => validatePolicy({ ...policy, allocation: { ...policy.allocation, total: { ...policy.allocation.total, us: .64 } } }), /US target/);
  assert.throws(() => validatePolicy({ ...policy, controls: { ...policy.controls, allowOrders: true } }), /read-only/);
  assert.throws(() => validatePolicy({ ...policy, products: policy.products.map((product, index) => index ? product : { ...product, isin: 'US0000000000' }) }), /approved identity/);
  assert.throws(() => validatePolicy({ ...policy, products: policy.products.map((product, index) => index ? product : { ...product, venue: 'NYSE' }) }), /approved identity/);
  assert.throws(() => validatePolicy({ ...policy, benchmark: { ...policy.benchmark, metrics: [...policy.benchmark.metrics, 'sixth'] } }), /benchmark/);
});

test('one deterministic renderer serves a scoped inline section and standalone page', () => {
  const section = renderPolicySection(policy);
  const html = renderPolicyPage(policy);
  assert.ok(html.includes(section), 'standalone page must contain the byte-identical shared section');
  assert.deepEqual(validatePolicyPage(section, policy), []);
  assert.deepEqual(validatePolicyPage(html, policy), []);
  assert.match(html, /max-width:390px/);
  assert.match(html, /#xuan-ib-policy-v2\{[^}]*box-sizing:border-box/);
  assert.match(html, /已批准 · 尚未接入日报计算/);
  assert.match(html, /资料未齐 · 暂停金额计算/);
  assert.match(html, /CALL 账本未核实/);
  assert.match(html, /不显示可投入金额/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /width:100%;max-width:390px/);
  assert.doesNotMatch(html, /<script|fetch\(|https?:\/\/|<button/i);
  assert.ok(html.includes(policyFingerprint(policy)));
  const css = section.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  assert.ok(css);
  assert.doesNotMatch(css, /(?:^|})\s*(?:html|body|main|:root|\*)\s*\{/);
  for (const name of ['.xpv2-top', '.xpv2-card', 'details', 'summary', '.xpv2-row']) assert.ok(css.includes(`#xuan-ib-policy-v2 ${name}`), name);
});

test('checked-in page carries the exact policy fingerprint and safe mobile contract', () => {
  const section = renderPolicySection(policy);
  assert.deepEqual(validatePolicyPage(checkedInPage, policy), []);
  assert.ok(checkedInPage.includes(section), 'checked-in page must consume the shared section byte-for-byte');
  assert.match(checkedInPage, /viewport-fit=cover/);
  assert.match(checkedInPage, /<section class="xpv2-card xpv2-call" id="xuan-ib-policy-v2-call-gate"/);
  assert.doesNotMatch(checkedInPage.match(/<section class="xpv2-card xpv2-call"[\s\S]*?<\/section>/)?.[0] ?? '', /<details/);
  for (const item of ['CSPX<br><small>IE00B5BMR087 · LSE', 'EQAC<br><small>IE00BFZXGZ54 · SWX', 'USSC<br><small>IE00BSPLC413 · LSE', '税务要点', '爱尔兰注册 UCITS', '美国 situs 风险仍需逐项核实']) assert.ok(checkedInPage.includes(item), item);
  for (const metric of ['税后收益', '最大回撤', 'AI 参与', 'US-situs 占比', 'CALL 覆盖', '至少 4 个完整季度后才排名']) assert.ok(checkedInPage.includes(metric), metric);
});

test('tampering, expanded secondary sections and dynamic capabilities are rejected', () => {
  const html = renderPolicyPage(policy);
  for (const changed of [
    html.replace('65%', '64%'),
    html.replace('<details>', '<details open>'),
    html.replace('</body>', '<script>fetch("/account")</script></body>'),
    html.replace('</body>', '<button>下单</button></body>'),
    html.replace('</body>', '<p>已投入 $100</p></body>'),
    html.replace(/<!-- xuan-ib-index-etf-policy-v2:[a-f0-9]+ -->/, ''),
  ]) assert.ok(validatePolicyPage(changed, policy).length, changed.slice(-80));
});
