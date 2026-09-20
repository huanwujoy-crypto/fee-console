import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAbcTag, formatAbcTag, tagDescription, planDescriptionUpdate, classifyCashRow, resolveCashEvents, simulationFlows, inTransitOn,
  reconcileWithLedger, PENDING_REASONS, TAG_KINDS, MAX_DESCRIPTION_LENGTH, MAX_TAG_LENGTH, TRANSFER_WINDOW_DAYS,
} from './xuan-ib-abc-cash-tags.mjs';

const IB = { id: 135339, custodian: 'IB-HK', currency: 'USD' };
const IB_CAD = { id: 155270, custodian: 'IB-HK', currency: 'CAD' };
const NOAH = { id: 142903, custodian: 'NOAH-HK', currency: 'USD' };
let nextId = 1000;
const row = (account, { date, amount, type = amount < 0 ? 'WITHDRAWAL' : 'DEPOSIT', description = '', foreign = null }) => ({
  id: nextId++, description, date_time: `${date}T04:00:00.000Z`, amount, balance: 0, cash_account_id: account.id,
  foreign_identifier: foreign, holding_id: null, trade_id: null, payout_id: null, cash_account_transaction_type: { name: type },
});
const classify = (account, spec) => classifyCashRow(row(account, spec), account);
const resolve = (rows, extra = {}) => resolveCashEvents(rows, { baselineDate: '2026-09-17', endDate: '2026-09-30', ...extra });
const reasons = r => r.pending.map(p => p.reason);

test('grammar: one bracketed group, version, kind, ev on every kind, typed fields, direction never restated', () => {
  assert.equal(parseAbcTag('Buy trade of 200 USSC.LSE shares'), null);
  assert.equal(parseAbcTag(''), null);
  assert.equal(parseAbcTag(undefined), null);
  const tag = parseAbcTag('NOAH-HK PN004779 external withdrawal to HSBC [ABC1 EXT ev:NHK-20260916-124603] … completed 14:49 HKT');
  assert.deepEqual({ ...tag, raw: undefined }, { version: 'ABC1', kind: 'EXT', ev: 'NHK-20260916-124603', usd: null, commit: null, fund: null, raw: undefined });
  assert.equal(parseAbcTag('[ABC1 XFER ev:X-20260920-A] transfer').ev, 'X-20260920-A');
  assert.equal(parseAbcTag('[ABC1 EXT ev:E-1234 usd:241.78] CAD 338.46 from HSBC').usd, 241.78);
  const call = parseAbcTag('[ABC1 CALL ev:CALL-HL3-20261001 commit:COMMIT-HL3-1 fund:HIGHLAND3]');
  assert.deepEqual([call.commit, call.fund], ['COMMIT-HL3-1', 'HIGHLAND3']);
  for (const kind of TAG_KINDS) assert.equal(parseAbcTag(`[ABC1 ${kind} ev:E-0001${kind === 'CALL' ? ' commit:C-0001' : ''}]`).kind, kind);
  for (const bad of [
    '[ABC1 EXT ev:E-0001', '[ABC1 EXT ev:E-0001] and [ABC1 EXT ev:E-0002]', '[ABC2 EXT ev:E-0001]', '[ABC1 PAY ev:E-0001]', '[ABC1 EXT]',
    '[ABC1 EXT OUT ev:E-0001]', '[ABC1 EXT ev:ab]', '[ABC1 EXT ev:a b]', '[ABC1 EXT ev:E-0001 usd:12]', '[ABC1 EXT ev:E-0001 usd:-12.00]',
    '[ABC1 EXT ev:E-0001 usd:0.00]', '[ABC1 EXT ev:E-0001 ev:E-0002]', '[ABC1 CALL ev:E-0001]', '[ABC1 CALL commit:C-1]', '[ABC1 EXT ev:E-0001 commit:C-0001]',
    '[ABC1 XFER ev:E-0001 fund:F1]', '[ABC1 ADJ ev:E-0001 usd:1.00]', '[ABC1 FX ev:E-0001 usd:1.00]', '[ABC1 EXT ev:E-0001 note:x]',
    `[ABC1 EXT ev:${'a'.repeat(65)}]`, `[ABC1 EXT ${'ev:E-0001 '.repeat(20)}]`,
  ]) assert.throws(() => parseAbcTag(bad), bad);
});

