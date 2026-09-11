// Complete AI-tier coverage for one run's risk constituents. Measurement only.
//
// Round one of this repair produced two things that were correct in isolation
// and unreachable in practice: a delegated reader that applies an owner's
// approval exactly, and an automatic classifier for a first-seen ordinary stock
// that no approval covers. Nothing called the second one, and nothing produced
// the machine-readable record the publication gate had learned to read. A new
// position could therefore still fall out of the AI-pressure numerator while
// staying in the denominator — the exact defect of 2026-09-11 — because the
// only thing standing between the report and that outcome was prose.
//
// This module is the missing production step. It takes the run's own normalized
// holdings and resolves EVERY one of them, in a fixed order:
//
//   1. an exact `WU` or `DELEG` rule, matched field by field, never by ticker;
//   2. otherwise the automatic `AUTO` policy, for a first-seen ordinary stock;
//   3. otherwise an explicit exclusion carrying an enumerated reason.
//
// There is no fourth outcome and no silent one. The result is a complete
// partition of the constituent universe into classified and excluded, which is
// what lets the publication gate reconcile the page's own holdings against its
// own records as arithmetic rather than as a matter of wording.
//
// It reads versioned repository files through their existing trusted readers
// and nothing else: no network, no financial account, no clock. It never places,
// modifies or cancels anything, never mints an owner receipt, never creates an
// `awaiting_user` item and never adopts a coefficient.
import {
  AUTO_EXCLUSION_REASONS, AUTO_NAMESPACE, assertNoProvisionalWording,
  classifyFirstSeenPosition, continueAutoClassification, readAutoClassificationPolicy,
  renderAutoClassificationRecord,
} from './xuan-ib-auto-classification.mjs';
import { AI_RISK_NAMESPACE, readAiRiskRegistry } from './xuan-ib-ai-risk-registry.mjs';
import { calculateDelegatedTier, listDelegatedRules } from './xuan-ib-delegated-tier.mjs';
import fs from 'node:fs';

const OVERRIDES_PATH = new URL('../claude/xuan-ib-ai-tier-overrides-v1.json', import.meta.url);
export const AI_TIER_RECORDS_ID = 'xuan-ib-ai-tier-records-v1';

const plain = value => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;

export class AiTierCoverageException extends Error {
  constructor(code, detail = null) {
    super(`AI tier coverage: ${code}${detail === null ? '' : ` (${detail})`}`);
    this.name = 'AiTierCoverageException';
    this.code = code;
    // A coverage problem is an engineering exception. It is never converted
    // into a per-stock owner question, which is precisely what the standing
    // delegation exists to stop.
    this.owner = 'Codex';
    this.requiresOwnerDecision = false;
    this.createsAwaitingUser = false;
  }
}
const fail = (code, detail = null) => { throw new AiTierCoverageException(code, detail); };

// The identity a constituent must carry before it can be resolved at all. These
// are the same fields the approved rules are written against, so a report can
// never satisfy a rule with less identity than the rule records.
//
// `custodian` is part of that identity, not decoration. The risk universe spans
// three accounts, and the same company is legitimately held in more than one of
// them: `GOOG` at IB-HK and `GOOG` at Webull are two positions, two market
// values and two contributions. `BRK.B` at IB-HK and `BRK/B` at Schwab-HK are
// one company spelled two ways. Neither fact is expressible in a ticker.
const CONSTITUENT = Object.freeze(['symbol', 'custodian', 'venue', 'portfolioId', 'holdingId',
  'instrumentId', 'currency', 'assetType', 'marketValueUsd', 'valueDate', 'identityVerified',
  'firstSeen']);

// The exact integer form of the same market value, in micro-USD. It is optional
// here and authoritative wherever it appears: this module classifies and never
// values, so it neither reads nor checks the amount, and `computeAiPressure`
// refuses a record whose two forms disagree. It is listed rather than ignored so
// that the strict field check below stays strict — an unrecognized field could
// carry a claim nothing verifies.
const CONSTITUENT_OPTIONAL = Object.freeze(['marketValueMicro', 'previousAutoRecordId']);

