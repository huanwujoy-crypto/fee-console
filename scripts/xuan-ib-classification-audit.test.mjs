import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { auditClassification, classifyHolding, validateClassificationMapping } from './xuan-ib-classification-audit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mapping = JSON.parse(fs.readFileSync(path.join(root, 'claude/four-bucket-mapping.json'), 'utf8'));
const holding = (overrides = {}) => ({ portfolioId: 936238, holdingId: 100, name: 'Explicit source holding', isCash: false, assetClass: 'Semi Liquid', ...overrides });
const classify = row => classifyHolding(mapping, holding(row));

test('approved repository mapping is valid', () => {
  assert.deepEqual(validateClassificationMapping(mapping), []);
});

test('cash takes precedence over non-cash portfolio rules and asset labels', () => {
  for (const portfolioId of [1021748, 1031350, 1350095, 936247, 936238]) {
    const row = classify({ portfolioId, isCash: true, assetClass: 'Highly Liquid' });
    assert.equal(row.bucket, 'highly_liquid');
    assert.equal(row.rule, 'cash');
  }
});

test('cash account has an explicit separate identity, not a fabricated holding ID', () => {
  const row = classifyHolding(mapping, { portfolioId: 1031350, recordType: 'cash_account', cashAccountId: 22, name: 'USD', isCash: true, assetClass: 'Cash' });
  assert.equal(row.key, '1031350:cash:22');
  assert.equal(row.rule, 'cash');
  assert.equal(classifyHolding(mapping, { portfolioId: 1031350, recordType: 'cash_account', cashAccountId: 22, name: 'USD', isCash: false, assetClass: 'Highly Liquid' }).unresolvedReason, 'invalid_holding');
});

test('UBS GCM exact ID override wins over UBS portfolio-wide evergreen', () => {
  const row = classify({ portfolioId: 1031350, holdingId: 21097888, name: 'GCM GROSVENOR fund' });
  assert.equal(row.bucket, 'hedge_fund');
  assert.equal(row.rule, 'holding_override');
  assert.equal(row.evidence.identityCheck, 'portfolioId + holdingId + nameContains');
});

test('override name cross-check failure blocks lower-priority fallback', () => {
  const row = classify({ portfolioId: 1031350, holdingId: 21097888, name: 'Completely different fund', assetClass: 'Highly Liquid' });
  assert.equal(row.bucket, null);
  assert.equal(row.unresolvedReason, 'override_name_mismatch');
});

test('matching name alone cannot use a NOAH override or cross-account holding ID', () => {
  assert.equal(classify({ holdingId: 999, name: 'VistaOne' }).unresolvedReason, 'unmapped_semi_liquid');
  assert.equal(classify({ portfolioId: 936240, holdingId: 27078301, name: 'VistaOne' }).unresolvedReason, 'unmapped_semi_liquid');
});

test('portfolioRules classify covered Semi Liquid rows without individual overrides', () => {
  const cases = [[1021748, 'hedge_fund'], [1031350, 'evergreen'], [1350095, 'evergreen'], [936247, 'highly_liquid']];
  for (const [portfolioId, expected] of cases) {
    const row = classify({ portfolioId });
    assert.equal(row.bucket, expected);
    assert.equal(row.rule, 'portfolio_rule');
  }
});

test('portfolio identity is the ID, not a familiar portfolio display name', () => {
  const row = classify({ portfolioId: 111111, portfolioName: 'UBS', name: 'UBS Evergreen Fund' });
  assert.equal(row.unresolvedReason, 'unmapped_semi_liquid');
});

test('specific portfolio rule outranks a lower-priority general asset-class label', () => {
  const row = classify({ portfolioId: 1031350, assetClass: 'Illiquid' });
  assert.equal(row.bucket, 'evergreen');
  assert.equal(row.rule, 'portfolio_rule');
});

test('explicit generic defaults only apply after higher-priority rules', () => {
  assert.equal(classify({ assetClass: 'Highly Liquid' }).bucket, 'highly_liquid');
  assert.equal(classify({ assetClass: 'Illiquid' }).bucket, 'vc_pe');
  assert.equal(classify({ assetClass: 'highly liquid' }).unresolvedReason, 'unrecognized_asset_class');
  assert.equal(classify({ assetClass: 'Mystery' }).unresolvedReason, 'unrecognized_asset_class');
});

