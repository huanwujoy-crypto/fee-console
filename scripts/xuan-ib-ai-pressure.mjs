// The §0-C AI-pressure calculation, as arithmetic instead of as typing.
//
// Until this module existed, the classification partition and the published
// number were connected by nothing at all. `buildAiTierCoverage` could resolve
// every constituent correctly and the report could still publish a numerator
// that disagreed with it, because the table was assembled by hand:
//
//     rows.push(['Webull GOOG T2', wv(webull,'GOOG'), 0.55]);
//
// — a label, a value and a coefficient, all retyped, once per position, once
// per run. A position left out of that list simply did not exist in the
// numerator while its account total kept it in the denominator. That is the
// 2026-09-11 defect, and no amount of classification correctness upstream
// could prevent it, because nothing downstream read the classification.
//
// This module is pure. It takes identities, source-bound market values and a
// source-bound denominator from its caller, resolves each coefficient through
// the approved rule or the transcribed registry, and returns the contributions,
// the scenario totals and the ratios. It fetches nothing: no network, no
// financial account, no clock. It decides no coefficient — it applies the one
// the approved rule or the registry already records, and names anything it
// cannot resolve rather than approximating it.
//
// Three things about the arithmetic are deliberate and were wrong before.
//
// FIRST, money is an integer here. Every market value and every denominator
// component is carried as an exact number of micro-USD, and every coefficient
// as exact basis points. A contribution is then their exact product in
// micro-basis units — and a contribution is not a whole number of cents and was
// never going to be: 6.01% of $405,988.00 is exactly $24,399.8788. The earlier
// contract required `valueCents x coefficientBp` to divide evenly by 10,000 and
// refused publication otherwise, which refused correct arithmetic on ordinary
// inputs. Every unrounded value is kept exact, published beside its row, summed
// exactly, and rounded half away from zero only for display. Rounding each row
// first and adding the rounded rows would publish a number that drifts with how
// many rows there happen to be.
//
// SECOND, the mid coefficient of every classified row is re-resolved from the
// trusted repository files through `resolveTrustedMidCoefficientBp` and must
// equal the one the resolved ladder carries. The engine and the publication
// gate call that same protected resolver, so there is one statement of the rule
// and no second copy to drift.
//
// THIRD, the denominator is a composition, not a typed total. Each component
// carries a stable key, a display label and its own integer micro-USD amount;
// the keys must be unique, and the total is their exact sum and can be nothing
// else. Publishing only the sum let a candidate move the denominator and the
// ratio together with nothing on the page to compare either against.
//
// Nothing here places, modifies or cancels an order, initiates a transfer, or
// writes to any financial account or repository file.
import { AUTO_EXCLUSION_REASONS } from './xuan-ib-auto-classification.mjs';
import { constituentKey } from './xuan-ib-ai-tier-coverage.mjs';
import {
  AI_DENOMINATOR_TEMPLATE_ID, BASIS_POINTS, DENOMINATOR_COMPONENT_KEY,
  basisPointsOf, centsFromMicroUsd, contributionMicroBasis, microUsdFromUsdNumber, microUsdOf,
  resolveTrustedMidCoefficientBp, roundMicroBasisToCents,
} from './xuan-ib-ai-coefficient-resolver.mjs';

const plain = value => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;

export class AiPressureException extends Error {
  constructor(code, detail = null) {
    super(`AI pressure: ${code}${detail === null ? '' : ` (${detail})`}`);
    this.name = 'AiPressureException';
    this.code = code;
    this.owner = 'Codex';
    this.requiresOwnerDecision = false;
    this.createsAwaitingUser = false;
  }
}
const fail = (code, detail = null) => { throw new AiPressureException(code, detail); };

export const SCENARIOS = Object.freeze(['low', 'mid', 'high']);
export const AI_PRESSURE_MARKER = 'data-ai-pressure-v1';
export const AI_PRESSURE_DENOMINATOR_MARKER = 'data-ai-denominator-v1';
export { AI_DENOMINATOR_TEMPLATE_ID };

