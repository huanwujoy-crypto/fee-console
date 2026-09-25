import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNightActionModel } from './xuan-ib-night-action-model.mjs';

const holding = (id, group_name, value, code) => ({ id, group_name, value, instrument: { code } });
const performance = (portfolio_id, holdings, cash_accounts = []) => ({ report: {
  portfolio_id, currency: { code: 'USD' }, grouping: 'custom_group_category',
  custom_group: { id: 83569, name: '资产类别' }, end_date: '2026-09-24', holdings, cash_accounts,
} });
const classes = [
  holding(1, '美国底仓', 450, 'CSPX'), holding(2, '美国底仓', 50, 'USSC'),
  holding(3, '美国科技', 250, 'GOOG'), holding(4, '非美发达', 180, 'EXUS'),
  holding(5, '新兴市场', 70, 'EIMI'), holding(6, '防御资产', 40, 'VGSH'),
  holding(7, '防御资产', 30, 'VGIT'), holding(8, '防御资产', 20, 'TLT'),
];
const order = (id, side) => ({ order_id: id, order_status: 'NEW', order_type: 'LIMIT', side,
  limit_price: '10.50', total_shares_qty: '1', cum_shares_qty: '0', remaining_shares_qty: '1',
  primary_description: side === 'BUY' ? 'Buy 1 EXUS' : 'Sell 1 ABC', secondary_description: 'description',
  order_time: '2026-09-20T13:30:00Z' });
const input = {
  dataDate: '2026-09-24', asOfHkt: '2026-09-24 21:30–21:35 HKT', ordersAsOfHkt: '2026-09-24 21:32 HKT',
  ibAccountSummary: { currency: 'USD', net_liquidation: 1000, total_cash_value: 100 },
  ibPositions: { positions: [
    { contract_description: 'EXUS', position: 100, market_price: 10, market_value: 1000, currency: 'USD' },
    { contract_description: 'ABC', position: 10, market_price: 12, market_value: 120, currency: 'USD' },
  ] },
  ibOrders: { orders: [order(1, 'SELL'), order(2, 'BUY')] },
  ibGroupedPerformance: performance(936247, classes),
  noahPerformance: { report: { portfolio_id: 936238, currency: { code: 'USD' }, end_date: '2026-09-24',
    cash_accounts: [{ value: 50 }] } },
  reserve: 50,
};

test('builds the entire nightly model from three IB and two Sharesight reads', () => {
  const model = buildNightActionModel(input);
  assert.equal(model.status, 'ready');
  assert.equal(model.cash.pool, 150);
  assert.equal(model.cash.planning, 89.5);
  assert.equal(model.cash.orderReserve, 10.5);
  assert.equal(model.orders.buys.length, 1);
  assert.equal(model.orders.sells.length, 1);
  assert.equal(model.schemaVersion, 4);
  assert.equal(model.orders.buys[0].currency, 'USD');
  assert.equal(model.orders.buys[0].ageDays, 4);
  assert.equal(model.orders.buys[0].distancePct, 5);
  assert.equal(model.orders.buys[0].trend.label, null);
  assert.equal(model.allocation.total, 1000);
  assert.equal(model.allocation.projectedTotal, 1010.5);
  assert.equal(model.allocation.categories.find(item => item.label === '非美发达').projectedMarketValue, 190.5);
  assert.deepEqual(model.cash.cashLike, { total: 90, items: [
    { symbol: 'VGSH', amount: 40 }, { symbol: 'VGIT', amount: 30 }, { symbol: 'TLT', amount: 20 },
  ] });
  assert.equal(model.cash.totalCapacity, 179.5);
  assert.equal(model.replenishment.budget, model.replenishment.total + model.replenishment.retained);
  assert.equal(model.replenishment.items.reduce((sum, item) => sum + item.amount, 0), model.replenishment.total);
  assert.match(model.notes[0], /2026-09-24/);
});

test('carries the prior verified price baseline without another history read', async () => {
  const first = buildNightActionModel(input);
  const { renderNightActionReport } = await import('./xuan-ib-night-action-view.mjs');
  const secondInput = structuredClone(input);
  secondInput.dataDate = '2026-09-25'; secondInput.asOfHkt = '2026-09-25 21:30 HKT';
  secondInput.ordersAsOfHkt = '2026-09-25 21:30 HKT';
  secondInput.ibPositions.positions[0].market_price = 10.5;
  secondInput.ibGroupedPerformance.report.end_date = '2026-09-25';
  secondInput.noahPerformance.report.end_date = '2026-09-25';
  secondInput.previousHtml = renderNightActionReport(first);
  const second = buildNightActionModel(secondInput);
  assert.equal(second.orders.buys[0].trend.label, '约 ↑ 5.0% · 观察1天');
});

test('surplus cash remains ready and is explicitly retained', () => {
  const model = buildNightActionModel({ ...input, ibAccountSummary: { ...input.ibAccountSummary, total_cash_value: 1_000_000 } });
  assert.equal(model.status, 'ready');
  assert.ok(model.replenishment.retained > 0);
  assert.equal(model.replenishment.budget, model.replenishment.total + model.replenishment.retained);
  assert.equal(model.orders.buys.length, 1);
  assert.equal(model.allocation.status, 'ready');
});

test('a display suffix does not invalidate the underlying source timestamp', () => {
  const model = buildNightActionModel({ ...input,
    asOfHkt: '2026-09-25 06:57 HKT · 美股 2026-09-24',
  });
  assert.equal(model.status, 'ready');
});

test('sub-cent source precision is rounded only for the planning view', () => {
  const model = buildNightActionModel({ ...input,
    ibAccountSummary: { ...input.ibAccountSummary, total_cash_value: 100.0049 },
    noahPerformance: { report: { ...input.noahPerformance.report,
      cash_accounts: [{ value: 50.0049 }] } },
  });
  assert.equal(model.status, 'ready');
  assert.equal(model.cash.pool, 150);
  assert.equal(model.cash.planning, 89.5);
});

test('requires the completed Sharesight source date selected by the pre-open run', () => {
  assert.equal(buildNightActionModel({ ...input, expectedSourceDate: '2026-09-24' }).status, 'ready');
  assert.throws(() => buildNightActionModel({ ...input, expectedSourceDate: '2026-09-23' }), /SOURCE_DATE_NOT_READY/);
});
