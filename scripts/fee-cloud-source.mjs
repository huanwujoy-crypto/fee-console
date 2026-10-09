#!/usr/bin/env node

// Fixed, GET-only Sharesight source used by the fee-console cloud producer.
// It deliberately exposes no arbitrary URL, method, portfolio, or date range.

import crypto from "node:crypto";
import { boundedJson, BoundedJsonError } from './fee-http-json.mjs';

const API = "https://api.sharesight.com";
const TOKEN_URL = `${API}/oauth2/token`;
const PORTFOLIOS_URL = `${API}/api/v2/portfolios.json`;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{20,16384}$/;
const MAX_BODY = 2 * 1024 * 1024;
const NUMBER_TEXT = Symbol('Sharesight number text');

export const CLOUD_ACCOUNTS = Object.freeze({
  schwab: Object.freeze({ name: "Schwab-HK", portfolioId: 936249 }),
  webull: Object.freeze({ name: "Webull", portfolioId: 1350094 }),
});

const fail = code => { throw new Error(`FEE_CLOUD_${code}`); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = value => typeof value === "number" && Number.isFinite(value);
const round2 = value => Math.round((value + Number.EPSILON) * 100) / 100;
const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
};
const sha256 = value => crypto.createHash("sha256").update(stable(value)).digest("hex");

function rows(payload, key) {
  assertComplete(payload);
  const result = object(payload) ? payload[key] : payload;
  if (!Array.isArray(result) || result.some(row => !object(row))) fail("SCHEMA");
  const ids = result.map(row => id(row.id));
  if (new Set(ids).size !== ids.length) fail('SOURCE_DUPLICATE');
  return result;
}

function assertComplete(payload) {
  if (!object(payload)) return;
  if (payload.links?.next || payload.pagination?.next_page || payload.meta?.pagination?.next_page
      || payload.next_page || payload.has_more === true || payload.complete === false
      || payload.restricted === true || payload.limited === true) fail('SOURCE_INCOMPLETE');
}

