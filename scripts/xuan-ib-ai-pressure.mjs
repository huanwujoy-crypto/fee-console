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
// Nothing here places, modifies or cancels an order, initiates a transfer, or
// writes to any financial account or repository file.
import { AUTO_EXCLUSION_REASONS } from './xuan-ib-auto-classification.mjs';
import { constituentKey } from './xuan-ib-ai-tier-coverage.mjs';

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

// Every coefficient this contract uses has at most four decimal places, so basis
// points are exact where a float is not. All accumulation below is integer, and
// the published total never depends on the order the rows happened to arrive in.
const BASIS = 10_000;
function basisPoints(coefficient, where) {
  if (typeof coefficient !== 'number' || !Number.isFinite(coefficient)
    || coefficient < 0 || coefficient > 1) fail('COEFFICIENT_INVALID', where);
  const points = Math.round(coefficient * BASIS);
  // A coefficient that is not expressible in basis points is not one of ours;
  // silently rounding it would publish a number no approved document records.
  if (Math.abs(points / BASIS - coefficient) > 1e-12) fail('COEFFICIENT_NOT_EXACT', where);
  return points;
}

const USD_CENTS = /^-?\d+(\.\d{1,2})?$/;
function cents(value, where) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12
    || !USD_CENTS.test(String(value))) fail('VALUE_NOT_VERIFIED_USD_CENTS', where);
  return BigInt(Math.round(value * 100));
}

// cents x basis points, accumulated exactly, converted once at the end.
const toUsd = micro => Number(micro) / (100 * BASIS);

/**
 * Compute one run's AI-pressure numerator, denominator and ratios.
 *
 * `constituents` are the same identity-bound records `buildAiTierCoverage`
 * resolved, and `coverage` is its result: this function never re-decides a
 * classification, it only applies the ladder that decision already implies.
 *
 * `denominator.components` are source-bound account totals supplied by the
 * caller — the three-account cash-inclusive total the published report already
 * describes as `IB NAV + Schwab-HK + Webull, 含现金`. They are never fetched
 * here and never derived from the constituents: an account total includes cash
 * and positions this pane does not enumerate.
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
  const components = denominator.components.map((component, index) => {
    if (!plain(component) || typeof component.label !== 'string' || !component.label.trim()) {
      fail('DENOMINATOR_COMPONENT_INVALID', `#${index}`);
    }
    const value = cents(component.valueUsd, `denominator.${component.label}`);
    denominatorMicro += value * BigInt(BASIS);
    return { label: component.label.trim(), valueUsd: component.valueUsd };
  });
  // Never zero, never a guess: a ratio over an unknown denominator is not a
  // conservative reading, it is an unbounded one.
  if (denominatorMicro <= 0n) fail('DENOMINATOR_NOT_POSITIVE');

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
    const value = cents(constituent.marketValueUsd, key);

    if (entry.status === 'excluded') {
      // Out of the numerator, still inside the denominator, and saying which
      // enumerated reason put it there. This row is the whole point: an excluded
      // constituent that vanished from the page instead of appearing here with a
      // zero contribution is exactly the understatement being prevented.
      if (!Object.values(AUTO_EXCLUSION_REASONS).includes(entry.reason)) {
        fail('EXCLUSION_REASON_UNENUMERATED', key);
      }
      return { key, symbol: entry.symbol, custodian: entry.custodian, status: 'excluded',
        reason: entry.reason, recordId: entry.recordId, namespace: entry.namespace,
        basis: resolved.basis, tier: null, marketValueUsd: constituent.marketValueUsd,
        coefficients: { low: null, mid: null, high: null },
        contributions: { low: 0, mid: 0, high: 0 } };
    }

    const ladder = resolved.ladder;
    if (!plain(ladder)) fail('LADDER_MISSING', key);
    const coefficients = {};
    const contributions = {};
    for (const scenario of SCENARIOS) {
      const coefficient = ladder[scenario];
      if (coefficient === null || coefficient === undefined) {
        coefficients[scenario] = null;
        contributions[scenario] = null;
        unavailable[scenario].push(key);
        continue;
      }
      const points = basisPoints(coefficient, `${key}.${scenario}`);
      coefficients[scenario] = coefficient;
      const micro = value * BigInt(points);
      contributions[scenario] = toUsd(micro);
      totals[scenario] += micro;
    }
    return { key, symbol: entry.symbol, custodian: entry.custodian, status: 'classified',
      reason: null, recordId: entry.recordId, namespace: entry.namespace, basis: resolved.basis,
      tier: resolved.tier ?? null, marketValueUsd: constituent.marketValueUsd,
      coefficients, contributions };
  });

  const denominatorUsd = toUsd(denominatorMicro);
  const scenarios = Object.fromEntries(SCENARIOS.map(scenario => {
    if (unavailable[scenario].length) {
      return [scenario, { numeratorUsd: null, ratio: null, available: false,
        unavailableFor: [...unavailable[scenario]] }];
    }
    const numeratorUsd = toUsd(totals[scenario]);
    return [scenario, { numeratorUsd, available: true, unavailableFor: [],
      // Held as an exact rational of the integer accumulators, so the published
      // percentage is the ratio of the published totals and not a re-rounding.
      ratio: Number(totals[scenario]) / Number(denominatorMicro) }];
  }));
  if (!scenarios.mid.available) fail('MID_SCENARIO_UNAVAILABLE', scenarios.mid.unavailableFor.join(','));

  return {
    schemaVersion: 1,
    registryRevision: coverage.registryRevision ?? null,
    rows,
    denominator: { components, totalUsd: denominatorUsd },
    scenarios,
    numeratorUsd: scenarios.mid.numeratorUsd,
    denominatorUsd,
    ratio: scenarios.mid.ratio,
    excludedKeys: rows.filter(row => row.status === 'excluded').map(row => row.key),
  };
}

const escape = value => String(value).replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const money = value => `$${Math.round(value).toLocaleString('en-US')}`;
const percent = ratio => `${(ratio * 100).toFixed(2)}%`;
const coefficientText = value => `${(value * 100).toFixed(2)}%`;
// Basis points of the ratio, to four decimal places of a percent, so the gate
// compares an exact integer rather than a re-parsed display string.
const ratioBasis = ratio => Math.round(ratio * 1_000_000);
const centsOf = value => Math.round(value * 100);

/**
 * The §0-C section, rendered from the computation and from nothing else.
 *
 * Every number the page shows is emitted here beside a machine-readable form of
 * itself, so the publication gate can recompute the numerator from the page's
 * own per-constituent contributions instead of trusting the summary line. There
 * is no input to this function that lets a caller supply a numerator or a ratio.
 */
