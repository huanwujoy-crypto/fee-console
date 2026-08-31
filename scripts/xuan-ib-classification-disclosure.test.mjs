import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderClassificationDisclosure, validateClassificationDisclosure } from './xuan-ib-classification-disclosure.mjs';

const canonical = renderClassificationDisclosure();
const page = (body) => `<!doctype html><html><head><title>Report</title></head><body>${body}</body></html>`;
// Actual recurrence from the published 2026-08-31 16:48–16:55 HKT report.
const recurrentClaim = '<p>NOAH-HK / ANTARCTICA / UBS 三个组合中带「Semi Liquid」Sharesight 标签的持仓本次<b>精确计数仍为 56 个</b>，其中仍仅 8 个在 <code>holdingOverrides</code> 中有明确 hedge_fund/evergreen 归类；其余 48 个因 mapping 自带 <code>unknownSemiLiquid</code> 规则要求 fail-closed，本次继续沿用 08-24 快照。</p>';

test('canonical policy describes historical partial evidence and retains dated fallback', () => {
  assert.deepEqual(validateClassificationDisclosure(page(canonical)), []);
  for (const detail of ['2026-08-31 15:31–15:34 HKT', '38 项 Semi Liquid', '7 次逐仓例外', '31 次整组合规则', '未覆盖为 0', '57 行', '56 行已分类', '1 行 UBS', '其余四个', '2026-08-24', '其他指标']) assert.ok(canonical.includes(detail), detail);
  assert.match(canonical, /不是本次七组合全量核验/);
  assert.match(canonical, /通过受控维护更新本说明后/);
});

test('actual obsolete accounting cannot pass with or without an appended correct disclaimer', () => {
  assert.match(validateClassificationDisclosure(page(recurrentClaim))[0], /exactly one/);
  assert.match(validateClassificationDisclosure(page(recurrentClaim + canonical))[0], /only in the canonical/);
});

test('correcting disclosure preserves unrelated financial output and allows dated fallback', () => {
  const finance = '<p>IB NAV $5,033,559；四类补仓缺口 $543,526；四桶沿用2026-08-24，原因见报告说明。</p>';
  const old = page(finance + recurrentClaim);
  const corrected = old.replace(recurrentClaim, canonical);
  assert.ok(corrected.includes(finance));
  assert.deepEqual(validateClassificationDisclosure(corrected), []);
});

test('ordinary candidate cannot drop topic to avoid inherited four-bucket disclosure', () => {
  assert.match(validateClassificationDisclosure(page('<p>其他数据</p>'), { previousHtml: page('<p>四桶沿用2026-08-24</p>') })[0], /exactly one/);
  assert.deepEqual(validateClassificationDisclosure(page('<p>MRVL §0-A 未分类新标的</p>')), []);
});

test('missing, duplicate, inert, altered, hidden and wrong-date canonical blocks fail', () => {
  for (const body of [
    '<p>四桶沿用2026-08-24</p>',
    canonical + canonical,
    `<!--${canonical}-->`,
    `<template>${canonical}</template>`,
    `<script>const example = ${JSON.stringify(canonical)};</script>`,
    canonical + `<!--${canonical}-->`,
    canonical + `<template>${canonical}</template>`,
    canonical.replace('38 项', '56 项'),
    canonical.replace('38 项', '38<!-- hidden variation --> 项'),
    canonical.replace('31 次整组合规则', '0 次整组合规则'),
    canonical.replace('未覆盖为 0', '未覆盖为 48'),
    canonical.replace('2026-08-24', '2026-08-31'),
    canonical.replace('2026-08-31 15:31–15:34 HKT', '本次实时'),
    canonical.replace('其余四个', '全部七个'),
    canonical.replace('<section id=', '<section hidden id='),
  ]) assert.ok(validateClassificationDisclosure(page(body), { previousHtml: page(canonical) }).length, body);
});

test('freeform rule/count reasoning and split or encoded old words fail outside canonical', () => {
  for (const claim of [
    recurrentClaim,
    '<p>56个SemiLiquid，8个holdingOverrides，48个未覆盖</p>',
    '<p>Semi <b>Liquid</b> 仍缺48条</p>',
    '<p>S&#101;mi&nbsp;Liquid 仍缺48条</p>',
    '<p>Semi\u200bLiquid 仍缺48条</p>',
    '<p>portfolioRules 未生效</p>',
    '<p>半流动56减8等于48</p>',
    '<p>其余48个未覆盖</p>',
    '<p>仍未覆盖：４８项</p>',
    '<p>四桶还存在48项未分类</p>',
    '<p>四桶已实时重算</p>',
    '<p>四桶七组合分类已全部完成</p>',
    '<p>七组合分类已全部完成</p>',
    '<p>四桶七组合全量核验已经完成</p>',
  ]) assert.ok(validateClassificationDisclosure(page(canonical + claim)).length, claim);
});

test('unrelated numbers, immutable receipt JSON, IDs and other live fields remain allowed', () => {
  const other = '<p>报告第56期，8月，金额$48；MRVL §0-A 有1项未分类新标的。</p><p>七个portfolio总额已读取；四类为本次实时重算。</p><p>D-20260829-SEMILIQUID-MAPPING</p>';
  const receipts = '<template id="xuan-ib-decision-state-v1">{"receipts":[{"publicSummary":"历史记录：56 Semi Liquid / 8 holdingOverrides / 48个未覆盖"}]}</template>';
  assert.deepEqual(validateClassificationDisclosure(page(canonical + other + receipts)), []);
});

test('validated disclosure neither classifies sources nor calculates money', () => {
  assert.equal(renderClassificationDisclosure(), canonical);
  assert.doesNotMatch(canonical, /\$[\d,]|token|account_number|U\d{7,}/);
  assert.deepEqual(validateClassificationDisclosure(page('<p>普通报告无四桶内容</p>' + canonical)), []);
});

test('CLI emits exact canonical markup without credentials or financial reads', () => {
  const script = fileURLToPath(new URL('./xuan-ib-classification-disclosure.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, canonical + '\n');
  const unsupported = spawnSync(process.execPath, [script, '--current'], { encoding: 'utf8' });
  assert.equal(unsupported.status, 2);
  assert.equal(unsupported.stdout, '');
});
