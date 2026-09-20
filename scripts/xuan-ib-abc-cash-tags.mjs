// ABC1 cash-event tags (v2.3 draft): the machine-readable annotation a
// Sharesight cash-account transaction carries in its description so the ABC
// comparison can classify a cash event without an owner declaration.
//
// This module is pure. It reads nothing, writes nothing, fetches nothing and
// prints no amount. It is not reached from the daily producer: wiring it into
// `xuan-ib-etf-daily.mjs` is a separate, owner-approved change, and until then
// the owner-declared ledgers remain the only source the comparison consumes.
//
// Contract (claude/xuan-ib-etf-cash-tags-v1.md):
//   * a tag is one bracketed group anywhere in the description,
//       [ABC1 KIND ev:REF key:value …]
//     KIND ∈ EXT | XFER | CALL | ADJ | FX | INKIND; every tag names its event
//     with `ev`; XFER legs share one `ev`; CALL also names `commit`, the owner
//     commitment it draws on; a non-USD pool event carries `usd`;
//   * the tag never replaces the original description text or the row's own
//     foreign_identifier: `ev` is the event reference, the write-dedup key
//     stays the row's own, and tagging an existing row is a description-only
//     update of that transaction id, never a new row;
//   * direction is the sign of the row's own amount, never restated;
//   * only DEPOSIT / WITHDRAWAL / OPENING_BALANCE rows are cash events. Trade,
//     payout, interest and fee rows are ordinary return and take no tag. A
//     private-fund distribution or capital return arriving in NOAH-HK cash is
//     a boundary inflow (EXT), never return, whatever its own wording says;
//   * nothing is inferred from one side alone: an unpaired transfer leg, a
//     call without its declared level change, an adjustment of unknown meaning
//     are named pending reasons for their posting date. Pending only holds the
//     ABC comparison; it never blocks the holdings, orders or the report.
export const TAG_VERSION = 'ABC1';
export const TAG_KINDS = Object.freeze(['EXT', 'XFER', 'CALL', 'ADJ', 'FX', 'INKIND']);
export const CASH_EVENT_TYPES = Object.freeze(['DEPOSIT', 'WITHDRAWAL', 'OPENING_BALANCE']);
export const RETURN_TYPES = Object.freeze(['INTEREST_PAYMENT', 'FEE', 'FEE_REIMBURSEMENT']);
export const TRADE_TYPES = Object.freeze(['Buy Trade', 'Sell Trade', 'Payout']);
export const CUSTODIANS = Object.freeze(['IB-HK', 'NOAH-HK']);
export const MAX_TAG_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 255;
export const TRANSFER_WINDOW_DAYS = 7;
export const PENDING_REASONS = Object.freeze([
  'malformed-tag',          // a [ABC1 …] group is present but does not parse
  'untagged-cash-event',    // DEPOSIT / WITHDRAWAL / OPENING_BALANCE without a tag
  'tag-on-return-row',      // a tag on a trade, payout, interest or fee row
  'unknown-row-type',       // a transaction type this module does not know
  'usd-equivalent-pending', // non-USD event that affects the pool with no usd: value
  'transfer-unpaired',      // an XFER leg whose counter-leg has not posted, or posted outside the window
  'transfer-mismatch',      // legs found but amounts, signs, count or custodians do not fit
  'call-unmatched',         // a CALL whose commitment id does not identify one open commitment covering it
  'call-level-pending',     // a matched CALL the owner has not yet reflected as a level decrease that day
  'adjustment-pending',     // a NOAH-HK ADJ: its meaning for the pool is the owner's to state
  'fx-on-pool-account',     // an FX tag on the single-currency NOAH-HK account
  'duplicate-event-ref',    // one ev on more than one row of a non-transfer kind
]);

