// Synthetic-shape tests for the v2.1 daily ABC producer. The fixtures mirror the
// exact response shapes of get_pa_performance_all_periods and get_price_history
// observed on 2026-09-17; no test reads a network or a financial account.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simulateEtfTrend, validateOpenEtfTrend } from './xuan-ib-etf-trend.mjs';
import { SYMBOLS, FLOW_TOLERANCE, validateFlowLedger, validateBaseline, validateInstruments, normalizePaPerformance,
  normalizePriceBars, dailyCutoff, buildEtfDailyInput, buildEtfDailySummary, runCli } from './xuan-ib-etf-daily.mjs';

const repo = new URL('../', import.meta.url);
const readRepo = file => JSON.parse(fs.readFileSync(new URL(file, repo), 'utf8'));
const compact = d => d.replaceAll('-', '');
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekend = d => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
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
const baseline = (startDate = '2020-09-01') => ({ schemaVersion: 1, purpose: 'xuan-etf-daily-baseline', methodId: 'xuan-etf-indicative-v2', startDate, frozenDate: startDate, reserveUsd: 240000, note: '' });
const ledger = (flows = []) => ({ schemaVersion: 1, purpose: 'xuan-etf-owner-declared-flows', note: '', flows });
const flow = (date, direction, usd, suffix = 'A1') => ({ id: `FLOW-${compact(date)}-${suffix}`, date, account: 'IB-HK', direction, usd, note: 'synthetic' });
const instruments = () => readRepo('claude/xuan-ib-etf-instruments-v1.json');
const days = tradingDays('2020-09-01', '2020-09-11');
const flat = days.map((_, i) => (i % 2 ? .01 : -.005));
const now = new Date('2020-09-14T13:30:00Z');

test('repository ledger, baseline and instrument files are valid and value-free', () => {
  const led = validateFlowLedger(readRepo('claude/xuan-ib-etf-flows-v1.json'));
  assert.deepEqual(led.flows, []);
  const base = validateBaseline(readRepo('claude/xuan-ib-etf-baseline-v2.json'));
  assert.equal(base.startDate, '2026-09-17'); assert.equal(base.frozenDate, base.startDate);
  for (const key of Object.keys(base)) assert.ok(!/usd|nav|price|close/i.test(key) || key === 'reserveUsd', key);
  const inst = validateInstruments(instruments());
  assert.deepEqual(Object.keys(inst.instruments).sort(), [...SYMBOLS].sort());
  assert.equal(inst.instruments.CSPX.isin, 'IE00B5BMR087');
});

test('flow ledger validation is strict: dated ids, IB-HK only, positive USD, append order', () => {
  validateFlowLedger(ledger([flow('2020-09-02', 'out', 286409), flow('2020-09-03', 'in', 5000, 'B2')]));
  const bad = [
    [flow('2020-09-02', 'out', 286409), flow('2020-09-02', 'out', 1, 'A1')],
    [{ ...flow('2020-09-02', 'out', 1), id: 'FLOW-20200903-A1' }],
    [{ ...flow('2020-09-02', 'out', 1), account: 'NOAH-HK' }],
    [{ ...flow('2020-09-02', 'out', 1), direction: 'transfer' }],
    [{ ...flow('2020-09-02', 'out', -1) }],
    [{ ...flow('2020-09-02', 'out', 1), extra: true }],
    [flow('2020-09-03', 'out', 1), flow('2020-09-02', 'out', 1, 'B2')],
  ];
  for (const flows of bad) assert.throws(() => validateFlowLedger(ledger(flows)), new RegExp('Flow'));
  assert.throws(() => validateBaseline({ ...baseline('2020-09-05') }), /weekday/);
  assert.throws(() => validateBaseline({ ...baseline(), frozenDate: '2020-09-02' }), /Invalid daily baseline/);
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
  const bars = normalizePriceBars(barsFixture(days, 100));
  assert.deepEqual(bars.bars.map(b => b.date), days);
  assert.throws(() => normalizePriceBars({ ...barsFixture(days, 100), chart_step: 3600 }), /Unexpected price history/);
  const unordered = barsFixture(days, 100); unordered.time.reverse();
  assert.throws(() => normalizePriceBars(unordered), /ordered/);
});

test('the daily cutoff is the day before the London date of the run: the run-day session is still open', () => {
  assert.equal(dailyCutoff(new Date('2026-09-17T13:30:00Z')), '2026-09-16');
  assert.equal(dailyCutoff(new Date('2026-09-17T23:30:00Z')), '2026-09-17');
  assert.equal(dailyCutoff(new Date('2026-12-31T23:30:00Z')), '2026-12-30'); // London is on GMT in winter
});

