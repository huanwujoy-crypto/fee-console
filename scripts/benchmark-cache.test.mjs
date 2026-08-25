import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFINITIONS, extractPrices, mergePrices } from './refresh-benchmark-cache.mjs';

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
