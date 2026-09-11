// The single protected re-resolver of one published AI-risk record.
//
// Round three of this repair found the binding between a published coefficient
// and the approval it claims to come from was only half there. The publication
// gate proved that a `REG` record id existed in the trusted registry, and for
// `WU`, `DELEG` and `AUTO` it proved only that the id started with the right
// letters. Nothing anywhere proved that the `data-ai-coefficient-bp` a row
// actually displayed was the mid coefficient of the rule that row named. A
// candidate could therefore raise a coefficient, recompute the row's own
// contribution from it, re-add the numerator, re-derive the ratio and re-derive
// the headline tile — a completely self-consistent page — and every check
// passed, because every check only compared the page against itself.
//
// This module is the missing half. Given the identity and record id a page
// publishes, it re-resolves, from the trusted repository files alone, the one
// mid coefficient that record is allowed to carry:
//
//   * `REG`   — `claude/xuan-ib-ai-risk-tiers-v1.json`, keyed on custodian and
//               symbol, through its own supported reader;
//   * `DELEG` — `claude/xuan-ib-classification-delegation-v1.json`, matched by
//               approval id and then field by field against the identity that
//               rule records;
//   * `WU`    — the same delegation file when the owner's selection lives there,
//               otherwise `claude/xuan-ib-ai-tier-overrides-v1.json`;
//   * `AUTO`  — `claude/xuan-ib-auto-classification-v1.json`, whose record id is
//               itself three facts (policy revision, portfolio, holding) that
//               must match the identity presented.
//
// Both the calculation engine and the publication gate call this one function,
// so there is exactly one statement of the rule and no second copy to drift.
// A record whose identity or id does not resolve is refused by name; nothing
// here approximates, defaults or falls back to a nearby rule.
//
// It reads versioned repository files and nothing else: no network, no financial
// account, no clock, no candidate. It never writes, and it never places,
// modifies or cancels anything.
import fs from 'node:fs';
import { AI_RISK_NAMESPACE, readAiRiskRegistry } from './xuan-ib-ai-risk-registry.mjs';
import { AUTO_NAMESPACE, readAutoClassificationPolicy } from './xuan-ib-auto-classification.mjs';
import { listDelegatedRules } from './xuan-ib-delegated-tier.mjs';

const OVERRIDES_PATH = new URL('../claude/xuan-ib-ai-tier-overrides-v1.json', import.meta.url);
const PORTFOLIO_REGISTRY_PATH = new URL('../claude/xuan-ib-portfolio-registry.json', import.meta.url);

const plain = value => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;

export class AiCoefficientResolverException extends Error {
  constructor(code, detail = null) {
    super(`AI coefficient: ${code}${detail === null ? '' : ` (${detail})`}`);
    this.name = 'AiCoefficientResolverException';
    this.code = code;
    // A binding failure is an engineering exception for the technical record.
    // It never becomes a per-stock question for the owner.
    this.owner = 'Codex';
    this.requiresOwnerDecision = false;
    this.createsAwaitingUser = false;
  }
}
const fail = (code, detail = null) => { throw new AiCoefficientResolverException(code, detail); };

export const AI_RISK_NAMESPACES = Object.freeze(['WU', 'DELEG', AI_RISK_NAMESPACE, AUTO_NAMESPACE]);

// ---------------------------------------------------------------------------
// Exact integer units.
//
// Money enters this contract as an integer number of micro-USD — a millionth of
// a dollar — and never as a float. A coefficient has at most four decimal
// places, so basis points are exact where a float is not. Their product is
// therefore exact in "micro-basis" units (micro-USD x basis points), and that is
// the unit every unrounded contribution and every numerator is accumulated in.
// Rounding happens once, at the end, on the total.
//
// The unit matters because the product is ordinarily NOT a whole number of
// cents. An ETF look-through of 25.03%, or 6.01%, applied to a real cent amount
// lands between cents far more often than on one: 6.01% of $405,988.00 is
// exactly $24,399.8788. The earlier contract required `valueCents x
// coefficientBp` to divide evenly by 10,000 and refused publication otherwise,
// which refused correct arithmetic on ordinary inputs.
//
// Every function below is shared by the calculation engine and the publication
// gate, so the page is checked with the same arithmetic that produced it.
// ---------------------------------------------------------------------------

