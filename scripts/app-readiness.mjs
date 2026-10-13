// Observation only. Collect every independent check against an already
// authorized snapshot. Never collect credentials, calculate fees, write a
// registry, start a workflow, or grant publication from this summary.
import { selectBenchmark } from './fee-cloud-source.mjs';
import { resolveStyle } from './fee-style-registry.mjs';
import { isIsoDate } from './daily-core.mjs';

const CHECKS = Object.freeze({
  fee: ['publication', 'benchmark', 'source-identity', 'source-dates',
    'source-stability', 'economic-source', 'cash', 'classification'],
  'ib-live': ['account-association', 'ib-positions', 'ib-orders', 'source-dates',
    'source-stability', 'classification', 'supporting-data', 'publication'],
  'ib-eod': ['account-association', 'flex-archive', 'source-dates',
    'archive-financial-evidence', 'classification', 'sharesight-snapshots', 'optional-live', 'publication'],
});
const CODES = new Set(['READY', 'NOT_CHECKED', 'CHECK_FAILED', 'DEPENDENCY_UNAVAILABLE',
  'BENCHMARK_PENDING', 'BENCHMARK_INVALID', 'CLASSIFICATION_MISSING',
  'CLASSIFICATION_INVALID', 'SOURCE_IDENTITY', 'SOURCE_DATE', 'SOURCE_UNSTABLE',
  'SOURCE_UNAVAILABLE', 'ECONOMIC_SOURCE', 'CASH_RECONCILIATION',
  'ACCOUNT_ASSOCIATION', 'IB_POSITIONS', 'IB_ORDERS', 'SUPPORTING_DATA',
  'PUBLICATION_UNVERIFIED', 'FLEX_ARCHIVE', 'ARCHIVE_FINANCIAL_EVIDENCE',
  'SHARESIGHT_SNAPSHOTS', 'OPTIONAL_LIVE']);
const STATUSES = new Set(['ready', 'blocked', 'unavailable', 'not-checked']);
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const fail = () => { throw new Error('APP_READINESS_INVALID_INPUT'); };

function normalize(result) {
  if (!plain(result) || Object.keys(result).some(k => !['status', 'code', 'missingCount'].includes(k))
      || !STATUSES.has(result.status) || !CODES.has(result.code)
      || (result.status === 'ready') !== (result.code === 'READY')
      || (result.status === 'not-checked') !== (result.code === 'NOT_CHECKED')
      || (Object.hasOwn(result, 'missingCount') && (result.code !== 'CLASSIFICATION_MISSING'
        || !Number.isInteger(result.missingCount) || result.missingCount < 1 || result.missingCount > 2000))) fail();
  return { status: result.status, code: result.code,
    ...(Object.hasOwn(result, 'missingCount') ? { missingCount: result.missingCount } : {}) };
}

export function feeBenchmarkCheck(cache, targetDate) {
  if (!isIsoDate(targetDate)) fail();
  try { selectBenchmark(cache, targetDate); return { status: 'ready', code: 'READY' }; }
  catch (error) { return { status: 'blocked', code: error?.message === 'FEE_CLOUD_BENCHMARK_PENDING'
    ? 'BENCHMARK_PENDING' : 'BENCHMARK_INVALID' }; }
}

export function feeClassificationCheck(snapshot) {
  try { resolveStyle(snapshot); return { status: 'ready', code: 'READY' }; }
  catch (error) {
    const indexes = /^STYLE_MISSING_ROWS_([0-9]+(?:_[0-9]+)*)$/.exec(error?.message || '');
    return indexes ? { status: 'blocked', code: 'CLASSIFICATION_MISSING', missingCount: indexes[1].split('_').length }
      : { status: 'blocked', code: 'CLASSIFICATION_INVALID' };
  }
}

/** Each probe is bounded by its caller's existing read-only timeout and source
 * policy. Sequential collection avoids concurrent sessions/credential reads.
 * A failed check does not suppress unrelated checks. A dependent probe should
 * return unavailable; this collector never invents a substitute snapshot.
 */
export async function collectAppReadiness({ app, profile, targetDate, probes }) {
  if (!Object.hasOwn(CHECKS, profile) || (app === 'fee' ? profile !== 'fee'
      : app !== 'ib' || !['ib-live', 'ib-eod'].includes(profile)) || !isIsoDate(targetDate) || !plain(probes)
      || Object.keys(probes).some(k => !CHECKS[profile].includes(k) || typeof probes[k] !== 'function')) fail();
  const checks = [];
  for (const name of CHECKS[profile]) {
    let result = { status: 'not-checked', code: 'NOT_CHECKED' };
    if (Object.hasOwn(probes, name)) {
      try { result = normalize(await probes[name]()); }
      catch { result = { status: 'blocked', code: 'CHECK_FAILED' }; }
    }
    checks.push({ name, ...result });
  }
  return { schema: 'fee-console.app-readiness.v1', app, profile, targetDate, status: 'observation-only',
    grantsPublication: false, allChecksReady: checks.every(c => c.status === 'ready'), checks,
    unresolvedChecks: checks.filter(c => c.status !== 'ready').map(c => c.name),
    // Fee classification gates the complete candidate. The IB summary does
    // not decide whether a classification is optional: keep its own resolver.
    classificationImpact: app === 'fee' ? 'fee-candidate-requires-original-style-gate'
      : 'use-existing-ib-classification-and-section-gates' };
}
