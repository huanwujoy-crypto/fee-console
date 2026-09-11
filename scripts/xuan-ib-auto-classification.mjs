// Automatic classification of a first-seen ordinary stock. Measurement only.
//
// On 2026-09-11 a position appeared that no approved rule covered. It was left
// out of the AI-pressure numerator while staying inside the denominator, which
// understates the very risk the metric exists to report. Leaving it out was not
// a bug in any single check: there was simply no path for "a stock nobody has
// classified yet", and the delegated reader is right to refuse one — its job is
// to apply an owner's approval exactly, never to invent one.
//
// This module is that missing path, and it is deliberately narrow. For a
// position that is genuinely first-seen, whose identity the sources verified,
// that no `WU` or `DELEG` rule already covers, and whose asset type is
// unambiguously ordinary stock, it applies the most conservative tier that
// already exists — standard T1, the same coefficients the owner already
// approved elsewhere — under its own `AUTO` namespace.
//
// The result is a real classification for the period, not a placeholder. There
// is no "provisional" state to linger and no queue to drain: the point of the
// standing delegation is that routine classification stops producing per-stock
// owner questions. So this module never creates an `awaiting_user` item, never
// mints a `WU` or `DELEG` receipt, never adopts a coefficient, never widens an
// account scope, and never touches an order, transfer or any financial write.
//
// Anything it cannot classify is fail-visible: named, disclosed with an
// enumerated reason and excluded — a Codex-owned technical exception for the
// technical record, never a guess and never zero.
//
// It reads two versioned repository files and nothing else: no network, no
// financial account, no clock.
import fs from 'node:fs';
import { SUPPORTED_TIERS, listDelegatedRules } from './xuan-ib-delegated-tier.mjs';

const POLICY_PATH = new URL('../claude/xuan-ib-auto-classification-v1.json', import.meta.url);
const OVERRIDES_PATH = new URL('../claude/xuan-ib-ai-tier-overrides-v1.json', import.meta.url);

// The AUTO namespace is separate on purpose. A `WU` id records an explicit
// owner selection and a `DELEG` id a routine classification made under the
// owner's standing delegation for one named instrument; neither may be
// manufactured here, and an AUTO record must never be mistaken for either.
export const AUTO_NAMESPACE = 'AUTO';
const POLICY_REVISION = /^AUTO-(\d{4})(\d{2})(\d{2})-[A-Z0-9]{1,16}-(T[1-9])-R(\d{1,3})$/;
const ID_STRING = /^\d{1,18}$/;
const USD_CENTS = /^\d+(?:\.\d{1,2})?$/;

// Wording that would turn a real, if conservative, classification back into a
// placeholder. An AUTO record is this period's effective classification, so
// nothing it emits may describe itself as temporary, unconfirmed or pending a
// ruling — that phrasing is what re-creates the per-stock decision queue the
// delegation exists to remove.
export const FORBIDDEN_PROVISIONAL_WORDS = Object.freeze(['临时', '待确认', '待裁决']);

// Why a position could not be classified automatically. Each one is disclosed
// by name; none of them is ever filled in with a tier, a zero or a guess.
export const AUTO_EXCLUSION_REASONS = Object.freeze({
  IDENTITY_UNVERIFIED: 'source-identity-unverified',
  NOT_FIRST_SEEN: 'not-first-seen-position',
  EXISTING_OWNER_RULE: 'existing-wu-or-deleg-rule',
  ASSET_TYPE_NOT_ORDINARY_STOCK: 'asset-type-not-ordinary-stock',
  ASSET_TYPE_UNKNOWN: 'asset-type-unknown-or-ambiguous',
  VALUE_NOT_VERIFIED: 'value-not-verified-usd-cents',
  VALUE_DATE_MISSING: 'value-date-missing',
  IDENTITY_INCOMPLETE: 'identity-fields-incomplete',
});

const plain = value => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;
const realDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export class AutoClassificationException extends Error {
  constructor(code, { detail = null, symbol = null, reason = null } = {}) {
    super(`Auto classification: ${code}${detail === null ? '' : ` (${detail})`}`);
    this.name = 'AutoClassificationException';
    this.code = code;
    this.symbol = symbol;
    // The enumerated reason the position is excluded, so a report can disclose
    // it by name instead of printing a generic failure.
    this.reason = reason;
    // An unresolved technical exception belongs to the accountable engineer. It
    // is never converted into an owner decision, and the standing rule against
    // per-stock user decisions applies here exactly as it does to the delegated
    // reader.
    this.owner = 'Codex';
    this.requiresOwnerDecision = false;
    this.createsAwaitingUser = false;
  }
};
const fail = (code, options = {}) => { throw new AutoClassificationException(code, options); };

