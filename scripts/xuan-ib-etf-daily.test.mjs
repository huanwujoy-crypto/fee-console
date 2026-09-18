// Synthetic-shape tests for the v2.2 daily ABC producer. The fixtures mirror the
// exact response shapes of get_pa_performance_all_periods, get_price_history,
// sharesight_list_cash_accounts and sharesight_get_cash_transactions observed on
// 2026-09-17/18; no test reads a network or a financial account.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simulateEtfTrend, validateOpenEtfTrend } from './xuan-ib-etf-trend.mjs';
import { SYMBOLS, FLOW_TOLERANCE, POOL_VERSION, validateFlowLedger, validatePendingCalls, validateBaseline, validateInstruments,
  normalizePaPerformance, normalizePriceBars, normalizeNoahCash, dailyCutoff, buildEtfDailyInput, buildEtfDailySummary, runCli } from './xuan-ib-etf-daily.mjs';

const repo = new URL('../', import.meta.url);
const readRepo = file => JSON.parse(fs.readFileSync(new URL(file, repo), 'utf8'));
const compact = d => d.replaceAll('-', '');
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekend = d => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
const round2 = v => Math.round(v * 100) / 100;
// Trading days of a synthetic fortnight: Tue 2020-09-01 .. Fri 2020-09-11.
const tradingDays = (from, to, closed = []) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) if (!weekend(d) && !closed.includes(d)) out.push(d); return out; };

// A time-weighted series is unaffected by flows; NAV moves by return then flow.
function performanceFixture({ days, returns, flows = {}, startNav = 1000000, measure = 'TWR', window = '1M', extraWindows = {} }) {
  const nav = [], cps = []; let cumulative = 1, value = startNav;
  days.forEach((day, i) => { cumulative *= 1 + returns[i]; value = value * (1 + returns[i]) + (flows[day] || 0); nav.push(value); cps.push(cumulative - 1); });
  const period = { start_date: compact(addDays(days[0], -1)), start_nav: startNav, cps, nav, dates: days.map(compact), frequency: 'D' };
  return { portfolio_measure: measure, currency_type: 'base', accounts: { account: { base_currency: 'USD', available_periods: [window],
    periods: { [window]: period, ...extraWindows } } } };
}
const barsFixture = (days, base) => ({ chart_step: 86400, delayed: 900, source: 'Last',
  time: days.map(d => `${d}T07:00:00Z`), close: days.map((_, i) => base * (1 + i / 200)),
  open: days.map(() => base), high: days.map(() => base * 1.01), low: days.map(() => base * .99), volume: days.map(() => 1000) });
const allBars = (days, drop = {}) => Object.fromEntries(SYMBOLS.map((s, i) => [s, barsFixture(days.filter(d => !(drop[s] || []).includes(d)), 50 * (i + 1))]));
const baseline = (startDate = '2020-09-01') => ({ schemaVersion: 1, purpose: 'xuan-etf-daily-baseline', methodId: 'xuan-etf-indicative-v2', poolVersion: 2, startDate, frozenDate: startDate, reserveUsd: 0, note: '' });
const ledger = (flows = []) => ({ schemaVersion: 1, purpose: 'xuan-etf-owner-declared-flows', note: '', flows });
const flow = (date, direction, usd, suffix = 'A1', kind = 'external') => ({ id: `FLOW-${compact(date)}-${suffix}`, date, account: 'IB-HK', direction, kind, usd, note: 'synthetic' });
const pending = (entries = [['2020-09-01', 240000]]) => ({ schemaVersion: 1, purpose: 'xuan-etf-owner-declared-pending-calls', note: '',
  entries: entries.map(([date, usd], i) => ({ id: `CALL-${compact(date)}-A${i + 1}`, date, usd, note: 'synthetic' })) });
