import test from 'node:test';
import assert from 'node:assert/strict';
import { extractNightActionModel, renderNightActionReport, validateNightActionModel } from './xuan-ib-night-action-view.mjs';

const model = {
  schemaVersion: 1, dataDate: '2026-09-24', asOfHkt: '2026-09-24 21:35 HKT', status: 'ready',
  replenishment: { status: 'ready', total: 600, items: [
    { symbol: 'EXUS', amount: 400 }, { symbol: 'EIMI', amount: 140 }, { symbol: 'USSC', amount: 60 },
  ] },
  orders: { status: 'ready', asOfHkt: '21:34 HKT', buys: [
    { side: 'BUY', description: 'EXUS', limit: '50.00 USD', quantity: '100', status: 'NEW' },
  ], sells: [{ side: 'SELL', description: 'ABC', limit: '70.00 USD', quantity: '10', status: 'NEW' }] },
  cash: { status: 'ready', pool: 1000, reserve: 400, planning: 600 },
  allocation: { status: 'ready', total: 4000, categories: [
    { label: '美国底仓', marketValue: 1800, currentPct: 45, targetPct: 45 },
    { label: '美国科技', marketValue: 800, currentPct: 20, targetPct: 20 },
    { label: '非美发达', marketValue: 920, currentPct: 23, targetPct: 23 },
    { label: '新兴市场', marketValue: 480, currentPct: 12, targetPct: 12 },
  ] },
  notes: ['数据来自本轮只读取数。', '不下单、撤单、改单或转账。'],
};

test('renders only the four approved nightly sections in a tabless mobile page', () => {
  const html = renderNightActionReport(model);
  for (const heading of ['今晚补仓', '挂单提醒', '现金优先补仓参考', '股票四类配置']) assert.match(html, new RegExp(heading));
  for (const removed of ['风险', 'ETF', '持仓一览', '家庭七组合', '使用指南']) assert.doesNotMatch(html, new RegExp(removed));
  assert.doesNotMatch(html, /role="tab"|class="tabs"/);
  assert.match(html, /买单[\s\S]*EXUS[\s\S]*卖单[\s\S]*ABC/);
  assert.match(html, /45\.0% <i>→<\/i> 45\.0%/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.deepEqual(extractNightActionModel(html), model);
});

test('shows public-update state and automatically replaces a stale open page', () => {
  const html = renderNightActionReport(model);
  assert.match(html, /id="report-state"/);
  assert.match(html, /id="report-state-detail"[^>]*aria-live="polite"/);
  assert.match(html, /更新中 · 21:30 开始/);
  assert.match(html, /更新延迟 · 仍显示上次报告/);
  assert.match(html, /setInterval\(check,30000\)/);
  assert.match(html, /fetch\(url,\{cache:'no-store'/);
  assert.match(html, /location\.replace\(fresh\)/);
  assert.doesNotMatch(html, /<button/i);
  const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test('missing current data is explicit and never reuses old amounts', () => {
  const unavailable = structuredClone(model);
  unavailable.status = 'partial';
  unavailable.replenishment = { status: 'unavailable' };
  unavailable.cash = { status: 'unavailable' };
  unavailable.allocation = { status: 'unavailable' };
  unavailable.orders = { status: 'unavailable', asOfHkt: '未取得', buys: [], sells: [] };
  const html = renderNightActionReport(unavailable);
  assert.match(html, /不沿用旧金额/);
  assert.match(html, /实时挂单尚未接入/);
  assert.match(html, /部分更新/);
});

test('schema v2 renders the compact legacy-style order facts without a missing-currency warning', () => {
  const detailed = structuredClone(model); detailed.schemaVersion = 2;
  detailed.orders.buys[0] = { side: 'BUY', description: 'EXUS', limit: '44', quantity: '300', status: 'NEW',
    currency: 'USD', ageDays: 73, distancePct: -4.39, trend: { key: 'a'.repeat(64), firstDate: '2026-09-18',
      firstPrice: 45.81, ageDays: 73, kind: 'up', label: '约 ↑ 0.5% · 观察6天' } };
  detailed.orders.sells[0] = { side: 'SELL', description: 'ABC', limit: '70', quantity: '10', status: 'NEW',
    currency: null, ageDays: null, distancePct: null, trend: null };
  const html = renderNightActionReport(detailed);
  assert.match(html, /1\. EXUS ×300/);
  assert.match(html, /73天 · NEW/);
  assert.match(html, /约 ↑ 0\.5% · 观察6天/);
  assert.match(html, /-4\.39%/);
  assert.doesNotMatch(html, /币种未返回|趋势建立中/);
  assert.deepEqual(extractNightActionModel(html), detailed);
});

test('schema v3 renders reconciled cash composition, cash-like reserves and retained budget', () => {
  const detailed = structuredClone(model); detailed.schemaVersion = 3;
  detailed.replenishment = { ...detailed.replenishment, budget: 1000, total: 600, retained: 400 };
  detailed.cash = { status: 'ready', ib: 700, noah: 300, pool: 1000, reserve: 400, planning: 600,
    cashLike: { total: 300, items: [{ symbol: 'VGIT', amount: 200 }, { symbol: 'TLT', amount: 100 }] },
    totalCapacity: 900 };
  detailed.orders.buys[0] = { side: 'BUY', description: 'EXUS', limit: '44', quantity: '300', status: 'NEW',
    currency: 'USD', ageDays: 5, distancePct: -1, trend: null };
  detailed.orders.sells[0] = { side: 'SELL', description: 'ABC', limit: '70', quantity: '10', status: 'NEW',
    currency: 'USD', ageDays: 1, distancePct: 2, trend: null };
  const html = renderNightActionReport(detailed);
  for (const value of ['IB $700', 'NOAH-HK $300', '类现金', 'VGIT $200', 'TLT $100', '全部弹药', '$900', '暂留 $400']) assert.match(html, new RegExp(value.replace('$', '\\$')));
  assert.deepEqual(extractNightActionModel(html), detailed);
});

test('model rejects duplicated or inconsistent planning arithmetic', () => {
  assert.throws(() => validateNightActionModel({ ...model, replenishment: { ...model.replenishment, total: 601 } }), /INVALID_REPLENISHMENT/);
  assert.throws(() => validateNightActionModel({ ...model, cash: { ...model.cash, planning: 599 } }), /INVALID_CASH/);
  const wrongGroup = structuredClone(model); wrongGroup.orders.buys[0].side = 'SELL';
  assert.throws(() => validateNightActionModel(wrongGroup), /ORDER_GROUP_MISMATCH/);
});
