#!/usr/bin/env node
// v2.1 simplified daily ABC producer. Pure assembly: it turns the IB
// PortfolioAnalyst daily NAV series, the four LSE ETF daily bars, the
// owner-declared flow ledger and the dated baseline into the private input of
// simulateEtfTrend, replays from the baseline and returns the public open
// summary. It fetches nothing, writes nothing but the requested output, and
// prints no amount. Financial systems stay read-only.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TREND_METHOD, ETF_WEIGHTS, simulateEtfTrend, projectOpenEtfTrend, zoneDate } from './xuan-ib-etf-trend.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SYMBOLS = Object.freeze(Object.keys(ETF_WEIGHTS));
export const FLOW_LEDGER_PATH = 'claude/xuan-ib-etf-flows-v1.json';
export const BASELINE_PATH = 'claude/xuan-ib-etf-baseline-v2.json';
export const INSTRUMENTS_PATH = 'claude/xuan-ib-etf-instruments-v1.json';
// The reading of a flow the account itself reports is a return-free NAV jump.
// Below this the residual is rounding and internal cash movement; above it the
// day is a flow the owner has not declared and the comparison must not guess.
export const FLOW_TOLERANCE = Object.freeze({ floorUsd: 10000, fraction: 0.0025 });
const fail = message => { throw new Error(message); };
const check = (ok, message) => { if (!ok) fail(message); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const validDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const nextDate = d => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const prevDate = d => new Date(Date.parse(`${d}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
const weekend = d => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

export function validateFlowLedger(ledger) {
  check(object(ledger) && ledger.schemaVersion === 1 && ledger.purpose === 'xuan-etf-owner-declared-flows'
    && Array.isArray(ledger.flows), 'Invalid flow ledger');
  const ids = new Set();
  for (const [i, flow] of ledger.flows.entries()) {
    check(object(flow) && Object.keys(flow).sort().join(',') === 'account,date,direction,id,note,usd', `Flow ${i}: unexpected fields`);
    check(typeof flow.id === 'string' && /^FLOW-\d{8}-[A-Z0-9]{2,12}$/.test(flow.id) && !ids.has(flow.id), `Flow ${i}: invalid or duplicate id`);
    check(validDate(flow.date) && flow.id.slice(5, 13) === flow.date.replaceAll('-', ''), `Flow ${i}: id must carry its own date`);
    check(flow.account === 'IB-HK', `Flow ${i}: only the IB-HK account is inside the comparison`);
    check(['in', 'out'].includes(flow.direction), `Flow ${i}: direction must be in or out`);
    check(finite(flow.usd) && flow.usd > 0 && flow.usd < 1e9, `Flow ${i}: amount must be a positive USD number`);
    check(typeof flow.note === 'string' && flow.note.length <= 200, `Flow ${i}: note too long`);
    if (i) check(flow.date >= ledger.flows[i - 1].date, `Flow ${i}: ledger must stay in date order`);
    ids.add(flow.id);
  }
  return ledger;
}

export function validateBaseline(baseline) {
  check(object(baseline) && baseline.schemaVersion === 1 && baseline.purpose === 'xuan-etf-daily-baseline'
    && baseline.methodId === TREND_METHOD && validDate(baseline.startDate) && validDate(baseline.frozenDate)
    && baseline.frozenDate === baseline.startDate && baseline.reserveUsd === 240000, 'Invalid daily baseline');
  check(!weekend(baseline.startDate), 'Baseline must be a weekday close');
  return baseline;
}

export function validateInstruments(instruments) {
  check(object(instruments) && instruments.schemaVersion === 1 && instruments.purpose === 'xuan-etf-daily-instruments'
    && object(instruments.instruments) && Object.keys(instruments.instruments).sort().join(',') === [...SYMBOLS].sort().join(','), 'Invalid instrument registry');
  for (const symbol of SYMBOLS) {
    const item = instruments.instruments[symbol];
    check(object(item) && Number.isSafeInteger(item.contractId) && item.contractId > 0 && item.exchange === 'LSEETF'
      && item.currency === 'USD', `Instrument ${symbol}: invalid identity`);
  }
  return instruments;
}

// The PortfolioAnalyst response carries several overlapping windows. Take the
// longest one that still starts on or before the baseline; every window is the
// same official daily series, so no value is averaged or preferred.
export function normalizePaPerformance(response, { startDate }) {
  const account = response?.accounts?.account;
  check(object(account) && object(account.periods) && account.base_currency === 'USD', 'Unexpected PortfolioAnalyst response');
  const measure = response.portfolio_measure;
  check(['TWR', 'MWR'].includes(measure), 'Unknown portfolio measure');
  const candidates = Object.entries(account.periods).map(([name, period]) => {
    check(object(period) && Array.isArray(period.dates) && Array.isArray(period.nav) && Array.isArray(period.cps)
      && period.dates.length === period.nav.length && period.nav.length === period.cps.length && period.frequency === 'D'
      && /^\d{8}$/.test(period.start_date) && finite(period.start_nav), `Malformed period ${name}`);
    return { name, period };
  }).filter(({ period }) => period.dates.length && period.dates[0] <= startDate.replaceAll('-', ''));
  check(candidates.length, 'No PortfolioAnalyst window reaches the baseline');
  candidates.sort((a, b) => a.period.dates[0].localeCompare(b.period.dates[0]));
  const { name, period } = candidates[0];
  const series = period.dates.map((raw, i) => {
    check(/^\d{8}$/.test(raw) && (!i || raw > period.dates[i - 1]), `Period ${name}: dates must be ordered`);
    check(finite(period.nav[i]) && period.nav[i] > 0 && finite(period.cps[i]), `Period ${name}: invalid value`);
    const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    check(validDate(date), `Period ${name}: invalid date`);
    return { date, nav: period.nav[i], cps: period.cps[i] };
  });
  return { measure, window: name, startNav: period.start_nav, series, fingerprint: fingerprint(response) };
}

export function normalizePriceBars(response) {
  check(object(response) && Array.isArray(response.time) && Array.isArray(response.close)
    && response.time.length === response.close.length && response.chart_step === 86400, 'Unexpected price history response');
  const bars = response.time.map((time, i) => {
    const ms = Date.parse(time);
    check(typeof time === 'string' && Number.isFinite(ms) && finite(response.close[i]) && response.close[i] > 0, 'Invalid price bar');
    // Daily bars are stamped at the London session open; the UTC date is the trading date.
    return { date: new Date(ms).toISOString().slice(0, 10) };
  }).map((bar, i) => ({ ...bar, close: response.close[i] }));
  for (let i = 1; i < bars.length; i++) check(bars[i].date > bars[i - 1].date, 'Price bars must be ordered daily bars');
  return { bars, fingerprint: fingerprint(response) };
}

// The last date a completed London session and a completed IB day can both be
// read for. At the PM run (09:30 New York) the London session of the run date
// is still open, so the series ends the day before the run's London date.
export function dailyCutoff(now = new Date()) {
  return prevDate(zoneDate('Europe/London', now));
}

export function buildEtfDailyInput({ baseline, ledger, instruments, performance, bars, cutoff }) {
  validateBaseline(baseline); validateFlowLedger(ledger); validateInstruments(instruments);
  check(validDate(cutoff), 'Invalid cutoff');
  const pa = normalizePaPerformance(performance, { startDate: baseline.startDate });
  check(object(bars) && Object.keys(bars).sort().join(',') === [...SYMBOLS].sort().join(','), 'Bars for all four instruments required');
  const priceMaps = {}, priceFingerprints = {};
  for (const symbol of SYMBOLS) {
    const normalized = normalizePriceBars(bars[symbol]);
    priceMaps[symbol] = new Map(normalized.bars.map(bar => [bar.date, bar.close]));
    priceFingerprints[symbol] = normalized.fingerprint;
  }
  const navMap = new Map(pa.series.map(row => [row.date, row]));
  check(navMap.has(baseline.startDate), 'Baseline day has no official IB NAV yet');
  for (const symbol of SYMBOLS) check(priceMaps[symbol].has(baseline.startDate), `Baseline day has no ${symbol} close yet`);
  const lastNav = pa.series.at(-1).date;
  const lastBar = SYMBOLS.map(s => [...priceMaps[s].keys()].at(-1)).sort()[0];
  const endDate = [cutoff, lastNav, lastBar].sort()[0];
  check(endDate >= baseline.startDate, 'No completed day after the baseline yet');
  const flowsByDate = new Map();
  for (const flow of ledger.flows) {
    const usd = flow.direction === 'in' ? flow.usd : -flow.usd;
    flowsByDate.set(flow.date, [...(flowsByDate.get(flow.date) || []), { id: flow.id, date: flow.date, usd, kind: 'external' }]);
  }
  check(!flowsByDate.has(baseline.startDate), 'A flow on the baseline day must be dated the next day: the baseline is a clean close');
  const tolerance = nav => Math.max(FLOW_TOLERANCE.floorUsd, FLOW_TOLERANCE.fraction * nav);
  const sourceRef = `ib-pa-performance:${pa.window}:${pa.fingerprint};${SYMBOLS.map(s => `ib-price-history:${s}:${priceFingerprints[s]}`).join(';')}`;
  const days = [], flagged = [];
  let carried = null, previousRow = null;
  for (let date = baseline.startDate; date <= endDate; date = nextDate(date)) {
    const row = navMap.get(date) ?? null;
    const closes = SYMBOLS.filter(s => priceMaps[s].has(date));
    // All four lines trade on one venue: no bar for any of them is a closed
    // session (weekend or London holiday), not four coincident data gaps.
    const marketClosed = closes.length === 0;
    const quotes = Object.fromEntries(SYMBOLS.map(s => [s, priceMaps[s].has(date)
      ? { status: 'close', usd: priceMaps[s].get(date), date, source: `ib-price-history:${instruments.instruments[s].exchange}` }
      : { status: marketClosed ? 'closed' : 'missing' }]));
    let actualUsd, flowsComplete = true;
    if (row) {
      actualUsd = row.nav;
      // Return-free NAV movement is money crossing the boundary. Compare the
      // account's own time-weighted reading with what the owner declared.
      if (pa.measure === 'TWR' && previousRow) {
        const dailyReturn = (1 + row.cps) / (1 + previousRow.cps) - 1;
        const implied = row.nav - previousRow.nav * (1 + dailyReturn);
        const declared = (flowsByDate.get(date) || []).reduce((sum, f) => sum + f.usd, 0);
        if (Math.abs(implied - declared) > tolerance(previousRow.nav)) { flowsComplete = false; flagged.push(date); }
      }
      previousRow = row; carried = row.nav;
    } else if (marketClosed && carried !== null) {
      actualUsd = carried; // No session anywhere: the account did not move.
    } else {
      actualUsd = null; // A trading day without an official IB reading stops the series.
    }
    days.push({ date, actualUsd, actualComplete: true, flowsComplete, flows: flowsByDate.get(date) || [], quotes, sourceRef });
  }
  const input = { methodId: TREND_METHOD, startDate: baseline.startDate, frozenDate: baseline.frozenDate,
    initialUsd: navMap.get(baseline.startDate).nav, reserveUsd: baseline.reserveUsd, days };
  return { input, diagnostics: { measure: pa.measure, window: pa.window, cutoff, endDate, days: days.length, undeclaredFlowDates: flagged } };
}

export function buildEtfDailySummary(args, { now = new Date() } = {}) {
  const { input, diagnostics } = buildEtfDailyInput({ ...args, cutoff: args.cutoff ?? dailyCutoff(now) });
  const result = simulateEtfTrend(input);
  const summary = projectOpenEtfTrend(result, { now });
  return { summary, diagnostics: { ...diagnostics, latestCompleteDate: summary.latestCompleteDate, stoppedAt: summary.stoppedAt, rows: summary.rows.length } };
}

const readJson = file => {
  const text = fs.readFileSync(file, 'utf8');
  try { return JSON.parse(text); } catch { fail(`Invalid JSON: ${file}`); }
};

export function runCli(argv, { now = new Date(), cwd = repo } = {}) {
  const usage = 'Usage: build --performance FILE --bars FILE --out FILE [--flows FILE] [--baseline FILE] [--instruments FILE] [--cutoff YYYY-MM-DD]';
  check(argv[0] === 'build' && argv.length % 2 === 1, usage);
  const options = {};
  for (let i = 1; i < argv.length; i += 2) {
    check(['--performance', '--bars', '--out', '--flows', '--baseline', '--instruments', '--cutoff'].includes(argv[i]) && argv[i + 1] && !Object.hasOwn(options, argv[i]), usage);
    options[argv[i]] = argv[i + 1];
  }
  check(options['--performance'] && options['--bars'] && options['--out'], usage);
  const resolve = (flag, fallback) => path.resolve(cwd, options[flag] ?? fallback);
  const out = path.resolve(cwd, options['--out']);
  check(out.endsWith('.json') && !fs.existsSync(out), 'Output must be a new .json file');
  const { summary, diagnostics } = buildEtfDailySummary({
    baseline: readJson(resolve('--baseline', BASELINE_PATH)),
    ledger: readJson(resolve('--flows', FLOW_LEDGER_PATH)),
    instruments: readJson(resolve('--instruments', INSTRUMENTS_PATH)),
    performance: readJson(resolve('--performance')),
    bars: readJson(resolve('--bars')),
    cutoff: options['--cutoff'] ?? null,
  }, { now });
  fs.writeFileSync(out, JSON.stringify(summary), { flag: 'wx', mode: 0o600 });
  // Dates and counts only: the log of an unattended run must never carry an amount.
  return { status: 'built', out, ...diagnostics };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(runCli(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
