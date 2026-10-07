#!/usr/bin/env node

// Fixed, GET-only Sharesight source used by the fee-console cloud producer.
// It deliberately exposes no arbitrary URL, method, portfolio, or date range.

import crypto from "node:crypto";

const API = "https://api.sharesight.com";
const TOKEN_URL = `${API}/oauth2/token`;
const PORTFOLIOS_URL = `${API}/api/v2/portfolios.json`;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{20,16384}$/;
const MAX_BODY = 2 * 1024 * 1024;

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
  const result = object(payload) ? payload[key] : payload;
  if (!Array.isArray(result) || result.some(row => !object(row))) fail("SCHEMA");
  return result;
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

function normalizePortfolio(account, performancePayload, holdingsPayload, cashPayload, cashTransactions, tradesPayload, targetDate, incomePayouts = {}, incomeDateEvidence = {}) {
  const expected = CLOUD_ACCOUNTS[account];
  const report = performancePayload?.report;
  if (!object(report) || id(report.portfolio_id) !== expected.portfolioId
      || date(report.end_date) !== targetDate || report.currency?.code !== "USD") fail("PERFORMANCE_IDENTITY");
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
    return { holdingId, ticker, valueUsd: amount(row.value) };
  }).sort((a, b) => a.holdingId - b.holdingId);
  const cashRows = rows(report.cash_accounts || [], "cash_accounts").map(row => {
    if (id(row.portfolio?.id) !== expected.portfolioId || row.portfolio?.name !== expected.name
        || typeof row.currency?.code !== "string") fail("CASH_CURRENCY");
    return { id: id(row.id), valueUsd: amount(row.value) };
  }).sort((a, b) => a.id - b.id);
  const listedCash = rows(cashPayload, "cash_accounts");
  const listedCashById = new Map(listedCash.map(row => [id(row.id), row]));
  for (const row of cashRows) {
    const listed = listedCashById.get(row.id);
    if (!listed || id(listed.portfolio_id) !== expected.portfolioId || listed.portfolio_currency !== "USD") {
      fail("CASH_IDENTITY");
    }
  }
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
  const tradeIds = new Set(trades.map(row => id(row.id)));
  const flows = [];
  let movementTotal = 0;
  for (const [cashIdText, payload] of Object.entries(cashTransactions)) {
    const cashId = id(cashIdText), cashAccount = listedCashById.get(cashId);
    if (!cashAccount || cashAccount.currency !== "USD") {
      if (rows(payload, "cash_account_transactions").length) fail("NON_USD_MOVEMENT");
      continue;
    }
    const transactionRows = rows(payload, "cash_account_transactions");
    if (transactionRows.length && !transactionRows.some(row => finite(row.balance)
        && Math.abs(row.balance - cashAccount.balance) <= 0.01)) fail("CASH_BALANCE_STALE");
    for (const row of transactionRows) {
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
  return {
    account, portfolioId: expected.portfolioId, sourceDate: targetDate, total, cash, other, stock,
    holdings: equity,
    flows: flows.sort((a, b) => stable(a).localeCompare(stable(b))),
    cashCheck: flows.length ? { current: round2(cash), previous: round2(cash - movementTotal) } : null,
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
      source.cashTransactions, source.trades, targetDate, source.incomePayouts, source.incomeDateEvidence));
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
  return { ...normalized, sourceFingerprint: sha256(normalized) };
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
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try { response = await this.fetchImpl(url, { ...init, redirect: "error", signal: controller.signal }); }
    catch { fail(url === TOKEN_URL ? "AUTH_UNAVAILABLE" : "SOURCE_UNAVAILABLE"); }
    finally { clearTimeout(timer); }
    if (!response || response.status !== 200 || response.url !== url) fail(url === TOKEN_URL ? "AUTH_REJECTED" : "HTTP_REJECTED");
    const type = String(response.headers?.get?.("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (type !== "application/json") fail("RESPONSE_TYPE");
    const text = await response.text();
    if (!text || Buffer.byteLength(text) > MAX_BODY) fail("RESPONSE_SIZE");
    try { return JSON.parse(text); } catch { fail("RESPONSE_JSON"); }
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
      const managementTrades = account === 'webull'
        ? await this.get(`${base3}/trades.json?consolidated=false&end_date=${targetDate}`, token) : undefined;
      raw[account] = { incomePayouts, incomeDateEvidence:account==='webull'?this.incomeDateEvidence:{}, ...(managementTrades ? {managementTrades} : {}), performance: performancePayload, holdings: holdingsPayload,
        cashAccounts: cashAccountsPayload, cashTransactions, trades: tradesPayload };
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
