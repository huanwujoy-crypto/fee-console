// Preparation-only control contract. No network, notification or financial I/O.
// Runtime adapters must bind run records to the actual session and round.
import { marketOpen } from '../cloud/xuan-preopen/calendar.mjs';

export const CLOSE_TIME_ZONE = 'America/New_York';
export const CLOSE_TIMES = Object.freeze({ first: '18:15', retry: '18:45' });

function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('BENCHMARK_CLOCK_DATE');
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('BENCHMARK_CLOCK_DATE');
  return value;
}

function instant(value) {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error('BENCHMARK_CLOCK_TIME');
  return result;
}

function nyParts(value) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: CLOSE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(value).map(part => [part.type, part.value]));
}

function nyInstant(date, localTime) {
  for (const utcHour of [22, 23]) {
    const candidate = new Date(date + 'T' + utcHour + ':' + localTime.slice(3) + ':00Z');
    const parts = nyParts(candidate);
    if (parts.year + '-' + parts.month + '-' + parts.day === date
        && parts.hour + ':' + parts.minute === localTime) return candidate;
  }
  throw new Error('BENCHMARK_CLOCK_ZONE');
}

export function closeSessionPlan(date, { retryTimeoutMinutes = 30 } = {}) {
  isoDate(date);
  if (!Number.isInteger(retryTimeoutMinutes) || retryTimeoutMinutes < 1 || retryTimeoutMinutes > 120) {
    throw new Error('BENCHMARK_CLOCK_TIMEOUT');
  }
  // Both calendars must have explicit reviewed coverage. Never infer a new year.
  const nyseOpen = marketOpen(date, 'NYSE'), nasdaqOpen = marketOpen(date, 'NASDAQ');
  const open = nyseOpen && nasdaqOpen;
  if (!open) return { targetDate: date, timeZone: CLOSE_TIME_ZONE, open: false, reason: 'MARKET_CLOSED' };
  const first = nyInstant(date, CLOSE_TIMES.first), retry = nyInstant(date, CLOSE_TIMES.retry);
  return {
    targetDate: date, timeZone: CLOSE_TIME_ZONE, open: true,
    firstAt: first.toISOString(), retryAt: retry.toISOString(),
    secondDeadlineAt: new Date(retry.getTime() + retryTimeoutMinutes * 60_000).toISOString(),
    retryTimeoutMinutes,
  };
}

export function benchmarkTargetStatus(cache, targetDate) {
  isoDate(targetDate);
  const rows = [], issues = [];
  if (!cache || cache.v !== 1 || !cache.benchmarks || typeof cache.benchmarks !== 'object') {
    return { targetDate, ready: false, issues: ['BENCHMARK_SCHEMA'], symbols: [] };
  }
  for (const [key, symbol, exchange] of [['spy', 'SPY', 'NYSEArca'], ['qqq', 'QQQ', 'NasdaqGS']]) {
    const item = cache.benchmarks[key];
    if (!item || item.symbol !== symbol || item.currency !== 'USD' || item.exchange !== exchange || !Array.isArray(item.series)) {
      issues.push('BENCHMARK_IDENTITY');
      rows.push({ key, targetRows: 0, ready: false });
      continue;
    }
    const matching = item.series.filter(row => row && row.d === targetDate);
    const point = matching[0];
    const ready = matching.length === 1 && Number.isFinite(point.p) && point.p > 0
      && (point.div === undefined || Number.isFinite(point.div) && point.div >= 0);
    if (!ready) issues.push('BENCHMARK_TARGET_INCOMPLETE');
    rows.push({ key, targetRows: matching.length, ready });
  }
  return { targetDate, ready: rows.every(row => row.ready), issues: [...new Set(issues)], symbols: rows };
}

function bindRun(run, plan, round, time) {
  if (run === null || run === undefined) return null;
  const startedAt = Date.parse(run.createdAt);
  const earliest = Date.parse(round === 1 ? plan.firstAt : plan.retryAt);
  if (run.targetDate !== plan.targetDate || run.round !== round
      || !['queued', 'requested', 'waiting', 'pending', 'in_progress', 'completed'].includes(run.status)
      || !Number.isFinite(startedAt) || startedAt < earliest || startedAt > time
      || startedAt - earliest > 24 * 60 * 60_000) throw new Error('BENCHMARK_RUN_BINDING');
  return run;
}

export function assessBenchmarkSession({
  targetDate, now, cache, firstRun = null, secondRun = null, retryTimeoutMinutes = 30,
}) {
  const plan = closeSessionPlan(targetDate, { retryTimeoutMinutes }), time = instant(now).getTime();
  if (!plan.open) return { ...plan, action: 'NO_ACTION', shouldRetry: false, shouldAlert: false };
  const target = benchmarkTargetStatus(cache, targetDate);
  // Exact validated data decides success. Exit zero or a success label alone never does.
  if (target.ready) return { ...plan, target, action: 'COMPLETE', shouldRetry: false, shouldAlert: false };
  const first = bindRun(firstRun, plan, 1, time), second = bindRun(secondRun, plan, 2, time);
  const firstMissing = !first;
  const base = {
    ...plan, target, firstMissing, shouldRetry: false, shouldAlert: false,
    // Existing adapters must persist/claim these keys; this pure contract sends nothing.
    retryKey: 'benchmark-close:' + targetDate + ':round-2',
    alertKey: 'benchmark-close:' + targetDate + ':two-rounds-incomplete',
  };
  if (time < Date.parse(plan.firstAt)) return { ...base, action: 'WAIT_FIRST_WINDOW' };
  if (second?.status === 'completed') return {
    ...base, action: 'ALERT', shouldAlert: true,
    code: second.conclusion === 'success' ? 'BENCHMARK_SECOND_TARGET_INCOMPLETE' : 'BENCHMARK_SECOND_FAILED',
  };
  if (time >= Date.parse(plan.secondDeadlineAt)) return {
    ...base, action: 'ALERT', shouldAlert: true,
    code: second ? 'BENCHMARK_SECOND_TIMEOUT' : 'BENCHMARK_SECOND_NOT_STARTED',
  };
  if (second) return { ...base, action: 'WAIT_SECOND_RESULT' };
  if (time >= Date.parse(plan.retryAt)) return { ...base, action: 'RETRY_REQUIRED', shouldRetry: true };
  return { ...base, action: first ? 'WAIT_FIRST_RESULT' : 'EXPECT_FIRST_START' };
}
