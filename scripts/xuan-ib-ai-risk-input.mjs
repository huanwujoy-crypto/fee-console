#!/usr/bin/env node
// The AI-risk input, derived from the run's own verified sources.
//
// Everything downstream of this file was already arithmetic: the classification
// partition, the coefficients, the numerator, the ratio and the headline tile
// are all computed and all reconciled by the publication gate. The inputs were
// not. `riskConstituents` and `riskDenominator` were two hand-authored JSON
// files, and a scheduled session typed them out once per run — every symbol,
// every portfolio and holding id, every market value, every `firstSeen` boolean
// and all three account totals. A mistyped holding id silently produced a
// different, perfectly self-consistent report; a forgotten position simply did
// not exist in the numerator while its account total kept it in the
// denominator, which is the 2026-09-11 defect arriving through the one door
// still left open.
//
// This module closes that door. It takes the three accounts' already-validated
// `normalizeSharesightReport` output — IB-HK, Schwab-HK and Webull, from the
// same run — plus the previous trusted public page, and derives both inputs:
//
//   * every risk constituent, with its identity taken from the source row
//     rather than retyped, its market value taken from the same reconciled
//     micro-units the report value was checked against, and its `firstSeen`
//     DERIVED from whether that identity appears in the previous trusted
//     manifest rather than asserted by a caller;
//   * the denominator, as the three reports' own reconciled report values,
//     each bound to its account by a stable component key.
//
// It deliberately reuses nothing of the four-bucket classification: no bucket,
// no liquidity label, no cash-identity registry. The only source field it
// interprets is the security type the normalizer already preserved verbatim,
// and it maps that strictly — ordinary stock, ETF, or a named other type. An
// unmapped type is fail-visible: named in the envelope's diagnostics and
// carried downstream as an asset type that can never be read as ordinary stock,
// so the position is excluded with an enumerated reason instead of being
// guessed into a tier.
//
// Cash enters the denominator and nothing else. A cash account is never a risk
// constituent: it has no AI exposure, and inventing one for it would put the
// account's cash into the numerator.
//
// Pure: no network, no financial account, no clock beyond what its inputs
// already carry, no repository write except the output file the CLI is asked
// for. It never places, modifies or cancels anything.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from './xuan-ib-run-manifest.mjs';
import { readAiRiskAccounts } from './xuan-ib-ai-coefficient-resolver.mjs';
import {
  CENT_MICRO, LISTING_SOURCE, normalizeSharesightReport,
} from './xuan-ib-four-bucket.mjs';

export const AI_RISK_INPUT_KIND = 'xuan-ib-ai-risk-input:v1';
const AI_TIER_RECORDS_ID = 'xuan-ib-ai-tier-records-v1';

const plain = value => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;
const MICRO_STRING = /^-?(?:0|[1-9]\d*)$/;

export class AiRiskInputException extends Error {
  constructor(code, detail = null) {
    super(`AI risk input: ${code}${detail === null ? '' : ` (${detail})`}`);
    this.name = 'AiRiskInputException';
    this.code = code;
    this.owner = 'Codex';
    this.requiresOwnerDecision = false;
    this.createsAwaitingUser = false;
  }
}
const fail = (code, detail = null) => { throw new AiRiskInputException(code, detail); };

