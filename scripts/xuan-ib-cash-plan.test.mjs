import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateCashPlan, renderCashPlan, validateCashPlan } from './xuan-ib-cash-plan.mjs';

export const snapshot = { schemaVersion: 1, status: 'snapshot', sourceAsOfHkt: '2026-08-31 16:48–16:55 HKT', equityTotal: 4045136, developed: 455111, emerging: 417160, ibCash: 466322.41, noahCash: 357968.92, reserve: 240000, currency: 'USD', denominator: 'equity-only' };
export const threeWaySnapshot = { ...snapshot, schemaVersion: 2, usBase: 2006230, ussc: 15216, usscBudgetShare: 0.10 };
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

test('ticker-first guidance includes secondary USSC without changing the two-class cash model', () => {
  const rendered = renderCashPlan(snapshot);
  for (const label of ['① EXUS｜非美发达', '② EIMI｜新兴市场', '③ USSC｜美国小盘价值', '待回款后重算', '不占本次现金预算']) assert.ok(rendered.detail.includes(label), label);
  for (const label of ['EXUS', 'EIMI', 'USSC 待回款后重算', '非下单额度']) assert.ok(rendered.kpi.includes(label), label);
  assert.doesNotMatch(rendered.kpi, /非美发达|新兴市场|美国小盘价值/);
  assert.ok(rendered.kpi.split('<br>').length <= 6);
  assert.doesNotMatch(rendered.kpi + rendered.detail, /EMMI/);
  assert.match(rendered.detail, /比例是类别合计，非单只 ETF 目标/);
  assert.match(rendered.detail, /EXUS＋VCN/);
  assert.match(rendered.detail, /EIMI＋INDA/);
  assert.deepEqual(calculateCashPlan(snapshot).allocations, [466482.25, 117809.08]);
  assert.equal(calculateCashPlan(snapshot).plannedSpend, 584291.33);
  assert.match(rendered.kpi, /\$466,482/);
  assert.match(rendered.kpi, /\$117,809/);
  const usscRow = rendered.detail.match(/<div class="kv"><span class="k">③ USSC[\s\S]*?<\/div>/)?.[0];
  assert.ok(usscRow); assert.doesNotMatch(usscRow, /\$|\d+%/);
  const unavailable = renderCashPlan({ schemaVersion: 1, status: 'unavailable' });
  for (const label of ['EXUS', 'EIMI', 'USSC', '待回款后重算']) assert.ok(unavailable.detail.includes(label));
  assert.doesNotMatch(unavailable.detail, /\$[\d,]/);
});

test('schema 2 allocates 10% of cash to USSC then recomputes both remaining categories', () => {
  const p = calculateCashPlan(threeWaySnapshot);
  assert.deepEqual(p.allocations, [417141.04, 108721.16, 58429.13]);
  close(p.budget, 584291.33); close(p.plannedSpend, 584291.33);
  close(p.developedEmergingBudget, 525862.20); close(p.usscAllocation, 58429.13);
  close(p.fullNeed, 867656.6084615381); close(p.full[0], 688269.9998461539); close(p.full[1], 179386.60861538455);
  close(p.fundingShortfall, 341794.40846153814);
  assert.equal(p.budgetUnused, 0); close(p.afterTotal, 4629427.33);
  close(p.afterWeights[0], (455111 + 417141.04) / 4629427.33, 1e-12);
  close(p.afterWeights[1], (417160 + 108721.16) / 4629427.33, 1e-12);
  close(p.afterWeights[2], (15216 + 58429.13) / 4629427.33, 1e-12);
  close(p.usBaseAfterWeight, (2006230 + 58429.13) / 4629427.33, 1e-12);
  assert.ok(Math.abs(p.allocations[0] - calculateCashPlan(snapshot).allocations[0] * .9) > 1000, 'not a flat 10% reduction of the old EXUS value');
  for (let i = 0; i < 2; i++) close(([455111, 417160][i] + p.full[i]) / (4045136 + p.usscAllocation + p.fullNeed), [.23, .12][i], 1e-12);
  // Additional D/E cash is computed after the whole three-way purchase, so it
  // includes the further expansion of the denominator from that future cash.
  const continuation = calculateCashPlan({ ...snapshot, equityTotal: p.afterTotal, developed: 455111 + p.allocations[0], emerging: 417160 + p.allocations[1], ibCash: 0, noahCash: 0, reserve: 0 });
  close(continuation.fullNeed, p.fundingShortfall, .01);
});