/**
 * The identity key of one constituent.
 *
 * `(portfolioId, holdingId)` is the pair every source in this pipeline already
 * publishes and the pair every approved rule is already written against. It is
 * the only key this module uses for coverage, deduplication, the manifest and
 * the gate's reconciliation. The symbol is display text.
 */
export const constituentKey = entry => `${entry.portfolioId}:${entry.holdingId}`;

// The owner's own identity-bound overrides, read from the repository beside this
// module. They are `WU` selections and carry no delegated coefficients, so they
// are matched on the identity they actually record rather than on a fuller
// identity they never claimed.
function ownerOverrides() {
  let file = null;
  try { file = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8')); }
  catch { fail('OVERRIDES_UNREADABLE'); }
  if (!plain(file) || file.schemaVersion !== 1 || file.purpose !== 'risk-measurement-only'
    || !Array.isArray(file.overrides)) fail('OVERRIDES_MISMATCH');
  return file.overrides;
}

function validateConstituent(entry, index) {
  if (!plain(entry)) fail('CONSTITUENT_MALFORMED', `#${index}`);
  const keys = Object.keys(entry).filter(key => !CONSTITUENT_OPTIONAL.includes(key)).sort().join('|');
  // Exact shape. An unrecognized field could carry a claim this module does not
  // check — a tier, an approval, an exemption — and ignoring it would classify
  // more widely than the approved policies allow.
  if (keys !== [...CONSTITUENT].sort().join('|')) fail('CONSTITUENT_FIELDS_UNEXPECTED', String(entry.symbol ?? `#${index}`));
  if (typeof entry.symbol !== 'string' || !entry.symbol.trim()) fail('CONSTITUENT_SYMBOL_REQUIRED', `#${index}`);
  return entry;
}

// One constituent, resolved. Never a guess, never zero, never silent.
function resolveOne(constituent, { rules, overrides, registry, policy, autoPolicyRevision }) {
  const symbol = constituent.symbol.trim().toUpperCase();
  const holdingKey = constituentKey(constituent);
  const identity = {
    key: holdingKey, symbol, custodian: constituent.custodian,
    portfolioId: constituent.portfolioId, holdingId: constituent.holdingId,
    instrumentId: constituent.instrumentId,
  };
  // A deterministic id for an exclusion, so that even a position nothing could
  // classify is still named by a stable machine-readable record instead of
  // disappearing from the manifest.
  const exclusionId = `${AUTO_NAMESPACE}:${autoPolicyRevision}:${
    /^\d{1,18}$/.test(String(constituent.portfolioId)) ? constituent.portfolioId : 'unresolved'}:${
    /^\d{1,18}$/.test(String(constituent.holdingId)) ? constituent.holdingId : symbol}`;
  const excluded = reason => ({ entry: { ...identity, namespace: AUTO_NAMESPACE, recordId: exclusionId,
    status: 'excluded', reason }, record: null, basis: 'excluded', ladder: null });

  // (1) An exact delegated rule. `calculateDelegatedTier` is the only supported
  // reader and does the field-by-field identity proof itself; this module never
  // re-implements that comparison or relaxes it.
  const delegated = rules.find(item => `${item.rule.portfolioId}:${item.rule.holdingId}` === holdingKey);
  if (delegated) {
    let calculated = null;
    try {
      calculated = calculateDelegatedTier({
        symbol: constituent.symbol, portfolioId: constituent.portfolioId, holdingId: constituent.holdingId,
        instrumentId: constituent.instrumentId, currency: constituent.currency,
        marketValueUsd: constituent.marketValueUsd, valueDate: constituent.valueDate,
        // A rule that records more identity than the core five must match those
        // too; supplying only what the rule asks for keeps that exactness.
        ...Object.fromEntries(['custodian', 'venue', 'instrumentName']
          .filter(key => Object.hasOwn(delegated.rule, key))
          .map(key => [key, key === 'venue' ? constituent.venue : delegated.rule[key]])),
      }, { approvalId: delegated.rule.approvalId });
    } catch {
      // The holding reaches an approved rule but is not the instrument that
      // rule approved. It is disclosed by name rather than being stretched onto
      // the approval or quietly handed to the automatic path.
      return excluded(AUTO_EXCLUSION_REASONS.OWNER_RULE_IDENTITY_MISMATCH);
    }
    return { entry: { ...identity, namespace: delegated.rule.approvalId.startsWith('WU-') ? 'WU' : 'DELEG',
      recordId: calculated.approvalId, status: 'classified' }, record: null, basis: 'delegated', calculated,
      ladder: { low: delegated.rule.low, mid: delegated.rule.mid, high: delegated.rule.high },
      tier: delegated.rule.tier };
  }

  // (1b) The owner's own identity-bound override, which records symbol,
  // portfolio and holding and nothing further.
  const override = overrides.find(rule => `${rule.portfolioId}:${rule.holdingId}` === holdingKey);
  if (override) {
    if (String(override.symbol).toUpperCase() !== symbol) {
      return excluded(AUTO_EXCLUSION_REASONS.OWNER_RULE_IDENTITY_MISMATCH);
    }
    return { entry: { ...identity, namespace: 'WU', recordId: override.approvalId, status: 'classified' },
      record: null, basis: 'owner-override',
      ladder: { low: override.low, mid: override.mid, high: override.high }, tier: override.tier };
  }

  // (1c) The transcribed registry of already-published tier assignments, ETF
  // look-through percentages and named exceptions. This is the step that used to
  // exist only as a coefficient retyped into a throwaway assembly script. It is
  // matched on custodian and symbol because that is exactly the granularity the
  // published report itself discloses — `IB-HK GOOG T2` and `Webull GOOG T2` are
  // two rows there and two rules here — and an entry may additionally pin a
  // portfolio, holding or instrument, in which case that binding must match too.
  const registered = registry.lookup(constituent.custodian, symbol);
  if (registered) {
    for (const field of ['portfolioId', 'holdingId', 'instrumentId']) {
      if (Object.hasOwn(registered, field) && registered[field] !== constituent[field]) {
        return excluded(AUTO_EXCLUSION_REASONS.OWNER_RULE_IDENTITY_MISMATCH);
      }
    }
    return { entry: { ...identity, namespace: AI_RISK_NAMESPACE, recordId: registered.recordId,
      status: 'classified' }, record: null, basis: 'registry', ladder: registered.ladder,
      tier: registered.tier, registered };
  }

  // A conservative AUTO classification is a real effective classification,
  // not a one-report placeholder. If the last trusted public page carried its
  // exact record id for this identity, continue it under the same protected
  // policy. It is not emitted as a new notification.
  if (constituent.previousAutoRecordId !== null
    && constituent.previousAutoRecordId !== undefined) {
    let record = null;
    try {
      record = continueAutoClassification({
        symbol: constituent.symbol, venue: constituent.venue,
        portfolioId: constituent.portfolioId, holdingId: constituent.holdingId,
        instrumentId: constituent.instrumentId, currency: constituent.currency,
        assetType: constituent.assetType, marketValueUsd: constituent.marketValueUsd,
        valueDate: constituent.valueDate, identityVerified: constituent.identityVerified,
        firstSeen: constituent.firstSeen,
      }, { policy, previousRecordId: constituent.previousAutoRecordId });
    } catch (error) {
      if (error.name !== 'AutoClassificationException') throw error;
      if (typeof error.reason === 'string'
        && Object.values(AUTO_EXCLUSION_REASONS).includes(error.reason)) {
        return excluded(error.reason);
      }
      fail('PERSISTED_AUTO_RECORD_INVALID', `${symbol}:${error.code}`);
    }
    return { entry: { ...identity, namespace: AUTO_NAMESPACE, recordId: record.classificationId,
      status: 'classified' }, record: null, basis: 'auto-carried',
      ladder: registry.ladderFor(record.tier), tier: record.tier };
  }

  // (2) The automatic policy, for a first-seen ordinary stock only. Everything
  // it refuses arrives here as an enumerated reason, which is the whole point:
  // an exclusion this module cannot name is not an exclusion it may publish.
  try {
    const record = classifyFirstSeenPosition({
      symbol: constituent.symbol, venue: constituent.venue, portfolioId: constituent.portfolioId,
      holdingId: constituent.holdingId, instrumentId: constituent.instrumentId,
      currency: constituent.currency, assetType: constituent.assetType,
      marketValueUsd: constituent.marketValueUsd, valueDate: constituent.valueDate,
      identityVerified: constituent.identityVerified, firstSeen: constituent.firstSeen,
    }, { policy });
    return { entry: { ...identity, namespace: AUTO_NAMESPACE, recordId: record.classificationId,
      status: 'classified' }, record, basis: 'auto',
      ladder: registry.ladderFor(record.tier), tier: record.tier };
  } catch (error) {
    if (error.name !== 'AutoClassificationException') throw error;
    // (3) Fail-visible. A refusal with no enumerated reason would be the exact
    // silent drop this module exists to make impossible, so it is refused here
    // too rather than published as an unexplained exclusion.
    if (typeof error.reason !== 'string' || !Object.values(AUTO_EXCLUSION_REASONS).includes(error.reason)) {
      fail('EXCLUSION_REASON_UNENUMERATED', `${symbol}:${error.code}`);
    }
    return excluded(error.reason);
  }
}

/**
 * Resolve every risk constituent of one run into a complete coverage record.
 *
 * The returned `entries` are the whole universe, in input order, each either
 * `classified` with a `WU`, `DELEG` or `AUTO` record id, or `excluded` with an
 * enumerated reason. There is no third state and nothing is omitted.
 */
export function buildAiTierCoverage(constituents, {
  policy = readAutoClassificationPolicy(),
  registry = readAiRiskRegistry(),
} = {}) {
  if (!Array.isArray(constituents) || constituents.length > 500) fail('CONSTITUENTS_INVALID');
  constituents.forEach(validateConstituent);
  const rules = listDelegatedRules();
  const overrides = ownerOverrides();
  const autoPolicyRevision = policy.policy.policyRevision;
  const resolved = constituents.map(constituent =>
    resolveOne(constituent, { rules, overrides, registry, policy, autoPolicyRevision }));
  const entries = resolved.map(item => item.entry);
  const seen = new Set();
  const byInstrument = new Set();
  for (const entry of entries) {
    // One identity may hold exactly one coverage record. Two disagreeing records
    // for one identity would make the reconciliation below depend on order.
    //
    // Deliberately NOT keyed on the symbol. The risk universe is three accounts
    // wide and a symbol recurs across them legitimately: rejecting the second
    // `GOOG` would have refused to publish a real, correctly identified Webull
    // position — the same "classified but absent from the numerator" outcome
    // this module exists to make impossible, arrived at from the other side.
    if (seen.has(entry.key)) fail('DUPLICATE_CONSTITUENT', entry.key);
    seen.add(entry.key);
    // Instrument identity as the second, independent check. One account holding
    // the same instrument under two holding ids would be counted twice in the
    // numerator while appearing once in the book.
    const instrument = `${entry.portfolioId}/${entry.instrumentId}`;
    if (byInstrument.has(instrument)) fail('DUPLICATE_INSTRUMENT_IN_PORTFOLIO', instrument);
    byInstrument.add(instrument);
  }
  const classified = entries.filter(entry => entry.status === 'classified');
  return {
    schemaVersion: 1,
    policyRevision: autoPolicyRevision,
    registryRevision: registry.policyRevision,
    entries,
    // The resolved ladder beside each entry, in input order, for the calculation
    // module. Kept out of `entries` so the published manifest stays identity and
    // classification only.
    resolved: resolved.map((item, index) => ({ key: entries[index].key, basis: item.basis,
      tier: item.tier ?? null, ladder: item.ladder ?? null })),
    // The records that need a human sentence beside them on the page. Only the
    // automatic path produces one: a `WU` or `DELEG` classification is already
    // disclosed by its own approval record.
    autoRecords: resolved.filter(item => item.basis === 'auto').map(item => item.record),
    // The universe is identities, not tickers. This is the declaration the gate
    // reconciles the manifest against, and it belongs to the AI-risk pane — it
    // is not, and must not be confused with, the IB-only holdings table's own
    // `data-holdings-universe-v1` count.
    universe: entries.map(entry => entry.key),
    universeSymbols: entries.map(entry => entry.symbol),
    coverage: {
      total: entries.length,
      classified: classified.length,
      excluded: entries.length - classified.length,
      numeratorKeys: classified.map(entry => entry.key),
      // The AI-pressure numerator's own membership, stated rather than implied:
      // a classified constituent is in it, an excluded one is out of it and
      // says why. Both stay in the denominator, which is the defect of
      // 2026-09-11 stated as arithmetic.
      numeratorSymbols: classified.map(entry => entry.symbol),
      excludedReasons: Object.fromEntries(entries.filter(entry => entry.status === 'excluded')
        .reduce((counts, entry) => counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1), new Map())),
    },
  };
}

