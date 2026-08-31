import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUCKETS = ['highly_liquid', 'vc_pe', 'hedge_fund', 'evergreen'];
const PORTFOLIO_RULES = ['all', 'all_non_cash', 'all_non_cash_except_holding_overrides'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => Number.isSafeInteger(value) && value > 0;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const normalizeName = value => value.normalize('NFC').trim().toLowerCase();
const increment = (map, key) => { map[key] = (map[key] ?? 0) + 1; };

/** Normalized input contract (normalization itself is outside this module):
 * holding: { portfolioId, holdingId, name, isCash, assetClass,
 *            recordType?: 'holding', pendingRedemption?: boolean }
 * cash:    { portfolioId, cashAccountId, name, isCash: true, assetClass,
 *            recordType: 'cash_account' }
 * IDs are positive safe integers; assetClass is one exact source label.
 * Cash identity must come from explicit source types, never the display name.
 * scope: { portfolioIds: [positive IDs], complete: boolean }
 * Scope and completeness must be justified by the caller's account registry,
 * pagination and reconciliation evidence. Counts below are row counts, not
 * market values; this audit does not calculate or publish financial totals.
 */

/** Validate approved rules before classifying any row. Duplicates are errors,
 * even when their buckets agree: array order must not change the result. */
export function validateClassificationMapping(mapping) {
  const errors = [];
  if (!object(mapping)) return ['mapping must be an object'];
  if (mapping.schemaVersion !== 1) errors.push('unsupported mapping schemaVersion');
  if (!nonempty(mapping.approvedBy)) errors.push('missing approvedBy');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mapping.effectiveDate ?? '') ||
      Number.isNaN(Date.parse(mapping.effectiveDate)) ||
      new Date(mapping.effectiveDate).toISOString().slice(0, 10) !== mapping.effectiveDate) errors.push('invalid effectiveDate');
  if (mapping.classificationBasis !== 'investment vehicle liquidity, not underlying asset exposure') errors.push('unsupported classificationBasis');
  if (!Array.isArray(mapping.buckets) || mapping.buckets.length !== BUCKETS.length ||
      new Set(mapping.buckets).size !== BUCKETS.length || mapping.buckets.some(bucket => !BUCKETS.includes(bucket))) errors.push('invalid buckets');
  if (!object(mapping.cashRule) || mapping.cashRule.match !== 'cash holding or cash account' || mapping.cashRule.bucket !== 'highly_liquid') errors.push('unsupported cashRule');
  if (!object(mapping.defaultAssetClassRules) ||
      Object.keys(mapping.defaultAssetClassRules).some(label => !['Highly Liquid', 'Illiquid'].includes(label)) ||
      mapping.defaultAssetClassRules['Highly Liquid'] !== 'highly_liquid' || mapping.defaultAssetClassRules.Illiquid !== 'vc_pe') errors.push('unsupported defaultAssetClassRules');
  if (mapping.matchingPolicy?.primaryKey !== 'portfolioId + holdingId' || mapping.matchingPolicy?.secondaryCheck !== 'nameContains') errors.push('unsupported matchingPolicy');
  if (mapping.matchingPolicy?.unknownSemiLiquid !== 'fail item classification and use the approved dated Monday snapshot fallback; do not guess') errors.push('unsupported unknownSemiLiquid policy');
  if (mapping.pendingRedemptionRule?.classification !== 'keep in original bucket until redemption completes' ||
      mapping.pendingRedemptionRule?.evergreenNet !== 'subtract pending redemption amount from evergreen gross for coverage display only' ||
      mapping.pendingRedemptionRule?.doNot !== 'do not move pending redemption to highly_liquid before cash is received') errors.push('unsupported pendingRedemptionRule');
  const overrides = new Set();
  if (!Array.isArray(mapping.holdingOverrides)) errors.push('holdingOverrides must be an array');
  else mapping.holdingOverrides.forEach((rule, index) => {
    if (!object(rule) || !id(rule.portfolioId) || !id(rule.holdingId) || !nonempty(rule.nameContains) || !BUCKETS.includes(rule.bucket)) {
      errors.push(`invalid holdingOverrides[${index}]`);
      return;
    }
    const key = `${rule.portfolioId}:${rule.holdingId}`;
    if (overrides.has(key)) errors.push(`duplicate holding override ${key}`);
    overrides.add(key);
  });
  const portfolios = new Set();
  if (!Array.isArray(mapping.portfolioRules)) errors.push('portfolioRules must be an array');
  else mapping.portfolioRules.forEach((rule, index) => {
    if (!object(rule) || !id(rule.portfolioId) || !PORTFOLIO_RULES.includes(rule.rule) || !BUCKETS.includes(rule.bucket)) {
      errors.push(`invalid portfolioRules[${index}]`);
      return;
    }
    if (portfolios.has(rule.portfolioId)) errors.push(`duplicate portfolio rule ${rule.portfolioId}`);
    portfolios.add(rule.portfolioId);
  });
  return errors;
}