test('formatter and description-only update: canonical tag, original text and identity preserved, 255 kept, idempotent', () => {
  assert.equal(formatAbcTag({ kind: 'EXT', ev: 'E-0001' }), '[ABC1 EXT ev:E-0001]');
  assert.equal(formatAbcTag({ kind: 'EXT', ev: 'E-0001', usd: 241.78 }), '[ABC1 EXT ev:E-0001 usd:241.78]');
  assert.equal(formatAbcTag({ kind: 'CALL', ev: 'C-0001', commit: 'COMMIT-1', fund: 'HIGHLAND3' }), '[ABC1 CALL ev:C-0001 commit:COMMIT-1 fund:HIGHLAND3]');
  assert.ok(formatAbcTag({ kind: 'CALL', ev: 'x'.repeat(40), commit: 'y'.repeat(40), fund: 'HIGHLAND3' }).length <= MAX_TAG_LENGTH);
  assert.throws(() => formatAbcTag({ kind: 'CALL', ev: 'x'.repeat(64), commit: 'y'.repeat(64), fund: 'z'.repeat(64), usd: 1e12 }), /oversized/);
  for (const bad of [{ kind: 'EXT' }, { kind: 'NOPE', ev: 'E-0001' }, { kind: 'EXT', ev: 'E-0001', usd: 1.005 }, { kind: 'EXT', ev: 'E-0001', usd: -1 },
    { kind: 'CALL', ev: 'C-0001' }, { kind: 'EXT', ev: 'E-0001', commit: 'C-1' }, { kind: 'ADJ', ev: 'A-0001', usd: 1 }]) assert.throws(() => formatAbcTag(bad), JSON.stringify(bad));
  const original = 'NOAH-HK PN004779 external withdrawal to HSBC; iARK Funds Records 提取资金 USD 300000.00, requested 2026-09-16 12:46:03 HKT, completed 2026-09-16 14:49:11 HKT; unique ref NHK-PN004779-20260916-124603-300000; Todayda sale is internal cash-equivalent transfer';
  assert.ok(original.length > 200 && original.length <= MAX_DESCRIPTION_LENGTH, 'a real Sharesight description near the limit');
  const tagged = tagDescription(original, { kind: 'EXT', ev: 'NHK-PN004779-20260916-124603-300000' });
  assert.equal(tagged.length, MAX_DESCRIPTION_LENGTH);
  assert.ok(tagged.startsWith('[ABC1 EXT ev:NHK-PN004779-20260916-124603-300000] NOAH-HK PN004779 external withdrawal to HSBC'));
  assert.equal(parseAbcTag(tagged).ev, 'NHK-PN004779-20260916-124603-300000');
  assert.equal(tagDescription('', '[ABC1 FX ev:FX-0001]'), '[ABC1 FX ev:FX-0001]');
  assert.equal(tagDescription(undefined, { kind: 'FX', ev: 'FX-0001' }), '[ABC1 FX ev:FX-0001]');
  // Idempotent on the same tag, refused on a different one or a malformed existing one.
  assert.equal(tagDescription(tagged, { kind: 'EXT', ev: 'NHK-PN004779-20260916-124603-300000' }), tagged);
  assert.throws(() => tagDescription(tagged, { kind: 'XFER', ev: 'NHK-PN004779-20260916-124603-300000' }), /different ABC tag/);
  assert.throws(() => tagDescription('[ABC1 EXT broken', { kind: 'EXT', ev: 'E-0001' }));
  // The plan is a description-only update of the existing transaction id: nothing else is touched.
  const existing = row(IB, { date: '2026-09-18', amount: 200000, description: '', foreign: 'ibkr.cash:keep-me' });
  const plan = planDescriptionUpdate(existing, { kind: 'EXT', ev: 'IB-20260918-200000' });
  assert.deepEqual(plan, { transactionId: existing.id, description: '[ABC1 EXT ev:IB-20260918-200000]', changed: true, mode: 'description-only' });
  assert.deepEqual(Object.keys(plan).sort(), ['changed', 'description', 'mode', 'transactionId']);
  assert.equal(existing.foreign_identifier, 'ibkr.cash:keep-me'); assert.equal(existing.description, '');
  assert.equal(planDescriptionUpdate({ ...existing, description: plan.description }, { kind: 'EXT', ev: 'IB-20260918-200000' }).changed, false);
});