// The shared unit arithmetic lives in the protected resolver so the gate applies
// the identical rule to the page it is checking. These wrappers only restate its
// refusals in this module's own exception type.
const units = (run, where) => {
  try { return run(); }
  catch (error) { return fail(error.code ?? 'VALUE_NOT_VERIFIED_USD_CENTS', where); }
};
const basisPoints = (coefficient, where) => units(() => basisPointsOf(coefficient, where), where);

/**
 * One money amount from a caller's record, as exact integer micro-USD.
 *
 * `microField` is the supported form and is authoritative wherever it appears.
 * `usdField` is the older verified-to-the-cent USD number, converted through its
 * own decimal text rather than through a float multiply. When a record carries
 * both, they must be the same amount: a pair that disagrees is two different
 * claims about one position, and picking either one silently would publish a
 * figure the other half of the record contradicts.
 */
function amountMicro(holder, microField, usdField, where) {
  const micro = plain(holder) ? holder[microField] : undefined;
  const usd = plain(holder) ? holder[usdField] : undefined;
  if (micro === undefined || micro === null) {
    return units(() => microUsdFromUsdNumber(usd, where), where);
  }
  const exact = units(() => microUsdOf(micro, where), where);
  if (usd !== undefined && usd !== null
    && units(() => microUsdFromUsdNumber(usd, where), where) !== exact) {
    fail('VALUE_MICRO_DISAGREES_WITH_USD', where);
  }
  return exact;
}

// ---------------------------------------------------------------------------
// Exact display conversion.
//
// A real three-account book in micro-basis units is far outside the range where
// a double is exact, so no published figure is produced by dividing one large
// float by another. Each display number is built from its exact integer as
// decimal text and converted once, which is correctly rounded.
// ---------------------------------------------------------------------------
function decimalNumber(value, scale) {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const unit = 10n ** BigInt(scale);
  const fraction = String(magnitude % unit).padStart(scale, '0').replace(/0+$/, '');
  return Number(`${negative ? '-' : ''}${magnitude / unit}${fraction ? `.${fraction}` : ''}`);
}
const usdFromMicro = micro => decimalNumber(micro, 6);
const usdFromMicroBasis = microBasis => decimalNumber(microBasis, 10);

// Millionths of one, i.e. four decimal places of a percent, computed from the
// integer accumulators so the published ratio is an exact function of the
// published totals and never a re-rounded float.
function ratioMillionths(numeratorMicroBasis, denominatorMicroBasis) {
  if (denominatorMicroBasis <= 0n) fail('DENOMINATOR_NOT_POSITIVE');
  const magnitude = numeratorMicroBasis < 0n ? -numeratorMicroBasis : numeratorMicroBasis;
  const value = (magnitude * 1_000_000n + denominatorMicroBasis / 2n) / denominatorMicroBasis;
  return numeratorMicroBasis < 0n ? -value : value;
}
// The same ratio as an ordinary number, correctly rounded from the exact
// rational rather than from two floats that have each already lost digits.
function ratioNumber(numeratorMicroBasis, denominatorMicroBasis) {
  if (denominatorMicroBasis <= 0n) fail('DENOMINATOR_NOT_POSITIVE');
  return decimalNumber((numeratorMicroBasis * 10n ** 24n) / denominatorMicroBasis, 24);
}

/**
 * Compute one run's AI-pressure numerator, denominator and ratios.
 *
 * `constituents` are the same identity-bound records `buildAiTierCoverage`
 * resolved, and `coverage` is its result: this function never re-decides a
 * classification, it only applies the ladder that decision already implies.
 * Each carries its market value as integer `marketValueMicro`, or as the older
 * verified-to-the-cent `marketValueUsd`.
 *
 * `denominator.components` are source-bound account totals supplied by the
 * caller — the three-account cash-inclusive total the published report already
 * describes. They are never fetched here and never derived from the
 * constituents: an account total includes cash and positions this pane does not
 * enumerate. Each component names one account by a stable key exactly once, and
 * the total is their exact sum, so a moved denominator is arithmetic rather than
 * a number nothing can be compared to.
 */
