// Deterministic daily-change column for the XUAN-IB holdings table.
//
// This module is the single supported entry point for the "日涨跌" column. It
// is pure: no API calls, no clock reads, no classification, no trading. Every
// row is either a number this run can stand behind or an explicit unavailable
// with a machine-readable reason. It never emits 0 as a substitute for missing
// data, and it degrades per row instead of throwing away a whole column.
//
// Two supported measurement methods, both fed from reads the run already has:
//   window-v1  a single-session performance window from the portfolio source,
//              which carries its own session date.
//   session-pnl-v1
//              the session profit and loss carried inside the same positions
//              payload, usable only with per-row session evidence.
// Which method an edition may use is a caller decision recorded in the runtime
// contract; this module refuses either one whose evidence is incomplete.
const fail = code => { throw new Error(`Daily change: ${code}`); };
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const num = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const DAILY_CHANGE_METHODS = Object.freeze(['window-v1', 'session-pnl-v1']);
// Display keeps two decimals, so the stored value keeps four and no more: a
// wider float would imply a precision the sources do not publish.
const round4 = value => Number(value.toFixed(4));

export const UNAVAILABLE_REASONS = Object.freeze({
  TRADED: 'traded-in-window',
  FLAT_OR_STALE: 'flat-or-stale-indistinguishable',
  CORPORATE_ACTION: 'corporate-action-unadjusted',
  OUTLIER: 'outlier-beyond-guard',
  MALFORMED: 'row-malformed',
  IDENTITY: 'identity-unresolved',
  AMBIGUOUS: 'identity-ambiguous',
  SESSION: 'session-not-proven',
  NO_INPUT: 'source-field-absent',
});

// Alias handling is explicit and versioned, never a fuzzy match. IB writes
// `BRK B`, the portfolio source writes `BRK/B`; both must resolve to one key
// or the row is dropped rather than silently paired with the wrong venue.
export function canonicalCode(code) {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) return null;
  return trimmed.replace(/[\s/_-]+/g, '.');
}

// A key is venue-scoped on purpose: the same ticker legitimately exists on
// more than one exchange, and a code-only map would write one venue's move
// onto another while still reporting quoteStatus ok.
export function identityKey({ venue = null, code = null } = {}) {
  const canonical = canonicalCode(code);
  if (typeof venue !== 'string' || !venue.trim() || !canonical) return null;
  return `${venue.trim().toUpperCase()}:${canonical}`;
}

function indexByKey(entries, label) {
  const byKey = new Map(), ambiguous = new Set();
  for (const entry of entries) {
    const key = entry.key;
    if (key === null) continue;
    if (byKey.has(key)) { ambiguous.add(key); continue; }
    byKey.set(key, entry);
  }
  if (ambiguous.size && label === 'measurement') {
    // Duplicates inside one measurement set cannot be resolved by preferring
    // either copy, so both are marked and neither is published.
    for (const key of ambiguous) byKey.delete(key);
  }
  return { byKey, ambiguous };
}

function readMeasurement(raw) {
  if (!plain(raw)) return { key: null, malformed: true };
  const key = identityKey({ venue: raw.venue, code: raw.code });
  const ok = num(raw.changePct) && (raw.currencyChangePct === null || num(raw.currencyChangePct));
  if (!key || !ok) return { key, malformed: true, raw };
  return { key, malformed: false, raw };
}

// The session a measurement belongs to must be proven for that row, not
// asserted once for the whole report: an upstream book rolls its session per
// instrument and per venue, so one boolean cannot cover a portfolio spanning
// several exchanges, and a schedule anchored to a fixed offset drifts against
// the venue's own calendar when its daylight-saving rule changes.
function sessionProven(row, intendedSessionDate) {
  if (!DATE.test(String(row.sessionDate || ''))) return false;
  if (row.sessionDate !== intendedSessionDate) return false;
  return row.sessionComplete === true;
}

