import { createHash } from 'node:crypto';

export const ETF_ABC_METHOD_ID = 'xuan-ib-etf-abc-v1';
export const ETF_ABC_T0_DATE = '2026-09-01';
export const ETF_ABC_POLICY_FINGERPRINT = '3de814cae31f058f8209f47771df03cf453ef985559274646234f5e43836af7f';
export const ETF_ABC_CANONICAL_POLICY_SECTION_SHA256 = '2a3ca4662bcd773d5a13c217d0f5775d5678e173a0c349a94431aaf78aab708a';
export const ETF_ABC_RUNTIME_START = '<!-- xuan-ib-etf-abc-runtime:v1:start -->';
export const ETF_ABC_RUNTIME_END = '<!-- xuan-ib-etf-abc-runtime:v1:end -->';
export const ETF_ABC_METRICS = Object.freeze([
  'afterTaxReturn',
  'maximumDrawdown',
  'aiParticipation',
  'usSitusShare',
  'callCoverage',
]);

const ROOT_KEYS = ['schemaVersion', 'methodId', 'mode', 't0DateHkt', 'baseline', 'calendar', 'flow', 'arms', 'tiltState', 'tiltValidation', 'quarters', 'metrics'];
const BASELINE_KEYS = ['status', 'dateHkt', 'mode', 'aHoldingsFingerprint', 'bHoldingsFingerprint', 'aValueUsd', 'bValueUsd'];
const CALENDAR_KEYS = ['status', 'economicDateHkt', 'effectiveMarketDate', 'observationCutoffHkt', 'staleMarketClosed', 'coverage', 'priceDates'];
const COVERAGE_KEYS = ['aHoldingsFingerprint', 'bShadowUnitsFingerprint', 'requiredInstruments', 'evidenceFingerprint'];
const REQUIRED_INSTRUMENT_KEYS = ['A', 'B', 'C'];
const FLOW_KEYS = ['economicEventId', 'classification', 'economicDateHkt', 'effectiveMarketDate', 'amountUsd', 'fx', 'applications'];
const FX_KEYS = ['identity', 'pair', 'rate', 'asOfHkt', 'source'];
const APPLICATION_KEYS = ['arm', 'economicDateHkt', 'effectiveMarketDate', 'amountUsd', 'fxIdentity'];
const VALUE_KEYS = ['openingValueUsd', 'endingValueBeforeFlowUsd'];
const A_KEYS = [...VALUE_KEYS, 'holdingsFingerprint'];
const B_KEYS = [...VALUE_KEYS, 'baselineMode', 'reserveStatus', 'requiredReserveUsd', 'reserveEvidence', 'pendingCashUnallocatedUsd', 'pendingOutflowUnsimulatedUsd', 'shadowUnitsFingerprint'];
const C_KEYS = [...VALUE_KEYS, 'ticker', 'isin', 'distribution', 'cashDividendUsd'];
const RESERVE_EVIDENCE_KEYS = ['asOfHkt', 'verified90dCallsUsd', 'approvedBufferUsd', 'fxOpsBufferUsd', 'evidenceFingerprint'];
const QUARTER_KEYS = ['id', 'status'];
const PRICE_REFERENCE_KEYS = ['date', 'closeAtHkt', 'status'];
const TILT_VALIDATION_KEYS = ['status', 'evidenceFingerprint', 'effectiveMarketDate'];
const RESULT_KEYS = ['schemaVersion', 'methodId', 'mode', 't0DateHkt', 't0QuarterStatus', 'baselineStatus', 'economicDateHkt', 'effectiveMarketDate', 'observationCutoffHkt', 'calendarStatus', 'staleMarketClosed', 'valuationCoverage', 'comparisonStatus', 'targetVector', 'arms', 'rawMetrics', 'completedQuarterIds', 'completeQuarterCount', 'minimumCompleteQuartersForRanking', 'rankingEligible', 'rankingStatus'];
const PUBLIC_RUNTIME_KEYS = ['schemaVersion', 'methodId', 'mode', 't0DateHkt', 't0QuarterStatus', 'baselineStatus', 'baselineCheckpointHash', 'economicDateHkt', 'effectiveMarketDate', 'calendarStatus', 'staleMarketClosed', 'comparisonStatus', 'targetVectorStatus', 'bReserveStatus', 'bPendingCashUnallocated', 'bPendingOutflowUnsimulated', 'bImplementationStatus', 'cDistributionTreatment', 'rawMetricsComplete', 'completedQuarterIds', 'completeQuarterCount', 'minimumCompleteQuartersForRanking', 'rankingEligible', 'rankingStatus'];
const RAW_TEXT_ELEMENTS = new Set(['iframe', 'noembed', 'noframes', 'noscript', 'script', 'style', 'textarea', 'title', 'xmp']);
const ETF_ABC_RUNTIME_CLASS = 'xuan-etf-abc-runtime';
const TARGET_ZERO = Object.freeze({ CSPX: 0.60, EQAC: 0, USSC: 0.05, EXUS: 0.23, EIMI: 0.12 });
const TARGET_EIGHT = Object.freeze({ CSPX: 0.52, EQAC: 0.08, USSC: 0.05, EXUS: 0.23, EIMI: 0.12 });
const B_REQUIRED_INSTRUMENTS = Object.freeze(['CSPX', 'EIMI', 'EQAC', 'EXUS', 'USSC']);
const C_REQUIRED_INSTRUMENTS = Object.freeze(['CSPX']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, keys, label) {
  if (!isRecord(value) || Object.keys(value).length !== keys.length
      || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error(`${label} schema differs from xuan-ib-etf-abc-v1`);
  }
}

function validDate(value) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

function calendarDaysBetween(startDate, endDate) {
  return (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000;
}

function validHktTimestamp(value) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+08:00$/);
  if (!match) return false;
  const [, y, m, d, h, min, sec] = match.map(Number);
  return validDate(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
    && h < 24 && min < 60 && sec < 60;
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
}

function validFingerprint(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validMoney(value, { positive = false } = {}) {
  return typeof value === 'number' && Number.isFinite(value) && value >= (positive ? 0.01 : 0)
    && value <= 1e12 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

function validSignedMoney(value) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12
    && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

function cents(value) {
  return Math.round(value * 100) / 100;
}

function canonicalHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateBaseline(baseline) {
  exactKeys(baseline, BASELINE_KEYS, 'baseline');
  if (baseline.dateHkt !== ETF_ABC_T0_DATE || baseline.mode !== 'clone-a-marginal-shadow'
      || !['pending', 'established'].includes(baseline.status)) throw new Error('T0 baseline contract is invalid');
  if (baseline.status === 'pending') {
    for (const key of ['aHoldingsFingerprint', 'bHoldingsFingerprint', 'aValueUsd', 'bValueUsd']) {
      if (baseline[key] !== null) throw new Error('Pending T0 baseline must not contain invented values');
    }
    return;
  }
  if (!validFingerprint(baseline.aHoldingsFingerprint) || baseline.aHoldingsFingerprint !== baseline.bHoldingsFingerprint
      || !validMoney(baseline.aValueUsd, { positive: true }) || baseline.aValueUsd !== baseline.bValueUsd) {
    throw new Error('B must be an exact clone of A at the established T0 baseline');
  }
}

function validateInstrumentList(value, label, { exact = null } = {}) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => !validId(item))
      || new Set(value).size !== value.length || value.some((item, index) => index > 0 && value[index - 1] >= item)
      || (exact && JSON.stringify(value) !== JSON.stringify(exact))) {
    throw new Error(`${label} must be a sorted, complete instrument universe`);
  }
}