const POLICY_KEYS = Object.freeze(['schemaVersion', 'policyId', 'policyRevision', 'effectiveDate',
  'activation', 'purpose', 'authority', 'namespace', 'tier', 'low', 'mid', 'high', 'notifyOnce',
  'createsAwaitingUser', 'mintsOwnerReceipt', 'requireDecisionForRoutineClassification',
  'coefficientChanges', 'accountScopeChanges', 'financialWrites', 'requireSourceIdentityVerified',
  'requireFirstSeen', 'ordinaryStockAssetTypes', 'excludedAssetTypes']);

export function readAutoClassificationPolicy({ path = POLICY_PATH } = {}) {
  let policy = null;
  try { policy = JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch { fail('POLICY_UNREADABLE'); }
  if (!plain(policy)) fail('POLICY_MISMATCH');
  // Exact shape. An unrecognized key could carry a permission this reader does
  // not enforce — a widened scope, a financial write, an owner receipt — and
  // ignoring it would apply the policy more broadly than it was written.
  for (const key of Object.keys(policy)) if (!POLICY_KEYS.includes(key)) fail('POLICY_UNKNOWN_FIELD', { detail: key });
  const revision = POLICY_REVISION.exec(String(policy.policyRevision ?? ''));
  if (policy.schemaVersion !== 1
    || policy.policyId !== 'AUTO-NEWSTK-T1'
    || !revision || !realDate(`${revision[1]}-${revision[2]}-${revision[3]}`)
    || revision[4] !== policy.tier
    || !realDate(policy.effectiveDate)
    || policy.purpose !== 'risk-measurement-only'
    || policy.authority !== 'owner-authorizable-first-seen-ordinary-stock-classification'
    || policy.namespace !== AUTO_NAMESPACE
    || policy.notifyOnce !== true
    // Every one of these must be false in the file itself. The module refuses
    // to execute a policy that claims any of them, rather than merely declining
    // to act on the claim.
    || policy.createsAwaitingUser !== false
    || policy.mintsOwnerReceipt !== false
    || policy.requireDecisionForRoutineClassification !== false
    || policy.coefficientChanges !== false
    || policy.accountScopeChanges !== false
    || policy.financialWrites !== false
    || policy.requireSourceIdentityVerified !== true
    || policy.requireFirstSeen !== true
    || !Array.isArray(policy.ordinaryStockAssetTypes) || !policy.ordinaryStockAssetTypes.length
    || !Array.isArray(policy.excludedAssetTypes) || !policy.excludedAssetTypes.length) fail('POLICY_MISMATCH');
  // The policy is not free to invent coefficients: it may only name a tier that
  // is already on the delegated whitelist, with that tier's exact triple.
  const tier = Object.hasOwn(SUPPORTED_TIERS, policy.tier) ? SUPPORTED_TIERS[policy.tier] : null;
  if (tier === null || policy.low !== tier.low || policy.mid !== tier.mid || policy.high !== tier.high) {
    fail('POLICY_COEFFICIENTS_UNSUPPORTED', { detail: String(policy.tier) });
  }
  // An asset type cannot be both ordinary stock and excluded.
  const ordinary = policy.ordinaryStockAssetTypes.map(normalizeAssetType);
  const excluded = policy.excludedAssetTypes.map(normalizeAssetType);
  if (ordinary.some(type => type === null) || excluded.some(type => type === null)
    || ordinary.some(type => excluded.includes(type))) fail('POLICY_ASSET_TYPES_INCONSISTENT');
  return { policy, tier, ordinary, excluded };
}

// One spelling per asset type, so `Common Stock`, `common-stock` and
// `COMMON_STOCK` are one thing and an unrecognized spelling stays unrecognized
// rather than being coerced towards the nearest known type.
export const normalizeAssetType = value => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return /^[A-Z][A-Z0-9_]{0,31}$/.test(normalized) ? normalized : null;
};