// ---------------------------------------------------------------------------
// Asset type.
//
// The normalizer preserves `sourceSecurityType` verbatim and never interprets
// it. Here it is mapped strictly onto the vocabulary the approved automatic
// classification policy already uses, so an ETF can never acquire a
// single-stock tier and an unrecognized spelling can never be rounded towards
// "probably a stock".
//
// `UNMAPPED-SECURITY-TYPE` is deliberately not a valid asset type anywhere: it
// appears in neither the policy's ordinary-stock list nor its excluded list, so
// the automatic classifier refuses it with the enumerated reason
// `asset-type-unknown-or-ambiguous` and the position is disclosed by name and
// kept in the denominator. Adding a spelling to this table is an ordinary,
// reviewable change; guessing at one in a run is not.
// ---------------------------------------------------------------------------
export const UNMAPPED_ASSET_TYPE = 'UNMAPPED_SECURITY_TYPE';
export const SOURCE_SECURITY_TYPES = Object.freeze({
  // Ordinary stock.
  STK: 'STK',
  STOCK: 'STK',
  STOCKS: 'STK',
  EQUITY: 'STK',
  EQUITIES: 'STK',
  SHARE: 'STK',
  SHARES: 'STK',
  COMMON_STOCK: 'STK',
  COMMON_STOCKS: 'STK',
  ORDINARY_SHARE: 'STK',
  ORDINARY_SHARES: 'STK',
  ORD: 'STK',
  // Exchange traded funds, which never take a single-stock tier here: the
  // approved registry records a look-through percentage for the ones it covers.
  ETF: 'ETF',
  ETFS: 'ETF',
  EXCHANGE_TRADED_FUND: 'ETF',
  EXCHANGE_TRADED_FUNDS: 'ETF',
  ETP: 'ETF',
  // Known other types. Each is refused by name rather than by failing to match.
  FUND: 'FUND',
  FUNDS: 'FUND',
  MANAGED_FUND: 'FUND',
  MUTUAL_FUND: 'MUTUAL_FUND',
  UNIT_TRUST: 'FUND',
  BOND: 'BOND',
  BONDS: 'BOND',
  FIXED_INTEREST: 'BOND',
  CASH: 'CASH',
  COMMODITY: 'COMMODITY',
  CRYPTO: 'CRYPTO',
  CRYPTOCURRENCY: 'CRYPTO',
  OPTION: 'OPT',
  OPT: 'OPT',
  FUTURE: 'FUT',
  FUT: 'FUT',
  WARRANT: 'WAR',
  WAR: 'WAR',
  RIGHT: 'RIGHT',
  RIGHTS: 'RIGHT',
  INDEX: 'IND',
  IND: 'IND',
});

const normalizeSourceType = value => {
  if (typeof value !== 'string') return null;
  const token = value.normalize('NFC').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return /^[A-Z][A-Z0-9_]{0,47}$/.test(token) ? token : null;
};

/** One source security type, strictly mapped, or the fail-visible marker. */
export function mapSourceSecurityType(value) {
  const token = normalizeSourceType(value);
  if (token === null) return { assetType: UNMAPPED_ASSET_TYPE, mapped: false, sourceToken: null };
  const mapped = Object.hasOwn(SOURCE_SECURITY_TYPES, token) ? SOURCE_SECURITY_TYPES[token] : null;
  return mapped === null
    ? { assetType: UNMAPPED_ASSET_TYPE, mapped: false, sourceToken: token }
    : { assetType: mapped, mapped: true, sourceToken: token };
}

// ---------------------------------------------------------------------------
// The previous trusted page's own published risk universe.
//
// `firstSeen` is never a caller's boolean. It is the answer to one question —
// does this identity already appear on the page the public last saw — and the
// only evidence for it is that page's own machine-readable records.
// ---------------------------------------------------------------------------
const AUTO_RECORD_ID = /^AUTO:AUTO-\d{8}-[A-Z0-9]{1,16}-T[1-9]-R\d{1,3}:(\d{1,18}):(\d{1,18})$/;