const fail = message => { throw new Error(message); };
const check = (ok, message) => { if (!ok) fail(message); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const validDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const round2 = v => Math.round(v * 100) / 100;
const CENTS = 0.005;
const REF_RE = /^[A-Za-z0-9._-]{4,64}$/;
const USD_RE = /^\d{1,13}\.\d{2}$/;
const FIELDS = Object.freeze(['ev', 'usd', 'commit', 'fund']);

// Parse the single ABC1 tag of a description. Returns null when no tag is
// present, the parsed tag when it is valid, and throws when a tag group is
// present but malformed — the caller turns that into a named pending reason.
export function parseAbcTag(description) {
  if (typeof description !== 'string') return null;
  const groups = description.match(/\[ABC\d[^\]]*\]?/g) || [];
  if (groups.length === 0) return null;
  check(groups.length === 1, 'more than one ABC tag');
  const raw = groups[0];
  check(raw.endsWith(']') && raw.length <= MAX_TAG_LENGTH, 'unterminated or oversized ABC tag');
  const parts = raw.slice(1, -1).trim().split(/\s+/);
  check(parts[0] === TAG_VERSION, `unsupported tag version ${parts[0]}`);
  const kind = parts[1];
  check(TAG_KINDS.includes(kind), `unknown kind ${kind}`);
  const tag = { version: TAG_VERSION, kind, ev: null, usd: null, commit: null, fund: null, raw };
  const seen = new Set();
  for (const part of parts.slice(2)) {
    const m = part.match(/^([a-z]+):(.+)$/);
    check(m && FIELDS.includes(m[1]) && !seen.has(m[1]), `bad or repeated field ${part}`);
    seen.add(m[1]);
    if (m[1] === 'usd') check(USD_RE.test(m[2]) && Number(m[2]) > 0, 'bad usd');
    else check(REF_RE.test(m[2]), `bad ${m[1]}`);
    tag[m[1]] = m[1] === 'usd' ? Number(m[2]) : m[2];
  }
  check(tag.ev, 'every tag names its event with ev');
  check(kind !== 'CALL' || tag.commit, 'CALL needs commit');
  check(kind === 'CALL' || (tag.commit === null && tag.fund === null), `${kind} carries no commit or fund`);
  check(!['FX', 'ADJ'].includes(kind) || tag.usd === null, `${kind} carries no usd`);
  return tag;
}

// Sync-side helpers. `formatAbcTag` renders the canonical tag; `tagDescription`
// places it in front of an existing description without losing the row's own
// identity, and `planDescriptionUpdate` turns that into a description-only
// update for one transaction id, never a create (rows without a
// foreign_identifier are de-duplicated by their full description, so a
// re-created row would double-book). Free text is truncated to the
// 255-character limit; the tag never is. Re-tagging with the identical tag is
// a no-op; a different tag on an already tagged row is refused.
export function formatAbcTag({ kind, ev, usd = null, commit = null, fund = null }) {
  check(TAG_KINDS.includes(kind), `unknown kind ${kind}`);
  check(typeof ev === 'string' && REF_RE.test(ev), 'bad ev');
  const parts = [TAG_VERSION, kind, `ev:${ev}`];
  if (usd !== null) { check(finite(usd) && usd > 0 && round2(usd) === usd, 'bad usd'); parts.push(`usd:${usd.toFixed(2)}`); }
  if (commit !== null) { check(typeof commit === 'string' && REF_RE.test(commit), 'bad commit'); parts.push(`commit:${commit}`); }
  if (fund !== null) { check(typeof fund === 'string' && REF_RE.test(fund), 'bad fund'); parts.push(`fund:${fund}`); }
  const raw = `[${parts.join(' ')}]`;
  parseAbcTag(raw); // the canonical form must round-trip through the parser
  return raw;
}
export function tagDescription(description, tag) {
  const raw = typeof tag === 'string' ? tag : formatAbcTag(tag);
  parseAbcTag(raw);
  const original = typeof description === 'string' ? description : '';
  const existing = parseAbcTag(original); // throws on a malformed existing tag
  if (existing) { check(existing.raw === raw, 'row already carries a different ABC tag'); return original; }
  const room = MAX_DESCRIPTION_LENGTH - raw.length - 1;
  check(room >= 0, 'tag leaves no room in the description');
  return original ? `${raw} ${original.slice(0, room)}` : raw;
}
export function planDescriptionUpdate(row, tag) {
  check(object(row) && Number.isSafeInteger(row.id), 'invalid transaction');
  const description = tagDescription(row.description, tag);
  return { transactionId: row.id, description, changed: description !== (row.description ?? ''), mode: 'description-only' };
}