// Every identity a `WU` or `DELEG` rule already covers. An automatic
// classification must stand aside for an owner selection or a named delegated
// approval, whichever exists, and must never shadow one.
export function existingOwnerRuleKeys() {
  const keys = new Map();
  for (const { rule } of listDelegatedRules()) {
    keys.set(`${rule.portfolioId}:${rule.holdingId}`, rule.approvalId);
  }
  let overrides = null;
  try { overrides = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8')); }
  catch { fail('OVERRIDES_UNREADABLE'); }
  if (!plain(overrides) || overrides.schemaVersion !== 1
    || overrides.purpose !== 'risk-measurement-only'
    || !Array.isArray(overrides.overrides)) fail('OVERRIDES_MISMATCH');
  for (const rule of overrides.overrides) {
    if (!plain(rule) || typeof rule.portfolioId !== 'string' || typeof rule.holdingId !== 'string'
      || typeof rule.approvalId !== 'string') fail('OVERRIDES_MISMATCH');
    keys.set(`${rule.portfolioId}:${rule.holdingId}`, rule.approvalId);
  }
  return keys;
}

const IDENTITY = Object.freeze(['symbol', 'portfolioId', 'holdingId', 'instrumentId', 'currency', 'venue']);

/**
 * Classify one first-seen position, or refuse it visibly.
 *
 * Returns this period's effective classification. It is not a status to revisit
 * and carries no owner decision of any kind.
 */
export function classifyFirstSeenPosition(input, {
  policy = readAutoClassificationPolicy(),
  ownerRuleKeys = null,
} = {}) {
  const { policy: file, tier, ordinary, excluded } = policy;
  if (!plain(input)) fail('INPUT_MALFORMED');
  for (const key of IDENTITY) {
    if (typeof input[key] !== 'string' || !input[key].trim()) {
      fail('IDENTITY_INCOMPLETE', { detail: key, symbol: input.symbol ?? null,
        reason: AUTO_EXCLUSION_REASONS.IDENTITY_INCOMPLETE });
    }
  }
  const symbol = input.symbol;
  for (const key of ['portfolioId', 'holdingId', 'instrumentId']) {
    if (!ID_STRING.test(input[key])) {
      fail('IDENTITY_INCOMPLETE', { detail: key, symbol, reason: AUTO_EXCLUSION_REASONS.IDENTITY_INCOMPLETE });
    }
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    fail('IDENTITY_INCOMPLETE', { detail: 'currency', symbol, reason: AUTO_EXCLUSION_REASONS.IDENTITY_INCOMPLETE });
  }
  // Identity must have been verified against the sources, not merely supplied.
  // An automatic classification bound to an unverified identity would be an
  // assignment onto whatever happened to share a ticker.
  if (input.identityVerified !== true) {
    fail('SOURCE_IDENTITY_UNVERIFIED', { symbol, reason: AUTO_EXCLUSION_REASONS.IDENTITY_UNVERIFIED });
  }
  // First-ever-seen only. A position the reports have carried for weeks without
  // a rule is a different question and is not silently settled here.
  if (input.firstSeen !== true) {
    fail('NOT_FIRST_SEEN', { symbol, reason: AUTO_EXCLUSION_REASONS.NOT_FIRST_SEEN });
  }
  const keys = ownerRuleKeys ?? existingOwnerRuleKeys();
  const existing = keys.get(`${input.portfolioId}:${input.holdingId}`) ?? null;
  if (existing !== null) {
    fail('EXISTING_OWNER_RULE', { detail: existing, symbol, reason: AUTO_EXCLUSION_REASONS.EXISTING_OWNER_RULE });
  }
  const assetType = normalizeAssetType(input.assetType);
  // Unknown or unreadable is not "probably a stock". It is excluded and named.
  if (assetType === null) {
    fail('ASSET_TYPE_UNKNOWN', { symbol, reason: AUTO_EXCLUSION_REASONS.ASSET_TYPE_UNKNOWN });
  }
  // Every already-known non-stock type is refused explicitly rather than by
  // failing to match: an ETF, fund, bond, cash, commodity or derivative has its
  // own treatment and never acquires a single-stock pressure tier here.
  if (excluded.includes(assetType)) {
    fail('ASSET_TYPE_NOT_ORDINARY_STOCK', { detail: assetType, symbol,
      reason: AUTO_EXCLUSION_REASONS.ASSET_TYPE_NOT_ORDINARY_STOCK });
  }
  if (!ordinary.includes(assetType)) {
    fail('ASSET_TYPE_UNKNOWN', { detail: assetType, symbol, reason: AUTO_EXCLUSION_REASONS.ASSET_TYPE_UNKNOWN });
  }
  if (input.currency !== 'USD') {
    fail('CURRENCY_UNSUPPORTED', { detail: input.currency, symbol,
      reason: AUTO_EXCLUSION_REASONS.IDENTITY_INCOMPLETE });
  }
  const value = input.marketValueUsd;
  // A missing or unusable value stays a data exception. It is never zero, and
  // it never becomes an owner classification question.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12
    || !USD_CENTS.test(String(value))) {
    fail('VALUE_NOT_VERIFIED_USD_CENTS', { symbol, reason: AUTO_EXCLUSION_REASONS.VALUE_NOT_VERIFIED });
  }
  if (!realDate(input.valueDate)) {
    fail('VALUE_DATE_REQUIRED', { symbol, reason: AUTO_EXCLUSION_REASONS.VALUE_DATE_MISSING });
  }
  // Exact integer arithmetic on cents, identical to the delegated reader, so a
  // published low/mid/high never drifts with binary floating point.
  const cents = BigInt(Math.round(value * 100));
  const scale = name => { const [factor, divisor] = tier.cents[name]; return Number(cents * factor) / divisor; };
  return {
    namespace: AUTO_NAMESPACE,
    policyId: file.policyId,
    policyRevision: file.policyRevision,
    // An AUTO record id, never a `WU-` or `DELEG-` approval id. Nothing here
    // may be read as an owner selection or a named delegated approval.
    classificationId: `${AUTO_NAMESPACE}:${file.policyRevision}:${input.portfolioId}:${input.holdingId}`,
    tier: file.tier,
    symbol, venue: input.venue, assetType,
    portfolioId: input.portfolioId, holdingId: input.holdingId, instrumentId: input.instrumentId,
    currency: input.currency, valueDate: input.valueDate, marketValueUsd: value,
    low: scale('low'), mid: scale('mid'), high: scale('high'),
    // Stable across runs for one identity under one policy revision: a later
    // report of the same position under the same policy is the same
    // classification, not a new one, so it must not notify again. This is an
    // identity to record delivery against — it is not a message, and generating
    // it is not delivery.
    notifyId: `classification:${input.portfolioId}:${input.holdingId}:${file.policyRevision}`,
    notifyOnce: true,
    // Explicit, and asserted by the tests: this path produces no owner artefact
    // of any kind.
    createsAwaitingUser: false,
    mintsOwnerReceipt: false,
    requiresOwnerDecision: false,
    effective: true,
  };
}

