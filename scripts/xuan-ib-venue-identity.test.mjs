import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createVenueIdentityResolver, emptyVenueIdentityResolver, describeVenuePair,
  listVenueEquivalences, readVenueIdentityPolicy, VenueIdentityException,
} from './xuan-ib-venue-identity.mjs';
import { applyDailyChangeColumn, buildDailyChangeColumn, identityKey } from './xuan-ib-daily-change.mjs';
import { measurePositionCompletedSessionChange, normalizeDailyChangeWindow,
  normalizePositions } from './xuan-ib-source-adapter.mjs';

const deployed = readVenueIdentityPolicy();
const resolver = createVenueIdentityResolver();

// Synthetic registry material. None of the identifiers below is a real
// contract; the deployed file is read separately and never rewritten here.
const entry = (over = {}) => ({
  instrumentRef: 'VENUE-20260911-ZZZ', basis: 'dual-source-identity',
  reviewedOn: '2026-09-11', evidenceRef: 'synthetic-test',
  canonical: { venue: 'EURONEXT', code: 'ZZZ' },
  endpoints: [
    { source: 'ib', identityField: 'contract_id', identityValue: '111', venue: 'EBS', code: 'ZZZUSD' },
    { source: 'sharesight', identityField: 'instrument.id', identityValue: '222', portfolioId: '936247',
      venue: 'EURONEXT', code: 'ZZZ' },
  ],
  ...over,
});
const policyWith = (instruments) => ({
  schemaVersion: 1, policyId: 'xuan-ib-venue-identity-v1', effectiveDate: '2026-09-11',
  purpose: 'instrument-scoped-venue-identity-only',
  authority: 'reviewed-maintenance-under-publication-lock',
  blanketVenueAliases: false, crossCustodianVenueInference: false, financialWrites: false,
  instruments,
});
const writePolicy = (value) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venue-identity-'));
  const file = path.join(dir, 'policy.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};

test('an equivalence is scoped to one instrument, never to a pair of venues', () => {
  const scoped = createVenueIdentityResolver(policyWith([entry()]));
  // The exact reviewed instrument resolves in both directions.
  assert.equal(scoped.canonicalKey('EBS:ZZZUSD'), 'EURONEXT:ZZZ');
  assert.equal(scoped.canonicalKey('EURONEXT:ZZZ'), 'EURONEXT:ZZZ');
  assert.ok(scoped.isReviewedPair('EBS:ZZZUSD', 'EURONEXT:ZZZ'));
  // Another instrument that merely happens to trade on both venues is NOT
  // aliased: EBS and EURONEXT stay different exchanges, and treating them as
  // synonyms would silently merge every future instrument listed on both.
  assert.equal(scoped.canonicalKey('EBS:OTHER'), 'EBS:OTHER');
  assert.equal(scoped.canonicalKey('EURONEXT:OTHER'), 'EURONEXT:OTHER');
  assert.equal(scoped.isReviewedPair('EBS:OTHER', 'EURONEXT:OTHER'), false);
  // Nor is a shared ticker on an unreviewed venue enough.
  assert.equal(scoped.canonicalKey('XETRA:ZZZ'), 'XETRA:ZZZ');
  assert.equal(scoped.isReviewedPair('XETRA:ZZZ', 'EURONEXT:ZZZ'), false);
});

test('the strong identifier each payload already carries resolves without any venue inference', () => {
  const scoped = createVenueIdentityResolver(policyWith([entry()]));
  assert.equal(scoped.canonicalKeyForSource('ib', '111'), 'EURONEXT:ZZZ');
  assert.equal(scoped.canonicalKeyForSource('sharesight', '222'), 'EURONEXT:ZZZ');
  // An identifier the registry does not record resolves to nothing at all,
  // rather than to a venue borrowed from some other book.
  assert.equal(scoped.canonicalKeyForSource('ib', '999'), null);
  assert.throws(() => scoped.canonicalKeyForSource('webull', '111'), /ENDPOINT_SOURCE_UNSUPPORTED/);
});

test('a registry that is not instrument-scoped, or not evidence-bound, is refused whole', () => {
  const refuse = (instruments, pattern) => assert.throws(
    () => createVenueIdentityResolver(policyWith(instruments)), pattern);
  // A blanket venue alias has no instrument code and is exactly what this
  // module exists not to be.
  refuse([entry({ endpoints: [{ source: 'ib', identityField: 'contract_id', identityValue: '111', venue: 'EBS', code: '' },
    entry().endpoints[1]] })], /ENDPOINT_CODE_REQUIRED/);
  // The identifier must be the one that source actually publishes.
  refuse([entry({ endpoints: [{ ...entry().endpoints[0], identityField: 'instrument.id' }, entry().endpoints[1]] })],
    /ENDPOINT_IDENTITY_FIELD_INVALID/);
  // The canonical identity must be one the sources published, not a third
  // spelling the registry invented.
  refuse([entry({ canonical: { venue: 'XETRA', code: 'ZZZ' } })], /ENTRY_CANONICAL_UNSOURCED/);
  // Endpoints of one entry must describe one instrument.
  refuse([entry({ endpoints: [{ ...entry().endpoints[0], code: 'QQQUSD' }, entry().endpoints[1]] })], /ENTRY_CODES_DISAGREE/);
  // The review date is part of the record, not decoration.
  refuse([entry({ reviewedOn: '2026-09-10' })], /ENTRY_REVIEW_DATE_MISMATCH/);
  refuse([entry({ evidenceRef: '' })], /ENTRY_EVIDENCE_REQUIRED/);
  // One key, and one source identifier, may belong to at most one instrument.
  refuse([entry(), entry({ instrumentRef: 'VENUE-20260911-ZZZB', basis: 'reviewed-single-source',
    canonical: { venue: 'EBS', code: 'ZZZUSD' },
    endpoints: [{ ...entry().endpoints[0], identityValue: '333' }] })], /POLICY_DUPLICATE_ENDPOINT/);
  refuse([entry(), entry({ instrumentRef: 'VENUE-20260911-ZZZC', basis: 'reviewed-single-source',
    canonical: { venue: 'BATS', code: 'ZZZUSD' },
    endpoints: [{ ...entry().endpoints[0], venue: null }] })], /POLICY_DUPLICATE_SOURCE_IDENTITY/);
  // An unknown key could carry a condition this reader does not enforce.
  refuse([entry({ instrumentRef: 'VENUE-20260911-ZZZ', basis: 'dual-source-identity', canonical: { venue: 'EURONEXT', code: 'ZZZ' },
    endpoints: entry().endpoints, reviewedOn: '2026-09-11', evidenceRef: 'synthetic-test', wildcard: true })],
  /ENTRY_UNKNOWN_FIELD/);
  for (const claim of [{ blanketVenueAliases: true }, { crossCustodianVenueInference: true },
    { financialWrites: true }, { purpose: 'anything-else' }]) {
    assert.throws(() => createVenueIdentityResolver({ ...policyWith([entry()]), ...claim }), /POLICY_MISMATCH/);
  }
  assert.throws(() => readVenueIdentityPolicy({ path: writePolicy({ ...policyWith([entry()]), extra: 1 }) }),
    /POLICY_UNKNOWN_FIELD/);
  assert.throws(() => readVenueIdentityPolicy({ path: '/nonexistent/venue.json' }), /POLICY_UNREADABLE/);
});

test('every refusal is a Codex technical exception, never an owner decision', () => {
  assert.throws(() => createVenueIdentityResolver(policyWith([entry({ reviewedOn: '2026-09-10' })])), (error) => {
    assert.ok(error instanceof VenueIdentityException);
    assert.equal(error.owner, 'Codex');
    assert.equal(error.requiresOwnerDecision, false);
    assert.equal(typeof error.code, 'string');
    return true;
  });
});

test('the deployed registry is reviewed, evidence-bound and free of blanket aliases', () => {
  assert.equal(deployed.blanketVenueAliases, false);
  assert.equal(deployed.crossCustodianVenueInference, false);
  assert.equal(deployed.financialWrites, false);
  const entries = listVenueEquivalences(deployed);
  assert.ok(entries.length > 0);
  for (const item of entries) {
    assert.ok(item.entry.evidenceRef, `${item.entry.instrumentRef} records the evidence it was reviewed against`);
    for (const endpoint of item.endpoints) assert.ok(endpoint.canonicalCode, 'every endpoint names an instrument');
  }
  // The 2026-09-11 case: IB described the instrument as HODLUSD on EBS while
  // the portfolio source reported HODL on EURONEXT. The two are joined only
  // through this one reviewed instrument entry.
  assert.equal(resolver.canonicalKey('EBS:HODLUSD'), 'EURONEXT:HODL');
  assert.equal(resolver.instrumentRefFor('EBS:HODLUSD'), 'VENUE-20260911-HODL');
  // And EBS is still not EURONEXT for anything else.
  assert.equal(resolver.canonicalKey('EBS:EQAC'), 'SWX:EQAC');
  assert.equal(resolver.isReviewedPair('EBS:EQAC', 'EURONEXT:EQAC'), false);
});

test('the real HODL merge joins only through the reviewed entry, and an unreviewed pair is named', () => {
  const session = '2026-09-10';
  const raw = { result: { mode: 'read_only', portfolio: { id: 936247, currency_code: 'USD' },
    data: { report: { portfolio_id: 936247, value: 100, currency: { code: 'USD' },
      start_date: session, end_date: session, percentages_annualised: false, cash_accounts: [],
      holdings: [{ instrument: { code: 'HODL', market_code: 'EURONEXT', id: 2751250 },
        capital_gain_percent: 1.75, currency_gain_percent: 0 }] } } } };
  const measurements = normalizeDailyChangeWindow(raw, { date: session, venuesComplete: ['EURONEXT'] });
  const column = buildDailyChangeColumn({ edition: 'am', method: 'window-v1', dataDate: '2026-09-11',
    intendedSessionDate: session, measurements, venueIdentity: resolver });
  assert.equal(column.coverage.available, 1);
  const view = [{ symbol: 'HODLUSD', market: 'EBS', quantity: 1, price: 10, priceCurrency: 'USD',
    marketValueUsd: 10, changePct: null, changeAsOfHkt: null, quoteStatus: 'unavailable' }];
  const merged = applyDailyChangeColumn(view, column, { venueOf: row => row.market, venueIdentity: resolver });
  assert.equal(merged[0].changePct, 1.75);
  // Without the reviewed entry the same two rows must NOT join. The merge stays
  // fail-closed and names the pairing nobody reviewed instead of performing it.
  assert.throws(() => applyDailyChangeColumn(view, buildDailyChangeColumn({ edition: 'am', method: 'window-v1',
    dataDate: '2026-09-11', intendedSessionDate: session, measurements }), { venueOf: row => row.market }),
  /COLUMN_MERGE_INCOMPLETE/);
  // A ticker match alone never produces an alias: an unreviewed cross-venue
  // pairing of the same code is disclosed by name and refused.
  const plainRaw = structuredClone(raw);
  plainRaw.result.data.report.holdings[0].instrument = { code: 'HODL', market_code: 'XETRA', id: 999 };
  const unreviewed = buildDailyChangeColumn({ edition: 'am', method: 'window-v1', dataDate: '2026-09-11',
    intendedSessionDate: session,
    measurements: normalizeDailyChangeWindow(plainRaw, { date: session, venuesComplete: ['XETRA'] }),
    venueIdentity: resolver });
  assert.throws(() => applyDailyChangeColumn(
    [{ ...view[0], symbol: 'HODL', market: 'EURONEXT' }], unreviewed,
    { venueOf: row => row.market, venueIdentity: resolver }),
  /COLUMN_MERGE_INCOMPLETE \(unreviewed venue pair: EURONEXT:HODL~XETRA:HODL\)/);
});

test('an empty resolver changes nothing, and pair labels are order independent', () => {
  const none = emptyVenueIdentityResolver();
  assert.equal(none.canonicalKey('EBS:HODLUSD'), 'EBS:HODLUSD');
  assert.equal(none.canonicalKeyForSource('ib', '343126962'), null);
  assert.equal(none.isReviewedPair('EBS:HODLUSD', 'EURONEXT:HODL'), false);
  assert.equal(describeVenuePair('EURONEXT:HODL', 'EBS:HODLUSD'), describeVenuePair('EBS:HODLUSD', 'EURONEXT:HODL'));
  assert.equal(identityKey({ venue: 'EBS', code: 'HODLUSD' }), 'EBS:HODLUSD');
});

// The strong-identity path, exercised through the production adapters from
// raw-shaped payloads rather than through hand-built measurement rows.
//
// This is the join the whole repair exists for. Before it, pairing HODL needed
// something upstream to have already decided that this IB row belongs to `EBS`
// and that `EBS` is the same instrument as the portfolio source's `EURONEXT` —
// the run-local venue inference the registry refuses to reintroduce. The
// identifiers both payloads already publish make that decision unnecessary.
const HODL_SESSION = '2026-09-10';
const hodlIbPayload = (over = {}) => ({ positions: [{
  contract_id: 343126962, contract_description: 'HODLUSD',
  position: 100, market_price: 20, market_value: 2000, currency: 'USD', daily_pnl: 40, ...over }] });
const hodlWindowPayload = (instrument) => ({ result: { mode: 'read_only',
  portfolio: { id: 936247, currency_code: 'USD' },
  data: { report: { portfolio_id: 936247, value: 100, currency: { code: 'USD' },
    start_date: HODL_SESSION, end_date: HODL_SESSION, percentages_annualised: false, cash_accounts: [],
    holdings: [{ instrument, capital_gain_percent: 2.04, currency_gain_percent: 0 }] } } } });

test('HODL joins through the identifiers both payloads publish, with no venue string in the match', () => {
  const [position] = normalizePositions(hodlIbPayload());
  // Preserved verbatim from the raw payload, which is what makes the rest
  // possible at all.
  assert.equal(position.contractId, '343126962');
  const ibRow = (venue, code) => measurePositionCompletedSessionChange(position, {
    venue, code, sessionDate: HODL_SESSION, venuesComplete: [venue], observedAtHkt: '2026-09-11 08:00 HKT' });
  const windowRows = normalizeDailyChangeWindow(
    hodlWindowPayload({ code: 'HODL', market_code: 'EURONEXT', id: 2751250 }),
    { date: HODL_SESSION, venuesComplete: ['EURONEXT'] });
  assert.deepEqual([windowRows[0].identitySource, windowRows[0].identityValue], ['sharesight', '2751250']);
  const column = (fallback, venueIdentity) => buildDailyChangeColumn({ edition: 'am', method: 'window-v1',
    dataDate: '2026-09-11', intendedSessionDate: HODL_SESSION, measurements: windowRows,
    fallbackMeasurements: fallback, venueIdentity });

  // Both books, spelling the instrument differently, resolve to one canonical
  // identity and corroborate each other.
  const joined = column([ibRow('EBS', 'HODLUSD')], resolver);
  assert.equal(joined.rows.length, 1);
  assert.equal(joined.rows[0].canonicalKey, 'EURONEXT:HODL');
  assert.equal(joined.rows[0].corroboratedBy, 'am-session-pnl-v1');

  // The decisive case: scramble the venue AND the code on the IB side, so that
  // no venue+code key on either side could possibly match, and the same join
  // still happens. Nothing about an exchange string took part in it — only the
  // contract id and the portfolio source's instrument id.
  const scrambled = { ...ibRow('ZZZZ', 'HODLUSD'), code: 'NOTATICKER' };
  const byIdAlone = column([scrambled], resolver);
  assert.equal(byIdAlone.rows.length, 1);
  assert.equal(byIdAlone.rows[0].canonicalKey, 'EURONEXT:HODL');
  assert.equal(byIdAlone.rows[0].corroboratedBy, 'am-session-pnl-v1');

  // Without the reviewed registry the identifiers resolve to nothing and the
  // two readings stay two separate instruments, exactly as they must.
  const unreviewed = column([ibRow('EBS', 'HODLUSD')], emptyVenueIdentityResolver());
  assert.deepEqual(unreviewed.rows.map(row => row.canonicalKey).sort(), ['EBS:HODLUSD', 'EURONEXT:HODL']);

  // The merge onto view rows follows the same precedence: a view row carrying
  // its source's own identifier matches by that identifier, whatever exchange
  // string the page happens to show.
  const view = [{ symbol: 'WRONGSYM', market: 'WRONGVENUE', quantity: 1, price: 10, priceCurrency: 'USD',
    marketValueUsd: 10, changePct: null, changeAsOfHkt: null, quoteStatus: 'unavailable' }];
  const merged = applyDailyChangeColumn(view, joined, { venueOf: row => row.market, venueIdentity: resolver,
    identityOf: () => ({ source: 'sharesight', value: '2751250' }) });
  assert.equal(merged[0].changePct, 2.04);
  // And with no identifier supplied, that same deliberately wrong view row
  // cannot match anything, so the merge stays fail-closed rather than guessing.
  assert.throws(() => applyDailyChangeColumn(view, joined,
    { venueOf: row => row.market, venueIdentity: resolver }), /COLUMN_MERGE_INCOMPLETE/);
});

test('a row with no strong identity still falls back to reviewed venue+code equivalence', () => {
  // Same instrument, but the IB payload publishes no contract id at all — the
  // ordinary case for a book that omits it. The venue+code path is then the
  // best evidence there is, and the reviewed entry is what joins `EBS:HODLUSD`
  // to `EURONEXT:HODL`.
  const [position] = normalizePositions(hodlIbPayload({ contract_id: null }));
  assert.equal(position.contractId, null);
  const ibRow = measurePositionCompletedSessionChange(position, { venue: 'EBS', code: 'HODLUSD',
    sessionDate: HODL_SESSION, venuesComplete: ['EBS'], observedAtHkt: '2026-09-11 08:00 HKT' });
  assert.equal(ibRow.identityValue, null);
  const column = buildDailyChangeColumn({ edition: 'am', method: 'window-v1', dataDate: '2026-09-11',
    intendedSessionDate: HODL_SESSION,
    measurements: normalizeDailyChangeWindow(
      hodlWindowPayload({ code: 'HODL', market_code: 'EURONEXT', id: 2751250 }),
      { date: HODL_SESSION, venuesComplete: ['EURONEXT'] }),
    fallbackMeasurements: [ibRow], venueIdentity: resolver });
  assert.equal(column.rows.length, 1);
  assert.equal(column.rows[0].canonicalKey, 'EURONEXT:HODL');
  assert.equal(column.rows[0].corroboratedBy, 'am-session-pnl-v1');

  // An instrument no reviewed entry records still joins when both books spell
  // it the same way, which is the plain venue+code case working unchanged.
  const agreeing = buildDailyChangeColumn({ edition: 'am', method: 'window-v1', dataDate: '2026-09-11',
    intendedSessionDate: HODL_SESSION,
    measurements: normalizeDailyChangeWindow(
      hodlWindowPayload({ code: 'ZZTEST', market_code: 'NASDAQ', id: 99000001 }),
      { date: HODL_SESSION, venuesComplete: ['NASDAQ'] }),
    fallbackMeasurements: [measurePositionCompletedSessionChange(position, { venue: 'NASDAQ', code: 'ZZTEST',
      sessionDate: HODL_SESSION, venuesComplete: ['NASDAQ'], observedAtHkt: '2026-09-11 08:00 HKT' })],
    venueIdentity: resolver });
  assert.equal(agreeing.rows.length, 1);
  assert.equal(agreeing.rows[0].canonicalKey, 'NASDAQ:ZZTEST');
  assert.equal(agreeing.rows[0].corroboratedBy, 'am-session-pnl-v1');
});

test('SGOV keeps its reviewed single-source entry once strong identity is primary', () => {
  // SGOV is the other evidenced case, and it is distinct from HODL: only the
  // broker's book carried it in the reviewed run, and that book publishes no
  // exchange for it. Its endpoint therefore contributes NO venue+code key at
  // all, so the entry is load-bearing in exactly one way — it is the only thing
  // that maps the contract id to a canonical identity. Removing or weakening it
  // would leave an SGOV row unresolvable rather than merely redundant.
  const sgov = listVenueEquivalences(deployed).find(item => item.entry.instrumentRef === 'VENUE-20260911-SGOV');
  assert.equal(sgov.entry.basis, 'reviewed-single-source');
  assert.equal(sgov.endpoints.length, 1);
  assert.equal(sgov.endpoints[0].venue, null);
  assert.equal(sgov.endpoints[0].key, null, 'a venueless endpoint contributes no venue+code key');
  assert.equal(resolver.canonicalKeyForSource('ib', sgov.endpoints[0].identityValue), 'NYSE:SGOV');
  // The portfolio source has no SGOV endpoint here, so its own row still
  // resolves by the venue+code it publishes, which is the canonical identity.
  assert.equal(resolver.canonicalKeyForSource('sharesight', sgov.endpoints[0].identityValue), null);
  assert.equal(resolver.canonicalKey('NYSE:SGOV'), 'NYSE:SGOV');
});