/** Basis points per whole coefficient. */
export const BASIS_POINTS = 10_000;
const BASIS_POINTS_BIG = BigInt(BASIS_POINTS);
/** Micro-USD per US dollar, and per displayed cent. */
export const MICRO_PER_USD = 1_000_000n;
export const MICRO_PER_CENT = 10_000n;
/** Micro-basis units (micro-USD x basis points) per displayed cent. */
export const MICRO_BASIS_PER_CENT = MICRO_PER_CENT * BASIS_POINTS_BIG;

// Up to 21 digits of micro-USD, i.e. a thousand trillion dollars: far beyond any
// real book, and small enough that a typo of the wrong order of magnitude is
// still a number this contract will happily multiply. The whole-cent check below
// is what actually bounds the precision a source is allowed to claim.
const MICRO_INTEGER = /^(?:0|[1-9]\d{0,20})$/;
const USD_CENTS_TEXT = /^(?:0|[1-9]\d{0,14})(?:\.\d{1,2})?$/;

/** A stable denominator-component key: lowercase, hyphenated, no whitespace.
 *
 * The engine and the gate apply this one pattern, so a component key is an
 * identity that survives a round trip through the page rather than free text.
 * The production three-account set is bound separately, by `readAiRiskAccounts`. */
export const DENOMINATOR_COMPONENT_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The inert JSON template the denominator's own composition is published in.
 *
 * It is a wire format shared by the renderer and the publication gate, so it
 * lives beside the arithmetic rather than inside either one of them. */
export const AI_DENOMINATOR_TEMPLATE_ID = 'xuan-ib-ai-denominator-v1';
/** The fields one published component carries, and nothing else. */
export const DENOMINATOR_COMPONENT_FIELDS = Object.freeze(['key', 'label', 'valueMicro']);

/** One coefficient as exact basis points, or a refusal. A coefficient this
 * contract cannot express exactly is not one of ours: silently rounding it
 * would publish a number no approved document records. */
export function basisPointsOf(coefficient, where = null) {
  if (typeof coefficient !== 'number' || !Number.isFinite(coefficient)
    || coefficient < 0 || coefficient > 1) fail('COEFFICIENT_INVALID', where);
  const points = Math.round(coefficient * BASIS_POINTS);
  if (Math.abs(points / BASIS_POINTS - coefficient) > 1e-12) fail('COEFFICIENT_NOT_EXACT', where);
  return points;
}

/**
 * One money amount as an exact integer number of micro-USD.
 *
 * The supported input is an integer: a `bigint`, or a plain decimal string of
 * micro-USD. A float is not accepted here at all — `microUsdFromUsdNumber`
 * exists for the older verified-to-the-cent USD form and converts it through
 * decimal text rather than through a float multiply.
 *
 * A value carrying a fraction of a cent is refused rather than rounded: every
 * published figure in this contract is defined on amounts verified to the cent,
 * and quietly rounding here would make a contribution disagree with the source
 * it claims to come from.
 */
export function microUsdOf(value, where = null) {
  let micro = null;
  if (typeof value === 'bigint') micro = value;
  else if (typeof value === 'string' && MICRO_INTEGER.test(value)) micro = BigInt(value);
  else fail('VALUE_NOT_VERIFIED_USD_CENTS', where);
  if (micro < 0n) fail('VALUE_NOT_VERIFIED_USD_CENTS', where);
  if (micro % MICRO_PER_CENT !== 0n) fail('VALUE_NOT_VERIFIED_USD_CENTS', where);
  return micro;
}

/** The older verified-to-the-cent USD number, converted exactly.
 *
 * The conversion reads the number's own decimal text and never multiplies by
 * 100: `Math.round(value * 100)` is a float operation on a value this contract
 * has already promised is exact. */
export function microUsdFromUsdNumber(value, where = null) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12) {
    fail('VALUE_NOT_VERIFIED_USD_CENTS', where);
  }
  const text = String(value);
  if (!USD_CENTS_TEXT.test(text)) fail('VALUE_NOT_VERIFIED_USD_CENTS', where);
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * MICRO_PER_USD + BigInt(fraction.padEnd(2, '0')) * MICRO_PER_CENT;
}

