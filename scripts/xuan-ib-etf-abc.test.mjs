import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ETF_ABC_METHOD_ID,
  ETF_ABC_POLICY_FINGERPRINT,
  ETF_ABC_T0_DATE,
  countVisibleEtfAbcRuntimeClassElements,
  computeEtfAbcObservation,
  parseEtfAbcPublicRuntimeStateJson,
  renderEtfAbcPublicRuntimeCard,
  renderEtfAbcRuntimeCard,
  upsertEtfAbcRuntime,
  validateEtfAbcInput,
  validateEtfAbcInitialPublicRuntimeState,
  validateEtfAbcPublicRuntimeState,
  validateEtfAbcResult,
} from './xuan-ib-etf-abc.mjs';
import { renderPolicySection } from './xuan-ib-policy-page.mjs';

const fp = char => char.repeat(64);
function coverage() {
  const value = {
    aHoldingsFingerprint: fp('a'), bShadowUnitsFingerprint: fp('b'),
    requiredInstruments: { A: ['CSPX'], B: ['CSPX', 'EIMI', 'EQAC', 'EXUS', 'USSC'], C: ['CSPX'] },
  };
  return { ...value, evidenceFingerprint: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}
const applications = (amountUsd, economicDateHkt = '2026-09-02', effectiveMarketDate = economicDateHkt, fxIdentity = 'fx-usd-usd-20260902') =>
  ['A', 'B', 'C'].map(arm => ({ arm, economicDateHkt, effectiveMarketDate, amountUsd, fxIdentity }));

function sample(overrides = {}) {
  const economicDateHkt = overrides.economicDateHkt ?? '2026-09-02';
  const effectiveMarketDate = overrides.effectiveMarketDate ?? economicDateHkt;
  const amountUsd = overrides.amountUsd ?? 100;
  const reserveStatus = overrides.reserveStatus ?? 'incomplete';
  return {
    schemaVersion: 1,
    methodId: ETF_ABC_METHOD_ID,
    mode: 'read-only',
    t0DateHkt: ETF_ABC_T0_DATE,
    baseline: overrides.baseline ?? {
      status: 'established', dateHkt: ETF_ABC_T0_DATE, mode: 'clone-a-marginal-shadow',
      aHoldingsFingerprint: fp('a'), bHoldingsFingerprint: fp('a'), aValueUsd: 1000, bValueUsd: 1000,
    },
    calendar: overrides.calendar ?? {
      status: effectiveMarketDate === economicDateHkt ? 'complete' : 'market-closed-carry',
      economicDateHkt, effectiveMarketDate, observationCutoffHkt: `${economicDateHkt}T23:59:59+08:00`,
      staleMarketClosed: effectiveMarketDate !== economicDateHkt,
      coverage: coverage(),
      priceDates: Object.fromEntries(['CSPX', 'EIMI', 'EQAC', 'EXUS', 'USSC'].map(ticker => [ticker, {
        date: effectiveMarketDate === economicDateHkt ? economicDateHkt : '2026-09-04',
        closeAtHkt: `${effectiveMarketDate === economicDateHkt ? economicDateHkt : '2026-09-04'}T23:00:00+08:00`,
        status: effectiveMarketDate === economicDateHkt ? 'official-close' : 'market-closed-carry',
      }])),
    },
    flow: overrides.flow === undefined ? {
      economicEventId: 'flow-20260902-1', classification: 'external', economicDateHkt, effectiveMarketDate, amountUsd,
      fx: { identity: 'fx-usd-usd-20260902', pair: 'USD/USD', rate: 1, asOfHkt: `${economicDateHkt}T16:00:00+08:00`, source: 'verified-ledger' },
      applications: applications(amountUsd, economicDateHkt, effectiveMarketDate),
    } : overrides.flow,
    arms: overrides.arms ?? {
      A: { openingValueUsd: 1000, endingValueBeforeFlowUsd: 1010, holdingsFingerprint: fp('a') },
      B: {
        openingValueUsd: 1000, endingValueBeforeFlowUsd: 1005, baselineMode: 'clone-a-marginal-shadow',
        reserveStatus, requiredReserveUsd: reserveStatus === 'verified' ? 240000 : null,
        reserveEvidence: reserveStatus === 'verified' ? {
          asOfHkt: `${economicDateHkt}T17:00:00+08:00`, verified90dCallsUsd: 100000,
          approvedBufferUsd: 100000, fxOpsBufferUsd: 40000, evidenceFingerprint: fp('c'),
        } : null,
        pendingCashUnallocatedUsd: overrides.pendingCashUnallocatedUsd ?? 25,
        pendingOutflowUnsimulatedUsd: overrides.pendingOutflowUnsimulatedUsd ?? 0,
        shadowUnitsFingerprint: fp('b'),
      },
      C: {
        openingValueUsd: 1000, endingValueBeforeFlowUsd: 1015, ticker: 'CSPX', isin: 'IE00B5BMR087',
        distribution: 'accumulation', cashDividendUsd: 0,
      },
    },
    tiltState: overrides.tiltState ?? 'pending-validation',
    tiltValidation: overrides.tiltValidation ?? ((overrides.tiltState ?? 'pending-validation') === 'eight'
      ? { status: 'verified', evidenceFingerprint: fp('e'), effectiveMarketDate }
      : { status: 'pending', evidenceFingerprint: null, effectiveMarketDate: null }),
    quarters: overrides.quarters ?? [{ id: '2026-Q3', status: 'stub' }],
    metrics: overrides.metrics ?? {
      afterTaxReturn: null, maximumDrawdown: null, aiParticipation: null, usSitusShare: null, callCoverage: null,
    },
  };
}

const matureSample = (overrides = {}) => sample({ economicDateHkt: '2027-10-01', ...overrides });

test('valid observation applies one same-date EOD flow to A, B and C', () => {
  const input = sample();
  const result = computeEtfAbcObservation(input);
  assert.deepEqual([result.arms.A.externalFlowUsdEod, result.arms.B.externalFlowUsdEod, result.arms.C.externalFlowUsdEod], [100, 100, 100]);
  assert.deepEqual([result.arms.A.endingValueAfterFlowUsd, result.arms.B.endingValueAfterFlowUsd, result.arms.C.endingValueAfterFlowUsd], [1110, 1105, 1115]);
  assert.ok(Math.abs(result.arms.A.dailyReturn - 0.01) < 1e-12);
  assert.ok(Math.abs(result.arms.B.dailyReturn - 0.005) < 1e-12);
  assert.ok(Math.abs(result.arms.C.dailyReturn - 0.015) < 1e-12);
});

test('T0 is fixed to 2026-09-01 and 2026-Q3 is always a stub', () => {
  assert.throws(() => validateEtfAbcInput({ ...sample(), t0DateHkt: '2026-09-02' }), /T0/);
  const input = sample();
  input.quarters = [{ id: '2026-Q3', status: 'complete' }];
  assert.throws(() => validateEtfAbcInput(input), /T0 stub/);
  const preT0 = sample();
  preT0.quarters = [{ id: '2026-Q3', status: 'stub' }, { id: '2026-Q2', status: 'complete' }];
  assert.throws(() => validateEtfAbcInput(preT0), /Quarter ledger/);
  const laterStub = sample();
  laterStub.quarters = [{ id: '2026-Q3', status: 'stub' }, { id: '2026-Q4', status: 'stub' }];
  assert.throws(() => validateEtfAbcInput(laterStub), /Quarter ledger/);
});

test('established B baseline must clone A value and holdings fingerprint', () => {
  const input = sample();
  input.baseline = { ...input.baseline, bValueUsd: 999.99 };
  assert.throws(() => validateEtfAbcInput(input), /exact clone/);
  const changed = sample();
  changed.baseline = { ...changed.baseline, bHoldingsFingerprint: fp('c') };
  assert.throws(() => validateEtfAbcInput(changed), /exact clone/);
});

test('pending baseline contains no invented fingerprint or value', () => {
  const pending = {
    status: 'pending', dateHkt: ETF_ABC_T0_DATE, mode: 'clone-a-marginal-shadow',
    aHoldingsFingerprint: null, bHoldingsFingerprint: null, aValueUsd: null, bValueUsd: null,
  };
  assert.equal(validateEtfAbcInput(sample({ baseline: pending })).baseline.status, 'pending');
  assert.throws(() => validateEtfAbcInput(sample({ baseline: { ...pending, aValueUsd: 1000 } })), /invented/);
});

test('pre-T0 observations and a verified reserve below the approved floor fail closed', () => {
  assert.throws(() => validateEtfAbcInput(sample({ economicDateHkt: '2026-08-31', effectiveMarketDate: '2026-08-31' })), /calendar|T0/i);
  const reserve = sample({ reserveStatus: 'verified', tiltState: 'zero' });
  reserve.arms.B.requiredReserveUsd = 239999.99;
  assert.throws(() => validateEtfAbcInput(reserve), /CALL reserve/);

  const wrongFormula = sample({ reserveStatus: 'verified', tiltState: 'zero' });
  wrongFormula.arms.B.reserveEvidence.verified90dCallsUsd = 250000;
  assert.throws(() => validateEtfAbcInput(wrongFormula), /formula evidence/);
});

test('fingerprints are full SHA-256 identities and a sub-cent flow is rejected', () => {
  const short = sample();
  short.baseline.aHoldingsFingerprint = 'a'.repeat(8);
  short.baseline.bHoldingsFingerprint = 'a'.repeat(8);
  assert.throws(() => validateEtfAbcInput(short), /exact clone/);
  const dust = sample();
  dust.flow.amountUsd = 1e-9;
  dust.flow.applications = applications(1e-9);
  assert.throws(() => validateEtfAbcInput(dust), /amount or FX/);
});

test('flow must be applied exactly once to all three arms', () => {
  const input = sample();
  input.flow = { ...input.flow, applications: input.flow.applications.slice(0, 2) };
  assert.throws(() => validateEtfAbcInput(input), /exactly once/);
  const duplicate = sample();
  duplicate.flow.applications[2] = { ...duplicate.flow.applications[2], arm: 'B' };
  assert.throws(() => validateEtfAbcInput(duplicate), /exactly once/);
});

test('flow amount, economic date, effective date and FX identity are invariant across arms', () => {
  for (const patch of [
    { amountUsd: 99.99 }, { economicDateHkt: '2026-09-03' },
    { effectiveMarketDate: '2026-09-03' }, { fxIdentity: 'different-fx' },
  ]) {
    const input = sample();
    input.flow.applications[1] = { ...input.flow.applications[1], ...patch };
    assert.throws(() => validateEtfAbcInput(input), /same flow date, amount and FX/);
  }
});

test('market-closed carry preserves economic date and visibly delays only effective market date', () => {
  const input = sample({ economicDateHkt: '2026-09-05', effectiveMarketDate: '2026-09-08' });
  const result = computeEtfAbcObservation(input);
  assert.equal(result.economicDateHkt, '2026-09-05');
  assert.equal(result.effectiveMarketDate, '2026-09-08');
  assert.equal(result.staleMarketClosed, true);
  assert.equal(result.comparisonStatus, 'incomplete');
  assert.equal(result.arms.A.dailyReturn, null);
  assert.equal(result.arms.B.shadowUnitsCreatedByThisObservation, false);
  const hidden = sample({ economicDateHkt: '2026-09-05', effectiveMarketDate: '2026-09-08' });
  hidden.calendar.staleMarketClosed = false;
  assert.throws(() => validateEtfAbcInput(hidden), /market-closed carry/);
  assert.throws(() => validateEtfAbcInput(sample({
    economicDateHkt: '2026-09-05', effectiveMarketDate: '2026-10-05',
  })), /bounded later effective market date/);
});

test('available valuation cannot use a future close', () => {
  const input = sample();
  input.calendar.priceDates.CSPX = { date: '2026-09-03', closeAtHkt: '2026-09-03T04:00:00+08:00', status: 'official-close' };
  assert.throws(() => validateEtfAbcInput(input), /completed closes known/);
  const afterCutoff = sample();
  afterCutoff.calendar.priceDates.CSPX = { date: '2026-09-02', closeAtHkt: '2026-09-03T04:00:00+08:00', status: 'official-close' };
  assert.throws(() => validateEtfAbcInput(afterCutoff), /completed closes known/);
  const ancient = sample();
  ancient.calendar.priceDates.CSPX = { date: '2026-08-01', closeAtHkt: '2026-08-01T23:00:00+08:00', status: 'official-close' };
  assert.throws(() => validateEtfAbcInput(ancient), /completed closes known/);
  const priorDayWithin36Hours = sample();
  priorDayWithin36Hours.calendar.priceDates.CSPX = {
    date: '2026-09-01', closeAtHkt: '2026-09-01T23:00:00+08:00', status: 'official-close',
  };
  assert.throws(() => validateEtfAbcInput(priorDayWithin36Hours), /completed closes known/);
  const mismatchedHktCloseDate = sample();
  mismatchedHktCloseDate.calendar.priceDates.CSPX = {
    date: '2026-09-02', closeAtHkt: '2026-09-01T23:30:00+08:00', status: 'official-close',
  };
  assert.throws(() => validateEtfAbcInput(mismatchedHktCloseDate), /completed closes known/);

  const incompleteCoverage = sample();
  delete incompleteCoverage.calendar.priceDates.EQAC;
  assert.throws(() => validateEtfAbcInput(incompleteCoverage), /complete A\/B\/C instrument price coverage/);
});

test('USD/USD FX identity is exactly one and cannot disguise an amount change', () => {
  const input = sample();
  input.flow.fx.rate = 2;
  assert.throws(() => validateEtfAbcInput(input), /amount or FX/);
});

test('positive B flow with incomplete CALL reserve remains unallocated cash and creates no units', () => {
  const input = sample({ amountUsd: 125 });
  const before = input.arms.B.shadowUnitsFingerprint;
  const result = computeEtfAbcObservation(input);
  assert.equal(result.arms.B.pendingCashUnallocatedUsd, 150);
  assert.equal(result.arms.B.shadowUnitsFingerprint, before);
  assert.equal(result.arms.B.shadowUnitsCreatedByThisObservation, false);
  assert.equal(result.arms.B.implementationStatus, 'pending-cash-unallocated');
});

test('verified CALL reserve does not make a new inflow allocated or comparison-complete', () => {
  const result = computeEtfAbcObservation(sample({
    reserveStatus: 'verified', tiltState: 'zero', pendingCashUnallocatedUsd: 0, amountUsd: 125,
  }));
  assert.equal(result.arms.B.pendingCashUnallocatedUsd, 125);
  assert.equal(result.arms.B.implementationStatus, 'pending-cash-unallocated');
  assert.equal(result.arms.B.shadowUnitsCreatedByThisObservation, false);
  assert.equal(result.comparisonStatus, 'incomplete');
  assert.equal(result.rankingEligible, false);
  const card = renderEtfAbcRuntimeCard(result);
  assert.match(card, /新现金待分配 · 比较暂停/);
  assert.doesNotMatch(card, /CALL 未齐/);
});

test('negative B flow with incomplete reserve is recorded but not silently liquidated', () => {
  const result = computeEtfAbcObservation(sample({ amountUsd: -80 }));
  assert.equal(result.arms.B.endingValueAfterFlowUsd, 925);
  assert.equal(result.arms.B.pendingOutflowUnsimulatedUsd, 80);
  assert.equal(result.arms.B.shadowUnitsCreatedByThisObservation, false);
  assert.equal(result.arms.B.implementationStatus, 'pending-outflow-unsimulated');
});

test('withdrawal above any arm value fails instead of borrowing or shorting', () => {
  assert.throws(() => computeEtfAbcObservation(sample({ amountUsd: -2000 })), /borrowing and shorting/);
});

test('zero-tilt candidate vector is exact, sums to one and is not deployable while validation is pending', () => {
  const target = computeEtfAbcObservation(sample()).targetVector;
  assert.deepEqual(target.weights, { CSPX: .60, EQAC: 0, USSC: .05, EXUS: .23, EIMI: .12 });
  assert.equal(Object.values(target.weights).reduce((sum, value) => sum + value, 0), 1);
  assert.equal(target.status, 'candidate-not-deployable');
});

test('validated eight-percent state changes only the prospective vector', () => {
  const target = computeEtfAbcObservation(sample({ tiltState: 'eight' })).targetVector;
  assert.deepEqual(target.weights, { CSPX: .52, EQAC: .08, USSC: .05, EXUS: .23, EIMI: .12 });
  assert.equal(target.aiTiltPct, .08);
  assert.equal(target.status, 'approved-read-only');
});

test('eight-percent tilt cannot be asserted without dated validation evidence', () => {
  assert.throws(() => validateEtfAbcInput(sample({
    tiltState: 'eight', tiltValidation: { status: 'pending', evidenceFingerprint: null, effectiveMarketDate: null },
  })), /requires verified mapping/);
  const future = sample({ tiltState: 'eight' });
  future.tiltValidation.effectiveMarketDate = '2026-09-03';
  assert.throws(() => validateEtfAbcInput(future), /known by the observation/);
  const carryLookAhead = sample({ economicDateHkt: '2026-09-05', effectiveMarketDate: '2026-09-08', tiltState: 'eight' });
  carryLookAhead.tiltValidation.effectiveMarketDate = '2026-09-08';
  assert.throws(() => validateEtfAbcInput(carryLookAhead), /known by the observation/);
});

test('C is exact CSPX accumulation and never double-counts a cash dividend', () => {
  assert.equal(computeEtfAbcObservation(sample()).arms.C.cashDividendUsd, 0);
  for (const patch of [
    { ticker: 'SPY' }, { isin: 'US78462F1030' }, { distribution: 'distribution' }, { cashDividendUsd: 1 },
  ]) {
    const input = sample();
    input.arms.C = { ...input.arms.C, ...patch };
    assert.throws(() => validateEtfAbcInput(input), /exact CSPX accumulating/);
  }
});

test('four complete post-T0 quarters only create eligibility, never a score or rank', () => {
  const quarters = [
    { id: '2026-Q3', status: 'stub' }, { id: '2026-Q4', status: 'complete' },
    { id: '2027-Q1', status: 'complete' }, { id: '2027-Q2', status: 'complete' }, { id: '2027-Q3', status: 'complete' },
  ];
  const metrics = { afterTaxReturn: .10, maximumDrawdown: .08, aiParticipation: .20, usSitusShare: .05, callCoverage: 1.5 };
  const result = computeEtfAbcObservation(matureSample({
    quarters, metrics, reserveStatus: 'verified', tiltState: 'zero', flow: null, pendingCashUnallocatedUsd: 0,
  }));
  assert.equal(result.rankingEligible, true);
  assert.equal(result.rankingStatus, 'eligible-raw-metrics-only-no-rank');
  assert.equal('score' in result, false);
  assert.equal('rank' in result, false);
  assert.deepEqual(result.rawMetrics, metrics);
});

test('future quarters cannot create ranking eligibility before they have ended', () => {
  const input = sample({
    quarters: [
      { id: '2026-Q3', status: 'stub' }, { id: '2026-Q4', status: 'complete' },
      { id: '2027-Q1', status: 'complete' }, { id: '2027-Q2', status: 'complete' },
      { id: '2027-Q3', status: 'complete' },
    ],
  });
  assert.throws(() => validateEtfAbcInput(input), /Quarter ledger/);
});

test('fewer than four complete quarters or missing raw metric prevents ranking eligibility', () => {
  const three = [{ id: '2026-Q3', status: 'stub' }, { id: '2026-Q4', status: 'complete' }, { id: '2027-Q1', status: 'complete' }, { id: '2027-Q2', status: 'complete' }];
  assert.equal(computeEtfAbcObservation(matureSample({ quarters: three, reserveStatus: 'verified', tiltState: 'zero' })).rankingEligible, false);
  const four = [...three, { id: '2027-Q3', status: 'complete' }];
  assert.equal(computeEtfAbcObservation(matureSample({ quarters: four, reserveStatus: 'verified', tiltState: 'zero' })).rankingStatus, 'not-eligible-incomplete-raw-metrics');
});

test('CALL or tilt gate cannot become comparison-complete even with four quarters and raw metrics', () => {
  const quarters = [
    { id: '2026-Q3', status: 'stub' }, { id: '2026-Q4', status: 'complete' },
    { id: '2027-Q1', status: 'complete' }, { id: '2027-Q2', status: 'complete' }, { id: '2027-Q3', status: 'complete' },
  ];
  const metrics = { afterTaxReturn: .10, maximumDrawdown: .08, aiParticipation: .20, usSitusShare: .05, callCoverage: 1.5 };
  const callBlocked = computeEtfAbcObservation(matureSample({ quarters, metrics, tiltState: 'zero' }));
  assert.equal(callBlocked.comparisonStatus, 'incomplete');
  assert.equal(callBlocked.rankingEligible, false);
  const tiltBlocked = computeEtfAbcObservation(matureSample({ quarters, metrics, reserveStatus: 'verified' }));
  assert.equal(tiltBlocked.comparisonStatus, 'incomplete');
  assert.equal(tiltBlocked.rankingEligible, false);
});

test('unavailable common valuation makes returns and comparison unavailable without bridging', () => {
  const calendar = {
    status: 'unavailable', economicDateHkt: '2026-09-02', effectiveMarketDate: '2026-09-02',
    observationCutoffHkt: '2026-09-02T23:59:59+08:00', staleMarketClosed: false,
    coverage: coverage(),
    priceDates: {},
  };
  const result = computeEtfAbcObservation(sample({ calendar }));
  assert.equal(result.arms.A.dailyReturn, null);
  assert.equal(result.arms.B.dailyReturn, null);
  assert.equal(result.arms.C.dailyReturn, null);
  assert.equal(result.comparisonStatus, 'incomplete');

  const partialCarry = structuredClone(calendar);
  partialCarry.staleMarketClosed = true;
  partialCarry.priceDates = {
    CSPX: { date: '2026-09-01', closeAtHkt: '2026-09-01T23:00:00+08:00', status: 'market-closed-carry' },
  };
  const partialResult = computeEtfAbcObservation(sample({ calendar: partialCarry }));
  const partialCard = renderEtfAbcRuntimeCard(partialResult);
  assert.match(partialCard, /估值不完整/);
  assert.doesNotMatch(partialCard, /休市顺延/);
});

test('pending T0 baseline records flow state but publishes no comparable daily return', () => {
  const baseline = {
    status: 'pending', dateHkt: ETF_ABC_T0_DATE, mode: 'clone-a-marginal-shadow',
    aHoldingsFingerprint: null, bHoldingsFingerprint: null, aValueUsd: null, bValueUsd: null,
  };
  const result = computeEtfAbcObservation(sample({ baseline }));
  assert.equal(result.arms.A.dailyReturn, null);
  assert.equal(result.arms.B.dailyReturn, null);
  assert.equal(result.arms.C.dailyReturn, null);
  assert.equal(result.arms.B.pendingCashUnallocatedUsd, 125);
  assert.equal(result.comparisonStatus, 'incomplete');
});

test('unknown fields, non-finite values and non-cent cash fail closed', () => {
  assert.throws(() => validateEtfAbcInput({ ...sample(), liveOrder: true }), /schema/);
  const nan = sample();
  nan.arms.A.openingValueUsd = Number.NaN;
  assert.throws(() => validateEtfAbcInput(nan), /Invalid A valuation/);
  const fractions = sample();
  fractions.flow.amountUsd = 1.001;
  fractions.flow.applications = applications(1.001);
  assert.throws(() => validateEtfAbcInput(fractions), /amount or FX/);
});

test('engine is pure and does not mutate the validated input', () => {
  const input = sample();
  const before = JSON.stringify(input);
  computeEtfAbcObservation(input);
  assert.equal(JSON.stringify(input), before);
});

test('compact runtime card is static, read-only and contains no composite score or action control', () => {
  const result = computeEtfAbcObservation(sample());
  assert.equal(validateEtfAbcResult(result), result);
  const html = renderEtfAbcRuntimeCard(result);
  assert.match(html, /XUAN-ETF · A\/B\/C/);
  assert.match(html, /T0 2026-09-01/);
  assert.match(html, /基线已建立 · 暂不比较/);
  assert.match(html, /资金流同日同额 · EOD/);
  assert.match(html, /新现金待分配 · 比较暂停/);
  assert.match(html, /0\/4 完整季度 · 暂不排名/);
  assert.match(html, /只读方法 · 不下单、不改单、不撤单、不转账/);
  assert.doesNotMatch(html, /<script|<button|<form|<a\b|fetch\(|综合分/i);
});

test('renderer rejects forged result fields instead of leaking them into public state', () => {
  const result = computeEtfAbcObservation(sample());
  assert.throws(() => renderEtfAbcRuntimeCard({ ...result, secretNav: 123456 }), /result schema/);
  assert.throws(() => renderEtfAbcRuntimeCard({ ...result, economicDateHkt: '<img src=x>' }), /Validated/);

  const mismatchedFlow = structuredClone(result);
  mismatchedFlow.arms.B.externalFlowUsdEod += 1;
  mismatchedFlow.arms.B.endingValueAfterFlowUsd += 1;
  assert.throws(() => renderEtfAbcRuntimeCard(mismatchedFlow), /Validated/);

  const contradictoryCalendar = structuredClone(result);
  contradictoryCalendar.staleMarketClosed = true;
  assert.throws(() => renderEtfAbcRuntimeCard(contradictoryCalendar), /Validated/);

  const forgedEligibility = structuredClone(result);
  forgedEligibility.rankingEligible = true;
  forgedEligibility.rankingStatus = 'eligible-raw-metrics-only-no-rank';
  assert.throws(() => renderEtfAbcRuntimeCard(forgedEligibility), /Validated/);

  const forgedImplementation = structuredClone(result);
  forgedImplementation.arms.B.implementationStatus = 'incomplete-call-reserve';
  assert.throws(() => renderEtfAbcRuntimeCard(forgedImplementation), /Validated/);

  const carryWithReturns = computeEtfAbcObservation(sample({
    economicDateHkt: '2026-09-05', effectiveMarketDate: '2026-09-08',
  }));
  for (const arm of ['A', 'B', 'C']) {
    carryWithReturns.arms[arm].dailyReturn = carryWithReturns.arms[arm].endingValueBeforeFlowUsd
      / carryWithReturns.arms[arm].openingValueUsd - 1;
  }
  assert.throws(() => renderEtfAbcRuntimeCard(carryWithReturns), /Validated/);
});

const policy = renderPolicySection(JSON.parse(readFileSync(new URL('../claude/xuan-ib-policy-v2.json', import.meta.url), 'utf8')));
const candidate = prefix => `${prefix}<div class="pane p4">unchanged</div><div class="pane p5">before${policy}after<div>nested pane content</div></div><footer>tail</footer>`;

test('pure upsert inserts the runtime block directly after canonical policy in the unique p5', () => {
  const source = candidate('<!doctype html><main>');
  const output = upsertEtfAbcRuntime(source, computeEtfAbcObservation(sample()));
  assert.ok(output.indexOf('xuan-ib-policy-v2') < output.indexOf('xuan-ib-etf-abc-runtime:v1:start'));
  assert.ok(output.indexOf('xuan-ib-etf-abc-runtime:v1:end') < output.indexOf('after<div>nested pane content'));
  assert.ok(output.startsWith('<!doctype html><main><div class="pane p4">unchanged</div><div class="pane p5">before'));
  assert.ok(output.endsWith('</div><footer>tail</footer>'));
});

test('upsert replaces one existing runtime block and is idempotent', () => {
  const result = computeEtfAbcObservation(sample());
  const once = upsertEtfAbcRuntime(candidate(''), result);
  const twice = upsertEtfAbcRuntime(once, result);
  assert.equal(twice, once);
  assert.equal((twice.match(/xuan-ib-etf-abc-runtime:v1:start/g) || []).length, 1);
  assert.equal((twice.match(/id="xuan-ib-etf-abc-state-v1"/g) || []).length, 1);
});

test('upsert public template carries statuses but no live values, prices or flow amounts', () => {
  const output = upsertEtfAbcRuntime(candidate(''), computeEtfAbcObservation(sample({ amountUsd: 137 })));
  const state = output.match(/<template id="xuan-ib-etf-abc-state-v1" type="application\/json">([^<]+)<\/template>/)?.[1];
  assert.ok(state);
  const parsed = JSON.parse(state);
  assert.equal(parsed.methodId, ETF_ABC_METHOD_ID);
  assert.equal(parsed.bImplementationStatus, 'pending-cash-unallocated');
  assert.equal(JSON.stringify(parsed).includes('137'), false);
  for (const forbidden of ['openingValueUsd', 'endingValueAfterFlowUsd', 'pendingCashUnallocatedUsd', 'rawMetrics']) {
    assert.equal(forbidden in parsed, false);
  }
});

test('public runtime parser accepts only the exact canonical flat shape', () => {
  const result = computeEtfAbcObservation(sample());
  const output = upsertEtfAbcRuntime(candidate(''), result);
  const json = output.match(/<template id="xuan-ib-etf-abc-state-v1" type="application\/json">([^<]+)<\/template>/)?.[1];
  assert.ok(json);
  const state = parseEtfAbcPublicRuntimeStateJson(json);
  assert.equal(validateEtfAbcPublicRuntimeState(state), state);
  assert.throws(() => parseEtfAbcPublicRuntimeStateJson(` ${json}`), /not canonical/);
  assert.throws(() => parseEtfAbcPublicRuntimeStateJson(json.replace('{"schemaVersion":1', '{"schemaVersion":1,"schemaVersion":1')), /not canonical/);
  assert.throws(() => parseEtfAbcPublicRuntimeStateJson(json.replace(/}$/, ',"unknown":true}')), /schema/);
  const reorderedEntries = Object.entries(state);
  [reorderedEntries[0], reorderedEntries[1]] = [reorderedEntries[1], reorderedEntries[0]];
  assert.throws(() => parseEtfAbcPublicRuntimeStateJson(JSON.stringify(Object.fromEntries(reorderedEntries))), /not canonical/);
  assert.throws(() => validateEtfAbcPublicRuntimeState({ ...state, bImplementationStatus: 'read-only-awaiting-shadow-signal' }), /internally inconsistent/);
  assert.equal(renderEtfAbcPublicRuntimeCard(state), renderEtfAbcRuntimeCard(result));
  const visibleCard = output.match(/<section class="xuan-etf-abc-runtime"[\s\S]*?<\/section>/)?.[0];
  assert.equal(visibleCard, renderEtfAbcPublicRuntimeCard(state));
  assert.notEqual(visibleCard.replace('暂不排名', '伪造为可排名'), renderEtfAbcPublicRuntimeCard(state));
});

test('initial publication gate permits only pending, non-comparable, unranked evidence', () => {
  const pendingBaseline = {
    status: 'pending', dateHkt: ETF_ABC_T0_DATE, mode: 'clone-a-marginal-shadow',
    aHoldingsFingerprint: null, bHoldingsFingerprint: null, aValueUsd: null, bValueUsd: null,
  };
  const pendingOutput = upsertEtfAbcRuntime(candidate(''), computeEtfAbcObservation(sample({ baseline: pendingBaseline })));
  const pendingJson = pendingOutput.match(/<template id="xuan-ib-etf-abc-state-v1" type="application\/json">([^<]+)<\/template>/)?.[1];
  const pendingState = parseEtfAbcPublicRuntimeStateJson(pendingJson);
  assert.equal(validateEtfAbcInitialPublicRuntimeState(pendingState), pendingState);
  assert.equal(pendingState.calendarStatus, 'complete');
  const pendingCard = renderEtfAbcPublicRuntimeCard(pendingState);
  assert.match(pendingCard, /基线待建立 · 暂不比较/);
  assert.equal((pendingCard.match(/<p>/g) ?? []).length, 6);

  const establishedOutput = upsertEtfAbcRuntime(candidate(''), computeEtfAbcObservation(sample()));
  const establishedJson = establishedOutput.match(/<template id="xuan-ib-etf-abc-state-v1" type="application\/json">([^<]+)<\/template>/)?.[1];
  const establishedState = parseEtfAbcPublicRuntimeStateJson(establishedJson);
  assert.throws(() => validateEtfAbcInitialPublicRuntimeState(establishedState), /baseline-pending/);
  assert.deepEqual(Object.keys(establishedState).filter(key => JSON.stringify(establishedState[key]) !== JSON.stringify(pendingState[key])), ['baselineStatus']);
  assert.match(renderEtfAbcPublicRuntimeCard(establishedState), /基线已建立 · 暂不比较/);
  assert.notEqual(renderEtfAbcPublicRuntimeCard(establishedState), pendingCard);
});

test('public runtime card bytes visibly encode comparison status', () => {
  const completeResult = computeEtfAbcObservation(sample({
    reserveStatus: 'verified', tiltState: 'zero', flow: null, pendingCashUnallocatedUsd: 0,
  }));
  const completeOutput = upsertEtfAbcRuntime(candidate(''), completeResult);
  const completeJson = completeOutput.match(/<template id="xuan-ib-etf-abc-state-v1" type="application\/json">([^<]+)<\/template>/)?.[1];
  const completeState = parseEtfAbcPublicRuntimeStateJson(completeJson);
  const incompleteState = { ...completeState, comparisonStatus: 'incomplete' };
  validateEtfAbcPublicRuntimeState(incompleteState);
  const completeCard = renderEtfAbcPublicRuntimeCard(completeState);
  const incompleteCard = renderEtfAbcPublicRuntimeCard(incompleteState);
  assert.match(completeCard, /基线已建立 · 比较完成/);
  assert.match(incompleteCard, /基线已建立 · 暂不比较/);
  assert.notEqual(completeCard, incompleteCard);
});

test('upsert fails closed for a missing or duplicate p5', () => {
  const result = computeEtfAbcObservation(sample());
  assert.throws(() => upsertEtfAbcRuntime(`<div class="pane p4">${policy}</div>`, result), /exactly one existing \.pane\.p5/);
  assert.throws(() => upsertEtfAbcRuntime(`<div class="pane p5">${policy}</div><div class="p5 pane">${policy}</div>`, result), /exactly one existing \.pane\.p5/);
  for (const inert of ['iframe', 'noembed', 'noframes', 'noscript', 'script', 'style', 'textarea', 'title', 'xmp']) {
    assert.throws(() => upsertEtfAbcRuntime(`<${inert}><div class="pane p5">${policy}</div></${inert}>`, result), /exactly one existing \.pane\.p5/);
  }
  assert.throws(() => upsertEtfAbcRuntime(`<plaintext><div class="pane p5">${policy}</div>`, result), /plaintext is forbidden/);
});

test('upsert requires one fingerprint-bound policy inside p5', () => {
  const result = computeEtfAbcObservation(sample());
  assert.throws(() => upsertEtfAbcRuntime('<div class="pane p5">empty</div>', result), /exactly one canonical policy/);
  assert.throws(() => upsertEtfAbcRuntime('<div class="pane p5"><section id="xuan-ib-policy-v2">unbound</section></div>', result), /Canonical policy bytes/);
  const fake = `<div class="pane p5"><section id="xuan-ib-policy-v2" data-policy-fingerprint="${fp('d')}"><!-- xuan-ib-index-etf-policy-v2:${fp('d')} --></section></div>`;
  assert.throws(() => upsertEtfAbcRuntime(fake, result), /Canonical policy bytes/);
  assert.throws(() => upsertEtfAbcRuntime(`<div data-class="pane p5">${policy}</div>`, result), /exactly one existing/);
  assert.throws(() => upsertEtfAbcRuntime(`<div class="pane p5"><section data-id="xuan-ib-policy-v2"><!-- xuan-ib-index-etf-policy-v2:${ETF_ABC_POLICY_FINGERPRINT} --></section></div>`, result), /exactly one canonical policy/);
  assert.throws(() => upsertEtfAbcRuntime(`<!-- <div class="pane p5">${policy}</div> -->`, result), /exactly one existing/);
  assert.throws(() => upsertEtfAbcRuntime(`<div data-x=" class='pane p5'>">${policy}</div>`, result), /exactly one existing/);
  assert.throws(() => upsertEtfAbcRuntime(`<div class="pane p5">${policy.replace('长期配置', '改变政策')}</div>`, result), /Canonical policy bytes/);
});

test('upsert rejects duplicate, orphaned or misplaced runtime markers', () => {
  const result = computeEtfAbcObservation(sample());
  const orphan = candidate('') .replace('after<div>nested pane content', '<!-- xuan-ib-etf-abc-runtime:v1:start -->after<div>nested pane content');
  assert.throws(() => upsertEtfAbcRuntime(orphan, result), /one complete pair/);
  const outside = `<!-- xuan-ib-etf-abc-runtime:v1:start -->old<!-- xuan-ib-etf-abc-runtime:v1:end -->${candidate('')}`;
  assert.throws(() => upsertEtfAbcRuntime(outside, result), /inside \.pane\.p5/);
  const intervening = upsertEtfAbcRuntime(candidate(''), result).replace('</section>\n<!-- xuan-ib-etf-abc-runtime:v1:start -->', '</section><aside>other module</aside>\n<!-- xuan-ib-etf-abc-runtime:v1:start -->');
  assert.throws(() => upsertEtfAbcRuntime(intervening, result), /inside \.pane\.p5/);
  const duplicateState = upsertEtfAbcRuntime(candidate(''), result).replace('<footer>', '<template id="xuan-ib-etf-abc-state-v1"></template><footer>');
  assert.throws(() => upsertEtfAbcRuntime(duplicateState, result), /inside \.pane\.p5/);
  const unquotedDuplicateState = upsertEtfAbcRuntime(candidate(''), result).replace('<footer>', '<template id=xuan-ib-etf-abc-state-v1>PRIVATE-NAV</template><footer>');
  assert.throws(() => upsertEtfAbcRuntime(unquotedDuplicateState, result), /inside \.pane\.p5/);
  const encodedDuplicateState = upsertEtfAbcRuntime(candidate(''), result).replace('<footer>', '<template id="xuan&#x2d;ib-etf-abc-state-v1">PRIVATE-NAV</template><footer>');
  assert.throws(() => upsertEtfAbcRuntime(encodedDuplicateState, result), /Character references/);
});

test('trusted runtime-class scanner is quote-aware and counts each real visible opening element', () => {
  assert.equal(countVisibleEtfAbcRuntimeClassElements(
    `<div data-note="> <span class='xuan-etf-abc-runtime'>" class="other xuan-etf-abc-runtime"></div>`,
  ), 1);
  assert.equal(countVisibleEtfAbcRuntimeClassElements([
    '<div class="xuan-etf-abc-runtime"></div>',
    '<span class="alpha xuan-etf-abc-runtime beta"></span>',
    '<x-phone-card class=xuan-etf-abc-runtime></x-phone-card>',
  ].join('')), 3);
});

test('trusted runtime-class scanner ignores comment, template and raw-text identities', () => {
  const html = `<!-- <div class="xuan-etf-abc-runtime"></div> -->
<template class="xuan-etf-abc-runtime"><span class="xuan-etf-abc-runtime"></span></template>
<script class="xuan-etf-abc-runtime"><div class="xuan-etf-abc-runtime"></div></script>
<style>.x::after{content:'<i class="xuan-etf-abc-runtime">'}</style>
<section class="xuan-etf-abc-runtime"></section>`;
  assert.equal(countVisibleEtfAbcRuntimeClassElements(html), 1);
});

test('trusted runtime-class scanner fails closed on malformed or entity-encoded class identity', () => {
  assert.throws(() => countVisibleEtfAbcRuntimeClassElements('<div class="xuan-etf-abc&#45;runtime"></div>'), /Character references/);
  assert.throws(() => countVisibleEtfAbcRuntimeClassElements('<div class="xuan-etf-abc-runtime></div>'), /Unclosed tag/);
  assert.throws(() => countVisibleEtfAbcRuntimeClassElements('<div class="other" class="xuan-etf-abc-runtime"></div>'), /Duplicate HTML attribute/);
  for (const inert of ['template', 'script', 'textarea']) {
    assert.throws(
      () => countVisibleEtfAbcRuntimeClassElements(`<${inert}/><x-card class="xuan-etf-abc-runtime"></x-card>`),
      /Self-closing .* is forbidden/,
    );
  }
  assert.throws(() => countVisibleEtfAbcRuntimeClassElements(null), /requires HTML text/);
});
