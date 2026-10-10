import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSessionPlan, benchmarkTargetStatus, assessBenchmarkSession } from './benchmark-close-contract.mjs';

const DAY = '2026-10-09';
function cache(spyDate = DAY, qqqDate = DAY) {
  return { v: 1, benchmarks: {
    spy: { symbol: 'SPY', currency: 'USD', exchange: 'NYSEArca', series: [{ d: spyDate, p: 100 }] },
    qqq: { symbol: 'QQQ', currency: 'USD', exchange: 'NasdaqGS', series: [{ d: qqqDate, p: 200 }] },
  } };
}
function run(round, status = 'completed', conclusion = 'success') {
  return { targetDate: DAY, round, status, conclusion,
    createdAt: round === 1 ? '2026-10-09T22:16:00Z' : '2026-10-09T22:45:01Z' };
}
function assess(now, extra = {}) {
  return assessBenchmarkSession({ targetDate: DAY, now, cache: cache('2026-10-08', '2026-10-08'), ...extra });
}

test('summer Friday session starts on Saturday 06:15 HKT and retries 06:45', () => {
  const plan = closeSessionPlan(DAY);
  assert.equal(plan.firstAt, '2026-10-09T22:15:00.000Z');
  assert.equal(plan.retryAt, '2026-10-09T22:45:00.000Z');
  assert.equal(plan.secondDeadlineAt, '2026-10-09T23:15:00.000Z');
});
test('winter uses NY 18:15 rather than a fixed Hong Kong time', () => {
  assert.equal(closeSessionPlan('2026-01-02').firstAt, '2026-01-02T23:15:00.000Z');
  assert.equal(closeSessionPlan('2026-01-02').retryAt, '2026-01-02T23:45:00.000Z');
});
test('both DST transition weeks choose the correct UTC hour', () => {
  assert.equal(closeSessionPlan('2026-03-09').firstAt, '2026-03-09T22:15:00.000Z');
  assert.equal(closeSessionPlan('2026-11-02').firstAt, '2026-11-02T23:15:00.000Z');
});
test('US Saturday and reviewed exchange holidays make no attempt', () => {
  for (const date of ['2026-10-10', '2026-06-19', '2026-11-26']) assert.equal(closeSessionPlan(date).open, false);
  assert.equal(closeSessionPlan('2026-11-27').open, true);
});
test('unsupported calendar years fail closed and malformed dates are rejected', () => {
  assert.throws(() => closeSessionPlan('2029-01-02'), /OFFICIAL_CALENDAR_UNAVAILABLE/);
  assert.throws(() => closeSessionPlan('2027-01-01'), /OFFICIAL_CALENDAR_UNAVAILABLE/);
  assert.throws(() => closeSessionPlan('2026-02-30'), /BENCHMARK_CLOCK_DATE/);
});
test('retry deadline is explicit and bounded', () => {
  assert.equal(closeSessionPlan(DAY, { retryTimeoutMinutes: 5 }).secondDeadlineAt, '2026-10-09T22:50:00.000Z');
  for (const value of [0, 121, 1.5]) assert.throws(() => closeSessionPlan(DAY, { retryTimeoutMinutes: value }), /TIMEOUT/);
});
test('only valid rows for both exact instruments and target date are complete', () => {
  assert.equal(benchmarkTargetStatus(cache(), DAY).ready, true);
  assert.equal(benchmarkTargetStatus(cache('2026-10-08', '2026-10-08'), DAY).ready, false);
  assert.equal(benchmarkTargetStatus(cache(DAY, '2026-10-08'), DAY).ready, false);
  const wrong = cache(); wrong.benchmarks.spy.symbol = 'OTHER';
  assert.equal(benchmarkTargetStatus(wrong, DAY).ready, false);
});
test('duplicate, invalid-price and invalid-dividend rows cannot be called complete', () => {
  const duplicate = cache(); duplicate.benchmarks.spy.series.push({ d: DAY, p: 100 });
  assert.equal(benchmarkTargetStatus(duplicate, DAY).ready, false);
  for (const p of [0, NaN, Infinity]) {
    const value = cache(); value.benchmarks.qqq.series[0].p = p;
    assert.equal(benchmarkTargetStatus(value, DAY).ready, false);
  }
  const value = cache(); value.benchmarks.spy.series[0].div = -1;
  assert.equal(benchmarkTargetStatus(value, DAY).ready, false);
});
test('no source retry is requested before the first window', () => {
  const result = assess('2026-10-09T22:14:59Z');
  assert.equal(result.action, 'WAIT_FIRST_WINDOW');
  assert.equal(result.shouldRetry, false);
});
test('a missing first start is detected at the 18:45 check and needs the second round', () => {
  const result = assess('2026-10-09T22:45:00Z');
  assert.equal(result.firstMissing, true);
  assert.equal(result.action, 'RETRY_REQUIRED');
  assert.equal(result.shouldRetry, true);
  assert.equal(result.shouldAlert, false);
});
test('first exit-zero with old dates still needs a retry', () => {
  const result = assess('2026-10-09T22:45:00Z', { firstRun: run(1) });
  assert.equal(result.firstMissing, false);
  assert.equal(result.shouldRetry, true);
});
test('successful target data suppresses retries even if a redundant run failed', () => {
  const result = assess('2026-10-09T23:30:00Z', { cache: cache(), firstRun: run(1), secondRun: run(2, 'completed', 'failure') });
  assert.equal(result.action, 'COMPLETE');
  assert.equal(result.shouldRetry, false);
  assert.equal(result.shouldAlert, false);
});
test('a queued or running second round is not repeated before its deadline', () => {
  for (const status of ['queued', 'in_progress']) {
    const result = assess('2026-10-09T22:50:00Z', { secondRun: run(2, status, null) });
    assert.equal(result.action, 'WAIT_SECOND_RESULT');
    assert.equal(result.shouldRetry, false);
  }
});
test('second failure alerts immediately and old data cannot hide behind success', () => {
  assert.equal(assess('2026-10-09T22:47:00Z', { secondRun: run(2, 'completed', 'failure') }).code, 'BENCHMARK_SECOND_FAILED');
  assert.equal(assess('2026-10-09T22:47:00Z', { secondRun: run(2) }).code, 'BENCHMARK_SECOND_TARGET_INCOMPLETE');
});
test('second missing start or timeout alerts at the explicit deadline', () => {
  assert.equal(assess('2026-10-09T23:15:00Z').code, 'BENCHMARK_SECOND_NOT_STARTED');
  assert.equal(assess('2026-10-09T23:15:00Z', { secondRun: run(2, 'in_progress', null) }).code, 'BENCHMARK_SECOND_TIMEOUT');
});
test('wrong-session or wrong-round records do not suppress a needed retry', () => {
  assert.throws(() => assess('2026-10-09T22:45:00Z', { secondRun: { ...run(2), targetDate: '2026-10-08' } }), /RUN_BINDING/);
  assert.throws(() => assess('2026-10-09T22:45:00Z', { secondRun: run(1) }), /RUN_BINDING/);
});
test('old or future start timestamps cannot claim the current second round', () => {
  assert.throws(() => assess('2026-10-09T22:50:00Z', {
    secondRun: { ...run(2), createdAt: '2026-10-08T22:45:00Z' },
  }), /RUN_BINDING/);
  assert.throws(() => assess('2026-10-09T22:50:00Z', {
    secondRun: { ...run(2), createdAt: '2026-10-09T23:00:00Z' },
  }), /RUN_BINDING/);
});
test('repeated checks have stable per-session retry and alarm keys', () => {
  const retry = assess('2026-10-09T22:45:00Z'), later = assess('2026-10-09T22:46:00Z');
  assert.equal(retry.retryKey, later.retryKey);
  const absent = assess('2026-10-09T23:15:00Z');
  const failed = assess('2026-10-09T23:16:00Z', { secondRun: run(2, 'completed', 'failure') });
  assert.equal(absent.alertKey, failed.alertKey);
  assert.equal(assess('2026-10-09T23:16:00Z', { cache: cache() }).shouldAlert, false);
});
test('market closure makes no refresh, retry or alarm even with no run', () => {
  const result = assessBenchmarkSession({ targetDate: '2026-10-10', now: '2026-10-10T23:15:00Z', cache: {} });
  assert.equal(result.action, 'NO_ACTION');
  assert.equal(result.shouldRetry, false);
  assert.equal(result.shouldAlert, false);
});
