import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFINITIONS,
  appendCrossCheckedClose,
  benchmarkSessionClose,
  extractNasdaqClose,
  extractNasdaqDividends,
  extractNasdaqHistoricalClose,
  extractPrices,
  expectedBenchmarkTargetDate,
  mergePrices,
  refresh,
} from './refresh-benchmark-cache.mjs';

function epoch(iso) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function payload(definition, { timestamps = [], closes = [], adjusted = closes, dividends, meta = {} } = {}) {
  return {
    chart: {
      error: null,
      result: [{
        meta: {
          symbol: definition.symbol,
          currency: definition.currency,
          exchangeName: definition.exchangeNames[0],
          exchangeTimezoneName: definition.exchangeTimezoneName,
          instrumentType: 'ETF',
          ...meta,
        },
        timestamp: timestamps,
        indicators: { quote: [{ close: closes }], adjclose: [{ adjclose: adjusted }] },
        ...(dividends ? { events: { dividends } } : {}),
      }],
    },
  };
}

function nasdaqInfo(definition, { date = 'Sep 22, 2026', price, marketStatus = 'Closed', data = {} } = {}) {
  return {
    data: {
      symbol: definition.symbol,
      companyName: definition.nasdaqCompanyNames[0],
      exchange: definition.nasdaqExchangeNames[0],
      assetClass: 'ETF',
      marketStatus,
      primaryData: { lastSalePrice: `$${price}`, lastTradeTimestamp: date },
      ...data,
    },
    status: { rCode: 200 },
  };
}

function nasdaqDividends(rows = []) {
  return { data: { dividends: { rows } }, status: { rCode: 200 } };
}

function nasdaqHistorical(definition, rows = []) {
  return {
    data: { symbol: definition.symbol, tradesTable: { rows } },
    status: { rCode: 200 },
  };
}

test('accepts a completed, identity-verified daily close', () => {
  const day = epoch('2026-08-24T13:30:00Z');
  const result = extractPrices(payload(DEFINITIONS.qqq, {
    timestamps: [day], closes: [706.32],
  }), DEFINITIONS.qqq, new Date('2026-08-25T02:00:00Z'));
  assert.deepEqual(result, [{ d: '2026-08-24', p: 706.32 }]);
});

test('rejects an intraday quote pretending to be a daily close', () => {
  assert.throws(() => extractPrices(payload(DEFINITIONS.spy, {
    timestamps: [epoch('2026-08-24T13:30:00Z')], closes: [763.47],
  }), DEFINITIONS.spy, new Date('2026-08-24T18:10:00Z')), /No completed closes/);
});

test('validates the exact ETF identity and USD currency', () => {
  const wrong = payload(DEFINITIONS.spy, {
    timestamps: [epoch('2026-08-24T13:30:00Z')], closes: [763.47],
  });
  wrong.chart.result[0].meta.symbol = 'SPXL';
  assert.throws(() => extractPrices(wrong, DEFINITIONS.spy, new Date('2026-08-25T02:00:00Z')), /Unexpected symbol/);
});

test('rejects wrong currency, type, exchange, and timezone', () => {
  const day = epoch('2026-08-24T13:30:00Z');
  for (const [field, value, message] of [
    ['currency', 'CAD', /Unexpected currency/],
    ['instrumentType', 'EQUITY', /Unexpected instrument type/],
    ['exchangeName', 'LSE', /Unexpected exchange/],
    ['exchangeTimezoneName', 'Europe/London', /Unexpected timezone/],
  ]) {
    const wrong = payload(DEFINITIONS.spy, { timestamps: [day], closes: [763.47] });
    wrong.chart.result[0].meta[field] = value;
    assert.throws(() => extractPrices(wrong, DEFINITIONS.spy, new Date('2026-08-25T02:00:00Z')), message);
  }
});

/* 含息链的原料。adjclose 会回溯改写历史，data.json 每天只写一次、永不重述，
   所以除息金额必须和当日的原始收盘价一起存下来。 */
test('carries the cash dividend that went ex on that trading day', () => {
  const exDate = epoch('2026-09-18T13:30:00Z');
  const result = extractPrices(payload(DEFINITIONS.spy, {
    timestamps: [epoch('2026-09-17T13:30:00Z'), exDate],
    closes: [770.1, 768.4],
    adjusted: [770.1, 770.303516],
    dividends: { [exDate]: { amount: 1.903516, date: exDate } },
  }), DEFINITIONS.spy, new Date('2026-09-19T02:00:00Z'));
  assert.deepEqual(result, [
    { d: '2026-09-17', p: 770.1 },
    { d: '2026-09-18', p: 768.4, div: 1.9035 },
  ]);
});