export function previousCalendarDate(targetDate) {
  date(targetDate);
  return new Date(Date.parse(`${targetDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

// Independent of cache contents. Holidays remain pending until a reviewed
// calendar contract supplies positive closed-session evidence.
export function expectedTargetDate(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('DATE');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]));
  let target = `${parts.year}-${parts.month}-${parts.day}`;
  if (Number(parts.hour) * 60 + Number(parts.minute) < 16 * 60 + 15) target = previousCalendarDate(target);
  while ([0, 6].includes(new Date(`${target}T00:00:00Z`).getUTCDay())) target = previousCalendarDate(target);
  return target;
}

function id(value) {
  const number = typeof value === "string" && /^[1-9]\d{0,14}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number <= 0) fail("IDENTITY");
  return number;
}

function date(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail("DATE");
  return value;
}

function amount(value) {
  if (!finite(value) || Math.abs(value) > 1e12) fail("AMOUNT");
  return round2(value);
}

function exactTicker(value) {
  if (typeof value !== "string" || !/^[A-Z0-9][A-Z0-9./^-]{0,31}$/.test(value)) fail("HOLDING");
  return value;
}

function holdingIdentity(row) {
  const instrument = row.instrument;
  if (!object(instrument) || typeof instrument.market_code !== 'string'
      || !instrument.market_code || instrument.market_code.length > 32
      || typeof instrument.code !== 'string' || !instrument.code.trim()
      || instrument.code.length > 128 || /[\u0000-\u001f\u007f]/.test(instrument.code)
      || !/^[A-Z]{3}$/.test(instrument.currency_code || '')
      || row.instrument_currency?.code !== instrument.currency_code) fail('HOLDING_IDENTITY');
  return { instrumentId: id(instrument.id), instrumentCode: instrument.code,
    market: instrument.market_code, currency: instrument.currency_code };
}

function sameHoldingInstrument(trade, identity) {
  const instrument = trade.instrument;
  return object(instrument) && id(instrument.id) === identity.instrumentId
    && instrument.code === identity.instrumentCode && instrument.market_code === identity.market
    && instrument.currency_code === identity.currency;
}

// Bounded JSON has already validated the document. A parallel parse preserves
// numeric tokens without relying on Number or runtime-specific reviver context.
// String tokens are kept intact, including escaped quotes and numeric text.
export function parseSourceJson(text) {
  let json, raw;
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  try {
    json = JSON.parse(text);
    raw = JSON.parse(text.replace(tokens, token => token.startsWith('"') ? token : JSON.stringify(token)));
  } catch { throw new BoundedJsonError('JSON'); }
  const retain = (row, rawRow, keys) => {
    if (object(row)) {
      if (!object(rawRow) || (typeof row.id === 'number'
        ? Number(rawRow.id) !== row.id : rawRow.id !== row.id)) throw new BoundedJsonError('JSON');
      const numbers = {};
      for (const key of keys) if (typeof row[key] === 'number') {
        const lexeme = rawRow[key];
        if (typeof lexeme !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(lexeme)
            || Number(lexeme) !== row[key]) throw new BoundedJsonError('JSON');
        numbers[key] = lexeme;
      }
      Object.defineProperty(row, NUMBER_TEXT, { value: numbers });
    }
  };
  const retainRows = (list, rawList, keys) => {
    if (!Array.isArray(list)) return;
    if (!Array.isArray(rawList) || rawList.length !== list.length) throw new BoundedJsonError('JSON');
    for (const [index, row] of list.entries()) retain(row, rawList[index], keys);
  };
  const retainPayload = (payload, rawPayload) => {
    retainRows(object(payload) ? payload.trades : payload, object(rawPayload) ? rawPayload.trades : rawPayload, ['quantity']);
    if (object(payload?.report)) {
      retain(payload.report, rawPayload.report, ['value']);
      retainRows(payload.report.holdings, rawPayload.report.holdings, ['quantity', 'value']);
      retainRows(payload.report.cash_accounts, rawPayload.report.cash_accounts, ['value']);
    }
  };
  retainPayload(json, raw);
  if (object(json?.data)) retainPayload(json.data, raw.data);
  return json;
}
export const parseTradeJson = parseSourceJson;

function exactNumberText(row, key) {
  const text = row[NUMBER_TEXT]?.[key];
  if (!finite(row[key]) || typeof text !== 'string') fail('HOLDING_TERMINAL_PRECISION');
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || text.length > 128) fail('HOLDING_TERMINAL_PRECISION');
  let digits = (match[2] + (match[3] || '')).replace(/^0+/, '');
  if (!digits) return '0';
  let exponent = Number(match[4] || 0) - (match[3] || '').length;
  if (!Number.isSafeInteger(exponent)) fail('HOLDING_TERMINAL_PRECISION');
  const zeros = /0+$/.exec(digits)?.[0].length || 0;
  digits = digits.slice(0, digits.length - zeros); exponent += zeros;
  return `${match[1]}${digits}e${exponent}`;
}

function quantityUnits(trade) {
  const value = trade.quantity;
  if (!finite(value) || value <= 0 || value > 1e12) fail('HOLDING_HISTORY_UNSUPPORTED');
  if (typeof trade[NUMBER_TEXT]?.quantity !== 'string') fail('HOLDING_HISTORY_UNSUPPORTED');
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(trade[NUMBER_TEXT].quantity);
  if (!match) fail('HOLDING_HISTORY_UNSUPPORTED');
  const fraction = match[2] || '', power = 18 + Number(match[3] || 0) - fraction.length;
  if (power < 0 || power > 30) fail('HOLDING_HISTORY_UNSUPPORTED');
  const units = BigInt(match[1] + fraction) * 10n ** BigInt(power);
  if (units <= 0n || units > 10n ** 30n) fail('HOLDING_HISTORY_UNSUPPORTED');
  return units;
}

// The undated holdings endpoint is an identity catalog, including sold positions.
// A complete report including sold positions supplies end-date quantity/value.
// History remains an identity/event audit; a BUY/SELL sum is not the terminal
// quantity authority, especially after corporate actions or stored decimal tails.
export function catalogScopeEvidence(listing, report, historyPayload, targetTrades, expected, targetDate, terminalPayload) {
  const reportRows = rows(report.holdings || [], 'holdings');
  const byId = new Map(listing.map(row => [id(row.id), row]));
  const reportIds = new Set(reportRows.map(row => id(row.id)));
  const extra = listing.filter(row => !reportIds.has(id(row.id)));
  const identities = listing.map(row => ({ holdingId: id(row.id), ...holdingIdentity(row) }))
    .sort((a, b) => a.holdingId - b.holdingId);
  if (!extra.length) return { identities, closed: [] };
  const fromDate = listing.map(row => date(row.inception_date)).sort()[0];
  const terminal = terminalPayload?.report;
  assertComplete(terminalPayload); assertComplete(terminal);
  if (!object(terminal) || id(terminal.portfolio_id) !== expected.portfolioId
      || date(terminal.start_date) !== fromDate || date(terminal.end_date) !== targetDate
      || terminal.include_sales !== true || terminal.portfolio_tz_name !== 'America/New_York'
      || terminal.currency?.code !== 'USD' || terminal.grouping !== 'investment_type') fail('HOLDING_TERMINAL_REQUIRED');
  const terminalRows = rows(terminal.holdings, 'holdings');
  if (terminalRows.length !== listing.length || terminalRows.some(row => !byId.has(id(row.id)))) {
    fail('HOLDING_TERMINAL_COVERAGE');
  }
  const terminalById = new Map(terminalRows.map(row => [id(row.id), row]));
  const terminalProof = terminalRows.map(row => {
    const listed = byId.get(id(row.id));
    if (row.valid_position !== true || id(row.portfolio?.id) !== expected.portfolioId
        || row.portfolio?.name !== expected.name || stable(holdingIdentity(row)) !== stable(holdingIdentity(listed))
        || (row.inception_date != null && row.inception_date !== listed.inception_date)) fail('HOLDING_TERMINAL_IDENTITY');
    const quantity = exactNumberText(row, 'quantity'), value = exactNumberText(row, 'value');
    const active = reportRows.find(active => id(active.id) === id(row.id));
    if (active) {
      if (quantity !== exactNumberText(active, 'quantity') || value !== exactNumberText(active, 'value')) {
        fail('HOLDING_TERMINAL_CURRENT');
      }
    } else if (quantity !== '0' || value !== '0' || row.number_of_unconfirmed_transactions !== 0) {
      fail('HOLDING_TERMINAL_OPEN');
    }
    return { holdingId: id(row.id), ...holdingIdentity(row), quantity, value };
  }).sort((a, b) => a.holdingId - b.holdingId);
  if (exactNumberText(terminal, 'value') !== exactNumberText(report, 'value')) fail('HOLDING_TERMINAL_CURRENT');
  const cashProof = source => rows(source.cash_accounts || [], 'cash_accounts').map(row => {
    if (id(row.portfolio?.id) !== expected.portfolioId || row.portfolio?.name !== expected.name
        || typeof row.currency?.code !== 'string') fail('HOLDING_TERMINAL_IDENTITY');
    return { id: id(row.id), currency: row.currency.code, value: exactNumberText(row, 'value') };
  }).sort((a, b) => a.id - b.id);
  const terminalCash = cashProof(terminal);
  if (stable(terminalCash) !== stable(cashProof(report))) fail('HOLDING_TERMINAL_CURRENT');
  if (!historyPayload) fail('HOLDING_HISTORY_REQUIRED');
  const history = rows(historyPayload, 'trades');
  for (const trade of history) {
    if (id(trade.portfolio_id) !== expected.portfolioId || !byId.has(id(trade.holding_id))
        || date(trade.transaction_date) > targetDate || trade.state !== 'confirmed') fail('HOLDING_HISTORY_IDENTITY');
  }
  if (history.filter(trade => trade.transaction_date === targetDate).length !== targetTrades.length) {
    fail('HOLDING_HISTORY_CURRENT');
  }
  const historyById = new Map(history.map(trade => [id(trade.id), trade]));
  for (const trade of targetTrades) {
    const full = historyById.get(id(trade.id));
    if (!full || ['portfolio_id', 'holding_id', 'transaction_date', 'description_code', 'quantity', 'state', 'company_event_id']
      .some(key => full[key] !== trade[key])
      || !sameHoldingInstrument(full, holdingIdentity(byId.get(id(trade.holding_id))))
      || !sameHoldingInstrument(trade, holdingIdentity(byId.get(id(trade.holding_id))))) {
      fail('HOLDING_HISTORY_CURRENT');
    }
    if (quantityUnits(full) !== quantityUnits(trade)) {
      fail('HOLDING_HISTORY_CURRENT');
    }
  }
  const closed = extra.map(row => {
    const identity = holdingIdentity(row), inception = date(row.inception_date);
    const trades = history.filter(trade => id(trade.holding_id) === id(row.id));
    const latestDate = trades.reduce((last, trade) => trade.transaction_date > last ? trade.transaction_date : last, inception);
    if (!trades.length || !trades.some(trade => trade.transaction_date === latestDate && trade.description_code === 'SELL')
        || trades.reduce((first, trade) => trade.transaction_date < first
      ? trade.transaction_date : first, targetDate) !== inception) fail('HOLDING_HISTORY_INCEPTION');
    let buySellContributionUnits = 0n;
    let openingBalances = 0;
    const proof = trades.map(trade => {
      if (!sameHoldingInstrument(trade, identity) || !['BUY', 'SELL', 'OPENING_BALANCE', 'SPLIT'].includes(trade.description_code)
          || !Object.hasOwn(trade, 'company_event_id')
          || (trade.description_code === 'SPLIT' && trade.company_event_id === null)) fail('HOLDING_HISTORY_UNSUPPORTED');
      const companyEventId = trade.company_event_id === null ? null : id(trade.company_event_id);
      if (trade.description_code === 'OPENING_BALANCE'
          && (trade.transaction_date !== inception || ++openingBalances > 1)) fail('HOLDING_HISTORY_INCEPTION');
      const units = quantityUnits(trade), delta = trade.description_code === 'SELL' ? -units : units;
      if (trade.description_code !== 'SPLIT') buySellContributionUnits += delta;
      return { id: id(trade.id), portfolioId: expected.portfolioId, holdingId: id(row.id), ...identity,
        date: trade.transaction_date, type: trade.description_code, quantityUnits: units.toString(), companyEventId, confirmed: true };
    });
    return { holdingId: id(row.id), inception, terminalQuantity: exactNumberText(terminalById.get(id(row.id)), 'quantity'),
      terminalValue: exactNumberText(terminalById.get(id(row.id)), 'value'),
      buySellContributionUnits: buySellContributionUnits.toString(), trades: proof.sort((a, b) => a.id - b.id) };
  });
  return { identities, terminal: { fromDate, targetDate, includeSales: true, holdings: terminalProof,
    cash: terminalCash, total: exactNumberText(terminal, 'value') }, closed: closed.sort((a, b) => a.holdingId - b.holdingId) };
}

import { dividendCashKey, resolveDividendCashEvidence } from './fee-income-evidence.mjs';
import { notificationIncomeAudits } from './fee-income-date-policy.mjs';

const CONTROLLED_WEBULL_PRINCIPAL_RE = /^Webull ([A-Z0-9][A-Z0-9./^-]{0,31}) (BUY|SELL) securities principal; NOT external funding; order ([A-Z0-9]{16,40}); (?:holding ([1-9]\d{0,14})|Sharesight trade ([1-9]\d{0,14})); (\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2} EDT; source fee USD (\d+\.\d{2})\.$/;

function isControlledWebullPrincipal({ account, row, movement, targetDate, trades }) {
  if (account !== "webull" || !/^(?:DEPOSIT|WITHDRAWAL)$/i.test(String(row.cash_account_transaction_type?.name || ""))) {
    return false;
  }
  const description = typeof row.description === "string" ? row.description : "";
  const match = CONTROLLED_WEBULL_PRINCIPAL_RE.exec(description);
  if (!match || match[6] !== targetDate) return false;
  const [, ticker, side, orderId, holdingIdText, tradeIdText] = match;
  const expectedMovement = side === "BUY" ? -Math.abs(movement) : Math.abs(movement);
  if (Math.abs(expectedMovement - movement) > 0.01) return false;
  const matches = trades.filter(trade => {
    const value = Number(trade.value);
    const comments = typeof trade.comments === "string" ? trade.comments : "";
    return id(trade.portfolio_id) === CLOUD_ACCOUNTS.webull.portfolioId
      && trade.transaction_date === targetDate
      && trade.state === "confirmed"
      && trade.description_code === side
      && exactTicker(trade.instrument?.code) === ticker
      && finite(value) && Math.abs(Math.abs(value) - Math.abs(movement)) <= 0.01
      && comments.startsWith("Webull account 10205226;")
      && comments.includes(`; order ${orderId};`)
      && (holdingIdText ? id(trade.holding_id) === Number(holdingIdText) : id(trade.id) === Number(tradeIdText));
  });
  return matches.length === 1;
}

// Strict support for the reviewed net-proceeds format. Text alone is never proof.
const NET_PROCEEDS_RE = /^Webull ([A-Z0-9][A-Z0-9./^-]{0,31}) SELL net proceeds; NOT external funding\. Order ([A-Z0-9]{16,40}); Sharesight trade ([1-9]\d{0,14}); (\d{4}-\d{2}-\d{2}); gross USD(\d+\.\d{2}) less fee USD(\d+\.\d{2}) = net USD(\d+\.\d{2})\. Fee included, no separate fee debit\.$/;
const NET_TRADE_RE = /^Webull ([A-Z0-9][A-Z0-9./^-]{0,31}) SELL (\d+(?:\.\d+)?) shares on (\d{4}-\d{2}-\d{2}) at USD(\d+(?:\.\d+)?); order ([A-Z0-9]{16,40})\. Commission USD(\d+(?:\.\d{1,2})?); actual fee USD(\d+\.\d{2}) recorded in trade fees\. Gross USD(\d+\.\d{2}); net USD(\d+\.\d{2})\.$/;
const exactCents = value => {
  if (!finite(value) || value < 0 || value > 1e12) return null;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) && Math.abs(value * 100 - cents) < 1e-4 ? cents : null;
};
export function isControlledWebullNetProceeds({ account, row, movement, targetDate, trades }) {
  if (account !== 'webull' || row.cash_account_transaction_type?.name !== 'DEPOSIT'
      || row.payout_id != null || String(row.date_time || '').slice(0, 10) !== targetDate
      || !Number.isSafeInteger(row.id) || row.id <= 0
      || !Number.isSafeInteger(row.cash_account_id) || row.cash_account_id <= 0 || !finite(movement) || movement <= 0 || !Array.isArray(trades)) return false;
  const cash = NET_PROCEEDS_RE.exec(typeof row.description === 'string' ? row.description : '');
  if (!cash || cash[4] !== targetDate) return false;
  const [, ticker, order, tradeId, , grossText, feeText, netText] = cash;
  const byId = trades.filter(t => String(t.id) === tradeId);
  const byOrder = trades.filter(t => typeof t.comments === 'string' && t.comments.includes(`; order ${order}.`));
  if (byId.length !== 1 || byOrder.length !== 1 || byId[0] !== byOrder[0]) return false;
  const trade = byId[0], proof = NET_TRADE_RE.exec(trade.comments);
  if (!proof || trade.portfolio_id !== CLOUD_ACCOUNTS.webull.portfolioId
      || trade.transaction_date !== targetDate || trade.state !== 'confirmed'
      || trade.description_code !== 'SELL' || trade.instrument?.code !== ticker
      || !Number.isSafeInteger(trade.holding_id) || trade.holding_id <= 0
      || !(trade.price_currency_code === 'USD' || (trade.price_currency_code == null && trade.instrument?.currency_code === 'USD'))
      || trade.brokerage_currency_code !== 'USD'
      || !finite(trade.price) || trade.price <= 0 || !finite(trade.quantity) || trade.quantity <= 0
      || !finite(trade.value) || trade.value >= 0
      || (row.trade_id != null && String(row.trade_id) !== tradeId)
      || (row.holding_id != null && row.holding_id !== trade.holding_id)) return false;
  const gross = exactCents(Number(grossText)), fee = exactCents(Number(feeText)), net = exactCents(Number(netText));
  return gross !== null && fee !== null && net !== null && gross > 0 && net > 0
    && gross - fee === net && exactCents(movement) === net && exactCents(Math.abs(trade.value)) === net
    && exactCents(trade.brokerage) === fee && Math.abs(trade.price * trade.quantity * 100 - gross) < 0.5
    && proof[1] === ticker && proof[3] === targetDate && proof[5] === order
    && Number(proof[2]) === trade.quantity && Number(proof[4]) === trade.price
    && exactCents(Number(proof[6])) !== null && Number(proof[6]) <= Number(feeText)
    && exactCents(Number(proof[7])) === fee && exactCents(Number(proof[8])) === gross
    && exactCents(Number(proof[9])) === net;
}

export function selectBenchmark(cache, targetDate) {
  if (!object(cache) || cache.v !== 1 || !object(cache.benchmarks)) fail("BENCHMARK_SCHEMA");
  const selected = {};
  for (const key of ["spy", "qqq"]) {
    const series = cache.benchmarks[key]?.series;
    if (!Array.isArray(series)) fail("BENCHMARK_SCHEMA");
    const matches = series.filter(row => object(row) && row.d === targetDate);
    if (matches.length !== 1 || !finite(matches[0].p) || matches[0].p <= 0
        || (matches[0].div !== undefined && (!finite(matches[0].div) || matches[0].div < 0))) {
      fail("BENCHMARK_PENDING");
    }
    selected[key] = round2(matches[0].p);
    selected[`${key}d`] = round2(matches[0].div || 0);
  }
  return selected;
}

export function latestCommonBenchmarkDate(cache) {
  if (!object(cache) || cache.v !== 1 || !object(cache.benchmarks)) fail("BENCHMARK_SCHEMA");
  const dates = ["spy", "qqq"].map(key => new Set((cache.benchmarks[key]?.series || [])
    .filter(row => object(row) && DATE_RE.test(String(row.d)) && finite(row.p) && row.p > 0)
    .map(row => row.d)));
  const common = [...dates[0]].filter(day => dates[1].has(day)).sort();
  if (!common.length) fail("BENCHMARK_PENDING");
  return common.at(-1);
}

function assertCashChain(transactions, previousCash, currentCash) {
  const cents = value => Math.round(amount(value) * 100);
  const groups = new Map();
  for (const row of transactions) {
    const timestamp = Date.parse(row.date_time);
    if (!groups.has(timestamp)) groups.set(timestamp, []);
    groups.get(timestamp).push(row);
  }
  let balance = cents(previousCash);
  for (const timestamp of [...groups.keys()].sort((a,b) => a-b)) {
    const rows = groups.get(timestamp), edges = new Map();
    for (const row of rows) {
      const after = cents(row.balance), before = after - cents(row.amount);
      if (!edges.has(before)) edges.set(before, new Map());
      const outgoing = edges.get(before);
      outgoing.set(after, (outgoing.get(after) || 0) + 1);
    }
    let remaining = rows.length;
    while (remaining) {
      const outgoing = edges.get(balance);
      if (!outgoing?.size) fail('CASH_CHAIN');
      // Zero movements and identical edges are indistinguishable for cash
      // ordering. Distinct possible next balances are not guessed from IDs.
      if (outgoing.has(balance)) {
        remaining -= outgoing.get(balance); outgoing.delete(balance);
        if (!remaining) break;
      }
      if (outgoing.size !== 1) fail(outgoing.size ? 'CASH_CHAIN_AMBIGUOUS' : 'CASH_CHAIN');
      const after = outgoing.keys().next().value, count = outgoing.get(after);
      if (count === 1) outgoing.delete(after); else outgoing.set(after, count - 1);
      balance = after; remaining--;
    }
  }
  if (Math.abs(balance - cents(currentCash)) > 1) fail('CASH_BALANCE_STALE');
}

function normalizePortfolio(account, performancePayload, holdingsPayload, cashPayload, cashTransactions, tradesPayload, targetDate, incomePayouts = {}, incomeDateEvidence = {}, previousPerformance, holdingHistory, terminalPerformance) {
  const expected = CLOUD_ACCOUNTS[account];
  const report = performancePayload?.report;
  assertComplete(performancePayload); assertComplete(report);
  if (!object(report) || id(report.portfolio_id) !== expected.portfolioId
      || date(report.start_date) !== targetDate || date(report.end_date) !== targetDate
      || report.currency?.code !== "USD" || report.include_sales !== false
      || report.portfolio_tz_name !== 'America/New_York') fail("PERFORMANCE_IDENTITY");
  const listing = rows(holdingsPayload, "holdings");
  const listedIds = new Set(listing.map(row => {
    if (id(row.portfolio?.id) !== expected.portfolioId || row.portfolio?.name !== expected.name
        || row.valid_position !== true) fail("HOLDING_IDENTITY");
    return id(row.id);
  }));
  const holdings = rows(report.holdings || [], "holdings").map(row => {
    const holdingId = id(row.id), ticker = exactTicker(row.instrument?.code);
    if (!listedIds.has(holdingId) || row.valid_position !== true
        || id(row.portfolio?.id) !== expected.portfolioId || row.portfolio?.name !== expected.name
        || row.instrument_currency?.code !== "USD") fail("HOLDING_IDENTITY");
    const listed = listing.find(item => id(item.id) === holdingId);
    if (stable(holdingIdentity(row)) !== stable(holdingIdentity(listed))) fail('HOLDING_IDENTITY');
    return { holdingId, ticker, valueUsd: amount(row.value) };
  }).sort((a, b) => a.holdingId - b.holdingId);
  const catalogEvidence = catalogScopeEvidence(listing, report,
    holdingHistory, rows(tradesPayload, 'trades'), expected, targetDate, terminalPerformance);
  const cashRows = rows(report.cash_accounts || [], "cash_accounts").map(row => {
    if (id(row.portfolio?.id) !== expected.portfolioId || row.portfolio?.name !== expected.name
        || typeof row.currency?.code !== "string") fail("CASH_CURRENCY");
    return { id: id(row.id), currency: row.currency.code, valueUsd: amount(row.value) };
  }).sort((a, b) => a.id - b.id);
  const listedCash = rows(cashPayload, "cash_accounts");
  const listedCashById = new Map(listedCash.map(row => [id(row.id), row]));
  for (const row of cashRows) {
    const listed = listedCashById.get(row.id);
    if (!listed || id(listed.portfolio_id) !== expected.portfolioId || listed.portfolio_currency !== "USD"
        || listed.currency !== row.currency) {
      fail("CASH_IDENTITY");
    }
    if (row.currency === 'USD' && (!finite(listed.balance) || Math.abs(row.valueUsd - listed.balance) > 0.01)) fail('CASH_REPORT_BALANCE');
  }
  if (listedCash.length !== cashRows.length || Object.keys(cashTransactions).length !== listedCash.length
      || listedCash.some(row => !Object.hasOwn(cashTransactions, String(id(row.id))))) fail('CASH_IDENTITY');
  for (const payload of Object.values(cashTransactions)) rows(payload, 'cash_account_transactions');
  let incomeEvidence;
  try {
    if(account==='webull')for(const audit of notificationIncomeAudits(incomeDateEvidence,targetDate)) {
      const cashId=audit.proof.scope.cashAccountId,listed=listedCash.filter(row=>id(row.id)===cashId);
      const reported=rows(report.cash_accounts||[],'cash_accounts').filter(row=>id(row.id)===cashId);
      if(listed.length!==1||reported.length!==1||id(listed[0].portfolio_id)!==expected.portfolioId
        ||listed[0].currency!=='USD'||listed[0].portfolio_currency!=='USD'||reported[0].currency?.code!=='USD')
        throw new Error('notification cash account identity');
    }
    incomeEvidence = resolveDividendCashEvidence({account,portfolioId:expected.portfolioId,targetDate,holdings,
    cashRows:Object.values(cashTransactions).flatMap(p => rows(p,'cash_account_transactions')),
    payouts:incomePayouts,dateEvidence:incomeDateEvidence}); } catch { fail('INCOME_EVIDENCE'); }
  const trades = rows(tradesPayload, "trades");
  if (trades.some(row => id(row.portfolio_id) !== expected.portfolioId || row.transaction_date !== targetDate
      || row.state !== 'confirmed')) fail('TRADE_IDENTITY');
  const tradeIds = new Set(trades.map(row => id(row.id)));
  const flows = [];
  const seenTransactions = new Set();
  let movementTotal = 0;
  for (const [cashIdText, payload] of Object.entries(cashTransactions)) {
    const cashId = id(cashIdText), cashAccount = listedCashById.get(cashId);
    if (!cashAccount || cashAccount.currency !== "USD") {
      if (rows(payload, "cash_account_transactions").length) fail("NON_USD_MOVEMENT");
      continue;
    }
    const transactionRows = rows(payload, "cash_account_transactions");
    if (transactionRows.some(row => !Number.isFinite(Date.parse(row.date_time)) || !finite(row.balance))) fail('CASH_TRANSACTION_IDENTITY');
    for (const row of transactionRows) {
      if (seenTransactions.has(id(row.id))) fail('SOURCE_DUPLICATE');
      seenTransactions.add(id(row.id));
      const movementDate = date(String(row.date_time || "").slice(0, 10));
      if (movementDate !== targetDate || id(row.cash_account_id) !== cashId) fail("CASH_TRANSACTION_IDENTITY");
      const movement = amount(row.amount);
      movementTotal += movement;
      const description = typeof row.description === "string" ? row.description.slice(0, 300) : "";
      const foreignIdentifier = typeof row.foreign_identifier === "string" ? row.foreign_identifier : "";
      const legacyControlledWebullPrincipal = account === "webull"
        && /^(?:DEPOSIT|WITHDRAWAL)$/i.test(String(row.cash_account_transaction_type?.name || ""))
        && /^webullhk-10205226-email-[a-f0-9]{32}-cash$/.test(foreignIdentifier)
        && /^Webull [A-Z0-9./^-]+ (?:BUY|SELL) securities principal; NOT external funding; webullhk-10205226-email-[a-f0-9]{32}-cash$/.test(description);
      const matchedControlledWebullPrincipal = isControlledWebullPrincipal({
        account, row: { ...row, description }, movement, targetDate, trades,
      });
      flows.push({
        date: targetDate, acct: account, amount: movement,
        desc: description,
        type: typeof row.cash_account_transaction_type?.name === "string" ? row.cash_account_transaction_type.name : "",
        tradeId: row.trade_id == null ? null : id(row.trade_id),
        holdingId: row.holding_id == null ? null : id(row.holding_id),
        foreignIdentifier,
        ...(legacyControlledWebullPrincipal || matchedControlledWebullPrincipal || isControlledWebullNetProceeds({ account, row: { ...row, description }, movement, targetDate, trades }) ? { evidence: "internal_trade" } : {}),
        ...(incomeEvidence.get(row.id) || {}),
      });
    }
  }
  for (const flow of flows) if (flow.tradeId !== null && !tradeIds.has(flow.tradeId)) fail("TRADE_NOT_LISTED");
  const total = amount(report.value);
  const cash = round2(cashRows.reduce((sum, row) => sum + row.valueUsd, 0));
  const other = round2(holdings.filter(row => row.ticker === "SGOV").reduce((sum, row) => sum + row.valueUsd, 0));
  const equity = holdings.filter(row => row.ticker !== "SGOV");
  const stock = round2(equity.reduce((sum, row) => sum + row.valueUsd, 0));
  if (Math.abs(total - cash - other - stock) > 1) fail("TOTAL_RECONCILIATION");
  let previousCash = null;
  {
    assertComplete(previousPerformance); assertComplete(previousPerformance?.report);
    const prior = previousPerformance?.report;
    if (!object(prior) || id(prior.portfolio_id) !== expected.portfolioId
        || prior.end_date !== previousCalendarDate(targetDate) || prior.currency?.code !== 'USD') fail('CASH_PREVIOUS_EVIDENCE');
    const priorRows = rows(prior.cash_accounts, 'cash_accounts');
    if (priorRows.length !== cashRows.length) fail('CASH_PREVIOUS_EVIDENCE');
    previousCash = 0;
    for (const row of priorRows) {
      const current = cashRows.find(c => c.id === id(row.id));
      if (!current || current.currency !== row.currency?.code || id(row.portfolio?.id) !== expected.portfolioId
          || row.portfolio?.name !== expected.name) fail('CASH_PREVIOUS_EVIDENCE');
      previousCash += amount(row.value);
      if (current.currency === 'USD') {
        const moved = rows(cashTransactions[String(current.id)], 'cash_account_transactions').reduce((sum, t) => sum + amount(t.amount), 0);
        if (Math.abs(amount(row.value) + moved - current.valueUsd) > 0.01) fail('CASH_RECONCILIATION');
        assertCashChain(rows(cashTransactions[String(current.id)], 'cash_account_transactions'), row.value, current.valueUsd);
      }
    }
    previousCash = round2(previousCash);
    if (Math.abs(previousCash + movementTotal - cash) > 0.01) fail('CASH_RECONCILIATION');
  }
  return {
    account, portfolioId: expected.portfolioId, sourceDate: targetDate, total, cash, other, stock,
    holdings: equity,
    flows: flows.sort((a, b) => stable(a).localeCompare(stable(b))),
    cashCheck: flows.length ? { current: round2(cash), previous: previousCash } : null,
    catalogEvidence,
  };
}

export function monthlyGiftEvidence(trade) {
  const marker = /^Webull HK monthly promotional gifted ([A-Z0-9][A-Z0-9./^-]{0,31}) shares, not a cash purchase: (\d+(?:\.\d+)?) share acquired for USD 0, brokerage USD 0, no cash movement\. Award date (\d{4}-\d{2}-\d{2}) per account holder confirmation of first-day-of-month gifts\./.exec(String(trade.comments || ''));
  return !!marker && trade.description_code === 'BUY' && trade.state === 'confirmed'
    && trade.price === 0 && trade.value === 0 && trade.brokerage === 0
    && marker[1] === trade.instrument?.code && marker[3] === String(trade.transaction_date).slice(0,10)
    && marker[3].endsWith('-01') && Number(marker[2]) === trade.quantity;
}

export function managementSourceInput(raw, targetDate) {
  if (!raw.webull?.managementTrades) return undefined;
  if (raw.webull.managementTrades.links?.next
      || raw.webull.managementTrades.pagination?.next_page
      || raw.webull.managementTrades.meta?.pagination?.next_page) fail('MANAGEMENT_HISTORY_INCOMPLETE');
  const pid = CLOUD_ACCOUNTS.webull.portfolioId;
  const holdings = rows(raw.webull.performance.report.holdings || [], 'holdings').map(h => ({
    account:'webull', portfolioId:pid, holdingId:id(h.id), ticker:exactTicker(h.instrument?.code),
    sourceDate:targetDate, quantity:h.quantity, valueUsd:amount(h.value),
  }));
  const trades = rows(raw.webull.managementTrades, 'trades').map(t => ({
    id:id(t.id), portfolioId:id(t.portfolio_id), holdingId:id(t.holding_id),
    date:String(t.transaction_date || '').slice(0,10), type:t.description_code,
    quantity:t.quantity, confirmed:t.state === 'confirmed',
    zeroPrice:t.price === 0,
    monthlyGiftEvidence:monthlyGiftEvidence(t),
    giftEvidence:typeof t.comments === 'string' && /(?:promotional gifted|gifted|gift)\b/i.test(t.comments),
  }));
  return {schemaVersion:1,date:targetDate,holdings,trades,historyComplete:true,proposals:[]};
}

export function normalizeRead(raw, targetDate, benchmark) {
  date(targetDate);
  const portfolios = [];
  for (const account of Object.keys(CLOUD_ACCOUNTS)) {
    const source = raw[account];
    if (!object(source)) fail("SOURCE_MISSING");
    portfolios.push(normalizePortfolio(account, source.performance, source.holdings, source.cashAccounts,
      source.cashTransactions, source.trades, targetDate, source.incomePayouts, source.incomeDateEvidence,
      source.previousPerformance, source.holdingHistory || (account === 'webull' ? source.managementTrades : undefined),
      source.terminalPerformance));
  }
  const accounts = Object.fromEntries(portfolios.map(p => [p.account, p.total]));
  const splits = {
    cash: round2(portfolios.reduce((sum, p) => sum + p.cash, 0)),
    stock: round2(portfolios.reduce((sum, p) => sum + p.stock, 0)),
    other: round2(portfolios.reduce((sum, p) => sum + p.other, 0)),
  };
  const sourceDates = Object.fromEntries(portfolios.map(p => [p.account, p.sourceDate]));
  const styleInput = { schemaVersion: 1, date: targetDate, portfolios: portfolios.map(p => ({
    account: p.account, portfolioId: p.portfolioId, sourceDate: p.sourceDate,
    stockTotalUsd: p.stock, holdings: p.holdings,
  })), proposals: [] };
  const flows = portfolios.flatMap(p => p.flows);
  const acctCash = {}, prevAcctCash = {};
  for (const p of portfolios) if (p.cashCheck) {
    acctCash[p.account] = p.cashCheck.current;
    prevAcctCash[p.account] = p.cashCheck.previous;
  }
  const managementInput = managementSourceInput(raw, targetDate);
  const normalized = { targetDate, accounts, splits, sourceDates, styleInput, flows, acctCash, prevAcctCash,
    ...(managementInput ? {managementInput} : {}),
    benchmark: { ...benchmark, sourceDate: targetDate, state: "session" } };
  return { ...normalized, sourceFingerprint: sha256({ ...normalized,
    catalogEvidence: portfolios.map(p => ({ account: p.account, ...p.catalogEvidence })) }) };
}

class FixedHttp {
  constructor(fetchImpl, { timeoutMs = 20_000 } = {}) {
    if (typeof fetchImpl !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000) {
      fail("CONFIG");
    }
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }
  async json(url, init) {
    const allowed = url === TOKEN_URL || url === PORTFOLIOS_URL
      || /^https:\/\/api\.sharesight\.com\/api\/v2\/payouts\/[1-9]\d{0,14}\.json$/.test(url)
      || /^https:\/\/api\.sharesight\.com\/api\/v3\/portfolios\/(?:936249|1350094)\/(?:performance|holdings|trades\.json)(?:\?.*)?$/.test(url)
      || /^https:\/\/api\.sharesight\.com\/api\/v2\/portfolios\/(?:936249|1350094)\/cash_accounts\.json$/.test(url)
      || /^https:\/\/api\.sharesight\.com\/api\/v2\/cash_accounts\/[1-9]\d{0,14}\/cash_account_transactions\.json\?.*$/.test(url);
    if (!allowed) fail("ROUTE_BLOCKED");
    try {
      const path = new URL(url).pathname;
      const isPrecisionSource = path.endsWith('/trades.json') || path.endsWith('/performance');
      const response = await boundedJson(this.fetchImpl, url, init, {
        timeoutMs: this.timeoutMs, maxBytes: MAX_BODY, requireJsonType: true, includeBytes: isPrecisionSource,
      });
      return isPrecisionSource ? parseSourceJson(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)) : response;
    } catch (error) {
      const code = error instanceof BoundedJsonError ? error.code : 'NETWORK';
      if (['NETWORK', 'TIMEOUT', 'ABORTED'].includes(code)) fail(url === TOKEN_URL ? 'AUTH_UNAVAILABLE' : 'SOURCE_UNAVAILABLE');
      if (code === 'HTTP') fail(url === TOKEN_URL ? 'AUTH_REJECTED' : 'HTTP_REJECTED');
      fail(`RESPONSE_${code}`);
    }
  }
}

export class SharesightCloudReader {
  constructor({ clientId, clientSecret, fetchImpl = globalThis.fetch, timeoutMs, incomeDateEvidence = {} } = {}) {
    this.incomeDateEvidence=incomeDateEvidence;
    if (![clientId, clientSecret].every(value => typeof value === "string" && value.length >= 1 && value.length <= 8192
        && !/[\r\n\0]/.test(value))) fail("CREDENTIALS");
    this.clientId = clientId; this.clientSecret = clientSecret;
    this.http = new FixedHttp(fetchImpl, { timeoutMs });
  }
  async token() {
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: this.clientId,
      client_secret: this.clientSecret }).toString();
    const payload = await this.http.json(TOKEN_URL, { method: "POST", headers: {
      Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded",
    }, body });
    if (!object(payload) || typeof payload.access_token !== "string" || !TOKEN_RE.test(payload.access_token)
        || String(payload.token_type || "").toLowerCase() !== "bearer") fail("AUTH_RESPONSE");
    return payload.access_token;
  }
  async get(url, token) {
    return this.http.json(url, { method: "GET", headers: { Accept: "application/json",
      Authorization: `Bearer ${token}`, "User-Agent": "fee-console-cloud-reader/1.0" } });
  }
  async readOnce(targetDate) {
    date(targetDate);
    const token = await this.token();
    const portfolioPayload = await this.get(PORTFOLIOS_URL, token);
    const listed = rows(portfolioPayload, "portfolios");
    const raw = {};
    for (const [account, expected] of Object.entries(CLOUD_ACCOUNTS)) {
      const matches = listed.filter(row => id(row.id) === expected.portfolioId && row.name === expected.name);
      if (matches.length !== 1 || matches[0].currency_code !== "USD") fail("PORTFOLIO_IDENTITY");
      const base3 = `${API}/api/v3/portfolios/${expected.portfolioId}`;
      const performanceUrl = `${base3}/performance?consolidated=false&end_date=${targetDate}&grouping=investment_type&include_limited=false&include_sales=false&report_combined=false&start_date=${targetDate}`;
      const tradesUrl = `${base3}/trades.json?consolidated=false&end_date=${targetDate}&start_date=${targetDate}`;
      const [performancePayload, holdingsPayload, cashAccountsPayload, tradesPayload] = await Promise.all([
        this.get(performanceUrl, token), this.get(`${base3}/holdings?consolidated=false`, token),
        this.get(`${API}/api/v2/portfolios/${expected.portfolioId}/cash_accounts.json`, token),
        this.get(tradesUrl, token),
      ]);
      const cashAccounts = rows(cashAccountsPayload, "cash_accounts");
      const cashTransactions = {};
      for (const cash of cashAccounts) {
        const cashId = id(cash.id);
        cashTransactions[cashId] = await this.get(`${API}/api/v2/cash_accounts/${cashId}/cash_account_transactions.json?from=${targetDate}&to=${targetDate}`, token);
      }
      const priorDate = previousCalendarDate(targetDate);
      const previousPerformance = await this.get(
        `${base3}/performance?consolidated=false&end_date=${priorDate}&grouping=investment_type&include_limited=false&include_sales=false&report_combined=false&start_date=${priorDate}`, token);
      const incomePayouts = {};
      if (account === 'webull') {
        const keys=Object.values(cashTransactions).flatMap(p=>rows(p,'cash_account_transactions'))
          .map(row=>dividendCashKey(row.description)).filter(Boolean);
        let audits;
        try { audits=notificationIncomeAudits(this.incomeDateEvidence,targetDate); } catch { fail('INCOME_EVIDENCE'); }
        for (const payoutId of new Set([...keys.map(k=>k.payoutId),...audits.map(a=>a.proof.scope.payoutId)]))
          incomePayouts[payoutId]=await this.get(`${API}/api/v2/payouts/${payoutId}.json`,token);
      }
      // Entire Webull history, not just today's trades, is required to bound
      // owner-authorized gift lots and retain a chargeable paid-lot balance.
      const datedHoldingIds = new Set(rows(performancePayload?.report?.holdings || [], 'holdings').map(row => id(row.id)));
      const needsHistory = rows(holdingsPayload, 'holdings').some(row => !datedHoldingIds.has(id(row.id)));
      const holdingHistory = account === 'webull' || needsHistory
        ? await this.get(`${base3}/trades.json?consolidated=false&end_date=${targetDate}`, token) : undefined;
      const managementTrades = account === 'webull' ? holdingHistory : undefined;
      const fromDate = needsHistory ? rows(holdingsPayload, 'holdings').map(row => date(row.inception_date)).sort()[0] : undefined;
      const terminalPerformance = needsHistory ? await this.get(
        `${base3}/performance?consolidated=false&end_date=${targetDate}&grouping=investment_type&include_limited=false&include_sales=true&report_combined=false&start_date=${fromDate}`, token) : undefined;
      raw[account] = { incomePayouts, incomeDateEvidence:account==='webull'?this.incomeDateEvidence:{}, ...(managementTrades ? {managementTrades} : {}), ...(previousPerformance ? {previousPerformance} : {}), performance: performancePayload, holdings: holdingsPayload,
        cashAccounts: cashAccountsPayload, cashTransactions, trades: tradesPayload,
        ...(holdingHistory ? { holdingHistory } : {}), ...(terminalPerformance ? { terminalPerformance } : {}) };
    }
    return raw;
  }
  async readStable(targetDate, benchmark) {
    const first = normalizeRead(await this.readOnce(targetDate), targetDate, benchmark);
    const second = normalizeRead(await this.readOnce(targetDate), targetDate, benchmark);
    if (stable(first) !== stable(second)) fail("SOURCE_UNSTABLE");
    return first;
  }
}
