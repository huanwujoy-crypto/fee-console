// Public market prices only. This module never dispatches GitHub or reads a financial API.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { benchmarkTargetStatus, closeSessionPlan } from './benchmark-close-contract.mjs';

export const PRICE_SCHEMA = 'unified-close.public-prices.v1';
export const PARSER_SHA256 = 'a0e9cfa389d89815427b3556ee5c118b769289b109fff1f6c4dc808a597aa4cf';
export const PRICE_BUCKET = 'family-portfolio-gateway-schwab-gmail-state-860729177589';
const hash = text => createHash('sha256').update(text).digest('hex');
const fail = () => { throw new Error('CONTROLLED_BENCHMARK_UNVERIFIED'); };
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...expected].sort().join(',');

export function priceObjectName(target) {
  closeSessionPlan(target);
  return `unified-close/v1/${target}/benchmark-prices.json`;
}

export function targetPriceCache(cache, target) {
  if (!benchmarkTargetStatus(cache, target).ready) fail();
  return { v: 1, benchmarks: Object.fromEntries(['spy', 'qqq'].map(key => {
    const item = cache.benchmarks[key], row = item.series.find(row => row.d === target);
    return [key, { symbol: item.symbol, currency: item.currency, exchange: item.exchange,
      series: [{ d: target, p: row.p, ...(row.div === undefined ? {} : { div: row.div }) }] }];
  })) };
}

export function sealPriceCache(cache, { target, round, sessionKey, producedAt }) {
  const cacheJson = JSON.stringify(targetPriceCache(cache, target));
  return { schema: PRICE_SCHEMA, target, round, sessionKey, producedAt,
    parserSha256: PARSER_SHA256, cacheSha256: hash(cacheJson), cacheJson };
}

export function validatePriceEnvelope(value, target, now = new Date()) {
  if (!keys(value, ['schema', 'target', 'round', 'sessionKey', 'producedAt', 'parserSha256', 'cacheSha256', 'cacheJson'])
      || value.schema !== PRICE_SCHEMA || value.target !== target || ![1, 2].includes(value.round)
      || value.sessionKey !== `unified-close:${target}:benchmark:${value.round}`
      || value.parserSha256 !== PARSER_SHA256 || typeof value.cacheJson !== 'string'
      || Buffer.byteLength(value.cacheJson) > 16384 || value.cacheSha256 !== hash(value.cacheJson)) fail();
  const plan = closeSessionPlan(target), stamp = Date.parse(value.producedAt), current = new Date(now).getTime();
  const start = Date.parse(value.round === 1 ? plan.firstAt : plan.retryAt);
  const end = Date.parse(value.round === 1 ? plan.retryAt : plan.secondDeadlineAt);
  if (!plan.open || !Number.isFinite(stamp) || !Number.isFinite(current) || stamp < start || stamp >= end || stamp > current) fail();
  let cache;
  try { cache = JSON.parse(value.cacheJson); } catch { fail(); }
  if (!keys(cache, ['v', 'benchmarks']) || !keys(cache.benchmarks, ['spy', 'qqq'])
      || !benchmarkTargetStatus(cache, target).ready) fail();
  for (const key of ['spy', 'qqq']) {
    const item = cache.benchmarks[key], row = item.series?.[0];
    if (!keys(item, ['symbol', 'currency', 'exchange', 'series']) || item.series.length !== 1
        || !keys(row, row?.div === undefined ? ['d', 'p'] : ['d', 'p', 'div'])) fail();
  }
  return cache;
}

async function jsonResponse(response, limit) {
  if (!response.ok || !response.body) fail();
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) fail(); chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel(); }
}

export async function readControlledBenchmark({ target, token, now = new Date(), fetchImpl = fetch }) {
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) fail();
  const name = priceObjectName(target), root = `https://storage.googleapis.com/storage/v1/b/${PRICE_BUCKET}/o/${encodeURIComponent(name)}`;
  const request = url => fetchImpl(url, { method: 'GET', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(20000) });
  const meta = await jsonResponse(await request(root + '?fields=bucket,name,generation,size'), 8192);
  if (meta.bucket !== PRICE_BUCKET || meta.name !== name || !/^[1-9][0-9]{0,31}$/.test(meta.generation)
      || !/^[0-9]{1,8}$/.test(meta.size) || Number(meta.size) > 16384) fail();
  const value = await jsonResponse(await request(root + '?alt=media&generation=' + meta.generation), 16384);
  return { cache: validatePriceEnvelope(value, target, now), generation: meta.generation };
}

export function validatePriceMode(mode) {
  if (mode !== '' && mode !== 'control-object-v1') fail();
  return mode === 'control-object-v1';
}

async function main() {
  const args = process.argv.slice(2);
  if (args.join() === '--validate-mode') { validatePriceMode(process.env.UNIFIED_CLOSE_PRICE_SOURCE || ''); return; }
  if (args.length !== 1 || !args[0].startsWith('--out=')
      || !validatePriceMode(process.env.UNIFIED_CLOSE_PRICE_SOURCE || '')) fail();
  const path = args[0].slice(6);
  if (!path.startsWith('/') || path.includes('/../')) fail();
  const { expectedTargetDate } = await import('./fee-cloud-source.mjs');
  const target = expectedTargetDate(new Date());
  const { cache } = await readControlledBenchmark({ target, token: process.env.CONTROL_PRICE_ACCESS_TOKEN });
  await fs.writeFile(path, JSON.stringify(cache) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('CONTROLLED_BENCHMARK_READY');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => { console.error('CONTROLLED_BENCHMARK_UNVERIFIED'); process.exitCode = 1; });
}