test('classification: return rows take no tag, cash events need one, unknown types are named', () => {
  const trade = classify(IB, { date: '2026-09-18', amount: -18232.56, type: 'Buy Trade', description: 'Buy trade of 200 USSC.LSE shares' });
  assert.equal(trade.category, 'return'); assert.equal(trade.pending, null);
  const interest = classify(IB, { date: '2026-09-18', amount: 1144.18, type: 'INTEREST_PAYMENT', description: 'IB broker interest received [4935797191]', foreign: 'ibkr.cash:4ad9' });
  assert.equal(interest.category, 'return'); assert.equal(interest.pending, null); assert.equal(interest.foreignIdentifier, 'ibkr.cash:4ad9');
  assert.equal(classify(IB, { date: '2026-09-18', amount: 33.88, type: 'Payout', description: 'Payout from GOOG.NASDAQ [ABC1 EXT ev:E-0001]' }).pending, 'tag-on-return-row');
  const untagged = classify(IB, { date: '2026-09-18', amount: 200000, description: '' });
  assert.equal(untagged.category, 'event'); assert.equal(untagged.pending, 'untagged-cash-event'); assert.equal(untagged.usd, null);
  assert.equal(classify(IB, { date: '2026-09-18', amount: 5, description: '[ABC1 EXT' }).pending, 'malformed-tag');
  assert.equal(classify(IB, { date: '2026-09-18', amount: 5, type: 'SOMETHING_NEW', description: '[ABC1 EXT ev:E-0001]' }).pending, 'unknown-row-type');
  const ext = classify(IB, { date: '2026-09-18', amount: -100000, description: 'for UBS [ABC1 EXT ev:IB-20260918-UBS]' });
  assert.equal(ext.pending, null); assert.equal(ext.usd, -100000); assert.equal(ext.tag.kind, 'EXT'); assert.equal(ext.id, `SS-${ext.rowId}`);
  assert.throws(() => classifyCashRow(row(IB, { date: '2026-09-18', amount: 1 }), NOAH), /not on a declared pool account/);
});

test('a private-fund distribution arriving in NOAH-HK cash is a boundary inflow, whatever its wording says', () => {
  const distribution = classify(NOAH, { date: '2026-09-22', amount: 13590.65, description: '[ABC1 EXT ev:NHK-20260922-HIGHLAND3] Highland Fund 3 capital return USD 1223.16 plus income distribution USD 12367.49; accounting cash receipt, not external contribution' });
  assert.equal(distribution.pending, null);
  assert.deepEqual(resolve([distribution]).flows, [{ id: distribution.id, date: '2026-09-22', usd: 13590.65, kind: 'external', custodian: 'NOAH-HK', ev: 'NHK-20260922-HIGHLAND3' }]);
  // An untagged one is not silently a flow either: it is named until tagged.
  assert.deepEqual(reasons(resolve([classify(NOAH, { date: '2026-09-22', amount: 15908.29, description: 'Blackstone capital + income | ref NHK-20260910-15908.29-v1' })])), ['untagged-cash-event']);
});

test('non-USD accounts: FX is never a pool event, a pool event needs usd:, small CAD FX is not forced into ADJ', () => {
  const fx = classify(IB_CAD, { date: '2026-09-19', amount: 338.46, description: '[ABC1 FX ev:FX-20260919-CAD] USD→CAD conversion' });
  assert.equal(fx.pending, null); assert.equal(fx.usd, null); assert.equal(fx.tag.kind, 'FX');
  assert.equal(classify(IB_CAD, { date: '2026-09-19', amount: 338.46, description: '[ABC1 EXT ev:E-0001] CAD from HSBC' }).pending, 'usd-equivalent-pending');
  const withUsd = classify(IB_CAD, { date: '2026-09-19', amount: -338.46, description: '[ABC1 EXT ev:E-0002 usd:241.78] CAD to HSBC' });
  assert.equal(withUsd.pending, null); assert.equal(withUsd.usd, -241.78);
  assert.equal(classify(NOAH, { date: '2026-09-19', amount: 1, description: '[ABC1 FX ev:FX-0001]' }).pending, 'fx-on-pool-account');
  assert.deepEqual(resolve([fx]), { flows: [], inTransit: [], calls: [], pending: [], pendingDates: [] });
});