const instruments = () => readRepo('claude/xuan-ib-etf-instruments-v1.json');
const CASH = instruments().cashAccounts['NOAH-HK'];
// The NOAH-HK cash account as Sharesight returns it: a dated listing balance and
// transactions with running balances, reconstructed backwards from the listing.
function noahFixture({ listingDate = '2020-09-13', balance = 100000, transactions = [], from = '2020-08-31', to = listingDate, wrap = true, accountId = CASH.cashAccountId } = {}) {
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  let running = balance; const rows = [];
  for (let i = sorted.length - 1; i >= 0; i--) { rows.unshift({ ...sorted[i], balance: round2(running) }); running -= sorted[i].amount; }
  const accounts = { cash_accounts: [{ id: accountId, name: 'NOAH-HK', currency: 'USD', portfolio_id: CASH.portfolioId, portfolio_currency: 'USD',
    date: listingDate, balance, balance_in_portfolio_currency: balance, links: {} }], links: {} };
  const tx = { cash_account_transactions: rows.map(r => ({ id: r.id, description: 'synthetic', date_time: `${r.date}T04:00:00.000Z`, amount: r.amount,
    balance: r.balance, cash_account_id: accountId, foreign_identifier: null, cash_account_transaction_type: { name: r.type } })),
    links: { self: `https://api.sharesight.com/api/v2.0/cash_accounts/${accountId}/cash_account_transactions?from=${from}&to=${to}` } };
  return { accounts: wrap ? { result: { source: 'Sharesight User API', mode: 'read_only', data: accounts } } : accounts,
    transactions: wrap ? { result: { source: 'Sharesight User API', mode: 'read_only', data: tx } } : tx };
}
const tx = (id, date, amount, type = amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL') => ({ id, date, amount, type });
const days = tradingDays('2020-09-01', '2020-09-11');
const flat = days.map((_, i) => (i % 2 ? .01 : -.005));
const now = new Date('2020-09-14T13:30:00Z');
const common = (over = {}) => ({ baseline: baseline(), ledger: ledger(), pendingCalls: pending(), instruments: instruments(),
  performance: performanceFixture({ days, returns: flat }), bars: allBars(days), noahCash: noahFixture(), cutoff: '2020-09-11', ...over });
const build = over => buildEtfDailyInput(common(over));
const dayOf = (input, date) => input.days.find(d => d.date === date);

test('repository ledgers, baseline and instrument files are valid; the baseline is value-free and declares pool version 2', () => {
  const led = validateFlowLedger(readRepo('claude/xuan-ib-etf-flows-v1.json'));
  assert.deepEqual(led.flows, []);
  const calls = validatePendingCalls(readRepo('claude/xuan-ib-etf-pending-calls-v1.json'));
  assert.equal(calls.entries[0].date, '2026-09-17'); assert.equal(calls.entries[0].usd, 240000);
  const base = validateBaseline(readRepo('claude/xuan-ib-etf-baseline-v2.json'));
  assert.equal(base.startDate, '2026-09-17'); assert.equal(base.frozenDate, base.startDate);
  assert.equal(base.poolVersion, POOL_VERSION); assert.equal(base.reserveUsd, 0);
  for (const key of Object.keys(base)) assert.ok(!/usd|nav|price|close/i.test(key) || key === 'reserveUsd', key);
  const inst = validateInstruments(instruments());
  assert.deepEqual(Object.keys(inst.instruments).sort(), [...SYMBOLS].sort());
  assert.equal(inst.instruments.CSPX.isin, 'IE00B5BMR087');
  assert.equal(inst.cashAccounts['NOAH-HK'].currency, 'USD');
  assert.throws(() => validateBaseline({ ...base, poolVersion: 1, reserveUsd: 240000 }), /poolVersion 2/);
});

test('ledger validation is strict: dated ids, IB-HK side only, external or transfer, positive USD, append order', () => {
  validateFlowLedger(ledger([flow('2020-09-02', 'out', 286409), flow('2020-09-03', 'in', 5000, 'B2', 'transfer')]));
  const bad = [
    [flow('2020-09-02', 'out', 286409), flow('2020-09-02', 'out', 1, 'A1')],
    [{ ...flow('2020-09-02', 'out', 1), id: 'FLOW-20200903-A1' }],
    [{ ...flow('2020-09-02', 'out', 1), account: 'NOAH-HK' }],
    [{ ...flow('2020-09-02', 'out', 1), direction: 'transfer' }],
    [{ ...flow('2020-09-02', 'out', 1), kind: 'internal' }],
    [{ ...flow('2020-09-02', 'out', -1) }],
    [{ ...flow('2020-09-02', 'out', 1), extra: true }],
    [flow('2020-09-03', 'out', 1), flow('2020-09-02', 'out', 1, 'B2')],
  ];
  for (const flows of bad) assert.throws(() => validateFlowLedger(ledger(flows)), /Flow/);
  validatePendingCalls(pending([['2020-09-01', 240000], ['2020-09-09', 100000]]));
  for (const entries of [[], [['2020-09-01', -1]], [['2020-09-01', 1], ['2020-09-01', 2]], [['2020-09-02', 1], ['2020-09-01', 2]]]) {
    assert.throws(() => validatePendingCalls(pending(entries)), /Pending call|pending-call/);
  }
  assert.throws(() => validatePendingCalls({ ...pending(), entries: [{ ...pending().entries[0], id: 'CALL-20200902-A1' }] }), /own date/);
  assert.throws(() => validateBaseline({ ...baseline('2020-09-05') }), /weekday/);
  assert.throws(() => validateBaseline({ ...baseline(), frozenDate: '2020-09-02' }), /Invalid daily baseline/);
  assert.throws(() => validateInstruments({ ...instruments(), cashAccounts: {} }), /pool cash account/);
});

test('PortfolioAnalyst normalisation takes the earliest window covering the baseline and rejects malformed periods', () => {
  const later = performanceFixture({ days: days.slice(3), returns: flat.slice(3), window: '7D' }).accounts.account.periods['7D'];
  const response = performanceFixture({ days, returns: flat, extraWindows: { '7D': later } });
  const pa = normalizePaPerformance(response, { startDate: '2020-09-01' });
  assert.equal(pa.window, '1M'); assert.equal(pa.measure, 'TWR'); assert.equal(pa.series.length, days.length);
  assert.equal(pa.series[0].date, '2020-09-01'); assert.equal(typeof pa.fingerprint, 'string');
  assert.throws(() => normalizePaPerformance(response, { startDate: '2020-08-01' }), /reaches the baseline/);
  const broken = structuredClone(response); broken.accounts.account.periods['1M'].nav.pop();
  assert.throws(() => normalizePaPerformance(broken, { startDate: '2020-09-01' }), /Malformed period/);
  const eur = structuredClone(response); eur.accounts.account.base_currency = 'EUR';
  assert.throws(() => normalizePaPerformance(eur, { startDate: '2020-09-01' }), /Unexpected PortfolioAnalyst/);
});

test('price bars normalise to UTC trading dates and reject non-daily or unordered bars', () => {
  const { bars } = normalizePriceBars(barsFixture(days, 100));
  assert.deepEqual(bars.map(b => b.date), days);
  assert.throws(() => normalizePriceBars({ ...barsFixture(days, 100), chart_step: 3600 }), /Unexpected price history/);
  const unordered = barsFixture(days, 100); [unordered.time[0], unordered.time[1]] = [unordered.time[1], unordered.time[0]];
  assert.throws(() => normalizePriceBars(unordered), /ordered daily bars/);
});

test('the daily cutoff is the day before the London date of the run: the run-day session is still open', () => {
  assert.equal(dailyCutoff(new Date('2026-09-18T13:30:00Z')), '2026-09-17');
  assert.equal(dailyCutoff(new Date('2026-09-18T23:30:00Z')), '2026-09-18');
  assert.equal(dailyCutoff(new Date('2026-01-05T00:30:00Z')), '2026-01-04');
});

test('the NOAH-HK cash account is read as a dated listing plus a chained transaction history, backwards from the listing', () => {
  const raw = noahFixture({ balance: 87468.22, transactions: [tx(1, '2020-09-03', 15908.29), tx(2, '2020-09-08', -300000), tx(3, '2020-09-08', 13590.65), tx(4, '2020-09-08', 0.36), tx(5, '2020-09-10', 12.5, 'INTEREST_PAYMENT')] });
  const noah = normalizeNoahCash(raw, CASH, { startDate: '2020-09-01', endDate: '2020-09-11' });
  assert.equal(noah.listingDate, '2020-09-13'); assert.equal(noah.transactions, 5);
  assert.equal(noah.balanceOn('2020-09-11'), 87468.22);
  assert.equal(noah.balanceOn('2020-09-09'), round2(87468.22 - 12.5));
  assert.equal(noah.balanceOn('2020-09-07'), round2(87468.22 - 12.5 - 0.36 - 13590.65 + 300000));
  assert.equal(noah.balanceOn('2020-09-01'), round2(87468.22 - 12.5 - 0.36 - 13590.65 + 300000 - 15908.29));
  assert.deepEqual([...noah.movements.keys()], ['2020-09-03', '2020-09-08']);
  assert.deepEqual(noah.movements.get('2020-09-08').map(f => [f.id, f.usd, f.kind]), [['SS-2', -300000, 'external'], ['SS-3', 13590.65, 'external'], ['SS-4', 0.36, 'external']]);
  assert.deepEqual([...noah.unknownTypeDates], []);
  // The bare payloads work as well as the tool envelope.
  assert.equal(normalizeNoahCash(noahFixture({ wrap: false }), CASH, { startDate: '2020-09-01', endDate: '2020-09-11' }).listingBalance, 100000);
  // Evidence checks: window, listing date, identity, chain and landing.
  const range = { startDate: '2020-09-01', endDate: '2020-09-11' };
  assert.throws(() => normalizeNoahCash(noahFixture({ from: '2020-09-02' }), CASH, range), /window must cover/);
  assert.throws(() => normalizeNoahCash(noahFixture({ listingDate: '2020-09-10', to: '2020-09-10' }), CASH, range), /older than the comparison end/);
  assert.throws(() => normalizeNoahCash(noahFixture({ accountId: 999 }), CASH, range), /not in the listing/);
  const broken = noahFixture({ transactions: [tx(1, '2020-09-03', 100), tx(2, '2020-09-04', 50)] });
  broken.transactions.result.data.cash_account_transactions[0].balance += 1;
  assert.throws(() => normalizeNoahCash(broken, CASH, range), /does not chain/);
  const landing = noahFixture({ transactions: [tx(1, '2020-09-03', 100)] });
  landing.accounts.result.data.cash_accounts[0].balance += 1;
  assert.throws(() => normalizeNoahCash(landing, CASH, range), /does not match the listing balance/);
  const hkd = noahFixture(); hkd.accounts.result.data.cash_accounts[0].currency = 'HKD';
  assert.throws(() => normalizeNoahCash(hkd, CASH, range), /identity or currency/);
});

test('a clean fortnight replays every calendar day as the pool: IB NAV plus NOAH-HK cash minus pending calls', () => {
  const { input, diagnostics } = build({ cutoff: '2020-09-13' });
  assert.equal(diagnostics.endDate, '2020-09-11'); assert.equal(diagnostics.poolVersion, 2);
  assert.equal(input.days.length, 11); assert.equal(input.days[0].date, '2020-09-01'); assert.equal(input.days.at(-1).date, '2020-09-11');
  const nav = performanceFixture({ days, returns: flat }).accounts.account.periods['1M'].nav;
  assert.equal(input.initialUsd, round2(nav[0] + 100000 - 240000));
  assert.equal(input.reserveUsd, 0);
  const saturday = dayOf(input, '2020-09-05');
  assert.equal(saturday.actualUsd, dayOf(input, '2020-09-04').actualUsd);
  assert.ok(SYMBOLS.every(s => saturday.quotes[s].status === 'closed'));
  assert.ok(input.days.every(d => d.flowsComplete && d.actualComplete && d.flows.length === 0));
  assert.ok(input.days.every(d => /^ib-pa-performance:1M:[0-9a-f]{16};ib-price-history:CSPX:[0-9a-f]{16}.*;ss-cash:[0-9a-f]{16}:[0-9a-f]{16}$/.test(d.sourceRef)));
  assert.deepEqual(diagnostics.undeclaredFlowDates, []); assert.deepEqual(diagnostics.unknownCashTypeDates, []);
  const result = simulateEtfTrend(input);
  assert.equal(result.latestCompleteDate, '2020-09-11'); assert.equal(result.stop, null);
  // B invests the whole pool: no reserve is ever touched.
  assert.ok(result.rows.every(r => !r.reserveUsed));
});

test('a NOAH-HK cash movement is a pool flow on its own date; interest is return; an unknown type stops the day', () => {
  const noahCash = noahFixture({ balance: 120000, transactions: [tx(1, '2020-09-03', 15908.29), tx(2, '2020-09-08', -5000), tx(3, '2020-09-10', 30, 'INTEREST_PAYMENT')] });
  const { input, diagnostics } = build({ noahCash });
  assert.deepEqual(dayOf(input, '2020-09-03').flows, [{ id: 'SS-1', date: '2020-09-03', usd: 15908.29, kind: 'external' }]);
  assert.deepEqual(dayOf(input, '2020-09-08').flows, [{ id: 'SS-2', date: '2020-09-08', usd: -5000, kind: 'external' }]);
  assert.deepEqual(dayOf(input, '2020-09-10').flows, []);
  assert.deepEqual(diagnostics.undeclaredFlowDates, []);
  // The pool rises by the receipt; the flow-adjusted index does not.
  const nav = performanceFixture({ days, returns: flat }).accounts.account.periods['1M'].nav;
  assert.equal(dayOf(input, '2020-09-02').actualUsd, round2(nav[1] + (120000 - 30 + 5000 - 15908.29) - 240000));
  assert.equal(dayOf(input, '2020-09-03').actualUsd, round2(nav[2] + (120000 - 30 + 5000) - 240000));
  const result = simulateEtfTrend(input);
  assert.equal(result.stop, null);
  const before = result.rows.find(r => r.date === '2020-09-02'), after = result.rows.find(r => r.date === '2020-09-03');
  assert.ok(after.endingUsd.B > before.endingUsd.B + 15000 && after.endingUsd.C > before.endingUsd.C + 15000);
  // The pool's own return: IB's return diluted by the cash sleeve, and no part of the receipt.
  const poolBefore = nav[1] + (120000 - 30 + 5000 - 15908.29) - 240000, poolAfter = nav[2] + (120000 - 30 + 5000 - 15908.29) - 240000;
  assert.ok(Math.abs(after.index.A / before.index.A - poolAfter / poolBefore) < 1e-6);
  // A type this module does not know is neither a flow nor a return: the day is named and the series stops there.
  const odd = build({ noahCash: noahFixture({ transactions: [tx(9, '2020-09-09', 100, 'ADJUSTMENT')] }) });
  assert.deepEqual(odd.diagnostics.unknownCashTypeDates, ['2020-09-09']);
  assert.equal(dayOf(odd.input, '2020-09-09').flowsComplete, false);
  assert.equal(simulateEtfTrend(odd.input).stop.date, '2020-09-09');
});

test('a transfer from NOAH-HK cash to IB-HK nets to zero inside the pool once declared, and is an undeclared jump otherwise', () => {
  const performance = performanceFixture({ days, returns: flat, flows: { '2020-09-08': 250000 } });
  const noahCash = noahFixture({ balance: 300000, transactions: [tx(1, '2020-09-08', -250000)] });
  const declared = build({ performance, noahCash, ledger: ledger([flow('2020-09-08', 'in', 250000, 'T1', 'transfer')]) });
  assert.deepEqual(declared.diagnostics.undeclaredFlowDates, []);
  const day = dayOf(declared.input, '2020-09-08');
  assert.deepEqual(day.flows.map(f => [f.id, f.usd, f.kind]), [['SS-1', -250000, 'external'], ['FLOW-20200908-T1', 250000, 'internal-transfer']]);
  assert.equal(day.flows.reduce((s, f) => s + f.usd, 0), 0);
  const result = simulateEtfTrend(declared.input);
  assert.equal(result.stop, null);
  const before = result.rows.find(r => r.date === '2020-09-07'), after = result.rows.find(r => r.date === '2020-09-08');
  assert.ok(Math.abs(after.endingUsd.B - before.endingUsd.B) < before.endingUsd.B * .02, 'B does not see the transfer');
  // Without the declaration the IB side shows a return-free jump nobody explained.
  const undeclared = build({ performance, noahCash });
  assert.deepEqual(undeclared.diagnostics.undeclaredFlowDates, ['2020-09-08']);
  assert.equal(simulateEtfTrend(undeclared.input).stop.date, '2020-09-08');
  // Sharesight may record the withdrawal on a later day: each side is a flow on its own date and the index stays flow-adjusted.
  const lagged = build({ performance, noahCash: noahFixture({ balance: 300000, transactions: [tx(1, '2020-09-09', -250000)] }),
    ledger: ledger([flow('2020-09-08', 'in', 250000, 'T1', 'transfer')]) });
  assert.equal(dayOf(lagged.input, '2020-09-08').flows.reduce((s, f) => s + f.usd, 0), 250000);
  assert.equal(dayOf(lagged.input, '2020-09-09').flows.reduce((s, f) => s + f.usd, 0), -250000);
  assert.equal(simulateEtfTrend(lagged.input).stop, null);
});

test('a change of the pending-call level is a boundary adjustment: scope-out when it rises, scope-in when it falls, never a return', () => {
  const { input, diagnostics } = build({ pendingCalls: pending([['2020-09-01', 240000], ['2020-09-04', 300000], ['2020-09-09', 100000]]) });
  assert.equal(diagnostics.pendingLevels, 3);
  assert.deepEqual(dayOf(input, '2020-09-04').flows, [{ id: 'CALL-20200904-A2', date: '2020-09-04', usd: -60000, kind: 'scope-out' }]);
  assert.deepEqual(dayOf(input, '2020-09-09').flows, [{ id: 'CALL-20200909-A3', date: '2020-09-09', usd: 200000, kind: 'scope-in' }]);
  const nav = performanceFixture({ days, returns: flat }).accounts.account.periods['1M'].nav;
  assert.equal(dayOf(input, '2020-09-03').actualUsd, round2(nav[2] + 100000 - 240000));
  assert.equal(dayOf(input, '2020-09-04').actualUsd, round2(nav[3] + 100000 - 300000));
  assert.equal(dayOf(input, '2020-09-09').actualUsd, round2(nav[6] + 100000 - 100000));
  const result = simulateEtfTrend(input);
  assert.equal(result.stop, null);
  const d3 = result.rows.find(r => r.date === '2020-09-03'), d4 = result.rows.find(r => r.date === '2020-09-04');
  // The index moves by the pool's own return only; the boundary change is removed as a flow.
  assert.ok(Math.abs(d4.index.A / d3.index.A - (nav[3] + 100000 - 240000) / (nav[2] + 100000 - 240000)) < 1e-6, 'the index ignores the boundary change');
  // Paying a call: cash and level fall together, so the pool does not move and the two items cancel.
  const paid = build({ noahCash: noahFixture({ balance: 50000, transactions: [tx(1, '2020-09-04', -50000)] }),
    pendingCalls: pending([['2020-09-01', 240000], ['2020-09-04', 190000]]) });
  assert.equal(dayOf(paid.input, '2020-09-04').flows.reduce((s, f) => s + f.usd, 0), 0);
  assert.equal(dayOf(paid.input, '2020-09-04').actualUsd, round2(nav[3] + 50000 - 190000));
  assert.equal(dayOf(paid.input, '2020-09-03').actualUsd, round2(nav[2] + 100000 - 240000));
  // A level must be declared at the baseline; a pool that would be negative is not a wealth.
  assert.throws(() => build({ pendingCalls: pending([['2020-09-02', 240000]]) }), /at the baseline/);
  assert.throws(() => build({ pendingCalls: pending([['2020-09-01', 2000000]]) }), /positive wealth/);
});

test('a declared IB-side external flow that matches the account\'s own return-free movement is accepted and reaches B and C', () => {
  const declared = { '2020-09-08': -286409 };
  const { input, diagnostics } = build({ ledger: ledger([flow('2020-09-08', 'out', 286409)]), performance: performanceFixture({ days, returns: flat, flows: declared }) });
  assert.deepEqual(diagnostics.undeclaredFlowDates, []);
  assert.deepEqual(dayOf(input, '2020-09-08').flows, [{ id: 'FLOW-20200908-A1', date: '2020-09-08', usd: -286409, kind: 'external' }]);
  const result = simulateEtfTrend(input);
  assert.equal(result.stop, null);
  const before = result.rows.find(r => r.date === '2020-09-07'), after = result.rows.find(r => r.date === '2020-09-08');
  assert.ok(after.endingUsd.B < before.endingUsd.B - 280000 && after.endingUsd.C < before.endingUsd.C - 280000);
  // The index is flow-adjusted: a withdrawal is not a loss.
  assert.ok(after.index.A > before.index.A * .99);
});

test('an undeclared IB NAV jump stops the series at that day and names it; declaring it later resumes', () => {
  const performance = performanceFixture({ days, returns: flat, flows: { '2020-09-09': -300000 } });
  const first = buildEtfDailySummary(common({ performance }), { now });
  assert.deepEqual(first.diagnostics.undeclaredFlowDates, ['2020-09-09']);
  assert.equal(first.summary.stoppedAt, '2020-09-09'); assert.equal(first.summary.latestCompleteDate, '2020-09-08');
  assert.equal(first.summary.rows.at(-1).date, '2020-09-08');
  const second = buildEtfDailySummary(common({ performance, ledger: ledger([flow('2020-09-09', 'out', 300000)]) }), { now });
  assert.equal(second.summary.stoppedAt, null); assert.equal(second.summary.latestCompleteDate, '2020-09-11');
  // Small residuals inside the tolerance are internal cash movement, not flows.
  const small = performanceFixture({ days, returns: flat, flows: { '2020-09-09': -FLOW_TOLERANCE.floorUsd + 1 } });
  const third = buildEtfDailySummary(common({ performance: small }), { now });
  assert.equal(third.summary.stoppedAt, null);
});

test('a money-weighted series cannot check flows and says so; the declared ledger still applies', () => {
  const performance = performanceFixture({ days, returns: flat, flows: { '2020-09-09': -300000 }, measure: 'MWR' });
  const { diagnostics } = build({ performance });
  assert.equal(diagnostics.measure, 'MWR'); assert.deepEqual(diagnostics.undeclaredFlowDates, []);
});

test('a London holiday with the account open carries prices; a trading day without an IB reading stops the series', () => {
  const holiday = '2020-09-07';
  const fromHoliday = build({ bars: allBars(days.filter(d => d !== holiday)) });
  const day = dayOf(fromHoliday.input, holiday);
  assert.ok(SYMBOLS.every(s => day.quotes[s].status === 'closed')); assert.equal(typeof day.actualUsd, 'number');
  assert.equal(simulateEtfTrend(fromHoliday.input).latestCompleteDate, '2020-09-11');
  const withoutNav = days.filter(d => d !== '2020-09-09');
  const gap = build({ performance: performanceFixture({ days: withoutNav, returns: flat.slice(0, withoutNav.length) }) });
  assert.equal(dayOf(gap.input, '2020-09-09').actualUsd, null);
  const result = simulateEtfTrend(gap.input);
  assert.equal(result.stop.date, '2020-09-09'); assert.equal(result.latestCompleteDate, '2020-09-08');
  // A single missing bar (not the whole venue) is a data gap, not a closed session.
  const partial = build({ bars: allBars(days, { EIMI: ['2020-09-10'] }) });
  assert.equal(dayOf(partial.input, '2020-09-10').quotes.EIMI.status, 'missing');
});

test('baseline evidence must be complete and clean; the series never starts from a partial run day', () => {
  assert.throws(() => build({ cutoff: '2020-08-31' }), /No completed day after the baseline/);
  assert.throws(() => build({ bars: allBars(days.slice(1)) }), /Baseline day has no CSPX close/);
  assert.throws(() => build({ performance: performanceFixture({ days: days.slice(1), returns: flat.slice(1) }) }), /reaches the baseline|no official IB NAV/);
  assert.throws(() => build({ ledger: ledger([flow('2020-09-01', 'in', 1)]) }), /baseline day must be dated the next day/);
  // A NOAH-HK transaction dated on the baseline day is inside the baseline close, not a flow after it.
  const onBaseline = build({ noahCash: noahFixture({ transactions: [tx(1, '2020-09-01', 5000)] }) });
  assert.deepEqual(dayOf(onBaseline.input, '2020-09-01').flows, []);
  assert.equal(onBaseline.input.days.every(d => d.flows.length === 0), true);
  // The run-day cutoff excludes the still-open session even when a partial bar exists.
  const { diagnostics } = build({ cutoff: '2020-09-10' });
  assert.equal(diagnostics.endDate, '2020-09-10');
  // The cash listing must reach the end of the series.
  assert.throws(() => build({ noahCash: noahFixture({ listingDate: '2020-09-09', to: '2020-09-09' }) }), /older than the comparison end/);
});

test('the summary is the public allowlist only, and the CLI writes it once without printing an amount', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuan-etf-daily-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, value) => { const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  const performance = write('pa.json', performanceFixture({ days, returns: flat, flows: { '2020-09-08': 50000 } }));
  const bars = write('bars.json', allBars(days));
  const noahCash = write('noah.json', noahFixture({ transactions: [tx(1, '2020-09-03', 15908.29)] }));
  const flows = write('flows.json', ledger([flow('2020-09-08', 'in', 50000)]));
  const calls = write('calls.json', pending());
  const base = write('baseline.json', baseline());
  const out = path.join(dir, 'summary.json');
  const printed = runCli(['build', '--performance', performance, '--bars', bars, '--noah-cash', noahCash, '--out', out,
    '--flows', flows, '--pending-calls', calls, '--baseline', base, '--cutoff', '2020-09-11'], { now });
  assert.equal(printed.status, 'built'); assert.equal(printed.latestCompleteDate, '2020-09-11'); assert.equal(printed.stoppedAt, null);
  assert.equal(printed.cashListingDate, '2020-09-13'); assert.equal(printed.cashTransactions, 1);
  for (const value of Object.values(printed)) assert.ok(typeof value !== 'number' || value < 1000, 'CLI output must carry no amount');
  const text = fs.readFileSync(out, 'utf8');
  const summary = validateOpenEtfTrend(JSON.parse(text), { now });
  assert.equal(JSON.stringify(summary), text);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  for (const forbidden of ['sourceRef', 'initialUsd', 'flows', 'FLOW-', 'SS-', 'CALL-', 'synthetic', 'cps', 'relativeWealth', '87468', '15908']) assert.ok(!text.includes(forbidden), forbidden);
  assert.throws(() => runCli(['build', '--performance', performance, '--bars', bars, '--noah-cash', noahCash, '--out', out, '--cutoff', '2020-09-11'], { now }), /new .json/);
  assert.throws(() => runCli(['build', '--performance', performance, '--bars', bars, '--out', path.join(dir, 'other.json'), '--cutoff', '2020-09-11'], { now }), /Usage/);
});
