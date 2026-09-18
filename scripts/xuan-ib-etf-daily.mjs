#!/usr/bin/env node
// v2.2 simplified daily ABC producer. Pure assembly: it turns the IB
// PortfolioAnalyst daily NAV series, the four LSE ETF daily bars, the NOAH-HK
// Sharesight cash account (listing and transactions), the owner-declared flow
// ledger, the owner-declared pending-call ledger and the dated baseline into the
// private input of simulateEtfTrend, replays from the baseline and returns the
// public open summary. It fetches nothing, writes nothing but the requested
// output, and prints no amount. Financial systems stay read-only.
//
// Pool (owner decision 2026-09-18, poolVersion 2): the compared wealth A is
//   IB-HK official daily NAV + NOAH-HK cash balance − pending calls.
// NOAH-HK cash movements are taken from the Sharesight cash-account
// transactions themselves (DEPOSIT / WITHDRAWAL are pool flows; interest and
// fees are return). The owner declares only the IB-HK side: external money in
// or out of IB-HK, and transfers between NOAH-HK cash and IB-HK, which are
// internal to the pool. A change of the pending-call level is a boundary
// adjustment (scope flow), never a return.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TREND_METHOD, ETF_WEIGHTS, simulateEtfTrend, projectOpenEtfTrend, zoneDate } from './xuan-ib-etf-trend.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SYMBOLS = Object.freeze(Object.keys(ETF_WEIGHTS));
export const FLOW_LEDGER_PATH = 'claude/xuan-ib-etf-flows-v1.json';
export const PENDING_CALLS_PATH = 'claude/xuan-ib-etf-pending-calls-v1.json';
export const BASELINE_PATH = 'claude/xuan-ib-etf-baseline-v2.json';
export const INSTRUMENTS_PATH = 'claude/xuan-ib-etf-instruments-v1.json';
export const POOL_VERSION = 2;
export const POOL_CASH_ACCOUNT = 'NOAH-HK';
// Sharesight cash-account transaction types. A movement crosses the pool
// boundary; a return type is income or cost inside it. Any other type is
// unknown to this module and stops the day rather than being guessed.
export const NOAH_MOVEMENT_TYPES = Object.freeze(['DEPOSIT', 'WITHDRAWAL', 'OPENING_BALANCE']);
export const NOAH_RETURN_TYPES = Object.freeze(['INTEREST_PAYMENT', 'FEE', 'FEE_REIMBURSEMENT']);
// The reading of a flow the IB account itself reports is a return-free NAV jump.
// Below this the residual is rounding and internal cash movement; above it the
// day is a flow the owner has not declared and the comparison must not guess.
export const FLOW_TOLERANCE = Object.freeze({ floorUsd: 10000, fraction: 0.0025 });
const CENTS = 0.005;
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
const round2 = v => Math.round(v * 100) / 100;
// A captured connector result may be the tool envelope, its data or the bare payload.
const unwrap = r => (object(r) && object(r.result) && object(r.result.data)) ? r.result.data : (object(r) && object(r.data) ? r.data : r);

export function validateFlowLedger(ledger) {
  check(object(ledger) && ledger.schemaVersion === 1 && ledger.purpose === 'xuan-etf-owner-declared-flows'
    && Array.isArray(ledger.flows), 'Invalid flow ledger');
  const ids = new Set();
  for (const [i, flow] of ledger.flows.entries()) {
    check(object(flow) && Object.keys(flow).sort().join(',') === 'account,date,direction,id,kind,note,usd', `Flow ${i}: unexpected fields`);
    check(typeof flow.id === 'string' && /^FLOW-\d{8}-[A-Z0-9]{2,12}$/.test(flow.id) && !ids.has(flow.id), `Flow ${i}: invalid or duplicate id`);
    check(validDate(flow.date) && flow.id.slice(5, 13) === flow.date.replaceAll('-', ''), `Flow ${i}: id must carry its own date`);
    check(flow.account === 'IB-HK', `Flow ${i}: the ledger declares the IB-HK side only; NOAH-HK cash movements come from Sharesight`);
    check(['in', 'out'].includes(flow.direction), `Flow ${i}: direction must be in or out`);
    check(['external', 'transfer'].includes(flow.kind), `Flow ${i}: kind must be external or transfer`);
    check(finite(flow.usd) && flow.usd > 0 && flow.usd < 1e9, `Flow ${i}: amount must be a positive USD number`);
    check(typeof flow.note === 'string' && flow.note.length <= 200, `Flow ${i}: note too long`);
    if (i) check(flow.date >= ledger.flows[i - 1].date, `Flow ${i}: ledger must stay in date order`);
    ids.add(flow.id);
  }
  return ledger;
}