export function computeAiPressure(constituents, coverage, { denominator } = {}) {
  if (!Array.isArray(constituents) || !constituents.length) fail('CONSTITUENTS_INVALID');
  if (!plain(coverage) || !Array.isArray(coverage.entries) || !Array.isArray(coverage.resolved)) {
    fail('COVERAGE_INVALID');
  }
  if (coverage.entries.length !== constituents.length) fail('COVERAGE_LENGTH_MISMATCH');
  if (!plain(denominator) || !Array.isArray(denominator.components) || !denominator.components.length) {
    fail('DENOMINATOR_INVALID');
  }

  let denominatorMicro = 0n;
  const seenComponents = new Set();
  const components = denominator.components.map((component, index) => {
    if (!plain(component)) fail('DENOMINATOR_COMPONENT_INVALID', `#${index}`);
    const key = typeof component.key === 'string' ? component.key.trim() : '';
    // A stable key, not free text: it is the identity the published component
    // is read back by, and it must survive a round trip through the page.
    if (!DENOMINATOR_COMPONENT_KEY.test(key)) fail('DENOMINATOR_COMPONENT_KEY_INVALID', key || `#${index}`);
    // Each account once. A missing one understates the denominator and
    // overstates the ratio; a repeated one does the reverse; either was
    // invisible while only the sum was published.
    if (seenComponents.has(key)) fail('DENOMINATOR_COMPONENT_DUPLICATE', key);
    seenComponents.add(key);
    const label = typeof component.label === 'string' ? component.label.trim() : '';
    if (!label || label.length > 60) fail('DENOMINATOR_COMPONENT_LABEL_REQUIRED', key);
    // The label is published inside an inert JSON template as well as in the
    // visible line. JSON escaping does not escape markup, so a label carrying
    // any of these could close the template it sits in.
    if (/[<>&"'\\\x00-\x1f]/.test(label)) fail('DENOMINATOR_COMPONENT_LABEL_INVALID', key);
    const value = amountMicro(component, 'valueMicro', 'valueUsd', `denominator.${key}`);
    denominatorMicro += value;
    return { key, label, valueMicro: String(value),
      valueCents: String(centsFromMicroUsd(value, `denominator.${key}`)),
      valueUsd: usdFromMicro(value) };
  });
  // Never zero, never a guess: a ratio over an unknown denominator is not a
  // conservative reading, it is an unbounded one.
  if (denominatorMicro <= 0n) fail('DENOMINATOR_NOT_POSITIVE');
  const denominatorCents = centsFromMicroUsd(denominatorMicro, 'denominator');
  const denominatorMicroBasis = denominatorMicro * BigInt(BASIS_POINTS);

  const resolvedByKey = new Map(coverage.resolved.map(item => [item.key, item]));
  const totals = { low: 0n, mid: 0n, high: 0n };
  // A scenario is available only when EVERY classified constituent defines it.
  // The published report states a single composition percentage for each ETF
  // look-through and no low or high case for them at all, so those scenarios
  // are genuinely undefined for this universe. They are reported unavailable
  // and named — never filled in with the mid case, and never with zero.
  const unavailable = { low: [], mid: [], high: [] };

  const rows = constituents.map((constituent, index) => {
    const entry = coverage.entries[index];
    const key = constituentKey(constituent);
    if (entry.key !== key) fail('COVERAGE_ORDER_MISMATCH', key);
    const resolved = resolvedByKey.get(key);
    if (!resolved) fail('COVERAGE_RESOLUTION_MISSING', key);
    const value = amountMicro(constituent, 'marketValueMicro', 'marketValueUsd', key);
    const identity = { key, symbol: entry.symbol, custodian: entry.custodian,
      recordId: entry.recordId, namespace: entry.namespace, basis: resolved.basis,
      marketValueUsd: usdFromMicro(value), marketValueMicro: String(value),
      marketValueCents: String(centsFromMicroUsd(value, key)) };

    if (entry.status === 'excluded') {
      // Out of the numerator, still inside the denominator, and saying which
      // enumerated reason put it there. This row is the whole point: an excluded
      // constituent that vanished from the page instead of appearing here with a
      // zero contribution is exactly the understatement being prevented.
      if (!Object.values(AUTO_EXCLUSION_REASONS).includes(entry.reason)) {
        fail('EXCLUSION_REASON_UNENUMERATED', key);
      }
      return { ...identity, status: 'excluded', reason: entry.reason, tier: null,
        coefficients: { low: null, mid: null, high: null },
        coefficientsBp: { low: null, mid: null, high: null },
        contributions: { low: 0, mid: 0, high: 0 },
        contributionsMicroBasis: { low: '0', mid: '0', high: '0' },
        contributionCents: '0' };
    }

    const ladder = resolved.ladder;
    if (!plain(ladder)) fail('LADDER_MISSING', key);
    const coefficients = {};
    const coefficientsBp = {};
    const contributions = {};
    const contributionsMicroBasis = {};
    for (const scenario of SCENARIOS) {
      const coefficient = ladder[scenario];
      if (coefficient === null || coefficient === undefined) {
        coefficients[scenario] = null;
        coefficientsBp[scenario] = null;
        contributions[scenario] = null;
        contributionsMicroBasis[scenario] = null;
        unavailable[scenario].push(key);
        continue;
      }
      const points = basisPoints(coefficient, `${key}.${scenario}`);
      coefficients[scenario] = coefficient;
      coefficientsBp[scenario] = points;
      const microBasis = units(() => contributionMicroBasis(value, BigInt(points)), key);
      contributions[scenario] = usdFromMicroBasis(microBasis);
      contributionsMicroBasis[scenario] = String(microBasis);
      totals[scenario] += microBasis;
    }
    // The published coefficient, re-resolved from the trusted files through the
    // same protected resolver the publication gate uses. A ladder that no longer
    // agrees with the record id beside it is refused here rather than rendered:
    // that disagreement is exactly the coherent tamper this closes.
    if (coefficientsBp.mid !== null) {
      let trusted = null;
      try {
        trusted = resolveTrustedMidCoefficientBp({ namespace: entry.namespace, recordId: entry.recordId,
          symbol: entry.symbol, custodian: entry.custodian, portfolioId: entry.portfolioId,
          holdingId: entry.holdingId, instrumentId: entry.instrumentId });
      } catch (error) { fail('COEFFICIENT_NOT_TRUSTED', `${key}:${error.code ?? 'UNRESOLVED'}`); }
      if (trusted.midBp !== coefficientsBp.mid) fail('COEFFICIENT_NOT_TRUSTED', key);
    }
    return { ...identity, status: 'classified', reason: null, tier: resolved.tier ?? null,
      coefficients, coefficientsBp, contributions, contributionsMicroBasis,
      contributionCents: contributionsMicroBasis.mid === null ? null
        : String(roundMicroBasisToCents(BigInt(contributionsMicroBasis.mid))) };
  });

  const denominatorUsd = usdFromMicro(denominatorMicro);
  const scenarios = Object.fromEntries(SCENARIOS.map(scenario => {
    if (unavailable[scenario].length) {
      return [scenario, { numeratorUsd: null, numeratorCents: null, numeratorMicroBasis: null,
        ratio: null, ratioMillionths: null, available: false,
        unavailableFor: [...unavailable[scenario]] }];
    }
    const total = totals[scenario];
    return [scenario, { numeratorUsd: usdFromMicroBasis(total), available: true, unavailableFor: [],
      // The exact unrounded sum, and the single rounding applied to it. Rows are
      // never rounded before being added.
      numeratorMicroBasis: String(total),
      numeratorCents: String(roundMicroBasisToCents(total)),
      // Held as an exact rational of the integer accumulators, so the published
      // percentage is the ratio of the published totals and not a re-rounding.
      ratio: ratioNumber(total, denominatorMicroBasis),
      ratioMillionths: String(ratioMillionths(total, denominatorMicroBasis)) }];
  }));
  if (!scenarios.mid.available) fail('MID_SCENARIO_UNAVAILABLE', scenarios.mid.unavailableFor.join(','));

  return {
    schemaVersion: 1,
    registryRevision: coverage.registryRevision ?? null,
    rows,
    denominator: { components, totalUsd: denominatorUsd, totalMicro: String(denominatorMicro),
      totalCents: String(denominatorCents) },
    scenarios,
    numeratorUsd: scenarios.mid.numeratorUsd,
    numeratorCents: scenarios.mid.numeratorCents,
    numeratorMicroBasis: scenarios.mid.numeratorMicroBasis,
    denominatorUsd,
    denominatorMicro: String(denominatorMicro),
    denominatorCents: String(denominatorCents),
    ratio: scenarios.mid.ratio,
    ratioMillionths: scenarios.mid.ratioMillionths,
    excludedKeys: rows.filter(row => row.status === 'excluded').map(row => row.key),
  };
}

const escape = value => String(value).replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const money = value => `$${Math.round(value).toLocaleString('en-US')}`;
// Two decimals of a percent, derived from the exact integer millionths rather
// than from a float, so the visible number and the machine-readable one are the
// same number.
const percentOf = millionths => `${(Number(millionths) / 10_000).toFixed(2)}%`;
const coefficientText = value => `${(value * 100).toFixed(2)}%`;

export const AI_PRESSURE_KPI_MARKER = 'data-ai-pressure-kpi-v1';

/**
 * The headline AI-pressure KPI, derived from the same computation as the table.
 *
 * This tile is the number most readers actually see, and it sits outside the
 * risk pane entirely — on the published page it was authored independently of
 * the table beneath it, so the two could disagree without anything noticing.
 * It is generated here and reconciled against the table by the gate.
 */
export function renderAiPressureKpi(pressure, { asOfHkt } = {}) {
  if (!plain(pressure) || !Array.isArray(pressure.rows) || !pressure.rows.length) fail('PRESSURE_INVALID');
  if (typeof asOfHkt !== 'string' || !asOfHkt.trim()) fail('AS_OF_REQUIRED');
  const excluded = pressure.excludedKeys.length;
  return `<div class="kpi" ${AI_PRESSURE_KPI_MARKER}="1"`
    + ` data-ai-kpi-numerator-mbp="${pressure.numeratorMicroBasis}"`
    + ` data-ai-kpi-numerator-cents="${pressure.numeratorCents}"`
    + ` data-ai-kpi-denominator-micro="${pressure.denominatorMicro}"`
    + ` data-ai-kpi-denominator-cents="${pressure.denominatorCents}"`
    + ` data-ai-kpi-ratio-bp="${pressure.ratioMillionths}">`
    + `<div class="lab">AI 压力中情景</div>`
    + `<div class="big num">${percentOf(pressure.ratioMillionths)}</div>`
    + `<div class="sub">${money(pressure.numeratorUsd)} / ${money(pressure.denominatorUsd)} `
    + `${escape(pressure.denominator.components.map(item => item.label).join(' + '))}，含现金`
    + `${excluded ? ` · ${excluded} 项无可用系数未计入分子，仍在分母内` : ''}<br>${escape(asOfHkt)}</div></div>`;
}

/**
 * The §0-C section, rendered from the computation and from nothing else.
 *
 * Every number the page shows is emitted here beside a machine-readable form of
 * itself, so the publication gate can recompute the numerator from the page's
 * own per-constituent contributions instead of trusting the summary line. There
 * is no input to this function that lets a caller supply a numerator or a ratio.
 *
 * Each row carries BOTH its exact unrounded contribution, in micro-basis units,
 * and the displayed cents that unrounded value rounds to. The gate recomputes
 * both from the market value and the trusted coefficient; it never requires the
 * unrounded product to land on a whole cent, because with a 25.03% look-through
 * it usually does not.
 */
export function renderAiPressureSection(pressure, { title, asOfHkt, note = '' } = {}) {
  if (!plain(pressure) || !Array.isArray(pressure.rows) || !pressure.rows.length) fail('PRESSURE_INVALID');
  if (typeof title !== 'string' || !title.trim()) fail('TITLE_REQUIRED');
  if (typeof asOfHkt !== 'string' || !asOfHkt.trim()) fail('AS_OF_REQUIRED');

  const body = pressure.rows.map(row => {
    const label = `${row.custodian} ${row.symbol}${row.tier ? ` ${row.tier}` : ''}`;
    const attributes = ` data-ai-risk-row="${escape(row.key)}"`
      + ` data-ai-risk-symbol="${escape(row.symbol)}"`
      + ` data-ai-risk-custodian="${escape(row.custodian)}"`
      + ` data-ai-market-value-micro="${row.marketValueMicro}"`
      + ` data-ai-market-value-cents="${row.marketValueCents}"`
      + ` data-ai-namespace="${escape(row.namespace)}"`
      + ` data-ai-record="${escape(row.recordId)}"`;
    if (row.status === 'excluded') {
      return `<tr${attributes} data-ai-status="excluded" data-ai-reason="${escape(row.reason)}"`
        + ` data-ai-contribution-mbp="0" data-ai-contribution-cents="0">`
        + `<td>${escape(label)} · 无可用系数 · 未计入分子</td><td>${money(row.marketValueUsd)}</td>`
        + `<td>不适用</td><td>${money(0)}</td></tr>`;
    }
    return `<tr${attributes} data-ai-status="classified"`
      + ` data-ai-coefficient-bp="${row.coefficientsBp.mid}"`
      + ` data-ai-contribution-mbp="${row.contributionsMicroBasis.mid}"`
      + ` data-ai-contribution-cents="${row.contributionCents}">`
      + `<td>${escape(label)}</td><td>${money(row.marketValueUsd)}</td>`
      + `<td>${coefficientText(row.coefficients.mid)}</td><td>${money(row.contributions.mid)}</td></tr>`;
  }).join('');

  const summary = `<tr ${AI_PRESSURE_MARKER}="1" data-ai-units="micro-usd:basis-points"`
    + ` data-ai-numerator-mbp="${pressure.numeratorMicroBasis}"`
    + ` data-ai-numerator-cents="${pressure.numeratorCents}"`
    + ` data-ai-denominator-micro="${pressure.denominatorMicro}"`
    + ` data-ai-denominator-cents="${pressure.denominatorCents}"`
    + ` data-ai-ratio-bp="${pressure.ratioMillionths}"`
    + ` data-ai-constituents="${pressure.rows.length}">`
    + `<td>分子合计（按已批准系数逐仓计算，未舍入求和后统一进位）</td><td>—</td><td>—</td>`
    + `<td>${money(pressure.numeratorUsd)}</td></tr>`
    + `<tr><td>÷ 分母（${escape(pressure.denominator.components.map(item => item.label).join(' + '))}，含现金）</td>`
    + `<td>${money(pressure.denominatorUsd)}</td><td>—</td><td>—</td></tr>`
    + `<tr><td>= 中情景占比</td><td>—</td><td>—</td><td>${percentOf(pressure.ratioMillionths)}</td></tr>`;

  // The denominator's own composition, as strict machine-readable JSON beside
  // the sentence a reader sees. Publishing only the total let a candidate move
  // the denominator and the ratio together with nothing to compare either
  // against; here each account is named once, with its own exact integer
  // micro-USD amount, and the gate re-parses this template, rejects a duplicate
  // key and adds the components up again.
  const componentsJson = `<template id="${AI_DENOMINATOR_TEMPLATE_ID}" type="application/json">`
    + `${JSON.stringify(pressure.denominator.components.map(item =>
      ({ key: item.key, label: item.label, valueMicro: item.valueMicro })))}</template>`;
  const denominatorLine = `<p ${AI_PRESSURE_DENOMINATOR_MARKER}="${pressure.denominator.components.length}"`
    + ` data-ai-denominator-total-micro="${pressure.denominatorMicro}"`
    + ` data-ai-denominator-total-cents="${pressure.denominatorCents}">`
    + `分母组成（三账户，含现金）— ${escape(pressure.denominator.components
      .map(item => `${item.label} ${money(item.valueUsd)}`).join('；'))}</p>${componentsJson}`;

  const scenarioLine = SCENARIOS.map(scenario => {
    const value = pressure.scenarios[scenario];
    return value.available
      ? `${scenario}：${money(value.numeratorUsd)}（${percentOf(value.ratioMillionths)}）`
      : `${scenario}：不可得（${value.unavailableFor.length} 项无该情景系数，按规则不以中情景或 0 代替）`;
  }).join('；');

  return `<section class="card"><h2>${escape(title)}</h2><p class="sub">${escape(asOfHkt)}</p>`
    + `<div class="tblwrap"><table data-columns="4"><thead><tr><th>账户 · 标的</th><th>市值 $</th>`
    + `<th>×系数</th><th>计入 $</th></tr></thead><tbody>${body}${summary}</tbody></table></div>`
    + denominatorLine
    + `<p data-ai-scenarios-v1="1">情景合计 — ${escape(scenarioLine)}</p>`
    + (note ? `<p>${escape(note)}</p>` : '')
    + `</section>`;
}