test('a clean fortnight replays every calendar day: weekends carry the account and mark the venue closed', () => {
  const { input, diagnostics } = buildEtfDailyInput({ baseline: baseline(), ledger: ledger(), instruments: instruments(),
    performance: performanceFixture({ days, returns: flat }), bars: allBars(days), cutoff: '2020-09-13' });
  assert.equal(diagnostics.endDate, '2020-09-11');
  assert.equal(input.days.length, 11); assert.equal(input.days[0].date, '2020-09-01'); assert.equal(input.days.at(-1).date, '2020-09-11');
  const saturday = input.days.find(d => d.date === '2020-09-05');
  assert.equal(saturday.actualUsd, input.days.find(d => d.date === '2020-09-04').actualUsd);
  assert.ok(SYMBOLS.every(s => saturday.quotes[s].status === 'closed'));
  assert.ok(input.days.every(d => d.flowsComplete && d.actualComplete && d.flows.length === 0));
  assert.ok(input.days.every(d => /^ib-pa-performance:1M:[0-9a-f]{16};ib-price-history:CSPX:[0-9a-f]{16}/.test(d.sourceRef)));
  assert.deepEqual(diagnostics.undeclaredFlowDates, []);
  const result = simulateEtfTrend(input);
  assert.equal(result.latestCompleteDate, '2020-09-11'); assert.equal(result.stop, null);
});

test('a declared flow that matches the account\'s own return-free movement is accepted and reaches B and C', () => {
  const declared = { '2020-09-08': -286409 };
  const { input, diagnostics } = buildEtfDailyInput({ baseline: baseline(), ledger: ledger([flow('2020-09-08', 'out', 286409)]), instruments: instruments(),
    performance: performanceFixture({ days, returns: flat, flows: declared }), bars: allBars(days), cutoff: '2020-09-11' });
  assert.deepEqual(diagnostics.undeclaredFlowDates, []);
  const day = input.days.find(d => d.date === '2020-09-08');
  assert.deepEqual(day.flows, [{ id: 'FLOW-20200908-A1', date: '2020-09-08', usd: -286409, kind: 'external' }]);
  const result = simulateEtfTrend(input);
  assert.equal(result.stop, null);
  const before = result.rows.find(r => r.date === '2020-09-07'), after = result.rows.find(r => r.date === '2020-09-08');
  assert.ok(after.endingUsd.B < before.endingUsd.B - 280000 && after.endingUsd.C < before.endingUsd.C - 280000);
  // The index is flow-adjusted: a withdrawal is not a loss.
  assert.ok(after.index.A > before.index.A * .99);
});

test('an undeclared NAV jump stops the series at that day and names it; declaring it later resumes', () => {
  const performance = performanceFixture({ days, returns: flat, flows: { '2020-09-09': -300000 } });
  const first = buildEtfDailySummary({ baseline: baseline(), ledger: ledger(), instruments: instruments(), performance, bars: allBars(days), cutoff: '2020-09-11' }, { now });
  assert.deepEqual(first.diagnostics.undeclaredFlowDates, ['2020-09-09']);
  assert.equal(first.summary.stoppedAt, '2020-09-09'); assert.equal(first.summary.latestCompleteDate, '2020-09-08');
  assert.equal(first.summary.rows.at(-1).date, '2020-09-08');
  const second = buildEtfDailySummary({ baseline: baseline(), ledger: ledger([flow('2020-09-09', 'out', 300000)]), instruments: instruments(), performance, bars: allBars(days), cutoff: '2020-09-11' }, { now });
  assert.equal(second.summary.stoppedAt, null); assert.equal(second.summary.latestCompleteDate, '2020-09-11');
  // Small residuals inside the tolerance are internal cash movement, not flows.
  const small = performanceFixture({ days, returns: flat, flows: { '2020-09-09': -FLOW_TOLERANCE.floorUsd + 1 } });
  const third = buildEtfDailySummary({ baseline: baseline(), ledger: ledger(), instruments: instruments(), performance: small, bars: allBars(days), cutoff: '2020-09-11' }, { now });
  assert.equal(third.summary.stoppedAt, null);
});

test('a money-weighted series cannot check flows and says so; the declared ledger still applies', () => {
  const performance = performanceFixture({ days, returns: flat, flows: { '2020-09-09': -300000 }, measure: 'MWR' });
  const { diagnostics } = buildEtfDailyInput({ baseline: baseline(), ledger: ledger(), instruments: instruments(), performance, bars: allBars(days), cutoff: '2020-09-11' });
  assert.equal(diagnostics.measure, 'MWR'); assert.deepEqual(diagnostics.undeclaredFlowDates, []);
});