test('fails closed when Yahoo omits or malforms a dividend event', () => {
  const d1 = epoch('2026-09-17T13:30:00Z'), d2 = epoch('2026-09-18T13:30:00Z');
  assert.throws(() => extractPrices(payload(DEFINITIONS.spy, {
    timestamps: [d1, d2], closes: [770.1, 768.4], adjusted: [770.1, 770.303516], dividends: {},
  }), DEFINITIONS.spy, new Date('2026-09-19T02:00:00Z')), /Dividend\/adjusted-close mismatch/);
  assert.throws(() => extractPrices(payload(DEFINITIONS.spy, {
    timestamps: [d1], closes: [770.1], dividends: { [d1]: { amount: 'bad', date: d1 } },
  }), DEFINITIONS.spy, new Date('2026-09-19T02:00:00Z')), /Malformed dividend event/);
});

test('leaves div off the days with no distribution', () => {
  const day = epoch('2026-08-24T13:30:00Z');
  const result = extractPrices(payload(DEFINITIONS.spy, {
    timestamps: [day], closes: [763.47], dividends: {},
  }), DEFINITIONS.spy, new Date('2026-08-25T02:00:00Z'));
  assert.deepEqual(result, [{ d: '2026-08-24', p: 763.47 }]);
});

test('ignores a dividend event just outside the requested chart boundary', () => {
  const outside = epoch('2026-06-22T13:30:00Z');
  const first = epoch('2026-06-23T13:30:00Z');
  const result = extractPrices(payload(DEFINITIONS.qqq, {
    timestamps: [first], closes: [700],
    dividends: { [outside]: { amount: 0.8, date: outside } },
  }), DEFINITIONS.qqq, new Date('2026-06-24T02:00:00Z'));
  assert.deepEqual(result, [{ d: '2026-06-23', p: 700 }]);
});

test('merges by date, replaces corrections, and preserves the last good cache', () => {
  const existing = {
    benchmarks: {
      spy: { series: [{ d: '2026-01-02', p: 700 }, { d: '2026-08-21', p: 765.72 }, { d: '2026-08-24', p: 760 }] },
      qqq: { series: [{ d: '2026-08-24', p: 706.32 }] },
    },
  };
  const merged = mergePrices(existing, {
    spy: [{ d: '2026-08-24', p: 763.47 }],
  }, new Date('2026-08-25T02:00:00Z'));
  assert.deepEqual(merged.benchmarks.spy.series, [
    { d: '2026-08-21', p: 765.72 },
    { d: '2026-08-24', p: 763.47 },
  ]);
  assert.deepEqual(merged.benchmarks.qqq.series, [{ d: '2026-08-24', p: 706.32 }]);
  assert.deepEqual(Object.keys(merged.benchmarks), ['spy', 'qqq']);
});

test('a merged correction keeps the dividend attached to its ex-date', () => {
  const existing = { benchmarks: {
    spy: { series: [{ d: '2026-09-18', p: 768.0, div: 1.9035 }] },
    qqq: { series: [{ d: '2026-09-18', p: 720.0 }] },
  } };
  const merged = mergePrices(existing, {
    spy: [{ d: '2026-09-18', p: 768.4, div: 1.9035 }],
  }, new Date('2026-09-19T02:00:00Z'));
  assert.deepEqual(merged.benchmarks.spy.series, [{ d: '2026-09-18', p: 768.4, div: 1.9035 }]);
});

test('a later price correction cannot silently erase a verified dividend', () => {
  const existing = { benchmarks: {
    spy: { series: [{ d: '2026-09-18', p: 768.0, div: 1.9035 }] },
    qqq: { series: [{ d: '2026-09-18', p: 720.0 }] },
  } };
  const merged = mergePrices(existing, {
    spy: [{ d: '2026-09-18', p: 768.4 }],
  }, new Date('2026-09-19T02:00:00Z'));
  assert.deepEqual(merged.benchmarks.spy.series, [{ d: '2026-09-18', p: 768.4, div: 1.9035 }]);
});

test('uses a Nasdaq close only when Yahoo meta independently agrees on date and price', () => {
  const prior = epoch('2026-09-21T13:30:00Z');
  const current = epoch('2026-09-22T20:00:00Z');
  const yahoo = payload(DEFINITIONS.spy, {
    timestamps: [prior], closes: [773.5],
    meta: { regularMarketTime: current, regularMarketPrice: 773.38 },
  });
  const result = appendCrossCheckedClose({
    yahooPayload: yahoo,
    nasdaqInfo: nasdaqInfo(DEFINITIONS.spy, { price: 773.38 }),
    nasdaqHistorical: nasdaqHistorical(DEFINITIONS.spy, [{ date: '09/22/2026', close: '773.38' }]),
    definition: DEFINITIONS.spy,
    now: new Date('2026-09-23T02:00:00Z'),
  });
  assert.deepEqual(result, [
    { d: '2026-09-21', p: 773.5 },
    { d: '2026-09-22', p: 773.38 },
  ]);
});