export function buildDailyChangeColumn({
  method = null,
  intendedSessionDate = null,
  measurements = null,
  trades = [],
  corporateActions = [],
  outlierPct = 100,
} = {}) {
  if (!DAILY_CHANGE_METHODS.includes(method)) fail('UNKNOWN_METHOD');
  if (!DATE.test(String(intendedSessionDate || ''))) fail('INVALID_SESSION_DATE');
  if (!Array.isArray(measurements) || measurements.length > 10_000) fail('INVALID_MEASUREMENTS');
  if (!Array.isArray(trades) || !Array.isArray(corporateActions)) fail('INVALID_EVENT_INPUT');
  if (!num(outlierPct) || outlierPct <= 0) fail('INVALID_OUTLIER_GUARD');

  const parsed = measurements.map(readMeasurement);
  const { byKey, ambiguous } = indexByKey(parsed, 'measurement');

  // Events are venue-scoped too. A trade or corporate action whose identity
  // cannot be resolved is retained as an unresolved marker: it must be able to
  // suppress a row, never to be silently ignored because its key did not map.
  const tradedKeys = new Set(), unresolvedEvents = [];
  for (const trade of trades) {
    const key = plain(trade) ? identityKey({ venue: trade.venue, code: trade.code }) : null;
    if (key === null) { unresolvedEvents.push('trade'); continue; }
    tradedKeys.add(key);
  }
  const actionKeys = new Set();
  for (const action of corporateActions) {
    const key = plain(action) ? identityKey({ venue: action.venue, code: action.code }) : null;
    if (key === null) { unresolvedEvents.push('corporate-action'); continue; }
    actionKeys.add(key);
  }

  const rows = parsed.map(entry => {
    const identity = entry.key;
    const base = {
      key: identity, changePct: null, currencyChangePct: null,
      quoteStatus: 'unavailable', reason: null, sessionDate: null,
    };
    if (identity === null || entry.malformed) {
      return { ...base, reason: identity === null ? UNAVAILABLE_REASONS.IDENTITY : UNAVAILABLE_REASONS.MALFORMED };
    }
    if (ambiguous.has(identity) || !byKey.has(identity)) {
      return { ...base, reason: UNAVAILABLE_REASONS.AMBIGUOUS };
    }
    const raw = entry.raw;
    if (!sessionProven(raw, intendedSessionDate)) return { ...base, reason: UNAVAILABLE_REASONS.SESSION };
    if (tradedKeys.has(identity)) return { ...base, sessionDate: raw.sessionDate, reason: UNAVAILABLE_REASONS.TRADED };
    // A corporate action moves the raw price without moving the holder's
    // economics. The magnitude guard below is an outlier trap, not a detector:
    // an unadjusted 2-for-1 split reads as about -50% and would pass it.
    if (actionKeys.has(identity)) return { ...base, sessionDate: raw.sessionDate, reason: UNAVAILABLE_REASONS.CORPORATE_ACTION };
    // Exactly zero cannot be told apart from a price the source carried
    // forward for a session it has not loaded, and that ambiguity is per row:
    // a portfolio-wide check misses the case where only some venues are stale.
    // Losing a genuinely flat row is the safe direction.
    if (raw.changePct === 0) return { ...base, sessionDate: raw.sessionDate, reason: UNAVAILABLE_REASONS.FLAT_OR_STALE };
    if (Math.abs(raw.changePct) > outlierPct) return { ...base, sessionDate: raw.sessionDate, reason: UNAVAILABLE_REASONS.OUTLIER };
    return {
      key: identity, changePct: round4(raw.changePct),
      currencyChangePct: raw.currencyChangePct === null ? null : round4(raw.currencyChangePct),
      quoteStatus: 'ok', reason: null, sessionDate: raw.sessionDate,
    };
  });

  const available = rows.filter(row => row.quoteStatus === 'ok').length;
  const reasons = {};
  for (const row of rows) if (row.reason) reasons[row.reason] = (reasons[row.reason] || 0) + 1;
  return {
    method, intendedSessionDate, rows,
    coverage: { available, total: rows.length, reasons },
    unresolvedEvents: unresolvedEvents.length,
  };
}

// Merge a built column onto view holding rows. The merge is identity-keyed,
// never positional and never by bare ticker, so a row whose identity does not
// resolve keeps its unavailable state instead of inheriting a neighbour's
// move. Passing `column: null` leaves every row exactly as it was, which is
// the no-regression path for a generator that has no measurement source.
export function applyDailyChangeColumn(rows, column, { venueOf = null } = {}) {
  if (!Array.isArray(rows)) fail('INVALID_VIEW_ROWS');
  if (column === null) return rows.map(row => ({ ...row }));
  if (!plain(column) || !Array.isArray(column.rows) || !DAILY_CHANGE_METHODS.includes(column.method)) fail('INVALID_COLUMN');
  const byKey = new Map();
  for (const row of column.rows) if (row.key !== null && row.quoteStatus === 'ok') byKey.set(row.key, row);
  return rows.map(row => {
    const key = typeof venueOf === 'function'
      ? identityKey({ venue: venueOf(row), code: row.symbol })
      : identityKey({ venue: row.market, code: row.symbol });
    const hit = key === null ? null : byKey.get(key) ?? null;
    if (hit === null) {
      return { ...row, changePct: null, changeAsOfHkt: null, quoteStatus: 'unavailable' };
    }
    return {
      ...row, changePct: hit.changePct, quoteStatus: 'ok',
      // The label is the session the number belongs to, never the moment the
      // report happened to read it: an AM column carries a completed session's
      // move and must not be described as an 08:00 reading.
      changeAsOfHkt: hit.sessionDate,
      changeMethod: column.method, changeSessionDate: hit.sessionDate,
    };
  });
}