export function validatePendingCalls(ledger) {
  check(object(ledger) && ledger.schemaVersion === 1 && ledger.purpose === 'xuan-etf-owner-declared-pending-calls'
    && Array.isArray(ledger.entries) && ledger.entries.length > 0, 'Invalid pending-call ledger');
  const ids = new Set();
  for (const [i, entry] of ledger.entries.entries()) {
    check(object(entry) && Object.keys(entry).sort().join(',') === 'date,id,note,usd', `Pending call ${i}: unexpected fields`);
    check(typeof entry.id === 'string' && /^CALL-\d{8}-[A-Z0-9]{2,12}$/.test(entry.id) && !ids.has(entry.id), `Pending call ${i}: invalid or duplicate id`);
    check(validDate(entry.date) && entry.id.slice(5, 13) === entry.date.replaceAll('-', ''), `Pending call ${i}: id must carry its own date`);
    check(finite(entry.usd) && entry.usd >= 0 && entry.usd < 1e9, `Pending call ${i}: level must be a non-negative USD number`);
    check(typeof entry.note === 'string' && entry.note.length <= 300, `Pending call ${i}: note too long`);
    if (i) check(entry.date > ledger.entries[i - 1].date, `Pending call ${i}: one level per date, in date order`);
    ids.add(entry.id);
  }
  return ledger;
}

