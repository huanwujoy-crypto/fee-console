import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAbcTag, formatAbcTag, tagDescription, planDescriptionUpdate, classifyCashRow, resolveCashEvents, simulationFlows, inTransitOn,
  reconcileWithLedger, PENDING_REASONS, TAG_KINDS, MAX_DESCRIPTION_LENGTH, MAX_TAG_LENGTH, TRANSFER_WINDOW_DAYS,
} from './xuan-ib-abc-cash-tags.mjs';

// Entirely synthetic identities and source memos; no live response fixture.
const IB = { id: 101, custodian: 'IB-HK', currency: 'USD' };
const IB_CAD = { id: 102, custodian: 'IB-HK', currency: 'CAD' };
const NOAH = { id: 103, custodian: 'NOAH-HK', currency: 'USD' };
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
  const tag = parseAbcTag('Synthetic external withdrawal [ABC1 EXT ev:SYNTHETIC-001] original note');
  assert.deepEqual({ ...tag, raw: undefined }, { version: 'ABC1', kind: 'EXT', ev: 'SYNTHETIC-001', usd: null, commit: null, fund: null, raw: undefined });
  assert.equal(parseAbcTag('[ABC1 XFER ev:X-20260920-A] transfer').ev, 'X-20260920-A');
  assert.equal(parseAbcTag('[ABC1 EXT ev:E-1234 usd:100.00] CAD 140 from demo bank').usd, 100);
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
  assert.equal(formatAbcTag({ kind: 'EXT', ev: 'E-0001', usd: 100 }), '[ABC1 EXT ev:E-0001 usd:100.00]');
  assert.equal(formatAbcTag({ kind: 'CALL', ev: 'C-0001', commit: 'COMMIT-1', fund: 'HIGHLAND3' }), '[ABC1 CALL ev:C-0001 commit:COMMIT-1 fund:HIGHLAND3]');
  assert.ok(formatAbcTag({ kind: 'CALL', ev: 'x'.repeat(40), commit: 'y'.repeat(40), fund: 'HIGHLAND3' }).length <= MAX_TAG_LENGTH);
  assert.throws(() => formatAbcTag({ kind: 'CALL', ev: 'x'.repeat(64), commit: 'y'.repeat(64), fund: 'z'.repeat(64), usd: 1e12 }), /oversized/);
  for (const bad of [{ kind: 'EXT' }, { kind: 'NOPE', ev: 'E-0001' }, { kind: 'EXT', ev: 'E-0001', usd: 1.005 }, { kind: 'EXT', ev: 'E-0001', usd: -1 },
    { kind: 'CALL', ev: 'C-0001' }, { kind: 'EXT', ev: 'E-0001', commit: 'C-1' }, { kind: 'ADJ', ev: 'A-0001', usd: 1 }]) assert.throws(() => formatAbcTag(bad), JSON.stringify(bad));
  const original = 'Synthetic source reference; '.padEnd(MAX_DESCRIPTION_LENGTH - '[ABC1 EXT ev:E-0001] '.length, 'x');
  const tagged = tagDescription(original, { kind: 'EXT', ev: 'E-0001' });
  assert.equal(tagged.length, MAX_DESCRIPTION_LENGTH);
  assert.equal(tagged, `[ABC1 EXT ev:E-0001] ${original}`);
  assert.equal(parseAbcTag(tagged).ev, 'E-0001');
  assert.throws(() => tagDescription('x'.repeat(255), { kind: 'EXT', ev: 'E-0001' }), /description-too-long/);
  assert.throws(() => tagDescription('测'.repeat(90), { kind: 'EXT', ev: 'E-0001' }), /description-too-long/);
  for (const bad of ['plain text', 'prefix [ABC1 EXT ev:E-0001]', '[ABC1 EXT ev:E-0001] trailing'])
    assert.throws(() => tagDescription('original', bad), /standalone ABC tag/);
  assert.equal(tagDescription('', '[ABC1 FX ev:FX-0001]'), '[ABC1 FX ev:FX-0001]');
  assert.equal(tagDescription(undefined, { kind: 'FX', ev: 'FX-0001' }), '[ABC1 FX ev:FX-0001]');
  // Idempotent on the same tag, refused on a different one or a malformed existing one.
  assert.equal(tagDescription(tagged, { kind: 'EXT', ev: 'E-0001' }), tagged);
  assert.throws(() => tagDescription(tagged, { kind: 'XFER', ev: 'E-0001' }), /different ABC tag/);
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
  const trade = classify(IB, { date: '2026-09-18', amount: -1234.56, type: 'Buy Trade', description: 'Synthetic buy trade of 20 DEMO shares' });
  assert.equal(trade.category, 'return'); assert.equal(trade.pending, null);
  const interest = classify(IB, { date: '2026-09-18', amount: 12.34, type: 'INTEREST_PAYMENT', description: 'Synthetic broker interest received [DEMO-REF]', foreign: 'ibkr.cash:4ad9' });
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
  const distribution = classify(NOAH, { date: '2026-09-22', amount: 1200, description: '[ABC1 EXT ev:NHK-DEMO-DIST] Synthetic fund capital return USD 200 plus income distribution USD 1000; accounting cash receipt, not external contribution' });
  assert.equal(distribution.pending, null);
  assert.deepEqual(resolve([distribution]).flows, [{ id: distribution.id, date: '2026-09-22', usd: 1200, kind: 'external', custodian: 'NOAH-HK', ev: 'NHK-DEMO-DIST' }]);
  // An untagged one is not silently a flow either: it is named until tagged.
  assert.deepEqual(reasons(resolve([classify(NOAH, { date: '2026-09-22', amount: 1500, description: 'Synthetic fund capital + income | ref DEMO-DISTRIBUTION' })])), ['untagged-cash-event']);
});