function validateCoverage(coverage) {
  exactKeys(coverage, COVERAGE_KEYS, 'calendar.coverage');
  exactKeys(coverage.requiredInstruments, REQUIRED_INSTRUMENT_KEYS, 'calendar.coverage.requiredInstruments');
  if (!validFingerprint(coverage.aHoldingsFingerprint) || !validFingerprint(coverage.bShadowUnitsFingerprint)
      || !validFingerprint(coverage.evidenceFingerprint)) {
    throw new Error('Valuation coverage requires holdings-bound fingerprints');
  }
  validateInstrumentList(coverage.requiredInstruments.A, 'A valuation coverage');
  validateInstrumentList(coverage.requiredInstruments.B, 'B valuation coverage', { exact: B_REQUIRED_INSTRUMENTS });
  validateInstrumentList(coverage.requiredInstruments.C, 'C valuation coverage', { exact: C_REQUIRED_INSTRUMENTS });
  const evidence = {
    aHoldingsFingerprint: coverage.aHoldingsFingerprint,
    bShadowUnitsFingerprint: coverage.bShadowUnitsFingerprint,
    requiredInstruments: coverage.requiredInstruments,
  };
  if (coverage.evidenceFingerprint !== canonicalHash(evidence)) {
    throw new Error('Valuation coverage evidence does not match its holdings and instrument universes');
  }
}

function validateCalendar(calendar) {
  exactKeys(calendar, CALENDAR_KEYS, 'calendar');
  if (!['complete', 'market-closed-carry', 'unavailable'].includes(calendar.status)
      || !validDate(calendar.economicDateHkt) || calendar.economicDateHkt < ETF_ABC_T0_DATE
      || !validDate(calendar.effectiveMarketDate)
      || calendar.effectiveMarketDate < calendar.economicDateHkt
      || !validHktTimestamp(calendar.observationCutoffHkt)
      || !isRecord(calendar.priceDates)) throw new Error('Common valuation calendar is invalid');
  validateCoverage(calendar.coverage);
  if (calendar.status === 'complete' && (calendar.staleMarketClosed !== false || calendar.effectiveMarketDate !== calendar.economicDateHkt)) {
    throw new Error('A complete common valuation date cannot be stale or delayed');
  }
  if (calendar.status === 'market-closed-carry'
      && (calendar.staleMarketClosed !== true || calendar.effectiveMarketDate === calendar.economicDateHkt
        || calendarDaysBetween(calendar.economicDateHkt, calendar.effectiveMarketDate) > 7)) {
    throw new Error('A market-closed carry must be visible and use a bounded later effective market date');
  }
  if (calendar.status === 'unavailable'
      && (typeof calendar.staleMarketClosed !== 'boolean' || calendar.effectiveMarketDate !== calendar.economicDateHkt)) {
    throw new Error('Unavailable calendar must retain an explicit stale flag without inventing a future effective date');
  }
  if (calendar.observationCutoffHkt.slice(0, 10) < calendar.economicDateHkt) {
    throw new Error('Observation cutoff cannot precede the economic date');
  }
  const priceEntries = Object.entries(calendar.priceDates);
  if (calendar.status !== 'unavailable' && priceEntries.length === 0) throw new Error('Available calendar requires dated prices');
  if (calendar.status !== 'unavailable' && !Object.prototype.hasOwnProperty.call(calendar.priceDates, 'CSPX')) {
    throw new Error('Available calendar requires an exact CSPX price reference');
  }
  let carriedPriceCount = 0;
  for (const [instrument, reference] of priceEntries) {
    exactKeys(reference, PRICE_REFERENCE_KEYS, `calendar.priceDates.${instrument}`);
    const ageMilliseconds = Date.parse(calendar.observationCutoffHkt) - Date.parse(reference.closeAtHkt);
    const closeHktDate = reference.closeAtHkt?.slice(0, 10);
    if (!validId(instrument) || !validDate(reference.date) || reference.date > calendar.economicDateHkt
        || !validHktTimestamp(reference.closeAtHkt) || closeHktDate !== reference.date
        || reference.closeAtHkt > calendar.observationCutoffHkt
        || !['official-close', 'market-closed-carry'].includes(reference.status)
        || (reference.status === 'official-close' && reference.date !== calendar.economicDateHkt)
        || (reference.status === 'market-closed-carry' && reference.date >= calendar.economicDateHkt)
        || ageMilliseconds < 0 || ageMilliseconds > (reference.status === 'official-close' ? 36 : 24 * 7) * 60 * 60 * 1000) {
      throw new Error('Price references must be completed closes known by the observation cutoff');
    }
    if (reference.status === 'market-closed-carry') carriedPriceCount += 1;
  }
  if (calendar.status !== 'unavailable') {
    const covered = new Set(Object.keys(calendar.priceDates));
    const required = new Set(Object.values(calendar.coverage.requiredInstruments).flat());
    if ([...required].some(instrument => !covered.has(instrument))) {
      throw new Error('Available comparison requires complete A/B/C instrument price coverage');
    }
  }
  if (calendar.status === 'complete' && carriedPriceCount !== 0) throw new Error('A complete calendar cannot contain a carried price');
  if (calendar.status === 'market-closed-carry' && carriedPriceCount === 0) throw new Error('A market-closed carry requires at least one visibly carried price');
}

function validateFlow(flow, calendar) {
  if (flow === null) return;
  exactKeys(flow, FLOW_KEYS, 'flow');
  exactKeys(flow.fx, FX_KEYS, 'flow.fx');
  if (!validId(flow.economicEventId) || flow.classification !== 'external'
      || flow.economicDateHkt !== calendar.economicDateHkt
      || flow.effectiveMarketDate !== calendar.effectiveMarketDate
      || !validMoney(Math.abs(flow.amountUsd), { positive: true })
      || !validId(flow.fx.identity) || !/^[A-Z]{3}\/[A-Z]{3}$/.test(flow.fx.pair)
      || typeof flow.fx.rate !== 'number' || !Number.isFinite(flow.fx.rate) || flow.fx.rate <= 0
      || (flow.fx.pair === 'USD/USD' && flow.fx.rate !== 1)
      || !validHktTimestamp(flow.fx.asOfHkt) || flow.fx.asOfHkt > calendar.observationCutoffHkt
      || typeof flow.fx.source !== 'string' || !flow.fx.source.trim()) {
    throw new Error('External flow identity, amount or FX evidence is invalid');
  }
  if (!Array.isArray(flow.applications) || flow.applications.length !== 3) throw new Error('External flow must apply exactly once to A, B and C');
  const seen = new Set();
  for (const application of flow.applications) {
    exactKeys(application, APPLICATION_KEYS, 'flow application');
    if (!['A', 'B', 'C'].includes(application.arm) || seen.has(application.arm)) throw new Error('External flow must apply exactly once to A, B and C');
    seen.add(application.arm);
    if (application.economicDateHkt !== flow.economicDateHkt
        || application.effectiveMarketDate !== flow.effectiveMarketDate
        || application.amountUsd !== flow.amountUsd || application.fxIdentity !== flow.fx.identity) {
      throw new Error('A, B and C require the same flow date, amount and FX identity');
    }
  }
}

function validateArmValue(arm, label) {
  for (const key of VALUE_KEYS) if (!validMoney(arm[key], { positive: key === 'openingValueUsd' })) throw new Error(`Invalid ${label} valuation: ${key}`);
}

