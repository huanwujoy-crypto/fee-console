#!/usr/bin/env node

import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const CACHE_PATH = process.env.BENCHMARK_CACHE_PATH || 'benchmark-close.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 120;
const TOTAL_RETURN_TOLERANCE = 5e-4;
const CLOSE_CROSSCHECK_TOLERANCE = 0.005;
const CACHE_SOURCE = 'Nasdaq historical daily closes and cash dividends for current updates; retained legacy cache history; State Street SPY dividend calendar';

export const DEFINITIONS = Object.freeze({
  spy: Object.freeze({
    symbol: 'SPY',
    currency: 'USD',
    // Yahoo has used both the legacy 'PCX' and the current 'NYSEArca' for NYSE
    // Arca listings; either is accepted. Anything else means the symbol did not
    // resolve to the listing we intend to track, so the fetch must fail loudly.
    exchangeNames: Object.freeze(['PCX', 'NYSEArca', 'ARCA']),
    exchangeTimezoneName: 'America/New_York',
    exchange: 'NYSEArca',
    timezone: 'America/New_York',
    closeMinutes: 16 * 60,
    nasdaqExchangeNames: Object.freeze(['PSE']),
    nasdaqCompanyNames: Object.freeze(['State Street SPDR S&P 500 ETF Trust']),
    dividendGuard: Object.freeze({
      validFrom: '2026-01-01',
      validThrough: '2026-12-31',
      exDates: Object.freeze(['2026-03-20', '2026-06-19', '2026-09-18', '2026-12-18']),
      source: 'State Street SPY distribution calendar',
    }),
  }),
  qqq: Object.freeze({
    symbol: 'QQQ',
    currency: 'USD',
    exchangeNames: Object.freeze(['NMS', 'NasdaqGS', 'NGM']),
    exchangeTimezoneName: 'America/New_York',
    exchange: 'NasdaqGS',
    timezone: 'America/New_York',
    closeMinutes: 16 * 60,
    nasdaqExchangeNames: Object.freeze(['NASDAQ-GM']),
    nasdaqCompanyNames: Object.freeze(['Invesco QQQ Trust, Series 1']),
  }),
});

// Why raw closes plus dividends rather than Yahoo's adjusted close:
// `adjclose` is restated backwards on every ex-date, but data.json stores each
// day's benchmark once and never rewrites history. Pairing an unadjusted close
// with the dividend that went ex that day keeps every stored value permanent
// while still producing a total-return chain: r = (P + D) / P_prev - 1.

function localParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minutes: Number(values.hour) * 60 + Number(values.minute),
  };
}

function isCompletedSession(date, definition, now) {
  const point = localParts(date, definition.timezone);
  const current = localParts(now, definition.timezone);
  if (point.date < current.date) return true;
  if (point.date > current.date) return false;
  return current.minutes >= definition.closeMinutes + 15;
}

function isCompletedSessionDate(date, definition, now) {
  const current = localParts(now, definition.timezone);
  if (date < current.date) return true;
  if (date > current.date) return false;
  return current.minutes >= definition.closeMinutes + 15;
}

// Match the fee producer's independent New York weekday boundary. A missing
// holiday close remains pending; an older cache is never closed-session proof.
export function expectedBenchmarkTargetDate(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Invalid benchmark clock');
  const current = localParts(now, DEFINITIONS.spy.timezone);
  let day = new Date(`${current.date}T00:00:00Z`);
  if (current.minutes < DEFINITIONS.spy.closeMinutes + 15) day = new Date(day.getTime() - DAY_MS);
  while ([0, 6].includes(day.getUTCDay())) day = new Date(day.getTime() - DAY_MS);
  return day.toISOString().slice(0, 10);
}

function roundPrice(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function yahooResult(payload, definition) {
  const result = payload?.chart?.result?.[0];
  if (!result || payload?.chart?.error) throw new Error(`No chart result for ${definition.symbol}`);

  const meta = result.meta || {};
  if (meta.symbol !== definition.symbol) throw new Error(`Unexpected symbol: ${meta.symbol}`);
  if (meta.currency !== definition.currency) throw new Error(`Unexpected currency for ${definition.symbol}: ${meta.currency}`);
  if (meta.instrumentType !== 'ETF') throw new Error(`Unexpected instrument type for ${definition.symbol}: ${meta.instrumentType}`);
  if (!definition.exchangeNames.includes(meta.exchangeName)) {
    throw new Error(`Unexpected exchange for ${definition.symbol}: ${meta.exchangeName}`);
  }
  if (meta.exchangeTimezoneName !== definition.exchangeTimezoneName) {
    throw new Error(`Unexpected timezone for ${definition.symbol}: ${meta.exchangeTimezoneName}`);
  }
  return result;
}

function yahooDividends(result, definition) {
  const divByDate = new Map();
  for (const event of Object.values(result.events?.dividends || {})) {
    const amount = Number(event?.amount);
    const stamp = Number(event?.date);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(stamp)) {
      throw new Error(`Malformed dividend event for ${definition.symbol}`);
    }
    const exDate = localParts(new Date(stamp * 1000), definition.timezone).date;
    divByDate.set(exDate, roundPrice((divByDate.get(exDate) || 0) + amount));
  }
  return divByDate;
}

