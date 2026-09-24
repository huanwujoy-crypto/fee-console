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
  holding(5, '新兴市场', 70, 'EIMI'),
];
const order = (id, side) => ({ order_id: id, order_status: 'NEW', order_type: 'LIMIT', side,
  limit_price: '10.50', total_shares_qty: '100', cum_shares_qty: '0', remaining_shares_qty: '100',
  primary_description: side === 'BUY' ? 'EXUS' : 'ABC', secondary_description: 'description',
  order_time: '2026-09-24T13:30:00Z' });
const input = {
  dataDate: '2026-09-24', asOfHkt: '2026-09-24 21:30–21:35 HKT', ordersAsOfHkt: '2026-09-24 21:32 HKT',
  ibAccountSummary: { currency: 'USD', net_liquidation: 1000, total_cash_value: 100 },
  ibOrders: { orders: [order(1, 'SELL'), order(2, 'BUY')] },
  ibGroupedPerformance: performance(936247, classes),
  noahPerformance: { report: { portfolio_id: 936238, currency: { code: 'USD' }, end_date: '2026-09-24',
    cash_accounts: [{ value: 50 }] } },
  reserve: 50,
};

test('builds the entire nightly model from two IB and two Sharesight reads', () => {
  const model = buildNightActionModel(input);
  assert.equal(model.status, 'ready');
  assert.equal(model.cash.pool, 150);
  assert.equal(model.cash.planning, 100);
  assert.equal(model.orders.buys.length, 1);
  assert.equal(model.orders.sells.length, 1);
  assert.equal(model.allocation.total, 1000);
  assert.equal(model.replenishment.items.reduce((sum, item) => sum + item.amount, 0), model.replenishment.total);
  assert.match(model.notes[0], /2026-09-24/);
});

test('a cash-plan policy edge stays partial without blocking orders or allocation', () => {
  const model = buildNightActionModel({ ...input, ibAccountSummary: { ...input.ibAccountSummary, total_cash_value: 1_000_000 } });
  assert.equal(model.status, 'partial');
  assert.deepEqual(model.replenishment, { status: 'unavailable' });
  assert.equal(model.orders.buys.length, 1);
  assert.equal(model.allocation.status, 'ready');
});
