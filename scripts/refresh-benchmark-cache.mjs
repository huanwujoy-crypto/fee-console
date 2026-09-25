#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const CACHE_PATH = process.env.BENCHMARK_CACHE_PATH || 'benchmark-close.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 120;
const TOTAL_RETURN_TOLERANCE = 5e-4;
const CLOSE_CROSSCHECK_TOLERANCE = 0.005;
const CACHE_SOURCE = 'Yahoo Finance chart API; Nasdaq official quote and historical close cross-check; issuer/Nasdaq dividend evidence';

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

export function extractNasdaqClose(payload, definition, now = new Date()) {
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
  const nasdaq = extractNasdaqClose(nasdaqInfo, definition, now);
  const historical = extractNasdaqHistoricalClose(nasdaqHistorical, definition, now);
  if (historical.d !== nasdaq.d) throw new Error(`Nasdaq cross-check date mismatch for ${definition.symbol}`);
  if (Math.abs(historical.p - nasdaq.p) > CLOSE_CROSSCHECK_TOLERANCE) {
    throw new Error(`Nasdaq cross-check price mismatch for ${definition.symbol}`);
  }

  // Yahoo meta is a third price check when it has reached the target session.
  // It may legitimately lag both Nasdaq completed-close endpoints for hours;
  // an older Yahoo date must not block the independently verified close.
  let yahoo = null;
  try {
    yahoo = extractYahooMetaClose(yahooPayload, definition, now);
  } catch (error) {
    if (!String(error?.message).startsWith('Missing Yahoo completed-session meta close')) throw error;
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
    if (item.div !== undefined && (!Number.isFinite(item.div) || item.div <= 0)) {
      throw new Error(`Malformed benchmark dividend on ${item.d}`);
    }
    const div = Number.isFinite(item?.div) && item.div > 0 ? roundPrice(item.div) : 0;
    byDate.set(item.d, { p: roundPrice(item.p), ...(div > 0 ? { div } : {}) });
  }
  return [...byDate.entries()]
    .map(([d, { p, div }]) => (div > 0 ? { d, p, div } : { d, p }))
    .sort((a, b) => a.d.localeCompare(b.d));
}

export function mergePrices(existing, fetched, now = new Date()) {
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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 fee-console-public-benchmark-cache/1.0',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchSymbol(definition, now) {
  const errors = [];
  let bestPrimary = null;
  for (const host of ['query2.finance.yahoo.com', 'query1.finance.yahoo.com']) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(definition.symbol)}?range=3mo&interval=1d&events=div%2Csplits&includeAdjustedClose=true`;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const yahooPayload = await fetchJson(url);
        const primary = extractPrices(yahooPayload, definition, now);
        if (!bestPrimary || primary.at(-1)?.d > bestPrimary.at(-1)?.d) bestPrimary = primary;
        let yahooLatest = null;
        try {
          yahooLatest = extractYahooMetaClose(yahooPayload, definition, now);
        } catch (error) {
          errors.push(`${host} attempt ${attempt} Yahoo meta unavailable: ${error.message}`);
        }
        try {
          const nasdaqInfo = await fetchJson(`https://api.nasdaq.com/api/quote/${definition.symbol}/info?assetclass=etf`);
          const nasdaqLatest = extractNasdaqClose(nasdaqInfo, definition, now);
          if (primary.at(-1)?.d >= nasdaqLatest.d) return { series: primary, warnings: [] };
          const current = localParts(now, definition.timezone).date;
          const from = new Date(now.getTime() - 10 * DAY_MS).toISOString().slice(0, 10);
          const nasdaqHistorical = await fetchJson(
            `https://api.nasdaq.com/api/quote/${definition.symbol}/historical?assetclass=etf&fromdate=${from}&todate=${current}&limit=20`,
          );
          const nasdaqDividends = definition.symbol === 'QQQ'
            ? await fetchJson(`https://api.nasdaq.com/api/quote/${definition.symbol}/dividends?assetclass=etf`)
            : undefined;
          return {
            series: appendCrossCheckedClose({
              yahooPayload, nasdaqInfo, nasdaqHistorical, nasdaqDividends, definition, now,
            }),
            warnings: [],
          };
        } catch (error) {
          errors.push(`${host} attempt ${attempt} cross-check fallback unavailable: ${error.message}`);
          if (!yahooLatest || primary.at(-1)?.d >= yahooLatest.d) return { series: primary, warnings: errors };
        }
      } catch (error) {
        errors.push(`${host} attempt ${attempt}: ${error.message}`);
      }
    }
  }
  if (bestPrimary) return { series: bestPrimary, warnings: errors };
  throw new Error(`${definition.symbol} fetch failed (${errors.join('; ')})`);
}

export async function refresh({ path = CACHE_PATH, now = new Date() } = {}) {
  const existing = await readExisting(path);
  const fetched = {};
  const failures = [];

  for (const [key, definition] of Object.entries(DEFINITIONS)) {
    try {
      const result = await fetchSymbol(definition, now);
      fetched[key] = result.series;
      failures.push(...result.warnings);
    } catch (error) {
      failures.push(error.message);
      if (!existing?.benchmarks?.[key]?.series?.length) throw error;
    }
  }

  const next = mergePrices(existing, fetched, now);
  const spyDate = next.benchmarks.spy.series.at(-1)?.d;
  const qqqDate = next.benchmarks.qqq.series.at(-1)?.d;
  if (!spyDate || spyDate !== qqqDate) {
    throw new Error(`Benchmark latest-date mismatch: spy=${spyDate || 'missing'} qqq=${qqqDate || 'missing'}`);
  }
  const changed = JSON.stringify(contentIgnoringTimestamp(existing)) !== JSON.stringify(contentIgnoringTimestamp(next));
  if (changed) {
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    console.log(`Updated ${path}`);
  } else {
    console.log(`No new completed close; ${path} unchanged`);
  }
  for (const failure of failures) console.warn(`Using last verified cache: ${failure}`);
  return { changed, cache: changed ? next : existing, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await refresh();
}