export function extractPrices(payload, definition, now = new Date()) {
  const result = yahooResult(payload, definition);

  const byDate = new Map();
  const rawByDate = new Map();
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose;
  if (!Array.isArray(adjusted) || adjusted.length !== timestamps.length) {
    throw new Error(`Missing adjusted-close verification series for ${definition.symbol}`);
  }
  for (let i = 0; i < timestamps.length; i += 1) {
    const price = closes[i];
    if (!Number.isFinite(price) || price <= 0) continue;
    const adj = adjusted[i];
    if (!Number.isFinite(adj) || adj <= 0) {
      throw new Error(`Invalid adjusted-close verification value for ${definition.symbol}`);
    }
    const date = new Date(timestamps[i] * 1000);
    if (!isCompletedSession(date, definition, now)) continue;
    const d = localParts(date, definition.timezone).date;
    byDate.set(d, roundPrice(price));
    rawByDate.set(d, { p: Number(price), adj: Number(adj) });
  }

  // This primary path still never trusts meta.regularMarketPrice by itself.
  // appendCrossCheckedClose may add exactly one newer close only after an
  // independent Nasdaq date/price match and separate dividend evidence.

  // Cash dividends, keyed by ex-date in the listing's own timezone. Yahoo only
  // returns these when the request carries `events=div`.
  const divByDate = yahooDividends(result, definition);

  const observedDates = [...byDate.keys()].sort();
  const firstObserved = observedDates[0], lastObserved = observedDates.at(-1);
  for (const d of divByDate.keys()) {
    // Yahoo can include one event just outside a range boundary. It cannot be
    // paired with a close from this response, so leave it out of this window;
    // only an event inside the observed close span is required to pair.
    if (d < firstObserved || d > lastObserved) continue;
    if (!byDate.has(d)) throw new Error(`Dividend on ${d} has no completed close for ${definition.symbol}`);
  }

  // `adjclose` is verification-only and is never stored.  Comparing adjacent
  // factors catches a Yahoo response that silently omitted a dividend event.
  const verified = [...rawByDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (let i = 1; i < verified.length; i += 1) {
    const [d, cur] = verified[i], [, prev] = verified[i - 1];
    const rawFactor = (cur.p + (divByDate.get(d) || 0)) / prev.p;
    const adjustedFactor = cur.adj / prev.adj;
    if (Math.abs(rawFactor - adjustedFactor) > TOTAL_RETURN_TOLERANCE) {
      throw new Error(`Dividend/adjusted-close mismatch for ${definition.symbol} on ${d}`);
    }
  }

  const series = [...byDate.entries()]
    .map(([d, p]) => {
      const div = divByDate.get(d) || 0;
      return div > 0 ? { d, p, div } : { d, p };
    })
    .sort((a, b) => a.d.localeCompare(b.d));
  if (!series.length) throw new Error(`No completed closes for ${definition.symbol}`);
  return series;
}

export function extractYahooMetaClose(payload, definition, now = new Date()) {
  const result = yahooResult(payload, definition);
  const price = Number(result.meta?.regularMarketPrice);
  const stamp = Number(result.meta?.regularMarketTime);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(stamp)) {
    throw new Error(`Missing Yahoo completed-session meta close for ${definition.symbol}`);
  }
  const date = new Date(stamp * 1000);
  if (!isCompletedSession(date, definition, now)) {
    throw new Error(`Yahoo meta close is not a completed session for ${definition.symbol}`);
  }
  return { d: localParts(date, definition.timezone).date, p: roundPrice(price) };
}

const NASDAQ_MONTHS = Object.freeze({
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
});

function nasdaqDate(value) {
  const match = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(String(value || '').trim());
  if (!match || !NASDAQ_MONTHS[match[1]]) throw new Error(`Malformed Nasdaq session date`);
  return `${match[3]}-${NASDAQ_MONTHS[match[1]]}-${match[2].padStart(2, '0')}`;
}

function nasdaqHistoricalDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value || '').trim());
  if (!match) throw new Error('Malformed Nasdaq historical session date');
  return `${match[3]}-${match[1]}-${match[2]}`;
}