function rowKey(holding) {
  if (!object(holding) || !id(holding.portfolioId)) return null;
  if (holding.recordType === 'cash_account') return id(holding.cashAccountId) ? `${holding.portfolioId}:cash:${holding.cashAccountId}` : null;
  return id(holding.holdingId) ? `${holding.portfolioId}:holding:${holding.holdingId}` : null;
}

function rowErrors(holding) {
  if (!object(holding)) return ['holding must be an object'];
  const errors = [];
  if (!id(holding.portfolioId)) errors.push('portfolioId must be a positive safe integer');
  if (!['holding', 'cash_account', undefined].includes(holding.recordType)) errors.push('unsupported recordType');
  if (holding.recordType === 'cash_account') {
    if (!id(holding.cashAccountId) || holding.holdingId !== undefined) errors.push('cash account requires cashAccountId and no holdingId');
    if (holding.isCash !== true) errors.push('cash account must explicitly set isCash=true');
  } else if (!id(holding.holdingId) || holding.cashAccountId !== undefined) errors.push('holding requires holdingId and no cashAccountId');
  if (!nonempty(holding.name)) errors.push('missing holding name');
  if (typeof holding.isCash !== 'boolean') errors.push('isCash must be an explicit boolean, never inferred from a name');
  if (!nonempty(holding.assetClass)) errors.push('assetClass must be one explicit source label');
  if (holding.pendingRedemption !== undefined && typeof holding.pendingRedemption !== 'boolean') errors.push('pendingRedemption must be boolean');
  if (holding.pendingRedemption === true && holding.isCash === true) errors.push('pending redemption is not received cash');
  if (holding.isCash === false && holding.assetClass === 'Cash') errors.push('Cash assetClass conflicts with isCash=false');
  return errors;
}

function result(holding, mapping, bucket, rule, reason, detail = null, extra = {}) {
  return {
    key: rowKey(holding),
    portfolioId: id(holding?.portfolioId) ? holding.portfolioId : null,
    holdingId: id(holding?.holdingId) ? holding.holdingId : null,
    cashAccountId: id(holding?.cashAccountId) ? holding.cashAccountId : null,
    name: nonempty(holding?.name) ? holding.name : null,
    assetClass: nonempty(holding?.assetClass) ? holding.assetClass : null,
    status: bucket === null ? 'unresolved' : 'classified',
    bucket,
    rule,
    unresolvedReason: reason,
    detail,
    evidence: {
      mappingEffectiveDate: mapping?.effectiveDate ?? null,
      rulePath: extra.rulePath ?? null,
      identityCheck: extra.identityCheck ?? null,
      pendingRedemptionRetainedInOriginalBucket: holding?.pendingRedemption === true && bucket !== null
    }
  };
}