export function renderAiPressureSection(pressure, { title, asOfHkt, note = '' } = {}) {
  if (!plain(pressure) || !Array.isArray(pressure.rows) || !pressure.rows.length) fail('PRESSURE_INVALID');
  if (typeof title !== 'string' || !title.trim()) fail('TITLE_REQUIRED');
  if (typeof asOfHkt !== 'string' || !asOfHkt.trim()) fail('AS_OF_REQUIRED');

  const body = pressure.rows.map(row => {
    const label = `${row.custodian} ${row.symbol}${row.tier ? ` ${row.tier}` : ''}`;
    const attributes = ` data-ai-risk-row="${escape(row.key)}"`
      + ` data-ai-risk-symbol="${escape(row.symbol)}"`
      + ` data-ai-market-value-cents="${centsOf(row.marketValueUsd)}"`
      + ` data-ai-record="${escape(row.recordId)}"`;
    if (row.status === 'excluded') {
      return `<tr${attributes} data-ai-status="excluded" data-ai-reason="${escape(row.reason)}"`
        + ` data-ai-contribution-cents="0">`
        + `<td>${escape(label)} · 无可用系数 · 未计入分子</td><td>${money(row.marketValueUsd)}</td>`
        + `<td>不适用</td><td>${money(0)}</td></tr>`;
    }
    return `<tr${attributes} data-ai-status="classified"`
      + ` data-ai-coefficient-bp="${basisPoints(row.coefficients.mid, row.key)}"`
      + ` data-ai-contribution-cents="${centsOf(row.contributions.mid)}">`
      + `<td>${escape(label)}</td><td>${money(row.marketValueUsd)}</td>`
      + `<td>${coefficientText(row.coefficients.mid)}</td><td>${money(row.contributions.mid)}</td></tr>`;
  }).join('');

  const summary = `<tr ${AI_PRESSURE_MARKER}="1"`
    + ` data-ai-numerator-cents="${centsOf(pressure.numeratorUsd)}"`
    + ` data-ai-denominator-cents="${centsOf(pressure.denominatorUsd)}"`
    + ` data-ai-ratio-bp="${ratioBasis(pressure.ratio)}"`
    + ` data-ai-constituents="${pressure.rows.length}">`
    + `<td>分子合计（按已批准系数逐仓计算）</td><td>—</td><td>—</td><td>${money(pressure.numeratorUsd)}</td></tr>`
    + `<tr><td>÷ 分母（${escape(pressure.denominator.components.map(item => item.label).join(' + '))}，含现金）</td>`
    + `<td>${money(pressure.denominatorUsd)}</td><td>—</td><td>—</td></tr>`
    + `<tr><td>= 中情景占比</td><td>—</td><td>—</td><td>${percent(pressure.ratio)}</td></tr>`;

  const scenarioLine = SCENARIOS.map(scenario => {
    const value = pressure.scenarios[scenario];
    return value.available
      ? `${scenario}：${money(value.numeratorUsd)}（${percent(value.ratio)}）`
      : `${scenario}：不可得（${value.unavailableFor.length} 项无该情景系数，按规则不以中情景或 0 代替）`;
  }).join('；');

  return `<section class="card"><h2>${escape(title)}</h2><p class="sub">${escape(asOfHkt)}</p>`
    + `<div class="tblwrap"><table data-columns="4"><thead><tr><th>账户 · 标的</th><th>市值 $</th>`
    + `<th>×系数</th><th>计入 $</th></tr></thead><tbody>${body}${summary}</tbody></table></div>`
    + `<p data-ai-scenarios-v1="1">情景合计 — ${escape(scenarioLine)}</p>`
    + (note ? `<p>${escape(note)}</p>` : '')
    + `</section>`;
}
