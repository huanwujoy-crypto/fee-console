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
//   am-session-pnl-v1
//              the same positions payload read AFTER the session it reports has
//              fully completed. It is a separate method, not the intraday one
//              under a different edition: it proves a completed venue session,
//              it is labelled with an instant on the REPORT date rather than on
//              the session date, and it may only fill a row the single-day
//              window never returned. It is never the primary AM source.
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

// Rendering and the publication guard must use one formatter. JavaScript's
// Intl formatter and Number#toFixed do not agree at binary midpoint values
// such as 2.195, which previously let the page show 2.2 while the guard
// expected 2.19 and blocked an otherwise valid report.
const PUBLISHED_PERCENT_FORMAT = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
  useGrouping: false,
});

export function formatPublishedDailyChangePct(value) {
  if (!num(value)) fail('INVALID_PUBLISHED_PERCENTAGE');
  const compact = PUBLISHED_PERCENT_FORMAT.format(value);
  // A value below the 1% section boundary must never display as exactly 1%.
  // Keep its validated source precision only in this boundary case.
  if (Math.abs(value) < 1 && Math.abs(Number(compact)) >= 1) return String(value);
  return compact;
}

export const DAILY_CHANGE_METHODS = Object.freeze(['window-v1', 'session-pnl-v1', 'am-session-pnl-v1']);
// Display keeps two decimals, so the stored value keeps four and no more: a
// wider float would imply a precision the sources do not publish.
const round4 = value => Number(value.toFixed(4));