test('rejects a mismatched fallback date or close', () => {
  const prior = epoch('2026-09-21T13:30:00Z');
  const current = epoch('2026-09-22T20:00:00Z');
  const yahoo = payload(DEFINITIONS.spy, {
    timestamps: [prior], closes: [773.5],
    meta: { regularMarketTime: current, regularMarketPrice: 773.38 },
  });
  const options = { yahooPayload: yahoo, definition: DEFINITIONS.spy, now: new Date('2026-09-23T02:00:00Z') };
  assert.throws(() => appendCrossCheckedClose({
    ...options,
    nasdaqInfo: nasdaqInfo(DEFINITIONS.spy, { date: 'Sep 21, 2026', price: 773.38 }),
    nasdaqHistorical: nasdaqHistorical(DEFINITIONS.spy, [{ date: '09/22/2026', close: '773.38' }]),
  }), /date mismatch/);
  assert.throws(() => appendCrossCheckedClose({
    ...options,
    nasdaqInfo: nasdaqInfo(DEFINITIONS.spy, { price: 773.40 }),
    nasdaqHistorical: nasdaqHistorical(DEFINITIONS.spy, [{ date: '09/22/2026', close: '773.38' }]),
  }), /price mismatch/);
});

test('Nasdaq identity and closed-session gates fail closed', () => {
  const good = nasdaqInfo(DEFINITIONS.qqq, { price: 747.46 });
  assert.deepEqual(extractNasdaqClose(good, DEFINITIONS.qqq, new Date('2026-09-23T02:00:00Z')),
    { d: '2026-09-22', p: 747.46 });
  assert.throws(() => extractNasdaqClose(nasdaqInfo(DEFINITIONS.qqq, {
    price: 747.46, data: { symbol: 'TQQQ' },
  }), DEFINITIONS.qqq, new Date('2026-09-23T02:00:00Z')), /Unexpected Nasdaq symbol/);
  assert.throws(() => extractNasdaqClose(nasdaqInfo(DEFINITIONS.qqq, {
    price: 747.46, marketStatus: 'Open',
  }), DEFINITIONS.qqq, new Date('2026-09-23T02:00:00Z')), /not closed/);
});

test('Nasdaq historical close accepts only completed, symbol-matched rows', () => {
  const good = nasdaqHistorical(DEFINITIONS.qqq, [
    { date: '09/21/2026', close: '741.47' },
    { date: '09/22/2026', close: '$747.46' },
  ]);
  assert.deepEqual(
    extractNasdaqHistoricalClose(good, DEFINITIONS.qqq, new Date('2026-09-23T02:00:00Z')),
    { d: '2026-09-22', p: 747.46 },
  );
  const wrong = nasdaqHistorical(DEFINITIONS.qqq, [{ date: '09/22/2026', close: '747.46' }]);
  wrong.data.symbol = 'TQQQ';
  assert.throws(() => extractNasdaqHistoricalClose(
    wrong, DEFINITIONS.qqq, new Date('2026-09-23T02:00:00Z'),
  ), /Unexpected Nasdaq historical symbol/);
});

test('uses dual Nasdaq completed-close evidence when Yahoo meta is one session behind', () => {
  const prior = epoch('2026-09-23T13:30:00Z');
  const yahoo = payload(DEFINITIONS.spy, {
    timestamps: [prior], closes: [767.81],
    meta: { regularMarketTime: prior, regularMarketPrice: 767.81 },
  });
  const result = appendCrossCheckedClose({
    yahooPayload: yahoo,
    nasdaqInfo: nasdaqInfo(DEFINITIONS.spy, { date: 'Sep 24, 2026', price: 767.18 }),
    nasdaqHistorical: nasdaqHistorical(DEFINITIONS.spy, [{ date: '09/24/2026', close: '767.18' }]),
    definition: DEFINITIONS.spy,
    now: new Date('2026-09-25T08:00:00Z'),
  });
  assert.deepEqual(result.at(-1), { d: '2026-09-24', p: 767.18 });
});