test('transfers need both legs with source rows; posting dates may differ and the money in transit stays in A only', () => {
  const out = classify(IB, { date: '2026-09-21', amount: -300000, description: '[ABC1 XFER ev:X-20260921-IB-NHK] to NOAH-HK', foreign: 'ibkr.cash:aaa' });
  const inn = classify(NOAH, { date: '2026-09-23', amount: 300000, description: 'from IB-HK [ABC1 XFER ev:X-20260921-IB-NHK]', foreign: 'noah-sync:bbb' });
  assert.notEqual(out.foreignIdentifier, inn.foreignIdentifier);
  const r = resolve([out, inn]);
  assert.deepEqual(r.pending, []);
  assert.deepEqual(r.flows.map(f => [f.date, f.usd, f.kind, f.custodian]), [['2026-09-21', -300000, 'internal-transfer', 'IB-HK'], ['2026-09-23', 300000, 'internal-transfer', 'NOAH-HK']]);
  assert.deepEqual(r.inTransit, [{ ev: 'X-20260921-IB-NHK', from: '2026-09-21', to: '2026-09-23', usd: 300000 }]);
  assert.deepEqual([ '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23'].map(d => inTransitOn(r.inTransit, d)), [0, 300000, 300000, 0]);
  // No double count: A carries the transfer through transit; B and C see no flow at all.
  assert.deepEqual(simulationFlows(r.flows), []);
  const ibNav = { '2026-09-20': 5000000, '2026-09-21': 4700000, '2026-09-22': 4700000, '2026-09-23': 4700000 };
  const noahCash = { '2026-09-20': 87468.22, '2026-09-21': 87468.22, '2026-09-22': 87468.22, '2026-09-23': 387468.22 };
  const pool = d => ibNav[d] + noahCash[d] + inTransitOn(r.inTransit, d);
  for (const d of Object.keys(ibNav)) assert.equal(pool(d), 5087468.22, d);
  // Same-day legs: no transit, still internal only.
  const same = resolve([out, classify(NOAH, { date: '2026-09-21', amount: 300000, description: '[ABC1 XFER ev:X-20260921-IB-NHK]' })]);
  assert.deepEqual(same.inTransit, []); assert.equal(same.flows.length, 2); assert.deepEqual(simulationFlows(same.flows), []);
  // Arrived before it left: negative transit so the pool is not counted twice.
  const early = resolve([classify(IB, { date: '2026-09-24', amount: -1000, description: '[ABC1 XFER ev:X-E001]' }), classify(NOAH, { date: '2026-09-22', amount: 1000, description: '[ABC1 XFER ev:X-E001]' })]);
  assert.deepEqual(early.inTransit, [{ ev: 'X-E001', from: '2026-09-22', to: '2026-09-24', usd: -1000 }]);
});

test('one transfer leg alone is only pending, never an inferred asset; mismatched legs are named, never netted', () => {
  const out = classify(IB, { date: '2026-09-21', amount: -300000, description: '[ABC1 XFER ev:X-0001]' });
  for (const endDate of ['2026-09-21', '2026-09-26', '2026-10-15']) {
    const r = resolveCashEvents([out], { baselineDate: '2026-09-17', endDate });
    assert.deepEqual(reasons(r), ['transfer-unpaired'], endDate); assert.deepEqual(r.inTransit, []); assert.deepEqual(r.flows, []);
  }
  assert.deepEqual(reasons(resolve([classify(NOAH, { date: '2026-09-21', amount: 5000, description: '[ABC1 XFER ev:X-0002]' })])), ['transfer-unpaired']);
  for (const legs of [
    [classify(IB, { date: '2026-09-21', amount: -300000, description: '[ABC1 XFER ev:X-0003]' }), classify(NOAH, { date: '2026-09-21', amount: 299000, description: '[ABC1 XFER ev:X-0003]' })],
    [classify(IB, { date: '2026-09-21', amount: -300000, description: '[ABC1 XFER ev:X-0004]' }), classify(IB, { date: '2026-09-21', amount: 300000, description: '[ABC1 XFER ev:X-0004]' })],
    [classify(IB, { date: '2026-09-21', amount: -300000, description: '[ABC1 XFER ev:X-0005]' }), classify(NOAH, { date: '2026-09-21', amount: -300000, description: '[ABC1 XFER ev:X-0005]' })],
    [classify(IB, { date: '2026-09-21', amount: -1, description: '[ABC1 XFER ev:X-0006]' }), classify(NOAH, { date: '2026-09-21', amount: 1, description: '[ABC1 XFER ev:X-0006]' }), classify(NOAH, { date: '2026-09-22', amount: 1, description: '[ABC1 XFER ev:X-0006]' })],
  ]) {
    const r = resolve(legs);
    assert.equal(r.flows.length, 0, legs[0].tag.ev); assert.ok(r.pending.every(p => p.reason === 'transfer-mismatch'), legs[0].tag.ev); assert.equal(r.pending.length, legs.length);
  }
  const far = resolve([classify(IB, { date: '2026-09-18', amount: -10, description: '[ABC1 XFER ev:X-0007]' }), classify(NOAH, { date: `2026-09-${18 + TRANSFER_WINDOW_DAYS + 1}`, amount: 10, description: '[ABC1 XFER ev:X-0007]' })]);
  assert.deepEqual(reasons(far), ['transfer-unpaired', 'transfer-unpaired']); assert.deepEqual(far.inTransit, []);
});