test('a suggestive asset name never supplies a missing liquidity rule', () => {
  for (const name of ['Cash money fund', 'Highly Liquid', 'Evergreen private equity', '景林', 'Hedge fund', 'Treasury USD']) {
    const row = classify({ name });
    assert.equal(row.bucket, null);
    assert.equal(row.unresolvedReason, 'unmapped_semi_liquid');
  }
});

test('pending redemption stays in original bucket; conflicting received-cash flag stops', () => {
  const row = classify({ portfolioId: 1350095, pendingRedemption: true });
  assert.equal(row.bucket, 'evergreen');
  assert.equal(row.evidence.pendingRedemptionRetainedInOriginalBucket, true);
  assert.equal(classify({ portfolioId: 1350095, isCash: true, pendingRedemption: true }).unresolvedReason, 'invalid_holding');
});

test('a cash claim conflicting with an explicit non-cash override is unresolved', () => {
  const row = classify({ portfolioId: 1031350, holdingId: 21097888, name: 'GCM', isCash: true });
  assert.equal(row.unresolvedReason, 'cash_override_conflict');
});

test('missing or malformed normalization fields are not guessed or coerced', () => {
  for (const [field, value] of [['portfolioId', '936238'], ['holdingId', 0], ['name', ''], ['isCash', undefined], ['assetClass', undefined], ['assetClass', ['Highly Liquid', 'Illiquid']], ['pendingRedemption', 'pending']]) {
    assert.equal(classify({ [field]: value }).unresolvedReason, 'invalid_holding', field);
  }
  assert.equal(classifyHolding(mapping, null).unresolvedReason, 'invalid_holding');
});

test('duplicate overrides are configuration errors, whether identical or conflicting', () => {
  for (const bucket of ['hedge_fund', 'evergreen']) {
    const edited = structuredClone(mapping);
    edited.holdingOverrides.push({ ...edited.holdingOverrides[0], bucket });
    assert.equal(classifyHolding(edited, holding()).unresolvedReason, 'invalid_mapping');
    assert.match(validateClassificationMapping(edited).join(' '), /duplicate holding override/);
  }
});

test('duplicate portfolio rules and unsupported default labels cannot guess precedence', () => {
  const edited = structuredClone(mapping);
  edited.portfolioRules.push({ ...edited.portfolioRules[0], bucket: 'evergreen' });
  assert.match(validateClassificationMapping(edited).join(' '), /duplicate portfolio rule/);
  const newDefault = structuredClone(mapping);
  newDefault.defaultAssetClassRules['Semi Liquid'] = 'evergreen';
  assert.equal(classifyHolding(newDefault, holding()).unresolvedReason, 'invalid_mapping');
});

test('changed unknown-label or pending-redemption policy is not silently executed', () => {
  const unknown = structuredClone(mapping);
  unknown.matchingPolicy.unknownSemiLiquid = 'guess evergreen';
  assert.equal(classifyHolding(unknown, holding()).unresolvedReason, 'invalid_mapping');
  const redemption = structuredClone(mapping);
  redemption.pendingRedemptionRule.classification = 'move to cash before receipt';
  assert.equal(classifyHolding(redemption, holding()).unresolvedReason, 'invalid_mapping');
  const invalidDate = structuredClone(mapping);
  invalidDate.effectiveDate = '2026-02-30';
  assert.equal(classifyHolding(invalidDate, holding()).unresolvedReason, 'invalid_mapping');
});

test('classification has no input mutation or nondeterministic timestamps', () => {
  const input = { mapping, holdings: [holding({ portfolioId: 1031350 })], scope: { portfolioIds: [1031350], complete: true } };
  const before = structuredClone(input);
  assert.deepEqual(auditClassification(input), auditClassification(input));
  assert.deepEqual(input, before);
});