function validateArms(arms, calendar) {
  exactKeys(arms, ['A', 'B', 'C'], 'arms');
  exactKeys(arms.A, A_KEYS, 'arms.A');
  exactKeys(arms.B, B_KEYS, 'arms.B');
  exactKeys(arms.C, C_KEYS, 'arms.C');
  validateArmValue(arms.A, 'A');
  validateArmValue(arms.B, 'B');
  validateArmValue(arms.C, 'C');
  if (!validFingerprint(arms.A.holdingsFingerprint)
      || arms.A.holdingsFingerprint !== calendar.coverage.aHoldingsFingerprint) {
    throw new Error('A valuation coverage is not bound to the current holdings inventory');
  }
  const b = arms.B;
  if (b.baselineMode !== 'clone-a-marginal-shadow' || !['incomplete', 'verified'].includes(b.reserveStatus)
      || !validMoney(b.pendingCashUnallocatedUsd) || !validMoney(b.pendingOutflowUnsimulatedUsd)
      || !validFingerprint(b.shadowUnitsFingerprint)
      || b.shadowUnitsFingerprint !== calendar.coverage.bShadowUnitsFingerprint) throw new Error('B shadow state is invalid');
  if (b.reserveStatus === 'incomplete' && (b.requiredReserveUsd !== null || b.reserveEvidence !== null)) {
    throw new Error('B CALL reserve must remain null until verified');
  }
  if (b.reserveStatus === 'verified') {
    exactKeys(b.reserveEvidence, RESERVE_EVIDENCE_KEYS, 'arms.B.reserveEvidence');
    const reserve = b.reserveEvidence;
    if (!validHktTimestamp(reserve.asOfHkt) || reserve.asOfHkt > calendar.observationCutoffHkt
        || !validFingerprint(reserve.evidenceFingerprint)
        || !validMoney(reserve.verified90dCallsUsd) || !validMoney(reserve.approvedBufferUsd)
        || !validMoney(reserve.fxOpsBufferUsd)
        || b.requiredReserveUsd !== cents(Math.max(240000,
          reserve.verified90dCallsUsd + reserve.approvedBufferUsd + reserve.fxOpsBufferUsd))) {
      throw new Error('B CALL reserve requires dated formula evidence');
    }
  }
  const c = arms.C;
  if (c.ticker !== 'CSPX' || c.isin !== 'IE00B5BMR087' || c.distribution !== 'accumulation'
      || c.cashDividendUsd !== 0) throw new Error('C must use the exact CSPX accumulating share class with no added cash dividend');
}

function quarterEndDate(quarterId) {
  const [, yearText, quarterText] = quarterId.match(/^(\d{4})-Q([1-4])$/) ?? [];
  if (!yearText) return null;
  const ends = ['03-31', '06-30', '09-30', '12-31'];
  return `${yearText}-${ends[Number(quarterText) - 1]}`;
}

function validateQuarters(quarters, calendar) {
  if (!Array.isArray(quarters) || quarters.length === 0) throw new Error('Quarter ledger is required');
  const t0 = quarters.find(quarter => quarter?.id === '2026-Q3');
  if (!t0 || t0.status !== 'stub') throw new Error('2026-Q3 is the T0 stub and can never be counted as a complete quarter');
  const seen = new Set();
  for (const quarter of quarters) {
    exactKeys(quarter, QUARTER_KEYS, 'quarter');
    if (!/^\d{4}-Q[1-4]$/.test(quarter.id) || !['stub', 'complete', 'incomplete'].includes(quarter.status) || seen.has(quarter.id)
        || quarter.id < '2026-Q3' || (quarter.id !== '2026-Q3' && quarter.status === 'stub')
        || (quarter.status === 'complete' && quarterEndDate(quarter.id) >= calendar.economicDateHkt)) {
      throw new Error('Quarter ledger is invalid');
    }
    seen.add(quarter.id);
  }
}

function validateMetrics(metrics) {
  exactKeys(metrics, ETF_ABC_METRICS, 'metrics');
  const ranges = {
    afterTaxReturn: [-1, 100], maximumDrawdown: [0, 1], aiParticipation: [0, 1],
    usSitusShare: [0, 1], callCoverage: [0, 1e6],
  };
  for (const key of ETF_ABC_METRICS) {
    const value = metrics[key];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value)
        || value < ranges[key][0] || value > ranges[key][1])) throw new Error(`Invalid raw metric: ${key}`);
  }
}

function validateTilt(tiltState, validation, calendar) {
  if (!['pending-validation', 'zero', 'eight'].includes(tiltState)) throw new Error('AI tilt state is invalid');
  exactKeys(validation, TILT_VALIDATION_KEYS, 'tiltValidation');
  if (!['pending', 'verified'].includes(validation.status)) throw new Error('AI tilt validation state is invalid');
  if (validation.status === 'pending') {
    if (validation.evidenceFingerprint !== null || validation.effectiveMarketDate !== null) {
      throw new Error('Pending AI tilt validation must not contain invented evidence');
    }
  } else if (!validFingerprint(validation.evidenceFingerprint) || !validDate(validation.effectiveMarketDate)
      || validation.effectiveMarketDate < ETF_ABC_T0_DATE
      || validation.effectiveMarketDate > calendar.observationCutoffHkt.slice(0, 10)) {
    throw new Error('Verified AI tilt requires dated evidence known by the observation');
  }
  if (tiltState === 'eight' && validation.status !== 'verified') throw new Error('Eight-percent AI tilt requires verified mapping and exposure evidence');
  if (tiltState === 'pending-validation' && validation.status !== 'pending') throw new Error('Pending AI tilt state cannot claim verified evidence');
}

export function validateEtfAbcInput(input) {
  exactKeys(input, ROOT_KEYS, 'ETF A/B/C input');
  if (input.schemaVersion !== 1 || input.methodId !== ETF_ABC_METHOD_ID
      || input.mode !== 'read-only' || input.t0DateHkt !== ETF_ABC_T0_DATE) {
    throw new Error('ETF A/B/C method identity or T0 differs from the approved contract');
  }
  validateBaseline(input.baseline);
  validateCalendar(input.calendar);
  validateFlow(input.flow, input.calendar);
  validateArms(input.arms, input.calendar);
  validateTilt(input.tiltState, input.tiltValidation, input.calendar);
  validateQuarters(input.quarters, input.calendar);
  validateMetrics(input.metrics);
  return input;
}

function targetForTilt(tiltState, validation) {
  const target = tiltState === 'eight' ? TARGET_EIGHT : TARGET_ZERO;
  return {
    status: tiltState === 'pending-validation' ? 'candidate-not-deployable' : 'approved-read-only',
    aiTiltPct: tiltState === 'eight' ? 0.08 : 0,
    validationEvidenceFingerprint: validation.evidenceFingerprint,
    validationEffectiveMarketDate: validation.effectiveMarketDate,
    weights: { ...target },
  };
}

function valuationCoverageResult(calendar) {
  const value = {
    aHoldingsFingerprint: calendar.coverage.aHoldingsFingerprint,
    bShadowUnitsFingerprint: calendar.coverage.bShadowUnitsFingerprint,
    requiredInstruments: Object.fromEntries(Object.entries(calendar.coverage.requiredInstruments).map(([arm, instruments]) => [arm, [...instruments]])),
    evidenceFingerprint: calendar.coverage.evidenceFingerprint,
    coveredInstruments: Object.keys(calendar.priceDates).sort(),
  };
  return { ...value, priceCoverageFingerprint: canonicalHash(value) };
}

