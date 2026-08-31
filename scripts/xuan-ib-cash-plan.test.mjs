import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateCashPlan, renderCashPlan, validateCashPlan } from './xuan-ib-cash-plan.mjs';

export const snapshot = { schemaVersion: 1, status: 'snapshot', sourceAsOfHkt: '2026-08-31 16:48–16:55 HKT', equityTotal: 4045136, developed: 455111, emerging: 417160, ibCash: 466322.41, noahCash: 357968.92, reserve: 240000, currency: 'USD', denominator: 'equity-only' };
const close = (a, b, tolerance = 0.005) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const page = data => { const r = renderCashPlan(data); return `<html><body>${r.kpi}${r.detail}${r.template}</body></html>`; };

test('cash-first uses enlarged equity denominator, not old static gaps', () => {
  const p = calculateCashPlan(snapshot);
  close(p.fullNeed, 836194.7692307694); close(p.full[0], 667595.076923077); close(p.full[1], 168599.6923076923);
  close(p.budget, 584291.33); close(p.fundingShortfall, 251903.4392307694);
  close(p.allocations[0], 466482.25); close(p.allocations[1], 117809.08);
  close(p.afterWeights[0], .199073, 1e-6); close(p.afterWeights[1], .115558, 1e-6);
  close(p.coverage, .698750281, 1e-8);
  assert.equal(p.allocations[0] + p.allocations[1], p.plannedSpend);
  for (let i = 0; i < 2; i++) close(([snapshot.developed, snapshot.emerging][i] + p.full[i]) / (snapshot.equityTotal + p.fullNeed), [.23, .12][i], 1e-10);
});
test('spare cash is retained rather than used to overshoot both targets', () => {
  const p = calculateCashPlan({ ...snapshot, ibCash: 1000000 });
  close(p.plannedSpend, 836194.77); assert.ok(p.budgetUnused > 0); close(p.fundingShortfall, 0);
  close(p.afterWeights[0], .23, 1e-8); close(p.afterWeights[1], .12, 1e-8);
});
test('no cash, reserve above pool, no gap, and one initially overweight category', () => {
  for (const reserve of [824291.33, 900000]) {
    const p = calculateCashPlan({ ...snapshot, reserve });
    assert.equal(p.budget, 0); assert.deepEqual(p.allocations, [0, 0]); assert.deepEqual(p.currentWeights, p.afterWeights);
  }
  const noGap = calculateCashPlan({ ...snapshot, developed: 1400000, emerging: 700000 });
  assert.equal(noGap.fullNeed, 0); assert.equal(noGap.plannedSpend, 0); assert.equal(noGap.coverage, null);
  const one = calculateCashPlan({ ...snapshot, developed: 1400000 });
  assert.equal(one.full[0], 0); assert.ok(one.full[1] > 0); assert.equal(one.allocations[0], 0);
});
test('no guessed missing values, future sale proceeds or credentials are accepted', () => {
  for (const patch of [{ ibCash: null }, { emerging: NaN }, { developed: -1 }, { equityTotal: 0 }, { equityTotal: 100 }, { saleProceeds: 1 }, { sourceAsOfHkt: '<script>' }, { reserve: undefined }, { noahCash: Infinity }, { currency: 'CAD' }, { denominator: 'cash-inclusive' }, { currency: undefined }, { ibCash: 1.009 }]) assert.throws(() => calculateCashPlan({ ...snapshot, ...patch }));
  assert.deepEqual(validateCashPlan(page({ schemaVersion: 1, status: 'unavailable' })), []);
  assert.throws(() => calculateCashPlan({ schemaVersion: 1, status: 'unavailable', ibCash: 0 }));
});
test('canonical output is exact, inherited, contextualized and cannot reintroduce static coverage', () => {
  const html = page(snapshot);
  assert.deepEqual(validateCashPlan(html), []);
  for (const text of ['现金优先', '非下单额度', '19.91%', '11.56%', '69.88%', '待撤', '不是 IB 即时购买力', '不代表四类全部', '数据时点：2026-08-31']) assert.ok(html.includes(text), text);
  for (const bad of [html.replace('$466,482', '$475,270'), html + renderCashPlan(snapshot).template, html + '<p>动态缺口（纯新钱补入）</p>', html + '<div id="xuan-ib-cash-plan-kpi">$9,999,999</div>', html.replace(renderCashPlan(snapshot).kpi, `<!--${renderCashPlan(snapshot).kpi}-->`)]) assert.ok(validateCashPlan(bad).length);
  assert.ok(validateCashPlan('<p>补仓</p>', { previousHtml: html }).length);
  assert.ok(validateCashPlan('<p>其他内容</p>', { previousHtml: '<p>动态缺口（纯新钱补入）</p>' }).length);
  assert.deepEqual(validateCashPlan('<p>不相关普通报告</p>'), []);
});
test('invalid dates, reversed source ranges and cash-limited buying into a current overweight fail closed', () => {
  for (const sourceAsOfHkt of ['2026-99-99 88:99 HKT', '2026-02-29 08:00 HKT', '2026-08-31 16:55–16:48 HKT', '2026-08-31 24:00 HKT']) assert.throws(() => calculateCashPlan({ ...snapshot, sourceAsOfHkt }));
  assert.throws(() => calculateCashPlan({ ...snapshot, equityTotal: 100, developed: 24, emerging: 0, ibCash: 1, noahCash: 0, reserve: 0 }), /already overweight/);
  assert.throws(() => calculateCashPlan({ ...snapshot, equityTotal: 1, developed: 1, emerging: 1 }), /reconcile/);
});