// Classify one Sharesight cash-account transaction against its account identity.
// `account` is { id, custodian, currency } from the reviewed instruments file.
export function classifyCashRow(row, account) {
  check(object(row) && Number.isSafeInteger(row.id) && typeof row.date_time === 'string'
    && Number.isFinite(Date.parse(row.date_time)) && finite(row.amount), 'invalid cash transaction');
  check(object(account) && account.id === row.cash_account_id && CUSTODIANS.includes(account.custodian)
    && typeof account.currency === 'string', 'transaction is not on a declared pool account');
  const type = row.cash_account_transaction_type?.name;
  const base = {
    id: `SS-${row.id}`, rowId: row.id, foreignIdentifier: row.foreign_identifier ?? null,
    date: new Date(Date.parse(row.date_time)).toISOString().slice(0, 10),
    amount: row.amount, currency: account.currency, custodian: account.custodian, type,
    category: null, tag: null, usd: null, pending: null,
  };
  let tag = null, malformed = false;
  try { tag = parseAbcTag(row.description); } catch { malformed = true; }
  if (TRADE_TYPES.includes(type) || RETURN_TYPES.includes(type)) {
    base.category = 'return';
    if (tag || malformed) base.pending = 'tag-on-return-row';
    return base;
  }
  if (!CASH_EVENT_TYPES.includes(type)) { base.category = 'unknown'; base.pending = 'unknown-row-type'; return base; }
  base.category = 'event';
  if (malformed) { base.pending = 'malformed-tag'; return base; }
  if (!tag) { base.pending = 'untagged-cash-event'; return base; }
  base.tag = tag;
  if (tag.kind === 'FX' && account.custodian === 'NOAH-HK') { base.pending = 'fx-on-pool-account'; return base; }
  if (['EXT', 'XFER', 'CALL', 'INKIND'].includes(tag.kind)) {
    if (account.currency === 'USD') base.usd = round2(row.amount);
    else if (tag.usd !== null) base.usd = round2(Math.sign(row.amount) * tag.usd);
    else base.pending = 'usd-equivalent-pending';
  }
  return base;
}