function armResult(arm, flowAmount, available) {
  const afterFlow = cents(arm.endingValueBeforeFlowUsd + flowAmount);
  if (afterFlow < 0) throw new Error('External withdrawal exceeds an arm value; borrowing and shorting are forbidden');
  return {
    openingValueUsd: arm.openingValueUsd,
    endingValueBeforeFlowUsd: arm.endingValueBeforeFlowUsd,
    externalFlowUsdEod: flowAmount,
    endingValueAfterFlowUsd: afterFlow,
    dailyReturn: available ? arm.endingValueBeforeFlowUsd / arm.openingValueUsd - 1 : null,
  };
}

function deriveBImplementationStatus(reserveStatus, pendingCashUnallocatedUsd, pendingOutflowUnsimulatedUsd) {
  if (pendingOutflowUnsimulatedUsd > 0) return 'pending-outflow-unsimulated';
  if (pendingCashUnallocatedUsd > 0) return 'pending-cash-unallocated';
  return reserveStatus === 'incomplete' ? 'incomplete-call-reserve' : 'read-only-awaiting-shadow-signal';
}

export function computeEtfAbcObservation(input) {
  validateEtfAbcInput(input);
  const flowAmount = input.flow?.amountUsd ?? 0;
  const available = input.calendar.status === 'complete' && input.baseline.status === 'established';
  const A = armResult(input.arms.A, flowAmount, available);
  const B = armResult(input.arms.B, flowAmount, available);
  const C = armResult(input.arms.C, flowAmount, available);
  const b = input.arms.B;
  let pendingCashUnallocatedUsd = b.pendingCashUnallocatedUsd;
  let pendingOutflowUnsimulatedUsd = b.pendingOutflowUnsimulatedUsd;
  if (flowAmount > 0) {
    pendingCashUnallocatedUsd = cents(pendingCashUnallocatedUsd + flowAmount);
  } else if (flowAmount < 0) {
    pendingOutflowUnsimulatedUsd = cents(pendingOutflowUnsimulatedUsd + Math.abs(flowAmount));
  }
  const implementationStatus = deriveBImplementationStatus(
    b.reserveStatus, pendingCashUnallocatedUsd, pendingOutflowUnsimulatedUsd,
  );
  const completeQuarterCount = input.quarters.filter(quarter => quarter.status === 'complete').length;
  const completedQuarterIds = input.quarters.filter(quarter => quarter.status === 'complete').map(quarter => quarter.id).sort();
  const metricsComplete = ETF_ABC_METRICS.every(metric => input.metrics[metric] !== null);
  const comparisonComplete = available && input.baseline.status === 'established'
    && b.reserveStatus === 'verified' && input.tiltState !== 'pending-validation'
    && pendingCashUnallocatedUsd === 0 && pendingOutflowUnsimulatedUsd === 0;
  const rankingEligible = completeQuarterCount >= 4 && metricsComplete && comparisonComplete;
  return {
    schemaVersion: 1,
    methodId: ETF_ABC_METHOD_ID,
    mode: 'read-only',
    t0DateHkt: ETF_ABC_T0_DATE,
    t0QuarterStatus: 'stub',
    baselineStatus: input.baseline.status,
    economicDateHkt: input.calendar.economicDateHkt,
    effectiveMarketDate: input.calendar.effectiveMarketDate,
    observationCutoffHkt: input.calendar.observationCutoffHkt,
    calendarStatus: input.calendar.status,
    staleMarketClosed: input.calendar.staleMarketClosed,
    valuationCoverage: valuationCoverageResult(input.calendar),
    comparisonStatus: comparisonComplete ? 'complete' : 'incomplete',
    targetVector: targetForTilt(input.tiltState, input.tiltValidation),
    arms: {
      A: { ...A, holdingsFingerprint: input.arms.A.holdingsFingerprint, role: 'actual' },
      B: {
        ...B, role: 'clone-a-marginal-shadow', baselineMode: b.baselineMode,
        reserveStatus: b.reserveStatus, requiredReserveUsd: b.requiredReserveUsd,
        reserveEvidence: b.reserveEvidence === null ? null : { ...b.reserveEvidence },
        pendingCashUnallocatedUsd, pendingOutflowUnsimulatedUsd,
        shadowUnitsFingerprint: b.shadowUnitsFingerprint,
        shadowUnitsCreatedByThisObservation: false,
        implementationStatus,
      },
      C: {
        ...C, role: 'CSPX-accumulation', ticker: 'CSPX', isin: 'IE00B5BMR087',
        distribution: 'accumulation', cashDividendUsd: 0,
        distributionTreatment: 'embedded-in-accumulating-price',
      },
    },
    rawMetrics: { ...input.metrics },
    completedQuarterIds,
    completeQuarterCount,
    minimumCompleteQuartersForRanking: 4,
    rankingEligible,
    rankingStatus: rankingEligible ? 'eligible-raw-metrics-only-no-rank'
      : completeQuarterCount < 4 ? 'not-eligible-less-than-four-complete-quarters'
        : !metricsComplete ? 'not-eligible-incomplete-raw-metrics' : 'not-eligible-incomplete-comparison',
  };
}

export function renderEtfAbcRuntimeCard(result, baselineCheckpointHash) {
  validateEtfAbcResult(result);
  return renderEtfAbcPublicRuntimeCard(publicRuntimeState(result, baselineCheckpointHash));
}

export function renderEtfAbcPublicRuntimeCard(state) {
  validateEtfAbcPublicRuntimeState(state);
  const calendar = state.calendarStatus === 'unavailable' ? '估值不完整'
    : state.staleMarketClosed ? '休市顺延待估值（不比较）' : '共同估值完成';
  const baseline = state.baselineStatus === 'pending' ? '基线待建立' : '基线已建立';
  const comparison = state.comparisonStatus === 'complete' ? '比较完成' : '暂不比较';
  const bStatus = state.bImplementationStatus === 'pending-cash-unallocated' ? '新现金待分配 · 比较暂停'
    : state.bImplementationStatus === 'pending-outflow-unsimulated' ? '流出待模拟 · 比较暂停'
      : state.bReserveStatus === 'incomplete' ? 'CALL 未齐 · 不建份额' : '只读影子 · 待独立信号';
  const ranking = state.rankingEligible ? '已具备逐项比较资格 · 无综合分'
    : `${state.completeQuarterCount}/4 完整季度 · 暂不排名`;
  return `<section class="xuan-etf-abc-runtime" data-method-id="${ETF_ABC_METHOD_ID}" data-t0="${ETF_ABC_T0_DATE}">
  <h3>XUAN-ETF · A/B/C</h3>
  <p>① T0 ${ETF_ABC_T0_DATE} · ${baseline} · ${comparison}</p>
  <p>② A 实际 · B A克隆边际影子 · C CSPX累积型</p>
  <p>③ 资金流同日同额 · EOD；${calendar}</p>
  <p>④ ${bStatus}</p>
  <p>⑤ ${ranking}</p>
  <p>只读方法 · 不下单、不改单、不撤单、不转账</p>
</section>`;
}

