// Delegated risk-tier classification. Measurement only.
//
// The owner delegated routine, evidence-supported classification under the
// coefficients that already exist. This module is the single supported reader of
// that delegation: it resolves one approved rule by its approval ID, proves the
// input is exactly the instrument the owner approved, and returns deterministic
// low/mid/high exposure. It reads one versioned repository file and nothing
// else — no financial account, no network, no clock — and it never places,
// modifies or cancels anything.
//
// It also never produces an owner decision. A rule it cannot resolve, or an
// input it cannot match, is a technical exception owned by Codex and recorded
// in the technical record: the delegation exists precisely so that routine
// classification stops queuing `awaiting_user` items, and an exception is never
// closed by guessing a tier instead.
import fs from 'node:fs';

const POLICY_PATH = new URL('../claude/xuan-ib-classification-delegation-v1.json', import.meta.url);

// Only coefficients the owner has already approved may be applied. A rule
// naming any other tier, or any other triple under a known tier, is refused
// rather than calculated: adopting a coefficient is a decision this delegation
// explicitly withholds (`coefficientChanges: false`). The scaling is exact
// integer arithmetic on cents, so a published low/mid/high never drifts with
// binary floating point.
export const SUPPORTED_TIERS = Object.freeze({
  T1: Object.freeze({
    low: 0.6, mid: 0.8, high: 1,
    cents: Object.freeze({ low: [6n, 1000], mid: [8n, 1000], high: [1n, 100] }),
  }),
});

// Identity is exact and complete. Every rule carries the core five; a rule that
// records more must match those too, so a later, better-evidenced approval
// cannot be satisfied by a weaker input that merely shares a ticker.
const CORE_IDENTITY = Object.freeze(['symbol', 'portfolioId', 'holdingId', 'instrumentId', 'currency']);
const EXTRA_IDENTITY = Object.freeze(['custodian', 'venue', 'instrumentName']);
const RULE_FIELDS = Object.freeze(['tier', 'low', 'mid', 'high', 'approvalId']);

// `WU` records an explicit owner selection; `DELEG` records a routine
// classification made under the owner's standing delegation. Keeping the two
// receipts distinct prevents a delegated decision from being misrepresented
// as a per-instrument owner instruction.
const APPROVAL_ID = /^(WU|DELEG)-(\d{4})(\d{2})(\d{2})-[A-Z0-9]{1,12}-(T[1-9])$/;
const ID_STRING = /^\d{1,18}$/;
// A verified holding value in the approved currency, to the cent. Anything with
// more precision was not read from a statement and is not published.
const USD_CENTS = /^\d+(?:\.\d{1,2})?$/;
const plain = value => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;
const realDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export class DelegatedTierException extends Error {
  constructor(code, detail = null) {
    super(`Delegated tier: ${code}${detail === null ? '' : ` (${detail})`}`);
    this.name = 'DelegatedTierException';
    this.code = code;
    // An unresolved technical exception belongs to the accountable engineer.
    // It is never converted into an owner decision and never silently defaulted.
    this.owner = 'Codex';
    this.requiresOwnerDecision = false;
  }
}
const fail = (code, detail = null) => { throw new DelegatedTierException(code, detail); };