test('uses dual Nasdaq completed-close evidence when Yahoo meta is unavailable', () => {
  const prior = epoch('2026-09-23T13:30:00Z');
  const yahoo = payload(DEFINITIONS.qqq, {
    timestamps: [prior], closes: [741.21], meta: {},
  });
  const result = appendCrossCheckedClose({
    yahooPayload: yahoo,
    nasdaqInfo: nasdaqInfo(DEFINITIONS.qqq, { date: 'Sep 24, 2026', price: 741.10 }),
    nasdaqHistorical: nasdaqHistorical(DEFINITIONS.qqq, [{ date: '09/24/2026', close: '741.10' }]),
    nasdaqDividends: nasdaqDividends([]),
    definition: DEFINITIONS.qqq,
    now: new Date('2026-09-25T08:00:00Z'),
  });
  assert.deepEqual(result.at(-1), { d: '2026-09-24', p: 741.1 });
});

test('QQQ fallback uses Nasdaq dividend evidence and validates Yahoo if both report it', () => {
  const prior = epoch('2026-09-18T13:30:00Z');
  const current = epoch('2026-09-21T20:00:00Z');
  const yahoo = payload(DEFINITIONS.qqq, {
    timestamps: [prior], closes: [721.45],
    meta: { regularMarketTime: current, regularMarketPrice: 741.47 },
  });
  const dividends = nasdaqDividends([{
    exOrEffDate: '09/21/2026', type: 'Cash', amount: '$0.75143', currency: 'USD',
  }]);
  assert.equal(extractNasdaqDividends(dividends, DEFINITIONS.qqq).get('2026-09-21'), 0.7514);
  const result = appendCrossCheckedClose({
    yahooPayload: yahoo,
    nasdaqInfo: nasdaqInfo(DEFINITIONS.qqq, { date: 'Sep 21, 2026', price: 741.47 }),
    nasdaqHistorical: nasdaqHistorical(DEFINITIONS.qqq, [{ date: '09/21/2026', close: '741.47' }]),
    nasdaqDividends: dividends,
    definition: DEFINITIONS.qqq,
    now: new Date('2026-09-22T02:00:00Z'),
  });
  assert.deepEqual(result.at(-1), { d: '2026-09-21', p: 741.47, div: 0.7514 });
});

test('SPY fallback refuses an uncovered year or a scheduled ex-date without an amount', () => {
  const prior = epoch('2026-09-17T13:30:00Z');
  const exDate = epoch('2026-09-18T20:00:00Z');
  const yahoo = payload(DEFINITIONS.spy, {
    timestamps: [prior], closes: [762.6],
    meta: { regularMarketTime: exDate, regularMarketPrice: 761.69 },
  });
  assert.throws(() => appendCrossCheckedClose({
    yahooPayload: yahoo,
    nasdaqInfo: nasdaqInfo(DEFINITIONS.spy, { date: 'Sep 18, 2026', price: 761.69 }),
    nasdaqHistorical: nasdaqHistorical(DEFINITIONS.spy, [{ date: '09/18/2026', close: '761.69' }]),
    definition: DEFINITIONS.spy,
    now: new Date('2026-09-19T02:00:00Z'),
  }), /Dividend amount missing/);

  const future = payload(DEFINITIONS.spy, {
    timestamps: [epoch('2027-01-04T14:30:00Z')], closes: [800],
    meta: { regularMarketTime: epoch('2027-01-05T21:00:00Z'), regularMarketPrice: 801 },
  });
  assert.throws(() => appendCrossCheckedClose({
    yahooPayload: future,
    nasdaqInfo: nasdaqInfo(DEFINITIONS.spy, { date: 'Jan 5, 2027', price: 801 }),
    nasdaqHistorical: nasdaqHistorical(DEFINITIONS.spy, [{ date: '01/05/2027', close: '801' }]),
    definition: DEFINITIONS.spy,
    now: new Date('2027-01-06T02:00:00Z'),
  }), /Benchmark official calendar unavailable/);
});

test('merge source describes the cross-checked fallback and paired tail dates stay inspectable', () => {
  const existing = { benchmarks: {
    spy: { series: [{ d: '2026-09-21', p: 773.5 }] },
    qqq: { series: [{ d: '2026-09-21', p: 741.47, div: 0.751 }] },
  } };
  const merged = mergePrices(existing, {
    spy: [{ d: '2026-09-22', p: 773.38 }],
    qqq: [{ d: '2026-09-22', p: 747.46 }],
  }, new Date('2026-09-23T02:00:00Z'));
  assert.match(merged.source, /Nasdaq official quote and historical close cross-check/);
  assert.equal(merged.benchmarks.spy.series.at(-1).d, merged.benchmarks.qqq.series.at(-1).d);
});