test('schema 2 treats USSC as a component of US base without double counting or a hard 45% cap', () => {
  const p = calculateCashPlan(threeWaySnapshot);
  close(p.currentWeights[2], 15216 / 4045136, 1e-12);
  close(p.usBaseCurrentWeight, 2006230 / 4045136, 1e-12);
  assert.ok(p.usBaseCurrentWeight > .45, '45% is a reference, not a source-data rejection cap');
  const q = calculateCashPlan({ ...threeWaySnapshot, equityTotal: 1000, developed: 100, emerging: 50, usBase: 850, ussc: 100, ibCash: 20, noahCash: 0, reserve: 0 });
  close(q.afterTotal, 1020); close(q.usBaseAfterWeight, 852 / 1020, 1e-12);
  assert.ok(q.usBaseAfterWeight > .45, 'no invented hard cap even in the resulting scenario');
  assert.throws(() => calculateCashPlan({ ...threeWaySnapshot, ussc: 2006230.01 }), /inside US base/);
  assert.throws(() => calculateCashPlan({ ...threeWaySnapshot, usBase: 4045136 }), /reconcile/);
});

test('schema 2 recalculates smaller budgets and exactly conserves cents', () => {
  for (const budget of [0, .01, .05, .10, 1, 100, 1000, 200000, 584291.33]) {
    const input = { ...threeWaySnapshot, ibCash: budget, noahCash: 0, reserve: 0 };
    const p = calculateCashPlan(input);
    const budgetCents = Math.round(budget * 100);
    assert.equal(Math.round(p.usscAllocation * 100), Math.round(budgetCents * .10));
    assert.equal(p.allocations.reduce((sum, value) => sum + Math.round(value * 100), 0), Math.round(p.plannedSpend * 100));
    assert.equal(Math.round(p.plannedSpend * 100) + Math.round(p.budgetUnused * 100), budgetCents);
    assert.ok(p.plannedSpend <= budget); close(p.afterTotal, input.equityTotal + p.plannedSpend);
    const z = Math.round(budgetCents * .10) / 100;
    const fullNeed = (.35 * (input.equityTotal + z) - input.developed - input.emerging) / .65;
    const developedFull = .23 * (input.equityTotal + z + fullNeed) - input.developed;
    close(p.allocations[0], Math.round(developedFull * (budget - z) / fullNeed * 100) / 100, 1e-8);
  }
  const zero = calculateCashPlan({ ...threeWaySnapshot, reserve: 900000 });
  assert.deepEqual(zero.allocations, [0, 0, 0]); assert.deepEqual(zero.afterWeights, zero.currentWeights);
});

test('schema 2 does not invent policy for surplus, no-gap or current-overweight edge cases', () => {
  assert.throws(() => calculateCashPlan({ ...threeWaySnapshot, ibCash: 1000000 }), /exceeds.*need|policy review/);
  assert.throws(() => calculateCashPlan({ ...threeWaySnapshot, equityTotal: 1000, developed: 400, emerging: 200, usBase: 400, ussc: 20, ibCash: 100, noahCash: 0, reserve: 0 }), /both target categories have no gap/);
  assert.throws(() => calculateCashPlan({ ...threeWaySnapshot, equityTotal: 100, developed: 24, emerging: 0, usBase: 70, ussc: 1, ibCash: 1, noahCash: 0, reserve: 0 }), /already overweight/);
  const unavailable = renderCashPlan({ schemaVersion: 2, status: 'unavailable' });
  assert.match(unavailable.detail, /暂不分配现金/); assert.doesNotMatch(unavailable.kpi + unavailable.detail, /\$[\d,]|待回款后重算|不占本次现金预算/);
});

