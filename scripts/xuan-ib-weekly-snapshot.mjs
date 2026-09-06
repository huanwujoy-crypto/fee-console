// Weekly Sharesight snapshot evidence — pure schema, validation, resolution.
//
// Scope decisions baked in (owner + root reviewed, 2026-09-06):
//  - IB stays live every report; this module only concerns the 9 covered
//    Sharesight portfolios that are captured ONCE per Asia/Hong_Kong week.
//  - Monday HKT is the CAPTURE/week key, NOT a valuation date. Each portfolio
//    preserves its native Sharesight report end_date as `valuationDate`; this
//    module never forces or requires a value to equal Monday.
//  - No durable private store is activated. This module performs no I/O of its
//    own; a durable store is injected. With none, resolution fails to the
//    explicit degraded path (DURABLE_CACHE_NOT_ACTIVATED) — never fake
//    persistence, never zero, never invent a snapshot.
//  - A failed Monday refresh keeps the last good snapshot, surfaced as an
//    explicitly dated `stale` result. Week rollover never advances stored dates
//    or erases previously good values.
//  - Weekly cadence does NOT resolve the four-bucket classification audit gap
//    and this module never asserts holdings-completeness beyond shape.
//  - The IB-HK (936247) weekly snapshot is NEVER a live-positions fallback.
import crypto from 'node:crypto';

export const WEEKLY_SNAPSHOT_KIND = 'xuan-ib-weekly-ss-snapshot:v1';
const HKT_OFFSET_MS = 8 * 60 * 60 * 1000;
const HEX64 = /^[a-f0-9]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_RE = /(?:Z|[+-]\d{2}:\d{2})$/i;

const fail = code => { throw Object.assign(new Error(code), { weeklyCode: code }); };
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.getPrototypeOf(v) === Object.prototype;

export function isCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const epoch = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === value;
}
const instantMs = value => {
  if (typeof value !== 'string' || !INSTANT_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};
// Weekday of an HKT calendar date (0=Sun..6=Sat). Date-only ⇒ UTC midnight is safe.
const weekdayOfDate = dateStr => new Date(`${dateStr}T00:00:00Z`).getUTCDay();
export const hktDateOfMs = ms => new Date(ms + HKT_OFFSET_MS).toISOString().slice(0, 10);
export function mondayOfHktDate(dateStr) {
  if (!isCalendarDate(dateStr)) fail('INVALID_DATE');
  const back = (weekdayOfDate(dateStr) + 6) % 7; // days since Monday
  const ms = Date.parse(`${dateStr}T00:00:00Z`) - back * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}
export const mondayOfHktInstant = nowMs => mondayOfHktDate(hktDateOfMs(nowMs));
export const isMondayHkt = dateStr => isCalendarDate(dateStr) && weekdayOfDate(dateStr) === 1;

export const fingerprint = value => crypto.createHash('sha256')
  .update(JSON.stringify(canonical(value))).digest('hex');
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (isPlainObject(v)) return Object.keys(v).sort().reduce((o, k) => (o[k] = canonical(v[k]), o), {});
  return v;
}

const requiredWeeklyIds = registry => {
  if (!registry || !Array.isArray(registry.portfolios)) fail('INVALID_REGISTRY');
  return registry.portfolios.filter(p => p.requiredEachReport === true);
};

// Structural + scope validation. Never advances dates and never forces Monday
// as a valuation date. `now` bounds "not in the future" checks only.
export function validateWeeklySnapshot(snapshot, registry, { nowMs = Date.now() } = {}) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 8.64e15 - HKT_OFFSET_MS) fail('INVALID_CLOCK');
  if (!isPlainObject(snapshot)) fail('INVALID_SNAPSHOT');
  const keys = Object.keys(snapshot).sort().join(',');
  if (keys !== 'captureWeekOfMondayHkt,capturedAt,kind,portfolios,schemaVersion') fail('INVALID_SNAPSHOT_KEYS');
  if (snapshot.schemaVersion !== 1 || snapshot.kind !== WEEKLY_SNAPSHOT_KIND) fail('INVALID_SNAPSHOT_VERSION');
  if (!isMondayHkt(snapshot.captureWeekOfMondayHkt)) fail('WEEK_KEY_NOT_MONDAY_HKT');
  const capturedMs = instantMs(snapshot.capturedAt);
  if (capturedMs === null) fail('INVALID_CAPTURED_AT');
  if (capturedMs > nowMs) fail('CAPTURED_AT_IN_FUTURE');
  // Captured during (or after the start of) its own week; never before Monday.
  const capturedHktDate = hktDateOfMs(capturedMs);
  if (capturedHktDate < snapshot.captureWeekOfMondayHkt) fail('CAPTURED_BEFORE_WEEK');
  if (mondayOfHktInstant(capturedMs) !== snapshot.captureWeekOfMondayHkt) fail('CAPTURE_WEEK_MISMATCH');

  const required = requiredWeeklyIds(registry);
  const byId = new Map(required.map(p => [p.portfolioId, p]));
  if (!Array.isArray(snapshot.portfolios)) fail('INVALID_PORTFOLIOS');
  const seen = new Set();
  for (const [i, entry] of snapshot.portfolios.entries()) {
    const label = `portfolios[${i}]`;
    if (!isPlainObject(entry)
      || Object.keys(entry).sort().join(',') !== 'fingerprint,portfolioId,readCompletedAt,role,status,valuationDate') {
      fail(`${label}_KEYS`);
    }
    if (!Number.isSafeInteger(entry.portfolioId) || !byId.has(entry.portfolioId)) fail(`${label}_UNEXPECTED_PORTFOLIO`);
    if (seen.has(entry.portfolioId)) fail(`${label}_DUPLICATE`);
    seen.add(entry.portfolioId);
    if (entry.role !== byId.get(entry.portfolioId).role) fail(`${label}_ROLE_MISMATCH`);
    if (entry.status !== 'ok') fail(`${label}_STATUS`);
    if (typeof entry.fingerprint !== 'string' || !HEX64.test(entry.fingerprint)) fail(`${label}_FINGERPRINT`);
    const readMs = instantMs(entry.readCompletedAt);
    if (readMs === null || readMs > nowMs) fail(`${label}_READ_TIME`);
    if (readMs > capturedMs || mondayOfHktInstant(readMs) !== snapshot.captureWeekOfMondayHkt) fail('READ_CAPTURE_CHRONOLOGY');
    // valuationDate is the native Sharesight end_date: any real calendar date,
    // not forced to Monday, not in the future. Could legitimately be a Friday.
    if (!isCalendarDate(entry.valuationDate)) fail(`${label}_VALUATION_DATE`);
    if (entry.valuationDate > capturedHktDate) fail(`${label}_VALUATION_IN_FUTURE`);
    if (entry.valuationDate > hktDateOfMs(readMs)) fail('VALUATION_AFTER_READ');
  }
  // Partial snapshots are never complete: every required weekly portfolio present.
  if (seen.size !== required.length) fail('SNAPSHOT_INCOMPLETE');
  return snapshot;
}