const RECOVERY_NOW = new Date('2026-10-15T00:21:31Z');
const RECOVERY_PRIOR = epoch('2026-10-13T13:30:00Z');
const RECOVERY_CLOSE = epoch('2026-10-14T20:00:00Z');

function recoveryOptions(definition = DEFINITIONS.spy, overrides = {}) {
  return {
    yahooPayload: payload(definition, {
      timestamps: [RECOVERY_PRIOR], closes: [100],
      meta: { regularMarketTime: RECOVERY_CLOSE, regularMarketPrice: 103 },
    }),
    nasdaqInfo: nasdaqInfo(definition, {
      date: 'Oct 14, 2026', price: 999, marketStatus: 'After-Hours',
    }),
    nasdaqHistorical: nasdaqHistorical(definition, [{ date: '10/14/2026', close: '103' }]),
    nasdaqDividends: nasdaqDividends(), definition, now: RECOVERY_NOW, ...overrides,
  };
}

test('historical fallback ignores extended-session prices and retains strict quote extraction', () => {
  const options = recoveryOptions();
  assert.throws(() => extractNasdaqClose(options.nasdaqInfo, DEFINITIONS.spy, RECOVERY_NOW), /not closed/);
  assert.deepEqual(appendCrossCheckedClose(options).at(-1), { d: '2026-10-14', p: 103 });
  assert.notEqual(appendCrossCheckedClose(options).at(-1).p, 999);
});

test('unknown current market status grants no price authority', () => {
  const info = nasdaqInfo(DEFINITIONS.spy, {
    marketStatus: 'unknown-provider-state', price: 999, date: 'Oct 14, 2026',
  });
  assert.deepEqual(appendCrossCheckedClose(recoveryOptions(DEFINITIONS.spy, { nasdaqInfo: info })).at(-1),
    { d: '2026-10-14', p: 103 });
  assert.throws(() => appendCrossCheckedClose(recoveryOptions(DEFINITIONS.spy, {
    nasdaqInfo: info,
    yahooPayload: payload(DEFINITIONS.spy, { timestamps: [RECOVERY_PRIOR], closes: [100] }),
  })), /needs same-date Yahoo regular-market evidence/);
});

test('non-Closed fallback rejects stale dates, mismatched values, and incomplete sessions', () => {
  const stale = payload(DEFINITIONS.spy, {
    timestamps: [RECOVERY_PRIOR], closes: [100],
    meta: { regularMarketTime: RECOVERY_PRIOR, regularMarketPrice: 100 },
  });
  assert.throws(() => appendCrossCheckedClose(recoveryOptions(DEFINITIONS.spy, { yahooPayload: stale })), /same-date/);
  const mismatch = payload(DEFINITIONS.spy, {
    timestamps: [RECOVERY_PRIOR], closes: [100],
    meta: { regularMarketTime: RECOVERY_CLOSE, regularMarketPrice: 104 },
  });
  assert.throws(() => appendCrossCheckedClose(recoveryOptions(DEFINITIONS.spy, { yahooPayload: mismatch })), /price mismatch/);
  assert.throws(() => appendCrossCheckedClose(recoveryOptions(DEFINITIONS.spy, {
    now: new Date('2026-10-14T20:14:59Z'),
  })), /No completed Nasdaq historical close/);
});

test('historical fallback preserves symbol, listing, issuer and dividend verification', () => {
  for (const data of [{ symbol: 'TQQQ' }, { assetClass: 'STOCK' }, { exchange: 'OTHER' }, { companyName: 'Other issuer' }]) {
    assert.throws(() => appendCrossCheckedClose(recoveryOptions(DEFINITIONS.spy, {
      nasdaqInfo: nasdaqInfo(DEFINITIONS.spy, { marketStatus: 'After-Hours', price: 999, data }),
    })), /Unexpected Nasdaq/);
  }
  const qqq = recoveryOptions(DEFINITIONS.qqq, {
    nasdaqDividends: nasdaqDividends([{ exOrEffDate: '10/14/2026', amount: '$0.75', currency: 'USD', type: 'Cash' }]),
  });
  assert.deepEqual(appendCrossCheckedClose(qqq).at(-1), { d: '2026-10-14', p: 103, div: 0.75 });
  const bad = nasdaqDividends([{ exOrEffDate: '10/14/2026', amount: '$0.75', currency: 'HKD', type: 'Cash' }]);
  assert.throws(() => appendCrossCheckedClose({ ...qqq, nasdaqDividends: bad }), /Unexpected Nasdaq dividend/);
});