const escape = value => String(value).replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

const EXCLUSION_TEXT = Object.freeze({
  [AUTO_EXCLUSION_REASONS.IDENTITY_UNVERIFIED]: '来源身份未核验',
  [AUTO_EXCLUSION_REASONS.NOT_FIRST_SEEN]: '非首次出现，无既有已批准规则',
  [AUTO_EXCLUSION_REASONS.EXISTING_OWNER_RULE]: '已有 WU／DELEG 规则',
  [AUTO_EXCLUSION_REASONS.ASSET_TYPE_NOT_ORDINARY_STOCK]: '资产类型非普通股',
  [AUTO_EXCLUSION_REASONS.ASSET_TYPE_UNKNOWN]: '资产类型未知或不明确',
  [AUTO_EXCLUSION_REASONS.VALUE_NOT_VERIFIED]: '市值未核验到分',
  [AUTO_EXCLUSION_REASONS.VALUE_DATE_MISSING]: '缺少市值日期',
  [AUTO_EXCLUSION_REASONS.IDENTITY_INCOMPLETE]: '身份字段不完整',
  [AUTO_EXCLUSION_REASONS.OWNER_RULE_IDENTITY_MISMATCH]: '与既有规则身份不一致',
});

/**
 * The page fragments for one coverage result.
 *
 * `template` is the inert machine-readable manifest the publication gate
 * reconciles against the report's own holdings. `disclosures` are the human
 * sentences that belong beside the risk pane. Neither carries an amount, a
 * coefficient or any owner artefact.
 */
