#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const CACHE_PATH = process.env.BENCHMARK_CACHE_PATH || 'benchmark-close.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 120;

export const DEFINITIONS = Object.freeze({
  cspx: Object.freeze({
    symbol: 'CSPX.L',
    currency: 'USD',
    exchangeNames: Object.freeze(['LSE']),
    exchange: 'LSE',
    timezone: 'Europe/London',
    closeMinutes: 16 * 60 + 30,
  }),
  eqac: Object.freeze({
    symbol: 'EQAC.SW',
    currency: 'USD',
    exchangeNames: Object.freeze(['EBS']),
    exchange: 'SIX',
    timezone: 'Europe/Zurich',
    closeMinutes: 17 * 60 + 30,
  }),
});

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

  const byDate = new Map();
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const price = closes[i];
    if (!Number.isFinite(price) || price <= 0) continue;
    const date = new Date(timestamps[i] * 1000);
    if (!isCompletedSession(date, definition, now)) continue;
    byDate.set(localParts(date, definition.timezone).date, roundPrice(price));
  }

  // Yahoo occasionally leaves the newest daily candle null while exposing the
  // completed close in meta. Accept it only after that exchange session ended.
  if (Number.isFinite(meta.regularMarketPrice) && meta.regularMarketPrice > 0 && Number.isFinite(meta.regularMarketTime)) {
    const quoteTime = new Date(meta.regularMarketTime * 1000);
    if (isCompletedSession(quoteTime, definition, now)) {
      byDate.set(localParts(quoteTime, definition.timezone).date, roundPrice(meta.regularMarketPrice));
    }
  }

  const series = [...byDate.entries()]
    .map(([d, p]) => ({ d, p }))
    .sort((a, b) => a.d.localeCompare(b.d));
  if (!series.length) throw new Error(`No completed closes for ${definition.symbol}`);
  return series;
}

function normalizedSeries(series) {
  const byDate = new Map();
  for (const item of series || []) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(item?.d) && Number.isFinite(item?.p) && item.p > 0) {
      byDate.set(item.d, roundPrice(item.p));
    }
  }
  return [...byDate.entries()]
    .map(([d, p]) => ({ d, p }))
    .sort((a, b) => a.d.localeCompare(b.d));
}

export function mergePrices(existing, fetched, now = new Date()) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
  const benchmarks = {};
  for (const [key, definition] of Object.entries(DEFINITIONS)) {
    const prior = existing?.benchmarks?.[key]?.series || [];
    const incoming = fetched[key] || [];
    const series = normalizedSeries([...prior, ...incoming]).filter(({ d }) => d >= cutoff);
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
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(definition.symbol)}?range=3mo&interval=1d&events=history`;
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
