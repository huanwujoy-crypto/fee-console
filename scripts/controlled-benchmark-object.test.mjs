import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DEFINITIONS } from './refresh-benchmark-cache.mjs';
import { produceControlledBenchmark } from './produce-controlled-benchmark.mjs';
import { PRICE_BUCKET, PARSER_SHA256, sealPriceCache, validatePriceEnvelope, readControlledBenchmark, validatePriceMode } from './controlled-benchmark-object.mjs';
import { selectBenchmark } from './fee-cloud-source.mjs';
import { publishedPreflight } from './fee-cloud-producer.mjs';

const target = '2026-10-09', now = '2026-10-09T22:16:00Z';
const input = round => ({ target, round, sessionKey: `unified-close:${target}:benchmark:${round}` });
const cache = date => ({ v: 1, benchmarks: Object.fromEntries(Object.entries(DEFINITIONS).map(([key, d]) =>
  [key, { symbol: d.symbol, currency: d.currency, exchange: d.exchange, series: [{ d: date, p: 100 }] }])) });
const sealed = (round = 1) => sealPriceCache(cache(target), { ...input(round), producedAt: round === 1 ? now : '2026-10-09T22:46:00Z' });
const response = value => new Response(JSON.stringify(value), { status: 200 });
const name = `unified-close/v1/${target}/benchmark-prices.json`;

test('actual unchanged parser is hash-bound; exact rows use the existing fee selector and preflight', async () => {
  assert.equal(createHash('sha256').update(await readFile(new URL('./refresh-benchmark-cache.mjs', import.meta.url))).digest('hex'), PARSER_SHA256);
  const value = sealed(), selected = validatePriceEnvelope(value, target, new Date(now));
  assert.equal(selectBenchmark(selected, target).spy, 100);
  const preflight = await publishedPreflight({ cache: selected, now: () => new Date('2026-10-10T02:00:00Z'),
    readState: async () => ({ mainSha: 'a'.repeat(40), finalMainSha: 'a'.repeat(40), pending: false }), attempts: 1 });
  assert.equal(preflight.targetDate, target); assert.equal(preflight.outcome, 'produce');
});

test('first stale actual provider result fails; second calls real parser/provider again and produces target', async () => {
  const original = globalThis.fetch, requests = []; let date = '2026-10-08';
  globalThis.fetch = async url => {
    requests.push(url);
    if (url.startsWith('https://api.nasdaq.com/')) return { ok: false, status: 503 };
    const symbol = url.includes('/SPY?') ? 'SPY' : 'QQQ';
    const definition = symbol === 'SPY' ? DEFINITIONS.spy : DEFINITIONS.qqq;
    return { ok: true, json: async () => ({ chart: { error: null, result: [{
      meta: { symbol, currency: 'USD', instrumentType: 'ETF', exchangeName: definition.exchangeNames[0],
        exchangeTimezoneName: 'America/New_York' }, timestamp: [Date.parse(date + 'T13:30:00Z') / 1000],
      indicators: { quote: [{ close: [100] }], adjclose: [{ adjclose: [100] }] },
    }] } }) };
  };
  try {
    await assert.rejects(produceControlledBenchmark({ ...input(1), seedCache: cache(date) }, { now: () => new Date(now) }));
    const firstCount = requests.length; assert.ok(firstCount >= 4);
    date = target;
    const second = await produceControlledBenchmark({ ...input(2), seedCache: cache('2026-10-08') },
      { now: () => new Date('2026-10-09T22:46:00Z') });
    assert.ok(requests.length > firstCount);
    assert.equal(validatePriceEnvelope(second, target, '2026-10-09T22:47:00Z').benchmarks.qqq.series[0].d, target);
    assert.ok(requests.every(url => /^(https:\/\/query[12]\.finance\.yahoo\.com\/|https:\/\/api\.nasdaq\.com\/)/.test(url)));
  } finally { globalThis.fetch = original; }
});

test('an exact completed seed performs zero public source requests', async () => {
  const old = globalThis.fetch; globalThis.fetch = async () => { throw new Error('provider should be skipped'); };
  try {
    const value = await produceControlledBenchmark({ ...input(2), seedCache: cache(target) }, { now: () => new Date('2026-10-09T22:46:00Z') });
    assert.equal(value.round, 2);
  } finally { globalThis.fetch = old; }
});

test('actual consumer performs only two fixed generation-bound GCS GETs', async () => {
  const calls = [], value = sealed();
  const result = await readControlledBenchmark({ target, token: 'synthetic-token', now,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(calls.length === 1 ? { bucket: PRICE_BUCKET, name, generation: '42', size: String(JSON.stringify(value).length) } : value);
    } });
  assert.equal(result.generation, '42'); assert.equal(selectBenchmark(result.cache, target).qqq, 100);
  const preflight = await publishedPreflight({ cache: result.cache, now: () => new Date('2026-10-10T02:00:00Z'),
    readState: async () => ({ mainSha: 'a'.repeat(40), finalMainSha: 'a'.repeat(40), pending: false }), attempts: 1 });
  assert.equal(preflight.targetDate, target); assert.equal(preflight.outcome, 'produce');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.endsWith('?alt=media&generation=42'));
  assert.ok(calls.every(call => call.options.method === 'GET' && call.options.redirect === 'error'
    && call.url.includes(encodeURIComponent(name))));
});

test('wrong target, future time, parser, payload hash or extra financial field fails closed', () => {
  for (const patch of [{ target: '2026-10-08' }, { parserSha256: '0'.repeat(64) }, { cacheSha256: '0'.repeat(64) },
    { producedAt: '2026-10-09T23:00:00Z' }, { financialField: 'synthetic-rejected' }]) {
    assert.throws(() => validatePriceEnvelope({ ...sealed(), ...patch }, target, now));
  }
  const value = sealPriceCache(cache(target), { ...input(2), producedAt: '2026-10-09T23:15:00Z' });
  assert.throws(() => validatePriceEnvelope(value, target, '2026-10-09T23:16:00Z'));
});

test('a fetching operation that crosses its round deadline cannot seal a result', async () => {
  let count = 0;
  await assert.rejects(produceControlledBenchmark({ ...input(1), seedCache: cache('2026-10-08') }, {
    now: () => new Date(count++ === 0 ? now : '2026-10-09T22:45:00Z'),
    refreshImpl: async () => ({ cache: cache(target) }),
  }));
});

test('missing, oversized, wrong-key or failed object reads do not fall back to legacy prices', async () => {
  for (const patch of [{ name: 'other' }, { bucket: 'other' }, { size: '20000' }, { generation: '0' }]) {
    let calls = 0;
    await assert.rejects(readControlledBenchmark({ target, token: 'synthetic-token', now, fetchImpl: async () => {
      calls++; return response({ bucket: PRICE_BUCKET, name, generation: '42', size: '100', ...patch });
    } }));
    assert.equal(calls, 1);
  }
  await assert.rejects(readControlledBenchmark({ target, token: 'synthetic-token', now,
    fetchImpl: async () => new Response('{}', { status: 404 }) }));
});

test('unknown source mode and newline tokens are rejected before any transport', async () => {
  assert.equal(validatePriceMode(''), false); assert.equal(validatePriceMode('control-object-v1'), true);
  assert.throws(() => validatePriceMode('anything-else'));
  await assert.rejects(readControlledBenchmark({ target, token: 'bad\ntoken', fetchImpl: () => assert.fail('network called') }));
});