test('non-USD accounts: FX is never a pool event, a pool event needs usd:, small CAD FX is not forced into ADJ', () => {
  const fx = classify(IB_CAD, { date: '2026-09-19', amount: 140, description: '[ABC1 FX ev:FX-20260919-CAD] synthetic USD→CAD conversion' });
  assert.equal(fx.pending, null); assert.equal(fx.usd, null); assert.equal(fx.tag.kind, 'FX');
  assert.equal(classify(IB_CAD, { date: '2026-09-19', amount: 140, description: '[ABC1 EXT ev:E-0001] CAD from demo bank' }).pending, 'usd-equivalent-pending');
  const withUsd = classify(IB_CAD, { date: '2026-09-19', amount: -140, description: '[ABC1 EXT ev:E-0002 usd:100.00] CAD to demo bank' });
  assert.equal(withUsd.pending, null); assert.equal(withUsd.usd, -100);
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
  const noahCash = { '2026-09-20': 80000, '2026-09-21': 80000, '2026-09-22': 80000, '2026-09-23': 380000 };
  const pool = d => ibNav[d] + noahCash[d] + inTransitOn(r.inTransit, d);
  for (const d of Object.keys(ibNav)) assert.equal(pool(d), 5080000, d);
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
  const commitments = [{ id: 'COMMIT-HL3-1', fund: 'HIGHLAND3', usd: 150000, date: '2026-09-18' }, { id: 'COMMIT-BX-1', fund: 'BLACKSTONE', usd: 90000, date: '2026-09-30' }];
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

test('adjustments: ignored on IB-HK where the official NAV never held them; NOAH-HK requires evidence review, not a size threshold', () => {
  const ib = classify(IB, { date: '2026-09-22', amount: -42, description: 'Synthetic adjustment [ABC1 ADJ ev:ADJ-IB-DEMO]' });
  const small = classify(NOAH, { date: '2026-09-22', amount: 0.01, description: '[ABC1 ADJ ev:ADJ-NHK-DEMO] synthetic rounding reconciliation' });
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

test('the owner ledger is superseded by a unique explicit matching event reference and kept otherwise', () => {
  const ledger = [
    { id: 'FLOW-20260922-01', date: '2026-09-22', account: 'IB-HK', direction: 'out', kind: 'external', usd: 100000, ev: 'IB-20260922-UBS', note: 'to UBS' },
    { id: 'FLOW-20260922-02', date: '2026-09-22', account: 'IB-HK', direction: 'out', kind: 'external', usd: 100000, ev: 'IB-20260922-HSBC', note: 'to HSBC' },
    { id: 'FLOW-20260923-01', date: '2026-09-23', account: 'IB-HK', direction: 'out', kind: 'transfer', usd: 300000, ev: 'X-20260923', note: 'to NOAH-HK' },
    { id: 'FLOW-20260924-01', date: '2026-09-24', account: 'IB-HK', direction: 'in', kind: 'external', usd: 5000, note: 'no Sharesight row yet' },
  ];
  const tagged = resolve([
    classify(IB, { date: '2026-09-22', amount: -100000, description: '[ABC1 EXT ev:IB-20260922-UBS]' }),
    classify(IB, { date: '2026-09-23', amount: -300000, description: '[ABC1 XFER ev:X-20260923]' }),
    classify(NOAH, { date: '2026-09-23', amount: 300000, description: '[ABC1 XFER ev:X-20260923]' }),
    classify(NOAH, { date: '2026-09-22', amount: -100000, description: '[ABC1 EXT ev:NHK-20260922-OUT]' }), // NOAH-side rows never touch the IB ledger
  ]);
  const { kept, superseded, pending } = reconcileWithLedger(tagged.flows, ledger);
  // Only the explicitly identical events are superseded; another reference
  // stays a distinct event even on the same day with the same amount.
  assert.deepEqual(superseded.map(s => s.ledgerId), ['FLOW-20260922-01', 'FLOW-20260923-01']);
  assert.deepEqual(kept.map(l => l.id), ['FLOW-20260922-02', 'FLOW-20260924-01']);
  assert.deepEqual(Object.keys(kept[0]).sort(), ['account', 'date', 'direction', 'ev', 'id', 'kind', 'note', 'usd']);
  assert.deepEqual(pending, []);
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
  assert.equal(PENDING_REASONS.length, 15);
});

test('currency conflicts and a usd field on a USD account are named pending, including equal amounts', () => {
  for (const usd of ['100.00', '999.00']) {
    const r = classify(IB, { date: '2026-09-19', amount: 100, description: `[ABC1 EXT ev:CURRENCY-USD usd:${usd}]` });
    assert.equal(r.pending, 'usd-on-usd-account'); assert.equal(r.usd, null);
    assert.deepEqual(reasons(resolve([r])), ['usd-on-usd-account']);
    assert.deepEqual(resolve([r]).flows, []);
  }
  const base = row(IB, { date: '2026-09-19', amount: 100, description: '[ABC1 EXT ev:CURRENCY-ROW]' });
  for (const currency of ['HKD', 'CAD', 'usd', null]) {
    const r = classifyCashRow({ ...base, currency }, IB);
    assert.equal(r.pending, 'currency-mismatch'); assert.equal(r.usd, null);
    assert.deepEqual(resolve([r]).flows, []);
  }
  assert.equal(classifyCashRow({ ...base, currency: 'USD' }, IB).pending, null);
  for (const currency of ['', 'usd', 'US', 'USDD']) {
    assert.throws(() => classifyCashRow(base, { ...IB, currency }), /declared pool account/);
  }
  const cad = row(IB_CAD, { date: '2026-09-19', amount: -140, description: '[ABC1 EXT ev:CURRENCY-CAD usd:100.00]' });
  assert.equal(classifyCashRow({ ...cad, currency: 'CAD' }, IB_CAD).usd, -100);
  assert.equal(classifyCashRow({ ...cad, currency: 'USD' }, IB_CAD).pending, 'currency-mismatch');
});

test('an event reference shared across XFER and any other kind holds every involved row', () => {
  const a = classify(IB, { date: '2026-09-19', amount: -100, description: '[ABC1 XFER ev:MIXED-0001]' });
  const b = classify(NOAH, { date: '2026-09-20', amount: 100, description: '[ABC1 XFER ev:MIXED-0001]' });
  const c = classify(IB, { date: '2026-09-20', amount: 50, description: '[ABC1 EXT ev:MIXED-0001]' });
  for (const rows of [[a, b, c], [a, c]]) {
    const result = resolve(rows);
    assert.equal(result.pending.length, rows.length);
    assert.ok(result.pending.every(p => p.reason === 'duplicate-event-ref'));
    assert.deepEqual(result.flows, []); assert.deepEqual(result.inTransit, []);
  }
  // An already-pending USD annotation must not hide its event reference from
  // the group-level conflict check and allow the XFER pair through.
  const invalid = classify(IB, { date: '2026-09-20', amount: 50, description: '[ABC1 EXT ev:MIXED-0001 usd:50.00]' });
  assert.equal(invalid.pending, 'usd-on-usd-account');
  assert.deepEqual(reasons(resolve([a, b, invalid])), ['duplicate-event-ref', 'duplicate-event-ref', 'duplicate-event-ref']);
});

test('CALL commitments dated on or before the baseline need independent opening remaining-balance evidence', () => {
  const call = classify(NOAH, { date: '2026-09-19', amount: -90, description: '[ABC1 CALL ev:OPENING-CALL-2 commit:COMMIT-OPENING]' });
  const earlier = classify(NOAH, { date: '2026-09-16', amount: -90, description: '[ABC1 CALL ev:OPENING-CALL-1 commit:COMMIT-OPENING]' });
  const levelChanges = [{ date: '2026-09-16', deltaUsd: -90 }, { date: '2026-09-19', deltaUsd: -90 }];
  for (const date of ['2026-09-01', '2026-09-17']) {
    const commitments = [{ id: 'COMMIT-OPENING', fund: 'SYNTHETIC-FUND', usd: 100, date }];
    for (const rows of [[call], [earlier, call]]) {
      const result = resolve(rows, { commitments, levelChanges });
      assert.deepEqual(reasons(result), ['call-opening-balance-pending']);
      assert.deepEqual(result.flows, []); assert.deepEqual(result.calls, []);
    }
  }
  // A genuinely new post-baseline commitment retains the existing bounded
  // matching behavior; its nominal amount is not recycled between calls.
  const fresh = [{ id: 'COMMIT-OPENING', fund: 'SYNTHETIC-FUND', usd: 100, date: '2026-09-18' }];
  const over = classify(NOAH, { date: '2026-09-20', amount: -90, description: '[ABC1 CALL ev:OPENING-CALL-3 commit:COMMIT-OPENING]' });
  const result = resolve([call, over], { commitments: fresh, levelChanges: [...levelChanges, { date: '2026-09-20', deltaUsd: -90 }] });
  assert.equal(result.calls.length, 1);
  assert.deepEqual(reasons(result), ['call-unmatched']);
});

test('legacy manual candidates stay pending and explicit distinct events are never silently merged', () => {
  const automatic = { id: 'SS-SYNTHETIC-1', date: '2026-09-19', usd: -100, kind: 'external', custodian: 'IB-HK', ev: 'WIRE-DESTINATION-A' };
  const legacy = { id: 'FLOW-SYNTHETIC-1', date: '2026-09-19', account: 'IB-HK', direction: 'out', kind: 'external', usd: 100, note: 'Separate transfer to destination B' };
  const before = JSON.stringify([automatic, legacy]);
  const ambiguous = reconcileWithLedger([automatic], [legacy]);
  assert.deepEqual(ambiguous.kept, [legacy]); assert.deepEqual(ambiguous.superseded, []);
  assert.deepEqual(ambiguous.pending, [{ ledgerId: legacy.id, rowId: automatic.id, date: automatic.date,
    ledgerDate: legacy.date, ev: automatic.ev, reason: 'manual-event-ref-pending' }]);
  assert.equal(JSON.stringify([automatic, legacy]), before);
  const distinct = { ...legacy, ev: 'WIRE-DESTINATION-B' };
  const result = reconcileWithLedger([automatic], [distinct]);
  assert.deepEqual(result, { kept: [distinct], superseded: [], pending: [] });
  const proven = { ...legacy, ev: automatic.ev };
  const exact = reconcileWithLedger([automatic], [proven]);
  assert.deepEqual(exact.kept, []); assert.deepEqual(exact.pending, []);
  assert.deepEqual(exact.superseded, [{ ledgerId: proven.id, rowId: automatic.id, ev: automatic.ev }]);
});

test('explicit manual references must be unique and agree on date, signed amount and kind', () => {
  const flow = { id: 'SS-SYNTHETIC-2', date: '2026-09-19', usd: -100, kind: 'external', custodian: 'IB-HK', ev: 'MANUAL-EXACT-1' };
  const ledger = { id: 'FLOW-SYNTHETIC-2', date: flow.date, account: 'IB-HK', direction: 'out', kind: 'external', usd: 100, ev: flow.ev, note: 'synthetic' };
  for (const change of [{ date: '2026-09-20' }, { usd: 99 }, { direction: 'in' }, { kind: 'transfer' }]) {
    const changed = { ...ledger, ...change };
    const result = reconcileWithLedger([flow], [changed]);
    assert.deepEqual(result.kept, [changed]); assert.deepEqual(result.superseded, []);
    assert.equal(result.pending[0].reason, 'manual-event-ref-conflict');
    assert.equal(result.pending[0].ledgerDate, changed.date);
  }
  const duplicateReference = { ...ledger, id: 'FLOW-SYNTHETIC-3' };
  const manyLedger = reconcileWithLedger([flow], [ledger, duplicateReference]);
  assert.equal(manyLedger.kept.length, 2); assert.equal(manyLedger.superseded.length, 0);
  assert.deepEqual(manyLedger.pending.map(p => p.reason), ['manual-event-ref-conflict', 'manual-event-ref-conflict']);
  const manyFlows = reconcileWithLedger([flow, { ...flow, id: 'SS-SYNTHETIC-3' }], [ledger]);
  assert.equal(manyFlows.kept.length, 1); assert.equal(manyFlows.superseded.length, 0);
  assert.ok(manyFlows.pending.every(p => p.reason === 'manual-event-ref-conflict'));
  assert.throws(() => reconcileWithLedger([flow], [ledger, ledger]), /duplicate ledger flow/);
  assert.throws(() => reconcileWithLedger([flow], [{ ...ledger, account: 'NOAH-HK' }]), /invalid ledger flow/);
});