test('expected benchmark target uses reviewed sessions across DST, weekends and holidays', () => {
  for (const [time, target] of [
    ['2026-10-14T20:14:59Z', '2026-10-13'], ['2026-10-14T20:15:00Z', '2026-10-14'],
    ['2026-11-05T21:14:59Z', '2026-11-04'], ['2026-11-05T21:15:00Z', '2026-11-05'],
    ['2026-10-18T14:00:00Z', '2026-10-16'], ['2026-10-19T18:00:00Z', '2026-10-16'],
    ['2026-11-27T02:00:00Z', '2026-11-25'], ['2026-12-26T02:00:00Z', '2026-12-24'],
  ]) assert.equal(expectedBenchmarkTargetDate(new Date(time)), target);
  assert.throws(() => expectedBenchmarkTargetDate(new Date('invalid')), /Invalid benchmark clock/);
  assert.throws(() => expectedBenchmarkTargetDate(new Date('2027-01-06T02:00:00Z')), /official calendar unavailable/);
});

function recoveryFetch({ freshPrimary = false, staleMeta = false, failedSymbol, failAll = false } = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const parsed = new URL(url);
    const symbol = /(?:chart|quote)\/(SPY|QQQ)/.exec(parsed.pathname)?.[1];
    assert.ok(symbol, `Unexpected offline request ${url}`);
    if (failAll || symbol === failedSymbol) return { ok: false, status: 503 };
    const definition = DEFINITIONS[symbol.toLowerCase()];
    let body;
    if (parsed.hostname.endsWith('finance.yahoo.com')) {
      body = payload(definition, {
        timestamps: [freshPrimary ? epoch('2026-10-14T13:30:00Z') : RECOVERY_PRIOR],
        closes: [freshPrimary ? 103 : 100],
        meta: { regularMarketTime: staleMeta ? RECOVERY_PRIOR : RECOVERY_CLOSE, regularMarketPrice: staleMeta ? 100 : 103 },
      });
    } else if (parsed.pathname.endsWith('/info')) {
      body = nasdaqInfo(definition, { date: 'Oct 14, 2026', price: 999, marketStatus: 'After-Hours' });
    } else if (parsed.pathname.endsWith('/historical')) {
      body = nasdaqHistorical(definition, [{ date: '10/14/2026', close: '103' }]);
    } else if (parsed.pathname.endsWith('/dividends')) body = nasdaqDividends();
    else assert.fail(`Unexpected offline request ${url}`);
    return { ok: true, status: 200, json: async () => body };
  };
  return { calls, fetchImpl };
}

async function offlineCache(t, cache) {
  const directory = await mkdtemp(join(tmpdir(), 'fee-benchmark-offline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'benchmark-close.json');
  const bytes = `${JSON.stringify(cache)}\n  `;
  await writeFile(path, bytes);
  return { path, bytes };
}

function priorCache() {
  return mergePrices(null, { spy: [{ d: '2026-10-13', p: 100 }], qqq: [{ d: '2026-10-13', p: 100 }] }, RECOVERY_NOW);
}

test('full refresh recovers two target rows from historical data while ignoring after-hours quotes', async t => {
  const { path } = await offlineCache(t, priorCache());
  const source = recoveryFetch();
  const result = await refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl });
  assert.equal(result.changed, true);
  for (const key of ['spy', 'qqq']) assert.deepEqual(result.cache.benchmarks[key].series.at(-1), { d: '2026-10-14', p: 103 });
  assert.ok(source.calls.some(url => url.includes('/historical?')));
  assert.equal(source.calls.filter(url => url.includes('/dividends?')).length, 1);
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(persisted, result.cache);
});

test('verified fresh daily bars do not depend on current Nasdaq market status', async t => {
  const { path } = await offlineCache(t, priorCache());
  const source = recoveryFetch({ freshPrimary: true });
  const result = await refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl });
  assert.equal(result.cache.benchmarks.spy.series.at(-1).d, '2026-10-14');
  assert.equal(source.calls.length, 2);
  assert.ok(source.calls.every(url => new URL(url).hostname.endsWith('finance.yahoo.com')));
});