export function validateBaseline(baseline) {
  check(object(baseline) && baseline.schemaVersion === 1 && baseline.purpose === 'xuan-etf-daily-baseline'
    && baseline.methodId === TREND_METHOD && validDate(baseline.startDate) && validDate(baseline.frozenDate)
    && baseline.frozenDate === baseline.startDate, 'Invalid daily baseline');
  // poolVersion 2: pending calls are deducted at the pool boundary, so B keeps
  // no separate reserve. The v2.1 shape (IB NAV only, reserve 240,000) is no
  // longer produced by this builder.
  check(baseline.poolVersion === POOL_VERSION && baseline.reserveUsd === 0, 'Baseline must declare poolVersion 2 with no separate reserve');
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
  const cash = instruments.cashAccounts?.[POOL_CASH_ACCOUNT];
  check(object(instruments.cashAccounts) && Object.keys(instruments.cashAccounts).join(',') === POOL_CASH_ACCOUNT
    && object(cash) && Number.isSafeInteger(cash.cashAccountId) && cash.cashAccountId > 0
    && Number.isSafeInteger(cash.portfolioId) && cash.portfolioId > 0 && cash.currency === 'USD', 'Invalid pool cash account identity');
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

// The NOAH-HK cash part of the pool, from the Sharesight cash-account listing
// (the balance on the listing date) and the account's transactions. The daily
// balance is reconstructed backwards from the listing balance: balance(t) =
// listing balance − Σ amounts dated after t. Sharesight stamps a transaction at
// 04:00Z of its civil date, so the UTC date of `date_time` is the transaction
// date. Movement types are pool flows on their date; return types are not.
export function normalizeNoahCash(raw, identity, { startDate, endDate }) {
  check(object(raw), 'NOAH-HK cash input required');
  const listing = unwrap(raw.accounts), transactions = unwrap(raw.transactions);
  check(object(listing) && Array.isArray(listing.cash_accounts), 'Unexpected cash-account listing');
  const account = listing.cash_accounts.find(a => object(a) && a.id === identity.cashAccountId);
  check(account, 'Pool cash account is not in the listing');
  check(account.portfolio_id === identity.portfolioId && account.currency === 'USD' && account.portfolio_currency === 'USD',
    'Pool cash account identity or currency differs from the registry');
  check(validDate(account.date) && finite(account.balance) && account.balance >= 0, 'Cash-account listing has no dated balance');
  check(account.date >= endDate, 'Cash-account listing is older than the comparison end date');
  check(object(transactions) && Array.isArray(transactions.cash_account_transactions), 'Unexpected cash-transaction response');
  // The request window is evidence: it must reach back to the baseline and
  // forward to the listing date, or a movement could sit outside what was read.
  const self = transactions.links?.self;
  const window = typeof self === 'string' ? Object.fromEntries([...new URL(self).searchParams]) : {};
  check(validDate(window.from) && validDate(window.to) && window.from <= startDate && window.to >= account.date,
    'Cash-transaction window must cover the baseline through the listing date');
  const rows = transactions.cash_account_transactions.map((t, i) => {
    check(object(t) && t.cash_account_id === identity.cashAccountId, `Transaction ${i}: not the pool cash account`);
    check(Number.isSafeInteger(t.id) && typeof t.date_time === 'string' && Number.isFinite(Date.parse(t.date_time)), `Transaction ${i}: invalid identity or time`);
    check(finite(t.amount) && finite(t.balance), `Transaction ${i}: invalid amount or balance`);
    const type = t.cash_account_transaction_type?.name;
    check(typeof type === 'string' && type.length > 0, `Transaction ${i}: type missing`);
    return { id: t.id, date: new Date(Date.parse(t.date_time)).toISOString().slice(0, 10), ms: Date.parse(t.date_time), amount: t.amount, balance: t.balance, type };
  }).sort((a, b) => a.ms - b.ms || a.id - b.id);
  // The running balances must chain, and the chain must land on the listing.
  for (let i = 1; i < rows.length; i++) {
    check(Math.abs(rows[i - 1].balance + rows[i].amount - rows[i].balance) <= CENTS, `Transaction ${rows[i].id}: running balance does not chain`);
  }
  if (rows.length) {
    check(rows.at(-1).date <= account.date, 'Cash-account listing is older than its latest transaction');
    check(Math.abs(rows.at(-1).balance - account.balance) <= CENTS, 'Latest transaction balance does not match the listing balance');
  }
  const balanceOn = date => round2(rows.filter(r => r.date > date).reduce((sum, r) => sum - r.amount, account.balance));
  const movements = new Map(), unknownTypeDates = new Set();
  for (const r of rows) {
    if (r.date <= startDate || r.date > endDate) continue;
    if (NOAH_RETURN_TYPES.includes(r.type)) continue;
    if (!NOAH_MOVEMENT_TYPES.includes(r.type)) { unknownTypeDates.add(r.date); continue; }
    movements.set(r.date, [...(movements.get(r.date) || []), { id: `SS-${r.id}`, date: r.date, usd: r.amount, kind: 'external', type: r.type }]);
  }
  return { listingDate: account.date, listingBalance: account.balance, balanceOn, movements, unknownTypeDates,
    transactions: rows.length, fingerprint: `${fingerprint(listing)}:${fingerprint(transactions)}` };
}

// The last date a completed London session and a completed IB day can both be
// read for. At the PM run (09:30 New York) the London session of the run date
// is still open, so the series ends the day before the run's London date.
export function dailyCutoff(now = new Date()) {
  return prevDate(zoneDate('Europe/London', now));
}

export function buildEtfDailyInput({ baseline, ledger, pendingCalls, instruments, performance, bars, noahCash, cutoff }) {
  validateBaseline(baseline); validateFlowLedger(ledger); validatePendingCalls(pendingCalls); validateInstruments(instruments);
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
  const noah = normalizeNoahCash(noahCash, instruments.cashAccounts[POOL_CASH_ACCOUNT], { startDate: baseline.startDate, endDate });

  // The pending-call level in force on each day, and the boundary adjustment a
  // change of level makes: a higher level takes wealth out of the pool
  // (scope-out), a lower level returns it (scope-in). Neither is a return.
  const levels = pendingCalls.entries;
  check(levels[0].date <= baseline.startDate, 'No pending-call level is declared at the baseline');
  const pendingOn = date => levels.filter(e => e.date <= date).at(-1).usd;
  const scopeByDate = new Map();
  for (const [i, entry] of levels.entries()) {
    if (!i || entry.date <= baseline.startDate || entry.date > endDate) continue;
    const delta = entry.usd - levels[i - 1].usd;
    if (delta === 0) continue;
    scopeByDate.set(entry.date, [{ id: entry.id, date: entry.date, usd: -delta, kind: delta > 0 ? 'scope-out' : 'scope-in' }]);
  }

  // The owner's IB-side declarations. An external flow enters the pool; a
  // transfer only moves money between NOAH-HK cash and IB-HK, so it appears as
  // an internal item that offsets the Sharesight movement on the other side.
  const ibByDate = new Map();
  for (const flow of ledger.flows) {
    const usd = flow.direction === 'in' ? flow.usd : -flow.usd;
    const kind = flow.kind === 'external' ? 'external' : 'internal-transfer';
    ibByDate.set(flow.date, [...(ibByDate.get(flow.date) || []), { id: flow.id, date: flow.date, usd, kind }]);
  }
  check(!ibByDate.has(baseline.startDate), 'A flow on the baseline day must be dated the next day: the baseline is a clean close');
  const tolerance = nav => Math.max(FLOW_TOLERANCE.floorUsd, FLOW_TOLERANCE.fraction * nav);
  const sourceRef = `ib-pa-performance:${pa.window}:${pa.fingerprint};${SYMBOLS.map(s => `ib-price-history:${s}:${priceFingerprints[s]}`).join(';')};ss-cash:${noah.fingerprint}`;
  const days = [], flagged = [];
  let carried = null, previousRow = null;
  const pool = (date, nav) => round2(nav + noah.balanceOn(date) - pendingOn(date));
  for (let date = baseline.startDate; date <= endDate; date = nextDate(date)) {
    const row = navMap.get(date) ?? null;
    const closes = SYMBOLS.filter(s => priceMaps[s].has(date));
    // All four lines trade on one venue: no bar for any of them is a closed
    // session (weekend or London holiday), not four coincident data gaps.
    const marketClosed = closes.length === 0;
    const quotes = Object.fromEntries(SYMBOLS.map(s => [s, priceMaps[s].has(date)
      ? { status: 'close', usd: priceMaps[s].get(date), date, source: `ib-price-history:${instruments.instruments[s].exchange}` }
      : { status: marketClosed ? 'closed' : 'missing' }]));
    const ib = ibByDate.get(date) || [];
    let actualUsd, flowsComplete = !noah.unknownTypeDates.has(date);
    if (row) {
      // Return-free NAV movement is money crossing the IB-HK boundary. Compare
      // the account's own time-weighted reading with what the owner declared
      // for that side: external money and transfers with NOAH-HK cash.
      if (pa.measure === 'TWR' && previousRow) {
        const dailyReturn = (1 + row.cps) / (1 + previousRow.cps) - 1;
        const implied = row.nav - previousRow.nav * (1 + dailyReturn);
        const declared = ib.reduce((sum, f) => sum + f.usd, 0);
        if (Math.abs(implied - declared) > tolerance(previousRow.nav)) { flowsComplete = false; flagged.push(date); }
      }
      previousRow = row; carried = row.nav;
      actualUsd = pool(date, row.nav);
    } else if (marketClosed && carried !== null) {
      actualUsd = pool(date, carried); // No session anywhere: IB did not move; NOAH-HK cash may have.
    } else {
      actualUsd = null; // A trading day without an official IB reading stops the series.
    }
    if (actualUsd !== null && actualUsd < 0) actualUsd = null; // A pool below zero is not a comparable wealth.
    const flows = date === baseline.startDate ? [] : [...(noah.movements.get(date) || []).map(({ type, ...f }) => f), ...ib, ...(scopeByDate.get(date) || [])];
    days.push({ date, actualUsd, actualComplete: true, flowsComplete, flows, quotes, sourceRef });
  }
  const initialUsd = days[0].actualUsd;
  check(finite(initialUsd) && initialUsd > 0, 'Baseline pool is not a positive wealth');
  const input = { methodId: TREND_METHOD, startDate: baseline.startDate, frozenDate: baseline.frozenDate,
    initialUsd, reserveUsd: baseline.reserveUsd, days };
  return { input, diagnostics: { measure: pa.measure, window: pa.window, cutoff, endDate, days: days.length,
    poolVersion: POOL_VERSION, cashListingDate: noah.listingDate, cashTransactions: noah.transactions,
    pendingLevels: levels.length, undeclaredFlowDates: flagged, unknownCashTypeDates: [...noah.unknownTypeDates].sort() } };
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
  const usage = 'Usage: build --performance FILE --bars FILE --noah-cash FILE --out FILE [--flows FILE] [--pending-calls FILE] [--baseline FILE] [--instruments FILE] [--cutoff YYYY-MM-DD]';
  check(argv[0] === 'build' && argv.length % 2 === 1, usage);
  const options = {};
  for (let i = 1; i < argv.length; i += 2) {
    check(['--performance', '--bars', '--noah-cash', '--out', '--flows', '--pending-calls', '--baseline', '--instruments', '--cutoff'].includes(argv[i]) && argv[i + 1] && !Object.hasOwn(options, argv[i]), usage);
    options[argv[i]] = argv[i + 1];
  }
  check(options['--performance'] && options['--bars'] && options['--noah-cash'] && options['--out'], usage);
  const resolve = (flag, fallback) => path.resolve(cwd, options[flag] ?? fallback);
  const out = path.resolve(cwd, options['--out']);
  check(out.endsWith('.json') && !fs.existsSync(out), 'Output must be a new .json file');
  const { summary, diagnostics } = buildEtfDailySummary({
    baseline: readJson(resolve('--baseline', BASELINE_PATH)),
    ledger: readJson(resolve('--flows', FLOW_LEDGER_PATH)),
    pendingCalls: readJson(resolve('--pending-calls', PENDING_CALLS_PATH)),
    instruments: readJson(resolve('--instruments', INSTRUMENTS_PATH)),
    performance: readJson(resolve('--performance')),
    bars: readJson(resolve('--bars')),
    noahCash: readJson(resolve('--noah-cash')),
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