// Notification is closed once — and only once the published page carrying the
// classification has actually been read back in public. Producing the record is
// not delivery, and a page that has not been read back is not publication.
export function closeAutoNotification(record, { publicReadBackVerified = false, closedAtHkt = null } = {}) {
  if (!plain(record) || record.namespace !== AUTO_NAMESPACE || typeof record.notifyId !== 'string') {
    fail('NOTIFICATION_RECORD_INVALID');
  }
  if (publicReadBackVerified !== true) fail('NOTIFICATION_READBACK_REQUIRED', { symbol: record.symbol });
  if (typeof closedAtHkt !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} HKT$/.test(closedAtHkt)
    || !realDate(closedAtHkt.slice(0, 10))) fail('NOTIFICATION_INSTANT_REQUIRED', { symbol: record.symbol });
  return Object.freeze({ notifyId: record.notifyId, state: 'delivered', closedAtHkt, notifyOnce: true });
}

export const autoNotificationState = (record, { delivered = [] } = {}) => {
  if (!plain(record) || typeof record.notifyId !== 'string') fail('NOTIFICATION_RECORD_INVALID');
  return delivered.includes(record.notifyId) ? 'delivered' : 'pending';
};

// Reject placeholder wording before it can reach a page. An AUTO record states
// a conservative classification as a fact for the period; describing it as
// temporary or awaiting a ruling would recreate the per-stock decision queue.
export function assertNoProvisionalWording(text, label = 'auto classification text') {
  if (typeof text !== 'string') fail('TEXT_INVALID', { detail: label });
  for (const word of FORBIDDEN_PROVISIONAL_WORDS) {
    if (text.includes(word)) fail('PROVISIONAL_WORDING', { detail: `${label}:${word}` });
  }
  return text;
}

const escape = value => String(value).replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

// The machine-readable record a report carries for a position classified here,
// alongside the one-line human disclosure. The guard reads the namespace and id
// from this shape; it is inert markup and carries no amount.
export function renderAutoClassificationRecord(record) {
  if (!plain(record) || record.namespace !== AUTO_NAMESPACE) fail('NOTIFICATION_RECORD_INVALID');
  const text = `${record.symbol}（${record.venue}）首次出现，来源身份已核验，属普通股，无既有 WU／DELEG 规则，`
    + `按自动分类政策 ${record.policyRevision} 采用标准 T1（60%／80%／100%），本期计入 AI 压力分子。`;
  assertNoProvisionalWording(text, `auto disclosure for ${record.symbol}`);
  return `<p data-ai-tier-symbol="${escape(record.symbol)}" data-ai-tier-namespace="${AUTO_NAMESPACE}"`
    + ` data-ai-tier-record="${escape(record.classificationId)}">${escape(text)}</p>`;
}