test('valid stale fallback keeps trying the other Yahoo host for the exact target', async t => {
  const { path } = await offlineCache(t, priorCache());
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const parsed = new URL(url);
    const symbol = /(?:chart|quote)\/(SPY|QQQ)/.exec(parsed.pathname)?.[1];
    const definition = DEFINITIONS[symbol?.toLowerCase()];
    assert.ok(definition, `Unexpected offline request ${url}`);
    let body;
    if (parsed.hostname.endsWith('finance.yahoo.com')) {
      const fresh = parsed.hostname === 'query1.finance.yahoo.com';
      body = payload(definition, {
        timestamps: [fresh ? epoch('2026-10-14T13:30:00Z') : RECOVERY_PRIOR],
        closes: [fresh ? 103 : 100],
        meta: { regularMarketTime: RECOVERY_PRIOR, regularMarketPrice: 100 },
      });
    } else if (parsed.pathname.endsWith('/info')) {
      body = nasdaqInfo(definition, { date: 'Oct 13, 2026', price: 100 });
    } else if (parsed.pathname.endsWith('/historical')) {
      body = nasdaqHistorical(definition, [{ date: '10/13/2026', close: '100' }]);
    } else if (parsed.pathname.endsWith('/dividends')) body = nasdaqDividends();
    else assert.fail(`Unexpected offline request ${url}`);
    return { ok: true, status: 200, json: async () => body };
  };
  const result = await refresh({ path, now: RECOVERY_NOW, fetchImpl });
  for (const key of ['spy', 'qqq']) assert.deepEqual(result.cache.benchmarks[key].series.at(-1), { d: '2026-10-14', p: 103 });
  assert.equal(calls.filter(url => new URL(url).hostname === 'query1.finance.yahoo.com').length, 2);
  assert.equal(calls.filter(url => new URL(url).hostname === 'query2.finance.yahoo.com').length, 4);
  assert.equal(result.failures.filter(message => message.includes('completed close still stale')).length, 4);
});

test('regular-market metadata timestamp is a witness; only historical daily close supplies the appended price', () => {
  for (const stamp of ['2026-10-14T13:30:00Z', '2026-10-14T19:00:00Z', '2026-10-14T22:00:00Z']) {
    const yahooPayload = payload(DEFINITIONS.spy, {
      timestamps: [RECOVERY_PRIOR], closes: [100],
      meta: { regularMarketTime: epoch(stamp), regularMarketPrice: 103 },
    });
    const options = {
      yahooPayload, definition: DEFINITIONS.spy, now: RECOVERY_NOW,
      nasdaqInfo: nasdaqInfo(DEFINITIONS.spy, { date: 'Oct 14, 2026', price: 999, marketStatus: 'After-Hours' }),
      nasdaqHistorical: nasdaqHistorical(DEFINITIONS.spy, [{ date: '10/14/2026', close: '103' }]),
    };
    assert.deepEqual(appendCrossCheckedClose(options).at(-1), { d: '2026-10-14', p: 103 });
    yahooPayload.chart.result[0].meta.regularMarketPrice = 100;
    assert.throws(() => appendCrossCheckedClose(options), /historical close price mismatch/);
  }
});

test('all source failures cannot report success or rewrite old cache bytes', async t => {
  const { path, bytes } = await offlineCache(t, priorCache());
  const source = recoveryFetch({ failAll: true });
  await assert.rejects(refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl }), /target pending: expected=2026-10-14/);
  assert.equal(await readFile(path, 'utf8'), bytes);
  assert.equal(source.calls.length, 8);
});

test('one fresh ETF and one stale ETF cannot partially write the cache', async t => {
  const { path, bytes } = await offlineCache(t, priorCache());
  const source = recoveryFetch({ failedSymbol: 'QQQ' });
  await assert.rejects(refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl }), /latest-date mismatch/);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('same-date historical data without independent regular-market evidence stays pending', async t => {
  const { path, bytes } = await offlineCache(t, priorCache());
  const source = recoveryFetch({ staleMeta: true });
  await assert.rejects(refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl }), /target pending/);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('successful target reuse is a byte-identical no-op', async t => {
  const cache = mergePrices(null, { spy: [{ d: '2026-10-14', p: 103 }], qqq: [{ d: '2026-10-14', p: 103 }] }, RECOVERY_NOW);
  const { path, bytes } = await offlineCache(t, cache);
  const source = recoveryFetch({ freshPrimary: true });
  const result = await refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl });
  assert.equal(result.changed, false);
  assert.equal(await readFile(path, 'utf8'), bytes);
  assert.equal(source.calls.length, 0);
});