test('a capital call is verified, never applied on its own: named commitment, enough remaining, and the owner\'s same-day level decrease', () => {
  const commitments = [{ id: 'COMMIT-HL3-1', fund: 'HIGHLAND3', usd: 150000, date: '2026-09-01' }, { id: 'COMMIT-BX-1', fund: 'BLACKSTONE', usd: 90000, date: '2026-09-30' }];
  const call = classify(NOAH, { date: '2026-09-22', amount: -100000, description: 'Highland 3 capital call [ABC1 CALL ev:CALL-HL3-20260922 commit:COMMIT-HL3-1 fund:HIGHLAND3]' });
  // The owner has already reflected the payment as a level decrease that day: the call is verified and the cash outflow recorded once.
  const r = resolve([call], { commitments, levelChanges: [{ date: '2026-09-22', deltaUsd: -100000 }] });
  assert.deepEqual(r.pending, []);
  assert.deepEqual(r.calls, [{ ev: 'CALL-HL3-20260922', commitmentId: 'COMMIT-HL3-1', fund: 'HIGHLAND3', date: '2026-09-22', usd: 100000, levelChangeDate: '2026-09-22' }]);
  assert.deepEqual(r.flows.map(f => [f.usd, f.kind]), [[-100000, 'external']]); // the +100000 scope-in comes from the ledger, not from here
  // Without that declared decrease the day is pending; nothing is netted or reduced.
  const unverified = resolve([call], { commitments });
  assert.deepEqual(reasons(unverified), ['call-level-pending']); assert.deepEqual(unverified.flows, []); assert.deepEqual(unverified.calls, []);
  // A decrease of another amount or another day does not verify it.
  assert.deepEqual(reasons(resolve([call], { commitments, levelChanges: [{ date: '2026-09-23', deltaUsd: -100000 }] })), ['call-level-pending']);
  assert.deepEqual(reasons(resolve([call], { commitments, levelChanges: [{ date: '2026-09-22', deltaUsd: -90000 }] })), ['call-level-pending']);
  // A replayed reference is a duplicate event: both rows are named, neither consumes a level decrease.
  const replay = classify(NOAH, { date: '2026-09-23', amount: -100000, description: '[ABC1 CALL ev:CALL-HL3-20260922 commit:COMMIT-HL3-1]' });
  const twice = resolve([call, replay], { commitments, levelChanges: [{ date: '2026-09-22', deltaUsd: -100000 }, { date: '2026-09-23', deltaUsd: -100000 }] });
  assert.deepEqual(twice.pending.map(p => [p.date, p.reason]), [['2026-09-22', 'duplicate-event-ref'], ['2026-09-23', 'duplicate-event-ref']]); assert.equal(twice.calls.length, 0); assert.deepEqual(twice.flows, []);
  // The commitment is the one the tag names: a wrong id, a mismatched fund, too little remaining or a later-dated commitment are unmatched.
  const levels = [{ date: '2026-09-22', deltaUsd: -100000 }, { date: '2026-09-24', deltaUsd: -60000 }, { date: '2026-09-25', deltaUsd: -10 }];
  const over = classify(NOAH, { date: '2026-09-24', amount: -60000, description: '[ABC1 CALL ev:CALL-HL3-20260924 commit:COMMIT-HL3-1]' });
  const r2 = resolve([call, over], { commitments, levelChanges: levels });
  assert.deepEqual(r2.pending.map(p => [p.ev, p.reason]), [['CALL-HL3-20260924', 'call-unmatched']]); assert.equal(r2.flows.length, 1);
  for (const [desc, date] of [
    ['[ABC1 CALL ev:CALL-Z commit:COMMIT-NONE]', '2026-09-25'],
    ['[ABC1 CALL ev:CALL-F commit:COMMIT-HL3-1 fund:BLACKSTONE]', '2026-09-25'],
    ['[ABC1 CALL ev:CALL-BX commit:COMMIT-BX-1]', '2026-09-25'],
  ]) assert.deepEqual(reasons(resolve([classify(NOAH, { date, amount: -10, description: desc })], { commitments, levelChanges: levels })), ['call-unmatched'], desc);
  // A deposit or an IB-side row is never a call.
  assert.deepEqual(reasons(resolve([classify(IB, { date: '2026-09-22', amount: -10, description: '[ABC1 CALL ev:CALL-IB commit:COMMIT-HL3-1]' })], { commitments, levelChanges: levels })), ['call-unmatched']);
  assert.deepEqual(reasons(resolve([classify(NOAH, { date: '2026-09-22', amount: 10, description: '[ABC1 CALL ev:CALL-DEP commit:COMMIT-HL3-1]' })], { commitments, levelChanges: levels })), ['call-unmatched']);
  assert.throws(() => resolve([call], { commitments: [{ id: 'x', fund: 'HIGHLAND3', usd: -1, date: '2026-09-01' }] }), /invalid commitments/);
  assert.throws(() => resolve([call], { commitments: [...commitments, { ...commitments[0] }] }), /unique/);
  assert.throws(() => resolve([call], { commitments, levelChanges: [{ date: 'x', deltaUsd: 1 }] }), /invalid level changes/);
});

