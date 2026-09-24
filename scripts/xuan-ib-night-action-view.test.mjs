import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNightActionReport, validateNightActionModel } from './xuan-ib-night-action-view.mjs';

const model = {
  schemaVersion: 1, dataDate: '2026-09-24', asOfHkt: '2026-09-24 21:35 HKT', status: 'ready',
  replenishment: { status: 'ready', total: 600, items: [
    { symbol: 'EXUS', amount: 400 }, { symbol: 'EIMI', amount: 140 }, { symbol: 'USSC', amount: 60 },
  ] },
  orders: { asOfHkt: '21:34 HKT', buys: [
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
});

test('missing current data is explicit and never reuses old amounts', () => {
  const unavailable = structuredClone(model);
  unavailable.status = 'partial';
  unavailable.replenishment = { status: 'unavailable' };
  unavailable.cash = { status: 'unavailable' };
  unavailable.allocation = { status: 'unavailable' };
  const html = renderNightActionReport(unavailable);
  assert.match(html, /不沿用旧金额/);
  assert.match(html, /部分更新/);
});

test('model rejects duplicated or inconsistent planning arithmetic', () => {
  assert.throws(() => validateNightActionModel({ ...model, replenishment: { ...model.replenishment, total: 601 } }), /INVALID_REPLENISHMENT/);
  assert.throws(() => validateNightActionModel({ ...model, cash: { ...model.cash, planning: 599 } }), /INVALID_CASH/);
  const wrongGroup = structuredClone(model); wrongGroup.orders.buys[0].side = 'SELL';
  assert.throws(() => validateNightActionModel(wrongGroup), /ORDER_GROUP_MISMATCH/);
});