function usdNumber(value, label) {
  const normalized = String(value || '').replace(/^\$/, '').replace(/,/g, '').trim();
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Malformed ${label}`);
  return amount;
}

function nasdaqIdentity(payload, definition) {
  const data = payload?.data;
  if (!data || payload?.status?.rCode !== 200) throw new Error(`No Nasdaq quote for ${definition.symbol}`);
  if (data.symbol !== definition.symbol) throw new Error(`Unexpected Nasdaq symbol: ${data.symbol}`);
  if (data.assetClass !== 'ETF') throw new Error(`Unexpected Nasdaq asset class for ${definition.symbol}`);
  if (!definition.nasdaqExchangeNames.includes(data.exchange)) {
    throw new Error(`Unexpected Nasdaq exchange for ${definition.symbol}: ${data.exchange}`);
  }
  if (!definition.nasdaqCompanyNames.includes(data.companyName)) {
    throw new Error(`Unexpected Nasdaq issuer for ${definition.symbol}: ${data.companyName}`);
  }
  return data;
}

export function extractNasdaqClose(payload, definition, now = new Date()) {
  const data = nasdaqIdentity(payload, definition);
  if (data.marketStatus !== 'Closed') throw new Error(`Nasdaq market is not closed for ${definition.symbol}`);
  const d = nasdaqDate(data.primaryData?.lastTradeTimestamp);
  if (!isCompletedSessionDate(d, definition, now)) {
    throw new Error(`Nasdaq quote is not a completed session for ${definition.symbol}`);
  }
  return { d, p: roundPrice(usdNumber(data.primaryData?.lastSalePrice, `Nasdaq close for ${definition.symbol}`)) };
}

export function extractNasdaqHistoricalClose(payload, definition, now = new Date()) {
  const data = payload?.data;
  if (!data || payload?.status?.rCode !== 200) {
    throw new Error(`No Nasdaq historical close for ${definition.symbol}`);
  }
  if (data.symbol !== definition.symbol) throw new Error(`Unexpected Nasdaq historical symbol: ${data.symbol}`);
  const rows = data.tradesTable?.rows;
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error(`Missing Nasdaq historical rows for ${definition.symbol}`);
  }
  const completed = rows.map(row => ({
    d: nasdaqHistoricalDate(row?.date),
    p: roundPrice(usdNumber(row?.close, `Nasdaq historical close for ${definition.symbol}`)),
  })).filter(({ d }) => isCompletedSessionDate(d, definition, now))
    .sort((a, b) => a.d.localeCompare(b.d));
  if (!completed.length) throw new Error(`No completed Nasdaq historical close for ${definition.symbol}`);
  return completed.at(-1);
}

export function extractNasdaqDividends(payload, definition) {
  if (payload?.status?.rCode !== 200 || !payload?.data) {
    throw new Error(`No Nasdaq dividend evidence for ${definition.symbol}`);
  }
  const rows = payload.data?.dividends?.rows;
  if (!Array.isArray(rows)) throw new Error(`Missing Nasdaq dividend rows for ${definition.symbol}`);
  const result = new Map();
  for (const row of rows) {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(row?.exOrEffDate || ''));
    if (!match) throw new Error(`Malformed Nasdaq dividend date for ${definition.symbol}`);
    if (row?.currency !== 'USD' || row?.type !== 'Cash') {
      throw new Error(`Unexpected Nasdaq dividend type for ${definition.symbol}`);
    }
    const d = `${match[3]}-${match[1]}-${match[2]}`;
    result.set(d, roundPrice((result.get(d) || 0) + usdNumber(row.amount, `Nasdaq dividend for ${definition.symbol}`)));
  }
  return result;
}

export function appendCrossCheckedClose({
  yahooPayload, nasdaqInfo, nasdaqHistorical, nasdaqDividends, definition, now = new Date(),
}) {
  const series = extractPrices(yahooPayload, definition, now);
  const info = nasdaqIdentity(nasdaqInfo, definition);
  const historical = extractNasdaqHistoricalClose(nasdaqHistorical, definition, now);

  // Yahoo meta is a third price check when it has reached the target session.
  // It may legitimately lag both Nasdaq completed-close endpoints for hours;
  // an older Yahoo date must not block the independently verified close.
  let yahoo = null;
  try {
    yahoo = extractYahooMetaClose(yahooPayload, definition, now);
  } catch (error) {
    if (!String(error?.message).startsWith('Missing Yahoo completed-session meta close')) throw error;
  }
  let nasdaq;
  if (info.marketStatus === 'Closed') {
    nasdaq = extractNasdaqClose(nasdaqInfo, definition, now);
    if (historical.d !== nasdaq.d) throw new Error(`Nasdaq cross-check date mismatch for ${definition.symbol}`);
    if (Math.abs(historical.p - nasdaq.p) > CLOSE_CROSSCHECK_TOLERANCE) {
      throw new Error(`Nasdaq cross-check price mismatch for ${definition.symbol}`);
    }
  } else {
    // Global marketStatus describes the current quote session, not whether a
    // historical daily close exists. Never read primaryData/secondaryData
    // prices here: require a same-date independent regular-session witness.
    if (!yahoo || yahoo.d !== historical.d) {
      throw new Error(`Historical close needs same-date Yahoo regular-market evidence for ${definition.symbol}`);
    }
    if (Math.abs(yahoo.p - historical.p) > CLOSE_CROSSCHECK_TOLERANCE) {
      throw new Error(`Yahoo/Nasdaq historical close price mismatch for ${definition.symbol}`);
    }
    nasdaq = historical;
  }
  if (yahoo?.d > nasdaq.d) throw new Error(`Yahoo/Nasdaq date order mismatch for ${definition.symbol}`);
  if (yahoo?.d === nasdaq.d && Math.abs(yahoo.p - nasdaq.p) > CLOSE_CROSSCHECK_TOLERANCE) {
    throw new Error(`Yahoo/Nasdaq price mismatch for ${definition.symbol}`);
  }
  const latest = series.at(-1)?.d;
  if (!latest || nasdaq.d <= latest) return series;

  const yahooDivs = yahooDividends(yahooResult(yahooPayload, definition), definition);
  let div = 0;
  if (definition.symbol === 'QQQ') {
    const official = extractNasdaqDividends(nasdaqDividends, definition);
    div = official.get(nasdaq.d) || 0;
    const yahooDiv = yahooDivs.get(nasdaq.d) || 0;
    if (yahooDiv > 0 && Math.abs(yahooDiv - div) > TOTAL_RETURN_TOLERANCE) {
      throw new Error(`Dividend cross-check mismatch for ${definition.symbol} on ${nasdaq.d}`);
    }
  } else {
    const guard = definition.dividendGuard;
    if (!guard || nasdaq.d < guard.validFrom || nasdaq.d > guard.validThrough) {
      throw new Error(`Dividend calendar coverage missing for ${definition.symbol} on ${nasdaq.d}`);
    }
    const isExDate = guard.exDates.includes(nasdaq.d);
    div = yahooDivs.get(nasdaq.d) || 0;
    if (isExDate && !(div > 0)) throw new Error(`Dividend amount missing for ${definition.symbol} on ${nasdaq.d}`);
    if (!isExDate && div > 0) throw new Error(`Dividend calendar mismatch for ${definition.symbol} on ${nasdaq.d}`);
  }
  return [...series, div > 0 ? { ...nasdaq, div } : nasdaq];
}

function normalizedSeries(series) {
  const byDate = new Map();
  for (const item of series || []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item?.d)) throw new Error('Malformed benchmark cache date');
    if (!Number.isFinite(item?.p) || item.p <= 0) throw new Error(`Malformed benchmark price on ${item.d}`);
    if (item.div !== undefined && (!Number.isFinite(item.div) || item.div < 0)) {
      throw new Error(`Malformed benchmark dividend on ${item.d}`);
    }
    const div = Number.isFinite(item?.div) && item.div > 0 ? roundPrice(item.div) : 0;
    byDate.set(item.d, { p: roundPrice(item.p), ...(div > 0 ? { div } : {}) });
  }
  return [...byDate.entries()]
    .map(([d, { p, div }]) => (div > 0 ? { d, p, div } : { d, p }))
    .sort((a, b) => a.d.localeCompare(b.d));
}

function validateExistingCacheIdentity(existing){
  if(existing===null||existing===undefined)return;
  if(existing.v!==1||!existing.benchmarks)throw Error('Benchmark cache identity invalid');
  for(const [key,d]of Object.entries(DEFINITIONS)){const b=existing.benchmarks[key];if(!b||b.symbol!==d.symbol||b.currency!==d.currency||b.exchange!==d.exchange||!Array.isArray(b.series))throw Error('Benchmark cache identity invalid');}
}
export function mergePrices(existing, fetched, now = new Date()) {
  validateExistingCacheIdentity(existing);
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
  const benchmarks = {};
  for (const [key, definition] of Object.entries(DEFINITIONS)) {
    const prior = normalizedSeries(existing?.benchmarks?.[key]?.series || []);
    const incoming = normalizedSeries(fetched[key] || []);
    const byDate = new Map(prior.map(item => [item.d, item]));
    for (const item of incoming) {
      const old = byDate.get(item.d);
      // A later response without a dividend event must never erase a dividend
      // that a prior verified response already recorded.
      byDate.set(item.d, old?.div > 0 && !(item.div > 0)
        ? { d: item.d, p: item.p, div: old.div }
        : item);
    }
    const series = [...byDate.values()].filter(({ d }) => d >= cutoff)
      .sort((a, b) => a.d.localeCompare(b.d));
    if (!series.length) throw new Error(`No usable cache data for ${key}`);
    benchmarks[key] = {
      symbol: definition.symbol,
      currency: definition.currency,
      exchange: definition.exchange,
      series,
    };
  }
  return {
    v: 1,
    generatedAt: now.toISOString(),
    source: CACHE_SOURCE,
    benchmarks,
  };
}

async function readExisting(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function contentIgnoringTimestamp(cache) {
  if (!cache) return null;
  const { generatedAt: _generatedAt, ...rest } = cache;
  return rest;
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 fee-console-public-benchmark-cache/1.0',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// Extend the verified cache from one price authority: Nasdaq dated historical
// closes. Current quote status and prices are never evidence for this path.
export function appendIndependentNasdaqClose({prior,definition,nasdaqInfo,nasdaqHistorical,nasdaqDividends,now=new Date()}){
  if(!prior||prior.symbol!==definition.symbol||prior.currency!==definition.currency||prior.exchange!==definition.exchange||!Array.isArray(prior.series))throw Error('Nasdaq historical cache identity missing');
  nasdaqIdentity(nasdaqInfo,definition); // Identity only; do not read quote prices/status.
  const series=normalizedSeries(prior.series),last=series.at(-1),target=expectedBenchmarkTargetDate(now),close=extractNasdaqHistoricalClose(nasdaqHistorical,definition,now);
  if(!last||last.d>target||close.d!==target)throw Error('Nasdaq historical target pending');
  const rows=nasdaqHistorical.data.tradesTable.rows.map(r=>({d:nasdaqHistoricalDate(r.date),p:roundPrice(usdNumber(r.close,'historical anchor'))})).filter(r=>r.d<=target).sort((a,b)=>a.d.localeCompare(b.d));
  if(new Set(rows.map(r=>r.d)).size!==rows.length)throw Error('Duplicate Nasdaq historical dates');
  // Retain the existing continuity check only when extending history. A repeated
  // target can be revalidated without requiring another opening balance.
  if(last.d<target&&(rows.length<2||rows.at(-2).d!==last.d||Math.abs(rows.at(-2).p-last.p)>0.005||(Date.parse(target)-Date.parse(last.d))/DAY_MS>4))throw Error('Nasdaq historical opening history mismatch');
  const dividends=extractNasdaqDividends(nasdaqDividends,definition),div=dividends.get(target)||0;
  if(definition.symbol==='SPY'){
    const g=definition.dividendGuard;
    if(!g||target<g.validFrom||target>g.validThrough||g.exDates.includes(target)!==(div>0))throw Error('Nasdaq historical dividend coverage missing');
  }
  return [...series.filter(row=>row.d<target),div>0?{...close,div}:close];
}
async function independentNasdaq(definition,prior,now,fetchImpl){
  const prefix='https://api.nasdaq.com/api/quote/'+definition.symbol;
  const info=await fetchJson(prefix+'/info?assetclass=etf',fetchImpl);
  const target=expectedBenchmarkTargetDate(now),from=new Date(now.getTime()-10*DAY_MS).toISOString().slice(0,10);
  const historical=await fetchJson(prefix+'/historical?assetclass=etf&fromdate='+from+'&todate='+target+'&limit=20',fetchImpl);
  const dividends=await fetchJson(prefix+'/dividends?assetclass=etf',fetchImpl);
  return appendIndependentNasdaqClose({prior,definition,nasdaqInfo:info,nasdaqHistorical:historical,nasdaqDividends:dividends,now});
}
async function fetchSymbol(definition, now, fetchImpl, prior) {
  // One source, one bounded read of each existing Nasdaq endpoint. Never make a
  // Yahoo request or compare a daily historical close with live quote metadata.
  return { series: await independentNasdaq(definition, prior, now, fetchImpl), warnings: [] };
}

export async function refresh({ path = CACHE_PATH, now = new Date(), fetchImpl = fetch } = {}) {
  const existing = await readExisting(path);
  validateExistingCacheIdentity(existing);
  const fetched = {};
  const failures = [];

  for (const [key, definition] of Object.entries(DEFINITIONS)) {
    try {
      const result = await fetchSymbol(definition, now, fetchImpl, existing?.benchmarks?.[key]);
      fetched[key] = result.series;
      failures.push(...result.warnings);
    } catch (error) {
      failures.push(error.message);
      if (!existing?.benchmarks?.[key]?.series?.length) throw error;
    }
  }

  for (const failure of failures) console.warn(`Benchmark source warning: ${failure}`);

  const next = mergePrices(existing, fetched, now);
  const spyDate = next.benchmarks.spy.series.at(-1)?.d;
  const qqqDate = next.benchmarks.qqq.series.at(-1)?.d;
  if (!spyDate || spyDate !== qqqDate) {
    throw new Error(`Benchmark latest-date mismatch: spy=${spyDate || 'missing'} qqq=${qqqDate || 'missing'}`);
  }
  const target = expectedBenchmarkTargetDate(now);
  if (spyDate !== target || qqqDate !== target) {
    throw new Error(`Benchmark target pending: expected=${target} spy=${spyDate || 'missing'} qqq=${qqqDate || 'missing'}`);
  }
  // An old same-target cache must not hide a failed current read: both ETFs
  // must validate in this refresh before either correction can be published.
  if (failures.length) throw new Error('Benchmark source pending: both ETFs must validate in this refresh');
  const changed = JSON.stringify(contentIgnoringTimestamp(existing)) !== JSON.stringify(contentIgnoringTimestamp(next));
  if (changed) {
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    console.log(`Updated ${path}`);
  } else {
    console.log(`No new completed close; ${path} unchanged`);
  }
  return { changed, cache: changed ? next : existing, failures };
}

// Sharesight is the sole authority for this adapter. It emits only public
// per-share benchmark fields, never a holding's quantity or personal payout.
// The legacy CLI remains available only for the separately paused old workflow.
const SS_INSTRUMENTS = Object.freeze({
  spy: Object.freeze({ id: 44697, code: 'SPY', market: 'NYSE' }),
  qqq: Object.freeze({ id: 1886621, code: 'QQQ', market: 'NASDAQ' }),
});
const SS_SOURCE = 'Sharesight holding daily prices and company-event gross dividends; retained verified earlier history';

function ssDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw Error('SS_BENCHMARK_DATE');
  }
  return value;
}

function ssComplete(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw Error('SS_BENCHMARK_RESPONSE');
  for (const part of [response, response.meta, response.pagination, response.meta?.pagination]) {
    if (!part || typeof part !== 'object') continue;
    if (part.truncated === true || part.restricted === true || part.limited === true
        || part.has_more === true || (part.next_page !== undefined && part.next_page !== null && part.next_page !== false)) {
      throw Error('SS_BENCHMARK_INCOMPLETE');
    }
  }
  if (response.links?.next) throw Error('SS_BENCHMARK_INCOMPLETE');
}

export function sharesightBenchmarkPoint({ key, targetDate, holdingId, holdingResponse, payoutsResponse }) {
  const expected = SS_INSTRUMENTS[key];
  if (!expected || !Number.isSafeInteger(holdingId) || holdingId <= 0) throw Error('SS_BENCHMARK_BINDING');
  ssDate(targetDate); ssComplete(holdingResponse); ssComplete(payoutsResponse);
  const holding = holdingResponse.holding, instrument = holding?.instrument;
  if (holding?.id !== holdingId || instrument?.id !== expected.id || instrument?.code !== expected.code
      || instrument?.market_code !== expected.market || instrument?.currency_code !== 'USD'
      || holding?.instrument_currency?.code !== 'USD') throw Error('SS_BENCHMARK_IDENTITY');
  if (!Array.isArray(holding.values_over_time)) throw Error('SS_BENCHMARK_PRICES');
  const prices = new Map();
  for (const row of holding.values_over_time) {
    // The verified holding endpoint supplies daily valuation dates directly.
    // Do not move a date-only price into the preceding US day through UTC.
    const date = ssDate(row?.timestamp);
    if (!Number.isFinite(row?.value) || row.value <= 0) throw Error('SS_BENCHMARK_PRICE');
    const price = roundPrice(row.value);
    if (prices.has(date) && prices.get(date) !== price) throw Error('SS_BENCHMARK_PRICE_CONFLICT');
    prices.set(date, price);
  }
  if (!prices.has(targetDate)) throw Error('SS_BENCHMARK_TARGET_PENDING');
  if (!Array.isArray(payoutsResponse.payouts)) throw Error('SS_BENCHMARK_DIVIDENDS');
  const events = new Map();
  for (const payout of payoutsResponse.payouts) {
    const event = payout?.company_event;
    if (!event || !Number.isSafeInteger(event.id) || event.id <= 0
        || event.currency_code !== 'USD' || !Number.isFinite(event.amount_per_share)
        || event.amount_per_share < 0) throw Error('SS_BENCHMARK_DIVIDEND');
    const date = ssDate(event.ex_date);
    const entry = { d: date, units: Math.round(event.amount_per_share * 10000) };
    if (events.has(event.id) && JSON.stringify(events.get(event.id)) !== JSON.stringify(entry)) {
      throw Error('SS_BENCHMARK_DIVIDEND_CONFLICT');
    }
    events.set(event.id, entry);
  }
  const dividend = [...events.values()].filter(event => event.d === targetDate).reduce((sum, event) => sum + event.units, 0) / 10000;
  return { d: targetDate, p: prices.get(targetDate), ...(dividend > 0 ? { div: dividend } : {}) };
}

export function appendSharesightBenchmark({ existing, points, targetDate, now = new Date() }) {
  validateExistingCacheIdentity(existing); ssDate(targetDate);
  if (!existing || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw Error('SS_BENCHMARK_CACHE');
  const next = structuredClone(existing);
  let changed = false;
  for (const key of ['spy', 'qqq']) {
    const point = points?.[key], series = next.benchmarks[key].series;
    if (point?.d !== targetDate || !Number.isFinite(point.p) || point.p <= 0
        || (point.div !== undefined && (!Number.isFinite(point.div) || point.div < 0))) throw Error('SS_BENCHMARK_POINT');
    if (!series.length) throw Error('SS_BENCHMARK_HISTORY');
    let previous = '';
    for (const row of series) {
      ssDate(row?.d);
      if (row.d <= previous || !Number.isFinite(row.p) || row.p <= 0
          || (row.div !== undefined && (!Number.isFinite(row.div) || row.div < 0))) throw Error('SS_BENCHMARK_HISTORY');
      previous = row.d;
    }
    if (previous > targetDate) throw Error('SS_BENCHMARK_HISTORY_REWRITE');
    if (previous === targetDate) {
      const old = series.at(-1);
      if (old.p !== point.p || (old.div || 0) !== (point.div || 0)) throw Error('SS_BENCHMARK_TARGET_CONFLICT');
    } else {
      // No historical normalization, restatement, retention trimming or
      // account-specific identifiers enter the cache from this source.
      series.push({ d: point.d, p: point.p, ...(point.div > 0 ? { div: point.div } : {}) });
      changed = true;
    }
  }
  if (!changed) return { changed: false, cache: existing };
  next.generatedAt = now.toISOString(); next.source = SS_SOURCE;
  return { changed: true, cache: next };
}

export async function readSharesightBenchmark({ existing, targetDate, holdingIds, readJson, now = new Date() }) {
  ssDate(targetDate);
  if (typeof readJson !== 'function') throw Error('SS_BENCHMARK_READER');
  const points = {};
  // Authentication stays inside the caller's existing controlled client.
  // Each of the two explicitly bound holdings receives exactly two GETs.
  for (const key of ['spy', 'qqq']) {
    const id = holdingIds?.[key];
    if (!Number.isSafeInteger(id) || id <= 0) throw Error('SS_BENCHMARK_BINDING');
  }
  if (holdingIds.spy === holdingIds.qqq) throw Error('SS_BENCHMARK_BINDING');
  for (const key of ['spy', 'qqq']) {
    const id = holdingIds[key];
    const holdingResponse = await readJson(`/api/v3/holdings/${id}?values_over_time=${targetDate}`);
    const payoutsResponse = await readJson(`/api/v3/holdings/${id}/payouts?use_date=ex_date`);
    points[key] = sharesightBenchmarkPoint({ key, targetDate, holdingId: id, holdingResponse, payoutsResponse });
  }
  // Both instruments must succeed before returning any cache candidate.
  // This function does not write a cache or retry failed reads.
  return appendSharesightBenchmark({ existing, points, targetDate, now });
}

// Reuse the report calendar and its ten-calendar-day catch-up boundary. Four
// source GETs cover the missing range; no request per day and no second source.
export async function sharesightBenchmarkDates(existing, targetDate) {
  ssDate(targetDate);
  const { reportSessionOpen, reportAddDays } = await import('./fee-report-period.mjs');
  const last = existing?.benchmarks?.spy?.series?.at(-1)?.d;
  if (!last || last !== existing?.benchmarks?.qqq?.series?.at(-1)?.d) throw Error('SS_BENCHMARK_HISTORY');
  appendSharesightBenchmark({ existing, targetDate: last,
    points: Object.fromEntries(['spy', 'qqq'].map(k => [k, existing.benchmarks[k].series.at(-1)])) });
  if (last > targetDate || !reportSessionOpen(targetDate)) throw Error('SS_BENCHMARK_DATE');
  if ((Date.parse(targetDate) - Date.parse(last)) / DAY_MS > 10) throw Error('SS_BENCHMARK_RANGE');
  const dates = [];
  for (let date = reportAddDays(last, 1); date <= targetDate; date = reportAddDays(date, 1)) {
    if (reportSessionOpen(date)) dates.push(date);
  }
  return dates;
}

export async function readSharesightBenchmarkRange({ existing, targetDate, holdingIds, readJson, now = new Date() }) {
  const dates = await sharesightBenchmarkDates(existing, targetDate);
  if (!dates.length) return { changed: false, cache: existing, dates, sourceGets: 0 };
  if (typeof readJson !== 'function' || !['spy', 'qqq'].every(k => Number.isSafeInteger(holdingIds?.[k]) && holdingIds[k] > 0)
      || holdingIds.spy === holdingIds.qqq) throw Error('SS_BENCHMARK_BINDING');
  const points = {};
  for (const key of ['spy', 'qqq']) {
    const holdingId = holdingIds[key];
    const holdingResponse = await readJson(`/api/v3/holdings/${holdingId}?values_over_time=${dates[0]}`);
    const payoutsResponse = await readJson(`/api/v3/holdings/${holdingId}/payouts?use_date=ex_date`);
    points[key] = dates.map(date => sharesightBenchmarkPoint({ key, targetDate: date, holdingId, holdingResponse, payoutsResponse }));
  }
  let cache = existing;
  for (let i = 0; i < dates.length; i++) cache = appendSharesightBenchmark({ existing: cache,
    points: { spy: points.spy[i], qqq: points.qqq[i] }, targetDate: dates[i], now }).cache;
  return { changed: true, cache, dates, sourceGets: 4 };
}

const SS_REPO = 'huanwujoy-crypto/fee-console', SS_BRANCH = 'market-data-cache';
const SS_SHA = /^[a-f0-9]{40}$/;
const ssBlob = bytes => createHash('sha1').update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest('hex');
const SS_SAFE_ERRORS = new Set(['DATE', 'RESPONSE', 'INCOMPLETE', 'BINDING', 'IDENTITY', 'PRICES', 'PRICE',
  'PRICE_CONFLICT', 'TARGET_PENDING', 'DIVIDENDS', 'DIVIDEND', 'DIVIDEND_CONFLICT', 'CACHE', 'POINT', 'HISTORY',
  'HISTORY_REWRITE', 'TARGET_CONFLICT', 'READER', 'RANGE', 'MODE', 'TOKEN', 'BASE_CHANGED', 'COMMIT_UNCERTAIN',
  'COMMIT_VERIFICATION', 'HTTP', 'NETWORK', 'TIMEOUT', 'RESPONSE_SIZE', 'AUTH', 'LOCAL_WRITE', 'ARGUMENT']);
export function sharesightBenchmarkFailureCode(error) {
  const code = typeof error?.message === 'string' && error.message.startsWith('SS_BENCHMARK_')
    ? error.message.slice('SS_BENCHMARK_'.length) : '';
  return 'SS_BENCHMARK_' + (SS_SAFE_ERRORS.has(code) ? code : 'RESPONSE');
}

// Only a public per-share projection reaches GitHub. The existing owner token
// signs one fixed-file CAS update; uncertainty never triggers a second mutation.
export async function commitSharesightBenchmark({ beforeBytes, afterBytes, expectedMain, expectedCacheHead,
  targetDate, token, request: suppliedRequest }) {
  ssDate(targetDate);
  if (!SS_SHA.test(expectedMain || '') || !SS_SHA.test(expectedCacheHead || '')) throw Error('SS_BENCHMARK_BINDING');
  if (typeof token !== 'string' || token.length < 20 || /[\r\n\0]/.test(token)) throw Error('SS_BENCHMARK_TOKEN');
  const request = suppliedRequest || (await import('./fee-cloud-commit.mjs')).request;
  const graph = 'https://api.github.com/graphql', rest = `https://api.github.com/repos/${SS_REPO}`;
  const readRefs = () => request(graph, token, { method: 'POST', body: JSON.stringify({ query:
    'query { viewer { login } repository(owner:"huanwujoy-crypto", name:"fee-console") { main:ref(qualifiedName:"refs/heads/main") { target { oid } } cache:ref(qualifiedName:"refs/heads/market-data-cache") { target { oid } } file:object(expression:"market-data-cache:benchmark-close.json") { oid } } }' }) });
  const refs = await readRefs(), repository = refs?.data?.repository;
  if (refs?.errors || refs?.data?.viewer?.login !== 'huanwujoy-crypto' || repository?.main?.target?.oid !== expectedMain
      || repository?.cache?.target?.oid !== expectedCacheHead || repository?.file?.oid !== ssBlob(beforeBytes)) throw Error('SS_BENCHMARK_BASE_CHANGED');
  let result;
  try {
    result = await request(graph, token, { method: 'POST', body: JSON.stringify({
      query: 'mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid}ref{name}}}',
      variables: { input: { branch: { repositoryNameWithOwner: SS_REPO, branchName: SS_BRANCH }, expectedHeadOid: expectedCacheHead,
        message: { headline: `Sharesight benchmark ${targetDate}` },
        fileChanges: { additions: [{ path: 'benchmark-close.json', contents: Buffer.from(afterBytes).toString('base64') }] } } },
    }) });
  } catch { throw Error('SS_BENCHMARK_COMMIT_UNCERTAIN'); }
  const oid = result?.data?.createCommitOnBranch?.commit?.oid;
  if (result?.errors || !SS_SHA.test(oid || '') || result?.data?.createCommitOnBranch?.ref?.name !== SS_BRANCH) throw Error('SS_BENCHMARK_COMMIT_UNCERTAIN');
  try {
    const commit = await request(`${rest}/commits/${oid}`, token);
    const current = await readRefs();
    if (commit?.sha !== oid || commit?.commit?.verification?.verified !== true || commit?.author?.login !== 'huanwujoy-crypto'
        || commit?.parents?.length !== 1 || commit.parents[0].sha !== expectedCacheHead || commit?.files?.length !== 1
        || commit.files[0].filename !== 'benchmark-close.json' || commit.files[0].status !== 'modified'
        || commit.files[0].sha !== ssBlob(afterBytes) || current?.errors
        || current?.data?.repository?.main?.target?.oid !== expectedMain
        || current?.data?.repository?.cache?.target?.oid !== oid || current?.data?.repository?.file?.oid !== ssBlob(afterBytes)) {
      throw Error();
    }
  } catch { throw Error('SS_BENCHMARK_COMMIT_VERIFICATION'); }
  return oid;
}