test('a London holiday with the account open carries prices; a trading day without an IB reading stops the series', () => {
  const holiday = '2020-09-07';
  const fromHoliday = buildEtfDailyInput({ baseline: baseline(), ledger: ledger(), instruments: instruments(),
    performance: performanceFixture({ days, returns: flat }), bars: allBars(days.filter(d => d !== holiday)), cutoff: '2020-09-11' });
  const day = fromHoliday.input.days.find(d => d.date === holiday);
  assert.ok(SYMBOLS.every(s => day.quotes[s].status === 'closed')); assert.equal(typeof day.actualUsd, 'number');
  assert.equal(simulateEtfTrend(fromHoliday.input).latestCompleteDate, '2020-09-11');
  const withoutNav = days.filter(d => d !== '2020-09-09');
  const gap = buildEtfDailyInput({ baseline: baseline(), ledger: ledger(), instruments: instruments(),
    performance: performanceFixture({ days: withoutNav, returns: flat.slice(0, withoutNav.length) }), bars: allBars(days), cutoff: '2020-09-11' });
  assert.equal(gap.input.days.find(d => d.date === '2020-09-09').actualUsd, null);
  const result = simulateEtfTrend(gap.input);
  assert.equal(result.stop.date, '2020-09-09'); assert.equal(result.latestCompleteDate, '2020-09-08');
  // A single missing bar (not the whole venue) is a data gap, not a closed session.
  const partial = buildEtfDailyInput({ baseline: baseline(), ledger: ledger(), instruments: instruments(),
    performance: performanceFixture({ days, returns: flat }), bars: allBars(days, { EIMI: ['2020-09-10'] }), cutoff: '2020-09-11' });
  assert.equal(partial.input.days.find(d => d.date === '2020-09-10').quotes.EIMI.status, 'missing');
});

test('baseline evidence must be complete and clean; the series never starts from a partial run day', () => {
  const performance = performanceFixture({ days, returns: flat });
  const common = { baseline: baseline(), ledger: ledger(), instruments: instruments(), performance, bars: allBars(days) };
  assert.throws(() => buildEtfDailyInput({ ...common, cutoff: '2020-08-31' }), /No completed day after the baseline/);
  assert.throws(() => buildEtfDailyInput({ ...common, bars: allBars(days.slice(1)), cutoff: '2020-09-11' }), /Baseline day has no CSPX close/);
  assert.throws(() => buildEtfDailyInput({ ...common, performance: performanceFixture({ days: days.slice(1), returns: flat.slice(1) }), cutoff: '2020-09-11' }), /reaches the baseline|no official IB NAV/);
  assert.throws(() => buildEtfDailyInput({ ...common, ledger: ledger([flow('2020-09-01', 'in', 1)]), cutoff: '2020-09-11' }), /baseline day must be dated the next day/);
  // The run-day cutoff excludes the still-open session even when a partial bar exists.
  const { diagnostics } = buildEtfDailyInput({ ...common, cutoff: '2020-09-10' });
  assert.equal(diagnostics.endDate, '2020-09-10');
});

test('the summary is the public allowlist only, and the CLI writes it once without printing an amount', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuan-etf-daily-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, value) => { const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  const performance = write('pa.json', performanceFixture({ days, returns: flat, flows: { '2020-09-08': 50000 } }));
  const bars = write('bars.json', allBars(days));
  const flows = write('flows.json', ledger([flow('2020-09-08', 'in', 50000)]));
  const base = write('baseline.json', baseline());
  const out = path.join(dir, 'summary.json');
  const printed = runCli(['build', '--performance', performance, '--bars', bars, '--out', out, '--flows', flows, '--baseline', base, '--cutoff', '2020-09-11'], { now });
  assert.equal(printed.status, 'built'); assert.equal(printed.latestCompleteDate, '2020-09-11'); assert.equal(printed.stoppedAt, null);
  for (const value of Object.values(printed)) assert.ok(typeof value !== 'number' || value < 1000, 'CLI output must carry no amount');
  const text = fs.readFileSync(out, 'utf8');
  const summary = validateOpenEtfTrend(JSON.parse(text), { now });
  assert.equal(JSON.stringify(summary), text);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  for (const forbidden of ['sourceRef', 'initialUsd', 'flows', 'FLOW-', 'synthetic', 'cps', 'relativeWealth']) assert.ok(!text.includes(forbidden), forbidden);
  assert.throws(() => runCli(['build', '--performance', performance, '--bars', bars, '--out', out, '--cutoff', '2020-09-11'], { now }), /new .json/);
  assert.throws(() => runCli(['build', '--performance', performance], { now }), /Usage/);
});