// Resolve the classified rows of both pool accounts between the baseline close
// and the end date into pool flows, in-transit balances, verified calls and
// named pending days. Nothing here is inferred from one side alone.
//   rows         classifyCashRow output from every pool account
//   commitments  owner-declared capital-call commitments from the pending-calls
//                ledger, [{ id, fund, usd, date }], append-only, ids unique
//   levelChanges the owner's declared pending-call level changes, [{ date, deltaUsd }]
export function resolveCashEvents(rows, { baselineDate, endDate, commitments = [], levelChanges = [], transferWindowDays = TRANSFER_WINDOW_DAYS } = {}) {
  check(Array.isArray(rows) && validDate(baselineDate) && validDate(endDate) && baselineDate <= endDate, 'invalid resolution window');
  check(Array.isArray(commitments) && commitments.every(c => object(c) && typeof c.id === 'string' && REF_RE.test(c.id)
    && typeof c.fund === 'string' && c.fund && finite(c.usd) && c.usd > 0 && validDate(c.date)), 'invalid commitments');
  check(new Set(commitments.map(c => c.id)).size === commitments.length, 'commitment ids must be unique');
  check(Array.isArray(levelChanges) && levelChanges.every(c => object(c) && validDate(c.date) && finite(c.deltaUsd)), 'invalid level changes');
  check(Number.isSafeInteger(transferWindowDays) && transferWindowDays >= 0, 'invalid transfer window');
  const ids = new Set();
  for (const r of rows) { check(!ids.has(r.id), `duplicate row ${r.id}`); ids.add(r.id); }
  const inWindow = rows.filter(r => r.date > baselineDate && r.date <= endDate).sort((a, b) => a.date.localeCompare(b.date) || a.rowId - b.rowId);
  // One event reference names one event. Two rows of a non-transfer kind with
  // the same ev are a double booking or a copied tag, never two events; two
  // distinct rows on one day with one amount and their own evs are two events.
  const evCount = new Map();
  for (const r of inWindow) if (r.tag?.ev && r.tag.kind !== 'XFER' && !r.pending) evCount.set(r.tag.ev, (evCount.get(r.tag.ev) || 0) + 1);
  const duplicateEv = new Set([...evCount].filter(([, n]) => n > 1).map(([ev]) => ev));
  const flows = [], pending = [], inTransit = [], calls = [];
  const hold = (r, reason) => pending.push({ id: r.id, date: r.date, reason, ev: r.tag?.ev ?? null });
  const legsByEvent = new Map();
  const remaining = new Map(commitments.map(c => [c.id, c.usd]));
  const ledgerDecreases = levelChanges.filter(c => c.deltaUsd < 0).map(c => ({ ...c, used: false }));
  for (const r of inWindow) {
    if (r.pending) { hold(r, r.pending); continue; }
    if (r.category !== 'event') continue;
    const { kind } = r.tag;
    if (duplicateEv.has(r.tag.ev)) { hold(r, 'duplicate-event-ref'); continue; }
    if (kind === 'EXT' || kind === 'INKIND') { flows.push({ id: r.id, date: r.date, usd: r.usd, kind: 'external', custodian: r.custodian, ev: r.tag.ev }); continue; }
    if (kind === 'FX') continue; // a conversion inside one custodian: the IB NAV already carries it
    if (kind === 'ADJ') {
      // The official IB NAV never contained a bookkeeping row, so an IB-side
      // correction is not a pool event. On NOAH-HK the balance is the source
      // itself; what a correction means for the pool is the owner's to state.
      if (r.custodian === 'NOAH-HK') hold(r, 'adjustment-pending');
      continue;
    }
    if (kind === 'XFER') { legsByEvent.set(r.tag.ev, [...(legsByEvent.get(r.tag.ev) || []), r]); continue; }
    if (kind === 'CALL') {
      if (r.custodian !== 'NOAH-HK' || r.usd >= 0) { hold(r, 'call-unmatched'); continue; }
      const amount = -r.usd;
      // The commitment is named, not chosen: exactly the id the tag carries,
      // declared on or before the call, with enough left to cover it.
      const commitment = commitments.find(c => c.id === r.tag.commit);
      if (!commitment || commitment.date > r.date || remaining.get(commitment.id) + CENTS < amount
          || (r.tag.fund !== null && r.tag.fund !== commitment.fund)) { hold(r, 'call-unmatched'); continue; }
      // The cash leaving NOAH-HK is a pool outflow only together with the
      // owner's same-day level decrease of the same amount; until the ledger
      // carries that decrease the day stays pending rather than being netted.
      const declared = ledgerDecreases.find(c => !c.used && c.date === r.date && Math.abs(-c.deltaUsd - amount) <= CENTS);
      if (!declared) { hold(r, 'call-level-pending'); continue; }
      declared.used = true;
      remaining.set(commitment.id, round2(remaining.get(commitment.id) - amount));
      flows.push({ id: r.id, date: r.date, usd: r.usd, kind: 'external', custodian: r.custodian, ev: r.tag.ev });
      calls.push({ ev: r.tag.ev, commitmentId: commitment.id, fund: commitment.fund, date: r.date, usd: amount, levelChangeDate: declared.date });
      continue;
    }
    fail(`unhandled kind ${kind}`);
  }
  // Transfers: exactly two legs, one per custodian, opposite signs, equal USD
  // amounts, both with their own source row. Posting dates may differ within
  // the window; then the money in transit is a pool asset between the two
  // postings. One leg alone proves nothing and only holds the day.
  for (const [ev, legs] of legsByEvent) {
    if (legs.length === 1) { hold(legs[0], 'transfer-unpaired'); continue; }
    const out = legs.filter(l => l.usd < 0), inn = legs.filter(l => l.usd > 0);
    if (legs.length !== 2 || out.length !== 1 || inn.length !== 1 || out[0].custodian === inn[0].custodian || Math.abs(out[0].usd + inn[0].usd) > CENTS) {
      for (const l of legs) hold(l, 'transfer-mismatch');
      continue;
    }
    if (Math.abs(dayDiff(out[0].date, inn[0].date)) > transferWindowDays) { for (const l of legs) hold(l, 'transfer-unpaired'); continue; }
    if (out[0].date < inn[0].date) inTransit.push({ ev, from: out[0].date, to: inn[0].date, usd: -out[0].usd });
    else if (inn[0].date < out[0].date) inTransit.push({ ev, from: inn[0].date, to: out[0].date, usd: -inn[0].usd }); // arrived before it left
    // Both legs are recorded against their own custodian so the IB-side check
    // can explain its NAV jump; as pool flows they are internal and net to zero.
    for (const l of legs) flows.push({ id: l.id, date: l.date, usd: l.usd, kind: 'internal-transfer', custodian: l.custodian, ev });
  }
  const byDate = (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
  flows.sort(byDate); pending.sort(byDate);
  return { flows, inTransit, calls, pending, pendingDates: [...new Set(pending.map(p => p.date))].sort() };
}

// The flows the simulated accounts B and C receive: only money crossing the
// pool boundary. Internal transfer legs never reach them; the pool's own value
// carries the transfer through `inTransitOn` instead.
export function simulationFlows(flows) {
  check(Array.isArray(flows), 'invalid flows');
  return flows.filter(f => f.kind !== 'internal-transfer');
}

// The pool's in-transit asset on a date: paired transfers that have left one
// custodian and not yet posted at the other. `to` is exclusive.
export function inTransitOn(inTransit, date) {
  check(validDate(date), 'invalid date');
  return round2(inTransit.filter(t => t.from <= date && date < t.to).reduce((sum, t) => sum + t.usd, 0));
}

// The owner's IB-side ledger stays as the fallback for an event no Sharesight
// row describes. A ledger entry that a tagged IB-HK row already covers — same
// posting date, same signed USD amount, same kind family — is superseded one
// for one, so one event is never counted twice; every other ledger entry is
// kept. Two distinct rows on one day with one amount each consume their own
// ledger entry: matching is one to one, never by amount alone.
export function reconcileWithLedger(flows, ledgerFlows) {
  check(Array.isArray(flows) && Array.isArray(ledgerFlows), 'invalid reconciliation input');
  const pool = ledgerFlows.map(f => {
    check(object(f) && typeof f.id === 'string' && validDate(f.date) && ['in', 'out'].includes(f.direction)
      && finite(f.usd) && f.usd > 0 && ['external', 'transfer'].includes(f.kind), `invalid ledger flow ${f?.id}`);
    return { ...f, signed: f.direction === 'in' ? f.usd : -f.usd, used: false };
  });
  const superseded = [];
  for (const flow of flows) {
    if (flow.custodian !== 'IB-HK') continue;
    const family = flow.kind === 'internal-transfer' ? 'transfer' : flow.kind === 'external' ? 'external' : null;
    if (!family) continue;
    const match = pool.find(l => !l.used && l.kind === family && l.date === flow.date && Math.abs(l.signed - flow.usd) <= CENTS);
    if (match) { match.used = true; superseded.push({ ledgerId: match.id, rowId: flow.id, ev: flow.ev ?? null }); }
  }
  return { kept: pool.filter(l => !l.used).map(({ signed, used, ...l }) => l), superseded };
}