// Public allowlist: metadata only. A valid envelope does NOT activate use of
// financial values or attest raw-source authenticity. No paths or raw errors.
const WEEKLY_REASONS = new Set(['DURABLE_CACHE_NOT_ACTIVATED', 'SNAPSHOT_MISSING', 'INVALID_SNAPSHOT']);
export const WEEKLY_STAGE_ERROR = 'SHARESIGHT_WEEKLY_MODE';
export const isWeeklyMode = sources => Object.hasOwn(sources ?? {}, 'sharesightWeekly');
export const isWeeklyStage = stage => stage?.status === 'degraded'
  && stage.cacheHit === false && stage.errorCode === WEEKLY_STAGE_ERROR;

export function validateWeeklyEvidence(evidence, registry, nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 8.64e15 - HKT_OFFSET_MS) fail('INVALID_CLOCK');
  if (!isPlainObject(evidence) || evidence.schemaVersion !== 1) fail('INVALID_WEEKLY_EVIDENCE');
  const keys = Object.keys(evidence).sort().join(',');
  if (evidence.status === 'unavailable') {
    if (keys !== 'reason,schemaVersion,status' || !WEEKLY_REASONS.has(evidence.reason)) fail('INVALID_WEEKLY_REASON');
    return { status: 'unavailable', reason: evidence.reason };
  }
  if (evidence.status !== 'metadata-only' || keys !== 'schemaVersion,snapshot,status') fail('INVALID_WEEKLY_EVIDENCE');
  validateWeeklySnapshot(evidence.snapshot, registry, { nowMs });
  return resolveWeeklySnapshot(registry, { nowMs, store: { loadLatest: () => evidence.snapshot } });
}

// Production-time monotonic guard: a newer snapshot must key to a strictly later
// Monday. Reuse never calls this; rollover never rewrites an older snapshot.
export function assertWeekAdvances(previous, next) {
  if (previous == null) return next;
  if (!isMondayHkt(previous.captureWeekOfMondayHkt) || !isMondayHkt(next.captureWeekOfMondayHkt)) fail('WEEK_KEY_NOT_MONDAY_HKT');
  if (!(next.captureWeekOfMondayHkt > previous.captureWeekOfMondayHkt)) fail('WEEK_NOT_ADVANCED');
  return next;
}

// Resolve the snapshot to use for a report at `nowMs`. `store.loadLatest()` (when
// provided) returns the newest good snapshot object or null. No store ⇒ the
// durable cache is not activated and callers take the degraded SS path.
export function resolveWeeklySnapshot(registry, { nowMs = Date.now(), store = null } = {}) {
  if (!store || typeof store.loadLatest !== 'function') {
    return { status: 'unavailable', reason: 'DURABLE_CACHE_NOT_ACTIVATED' };
  }
  let latest;
  try { latest = store.loadLatest(); } catch { return { status: 'unavailable', reason: 'STORE_READ_FAILED' }; }
  if (latest == null) return { status: 'unavailable', reason: 'SNAPSHOT_MISSING' };
  try { validateWeeklySnapshot(latest, registry, { nowMs }); }
  catch (e) { return { status: 'unavailable', reason: e.weeklyCode || 'INVALID_SNAPSHOT' }; }

  const currentMonday = mondayOfHktInstant(nowMs);
  const week = latest.captureWeekOfMondayHkt;
  // Dates are surfaced verbatim from the stored snapshot; never advanced here.
  const view = {
    captureWeekOfMondayHkt: week,
    capturedAt: latest.capturedAt,
    portfolios: latest.portfolios.map(p => ({
      portfolioId: p.portfolioId, role: p.role,
      readCompletedAt: p.readCompletedAt, valuationDate: p.valuationDate,
      fingerprint: p.fingerprint
    }))
  };
  if (week === currentMonday) return { status: 'current', ...view };
  if (week < currentMonday) return { status: 'stale', currentMonday, ...view };
  return { status: 'unavailable', reason: 'SNAPSHOT_FUTURE_WEEK' };
}