test('reviewed early close is complete after13:15NY and a holiday never supplies a fabricated bar', () => {
  assert.equal(benchmarkSessionClose('2026-11-27', DEFINITIONS.spy), 780);
  assert.equal(benchmarkSessionClose('2026-11-26', DEFINITIONS.qqq), null);
  const early = payload(DEFINITIONS.spy, { timestamps: [epoch('2026-11-27T14:30:00Z')], closes: [103] });
  assert.throws(() => extractPrices(early, DEFINITIONS.spy, new Date('2026-11-27T18:14:59Z')), /No completed closes/);
  assert.deepEqual(extractPrices(early, DEFINITIONS.spy, new Date('2026-11-27T18:15:00Z')), [{ d: '2026-11-27', p: 103 }]);
  const closed = payload(DEFINITIONS.spy, { timestamps: [epoch('2026-11-26T14:30:00Z')], closes: [999] });
  assert.throws(() => extractPrices(closed, DEFINITIONS.spy, new Date('2026-11-27T02:00:00Z')), /No completed closes/);
});

test('only the missing ETF is fetched and complete cached evidence is retained', async t => {
  const cache = priorCache();
  cache.benchmarks.spy.series.push({ d: '2026-10-14', p: 103 });
  const { path } = await offlineCache(t, cache);
  const source = recoveryFetch();
  const result = await refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl });
  assert.ok(source.calls.length > 0);
  assert.ok(source.calls.every(url => !url.includes('/SPY')));
  assert.deepEqual(result.cache.benchmarks.spy.series.at(-1), { d: '2026-10-14', p: 103 });
  assert.deepEqual(result.cache.benchmarks.qqq.series.at(-1), { d: '2026-10-14', p: 103 });
});

test('holiday reuses the actual previous trading session without provider calls or new dates', async t => {
  const now = new Date('2026-11-27T01:00:00Z');
  const cache = mergePrices(null, { spy: [{ d: '2026-11-25', p: 103 }], qqq: [{ d: '2026-11-25', p: 103 }] }, now);
  const { path, bytes } = await offlineCache(t, cache);
  const source = recoveryFetch({ failAll: true });
  const result = await refresh({ path, now, fetchImpl: source.fetchImpl });
  assert.equal(result.changed, false);
  assert.equal(source.calls.length, 0);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('untrusted or future cache evidence cannot bypass price verification by claiming a target row', async t => {
  for (const alter of [
    cache => { cache.benchmarks.spy.symbol = 'SPXL'; },
    cache => { cache.benchmarks.spy.series.push({ d: '2026-10-15', p: 103 }); },
    cache => { cache.benchmarks.spy.series.push({ d: '2026-10-13', p: 999 }); },
  ]) {
    const cache = priorCache(); alter(cache);
    const { path, bytes } = await offlineCache(t, cache);
    const source = recoveryFetch();
    await assert.rejects(refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl }), /Invalid reusable benchmark cache/);
    assert.equal(await readFile(path, 'utf8'), bytes);
    assert.equal(source.calls.length, 0);
  }
});

test('target tail with missing intermediate sessions cannot be reused or written', async t => {
  const rows = [{ d: '2026-10-09', p: 99 }, { d: '2026-10-14', p: 103 }];
  const cache = mergePrices(null, { spy: rows, qqq: rows }, RECOVERY_NOW);
  const { path, bytes } = await offlineCache(t, cache);
  const source = recoveryFetch({ freshPrimary: true });
  await assert.rejects(refresh({ path, now: RECOVERY_NOW, fetchImpl: source.fetchImpl }), /session gap/);
  assert.equal(source.calls.length, 2);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('complete fresh history can repair missing sessions without replacing the price definition', async t => {
  const rows = [{ d: '2026-10-09', p: 99 }, { d: '2026-10-14', p: 103 }];
  const cache = mergePrices(null, { spy: rows, qqq: rows }, RECOVERY_NOW);
  const { path } = await offlineCache(t, cache);
  let calls = 0;
  const fetchImpl = async url => {
    calls += 1;
    const symbol = /chart\/(SPY|QQQ)/.exec(new URL(url).pathname)?.[1];
    assert.ok(symbol);
    return { ok: true, status: 200, json: async () => payload(DEFINITIONS[symbol.toLowerCase()], {
      timestamps: ['2026-10-12', '2026-10-13', '2026-10-14'].map(d => epoch(`${d}T13:30:00Z`)),
      closes: [101, 102, 103],
      meta: { regularMarketTime: RECOVERY_CLOSE, regularMarketPrice: 103 },
    }) };
  };
  const result = await refresh({ path, now: RECOVERY_NOW, fetchImpl });
  assert.equal(calls, 2);
  for (const key of ['spy', 'qqq']) assert.deepEqual(result.cache.benchmarks[key].series.map(row => row.d),
    ['2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14']);
});

test('a normalized impossible date is never an official session', () => {
  assert.throws(() => benchmarkSessionClose('2026-02-30', DEFINITIONS.spy), /calendar unavailable/);
});
