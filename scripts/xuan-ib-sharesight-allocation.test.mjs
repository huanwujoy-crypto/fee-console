import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSharesightCash, parseSharesightStockAllocation } from './xuan-ib-sharesight-allocation.mjs';

const holding = (id, group_name, value, code) => ({ id, group_name, value, instrument: { code } });
const report = {
  portfolio_id: 936247, currency: { code: 'USD' }, grouping: 'custom_group_category',
  custom_group: { id: 83569, name: '资产类别' }, end_date: '2026-09-24',
  holdings: [
    holding(1, '美国底仓', 400, 'CSPX'), holding(2, '美国底仓', 50, 'USSC'),
    holding(3, '美国科技', 200, 'GOOG'), holding(4, '非美发达', 230, 'EXUS'),
    holding(5, '新兴市场', 120, 'EIMI'), holding(6, '主题投资', 80, 'GLD'),
    holding(7, '防御资产', 70, 'VGIT'), holding(8, '防御资产', 20, 'TLT.NASDAQ'),
  ], cash_accounts: [{ value: 100 }, { value: 25 }],
};

test('reads the exact owner custom group and excludes theme and defensive assets from the four-class denominator', () => {
  const allocation = parseSharesightStockAllocation({ report });
  assert.equal(allocation.customGroupId, 83569);
  assert.equal(allocation.total, 1000);
  assert.equal(allocation.usBase, 450);
  assert.equal(allocation.technology, 200);
  assert.equal(allocation.developed, 230);
  assert.equal(allocation.emerging, 120);
  assert.equal(allocation.ussc, 50);
  assert.equal(allocation.excludedValue, 170);
  assert.deepEqual(allocation.cashLike, { total: 90, items: [
    { symbol: 'VGIT', amount: 70 }, { symbol: 'TLT', amount: 20 },
  ] });
  assert.deepEqual(allocation.categories.map(item => [item.label, item.currentPct, item.targetPct]), [
    ['美国底仓', 45, 45], ['美国科技', 20, 20], ['非美发达', 23, 23], ['新兴市场', 12, 12],
  ]);
});

test('cash uses the report base-currency cash accounts only', () => {
  assert.deepEqual(parseSharesightCash({ report }, { portfolioId: 936247 }), {
    status: 'ready', source: 'Sharesight', dataDate: '2026-09-24', total: 125, accountCount: 2,
  });
});

test('unknown, ungrouped, duplicate and misplaced USSC rows fail closed', () => {
  const withHolding = row => ({ report: { ...report, holdings: [...report.holdings, row] } });
  assert.throws(() => parseSharesightStockAllocation(withHolding(holding(9, '', 1, 'NEW'))), /UNGROUPED_HOLDING/);
  assert.throws(() => parseSharesightStockAllocation(withHolding(holding(9, '其它', 1, 'NEW'))), /UNKNOWN_ASSET_CLASS/);
  assert.throws(() => parseSharesightStockAllocation(withHolding(holding(1, '美国底仓', 1, 'NEW'))), /INVALID_HOLDING/);
  assert.throws(() => parseSharesightStockAllocation({ report: { ...report, holdings: [holding(1, '美国科技', 1, 'USSC')] } }), /USSC_CLASS_MISMATCH/);
  assert.throws(() => parseSharesightStockAllocation(withHolding(holding(9, '主题投资', 1, 'TLT'))), /CASH_LIKE_CLASS_MISMATCH/);
});