// What each method has to prove per row before a number may be published.
export const DAILY_CHANGE_METHOD_RULES = Object.freeze({
  'window-v1': Object.freeze({ phases: Object.freeze(['complete']), label: 'session-date', instantOn: null, proveMark: false }),
  // The running session is read out of the positions payload the report
  // already holds, so `mark * quantity` must reproduce that payload's own
  // market value before its session P&L may be turned into a percentage.
  // `instantOn: 'session'` is PM's own labelling and is left exactly as it was.
  'session-pnl-v1': Object.freeze({ phases: Object.freeze(['open', 'complete']), label: 'instant', instantOn: 'session', proveMark: true }),
  // The completed-session reading of the same payload. Stricter than PM on both
  // ends: the venue's session must be proven FINISHED, never merely running,
  // and the observation instant must fall on the report's own Hong Kong date,
  // because an 08:00 HKT run reads the previous New York session hours after it
  // closed. Reusing PM's instant rule here would demand a minute on the session
  // date and silently relabel one day's reading as another's.
  'am-session-pnl-v1': Object.freeze({ phases: Object.freeze(['complete']), label: 'instant', instantOn: 'dataDate', proveMark: true }),
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

// A per-row fallback, deliberately kept out of `DAILY_CHANGE_EDITION_RULES`
// above so that the primary method an edition publishes is unchanged and
// remains readable at a glance. AM gained one because a newly opened position
// can be live in the broker's book before the portfolio source has synced it
// into the single-day window at all, which is a source gap for one row and not
// a reason to lose the column or to widen the window's own contract. PM has
// none: its measurement already comes from the positions payload.
export const DAILY_CHANGE_EDITION_FALLBACK = Object.freeze({ am: 'am-session-pnl-v1', pm: null });
const editionFallback = edition => (typeof edition === 'string'
  && Object.hasOwn(DAILY_CHANGE_EDITION_FALLBACK, edition) ? DAILY_CHANGE_EDITION_FALLBACK[edition] : null);
// The published gate accepts an edition's primary methods plus its approved
// fallback, and nothing else.
export const editionPublishableMethods = edition => {
  const rule = editionRule(edition);
  if (rule === null) return [];
  const fallback = editionFallback(edition);
  return fallback === null ? [...rule.methods] : [...rule.methods, fallback];
};

export const UNAVAILABLE_REASONS = Object.freeze({
  TRADED: 'traded-in-window',
  FLAT_OR_STALE: 'flat-or-stale-indistinguishable',
  // The two independent readings of one completed session disagree. Neither is
  // preferred and nothing is arbitrated: a number that two sources cannot agree
  // on is not published at all, and the row says why by name.
  CONTRADICTED: 'contradicted-between-sources',
  // The single-day window never returned this row. Presence is its own state,
  // separate from a row that was returned and then suppressed.
  NOT_IN_WINDOW: 'not-in-single-day-window',
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

// The strong identifier a normalized row carries from its own book — the IB
// contract id, the portfolio source's `instrument.id`. Resolving through it is
// the path that removes venue inference entirely: the registry is asked what
// instrument this exact identifier is, rather than being asked to reconcile two
// exchange strings that somebody upstream had to attach first. A source name
// the registry does not support is a caller mistake and fails the column loudly
// rather than degrading into a venue guess.
export function strongIdentityKey(raw, venueIdentity) {
  if (venueIdentity === null || !plain(raw)) return null;
  if (typeof venueIdentity.canonicalKeyForSource !== 'function') return null;
  const source = raw.identitySource, value = raw.identityValue;
  // Absent is the ordinary case for a payload that publishes no such id, and it
  // is exactly when the venue+code key is still the best evidence there is.
  if (typeof source !== 'string' || !source) return null;
  if (typeof value !== 'string' || !value) return null;
  return venueIdentity.canonicalKeyForSource(source, value) ?? null;
}

// `malformed` now means only that the row's numbers are unusable. A missing
// venue+code key is no longer the same thing, because a row whose book
// publishes no exchange label can still be identified exactly by its contract
// id; whether any identity resolved at all is decided by the caller once both
// paths have been tried.
function readMeasurement(raw) {
  if (!plain(raw)) return { key: null, malformed: true };
  const key = identityKey({ venue: raw.venue, code: raw.code });
  const ok = num(raw.changePct) && (raw.currencyChangePct === null || num(raw.currencyChangePct));
  return { key, malformed: !ok, raw };
}

// The evidence a measurement needs must be proven for that row, not asserted
// once for the whole report: an upstream book rolls its session per instrument
// and per venue, so one flag cannot cover a portfolio spanning several
// exchanges, and a schedule anchored to a fixed offset drifts against the
// venue's own calendar when its daylight-saving rule changes.
function evidenceReason(row, rules, intendedSessionDate, dataDate = null) {
  if (row.sessionDate !== intendedSessionDate || !rules.phases.includes(row.sessionPhase)) {
    return UNAVAILABLE_REASONS.SESSION;
  }
  // A reading taken from a payload means nothing without the minute it belongs
  // to, and that minute must fall on the day the method says it should. PM
  // reads a running session, so its instant belongs to the session date: a run
  // that slips onto the next Hong Kong date loses the column rather than
  // publishing an instant labelled with someone else's session. The AM fallback
  // reads a session that has already finished, so its instant belongs to the
  // report's own date; accepting the session date there would let a reading
  // taken a day late pass as if it had been taken at the close.
  if (rules.label === 'instant') {
    const expected = rules.instantOn === 'dataDate' ? dataDate : row.sessionDate;
    const match = INSTANT.exec(String(row.observedAtHkt ?? ''));
    if (!match || expected === null || match[1] !== expected
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
  // An independent same-run reading of the same completed session, normalized
  // by the other adapter. It does two jobs and no others: it fills a row the
  // primary source never returned, and it corroborates — or contradicts — a
  // reading the primary source did return. It never overrides one.
  fallbackMeasurements = null,
  // Two honest measurements of one session are computed differently and will
  // not agree to the last basis point. Beyond this they are treated as
  // disagreeing, and the row is dropped rather than reconciled.
  corroborationTolerancePct = 0.05,
  // A reviewed instrument-scoped resolver from `xuan-ib-venue-identity.mjs`.
  // Absent, every key stays exactly as its source spelled it.
  venueIdentity = null,
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
  if (!num(corroborationTolerancePct) || corroborationTolerancePct < 0) fail('INVALID_CORROBORATION_TOLERANCE');
  if (venueIdentity !== null && (!venueIdentity || typeof venueIdentity.canonicalKey !== 'function')) {
    fail('INVALID_VENUE_IDENTITY');
  }
  // Only a key a reviewed instrument entry actually records is rewritten; every
  // other key is returned untouched, so nothing is ever merged by accident.
  const canon = key => (key === null ? null : (venueIdentity === null ? key : venueIdentity.canonicalKey(key)));
  // Strong identity first, venue+code only when there is no strong identifier
  // or the registry does not record it. The order matters: the venue+code path
  // can only join two books that already agree on an exchange string, or whose
  // exact pair of strings a reviewed entry happens to record, whereas the
  // identifier each payload publishes about the instrument itself needs neither.
  const resolve = entry => strongIdentityKey(entry.raw, venueIdentity) ?? canon(entry.key);

  const fallbackMethod = editionFallback(edition);
  if (fallbackMeasurements !== null) {
    // An edition with no approved fallback refuses the input outright rather
    // than ignoring it: silently dropping a set the caller believed was in use
    // would be indistinguishable from the rows simply not existing.
    if (fallbackMethod === null) fail('FALLBACK_NOT_APPROVED_FOR_EDITION');
    if (!Array.isArray(fallbackMeasurements) || fallbackMeasurements.length > 10_000) fail('INVALID_FALLBACK_MEASUREMENTS');
  }
  const fallbackRules = fallbackMethod === null ? null : DAILY_CHANGE_METHOD_RULES[fallbackMethod];

  const parsed = measurements.map(readMeasurement);
  // Each measurement names the source that produced it. A set assembled by the
  // other adapter fails the whole column instead of degrading row by row: it is
  // a caller mistake, not a source gap, and its rows would otherwise be
  // published under a method that did not measure them.
  for (const entry of parsed) if (entry.raw && entry.raw.method !== method) fail('MEASUREMENT_METHOD_MISMATCH');
  for (const entry of parsed) entry.canonical = resolve(entry);
  const { byKey, ambiguous } = indexByKey(parsed.map(entry => ({ ...entry, key: entry.canonical })), 'measurement');

  const parsedFallback = (fallbackMeasurements ?? []).map(readMeasurement);
  for (const entry of parsedFallback) if (entry.raw && entry.raw.method !== fallbackMethod) fail('MEASUREMENT_METHOD_MISMATCH');
  for (const entry of parsedFallback) entry.canonical = resolve(entry);
  const fallbackIndex = indexByKey(parsedFallback.map(entry => ({ ...entry, key: entry.canonical })), 'measurement');

  // Events are venue-scoped too. A trade or corporate action whose identity
  // cannot be resolved is retained as an unresolved marker: it must be able to
  // suppress a row, never to be silently ignored because its key did not map.
  const tradedKeys = new Set(), unresolvedEvents = [];
  for (const trade of trades) {
    const key = plain(trade) ? canon(identityKey({ venue: trade.venue, code: trade.code })) : null;
    if (key === null) { unresolvedEvents.push('trade'); continue; }
    tradedKeys.add(key);
  }
  const actionKeys = new Set();
  for (const action of corporateActions) {
    const key = plain(action) ? canon(identityKey({ venue: action.venue, code: action.code })) : null;
    if (key === null) { unresolvedEvents.push('corporate-action'); continue; }
    actionKeys.add(key);
  }

  // The corroborating reading for one canonical key, or null. It must clear its
  // own method's full evidence bar first: a reading that could not be published
  // on its own is not evidence about anybody else's number either.
  const corroborationFor = identity => {
    if (fallbackRules === null || identity === null) return null;
    const entry = fallbackIndex.byKey.get(identity) ?? null;
    if (entry === null || entry.malformed || fallbackIndex.ambiguous.has(identity)) return null;
    if (evidenceReason(entry.raw, fallbackRules, intendedSessionDate, dataDate) !== null) return null;
    return num(entry.raw.changePct) ? entry.raw : null;
  };

  const measured = (identity, raw, rowRules, rowMethod, corroboratedBy, presence) => ({
    key: identity, canonicalKey: identity, method: rowMethod, presence,
    changePct: round4(raw.changePct),
    currencyChangePct: raw.currencyChangePct === null || raw.currencyChangePct === undefined
      ? null : round4(raw.currencyChangePct),
    quoteStatus: 'ok', reason: null, sessionDate: raw.sessionDate, corroboratedBy,
    // The label belongs to the measurement, so this module decides it: a
    // completed session is named by its date, a reading of a payload by the
    // minute it was taken. The merge below only copies what was decided here.
    asOfLabel: rowRules.label === 'instant' ? raw.observedAtHkt : raw.sessionDate,
  });

  const rows = parsed.map(entry => {
    const identity = entry.canonical;
    const base = {
      key: identity, canonicalKey: identity, method, presence: 'in-window',
      changePct: null, currencyChangePct: null,
      quoteStatus: 'unavailable', reason: null, sessionDate: null, asOfLabel: null, corroboratedBy: null,
    };
    if (identity === null || entry.malformed) {
      return { ...base, key: entry.key, canonicalKey: identity,
        reason: identity === null ? UNAVAILABLE_REASONS.IDENTITY : UNAVAILABLE_REASONS.MALFORMED };
    }
    if (ambiguous.has(identity) || !byKey.has(identity)) {
      return { ...base, reason: UNAVAILABLE_REASONS.AMBIGUOUS };
    }
    const raw = entry.raw;
    const missing = evidenceReason(raw, rules, intendedSessionDate, dataDate);
    if (missing !== null) return { ...base, reason: missing };
    if (tradedKeys.has(identity)) return { ...base, sessionDate: raw.sessionDate, reason: UNAVAILABLE_REASONS.TRADED };
    // A corporate action moves the raw price without moving the holder's
    // economics. The magnitude guard below is an outlier trap, not a detector:
    // an unadjusted 2-for-1 split reads as about -50% and would pass it.
    if (actionKeys.has(identity)) return { ...base, sessionDate: raw.sessionDate, reason: UNAVAILABLE_REASONS.CORPORATE_ACTION };
    const corroborating = corroborationFor(identity);
    // Presence is three-valued, not two. Exactly zero on its own still cannot
    // be told apart from a price the source carried forward for a session it
    // never loaded, so it stays unpublishable — but a second, independent
    // reading of the same completed session settles which it was. Agreeing at
    // zero makes a genuinely flat row publishable as 0.00%; disagreeing makes
    // it a contradiction, disclosed by name and never averaged away.
    if (raw.changePct === 0) {
      if (corroborating === null) return { ...base, sessionDate: raw.sessionDate, reason: UNAVAILABLE_REASONS.FLAT_OR_STALE };
      if (Math.abs(corroborating.changePct) > corroborationTolerancePct) {
        return { ...base, sessionDate: raw.sessionDate, reason: UNAVAILABLE_REASONS.CONTRADICTED };
      }
      return measured(identity, raw, rules, method, fallbackMethod, 'in-window');
    }
    // A nonzero primary reading is the one that publishes; the fallback never
    // overrides it and is never averaged with it. It can still withhold it:
    // two readings of one finished session that disagree materially mean one of
    // them is wrong, and there is no sound basis here for choosing which.
    if (corroborating !== null && Math.abs(corroborating.changePct - raw.changePct) > corroborationTolerancePct) {
      return { ...base, sessionDate: raw.sessionDate, reason: UNAVAILABLE_REASONS.CONTRADICTED };
    }
    if (Math.abs(raw.changePct) > outlierPct) return { ...base, sessionDate: raw.sessionDate, reason: UNAVAILABLE_REASONS.OUTLIER };
    return measured(identity, raw, rules, method, corroborating === null ? null : fallbackMethod, 'in-window');
  });

  // Rows the single-day window never returned at all. A position opened in the
  // broker's book before the portfolio source synced it is a gap in one row of
  // one source, so it is filled from the other reading under its own strictly
  // evidenced method — and only when that method proves everything it needs.
  if (fallbackMethod !== null) {
    for (const entry of parsedFallback) {
      const identity = entry.canonical;
      if (identity === null || entry.malformed) continue;
      // A key the window did return keeps the window's decision, including a
      // suppression: the fallback fills gaps, it does not overturn rulings.
      if (byKey.has(identity) || ambiguous.has(identity)) continue;
      // Duplicates inside the fallback set resolve to neither copy, exactly as
      // they do inside the primary set.
      if (fallbackIndex.ambiguous.has(identity) || fallbackIndex.byKey.get(identity) === undefined) continue;
      const base = {
        key: identity, canonicalKey: identity, method: fallbackMethod, presence: 'not-in-window',
        changePct: null, currencyChangePct: null,
        quoteStatus: 'unavailable', reason: null, sessionDate: null, asOfLabel: null, corroboratedBy: null,
      };
      const raw = entry.raw;
      const missing = evidenceReason(raw, fallbackRules, intendedSessionDate, dataDate);
      if (missing !== null) { rows.push({ ...base, reason: missing }); continue; }
      if (tradedKeys.has(identity)) { rows.push({ ...base, sessionDate: raw.sessionDate, reason: UNAVAILABLE_REASONS.TRADED }); continue; }
      if (actionKeys.has(identity)) { rows.push({ ...base, sessionDate: raw.sessionDate, reason: UNAVAILABLE_REASONS.CORPORATE_ACTION }); continue; }
      if (!num(raw.changePct)) { rows.push({ ...base, reason: UNAVAILABLE_REASONS.NO_INPUT }); continue; }
      // Nothing corroborates the fallback when it is the only reading there is,
      // so its own zero stays unpublishable for exactly the original reason.
      if (raw.changePct === 0) { rows.push({ ...base, sessionDate: raw.sessionDate, reason: UNAVAILABLE_REASONS.FLAT_OR_STALE }); continue; }
      if (Math.abs(raw.changePct) > outlierPct) { rows.push({ ...base, sessionDate: raw.sessionDate, reason: UNAVAILABLE_REASONS.OUTLIER }); continue; }
      rows.push(measured(identity, raw, fallbackRules, fallbackMethod, null, 'not-in-window'));
    }
  }

  const available = rows.filter(row => row.quoteStatus === 'ok').length;
  const reasons = {};
  for (const row of rows) if (row.reason) reasons[row.reason] = (reasons[row.reason] || 0) + 1;
  return {
    edition, method, fallbackMethod, dataDate, intendedSessionDate, rows,
    coverage: { available, total: rows.length, reasons },
    unresolvedEvents: unresolvedEvents.length,
  };
}

// Merge a built column onto view holding rows. The merge is identity-keyed,
// never positional and never by bare ticker, so a row whose identity does not
// resolve keeps its unavailable state instead of inheriting a neighbour's
// move. Passing `column: null` leaves every row exactly as it was, which is
// the no-regression path for a generator that has no measurement source.
// `identityOf` lets a view row be matched by the same strong identifier its
// source published, returning `{ source, value }` or null. Supplying it is what
// makes the merge independent of the exchange string the view happens to show:
// without it a row is still matched by venue+code exactly as before.
export function applyDailyChangeColumn(rows, column, { venueOf = null, venueIdentity = null, identityOf = null } = {}) {
  if (!Array.isArray(rows)) fail('INVALID_VIEW_ROWS');
  if (column === null) return rows.map(row => ({ ...row }));
  if (identityOf !== null && typeof identityOf !== 'function') fail('INVALID_VIEW_IDENTITY_RESOLVER');
  if (!plain(column) || !Array.isArray(column.rows) || !DAILY_CHANGE_METHODS.includes(column.method)) fail('INVALID_COLUMN');
  if (typeof venueOf !== 'function') fail('VENUE_RESOLVER_REQUIRED');
  if (venueIdentity !== null && (!venueIdentity || typeof venueIdentity.canonicalKey !== 'function')) {
    fail('INVALID_VENUE_IDENTITY');
  }
  if (!plain(column.coverage) || !Number.isSafeInteger(column.coverage.available)
      || column.coverage.available < 0) fail('INVALID_COLUMN_COVERAGE');
  const canon = key => (key === null ? null : (venueIdentity === null ? key : venueIdentity.canonicalKey(key)));
  const byKey = new Map(), reasonByKey = new Map();
  for (const row of column.rows) {
    const key = row.canonicalKey ?? row.key;
    if (key === null) continue;
    if (row.quoteStatus === 'ok') byKey.set(key, row);
    else if (row.reason && !reasonByKey.has(key)) reasonByKey.set(key, row.reason);
  }
  if (byKey.size !== column.coverage.available) fail('COLUMN_COVERAGE_MISMATCH');
  const resolved = new Set();
  const unmatchedViewKeys = [];
  let matched = 0;
  // The same precedence the builder uses, so a column keyed by strong identity
  // is merged by strong identity rather than falling back to the venue string
  // the two sides were never guaranteed to spell the same way.
  const viewKey = row => {
    const declared = identityOf === null ? null : identityOf(row);
    const strong = declared === null || declared === undefined ? null
      : strongIdentityKey({ identitySource: declared.source, identityValue: declared.value }, venueIdentity);
    return strong ?? canon(identityKey({ venue: venueOf(row), code: row.symbol }));
  };
  const output = rows.map(row => {
    const key = viewKey(row);
    if (key !== null) {
      if (resolved.has(key)) fail('VIEW_IDENTITY_AMBIGUOUS');
      resolved.add(key);
    }
    const hit = key === null ? null : byKey.get(key) ?? null;
    if (hit === null) {
      if (key !== null) unmatchedViewKeys.push(key);
      // Every unmeasured row states why in machine-readable form. A row the
      // source returned and this module suppressed keeps that exact reason; a
      // row the single-day window never returned says so rather than vanishing
      // into an undifferentiated 未取得.
      return {
        ...row, changePct: null, changeAsOfHkt: null, quoteStatus: 'unavailable',
        changeReason: (key === null ? UNAVAILABLE_REASONS.IDENTITY
          : reasonByKey.get(key) ?? UNAVAILABLE_REASONS.NOT_IN_WINDOW),
      };
    }
    matched += 1;
    return {
      ...row, changePct: hit.changePct, quoteStatus: 'ok',
      // The label states what was measured: a completed-session window carries
      // that session's date and must not be described as an 08:00 reading,
      // while a reading taken from a positions payload must name the minute it
      // was taken, because a PM intraday reading and the following AM close
      // reading of the same instrument legitimately differ and are never
      // reconciled.
      changeAsOfHkt: hit.asOfLabel,
      // Per row, not per column: an AM column may carry the window for most
      // rows and the strictly evidenced completed-session fallback for a row
      // the window never returned, and each row must name what measured it.
      changeMethod: hit.method ?? column.method, changeSessionDate: hit.sessionDate,
      ...(hit.corroboratedBy ? { changeCorroboratedBy: hit.corroboratedBy } : {}),
    };
  });
  // A venue mismatch such as view `US` versus source `NASDAQ` used to turn a
  // complete measurement set into an all-未取得 report without an error. The
  // caller now has to supply the explicit venue map and every usable source
  // row must land exactly once before the report can continue.
  if (matched !== column.coverage.available) {
    // Name the cross-venue pairings nobody reviewed. The same ticker on two
    // venues is genuinely two instruments, so this is a disclosure and a
    // refusal, never a hint to join them: an equivalence is added only as a
    // reviewed, instrument-scoped registry entry under the publication lock.
    const unmatchedSource = [...byKey.keys()].filter(key => !resolved.has(key));
    const pairs = [];
    for (const source of unmatchedSource) {
      for (const view of unmatchedViewKeys) {
        if (source === view) continue;
        const [sourceVenue, sourceCode] = splitKey(source), [viewVenue, viewCode] = splitKey(view);
        if (sourceVenue === viewVenue || sourceCode !== viewCode) continue;
        if (venueIdentity !== null && venueIdentity.isReviewedPair?.(source, view)) continue;
        pairs.push(describeVenuePair(source, view));
      }
    }
    fail(pairs.length
      ? `COLUMN_MERGE_INCOMPLETE (unreviewed venue pair: ${[...new Set(pairs)].sort().join(', ')})`
      : 'COLUMN_MERGE_INCOMPLETE');
  }
  return output;
}

const splitKey = key => {
  const at = String(key).indexOf(':');
  return at < 0 ? [String(key), ''] : [String(key).slice(0, at), String(key).slice(at + 1)];
};
// The label an unreviewed cross-venue pairing is refused under.
const describeVenuePair = (left, right) => [left, right].sort().join('~');

const attr = (attributes, name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...attributes.matchAll(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'gi'))];
  return matches.length === 1 ? matches[0][2] : null;
};

// Release-side verification for the evidence carried by rendered percentage
// rows. Validating final HTML closes the gap where a candidate could bypass
// the supported builder and write a percentage directly into the page.
const UNAVAILABLE_REASON_VALUES = Object.freeze(new Set(Object.values(UNAVAILABLE_REASONS)));

export function validatePublishedDailyChangeHtml(html, { edition = null, dataDate = null } = {}) {
  if (typeof html !== 'string' || !realDate(dataDate)) fail('INVALID_PUBLISHED_REPORT');
  const rule = editionRule(edition);
  const publishable = editionPublishableMethods(edition);
  const paneMatch = html.match(/<div class="pane p1">([\s\S]*?)(?=<div class="pane p2">)/i);
  if (!paneMatch) fail('HOLDINGS_PANE_MISSING');
  const pane = paneMatch[1];
  const rows = [...pane.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)];
  let measured = 0, unavailable = 0;
  for (const [, attributes, body] of rows) {
    // `flat` is the corroborated-zero class. It exists only because a zero that
    // two independent readings agree on is a real measurement with no direction
    // to colour, and it must still be checked like any other published number.
    const displayed = body.match(/<td\b[^>]*class=(?:"[^"]*\b(?:up|dn|flat)\b[^"]*"|'[^']*\b(?:up|dn|flat)\b[^']*')[^>]*>\s*([+-]?\d+(?:\.\d+)?)%/i);
    const marker = attr(attributes, 'data-daily-change-v1');
    const absent = attr(attributes, 'data-change-unavailable-v1');
    // A row cannot simultaneously claim a measurement and declare that it has
    // none; that ambiguity is the exact shape a silently dropped row would take.
    if (marker !== null && absent !== null) fail('PUBLISHED_ROW_STATE_AMBIGUOUS');
    if (absent !== null) {
      if (absent !== '1' || displayed) fail('PUBLISHED_ROW_STATE_AMBIGUOUS');
      const reason = attr(attributes, 'data-change-reason');
      // An unmeasured row names which of the enumerated reasons applies. A free
      // text, an unknown code or a missing attribute is refused, so a report
      // cannot report an absence it has not classified.
      if (reason === null || !UNAVAILABLE_REASON_VALUES.has(reason)) fail('PUBLISHED_REASON_INVALID');
      unavailable += 1;
      continue;
    }
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
    const corroboratedBy = attr(attributes, 'data-change-corroborated-by');
    if (!publishable.includes(method)) fail('PUBLISHED_METHOD_NOT_APPROVED_FOR_EDITION');
    if (!realDate(session)) fail('PUBLISHED_SESSION_INVALID');
    const lag = (Date.parse(`${dataDate}T00:00:00Z`) - Date.parse(`${session}T00:00:00Z`)) / 86_400_000;
    if (lag !== rule.lagDays) fail('PUBLISHED_SESSION_OUTSIDE_EDITION_WINDOW');
    const methodRules = DAILY_CHANGE_METHOD_RULES[method];
    const instant = INSTANT.exec(String(asOf ?? ''));
    if (methodRules.label === 'instant') {
      // Each instant method names the day its reading belongs to. PM's belongs
      // to the session it is reading; the AM fallback's belongs to the report
      // date, hours after that session closed.
      const expected = methodRules.instantOn === 'dataDate' ? dataDate : session;
      if (!instant || instant[1] !== expected || Number(instant[2]) > 23 || Number(instant[3]) > 59) {
        fail('PUBLISHED_INSTANT_INVALID');
      }
    } else if (asOf !== session) fail('PUBLISHED_SESSION_LABEL_INVALID');
    if (corroboratedBy !== null && (!publishable.includes(corroboratedBy) || corroboratedBy === method)) {
      fail('PUBLISHED_CORROBORATION_INVALID');
    }
    const exactPct = Number(pct);
    const shownPct = Number(displayed[1]);
    // Exactly zero publishes only when the row names the independent method
    // that corroborated it. Without that attribute a zero is still the
    // indistinguishable case and is refused exactly as before.
    if (!num(exactPct) || (exactPct === 0 && corroboratedBy === null)
      || Number(formatPublishedDailyChangePct(exactPct)) !== shownPct) {
      fail('PUBLISHED_VALUE_MISMATCH');
    }
  }
  const markers = (pane.match(/\bdata-daily-change-v1\s*=/gi) || []).length;
  if (markers !== measured) fail('PUBLISHED_EVIDENCE_COUNT_MISMATCH');
  const absentMarkers = (pane.match(/\bdata-change-unavailable-v1\s*=/gi) || []).length;
  if (absentMarkers !== unavailable) fail('PUBLISHED_REASON_COUNT_MISMATCH');
  // Coverage closes the last gap: without it a producer could drop a row from
  // the table altogether and still look complete, because nothing that remains
  // would be wrong. Declaring measured and total makes the omission arithmetic
  // rather than a matter of trust.
  const coverage = [...pane.matchAll(/\bdata-daily-change-coverage-v1\s*=\s*(["'])(.*?)\1/gi)];
  if (unavailable > 0 && !coverage.length) fail('PUBLISHED_COVERAGE_MISSING');
  if (coverage.length > 1) fail('PUBLISHED_COVERAGE_MISMATCH');
  if (coverage.length) {
    const parts = /^(\d{1,5})\/(\d{1,5})$/.exec(coverage[0][2]);
    if (!parts || Number(parts[1]) !== measured || Number(parts[2]) !== measured + unavailable) {
      fail('PUBLISHED_COVERAGE_MISMATCH');
    }
  }
  // The return shape stays exactly `{ measured }`: existing callers compare it
  // whole, and the unmeasured count is already proven above rather than being
  // something a caller has to re-derive and trust.
  return { measured };
}