test('schema 2 validates all source values and the explicitly approved scenario share', () => {
  for (const patch of [
    { usBase: NaN }, { usBase: Infinity }, { usBase: -1 }, { usBase: null }, { usBase: undefined },
    { ussc: NaN }, { ussc: Infinity }, { ussc: -1 }, { ussc: null }, { ussc: undefined },
    { usscBudgetShare: 0 }, { usscBudgetShare: .05 }, { usscBudgetShare: .11 }, { usscBudgetShare: 10 },
    { usscBudgetShare: '0.10' }, { usscBudgetShare: NaN }, { usscBudgetShare: undefined },
    { currency: 'CAD' }, { denominator: 'cash-inclusive' }, { equityTotal: 0 }, { developed: Infinity },
    { sourceAsOfHkt: '2026-08-31 16:55–16:48 HKT' }, { ibCash: 1.009 }, { noahCash: null },
    { futureSaleProceeds: 100 }, { equityTotal: 1e13 }, { ussc: 1e13 },
  ]) assert.throws(() => calculateCashPlan({ ...threeWaySnapshot, ...patch }), JSON.stringify(patch));
  assert.throws(() => calculateCashPlan({ schemaVersion: 2, status: 'unavailable', usscBudgetShare: .10 }), /guessed inputs/);
  assert.throws(() => calculateCashPlan({ ...threeWaySnapshot, schemaVersion: 3 }), /schema/);
  assert.deepEqual(calculateCashPlan({ schemaVersion: 2, status: 'unavailable' }), { status: 'unavailable' });
});

test('schema 2 has compact canonical ticker amounts and explanatory details', () => {
  const rendered = renderCashPlan(threeWaySnapshot);
  assert.ok(rendered.kpi.split('<br>').length <= 6);
  for (const label of ['EXUS $417,141', 'EIMI $108,721', 'USSC $58,429', '非下单额度']) assert.ok(rendered.kpi.includes(label), label);
  assert.doesNotMatch(rendered.kpi, /非美发达|新兴市场|美国小盘价值/);
  assert.doesNotMatch(rendered.kpi + rendered.detail, /待回款后重算|不占本次现金预算|EMMI/);
  for (const label of ['18.84%', '11.36%', '1.59%', '44.60%', '不是永久持仓比例', '实际可用资金更少', '现金池不是 IB 即时购买力', '默认折叠', '不重复计入', '未成交卖单不计回款', '数据时点：2026-08-31 16:48–16:55 HKT']) assert.ok(rendered.detail.includes(label), label);
  assert.match(rendered.template, /^<!-- xuan-ib-cash-plan-v1:/, 'retain the transport protocol while payload schema advances');
  assert.deepEqual(validateCashPlan(page(threeWaySnapshot)), []);
  for (const html of [page(threeWaySnapshot).replace('$58,429', '$0'), page(threeWaySnapshot) + rendered.template, page(threeWaySnapshot).replace(rendered.kpi, `<!-- ${rendered.kpi} -->`)]) assert.ok(validateCashPlan(html).length);
});

test('schema 2 policy survives unavailable reports and rejects downgrade or marker removal', () => {
  const old = page(snapshot), current = page(threeWaySnapshot), missing = page({ schemaVersion: 2, status: 'unavailable' });
  assert.deepEqual(validateCashPlan(current, { previousHtml: old }), []);
  assert.deepEqual(validateCashPlan(missing, { previousHtml: current }), []);
  assert.deepEqual(validateCashPlan(current, { previousHtml: missing }), []);
  for (const previousHtml of [current, missing, `<!-- ${current} -->`, `<template>${current}</template>`]) {
    for (const html of [old, page({ schemaVersion: 1, status: 'unavailable' })]) assert.match(validateCashPlan(html, { previousHtml }).join(' '), /cannot downgrade/);
    assert.ok(validateCashPlan('<p>no cash plan</p>', { previousHtml }).length);
  }
  const rendered = renderCashPlan(threeWaySnapshot);
  assert.ok(validateCashPlan(old, { previousHtml: current.replace(rendered.template, `<!-- xuan-ib-cash-plan-v1:not-json -->`) }).length);
  assert.ok(validateCashPlan(old, { previousHtml: current + rendered.template }).length);
});