test('full-rule coverage does not calculate unclassified count as total minus overrides', () => {
  const rows = [
    holding({ holdingId: 27078301, name: 'VistaOne' }),
    holding({ portfolioId: 1031350, holdingId: 100 }),
    holding({ portfolioId: 1021748, holdingId: 100 }),
    holding({ holdingId: 101, name: 'Unknown new semi-liquid' })
  ];
  const audit = auditClassification({ mapping, holdings: rows });
  assert.deepEqual(audit.summary.semiLiquid, { suppliedRows: 4, classifiedRows: 3, unresolvedRows: 1, byRule: { holding_override: 1, portfolio_rule: 2 } });
  assert.equal(audit.summary.unresolvedRows, 1, 'not 4 - 1 overrides = 3');
  assert.equal(audit.coverage.requiresDatedSnapshotFallback, true);
});

test('all duplicate copies remain unresolved; separate cash/holding namespaces are distinct', () => {
  const h = holding({ assetClass: 'Highly Liquid' });
  const audit = auditClassification({ mapping, holdings: [h, { ...h, name: 'Different name' }] });
  assert.equal(audit.summary.byUnresolvedReason.duplicate_source_row, 2);
  assert.equal(audit.summary.classifiedRows, 0);
  const distinct = auditClassification({ mapping, holdings: [h, { portfolioId: h.portfolioId, recordType: 'cash_account', cashAccountId: h.holdingId, name: 'USD', isCash: true, assetClass: 'Cash' }] });
  assert.equal(distinct.summary.classifiedRows, 2);
});

test('sample coverage cannot assert complete source holdings', () => {
  const audit = auditClassification({ mapping, holdings: [holding({ assetClass: 'Highly Liquid' })] });
  assert.equal(audit.coverage.classificationCompleteForSuppliedRows, true);
  assert.equal(audit.coverage.inputDeclaredComplete, false);
  assert.equal(audit.coverage.requiresDatedSnapshotFallback, true);
  assert.equal(audit.coverage.completenessBasis, 'partial_or_unspecified');
});

test('complete scope remains explicitly caller-declared, requiring independent source reconciliation', () => {
  const audit = auditClassification({ mapping, holdings: [holding({ assetClass: 'Highly Liquid' })], scope: { portfolioIds: [936238], complete: true } });
  assert.equal(audit.coverage.requiresDatedSnapshotFallback, false);
  assert.equal(audit.coverage.completenessBasis, 'caller_declared_complete_not_independently_verified');
});

test('missing portfolios, out-of-scope rows, malformed scope and empty input retain fallback', () => {
  const rows = [holding({ assetClass: 'Highly Liquid' })];
  const missing = auditClassification({ mapping, holdings: rows, scope: { portfolioIds: [936238, 936240], complete: true } });
  assert.deepEqual(missing.coverage.missingPortfolioIds, [936240]);
  assert.equal(missing.coverage.requiresDatedSnapshotFallback, true);
  const outside = auditClassification({ mapping, holdings: rows, scope: { portfolioIds: [936240], complete: true } });
  assert.equal(outside.rows[0].unresolvedReason, 'outside_declared_scope');
  assert.equal(outside.coverage.requiresDatedSnapshotFallback, true);
  const malformed = auditClassification({ mapping, holdings: rows, scope: { portfolioIds: [936238, 936238], complete: true } });
  assert.ok(malformed.scopeErrors.length > 0);
  assert.equal(malformed.coverage.requiresDatedSnapshotFallback, true);
  assert.equal(auditClassification({ mapping, holdings: [], scope: { portfolioIds: [936238], complete: true } }).coverage.requiresDatedSnapshotFallback, true);
});

test('CLI has no implicit files, credentials, networking or financial writes', () => {
  const script = path.join(root, 'scripts/xuan-ib-classification-audit.mjs');
  const response = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(response.status, 1);
  assert.match(response.stderr, /explicit|Usage/);
  const source = fs.readFileSync(script, 'utf8');
  assert.doesNotMatch(source, /process\.env|fetch\(|https?:\/\/|writeFile|execSync|spawnSync|keychain/i);
  assert.throws(() => auditClassification({ mapping }), /explicit normalized array/);
});