/** Micro-USD to whole cents. Exact by construction: `microUsdOf` already
 * refused anything finer than a cent. */
export function centsFromMicroUsd(micro, where = null) {
  if (typeof micro !== 'bigint' || micro % MICRO_PER_CENT !== 0n) {
    fail('VALUE_NOT_VERIFIED_USD_CENTS', where);
  }
  return micro / MICRO_PER_CENT;
}

/** One row's exact, unrounded contribution in micro-basis units.
 *
 * This is the value that must be summed. Rounding each row first and adding the
 * rounded rows would publish a number that drifts with how many rows there
 * happen to be. */
export function contributionMicroBasis(valueMicro, basisPoints) {
  if (typeof valueMicro !== 'bigint' || typeof basisPoints !== 'bigint') fail('CONTRIBUTION_UNITS_INVALID');
  if (valueMicro < 0n) fail('VALUE_NOT_VERIFIED_USD_CENTS');
  if (basisPoints < 0n || basisPoints > BASIS_POINTS_BIG) fail('COEFFICIENT_OUT_OF_RANGE');
  return valueMicro * basisPoints;
}

/** Micro-basis units to displayed cents, rounded half away from zero, exactly
 * once. This is the only rounding this contract performs, and it is applied at
 * the display layer — to a row's shown figure and to the summed total — never
 * to a value that is about to be added to something else. */
export function roundMicroBasisToCents(microBasis) {
  if (typeof microBasis !== 'bigint') fail('CONTRIBUTION_UNITS_INVALID');
  const magnitude = microBasis < 0n ? -microBasis : microBasis;
  const cents = (magnitude + MICRO_BASIS_PER_CENT / 2n) / MICRO_BASIS_PER_CENT;
  return microBasis < 0n ? -cents : cents;
}

// ---------------------------------------------------------------------------
// The three accounts the risk universe and its denominator span.
//
// The denominator is a composition, not a single typed total: `IB-HK +
// Schwab-HK + Webull, cash included`. Publishing only the sum let a candidate
// move the denominator and the ratio together with nothing to compare either
// against. Each component is named by a stable key here, bound to the portfolio
// the trusted registry records under that name.
// ---------------------------------------------------------------------------

export const AI_RISK_ACCOUNTS = Object.freeze([
  Object.freeze({ key: 'ib-hk', portfolioName: 'IB-HK' }),
  Object.freeze({ key: 'schwab-hk', portfolioName: 'Schwab-HK' }),
  Object.freeze({ key: 'webull', portfolioName: 'Webull' }),
]);
export const AI_RISK_ACCOUNT_KEYS = Object.freeze(AI_RISK_ACCOUNTS.map(account => account.key));

/** The three accounts, bound to the portfolio ids the trusted registry records.
 * The registry is the only place a portfolio id is read from: hard-coding one
 * here would make this module disagree with the registry the moment either
 * moved. */
export function readAiRiskAccounts({ registry = null } = {}) {
  let file = registry;
  if (file === null) {
    try { file = JSON.parse(fs.readFileSync(PORTFOLIO_REGISTRY_PATH, 'utf8')); }
    catch { fail('PORTFOLIO_REGISTRY_UNREADABLE'); }
  }
  if (!plain(file) || !Array.isArray(file.portfolios)) fail('PORTFOLIO_REGISTRY_MISMATCH');
  return AI_RISK_ACCOUNTS.map(account => {
    const matches = file.portfolios.filter(entry => plain(entry) && entry.portfolioName === account.portfolioName);
    if (matches.length !== 1) fail('PORTFOLIO_REGISTRY_ACCOUNT_NOT_UNIQUE', account.portfolioName);
    const [entry] = matches;
    if (!Number.isSafeInteger(entry.portfolioId) || entry.portfolioId <= 0) {
      fail('PORTFOLIO_REGISTRY_ID_INVALID', account.portfolioName);
    }
    // `family` is the household book, `ai_only` an account the registry admits
    // exclusively into the approved AI-pressure set. Anything else — an
    // explicitly excluded portfolio, a role this contract does not know — is
    // refused rather than counted.
    if (!['family', 'ai_only'].includes(entry.role)) fail('PORTFOLIO_REGISTRY_ROLE_UNEXPECTED', account.portfolioName);
    return Object.freeze({ key: account.key, custodian: account.portfolioName,
      portfolioId: String(entry.portfolioId), role: entry.role });
  });
}