export function publishedRiskUniverse(previousPageHtml) {
  const keys = new Set();
  const autoByKey = new Map();
  if (previousPageHtml === null || previousPageHtml === undefined) {
    return { status: 'absent', keys, autoByKey };
  }
  if (typeof previousPageHtml !== 'string') fail('PREVIOUS_PAGE_INVALID');
  // An AUTO record id is itself the policy revision, the portfolio and the
  // holding, so the attribute form of a record still names an identity.
  for (const match of previousPageHtml.matchAll(
    /<[a-z][^<>]*\bdata-ai-tier-record\s*=\s*(["'])(.*?)\1[^<>]*>/gi)) {
    const parts = AUTO_RECORD_ID.exec(match[2].trim());
    if (parts) {
      const key = `${parts[1]}:${parts[2]}`;
      keys.add(key);
      autoByKey.set(key, match[2].trim());
    }
  }
  const template = previousPageHtml.match(new RegExp(
    `<template id="${AI_TIER_RECORDS_ID}" type="application/json">([\\s\\S]*?)</template>`, 'i'));
  if (!template) {
    // A page published before the manifest existed carries no identities at all.
    // That is stated rather than silently treated as "nothing was ever held":
    // under it every position is first-seen, which classifies conservatively
    // (into the numerator) rather than dropping anything out of it.
    return { status: keys.size ? 'attributes-only' : 'absent', keys, autoByKey };
  }
  let entries = null;
  // A manifest this run cannot parse is not evidence that nothing was published.
  // Treating it as empty would call every position first-seen on the strength of
  // a parse failure, so it is refused instead.
  try { entries = JSON.parse(template[1]); } catch { fail('PREVIOUS_RECORDS_UNREADABLE'); }
  if (!Array.isArray(entries)) fail('PREVIOUS_RECORDS_UNREADABLE');
  for (const entry of entries) {
    if (!plain(entry) || typeof entry.key !== 'string' || !entry.key.trim()) fail('PREVIOUS_RECORDS_UNREADABLE');
    const key = entry.key.trim();
    keys.add(key);
    // An exclusion deliberately carries a stable AUTO-shaped technical id, but
    // it is not an AUTO classification and must never be continued as one.
    if (entry.status === 'classified' && entry.namespace === 'AUTO'
      && typeof entry.recordId === 'string' && AUTO_RECORD_ID.test(entry.recordId)) {
      const current = autoByKey.get(key);
      if (current !== undefined && current !== entry.recordId) fail('PREVIOUS_AUTO_RECORD_AMBIGUOUS', key);
      autoByKey.set(key, entry.recordId);
    }
  }
  return { status: 'present', keys, autoByKey };
}

// ---------------------------------------------------------------------------
// Report validation.
//
// The reports arrive as the normalizer's own output. They are re-verified here
// rather than trusted: the envelope is a file on disk by the time `prepareReport`
// reads it, and a reconciliation nobody re-checked is a reconciliation that can
// be edited. This is drift detection against the values the normalizer wrote,
// not an independent attestation that a connector was really called.
// ---------------------------------------------------------------------------
const REPORT_KEYS = Object.freeze(['schemaVersion', 'portfolioId', 'portfolioName', 'reportCutoffDate',
  'readStartedAt', 'readCompletedAt', 'reportParameters', 'reportValueMicro', 'holdings', 'cashAccounts',
  'listingOnlyHoldingIds', 'listing', 'reconciliation', 'sourceFingerprint', 'sourceBytes']);

const microOf = (value, where) => {
  if (typeof value !== 'string' || !MICRO_STRING.test(value)) fail('MICRO_VALUE_INVALID', where);
  return BigInt(value);
};

function validateReport(report, account) {
  if (!plain(report)) fail('REPORT_MALFORMED', account.custodian);
  for (const key of REPORT_KEYS) {
    if (!Object.hasOwn(report, key)) fail('REPORT_FIELD_MISSING', `${account.custodian}.${key}`);
  }
  if (report.schemaVersion !== 1) fail('REPORT_VERSION', account.custodian);
  if (String(report.portfolioId) !== account.portfolioId) {
    fail('REPORT_PORTFOLIO_MISMATCH', `${account.custodian}:${report.portfolioId}`);
  }
  if (report.portfolioName !== account.custodian) {
    fail('REPORT_PORTFOLIO_NAME_MISMATCH', `${account.custodian}:${report.portfolioName}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(report.reportCutoffDate))) fail('REPORT_CUTOFF_INVALID', account.custodian);
  if (!Array.isArray(report.holdings) || !Array.isArray(report.cashAccounts)) fail('REPORT_ROWS_INVALID', account.custodian);
  if (!plain(report.reconciliation) || report.reconciliation.withinTolerance !== true) {
    fail('REPORT_NOT_RECONCILED', account.custodian);
  }
  // The reconciliation, recomputed. A report whose declared sum no longer
  // follows from its own rows cannot supply either a denominator component or a
  // set of market values.
  const holdingsMicro = report.holdings.reduce((total, row) =>
    total + microOf(row?.valueMicro, `${account.custodian}.holding`), 0n);
  const sumMicro = report.cashAccounts.reduce((total, row) =>
    total + microOf(row?.valueMicro, `${account.custodian}.cash`), holdingsMicro);
  const reportValueMicro = microOf(report.reportValueMicro, `${account.custodian}.reportValue`);
  if (microOf(report.reconciliation.sumMicro, `${account.custodian}.reconciliation.sum`) !== sumMicro
    || microOf(report.reconciliation.reportValueMicro, `${account.custodian}.reconciliation.value`) !== reportValueMicro) {
    fail('REPORT_RECONCILIATION_TAMPERED', account.custodian);
  }
  const difference = sumMicro - reportValueMicro;
  const magnitude = difference < 0n ? -difference : difference;
  const tolerance = CENT_MICRO * BigInt(report.holdings.length + report.cashAccounts.length + 1);
  if (magnitude > tolerance) fail('REPORT_RECONCILIATION_OUT_OF_TOLERANCE', account.custodian);
  if (microOf(report.reconciliation.differenceMicro, `${account.custodian}.reconciliation.difference`) !== difference) {
    fail('REPORT_RECONCILIATION_TAMPERED', account.custodian);
  }
  if (reportValueMicro <= 0n) fail('REPORT_VALUE_NOT_POSITIVE', account.custodian);
  return { reportValueMicro, sumMicro };
}

// Exact USD from micro-units, to the cent. A source value carrying a fraction of
// a cent is refused rather than rounded: the whole downstream calculation is
// defined on verified cent amounts, and quietly rounding here would make the
// published contribution disagree with the source it claims to come from.
function usdFromMicro(micro, where) {
  if (micro < 0n) fail('VALUE_NEGATIVE', where);
  if (micro % CENT_MICRO !== 0n) fail('VALUE_NOT_WHOLE_CENTS', where);
  const cents = micro / CENT_MICRO;
  const whole = cents / 100n;
  const fraction = cents % 100n;
  if (whole > 1_000_000_000_000n) fail('VALUE_OUT_OF_RANGE', where);
  return Number(`${whole}.${String(fraction).padStart(2, '0')}`);
}

/**
 * Build one run's complete AI-risk input from its own verified sources.
 *
 * `reports` is an array of `normalizeSharesightReport` results — exactly one
 * for each of IB-HK, Schwab-HK and Webull, all from the same run.
 * `previousTrustedHtml` is the trusted previous published page, and is the only
 * evidence used to decide `firstSeen`.
 */
export function buildAiRiskInput({ reports, previousTrustedHtml = null, registry = null } = {}) {
  if (!Array.isArray(reports)) fail('REPORTS_INVALID');
  const accounts = readAiRiskAccounts({ registry });
  if (reports.length !== accounts.length) {
    fail('ACCOUNT_SET_INCOMPLETE', `expected ${accounts.length} reports, received ${reports.length}`);
  }
  const byPortfolio = new Map();
  for (const report of reports) {
    const id = String(plain(report) ? report.portfolioId : '');
    if (byPortfolio.has(id)) fail('ACCOUNT_DUPLICATE_REPORT', id);
    byPortfolio.set(id, report);
  }
  for (const account of accounts) {
    if (!byPortfolio.has(account.portfolioId)) fail('ACCOUNT_MISSING_REPORT', account.custodian);
  }

  const previous = publishedRiskUniverse(previousTrustedHtml);
  const riskConstituents = [];
  const components = [];
  const diagnostics = { unmappedSecurityTypes: [], cashAccountRows: 0, holdingRows: 0 };
  const provenance = [];
  const instrumentSeen = new Set();

  for (const account of accounts) {
    const report = byPortfolio.get(account.portfolioId);
    const { reportValueMicro } = validateReport(report, account);
    diagnostics.cashAccountRows += report.cashAccounts.length;
    diagnostics.holdingRows += report.holdings.length;
    // Cash is in the denominator and nowhere else. It carries no AI exposure,
    // and a cash row promoted into the constituent universe would put the
    // account's cash balance into the numerator.
    components.push({ key: account.key, label: account.custodian,
      valueMicro: String(reportValueMicro),
      valueUsd: usdFromMicro(reportValueMicro, `${account.custodian}.reportValue`) });
    provenance.push({ key: account.key, custodian: account.custodian, portfolioId: account.portfolioId,
      reportCutoffDate: report.reportCutoffDate, readStartedAt: report.readStartedAt,
      readCompletedAt: report.readCompletedAt, sourceFingerprint: report.sourceFingerprint,
      holdingRows: report.holdings.length, cashAccountRows: report.cashAccounts.length });

    for (const row of report.holdings) {
      if (!plain(row)) fail('HOLDING_ROW_INVALID', account.custodian);
      const holdingId = String(row.holdingId ?? '');
      const where = `${account.custodian}:${holdingId || '?'}`;
      if (!/^\d{1,18}$/.test(holdingId)) fail('HOLDING_IDENTITY_INCOMPLETE', where);
      // A constituent with no symbol cannot be looked up in any approved rule,
      // and silently dropping it is the understatement this whole repair
      // exists to prevent. It is named and refused instead.
      if (typeof row.symbol !== 'string' || !row.symbol.trim()) fail('HOLDING_SYMBOL_MISSING', where);
      const instrumentId = row.instrumentId === null || row.instrumentId === undefined
        ? null : String(row.instrumentId);
      if (instrumentId === null || !/^\d{1,18}$/.test(instrumentId)) fail('HOLDING_INSTRUMENT_MISSING', where);
      const instrument = `${account.portfolioId}/${instrumentId}`;
      if (instrumentSeen.has(instrument)) fail('HOLDING_INSTRUMENT_DUPLICATE', instrument);
      instrumentSeen.add(instrument);
      if (typeof row.venue !== 'string' || !row.venue.trim()) fail('HOLDING_VENUE_MISSING', where);
      if (typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency)) fail('HOLDING_CURRENCY_MISSING', where);
      const type = mapSourceSecurityType(row.sourceSecurityType);
      if (!type.mapped) {
        diagnostics.unmappedSecurityTypes.push({ custodian: account.custodian, symbol: row.symbol.trim(),
          portfolioId: account.portfolioId, holdingId, sourceSecurityType: row.sourceSecurityType ?? null });
      }
      const key = `${account.portfolioId}:${holdingId}`;
      riskConstituents.push({
        symbol: row.symbol.trim(),
        custodian: account.custodian,
        venue: row.venue.trim(),
        portfolioId: account.portfolioId,
        holdingId,
        instrumentId,
        currency: row.currency,
        assetType: type.assetType,
        marketValueMicro: String(microOf(row.valueMicro, where)),
        marketValueUsd: usdFromMicro(microOf(row.valueMicro, where), where),
        valueDate: report.reportCutoffDate,
        // Only a row that came through the validated normalizer reaches this
        // line, and this module never accepts the flag from a caller.
        identityVerified: true,
        // Derived, never asserted: an identity the previous trusted page
        // already published is not first-seen.
        firstSeen: !previous.keys.has(key),
        previousAutoRecordId: previous.autoByKey.get(key) ?? null,
      });
    }
  }
  if (!riskConstituents.length) fail('NO_RISK_CONSTITUENTS');

  const envelope = {
    schemaVersion: 1,
    kind: AI_RISK_INPUT_KIND,
    generatedFrom: 'normalizeSharesightReport',
    accounts: accounts.map(account => ({ key: account.key, custodian: account.custodian,
      portfolioId: account.portfolioId, role: account.role })),
    previousManifest: { status: previous.status, publishedIdentities: previous.keys.size },
    diagnostics,
    provenance,
    riskConstituents,
    riskDenominator: { components },
  };
  // Drift detection over everything a consumer will act on, so a hand-edited
  // envelope is refused at `prepareReport` rather than silently published. It is
  // a hash of this module's own output, not proof that a connector was called.
  envelope.bindingFingerprint = fingerprint({
    kind: envelope.kind, accounts: envelope.accounts, previousManifest: envelope.previousManifest,
    provenance: envelope.provenance, riskConstituents, riskDenominator: envelope.riskDenominator,
  });
  return envelope;
}

const ENVELOPE_KEYS = Object.freeze(['schemaVersion', 'kind', 'generatedFrom', 'accounts',
  'previousManifest', 'diagnostics', 'provenance', 'riskConstituents', 'riskDenominator',
  'bindingFingerprint']);

/**
 * Validate one envelope and return the two inputs the assembly path consumes.
 *
 * This is the only supported way to turn a risk-input file into constituents
 * and a denominator: it re-checks the shape, re-checks the identity keys and
 * re-computes the binding fingerprint before anything downstream sees a value.
 */
export function readAiRiskInput(envelope) {
  if (!plain(envelope)) fail('ENVELOPE_MALFORMED');
  const keys = Object.keys(envelope).sort().join('|');
  if (keys !== [...ENVELOPE_KEYS].sort().join('|')) fail('ENVELOPE_FIELDS_UNEXPECTED');
  if (envelope.schemaVersion !== 1 || envelope.kind !== AI_RISK_INPUT_KIND
    || envelope.generatedFrom !== 'normalizeSharesightReport') fail('ENVELOPE_KIND_MISMATCH');
  if (!Array.isArray(envelope.riskConstituents) || !envelope.riskConstituents.length) fail('ENVELOPE_CONSTITUENTS_INVALID');
  if (!Array.isArray(envelope.accounts) || !Array.isArray(envelope.provenance)
    || envelope.accounts.length !== 3 || envelope.provenance.length !== 3) fail('ENVELOPE_ACCOUNT_SET_INVALID');
  if (!plain(envelope.riskDenominator) || !Array.isArray(envelope.riskDenominator.components)) {
    fail('ENVELOPE_DENOMINATOR_INVALID');
  }
  const expected = fingerprint({
    kind: envelope.kind, accounts: envelope.accounts, previousManifest: envelope.previousManifest,
    provenance: envelope.provenance, riskConstituents: envelope.riskConstituents,
    riskDenominator: envelope.riskDenominator,
  });
  if (expected !== envelope.bindingFingerprint) fail('ENVELOPE_FINGERPRINT_MISMATCH');
  const approved = readAiRiskAccounts();
  if (JSON.stringify(envelope.accounts) !== JSON.stringify(approved)) fail('ENVELOPE_ACCOUNT_SET_INVALID');
  const accountByPortfolio = new Map(approved.map(account => [account.portfolioId, account]));
  const provenanceIds = envelope.provenance.map(source => String(source?.portfolioId ?? ''));
  if (new Set(provenanceIds).size !== approved.length
    || approved.some(account => !provenanceIds.includes(account.portfolioId))) {
    fail('ENVELOPE_PROVENANCE_SCOPE_INVALID');
  }
  const componentKeys = envelope.riskDenominator.components.map(component => component?.key);
  if (new Set(componentKeys).size !== approved.length
    || approved.some(account => !componentKeys.includes(account.key))) {
    fail('ENVELOPE_DENOMINATOR_SCOPE_INVALID');
  }
  const seen = new Set();
  for (const constituent of envelope.riskConstituents) {
    if (!plain(constituent)) fail('ENVELOPE_CONSTITUENTS_INVALID');
    // `identityVerified` and `firstSeen` are this module's own derivations. An
    // envelope that carries them as anything other than real booleans, or that
    // claims a verified identity it did not derive, is refused rather than
    // trusted: they are exactly the two fields a hand-authored file used to set.
    if (typeof constituent.identityVerified !== 'boolean' || typeof constituent.firstSeen !== 'boolean') {
      fail('ENVELOPE_CONSTITUENTS_INVALID', String(constituent.symbol ?? '?'));
    }
    if (constituent.previousAutoRecordId !== null
      && (typeof constituent.previousAutoRecordId !== 'string'
        || !AUTO_RECORD_ID.test(constituent.previousAutoRecordId))) {
      fail('ENVELOPE_PREVIOUS_AUTO_INVALID', String(constituent.symbol ?? '?'));
    }
    const account = accountByPortfolio.get(String(constituent.portfolioId));
    if (!account || account.custodian !== constituent.custodian) {
      fail('ENVELOPE_CONSTITUENT_SCOPE_INVALID', String(constituent.symbol ?? '?'));
    }
    const key = `${constituent.portfolioId}:${constituent.holdingId}`;
    if (seen.has(key)) fail('ENVELOPE_DUPLICATE_CONSTITUENT', key);
    seen.add(key);
  }
  return { riskConstituents: envelope.riskConstituents, riskDenominator: envelope.riskDenominator,
    previousManifest: envelope.previousManifest, diagnostics: envelope.diagnostics };
}

/**
 * Bind a risk-input envelope back to the exact source evidence and previous
 * public manifest that report preparation is already validating.
 */
export function readBoundAiRiskInput(envelope, { previousTrustedHtml, evidence } = {}) {
  const result = readAiRiskInput(envelope);
  const previous = publishedRiskUniverse(previousTrustedHtml);
  for (const constituent of result.riskConstituents) {
    const key = `${constituent.portfolioId}:${constituent.holdingId}`;
    if (constituent.firstSeen !== !previous.keys.has(key)
      || (constituent.previousAutoRecordId ?? null) !== (previous.autoByKey.get(key) ?? null)) {
      fail('ENVELOPE_PREVIOUS_MANIFEST_MISMATCH', key);
    }
  }
  if (!plain(evidence?.sources) || !Array.isArray(evidence.sources.sharesight)) {
    fail('SOURCE_EVIDENCE_REQUIRED');
  }
  const sourceByPortfolio = new Map(evidence.sources.sharesight.map(source =>
    [String(source?.portfolioId ?? ''), source]));
  for (const source of envelope.provenance) {
    const receipt = sourceByPortfolio.get(String(source.portfolioId));
    if (!receipt || receipt.status !== 'ok' || receipt.fingerprint !== source.sourceFingerprint
      || receipt.asOf !== source.readCompletedAt) {
      fail('ENVELOPE_SOURCE_EVIDENCE_MISMATCH', String(source.portfolioId));
    }
  }
  return result;
}

/** Normalize the three approved reports directly from one immutable full-live
 * capture. The performance report's own row identities are used as the listing
 * for this risk-only derivation; completeness is independently constrained by
 * the report-value reconciliation and pagination checks. */
export function buildAiRiskInputFromCapture(input, {
  previousTrustedHtml = null, registry = null,
} = {}) {
  if (!plain(input) || !Array.isArray(input.sharesight)) fail('CAPTURE_INPUT_INVALID');
  const accounts = readAiRiskAccounts({ registry });
  const wanted = new Set(accounts.map(account => account.portfolioId));
  const selected = input.sharesight.filter(receipt => {
    const id = receipt?.raw?.result?.portfolio?.id;
    return wanted.has(String(id));
  });
  if (selected.length !== accounts.length) fail('ACCOUNT_SET_INCOMPLETE');
  const reports = selected.map(receipt => {
    if (!plain(receipt) || receipt.status !== 'ok' || typeof receipt.startedAt !== 'string'
      || typeof receipt.completedAt !== 'string' || !plain(receipt.raw)) fail('CAPTURE_RECEIPT_INVALID');
    if (receipt.rawFingerprint !== fingerprint(receipt.raw)) fail('CAPTURE_RECEIPT_FINGERPRINT_MISMATCH');
    const portfolioId = receipt.raw.result.portfolio.id;
    const rows = receipt.raw?.result?.data?.report?.holdings;
    if (!Array.isArray(rows)) fail('CAPTURE_REPORT_INVALID', String(portfolioId));
    const holdingIds = rows.map(row => row?.holding_id ?? row?.id);
    return normalizeSharesightReport(receipt.raw, {
      registry, portfolioId, readStartedAt: receipt.startedAt,
      readCompletedAt: receipt.completedAt,
      portfolioRoles: ['family', 'ai_only'],
      listing: { source: LISTING_SOURCE, portfolioId,
        readCompletedAt: receipt.completedAt, holdingIds },
    });
  });
  return buildAiRiskInput({ reports, previousTrustedHtml, registry });
}

// ---------------------------------------------------------------------------
// The production entry point.
//
// One command, three normalized report files and the trusted previous page, in;
// one risk-input envelope, out. There is no supported way to hand-write the two
// halves separately for an ordinary scheduled edition.
// ---------------------------------------------------------------------------
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (file, maxBytes = 16 * 1024 * 1024) => {
  if (fs.statSync(file).size > maxBytes) fail('INPUT_TOO_LARGE', file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

export function runAiRiskInputCli(args, { cwd = root } = {}) {
  if (!['build', 'build-from-capture'].includes(args[0])) {
    fail('USAGE', 'build-from-capture --input FILE [--previous-html FILE] --output FILE');
  }
  const reports = [];
  let capturePath = null;
  let previousHtmlPath = null;
  let output = null;
  for (let index = 1; index < args.length; index += 2) {
    const value = args[index + 1];
    if (typeof value !== 'string' || !value) fail('USAGE', args[index]);
    if (args[index] === '--report') reports.push(value);
    else if (args[index] === '--input') {
      if (capturePath !== null) fail('USAGE', 'duplicate --input');
      capturePath = value;
    }
    else if (args[index] === '--previous-html') {
      if (previousHtmlPath !== null) fail('USAGE', 'duplicate --previous-html');
      previousHtmlPath = value;
    } else if (args[index] === '--output') {
      if (output !== null) fail('USAGE', 'duplicate --output');
      output = value;
    } else fail('USAGE', args[index]);
  }
  if (!output) fail('USAGE', 'an output path is required');
  if (args[0] === 'build-from-capture') {
    if (capturePath === null || reports.length) fail('USAGE', 'build-from-capture requires one --input and no --report');
  } else if (capturePath !== null || reports.length !== 3) {
    fail('USAGE', 'build requires exactly three --report files and no --input');
  }
  const resolved = path.resolve(cwd, output);
  // The envelope is an intermediate run artefact. It is never a report
  // candidate, a published page or any part of the trusted pair.
  if (!resolved.endsWith('.json') || resolved.startsWith(path.join(cwd, 'xuan-ib'))
    || resolved === path.join(cwd, 'data.json')) fail('OUTPUT_PATH_REFUSED', output);
  if (fs.existsSync(resolved)) fail('OUTPUT_EXISTS', output);
  // The previous trusted page defaults to the one in this checkout, which is
  // the same page the candidate is built against.
  const previousTrustedHtml = fs.readFileSync(
    previousHtmlPath === null ? path.join(cwd, 'xuan-ib/latest.html') : previousHtmlPath, 'utf8');
  const registry = JSON.parse(fs.readFileSync(path.join(cwd, 'claude/xuan-ib-portfolio-registry.json'), 'utf8'));
  const envelope = args[0] === 'build-from-capture'
    ? buildAiRiskInputFromCapture(readJson(path.resolve(cwd, capturePath)), {
      previousTrustedHtml, registry,
    })
    : buildAiRiskInput({
      reports: reports.map(file => readJson(path.resolve(cwd, file))), previousTrustedHtml, registry,
    });
  fs.writeFileSync(resolved, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  // Counts, identities and status only: never an amount.
  return {
    status: 'risk-input-built',
    accounts: envelope.accounts.map(account => account.key),
    constituents: envelope.riskConstituents.length,
    firstSeen: envelope.riskConstituents.filter(item => item.firstSeen).length,
    previousManifest: envelope.previousManifest,
    unmappedSecurityTypes: envelope.diagnostics.unmappedSecurityTypes.length,
    bindingFingerprint: envelope.bindingFingerprint,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(runAiRiskInputCli(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`${error.code ?? error.message}\n`); process.exitCode = 1; }
}
