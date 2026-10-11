import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { refreshSessionBenchmark, validateSessionInputs } from './refresh-session-benchmark.mjs';
before(() => { globalThis.fetch = async () => { throw new Error('synthetic tests prohibit network'); }; });

const target = '2026-10-09';
const env = round => ({ CLOSE_TARGET_DATE: target, CLOSE_ROUND: String(round),
  CLOSE_SESSION_KEY: `unified-close:${target}:benchmark:${round}`, CLOSE_UNIFIED_ENABLED: 'true' });
const cache = date => ({ v: 1, benchmarks: {
  spy: { symbol: 'SPY', currency: 'USD', exchange: 'NYSEArca', series: [{ d: date, p: 100 }] },
  qqq: { symbol: 'QQQ', currency: 'USD', exchange: 'NasdaqGS', series: [{ d: date, p: 100 }] },
} });

test('exact first/second windows bind the target and expire old deliveries before provider access', () => {
  assert.equal(validateSessionInputs(env(1), '2026-10-09T22:15:00Z').round, 1);
  assert.equal(validateSessionInputs(env(2), '2026-10-09T22:45:00Z').round, 2);
  for (const [round, now] of [[1, '2026-10-09T22:14:59Z'], [1, '2026-10-09T22:45:00Z'],
    [2, '2026-10-09T22:44:59Z'], [2, '2026-10-09T23:15:00Z'], [2, '2026-10-10T22:45:00Z']]) {
    assert.throws(() => validateSessionInputs(env(round), now));
  }
});

test('partial, forged, disabled or malformed dispatch input never reaches the extractor', async () => {
  for (const patch of [{ CLOSE_UNIFIED_ENABLED: '' }, { CLOSE_ROUND: '3' }, { CLOSE_ROUND: '01' },
    { CLOSE_SESSION_KEY: 'different' }, { CLOSE_TARGET_DATE: '2026-02-30' }, { CLOSE_ROUND: '' }]) {
    let calls = 0;
    await assert.rejects(refreshSessionBenchmark({ env: { ...env(1), ...patch }, now: '2026-10-09T22:15:00Z',
      refreshImpl: async () => { calls++; } }));
    assert.equal(calls, 0);
  }
});

test('a completed exact cache skips the late duplicate fetch', async () => {
  let calls = 0;
  const result = await refreshSessionBenchmark({ env: env(2), now: '2026-10-09T22:45:00Z',
    read: async () => JSON.stringify(cache(target)), refreshImpl: async () => { calls++; } });
  assert.equal(result.completed, true); assert.equal(result.changed, false); assert.equal(calls, 0);
});

test('exit zero with equal stale ETF dates is a failed target, not a successful close', async () => {
  await assert.rejects(refreshSessionBenchmark({ env: env(1), now: '2026-10-09T22:15:00Z',
    read: async () => JSON.stringify(cache('2026-10-08')),
    refreshImpl: async () => ({ changed: false, cache: cache('2026-10-08') }) }), /TARGET_INCOMPLETE/);
});

test('one refresh must validate both target rows before publish can continue', async () => {
  let calls = 0;
  const result = await refreshSessionBenchmark({ env: env(1), now: '2026-10-09T22:15:00Z',
    read: async () => JSON.stringify(cache('2026-10-08')), refreshImpl: async () => {
      calls++; return { changed: true, cache: cache(target) };
    } });
  assert.equal(calls, 1); assert.equal(result.completed, true);
  const partial = cache(target); partial.benchmarks.qqq.series[0].d = '2026-10-08';
  await assert.rejects(refreshSessionBenchmark({ env: env(2), now: '2026-10-09T22:45:00Z',
    read: async () => JSON.stringify(cache('2026-10-08')), refreshImpl: async () => ({ cache: partial }) }), /TARGET_INCOMPLETE/);
});

test('existing standalone/manual invocation retains the original extractor contract', async () => {
  const expected = { changed: false, cache: cache(target) };
  assert.equal(await refreshSessionBenchmark({ env: {}, refreshImpl: async () => expected }), expected);
  assert.equal(validateSessionInputs({}), null);
  assert.throws(() => validateSessionInputs({ CLOSE_UNIFIED_ENABLED: 'true' }), /INPUT/);
});