export async function refreshSharesightCloud({ path, targetDate, mode, expectedMain, expectedCacheHead,
  clientId, clientSecret, holdingIds, githubToken, fetchImpl = globalThis.fetch, githubRequest, now = new Date() }) {
  if (!['shadow', 'publish'].includes(mode)) throw Error('SS_BENCHMARK_MODE');
  if (!SS_SHA.test(expectedMain || '') || !SS_SHA.test(expectedCacheHead || '')) throw Error('SS_BENCHMARK_BINDING');
  const beforeBytes = await readFile(path), existing = JSON.parse(beforeBytes);
  const dates = await sharesightBenchmarkDates(existing, targetDate);
  if (!dates.length) return { changed: false, targetDate, sourceGets: 0, cacheCommit: null };
  if (!['spy', 'qqq'].every(k => Number.isSafeInteger(holdingIds?.[k]) && holdingIds[k] > 0)
      || holdingIds.spy === holdingIds.qqq) throw Error('SS_BENCHMARK_BINDING');
  if (mode === 'publish' && (typeof githubToken !== 'string' || githubToken.length < 20 || /[\r\n\0]/.test(githubToken))) throw Error('SS_BENCHMARK_TOKEN');
  const { SharesightCloudReader } = await import('./fee-cloud-source.mjs');
  const { boundedJson, BoundedJsonError } = await import('./fee-http-json.mjs');
  let accessToken;
  try { accessToken = await new SharesightCloudReader({ clientId, clientSecret, fetchImpl, timeoutMs: 20_000 }).token(); }
  catch { throw Error('SS_BENCHMARK_AUTH'); }
  const routes = new Set(['spy', 'qqq'].flatMap(k => [
    `/api/v3/holdings/${holdingIds[k]}?values_over_time=${dates[0]}`,
    `/api/v3/holdings/${holdingIds[k]}/payouts?use_date=ex_date`,
  ]));
  const readJson = async route => {
    if (!routes.delete(route)) throw Error('SS_BENCHMARK_BINDING');
    try { return await boundedJson(fetchImpl, `https://api.sharesight.com${route}`, { method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` } },
    { timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024, requireJsonType: true }); }
    catch (error) {
      const code = error instanceof BoundedJsonError ? error.code : 'NETWORK';
      throw Error('SS_BENCHMARK_' + ({ HTTP: 'HTTP', TIMEOUT: 'TIMEOUT', NETWORK: 'NETWORK', SIZE: 'RESPONSE_SIZE' }[code] || 'RESPONSE'));
    }
  };
  let candidate;
  try { candidate = await readSharesightBenchmarkRange({ existing, targetDate, holdingIds, readJson, now }); }
  finally { accessToken = null; }
  const afterBytes = Buffer.from(JSON.stringify(candidate.cache, null, 2) + '\n');
  const cacheCommit = mode === 'publish' ? await commitSharesightBenchmark({ beforeBytes, afterBytes,
    expectedMain, expectedCacheHead, targetDate, token: githubToken, request: githubRequest }) : null;
  // Only the public projection is saved. Never save authentication, raw holding
  // responses, quantities, portfolio IDs or personal payout totals.
  const temporary = path + '.sharesight-new';
  let created = false;
  try {
    if (!(await readFile(path)).equals(beforeBytes)) throw Error();
    await writeFile(temporary, afterBytes, { mode: 0o600, flag: 'wx' });
    created = true;
    await rename(temporary, path);
  } catch { if (created) await rm(temporary, { force: true }); throw Error('SS_BENCHMARK_LOCAL_WRITE'); }
  return { changed: true, targetDate, sourceGets: candidate.sourceGets, cacheCommit };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length === 3 && process.argv[2] === '--sharesight-cloud') {
    try {
      const env = process.env, plan = JSON.parse(env.REPORT_PLAN || 'null');
      const { validateReportPlan } = await import('./fee-report-period.mjs');
      if (!validateReportPlan(plan)) throw Error('SS_BENCHMARK_ARGUMENT');
      const result = await refreshSharesightCloud({ path: env.BENCHMARK_CACHE_PATH, targetDate: plan.priceThrough,
        mode: env.FEE_CLOUD_MODE, expectedMain: env.PLANNED_MAIN, expectedCacheHead: env.BENCHMARK_CACHE_HEAD,
        clientId: env.FEE_CLOUD_SHARESIGHT_CLIENT_ID, clientSecret: env.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET,
        holdingIds: { spy: Number(env.FEE_BENCHMARK_SPY_HOLDING_ID), qqq: Number(env.FEE_BENCHMARK_QQQ_HOLDING_ID) },
        githubToken: env.FEE_CLOUD_GITHUB_TOKEN });
      console.log(JSON.stringify(result));
    } catch (error) { console.error(sharesightBenchmarkFailureCode(error)); process.exitCode = 1; }
  } else if (process.argv.length === 2) await refresh();
  else { console.error('SS_BENCHMARK_ARGUMENT'); process.exitCode = 1; }
}
