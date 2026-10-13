// Pure incident/retry decisions for an external observer. These functions do
// not fetch runs, send notifications, persist state, dispatch, or close issues.
import { isIsoDate } from './daily-core.mjs';

const TRANSIENT = new Set(['FEE_CLOUD_SOURCE_UNAVAILABLE', 'FEE_CLOUD_SOURCE_UNSTABLE',
  'FEE_CLOUD_AUTH_UNAVAILABLE', 'SOURCE_NETWORK', 'SOURCE_TIMEOUT', 'SOURCE_CHANGED']);
const BLOCKERS = new Set(['CLASSIFICATION_MISSING', 'CLASSIFICATION_INVALID',
  'CASH_RECONCILIATION', 'SOURCE_IDENTITY', 'SOURCE_DATE', 'ECONOMIC_SOURCE',
  'ACCOUNT_ASSOCIATION', 'IB_POSITIONS', 'IB_ORDERS', 'BENCHMARK_PENDING', 'BENCHMARK_INVALID']);
const OUTCOMES = new Set(['failure', 'timed-out', 'cancelled', 'skipped', 'candidate', 'reused']);
const STATES = new Set(['queued', 'in-progress', 'completed']);
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const fail = () => { throw new Error('APP_RUN_DIAGNOSTIC_INVALID_INPUT'); };
const exact = (v, keys) => {
  if (!plain(v) || Reflect.ownKeys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) fail();
};
const instant = v => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
      || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail();
  return Date.parse(v);
};

export function sourceRetryDecision(code, attempt) {
  if (typeof code !== 'string' || !Number.isInteger(attempt) || attempt < 1 || attempt > 2) fail();
  return { action: TRANSIENT.has(code) && attempt === 1 ? 'retry-once' : 'stop',
    maxAttempts: 2, requiresExistingReadAuthorization: true };
}

// Coarse public producer codes cannot prove a missing row. In particular the
// historical STYLE code is classification-invalid, never invented missing IDs.
export function feeDiagnosticCode(code) {
  if (typeof code !== 'string' || code.length > 128) return 'UNKNOWN';
  if (TRANSIENT.has(code)) return code;
  const fixed = {
    FEE_CLOUD_CASH_RECONCILIATION: 'CASH_RECONCILIATION',
    FEE_CLOUD_WRITER_PREFLIGHT_CASH_RECONCILIATION: 'CASH_RECONCILIATION',
    FEE_CLOUD_WRITER_CASH_RECONCILIATION: 'CASH_RECONCILIATION',
    FEE_CLOUD_BENCHMARK_PENDING: 'BENCHMARK_PENDING',
    FEE_CLOUD_BENCHMARK_SCHEMA: 'BENCHMARK_INVALID',
    FEE_CLOUD_SOURCE_IDENTITY: 'SOURCE_IDENTITY',
    FEE_CLOUD_SOURCE_DATE: 'SOURCE_DATE',
    FEE_CLOUD_ECON_VERSION: 'ECONOMIC_SOURCE',
  };
  if (Object.hasOwn(fixed, code)) return fixed[code];
  if (/^FEE_CLOUD_WRITER_(?:PREFLIGHT_)?STYLE(?:_[A-Z0-9_]+)?$/.test(code)) return 'CLASSIFICATION_INVALID';
  return 'UNKNOWN';
}

/** `coverage` describes an upstream observer's complete target/window listing,
 * not a proof supplied by GitHub or by this helper. A receipt is never inferred
 * from a green candidate, skip, or reuse: the caller must independently verify
 * existing public bytes/receipt under the unchanged application contract.
 */
export function diagnoseAppRun(input) {
  exact(input, ['app', 'targetDate', 'scheduledAt', 'deadlineAt', 'now', 'coverage',
    'runs', 'publicationVerified', 'previousAlert']);
  if (!['fee', 'ib'].includes(input.app) || !isIsoDate(input.targetDate)
      || !['complete', 'unavailable'].includes(input.coverage)
      || typeof input.publicationVerified !== 'boolean' || !Array.isArray(input.runs)
      || input.runs.length > 100) fail();
  const scheduled = instant(input.scheduledAt), deadline = instant(input.deadlineAt), now = instant(input.now);
  if (deadline <= scheduled) fail();
  const key = `${input.app}:${input.targetDate}`;
  if (input.previousAlert !== null) {
    exact(input.previousAlert, ['key', 'reason']);
    if (input.previousAlert.key !== key || !['not-started', 'queued-late', 'in-progress-late',
      'blocked', 'second-failure', 'publication-unverified', 'observation-unavailable'].includes(input.previousAlert.reason)) fail();
  }
  const ids = new Set();
  const runs = input.runs.map(r => {
    exact(r, ['id', 'attempt', 'targetDate', 'attemptAt', 'status', 'outcome', 'code']);
    if (!Number.isSafeInteger(r.id) || r.id <= 0 || !Number.isSafeInteger(r.attempt) || r.attempt < 1
        || r.targetDate !== input.targetDate || !STATES.has(r.status)
        || (r.status === 'completed' ? !OUTCOMES.has(r.outcome) : r.outcome !== null)
        || (r.code !== null && !TRANSIENT.has(r.code) && !BLOCKERS.has(r.code) && r.code !== 'UNKNOWN')) fail();
    const time = instant(r.attemptAt), identity = `${r.id}:${r.attempt}`;
    if (time < scheduled || time > now || ids.has(identity)) fail();
    ids.add(identity);
    return { ...r, time };
  }).sort((a, b) => b.time - a.time || b.id - a.id || b.attempt - a.attempt);
  let state, reason = null;
  if (input.publicationVerified) state = 'published';
  else if (input.coverage !== 'complete') {
    state = 'observation-unavailable'; if (now >= deadline) reason = state;
  } else {
    const latest = runs[0];
    const failures = runs.filter(r => r.status === 'completed'
      && ['failure', 'timed-out'].includes(r.outcome));
    const unresolvedReason = failures.some(r => BLOCKERS.has(r.code)) ? 'blocked'
      : failures.length >= 2 ? 'second-failure' : null;
    if (!latest) { state = now < scheduled ? 'not-due' : 'not-started'; if (now >= deadline) reason = 'not-started'; }
    else if (latest.status !== 'completed') {
      state = latest.status; reason = unresolvedReason;
      if (reason === null && now >= deadline) reason = `${state}-late`;
    } else {
      state = latest.outcome;
      reason = unresolvedReason;
      if (reason === null && now >= deadline) reason = 'publication-unverified';
    }
  }
  return { schema: 'fee-console.app-run-diagnostic.v1', status: 'observation-only',
    app: input.app, targetDate: input.targetDate, state, reason, alertKey: reason ? key : null,
    alertAction: reason === null ? 'none' : input.previousAlert === null ? 'create'
      : input.previousAlert.reason === reason ? 'none' : 'update',
    closesExistingAlert: false, dispatchesProduction: false };
}
