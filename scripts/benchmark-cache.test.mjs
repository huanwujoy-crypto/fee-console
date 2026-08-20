import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFINITIONS, extractPrices, mergePrices } from './refresh-benchmark-cache.mjs';

function epoch(iso) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function payload(definition, { timestamps = [], closes = [], marketTime, marketPrice } = {}) {
  return {
    chart: {
      error: null,
      result: [{
        meta: {
          symbol: definition.symbol,
          currency: definition.currency,
          exchangeName: definition.exchangeNames[0],
          instrumentType: 'ETF',
          regularMarketTime: marketTime,
          regularMarketPrice: marketPrice,
        },
        timestamp: timestamps,
        indicators: { quote: [{ close: closes }] },
      }],
    },
  };
}

test('accepts a completed close from meta after the session', () => {
  const result = extractPrices(payload(DEFINITIONS.eqac, {
    marketTime: epoch('2026-08-19T15:20:00Z'),
    marketPrice: 505.1,
  }), DEFINITIONS.eqac, new Date('2026-08-20T01:00:00Z'));
  assert.deepEqual(result, [{ d: '2026-08-19', p: 505.1 }]);
});

test('rejects an intraday quote pretending to be a daily close', () => {
  assert.throws(() => extractPrices(payload(DEFINITIONS.cspx, {
    marketTime: epoch('2026-08-20T07:45:00Z'),
    marketPrice: 832.79,
  }), DEFINITIONS.cspx, new Date('2026-08-20T08:10:00Z')), /No completed closes/);
});

test('validates the exact ETF identity and USD currency', () => {
  const wrong = payload(DEFINITIONS.eqac, {
    marketTime: epoch('2026-08-19T15:20:00Z'),
    marketPrice: 505.1,
  });
  wrong.chart.result[0].meta.symbol = 'EQQQ.SW';
  assert.throws(() => extractPrices(wrong, DEFINITIONS.eqac, new Date('2026-08-20T01:00:00Z')), /Unexpected symbol/);
});

test('merges by date, replaces corrections, and preserves the last good cache', () => {
  const existing = {
    benchmarks: {
      cspx: { series: [{ d: '2026-01-02', p: 700 }, { d: '2026-08-18', p: 829.52 }, { d: '2026-08-19', p: 830 }] },
      eqac: { series: [{ d: '2026-08-19', p: 505.1 }] },
    },
  };
  const merged = mergePrices(existing, {
    cspx: [{ d: '2026-08-19', p: 832.79 }],
  }, new Date('2026-08-20T01:00:00Z'));
  assert.deepEqual(merged.benchmarks.cspx.series, [
    { d: '2026-08-18', p: 829.52 },
    { d: '2026-08-19', p: 832.79 },
  ]);
  assert.deepEqual(merged.benchmarks.eqac.series, [{ d: '2026-08-19', p: 505.1 }]);
  assert.deepEqual(Object.keys(merged.benchmarks), ['cspx', 'eqac']);
});