export function renderAiTierCoverage(coverage) {
  if (!plain(coverage) || !Array.isArray(coverage.entries)) fail('COVERAGE_INVALID');
  const template = `<template id="${AI_TIER_RECORDS_ID}" type="application/json">`
    + `${JSON.stringify(coverage.entries)}</template>`;
  const auto = coverage.autoRecords.map(renderAutoClassificationRecord).join('');
  const excluded = coverage.entries.filter(entry => entry.status === 'excluded').map(entry => {
    const why = EXCLUSION_TEXT[entry.reason];
    if (why === undefined) fail('EXCLUSION_REASON_UNENUMERATED', entry.symbol);
    // Named, with its reason, and never dressed up as a pending ruling: an
    // excluded constituent is a stated technical exception for this period.
    const text = `${entry.symbol}：${why}（${entry.reason}），本期不计入 AI 压力分子，仍计入分母。`;
    assertNoProvisionalWording(text, `exclusion disclosure for ${entry.symbol}`);
    return `<p data-ai-tier-excluded="${escape(entry.symbol)}" data-ai-tier-reason="${escape(entry.reason)}">`
      + `${escape(text)}</p>`;
  }).join('');
  // The AI-risk pane's own constituent universe, declared independently of the
  // IB-only holdings table. These are two different populations: the holdings
  // table is one custodian's book, the risk universe spans three accounts, and
  // reconciling the manifest against the holdings count was checking the wrong
  // arithmetic — it would have passed a report that silently dropped every
  // Schwab and Webull constituent, and failed a correct one.
  const constituents = coverage.entries.map(entry =>
    `<span data-ai-risk-constituent="${escape(entry.key)}" data-ai-risk-symbol="${escape(entry.symbol)}"`
    + ` data-ai-risk-custodian="${escape(entry.custodian)}"></span>`).join('');
  const summary = `<p data-ai-risk-universe-v1="${coverage.entries.length}"`
    + ` data-ai-tier-coverage-v1="${coverage.coverage.classified}/${coverage.coverage.total}">`
    + `AI 压力口径覆盖：共 ${coverage.coverage.total} 项，已分类 ${coverage.coverage.classified} 项计入分子，`
    + `${coverage.coverage.excluded} 项按列名原因排除但仍在分母内。</p>`;
  return { template, disclosures: `${summary}${constituents}${auto}${excluded}` };
}