// ---------------------------------------------------------------------------
// The trusted rule index, read once per process and validated in full.
// ---------------------------------------------------------------------------

const AUTO_RECORD_ID = /^AUTO:(AUTO-\d{8}-[A-Z0-9]{1,16}-T[1-9]-R\d{1,3}):(\d{1,18}):(\d{1,18})$/;
const ID_STRING = /^[A-Za-z0-9_.:/-]{1,64}$/;

let cached = null;

function ownerOverrides() {
  let file = null;
  try { file = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8')); }
  catch { fail('OVERRIDES_UNREADABLE'); }
  if (!plain(file) || file.schemaVersion !== 1 || file.purpose !== 'risk-measurement-only'
    || !Array.isArray(file.overrides)) fail('OVERRIDES_MISMATCH');
  return file.overrides;
}

function trustedRules() {
  if (cached) return cached;
  const delegated = new Map();
  const delegatedByHolding = new Map();
  for (const { rule } of listDelegatedRules()) {
    delegated.set(rule.approvalId, rule);
    delegatedByHolding.set(`${rule.portfolioId}:${rule.holdingId}`, rule);
  }
  const overrides = new Map();
  const overridesByHolding = new Map();
  for (const rule of ownerOverrides()) {
    if (!plain(rule) || typeof rule.approvalId !== 'string' || !rule.approvalId.startsWith('WU-')) {
      fail('OVERRIDES_MISMATCH', String(rule?.approvalId ?? '?'));
    }
    if (overrides.has(rule.approvalId)) fail('OVERRIDES_DUPLICATE_APPROVAL', rule.approvalId);
    overrides.set(rule.approvalId, rule);
    overridesByHolding.set(`${rule.portfolioId}:${rule.holdingId}`, rule);
  }
  cached = Object.freeze({
    delegated, delegatedByHolding, overrides, overridesByHolding,
    registry: readAiRiskRegistry(),
    auto: readAutoClassificationPolicy(),
  });
  return cached;
}

/** Test seam only: drop the memoised index so a fixture can be re-read. */
export function resetAiCoefficientResolverCache() { cached = null; }

const upper = value => String(value).trim().toUpperCase();

function requireIdentity(record) {
  if (!plain(record)) fail('RECORD_MALFORMED');
  for (const field of ['namespace', 'recordId', 'symbol', 'custodian', 'portfolioId', 'holdingId', 'instrumentId']) {
    if (typeof record[field] !== 'string' || !record[field].trim()) fail('RECORD_IDENTITY_INCOMPLETE', field);
  }
  for (const field of ['portfolioId', 'holdingId', 'instrumentId']) {
    if (!ID_STRING.test(record[field])) fail('RECORD_IDENTITY_INCOMPLETE', field);
  }
  if (!AI_RISK_NAMESPACES.includes(record.namespace)) fail('RECORD_NAMESPACE_UNKNOWN', record.namespace);
  const prefix = record.namespace === AUTO_NAMESPACE ? `${AUTO_NAMESPACE}:` : `${record.namespace}-`;
  if (!record.recordId.startsWith(prefix)) fail('RECORD_NAMESPACE_MISMATCH', record.recordId);
  return record;
}

// Every identity field a rule actually records must match; a field the rule
// never claimed is not invented here. This is the same exactness the delegated
// reader applies, stated against the identity a published manifest carries.
function matchRuleIdentity(rule, record, where) {
  if (upper(rule.symbol) !== upper(record.symbol)) fail('RECORD_IDENTITY_MISMATCH', `${where}.symbol`);
  for (const field of ['portfolioId', 'holdingId', 'instrumentId', 'custodian']) {
    if (!Object.hasOwn(rule, field)) continue;
    if (String(rule[field]) !== String(record[field])) fail('RECORD_IDENTITY_MISMATCH', `${where}.${field}`);
  }
}

/**
 * The one mid coefficient a published record is allowed to carry, as exact
 * basis points, re-resolved from the trusted repository files.
 *
 * `record` is the identity a page publishes for one constituent: namespace,
 * record id, symbol, custodian, portfolio, holding and instrument. Nothing
 * about the page's own arithmetic is read, and no coefficient the page states
 * is accepted as input.
 */
export function resolveTrustedMidCoefficientBp(record) {
  requireIdentity(record);
  const rules = trustedRules();
  const symbol = upper(record.symbol);
  const holdingKey = `${record.portfolioId}:${record.holdingId}`;

  if (record.namespace === AI_RISK_NAMESPACE) {
    const rule = rules.registry.lookup(record.custodian.trim(), symbol);
    if (!rule) fail('REG_RULE_NOT_RECORDED', `${record.custodian}:${symbol}`);
    if (rule.recordId !== record.recordId) fail('REG_RULE_ID_MISMATCH', record.recordId);
    // A registry entry may additionally pin a portfolio, holding or instrument;
    // when it does, that binding must hold too.
    for (const field of ['portfolioId', 'holdingId', 'instrumentId']) {
      if (Object.hasOwn(rule, field) && String(rule[field]) !== String(record[field])) {
        fail('RECORD_IDENTITY_MISMATCH', `REG.${field}`);
      }
    }
    if (typeof rule.ladder?.mid !== 'number') fail('REG_RULE_MID_UNDEFINED', record.recordId);
    return { midBp: basisPointsOf(rule.ladder.mid, record.recordId), namespace: AI_RISK_NAMESPACE,
      recordId: record.recordId, basis: 'registry', tier: rule.tier ?? null };
  }

  if (record.namespace === 'WU' || record.namespace === 'DELEG') {
    // An approval id names its own namespace. `WU` records an explicit owner
    // selection and `DELEG` a routine classification under the standing
    // delegation; presenting one as the other misrepresents its authority.
    const expected = record.recordId.startsWith('DELEG-') ? 'DELEG' : 'WU';
    if (expected !== record.namespace) fail('RECORD_NAMESPACE_MISMATCH', record.recordId);
    // The owner's `WU` selections live in two reviewed files: an approval kept
    // beside the standing delegation, and the identity-bound overrides file.
    const rule = rules.delegated.get(record.recordId)
      ?? (record.namespace === 'WU' ? rules.overrides.get(record.recordId) : undefined);
    if (!rule) fail('OWNER_RULE_NOT_APPROVED', record.recordId);
    matchRuleIdentity(rule, record, record.namespace);
    return { midBp: basisPointsOf(rule.mid, record.recordId), namespace: record.namespace,
      recordId: record.recordId, basis: rules.delegated.has(record.recordId) ? 'delegated' : 'owner-override',
      tier: rule.tier ?? null };
  }

  // AUTO. The record id is not a name to check a prefix on: it is the policy
  // revision, the portfolio and the holding, so it must be the revision this
  // repository actually carries and the identity actually presented.
  const parts = AUTO_RECORD_ID.exec(record.recordId);
  if (!parts) fail('AUTO_RECORD_ID_INVALID', record.recordId);
  const { policy } = rules.auto;
  if (parts[1] !== policy.policyRevision) fail('AUTO_POLICY_REVISION_MISMATCH', parts[1]);
  if (parts[2] !== record.portfolioId || parts[3] !== record.holdingId) {
    fail('RECORD_IDENTITY_MISMATCH', 'AUTO.holding');
  }
  // An automatic classification may never shadow an owner selection, a
  // delegated approval or an already-published registry assignment: production
  // resolves those first, so an AUTO record standing where one of them applies
  // is a record that could only have been written by hand.
  if (rules.delegatedByHolding.has(holdingKey) || rules.overridesByHolding.has(holdingKey)) {
    fail('AUTO_SHADOWS_OWNER_RULE', holdingKey);
  }
  if (rules.registry.lookup(record.custodian.trim(), symbol)) {
    fail('AUTO_SHADOWS_REGISTRY_RULE', `${record.custodian}:${symbol}`);
  }
  return { midBp: basisPointsOf(policy.mid, record.recordId), namespace: AUTO_NAMESPACE,
    recordId: record.recordId, basis: 'auto', tier: policy.tier };
}