export function validateEtfAbcResult(result) {
  exactKeys(result, RESULT_KEYS, 'ETF A/B/C result');
  if (result.schemaVersion !== 1 || result.methodId !== ETF_ABC_METHOD_ID || result.mode !== 'read-only'
      || result.t0DateHkt !== ETF_ABC_T0_DATE || result.t0QuarterStatus !== 'stub'
      || !['pending', 'established'].includes(result.baselineStatus)
      || !validDate(result.economicDateHkt) || result.economicDateHkt < ETF_ABC_T0_DATE
      || !validDate(result.effectiveMarketDate) || result.effectiveMarketDate < result.economicDateHkt
      || !validHktTimestamp(result.observationCutoffHkt)
      || result.observationCutoffHkt.slice(0, 10) < result.economicDateHkt
      || !['complete', 'market-closed-carry', 'unavailable'].includes(result.calendarStatus)
      || typeof result.staleMarketClosed !== 'boolean' || !['complete', 'incomplete'].includes(result.comparisonStatus)
      || !Number.isInteger(result.completeQuarterCount) || result.completeQuarterCount < 0
      || result.minimumCompleteQuartersForRanking !== 4 || typeof result.rankingEligible !== 'boolean'
      || !['eligible-raw-metrics-only-no-rank', 'not-eligible-less-than-four-complete-quarters', 'not-eligible-incomplete-raw-metrics', 'not-eligible-incomplete-comparison'].includes(result.rankingStatus)) {
    throw new Error('Validated ETF A/B/C result is required');
  }
  if ((result.calendarStatus === 'complete'
        && (result.staleMarketClosed !== false || result.effectiveMarketDate !== result.economicDateHkt))
      || (result.calendarStatus === 'market-closed-carry'
        && (result.staleMarketClosed !== true || result.effectiveMarketDate === result.economicDateHkt
          || calendarDaysBetween(result.economicDateHkt, result.effectiveMarketDate) > 7))
      || (result.calendarStatus === 'unavailable' && result.effectiveMarketDate !== result.economicDateHkt)) {
    throw new Error('Validated ETF A/B/C result is required');
  }
  exactKeys(result.valuationCoverage, [...COVERAGE_KEYS, 'coveredInstruments', 'priceCoverageFingerprint'], 'result.valuationCoverage');
  validateCoverage({
    aHoldingsFingerprint: result.valuationCoverage.aHoldingsFingerprint,
    bShadowUnitsFingerprint: result.valuationCoverage.bShadowUnitsFingerprint,
    requiredInstruments: result.valuationCoverage.requiredInstruments,
    evidenceFingerprint: result.valuationCoverage.evidenceFingerprint,
  });
  if (result.calendarStatus !== 'unavailable' || result.valuationCoverage.coveredInstruments.length !== 0) {
    validateInstrumentList(result.valuationCoverage.coveredInstruments, 'result valuation coverage');
  }
  const coverageValue = {
    aHoldingsFingerprint: result.valuationCoverage.aHoldingsFingerprint,
    bShadowUnitsFingerprint: result.valuationCoverage.bShadowUnitsFingerprint,
    requiredInstruments: result.valuationCoverage.requiredInstruments,
    evidenceFingerprint: result.valuationCoverage.evidenceFingerprint,
    coveredInstruments: result.valuationCoverage.coveredInstruments,
  };
  const allRequired = new Set(Object.values(result.valuationCoverage.requiredInstruments).flat());
  if (!validFingerprint(result.valuationCoverage.priceCoverageFingerprint)
      || result.valuationCoverage.priceCoverageFingerprint !== canonicalHash(coverageValue)
      || (result.calendarStatus !== 'unavailable'
        && [...allRequired].some(instrument => !result.valuationCoverage.coveredInstruments.includes(instrument)))) {
    throw new Error('Validated ETF A/B/C result is required');
  }
  exactKeys(result.targetVector, ['status', 'aiTiltPct', 'validationEvidenceFingerprint', 'validationEffectiveMarketDate', 'weights'], 'result.targetVector');
  exactKeys(result.targetVector.weights, ['CSPX', 'EQAC', 'USSC', 'EXUS', 'EIMI'], 'result.targetVector.weights');
  const expectedTarget = result.targetVector.aiTiltPct === 0.08 ? TARGET_EIGHT : TARGET_ZERO;
  if (!['candidate-not-deployable', 'approved-read-only'].includes(result.targetVector.status)
      || ![0, 0.08].includes(result.targetVector.aiTiltPct)
      || Object.keys(expectedTarget).some(key => result.targetVector.weights[key] !== expectedTarget[key])
      || (result.targetVector.status === 'candidate-not-deployable'
        && (result.targetVector.aiTiltPct !== 0 || result.targetVector.validationEvidenceFingerprint !== null
          || result.targetVector.validationEffectiveMarketDate !== null))
      || (result.targetVector.status === 'approved-read-only' && result.targetVector.aiTiltPct === 0.08
        && (!validFingerprint(result.targetVector.validationEvidenceFingerprint)
          || !validDate(result.targetVector.validationEffectiveMarketDate)
          || result.targetVector.validationEffectiveMarketDate > result.observationCutoffHkt.slice(0, 10)))
      || (result.targetVector.status === 'approved-read-only' && result.targetVector.aiTiltPct === 0
        && !((result.targetVector.validationEvidenceFingerprint === null
            && result.targetVector.validationEffectiveMarketDate === null)
          || (validFingerprint(result.targetVector.validationEvidenceFingerprint)
            && validDate(result.targetVector.validationEffectiveMarketDate)
            && result.targetVector.validationEffectiveMarketDate <= result.observationCutoffHkt.slice(0, 10))))) {
    throw new Error('Validated ETF A/B/C result is required');
  }
  exactKeys(result.arms, ['A', 'B', 'C'], 'result.arms');
  exactKeys(result.arms.A, [...A_KEYS, 'externalFlowUsdEod', 'endingValueAfterFlowUsd', 'dailyReturn', 'role'], 'result.arms.A');
  exactKeys(result.arms.B, [...B_KEYS, 'externalFlowUsdEod', 'endingValueAfterFlowUsd', 'dailyReturn', 'role', 'shadowUnitsCreatedByThisObservation', 'implementationStatus'], 'result.arms.B');
  exactKeys(result.arms.C, [...C_KEYS, 'externalFlowUsdEod', 'endingValueAfterFlowUsd', 'dailyReturn', 'role', 'distributionTreatment'], 'result.arms.C');
  for (const [key, role] of [['A', 'actual'], ['B', 'clone-a-marginal-shadow'], ['C', 'CSPX-accumulation']]) {
    const arm = result.arms[key];
    if (!isRecord(arm) || arm.role !== role || !validMoney(arm.openingValueUsd, { positive: true })
        || !validMoney(arm.endingValueBeforeFlowUsd) || !validMoney(arm.endingValueAfterFlowUsd)
        || !validSignedMoney(arm.externalFlowUsdEod)
        || arm.endingValueAfterFlowUsd !== cents(arm.endingValueBeforeFlowUsd + arm.externalFlowUsdEod)
        || (arm.dailyReturn !== null && (typeof arm.dailyReturn !== 'number' || !Number.isFinite(arm.dailyReturn)
          || Math.abs(arm.dailyReturn - (arm.endingValueBeforeFlowUsd / arm.openingValueUsd - 1)) > 1e-12))) {
      throw new Error('Validated ETF A/B/C result is required');
    }
  }
  if (result.arms.B.externalFlowUsdEod !== result.arms.A.externalFlowUsdEod
      || result.arms.C.externalFlowUsdEod !== result.arms.A.externalFlowUsdEod) {
    throw new Error('Validated ETF A/B/C result is required');
  }
  const returnsMustBeAvailable = result.calendarStatus === 'complete' && result.baselineStatus === 'established';
  if (['A', 'B', 'C'].some(arm => (result.arms[arm].dailyReturn !== null) !== returnsMustBeAvailable)) {
    throw new Error('Validated ETF A/B/C result is required');
  }
  if (!['incomplete', 'verified'].includes(result.arms.B.reserveStatus)
      || result.arms.B.baselineMode !== 'clone-a-marginal-shadow'
      || result.arms.A.holdingsFingerprint !== result.valuationCoverage.aHoldingsFingerprint
      || result.arms.B.shadowUnitsFingerprint !== result.valuationCoverage.bShadowUnitsFingerprint
      || (result.arms.B.reserveStatus === 'incomplete'
        && (result.arms.B.requiredReserveUsd !== null || result.arms.B.reserveEvidence !== null))
      || !validMoney(result.arms.B.pendingCashUnallocatedUsd) || !validMoney(result.arms.B.pendingOutflowUnsimulatedUsd)
      || !validFingerprint(result.arms.B.shadowUnitsFingerprint)
      || result.arms.B.shadowUnitsCreatedByThisObservation !== false
      || result.arms.C.ticker !== 'CSPX' || result.arms.C.isin !== 'IE00B5BMR087'
      || result.arms.C.distribution !== 'accumulation' || result.arms.C.cashDividendUsd !== 0
      || result.arms.C.distributionTreatment !== 'embedded-in-accumulating-price') {
    throw new Error('Validated ETF A/B/C result is required');
  }
  if (result.arms.B.implementationStatus !== deriveBImplementationStatus(
    result.arms.B.reserveStatus,
    result.arms.B.pendingCashUnallocatedUsd,
    result.arms.B.pendingOutflowUnsimulatedUsd,
  )) {
    throw new Error('Validated ETF A/B/C result is required');
  }
  if (result.arms.B.reserveStatus === 'verified') {
    exactKeys(result.arms.B.reserveEvidence, RESERVE_EVIDENCE_KEYS, 'result.arms.B.reserveEvidence');
    const reserve = result.arms.B.reserveEvidence;
    if (!validHktTimestamp(reserve.asOfHkt) || reserve.asOfHkt > result.observationCutoffHkt
        || !validFingerprint(reserve.evidenceFingerprint)
        || !validMoney(reserve.verified90dCallsUsd) || !validMoney(reserve.approvedBufferUsd)
        || !validMoney(reserve.fxOpsBufferUsd)
        || result.arms.B.requiredReserveUsd !== cents(Math.max(240000,
          reserve.verified90dCallsUsd + reserve.approvedBufferUsd + reserve.fxOpsBufferUsd))) {
      throw new Error('Validated ETF A/B/C result is required');
    }
  }
  validateMetrics(result.rawMetrics);
  if (!Array.isArray(result.completedQuarterIds) || result.completedQuarterIds.length !== result.completeQuarterCount
      || new Set(result.completedQuarterIds).size !== result.completedQuarterIds.length
      || result.completedQuarterIds.some((id, index) => !/^\d{4}-Q[1-4]$/.test(id)
        || id <= '2026-Q3' || quarterEndDate(id) >= result.economicDateHkt
        || (index > 0 && result.completedQuarterIds[index - 1] >= id))) {
    throw new Error('Validated ETF A/B/C result is required');
  }
  const rawMetricsComplete = ETF_ABC_METRICS.every(metric => result.rawMetrics[metric] !== null);
  const comparisonCanBeComplete = result.calendarStatus === 'complete'
    && result.baselineStatus === 'established'
    && result.arms.B.reserveStatus === 'verified'
    && result.targetVector.status === 'approved-read-only'
    && result.arms.B.pendingCashUnallocatedUsd === 0
    && result.arms.B.pendingOutflowUnsimulatedUsd === 0
    && ['A', 'B', 'C'].every(arm => result.arms[arm].dailyReturn !== null);
  const expectedRankingStatus = result.completeQuarterCount < 4
    ? 'not-eligible-less-than-four-complete-quarters'
    : !rawMetricsComplete ? 'not-eligible-incomplete-raw-metrics'
      : result.comparisonStatus !== 'complete' ? 'not-eligible-incomplete-comparison'
        : 'eligible-raw-metrics-only-no-rank';
  if ((result.comparisonStatus === 'complete') !== comparisonCanBeComplete
      || result.rankingStatus !== expectedRankingStatus
      || result.rankingEligible !== (expectedRankingStatus === 'eligible-raw-metrics-only-no-rank')) {
    throw new Error('Validated ETF A/B/C result is required');
  }
  return result;
}