function classifyWithValidatedMapping(mapping, holding) {
  const errors = rowErrors(holding);
  if (errors.length) return result(holding, mapping, null, null, 'invalid_holding', errors);
  const overrideIndex = mapping.holdingOverrides.findIndex(rule => rule.portfolioId === holding.portfolioId && rule.holdingId === holding.holdingId);
  const override = overrideIndex < 0 ? null : mapping.holdingOverrides[overrideIndex];
  // Cash has first priority, but an identity contradiction is not a priority
  // decision. A formerly non-cash override must never be silently ignored.
  if (holding.isCash === true) {
    if (override && (override.bucket !== 'highly_liquid' || !normalizeName(holding.name).includes(normalizeName(override.nameContains)))) {
      return result(holding, mapping, null, null, 'cash_override_conflict', 'cash source identity conflicts with explicit holding override');
    }
    return result(holding, mapping, 'highly_liquid', 'cash', null, null, { rulePath: 'cashRule', identityCheck: 'explicit isCash=true' });
  }
  if (override) {
    if (!normalizeName(holding.name).includes(normalizeName(override.nameContains))) {
      return result(holding, mapping, null, null, 'override_name_mismatch', 'exact IDs matched but required nameContains cross-check failed', { rulePath: `holdingOverrides[${overrideIndex}]`, identityCheck: 'ID match; name mismatch' });
    }
    return result(holding, mapping, override.bucket, 'holding_override', null, null, { rulePath: `holdingOverrides[${overrideIndex}]`, identityCheck: 'portfolioId + holdingId + nameContains' });
  }
  const portfolioIndex = mapping.portfolioRules.findIndex(rule => rule.portfolioId === holding.portfolioId);
  if (portfolioIndex >= 0) {
    const portfolioRule = mapping.portfolioRules[portfolioIndex];
    return result(holding, mapping, portfolioRule.bucket, 'portfolio_rule', null, null, { rulePath: `portfolioRules[${portfolioIndex}]`, identityCheck: 'portfolioId; explicitly non-cash row' });
  }
  if (Object.hasOwn(mapping.defaultAssetClassRules, holding.assetClass)) {
    return result(holding, mapping, mapping.defaultAssetClassRules[holding.assetClass], 'asset_class_default', null, null, { rulePath: `defaultAssetClassRules.${holding.assetClass}`, identityCheck: 'exact source assetClass label' });
  }
  return result(holding, mapping, null, null,
    holding.assetClass === 'Semi Liquid' ? 'unmapped_semi_liquid' : 'unrecognized_asset_class',
    'no approved rule matched; do not infer a bucket from the holding name');
}

/** Pure, read-only classification. Inputs are already normalized from trusted
 * source fields; this module does not fetch, authenticate, or change holdings. */
export function classifyHolding(mapping, holding) {
  const errors = validateClassificationMapping(mapping);
  return errors.length ? result(holding, mapping, null, null, 'invalid_mapping', errors) : classifyWithValidatedMapping(mapping, holding);
}

/** scope.complete is only a caller declaration, not evidence manufactured by
 * this function. A complete supplied sample does not prove a complete account. */
