// The single supported reader of `claude/xuan-ib-ai-risk-tiers-v1.json`.
//
// Until this file existed, the tier ladders, the ETF look-through percentages
// and the named exceptions of §0-C lived nowhere. They were retyped into a
// throwaway assembly script on every run — `rows.push(['IB-HK GOOG T2', v, 0.55])`
// — so the numbers a report published were only ever as good as one session's
// typing, and nothing could compare this run's coefficient against the last
// one's. That is the arithmetic half of the 2026-09-11 defect: the
// classification partition can be perfectly correct and the number beside it
// still wrong, because no code connected them.
//
// This module reads one versioned repository file and nothing else: no network,
// no financial account, no clock, no candidate. It never places, modifies or
// cancels anything and it never writes.
//
// It applies coefficients; it does not decide them. Every value in the policy
// file is a transcription of an already-published, already-approved artefact,
// and a tier, ladder or exception that file does not record is refused by name
// rather than approximated.
import fs from 'node:fs';

const POLICY_PATH = new URL('../claude/xuan-ib-ai-risk-tiers-v1.json', import.meta.url);
export const AI_RISK_NAMESPACE = 'REG';

const plain = value => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;

export class AiRiskRegistryException extends Error {
  constructor(code, detail = null) {
    super(`AI risk registry: ${code}${detail === null ? '' : ` (${detail})`}`);
    this.name = 'AiRiskRegistryException';
    this.code = code;
    // A registry problem is an engineering exception for the technical record.
    // It never becomes a per-stock question for the owner, which is exactly what
    // the standing delegation exists to prevent.
    this.owner = 'Codex';
    this.requiresOwnerDecision = false;
    this.createsAwaitingUser = false;
  }
}
const fail = (code, detail = null) => { throw new AiRiskRegistryException(code, detail); };

const TIERS = Object.freeze(['T1', 'T2', 'T3']);
// The only coefficients this module may ever apply. A value outside [0,1] is not
// a conservative reading of anything; it is a typo or a different contract.
const coefficient = value => typeof value === 'number' && Number.isFinite(value)
  && value >= 0 && value <= 1;

function validateLadder(ladder, where) {
  if (!plain(ladder)) fail('LADDER_MALFORMED', where);
  for (const name of ['low', 'mid', 'high']) {
    if (!coefficient(ladder[name])) fail('LADDER_COEFFICIENT_INVALID', `${where}.${name}`);
  }
  // A ladder whose scenarios are not ordered is not a scenario ladder. Publishing
  // a "high" case below its own "low" case would be a silent sign error in the
  // direction that understates risk.
  if (!(ladder.low <= ladder.mid && ladder.mid <= ladder.high)) fail('LADDER_NOT_ORDERED', where);
  return Object.freeze({ low: ladder.low, mid: ladder.mid, high: ladder.high });
}

const key = (custodian, symbol) => `${String(custodian).trim()}:${String(symbol).trim().toUpperCase()}`;

let cached = null;

/**
 * The validated registry. Read once, frozen, and validated in full every time:
 * a policy carrying an unusable entry anywhere is not a policy this module may
 * execute, and skipping that entry silently would hide the problem until the
 * day it was needed.
 */