function readTagEnd(source, start) {
  let quote = null;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index + 1;
  }
  throw new Error('Unclosed tag in candidate HTML');
}

function parseTag(source, start, end, templateDepth) {
  const raw = source.slice(start, end);
  let cursor = 1;
  let closing = false;
  if (raw[cursor] === '/') { closing = true; cursor += 1; }
  while (/\s/.test(raw[cursor] ?? '')) cursor += 1;
  const nameMatch = raw.slice(cursor).match(/^[A-Za-z][A-Za-z0-9:-]*/);
  if (!nameMatch) return null;
  const name = nameMatch[0].toLowerCase();
  cursor += nameMatch[0].length;
  const attrs = Object.create(null);
  let selfClosing = false;
  while (cursor < raw.length - 1) {
    while (/\s/.test(raw[cursor] ?? '')) cursor += 1;
    if (raw[cursor] === '/' && raw[cursor + 1] === '>') { selfClosing = true; cursor += 1; break; }
    if (raw[cursor] === '>') break;
    if (closing) throw new Error('Closing tags cannot contain attributes');
    const attributeMatch = raw.slice(cursor).match(/^[^\s=/>]+/);
    if (!attributeMatch) throw new Error('Malformed attribute in candidate HTML');
    const attribute = attributeMatch[0].toLowerCase();
    cursor += attributeMatch[0].length;
    while (/\s/.test(raw[cursor] ?? '')) cursor += 1;
    let value = '';
    if (raw[cursor] === '=') {
      cursor += 1;
      while (/\s/.test(raw[cursor] ?? '')) cursor += 1;
      const quote = raw[cursor];
      if (quote === '"' || quote === "'") {
        const valueStart = ++cursor;
        while (cursor < raw.length && raw[cursor] !== quote) cursor += 1;
        if (cursor >= raw.length) throw new Error('Unclosed attribute value in candidate HTML');
        value = raw.slice(valueStart, cursor);
        cursor += 1;
      } else {
        const valueStart = cursor;
        while (cursor < raw.length && !/[\s>]/.test(raw[cursor])) {
          if (/["'<=`]/.test(raw[cursor])) throw new Error('Malformed unquoted attribute in candidate HTML');
          cursor += 1;
        }
        if (cursor === valueStart) throw new Error('Empty unquoted attribute in candidate HTML');
        value = raw.slice(valueStart, cursor);
      }
    }
    if (Object.prototype.hasOwnProperty.call(attrs, attribute)) throw new Error('Duplicate HTML attribute in candidate HTML');
    if (['class', 'id'].includes(attribute) && value.includes('&')) {
      throw new Error('Character references are forbidden in reserved HTML identity attributes');
    }
    attrs[attribute] = value;
  }
  return { start, openEnd: end, name, closing, selfClosing, attrs, templateDepth };
}

function tokenizeHtml(source) {
  const tokens = [];
  let index = 0;
  let templateDepth = 0;
  let rawTextTag = null;
  while (index < source.length) {
    if (rawTextTag) {
      const match = new RegExp(`<\\/${rawTextTag}\\s*>`, 'ig');
      match.lastIndex = index;
      const closing = match.exec(source);
      if (!closing) throw new Error(`Unclosed ${rawTextTag} element in candidate HTML`);
      index = closing.index;
      rawTextTag = null;
    }
    const start = source.indexOf('<', index);
    if (start < 0) break;
    if (source.startsWith('<!--', start)) {
      const commentEnd = source.indexOf('-->', start + 4);
      if (commentEnd < 0) throw new Error('Unclosed comment in candidate HTML');
      index = commentEnd + 3;
      continue;
    }
    if (/^<![^-]|^<\?/i.test(source.slice(start, start + 3))) {
      index = readTagEnd(source, start);
      continue;
    }
    const end = readTagEnd(source, start);
    const token = parseTag(source, start, end, templateDepth);
    index = end;
    if (!token) continue;
    if (!token.closing && token.name === 'plaintext') {
      throw new Error('plaintext is forbidden in candidate HTML');
    }
    if (!token.closing && token.selfClosing && (token.name === 'template' || RAW_TEXT_ELEMENTS.has(token.name))) {
      throw new Error(`Self-closing ${token.name} is forbidden because the browser keeps this inert container open`);
    }
    if (token.name === 'template' && token.closing) templateDepth = Math.max(0, templateDepth - 1);
    token.templateDepth = templateDepth;
    tokens.push(token);
    if (token.name === 'template' && !token.closing && !token.selfClosing) templateDepth += 1;
    if (!token.closing && !token.selfClosing && RAW_TEXT_ELEMENTS.has(token.name)) rawTextTag = token.name;
  }
  if (templateDepth !== 0) throw new Error('Unclosed template element in candidate HTML');
  return tokens;
}

export function countVisibleEtfAbcRuntimeClassElements(html) {
  if (typeof html !== 'string') throw new Error('ETF A/B/C runtime class scan requires HTML text');
  return tokenizeHtml(html).filter(token => !token.closing && token.templateDepth === 0
    && token.name !== 'template' && !RAW_TEXT_ELEMENTS.has(token.name)
    && (token.attrs.class ?? '').trim().split(/[\t\n\f\r ]+/).includes(ETF_ABC_RUNTIME_CLASS)).length;
}

function findMatchingElementEnd(tokens, opening) {
  let depth = 0;
  for (const token of tokens) {
    if (token.start < opening.start || token.name !== opening.name || token.templateDepth !== opening.templateDepth) continue;
    if (token.closing) depth -= 1;
    else if (!token.selfClosing) depth += 1;
    if (depth === 0) return token.openEnd;
  }
  throw new Error(`Unclosed ${opening.name} element in candidate HTML`);
}

function findUniqueP5(source, tokens) {
  const matches = tokens.filter(token => !token.closing && token.name === 'div' && token.templateDepth === 0
    && (token.attrs.class ?? '').trim().split(/\s+/).includes('pane')
    && (token.attrs.class ?? '').trim().split(/\s+/).includes('p5'));
  if (matches.length !== 1) throw new Error('Candidate HTML requires exactly one existing .pane.p5');
  return { ...matches[0], end: findMatchingElementEnd(tokens, matches[0]) };
}

function publicRuntimeState(result, baselineCheckpointHash) {
  if (!validFingerprint(baselineCheckpointHash)) {
    throw new Error('ETF A/B/C public runtime requires an exact value-free baseline checkpoint hash');
  }
  return validateEtfAbcPublicRuntimeState({
    schemaVersion: 1,
    methodId: ETF_ABC_METHOD_ID,
    mode: 'read-only',
    t0DateHkt: ETF_ABC_T0_DATE,
    t0QuarterStatus: result.t0QuarterStatus,
    baselineStatus: result.baselineStatus,
    baselineCheckpointHash,
    economicDateHkt: result.economicDateHkt,
    effectiveMarketDate: result.effectiveMarketDate,
    calendarStatus: result.calendarStatus,
    staleMarketClosed: result.staleMarketClosed,
    comparisonStatus: result.comparisonStatus,
    targetVectorStatus: result.targetVector.status,
    bReserveStatus: result.arms.B.reserveStatus,
    bPendingCashUnallocated: result.arms.B.pendingCashUnallocatedUsd > 0,
    bPendingOutflowUnsimulated: result.arms.B.pendingOutflowUnsimulatedUsd > 0,
    bImplementationStatus: result.arms.B.implementationStatus,
    cDistributionTreatment: result.arms.C.distributionTreatment,
    rawMetricsComplete: ETF_ABC_METRICS.every(metric => result.rawMetrics[metric] !== null),
    completedQuarterIds: [...result.completedQuarterIds],
    completeQuarterCount: result.completeQuarterCount,
    minimumCompleteQuartersForRanking: result.minimumCompleteQuartersForRanking,
    rankingEligible: result.rankingEligible,
    rankingStatus: result.rankingStatus,
  });
}

function maximumElapsedCompleteQuarters(economicDateHkt) {
  let count = 0;
  const finalYear = Number(economicDateHkt.slice(0, 4));
  for (let year = 2026; year <= finalYear; year += 1) {
    for (let quarter = 1; quarter <= 4; quarter += 1) {
      const id = `${year}-Q${quarter}`;
      if (id > '2026-Q3' && quarterEndDate(id) < economicDateHkt) count += 1;
    }
  }
  return count;
}

export function validateEtfAbcPublicRuntimeState(state) {
  exactKeys(state, PUBLIC_RUNTIME_KEYS, 'ETF A/B/C public runtime state');
  if (state.schemaVersion !== 1 || state.methodId !== ETF_ABC_METHOD_ID || state.mode !== 'read-only'
      || state.t0DateHkt !== ETF_ABC_T0_DATE || state.t0QuarterStatus !== 'stub'
      || !['pending', 'established'].includes(state.baselineStatus)
      || !validFingerprint(state.baselineCheckpointHash)
      || !validDate(state.economicDateHkt) || state.economicDateHkt < ETF_ABC_T0_DATE
      || !validDate(state.effectiveMarketDate) || state.effectiveMarketDate < state.economicDateHkt
      || !['complete', 'market-closed-carry', 'unavailable'].includes(state.calendarStatus)
      || typeof state.staleMarketClosed !== 'boolean'
      || !['complete', 'incomplete'].includes(state.comparisonStatus)
      || !['candidate-not-deployable', 'approved-read-only'].includes(state.targetVectorStatus)
      || !['incomplete', 'verified'].includes(state.bReserveStatus)
      || typeof state.bPendingCashUnallocated !== 'boolean'
      || typeof state.bPendingOutflowUnsimulated !== 'boolean'
      || !['incomplete-call-reserve', 'pending-cash-unallocated', 'pending-outflow-unsimulated', 'read-only-awaiting-shadow-signal'].includes(state.bImplementationStatus)
      || state.cDistributionTreatment !== 'embedded-in-accumulating-price'
      || typeof state.rawMetricsComplete !== 'boolean'
      || !Number.isInteger(state.completeQuarterCount) || state.completeQuarterCount < 0
      || state.completeQuarterCount > maximumElapsedCompleteQuarters(state.economicDateHkt)
      || state.minimumCompleteQuartersForRanking !== 4 || typeof state.rankingEligible !== 'boolean'
      || !['eligible-raw-metrics-only-no-rank', 'not-eligible-less-than-four-complete-quarters', 'not-eligible-incomplete-raw-metrics', 'not-eligible-incomplete-comparison'].includes(state.rankingStatus)) {
    throw new Error('ETF A/B/C public runtime state is invalid');
  }
  if (!Array.isArray(state.completedQuarterIds)
      || state.completedQuarterIds.length !== state.completeQuarterCount
      || new Set(state.completedQuarterIds).size !== state.completedQuarterIds.length
      || state.completedQuarterIds.some((id, index) => !/^\d{4}-Q[1-4]$/.test(id)
        || id <= '2026-Q3' || quarterEndDate(id) >= state.economicDateHkt
        || (index > 0 && state.completedQuarterIds[index - 1] >= id))) {
    throw new Error('ETF A/B/C public runtime quarter evidence is invalid');
  }
  if ((state.calendarStatus === 'complete'
        && (state.staleMarketClosed !== false || state.effectiveMarketDate !== state.economicDateHkt))
      || (state.calendarStatus === 'market-closed-carry'
        && (state.staleMarketClosed !== true || state.effectiveMarketDate === state.economicDateHkt
          || calendarDaysBetween(state.economicDateHkt, state.effectiveMarketDate) > 7))
      || (state.calendarStatus === 'unavailable' && state.effectiveMarketDate !== state.economicDateHkt)
      || state.bImplementationStatus !== deriveBImplementationStatus(
        state.bReserveStatus,
        state.bPendingCashUnallocated ? 1 : 0,
        state.bPendingOutflowUnsimulated ? 1 : 0,
      )) {
    throw new Error('ETF A/B/C public runtime state is internally inconsistent');
  }
  const canCompare = state.calendarStatus === 'complete'
    && state.baselineStatus === 'established'
    && state.targetVectorStatus === 'approved-read-only'
    && state.bReserveStatus === 'verified'
    && state.bImplementationStatus === 'read-only-awaiting-shadow-signal';
  const expectedRankingStatus = state.completeQuarterCount < 4
    ? 'not-eligible-less-than-four-complete-quarters'
    : !state.rawMetricsComplete ? 'not-eligible-incomplete-raw-metrics'
      : state.comparisonStatus !== 'complete' ? 'not-eligible-incomplete-comparison'
        : 'eligible-raw-metrics-only-no-rank';
  if ((state.comparisonStatus === 'complete' && !canCompare)
      || state.rankingStatus !== expectedRankingStatus
      || state.rankingEligible !== (expectedRankingStatus === 'eligible-raw-metrics-only-no-rank')
      || (state.rankingEligible && state.comparisonStatus !== 'complete')) {
    throw new Error('ETF A/B/C public runtime state is internally inconsistent');
  }
  return state;
}

export function validateEtfAbcInitialPublicRuntimeState(state) {
  validateEtfAbcPublicRuntimeState(state);
  if (state.baselineStatus !== 'pending' || state.comparisonStatus !== 'incomplete'
      || state.rawMetricsComplete !== false || state.completedQuarterIds.length !== 0
      || state.completeQuarterCount !== 0 || state.rankingEligible !== false
      || state.rankingStatus !== 'not-eligible-less-than-four-complete-quarters') {
    throw new Error('Initial ETF A/B/C publication must remain baseline-pending and non-comparable until a trusted append-only ledger is integrated');
  }
  return state;
}

export function validateEtfAbcEstablishedPublicRuntimeState(state) {
  validateEtfAbcPublicRuntimeState(state);
  if (state.baselineStatus !== 'established' || state.comparisonStatus !== 'incomplete'
      || state.rawMetricsComplete !== false || state.completedQuarterIds.length !== 0
      || state.completeQuarterCount !== 0 || state.rankingEligible !== false
      || state.rankingStatus !== 'not-eligible-less-than-four-complete-quarters') {
    throw new Error('Established ETF A/B/C publication must remain non-comparable and unranked until later complete observations exist');
  }
  return state;
}

function safeJson(value) {
  return JSON.stringify(value).replace(/[<>&]/g, character => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[character]);
}

export function parseEtfAbcPublicRuntimeStateJson(json) {
  if (typeof json !== 'string') throw new Error('ETF A/B/C public runtime JSON must be a canonical string');
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('ETF A/B/C public runtime JSON is invalid');
  }
  validateEtfAbcPublicRuntimeState(parsed);
  const ordered = Object.fromEntries(PUBLIC_RUNTIME_KEYS.map(key => [key, parsed[key]]));
  if (safeJson(ordered) !== json) {
    throw new Error('ETF A/B/C public runtime JSON is not canonical or contains duplicate/reordered fields');
  }
  return parsed;
}

export function upsertEtfAbcRuntime(html, result, baselineCheckpointHash) {
  const source = String(html ?? '');
  const card = renderEtfAbcRuntimeCard(result, baselineCheckpointHash);
  const tokens = tokenizeHtml(source);
  const pane = findUniqueP5(source, tokens);
  const policyMatches = tokens.filter(token => !token.closing && token.name === 'section' && token.templateDepth === 0
    && token.attrs.id === 'xuan-ib-policy-v2' && token.start >= pane.openEnd && token.start < pane.end);
  if (policyMatches.length !== 1) throw new Error('The unique .pane.p5 must contain exactly one canonical policy section');
  const policyStart = policyMatches[0].start;
  const policyEnd = findMatchingElementEnd(tokens, policyMatches[0]);
  const policySource = source.slice(policyStart, policyEnd);
  if (!policySource.includes(`<!-- xuan-ib-index-etf-policy-v2:${ETF_ABC_POLICY_FINGERPRINT} -->`)
      || policyMatches[0].attrs['data-policy-fingerprint'] !== ETF_ABC_POLICY_FINGERPRINT
      || createHash('sha256').update(policySource).digest('hex') !== ETF_ABC_CANONICAL_POLICY_SECTION_SHA256) {
    throw new Error('Canonical policy bytes differ from the fingerprint-bound approved section');
  }
  const publicState = safeJson(publicRuntimeState(result, baselineCheckpointHash));
  const block = `${ETF_ABC_RUNTIME_START}\n<template id="xuan-ib-etf-abc-state-v1" type="application/json">${publicState}</template>\n${card}\n${ETF_ABC_RUNTIME_END}`;
  const startMatches = [...source.matchAll(new RegExp(ETF_ABC_RUNTIME_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))];
  const endMatches = [...source.matchAll(new RegExp(ETF_ABC_RUNTIME_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))];
  const stateMatches = tokens.filter(token => !token.closing && token.name === 'template'
    && token.attrs.id === 'xuan-ib-etf-abc-state-v1');
  if (startMatches.length !== endMatches.length || startMatches.length > 1) throw new Error('ETF A/B/C runtime markers must be absent or one complete pair');
  if (startMatches.length === 1) {
    const start = startMatches[0].index;
    const end = endMatches[0].index + ETF_ABC_RUNTIME_END.length;
    if (start < policyEnd || end > pane.end || endMatches[0].index < start
        || source.slice(policyEnd, start).trim() !== '' || stateMatches.length !== 1
        || stateMatches[0].start < start || stateMatches[0].start > end) {
      throw new Error('ETF A/B/C runtime block must remain after canonical policy inside .pane.p5');
    }
    return source.slice(0, start) + block + source.slice(end);
  }
  if (stateMatches.length !== 0) throw new Error('ETF A/B/C public state template must exist only inside its runtime marker pair');
  return source.slice(0, policyEnd) + `\n${block}` + source.slice(policyEnd);
}
