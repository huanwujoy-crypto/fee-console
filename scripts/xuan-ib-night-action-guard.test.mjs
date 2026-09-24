import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNightActionReport, extractNightActionModel } from './xuan-ib-night-action-view.mjs';
import { validateNightActionHtml } from './xuan-ib-night-action-guard.mjs';

const model = {
  schemaVersion: 1, dataDate: '2026-09-24', asOfHkt: '2026-09-24 21:30–21:31 HKT', status: 'ready',
  replenishment: { status: 'ready', total: 60, items: [{ symbol: 'EXUS', amount: 40 },
    { symbol: 'EIMI', amount: 14 }, { symbol: 'USSC', amount: 6 }] },
  orders: { status: 'ready', asOfHkt: '2026-09-24 21:31 HKT', buys: [], sells: [] },
  cash: { status: 'ready', pool: 100, reserve: 40, planning: 60 },
  allocation: { status: 'ready', total: 1000, categories: [
    { label: '美国底仓', marketValue: 450, currentPct: 45, targetPct: 45 },
    { label: '美国科技', marketValue: 200, currentPct: 20, targetPct: 20 },
    { label: '非美发达', marketValue: 230, currentPct: 23, targetPct: 23 },
    { label: '新兴市场', marketValue: 120, currentPct: 12, targetPct: 12 },
  ] }, notes: ['只读。'],
};

test('canonical action page round-trips and validates', () => {
  const html = renderNightActionReport(model);
  assert.deepEqual(extractNightActionModel(html), model);
  assert.equal(validateNightActionHtml(html, model.dataDate).status, 'ready');
});

test('date, body or marker changes fail closed', () => {
  const html = renderNightActionReport(model);
  assert.throws(() => validateNightActionHtml(html, '2026-09-23'), /DATE_MISMATCH/);
  assert.throws(() => validateNightActionHtml(html.replace('今晚补仓', '别的内容'), model.dataDate), /NONDETERMINISTIC/);
  assert.throws(() => extractNightActionModel(html.replace('xuan-ib-night-action-v1:', 'other:')), /INVALID_MARKER/);
});
