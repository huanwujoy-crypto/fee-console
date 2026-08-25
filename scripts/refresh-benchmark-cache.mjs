#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const CACHE_PATH = process.env.BENCHMARK_CACHE_PATH || 'benchmark-close.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 120;
const TOTAL_RETURN_TOLERANCE = 5e-4;

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
  }),
  qqq: Object.freeze({
    symbol: 'QQQ',
    currency: 'USD',
    exchangeNames: Object.freeze(['NMS', 'NasdaqGS', 'NGM']),
    exchangeTimezoneName: 'America/New_York',
    exchange: 'NasdaqGS',
    timezone: 'America/New_York',
    closeMinutes: 16 * 60,
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

function roundPrice(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

export function extractPrices(payload, definition, now = new Date()) {
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

  // Do not use meta.regularMarketPrice as a fallback.  It has no paired
  // adjusted-close observation, so an ex-dividend omission could not be
  // verified.  A one-day stale cache is safer than an unverifiable close.

  // Cash dividends, keyed by ex-date in the listing's own timezone. Yahoo only
  // returns these when the request carries `events=div`.
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

  for (const d of divByDate.keys()) {
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
    source: 'Yahoo Finance public chart API',
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
  for (const host of ['query2.finance.yahoo.com', 'query1.finance.yahoo.com']) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(definition.symbol)}?range=3mo&interval=1d&events=div%2Csplits&includeAdjustedClose=true`;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return extractPrices(await fetchJson(url), definition, now);
      } catch (error) {
        errors.push(`${host} attempt ${attempt}: ${error.message}`);
      }
    }
  }
  throw new Error(`${definition.symbol} fetch failed (${errors.join('; ')})`);
}

export async function refresh({ path = CACHE_PATH, now = new Date() } = {}) {
  const existing = await readExisting(path);
  const fetched = {};
  const failures = [];

  for (const [key, definition] of Object.entries(DEFINITIONS)) {
    try {
      fetched[key] = await fetchSymbol(definition, now);
    } catch (error) {
      failures.push(error.message);
      if (!existing?.benchmarks?.[key]?.series?.length) throw error;
    }
  }

  const next = mergePrices(existing, fetched, now);
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