export function auditClassification({ mapping, holdings, scope } = {}) {
  if (!Array.isArray(holdings)) throw new Error('holdings must be an explicit normalized array');
  const mappingErrors = validateClassificationMapping(mapping);
  const scopeErrors = [];
  const hasScope = object(scope);
  if (scope !== undefined && !hasScope) scopeErrors.push('scope must be an object');
  if (hasScope && (!Array.isArray(scope.portfolioIds) || !scope.portfolioIds.length || scope.portfolioIds.some(value => !id(value)) || new Set(scope.portfolioIds).size !== scope.portfolioIds.length)) scopeErrors.push('scope.portfolioIds requires unique positive IDs');
  if (hasScope && typeof scope.complete !== 'boolean') scopeErrors.push('scope.complete must be an explicit boolean');
  const portfolioIds = hasScope && !scopeErrors.length ? scope.portfolioIds : [];
  const keyCounts = new Map();
  for (const holding of holdings) {
    const key = rowKey(holding);
    if (key) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  const rows = holdings.map(holding => {
    if (mappingErrors.length) return result(holding, mapping, null, null, 'invalid_mapping', mappingErrors);
    const errors = rowErrors(holding);
    if (errors.length) return result(holding, mapping, null, null, 'invalid_holding', errors);
    if ((keyCounts.get(rowKey(holding)) ?? 0) > 1) return result(holding, mapping, null, null, 'duplicate_source_row', 'all copies remain unresolved; do not count twice or select the first');
    if (portfolioIds.length && !portfolioIds.includes(holding.portfolioId)) return result(holding, mapping, null, null, 'outside_declared_scope', 'row portfolioId is not in the explicitly declared input scope');
    return classifyWithValidatedMapping(mapping, holding);
  });
  const summary = {
    totalRows: rows.length, classifiedRows: 0, unresolvedRows: 0,
    byBucket: Object.fromEntries(BUCKETS.map(bucket => [bucket, 0])),
    byRule: {}, byUnresolvedReason: {}, byPortfolio: {},
    semiLiquid: { suppliedRows: 0, classifiedRows: 0, unresolvedRows: 0, byRule: {} }
  };
  for (const row of rows) {
    const portfolio = summary.byPortfolio[row.portfolioId ?? 'invalid'] ??= { totalRows: 0, classifiedRows: 0, unresolvedRows: 0 };
    portfolio.totalRows += 1;
    const key = row.status === 'classified' ? 'classifiedRows' : 'unresolvedRows';
    summary[key] += 1;
    portfolio[key] += 1;
    if (row.bucket) { increment(summary.byBucket, row.bucket); increment(summary.byRule, row.rule); }
    else increment(summary.byUnresolvedReason, row.unresolvedReason);
    if (row.assetClass === 'Semi Liquid') {
      summary.semiLiquid.suppliedRows += 1;
      summary.semiLiquid[key] += 1;
      if (row.rule) increment(summary.semiLiquid.byRule, row.rule);
    }
  }
  const observed = new Set(rows.map(row => row.portfolioId).filter(value => value !== null));
  const missingPortfolioIds = portfolioIds.filter(value => !observed.has(value));
  const classificationCompleteForSuppliedRows = rows.length > 0 && !mappingErrors.length && summary.unresolvedRows === 0;
  const inputDeclaredComplete = hasScope && !scopeErrors.length && scope.complete === true;
  return {
    schemaVersion: 1, kind: 'xuan-ib-classification-audit',
    mappingEffectiveDate: mapping?.effectiveDate ?? null,
    mappingErrors, scopeErrors, rows, summary,
    coverage: {
      portfolioIds: [...portfolioIds], inputDeclaredComplete,
      completenessBasis: inputDeclaredComplete ? 'caller_declared_complete_not_independently_verified' : 'partial_or_unspecified',
      missingPortfolioIds,
      classificationCompleteForSuppliedRows,
      requiresDatedSnapshotFallback: !classificationCompleteForSuppliedRows || !inputDeclaredComplete || scopeErrors.length > 0 || missingPortfolioIds.length > 0,
      note: 'Classification coverage concerns only supplied rows. Verify source pagination, active holdings, cash inclusion, account scope and value reconciliation separately before publishing current aggregates.'
    }
  };
}

function readExplicitJson(file) {
  if (!nonempty(file)) throw new Error('an explicit JSON path is required');
  if (fs.statSync(file).size > 8 * 1024 * 1024) throw new Error('JSON input exceeds 8 MiB');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--mapping' || args[2] !== '--input') throw new Error('Usage: node scripts/xuan-ib-classification-audit.mjs --mapping APPROVED_MAPPING.json --input NORMALIZED_INPUT.json');
    const input = readExplicitJson(args[3]);
    if (!object(input)) throw new Error('normalized input must be an object containing holdings and scope');
    const audit = auditClassification({ mapping: readExplicitJson(args[1]), holdings: input.holdings, scope: input.scope });
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
    if (audit.coverage.requiresDatedSnapshotFallback) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`Classification audit stopped: ${error.message}\n`);
    process.exitCode = 1;
  }
}