function readDelegationPolicy() {
  let policy = null;
  try { policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8')); }
  catch { fail('POLICY_UNREADABLE'); }
  // The delegation covers measurement only, keeps historical receipts, and
  // grants no coefficient change and no financial write. A file that claims
  // otherwise is not this policy and must not be executed.
  if (!plain(policy) || policy.schemaVersion !== 1
    || policy.purpose !== 'risk-measurement-only'
    || policy.authority !== 'owner-authorized-evidence-supported-classification'
    || policy.notifyOnce !== true
    || policy.preserveHistoricalReceipts !== true
    || policy.requireDecisionForRoutineClassification !== false
    || policy.financialWrites !== false
    || policy.coefficientChanges !== false
    || !Array.isArray(policy.overrides) || !policy.overrides.length) fail('POLICY_MISMATCH');
  return policy;
}

function validateRule(rule) {
  if (!plain(rule)) fail('RULE_MALFORMED');
  const parts = APPROVAL_ID.exec(String(rule.approvalId ?? ''));
  if (!parts || !realDate(`${parts[2]}-${parts[3]}-${parts[4]}`)) fail('RULE_APPROVAL_ID_INVALID', rule.approvalId);
  const tier = Object.hasOwn(SUPPORTED_TIERS, rule.tier) ? SUPPORTED_TIERS[rule.tier] : null;
  if (tier === null || rule.low !== tier.low || rule.mid !== tier.mid || rule.high !== tier.high) {
    fail('RULE_COEFFICIENTS_UNSUPPORTED', `${rule.approvalId}:${rule.tier}`);
  }
  // The approval ID names the tier it approved; a rule whose body disagrees with
  // its own approval is refused rather than reconciled.
  if (parts[5] !== rule.tier) fail('RULE_TIER_MISMATCH', rule.approvalId);
  const identity = [...CORE_IDENTITY, ...EXTRA_IDENTITY.filter(key => Object.hasOwn(rule, key))];
  for (const key of identity) {
    if (typeof rule[key] !== 'string' || !rule[key].trim()) fail('RULE_IDENTITY_INCOMPLETE', key);
  }
  for (const key of ['portfolioId', 'holdingId', 'instrumentId']) {
    if (!ID_STRING.test(rule[key])) fail('RULE_IDENTITY_INCOMPLETE', key);
  }
  if (!/^[A-Z]{3}$/.test(rule.currency)) fail('RULE_IDENTITY_INCOMPLETE', 'currency');
  // No field outside the approved rule shape: an unrecognized key could carry a
  // condition this reader does not enforce, and ignoring it would apply the rule
  // more widely than it was approved.
  const allowed = new Set([...identity, ...RULE_FIELDS]);
  for (const key of Object.keys(rule)) if (!allowed.has(key)) fail('RULE_UNKNOWN_FIELD', key);
  return { rule, identity, tier };
}

export function listDelegatedRules() {
  // Every rule in the file is validated, not only the one being used: a policy
  // carrying an unsupported coefficient anywhere is not a policy this module may
  // execute, and skipping it silently would hide the problem until it was used.
  const validated = readDelegationPolicy().overrides.map(validateRule);
  const unique = (values, code) => { if (new Set(values).size !== values.length) fail(code); };
  unique(validated.map(entry => entry.rule.approvalId), 'POLICY_DUPLICATE_APPROVAL');
  // One holding cannot carry two approved tiers; which one applied would
  // otherwise depend on file order.
  unique(validated.map(entry => `${entry.rule.portfolioId}:${entry.rule.holdingId}`), 'POLICY_DUPLICATE_HOLDING');
  return validated;
}

export function findDelegatedRule(approvalId) {
  const found = listDelegatedRules().find(entry => entry.rule.approvalId === approvalId);
  if (!found) fail('RULE_NOT_APPROVED', approvalId);
  return found;
}

export function calculateDelegatedTier(input, { approvalId = null } = {}) {
  if (!plain(input)) fail('INPUT_MALFORMED');
  const { rule, identity, tier } = findDelegatedRule(approvalId ?? input.approvalId ?? null);
  // Exact identity, field by field. A near match is a technical exception, never
  // a close-enough assignment onto the owner's approval: the same ticker exists
  // under other custodians, portfolios and instrument IDs.
  for (const key of identity) if (input[key] !== rule[key]) fail('IDENTITY_MISMATCH', key);
  if (rule.currency !== 'USD') fail('CURRENCY_UNSUPPORTED', rule.currency);
  // A missing or unusable value stays a Codex-owned data exception. It is never
  // zero, and it never becomes an owner classification question.
  const value = input.marketValueUsd;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12
    || !USD_CENTS.test(String(value))) fail('VALUE_NOT_VERIFIED_USD_CENTS');
  if (!realDate(input.valueDate)) fail('VALUE_DATE_REQUIRED');
  const cents = BigInt(Math.round(value * 100));
  const scale = name => { const [factor, divisor] = tier.cents[name]; return Number(cents * factor) / divisor; };
  return {
    approvalId: rule.approvalId, tier: rule.tier, symbol: rule.symbol,
    portfolioId: rule.portfolioId, holdingId: rule.holdingId, instrumentId: rule.instrumentId,
    currency: rule.currency, valueDate: input.valueDate, marketValueUsd: value,
    low: scale('low'), mid: scale('mid'), high: scale('high'),
    // One stable identity per rule, not per run: it survives the holding's value
    // and date moving, so a later report under the same established tier cannot
    // look like a new classification. This is an identity to record delivery
    // against — it is not a message, and generating it is not delivery.
    notifyId: `classification:${rule.portfolioId}:${rule.holdingId}:${rule.approvalId}`,
    notifyOnce: true,
  };
}