export function readAiRiskRegistry() {
  if (cached) return cached;
  let file = null;
  try { file = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8')); }
  catch { fail('POLICY_UNREADABLE'); }
  if (!plain(file) || file.schemaVersion !== 1 || file.purpose !== 'risk-measurement-only'
    || file.namespace !== AI_RISK_NAMESPACE || typeof file.policyRevision !== 'string'
    || !file.policyRevision.trim()) fail('POLICY_MISMATCH');
  // The file must keep saying, in machine-readable form, that it changes no
  // coefficient and authorises no write. A future edit that quietly drops those
  // statements is a different document and is refused as one.
  if (file.financialWrites !== false || file.coefficientChanges !== false) fail('POLICY_SCOPE_WIDENED');
  if (!plain(file.transcription) || file.transcription.changesAnyCoefficient !== false
    || file.transcription.inventsAnyCoefficient !== false) fail('POLICY_TRANSCRIPTION_CLAIM_MISSING');
  if (!plain(file.ladders)) fail('POLICY_MISMATCH');

  const ladders = new Map();
  for (const tier of TIERS) {
    if (!plain(file.ladders[tier])) fail('LADDER_MISSING', tier);
    ladders.set(tier, validateLadder(file.ladders[tier], tier));
  }
  if (Object.keys(file.ladders).length !== TIERS.length) fail('LADDER_UNKNOWN_TIER');

  const entries = new Map();
  const claim = (custodian, symbol, value) => {
    if (typeof custodian !== 'string' || !custodian.trim()) fail('ENTRY_CUSTODIAN_REQUIRED', symbol);
    if (typeof symbol !== 'string' || !symbol.trim()) fail('ENTRY_SYMBOL_REQUIRED', custodian);
    const id = key(custodian, symbol);
    // One custodian-and-symbol holds exactly one coefficient rule. Two rules for
    // one position would make the published number depend on file order.
    if (entries.has(id)) fail('ENTRY_DUPLICATE', id);
    entries.set(id, Object.freeze({ ...value, custodian: custodian.trim(), symbol: symbol.trim().toUpperCase(), id }));
  };

  if (!Array.isArray(file.stocks)) fail('POLICY_MISMATCH');
  for (const stock of file.stocks) {
    if (!plain(stock) || !TIERS.includes(stock.tier)) fail('STOCK_ENTRY_INVALID', String(stock?.symbol ?? '?'));
    claim(stock.custodian, stock.symbol, {
      kind: 'stock-tier', tier: stock.tier, ladder: ladders.get(stock.tier),
      recordId: `${AI_RISK_NAMESPACE}-${file.policyRevision}-${key(stock.custodian, stock.symbol).replace(/[^A-Za-z0-9:.\/-]/g, '')}`,
      publishedLabel: typeof stock.publishedLabel === 'string' ? stock.publishedLabel : stock.tier,
    });
  }

  if (!Array.isArray(file.etfLookThrough)) fail('POLICY_MISMATCH');
  for (const etf of file.etfLookThrough) {
    if (!plain(etf) || !coefficient(etf.mid)) fail('ETF_ENTRY_INVALID', String(etf?.symbol ?? '?'));
    // A look-through percentage is a composition fact about one fund, not a
    // scenario ladder, and the published report states exactly one of them. Low
    // and high are therefore unavailable rather than equal to the mid case or
    // zero — filling them in would be inventing a coefficient.
    if (etf.scenario !== 'mid-only') fail('ETF_SCENARIO_UNSUPPORTED', String(etf.symbol));
    claim(etf.custodian, etf.symbol, {
      kind: 'etf-look-through', tier: null,
      ladder: Object.freeze({ low: null, mid: etf.mid, high: null }),
      recordId: `${AI_RISK_NAMESPACE}-${file.policyRevision}-${key(etf.custodian, etf.symbol).replace(/[^A-Za-z0-9:.\/-]/g, '')}`,
      publishedLabel: typeof etf.publishedLabel === 'string' ? etf.publishedLabel : 'ETF look-through',
    });
  }

  if (!Array.isArray(file.specialCases)) fail('POLICY_MISMATCH');
  for (const special of file.specialCases) {
    if (!plain(special) || typeof special.id !== 'string' || !special.id.startsWith(`${AI_RISK_NAMESPACE}-`)) {
      fail('SPECIAL_ENTRY_INVALID', String(special?.symbol ?? '?'));
    }
    let ladder = null;
    let tier = null;
    if (special.kind === 'leveraged-etf') {
      // min(leverage x underlying coefficient, cap), applied scenario by
      // scenario. The cap is what stops a levered position from contributing
      // more than its own market value to the numerator.
      const base = ladders.get(special.underlyingTier);
      if (!base) fail('SPECIAL_UNDERLYING_TIER_UNKNOWN', special.id);
      if (typeof special.leverage !== 'number' || !Number.isFinite(special.leverage)
        || special.leverage <= 0 || special.leverage > 5) fail('SPECIAL_LEVERAGE_INVALID', special.id);
      if (!coefficient(special.cap)) fail('SPECIAL_CAP_INVALID', special.id);
      tier = special.underlyingTier;
      ladder = Object.freeze(Object.fromEntries(['low', 'mid', 'high'].map(name =>
        [name, Math.min(base[name] * special.leverage, special.cap)])));
    } else if (special.kind === 'named-tier-exception') {
      const base = ladders.get(special.tier);
      if (!base) fail('SPECIAL_TIER_UNKNOWN', special.id);
      tier = special.tier;
      ladder = base;
    } else if (special.kind === 'explicit-ladder') {
      ladder = validateLadder(special, special.id);
    } else {
      // A special case this module cannot execute is named and refused. It is
      // never approximated onto the nearest standard tier.
      fail('SPECIAL_KIND_UNSUPPORTED', `${special.id}:${String(special.kind)}`);
    }
    claim(special.custodian, special.symbol, {
      kind: special.kind, tier, ladder, recordId: special.id,
      publishedLabel: typeof special.publishedLabel === 'string' ? special.publishedLabel : special.kind,
    });
  }

  cached = Object.freeze({
    policyRevision: file.policyRevision,
    namespace: AI_RISK_NAMESPACE,
    ladders,
    entries,
    /** The standard ladder for one tier name, or null. */
    ladderFor: tier => ladders.get(tier) ?? null,
    /** The registry rule for one custodian-and-symbol, or null when unrecorded. */
    lookup: (custodian, symbol) => entries.get(key(custodian, symbol)) ?? null,
  });
  return cached;
}

/** Test seam only: drop the memoised policy so a fixture can be re-read. */
export function resetAiRiskRegistryCache() { cached = null; }
