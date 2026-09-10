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
//              which carries its own session date and reports a completed
//              trading day.
//   session-pnl-v1
//              the session profit and loss carried inside the same positions
//              payload, read while the session is still running, usable only
//              with per-row session evidence, a self-consistent
//              mark/value/quantity triple and the instant it was taken.
// Which method an edition may use is fixed below, not left to the caller.
const fail = code => { throw new Error(`Daily change: ${code}`); };
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const num = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// A calendar date, not merely a well-shaped string: `2026-02-31` matches the
// pattern and would otherwise silently shift the session by a day.
const realDate = value => DATE.test(String(value ?? ''))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
// A completed session is labelled with its date; an intraday reading must name
// the minute it was taken, because two readings of one instrument inside the
// same session legitimately differ and must never be reconciled into one
// number or presented as the session's result.
const INSTANT = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}) HKT$/;

export const DAILY_CHANGE_METHODS = Object.freeze(['window-v1', 'session-pnl-v1']);
// Display keeps two decimals, so the stored value keeps four and no more: a
// wider float would imply a precision the sources do not publish.
const round4 = value => Number(value.toFixed(4));

// What each method has to prove per row before a number may be published.
export const DAILY_CHANGE_METHOD_RULES = Object.freeze({
  'window-v1': Object.freeze({ phases: Object.freeze(['complete']), label: 'session-date', proveMark: false }),
  // The running session is read out of the positions payload the report
  // already holds, so `mark * quantity` must reproduce that payload's own
  // market value before its session P&L may be turned into a percentage.
  'session-pnl-v1': Object.freeze({ phases: Object.freeze(['open', 'complete']), label: 'instant', proveMark: true }),
});

// Which edition may publish which method, and the only session date it may
// label. AM reports a finished trading day, so it keeps the dated window. PM
// runs while New York is open and reads the intraday move from the same
// positions payload; it may not borrow the window, whose intraday behaviour
// has not been measured. `lagDays` counts back from the report's own Hong Kong
// data date. The retired ad-hoc edition has no measured column at all.
export const DAILY_CHANGE_EDITION_RULES = Object.freeze({
  am: Object.freeze({ methods: Object.freeze(['window-v1']), lagDays: 1 }),
  pm: Object.freeze({ methods: Object.freeze(['session-pnl-v1']), lagDays: 0 }),
});
const editionRule = edition => typeof edition === 'string'
  && Object.hasOwn(DAILY_CHANGE_EDITION_RULES, edition) ? DAILY_CHANGE_EDITION_RULES[edition] : null;