test('adjustments: ignored on IB-HK where the official NAV never held them, always the owner\'s to explain on NOAH-HK', () => {
  const ib = classify(IB, { date: '2026-09-22', amount: -416.02, description: 'Adjustment to match IB actual cash balance [ABC1 ADJ ev:ADJ-IB-20260722]' });
  const small = classify(NOAH, { date: '2026-09-22', amount: 0.36, description: '[ABC1 ADJ ev:ADJ-NHK-20260916-036] rounding reconciliation' });
  const big = classify(NOAH, { date: '2026-09-23', amount: 25000, description: '[ABC1 ADJ ev:ADJ-NHK-20260923] late-booked distribution' });
  const r = resolve([ib, small, big]);
  assert.equal(r.flows.length, 0);
  assert.deepEqual(r.pending.map(p => [p.id, p.reason]), [[small.id, 'adjustment-pending'], [big.id, 'adjustment-pending']]);
});

test('duplicate tags and distinct same-day same-amount events are told apart by ev and row identity', () => {
  const a = classify(IB, { date: '2026-09-22', amount: -50000, description: '[ABC1 EXT ev:IB-20260922-UBS-1] for UBS' });
  const b = classify(IB, { date: '2026-09-22', amount: -50000, description: '[ABC1 EXT ev:IB-20260922-UBS-2] for UBS second wire' });
  const distinct = resolve([a, b]);
  assert.deepEqual(distinct.pending, []); assert.equal(distinct.flows.length, 2); assert.equal(distinct.flows.reduce((s, f) => s + f.usd, 0), -100000);
  // The same ev copied onto a second row is a double booking, not a second event: both are named, neither counted.
  const copied = classify(IB, { date: '2026-09-22', amount: -50000, description: '[ABC1 EXT ev:IB-20260922-UBS-1] duplicate' });
  const dup = resolve([a, copied]);
  assert.deepEqual(reasons(dup), ['duplicate-event-ref', 'duplicate-event-ref']); assert.deepEqual(dup.flows, []);
  // A CALL ev reused on a second row is also a duplicate, before any commitment logic runs.
  const c1 = classify(NOAH, { date: '2026-09-22', amount: -10, description: '[ABC1 CALL ev:CALL-DUP commit:COMMIT-1]' });
  const c2 = classify(NOAH, { date: '2026-09-22', amount: -10, description: '[ABC1 CALL ev:CALL-DUP commit:COMMIT-1]' });
  assert.deepEqual(reasons(resolve([c1, c2], { commitments: [{ id: 'COMMIT-1', fund: 'F', usd: 100, date: '2026-09-01' }], levelChanges: [{ date: '2026-09-22', deltaUsd: -10 }] })), ['duplicate-event-ref', 'duplicate-event-ref']);
});

