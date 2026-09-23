import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFINITIONS,
  appendCrossCheckedClose,
  extractNasdaqClose,
  extractNasdaqDividends,
  extractPrices,
  mergePrices,
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
    ...options, nasdaqInfo: nasdaqInfo(DEFINITIONS.spy, { date: 'Sep 21, 2026', price: 773.38 }),
  }), /date mismatch/);
  assert.throws(() => appendCrossCheckedClose({
    ...options, nasdaqInfo: nasdaqInfo(DEFINITIONS.spy, { price: 773.40 }),
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
    definition: DEFINITIONS.spy,
    now: new Date('2027-01-06T02:00:00Z'),
  }), /calendar coverage missing/);
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
  assert.match(merged.source, /Nasdaq official quote cross-check/);
  assert.equal(merged.benchmarks.spy.series.at(-1).d, merged.benchmarks.qqq.series.at(-1).d);
});