export const UNAVAILABLE_REASONS = Object.freeze({
  TRADED: 'traded-in-window',
  FLAT_OR_STALE: 'flat-or-stale-indistinguishable',
  CORPORATE_ACTION: 'corporate-action-unadjusted',
  OUTLIER: 'outlier-beyond-guard',
  MALFORMED: 'row-malformed',
  IDENTITY: 'identity-unresolved',
  AMBIGUOUS: 'identity-ambiguous',
  SESSION: 'session-not-proven',
  INSTANT: 'observation-instant-unproven',
  MARK: 'mark-value-quantity-unproven',
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

// The evidence a measurement needs must be proven for that row, not asserted
// once for the whole report: an upstream book rolls its session per instrument
// and per venue, so one flag cannot cover a portfolio spanning several
// exchanges, and a schedule anchored to a fixed offset drifts against the
// venue's own calendar when its daylight-saving rule changes.
function evidenceReason(row, rules, intendedSessionDate) {
  if (row.sessionDate !== intendedSessionDate || !rules.phases.includes(row.sessionPhase)) {
    return UNAVAILABLE_REASONS.SESSION;
  }
  // A reading taken inside a running session means nothing without the minute
  // it belongs to, and that minute must fall on the session it reports: a run
  // that slips onto the next Hong Kong date loses the column rather than
  // publishing an instant labelled with someone else's session.
  if (rules.label === 'instant') {
    const match = INSTANT.exec(String(row.observedAtHkt ?? ''));
    if (!match || match[1] !== row.sessionDate
      || Number(match[2]) > 23 || Number(match[3]) > 59) return UNAVAILABLE_REASONS.INSTANT;
  }
  if (rules.proveMark && row.markReconciled !== true) return UNAVAILABLE_REASONS.MARK;
  return null;
}

export function buildDailyChangeColumn({
  edition = null,
  method = null,
  dataDate = null,
  intendedSessionDate = null,
  measurements = null,
  trades = [],
  corporateActions = [],
  outlierPct = 100,
} = {}) {
  if (!DAILY_CHANGE_METHODS.includes(method)) fail('UNKNOWN_METHOD');
  const rule = editionRule(edition);
  // The retired ad-hoc edition, and anything else, has no measured column.
  if (rule === null) fail('UNKNOWN_EDITION');
  if (!rule.methods.includes(method)) fail('METHOD_NOT_APPROVED_FOR_EDITION');
  const rules = DAILY_CHANGE_METHOD_RULES[method];
  if (!realDate(intendedSessionDate) || !realDate(dataDate)) fail('INVALID_SESSION_DATE');
  // The session a column reports is fixed by the edition, not chosen per run:
  // AM reports the completed session before its Hong Kong date, PM reports the
  // session running on it. Anything else would relabel one session as another.
  if ((Date.parse(`${dataDate}T00:00:00Z`) - Date.parse(`${intendedSessionDate}T00:00:00Z`))
      / 86_400_000 !== rule.lagDays) fail('SESSION_OUTSIDE_EDITION_WINDOW');
  if (!Array.isArray(measurements) || measurements.length > 10_000) fail('INVALID_MEASUREMENTS');
  if (!Array.isArray(trades) || !Array.isArray(corporateActions)) fail('INVALID_EVENT_INPUT');
  if (!num(outlierPct) || outlierPct <= 0) fail('INVALID_OUTLIER_GUARD');

  const parsed = measurements.map(readMeasurement);
  // Each measurement names the source that produced it. A set assembled by the
  // other adapter fails the whole column instead of degrading row by row: it is
  // a caller mistake, not a source gap, and its rows would otherwise be
  // published under a method that did not measure them.
  for (const entry of parsed) if (entry.raw && entry.raw.method !== method) fail('MEASUREMENT_METHOD_MISMATCH');
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
      quoteStatus: 'unavailable', reason: null, sessionDate: null, asOfLabel: null,
    };
    if (identity === null || entry.malformed) {
      return { ...base, reason: identity === null ? UNAVAILABLE_REASONS.IDENTITY : UNAVAILABLE_REASONS.MALFORMED };
    }
    if (ambiguous.has(identity) || !byKey.has(identity)) {
      return { ...base, reason: UNAVAILABLE_REASONS.AMBIGUOUS };
    }
    const raw = entry.raw;
    const missing = evidenceReason(raw, rules, intendedSessionDate);
    if (missing !== null) return { ...base, reason: missing };
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
      // The label belongs to the measurement, so this module decides it: a
      // completed session is named by its date, a running one by the minute it
      // was read. The merge below only copies what was decided here.
      asOfLabel: rules.label === 'instant' ? raw.observedAtHkt : raw.sessionDate,
    };
  });

  const available = rows.filter(row => row.quoteStatus === 'ok').length;
  const reasons = {};
  for (const row of rows) if (row.reason) reasons[row.reason] = (reasons[row.reason] || 0) + 1;
  return {
    edition, method, dataDate, intendedSessionDate, rows,
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
  if (typeof venueOf !== 'function') fail('VENUE_RESOLVER_REQUIRED');
  if (!plain(column.coverage) || !Number.isSafeInteger(column.coverage.available)
      || column.coverage.available < 0) fail('INVALID_COLUMN_COVERAGE');
  const byKey = new Map();
  for (const row of column.rows) if (row.key !== null && row.quoteStatus === 'ok') byKey.set(row.key, row);
  if (byKey.size !== column.coverage.available) fail('COLUMN_COVERAGE_MISMATCH');
  const resolved = new Set();
  let matched = 0;
  const output = rows.map(row => {
    const key = identityKey({ venue: venueOf(row), code: row.symbol });
    if (key !== null) {
      if (resolved.has(key)) fail('VIEW_IDENTITY_AMBIGUOUS');
      resolved.add(key);
    }
    const hit = key === null ? null : byKey.get(key) ?? null;
    if (hit === null) {
      return { ...row, changePct: null, changeAsOfHkt: null, quoteStatus: 'unavailable' };
    }
    matched += 1;
    return {
      ...row, changePct: hit.changePct, quoteStatus: 'ok',
      // The label states what was measured: an AM column carries a completed
      // session's move and must not be described as an 08:00 reading, while a
      // PM column carries one reading inside a running session and must name
      // the minute it was taken, because the following AM close reading of the
      // same instrument legitimately differs and the two are never reconciled.
      changeAsOfHkt: hit.asOfLabel,
      changeMethod: column.method, changeSessionDate: hit.sessionDate,
    };
  });
  // A venue mismatch such as view `US` versus source `NASDAQ` used to turn a
  // complete measurement set into an all-未取得 report without an error. The
  // caller now has to supply the explicit venue map and every usable source
  // row must land exactly once before the report can continue.
  if (matched !== column.coverage.available) fail('COLUMN_MERGE_INCOMPLETE');
  return output;
}