test('the owner ledger is superseded one for one by a tagged IB-HK row and kept otherwise, so one event is never counted twice', () => {
  const ledger = [
    { id: 'FLOW-20260922-01', date: '2026-09-22', account: 'IB-HK', direction: 'out', kind: 'external', usd: 100000, note: 'to UBS' },
    { id: 'FLOW-20260922-02', date: '2026-09-22', account: 'IB-HK', direction: 'out', kind: 'external', usd: 100000, note: 'to HSBC' },
    { id: 'FLOW-20260923-01', date: '2026-09-23', account: 'IB-HK', direction: 'out', kind: 'transfer', usd: 300000, note: 'to NOAH-HK' },
    { id: 'FLOW-20260924-01', date: '2026-09-24', account: 'IB-HK', direction: 'in', kind: 'external', usd: 5000, note: 'no Sharesight row yet' },
  ];
  const tagged = resolve([
    classify(IB, { date: '2026-09-22', amount: -100000, description: '[ABC1 EXT ev:IB-20260922-UBS]' }),
    classify(IB, { date: '2026-09-23', amount: -300000, description: '[ABC1 XFER ev:X-20260923]' }),
    classify(NOAH, { date: '2026-09-23', amount: 300000, description: '[ABC1 XFER ev:X-20260923]' }),
    classify(NOAH, { date: '2026-09-22', amount: -100000, description: '[ABC1 EXT ev:NHK-20260922-OUT]' }), // NOAH-side rows never touch the IB ledger
  ]);
  const { kept, superseded } = reconcileWithLedger(tagged.flows, ledger);
  // One tagged IB row supersedes exactly one of the two same-day same-amount ledger entries; the other and the row-less one stay.
  assert.deepEqual(superseded.map(s => s.ledgerId), ['FLOW-20260922-01', 'FLOW-20260923-01']);
  assert.deepEqual(kept.map(l => l.id), ['FLOW-20260922-02', 'FLOW-20260924-01']);
  assert.deepEqual(Object.keys(kept[0]).sort(), ['account', 'date', 'direction', 'id', 'kind', 'note', 'usd']);
  // Direction and kind family must agree: an inbound ledger entry is not superseded by an outbound row, nor a transfer by an external.
  const wrong = reconcileWithLedger(tagged.flows, [{ id: 'F-1', date: '2026-09-22', account: 'IB-HK', direction: 'in', kind: 'external', usd: 100000, note: '' }, { id: 'F-2', date: '2026-09-23', account: 'IB-HK', direction: 'out', kind: 'external', usd: 300000, note: '' }]);
  assert.deepEqual(wrong.superseded, []); assert.equal(wrong.kept.length, 2);
  assert.throws(() => reconcileWithLedger([], [{ id: 'x', date: '2026-09-22', direction: 'sideways', kind: 'external', usd: 1 }]), /invalid ledger flow/);
});

test('resolution window, ordering and identity: rows on or before the baseline are ignored, every pending reason is enumerated', () => {
  const pre = classify(IB, { date: '2026-09-17', amount: 999999, description: '' });
  const later = classify(IB, { date: '2026-10-01', amount: 999999, description: '' });
  const a = classify(IB, { date: '2026-09-25', amount: -100, description: '[ABC1 EXT ev:E-A001]' });
  const b = classify(NOAH, { date: '2026-09-19', amount: 50, description: '[ABC1 EXT ev:E-B001]' });
  const r = resolve([pre, later, a, b]);
  assert.deepEqual(r.flows.map(f => f.date), ['2026-09-19', '2026-09-25']); assert.deepEqual(r.pending, []);
  assert.throws(() => resolve([a, a]), /duplicate row/);
  assert.throws(() => resolveCashEvents([a], { baselineDate: '2026-09-30', endDate: '2026-09-17' }), /invalid resolution window/);
  assert.throws(() => inTransitOn([], 'bad'), /invalid date/);
  for (const reason of ['malformed-tag', 'untagged-cash-event', 'tag-on-return-row', 'unknown-row-type', 'usd-equivalent-pending', 'transfer-unpaired', 'transfer-mismatch',
    'call-unmatched', 'call-level-pending', 'adjustment-pending', 'fx-on-pool-account', 'duplicate-event-ref']) assert.ok(PENDING_REASONS.includes(reason), reason);
  assert.equal(PENDING_REASONS.length, 12);
});