const attr = (attributes, name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...attributes.matchAll(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'gi'))];
  return matches.length === 1 ? matches[0][2] : null;
};

// Release-side verification for the evidence carried by rendered percentage
// rows. Validating final HTML closes the gap where a candidate could bypass
// the supported builder and write a percentage directly into the page.
export function validatePublishedDailyChangeHtml(html, { edition = null, dataDate = null } = {}) {
  if (typeof html !== 'string' || !realDate(dataDate)) fail('INVALID_PUBLISHED_REPORT');
  const rule = editionRule(edition);
  const paneMatch = html.match(/<div class="pane p1">([\s\S]*?)(?=<div class="pane p2">)/i);
  if (!paneMatch) fail('HOLDINGS_PANE_MISSING');
  const pane = paneMatch[1];
  const rows = [...pane.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)];
  let measured = 0;
  for (const [, attributes, body] of rows) {
    const displayed = body.match(/<td\b[^>]*class=(?:"[^"]*\b(?:up|dn)\b[^"]*"|'[^']*\b(?:up|dn)\b[^']*')[^>]*>\s*([+-]?\d+(?:\.\d+)?)%/i);
    const marker = attr(attributes, 'data-daily-change-v1');
    if (!displayed) {
      if (marker !== null) fail('ORPHAN_PUBLISHED_EVIDENCE');
      continue;
    }
    measured += 1;
    if (marker !== '1' || rule === null) fail('PUBLISHED_EVIDENCE_MISSING');
    const method = attr(attributes, 'data-change-method');
    const session = attr(attributes, 'data-change-session');
    const asOf = attr(attributes, 'data-change-as-of');
    const pct = attr(attributes, 'data-change-pct');
    if (!rule.methods.includes(method)) fail('PUBLISHED_METHOD_NOT_APPROVED_FOR_EDITION');
    if (!realDate(session)) fail('PUBLISHED_SESSION_INVALID');
    const lag = (Date.parse(`${dataDate}T00:00:00Z`) - Date.parse(`${session}T00:00:00Z`)) / 86_400_000;
    if (lag !== rule.lagDays) fail('PUBLISHED_SESSION_OUTSIDE_EDITION_WINDOW');
    const instant = INSTANT.exec(String(asOf ?? ''));
    if (DAILY_CHANGE_METHOD_RULES[method].label === 'instant') {
      if (!instant || instant[1] !== session || Number(instant[2]) > 23 || Number(instant[3]) > 59) {
        fail('PUBLISHED_INSTANT_INVALID');
      }
    } else if (asOf !== session) fail('PUBLISHED_SESSION_LABEL_INVALID');
    const exactPct = Number(pct);
    const shownPct = Number(displayed[1]);
    if (!num(exactPct) || exactPct === 0 || Number(exactPct.toFixed(2)) !== shownPct) {
      fail('PUBLISHED_VALUE_MISMATCH');
    }
  }
  const markers = (pane.match(/\bdata-daily-change-v1\s*=/gi) || []).length;
  if (markers !== measured) fail('PUBLISHED_EVIDENCE_COUNT_MISMATCH');
  return { measured };
}
