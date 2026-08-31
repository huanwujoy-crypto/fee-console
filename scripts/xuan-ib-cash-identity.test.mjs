import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { resolveCashIdentity, validateCashIdentityRegistry } from './xuan-ib-cash-identity.mjs';
import { classifyHolding } from './xuan-ib-classification-audit.mjs';

const registry = JSON.parse(fs.readFileSync(new URL('../claude/xuan-ib-cash-identities-v1.json', import.meta.url), 'utf8'));
const mapping = JSON.parse(fs.readFileSync(new URL('../claude/four-bucket-mapping.json', import.meta.url), 'utf8'));
const source = {
  portfolioId: 1031350, holdingId: 26755602,
  name: '现金帐户 | OTHER\n\nCash', recordType: 'holding',
  securityType: 'OrdinaryShares', sourceSecurityType: 'Ordinary Shares',
  currency: 'USD', unitPrice: 1, pendingRedemption: false,
  assetClass: 'Highly Liquid', sourceLabels: ['Highly Liquid'],
};
const resolve = patch => resolveCashIdentity(registry, { ...source, ...patch });

test('reviewed registry contains only the source-proven cash proxy and no private banking amounts', () => {
  assert.deepEqual(validateCashIdentityRegistry(registry), []);
  assert.equal(registry.identities.length, 1);
  const text = JSON.stringify(registry);
  assert.doesNotMatch(text, /132380|132,380|12717|12139|173528|accountNumber|balance|transaction|token|secret/i);
  for (const invalid of [null, [], {}, { ...registry, schemaVersion: 2 }, { ...registry, arbitrary: true }, { ...registry, identities: [] }, { ...registry, identities: [...registry.identities, registry.identities[0]] }]) assert.ok(validateCashIdentityRegistry(invalid).length);
  for (const patch of [{ holdingId: 26755603 }, { portfolioId: 936238 }, { currency: 'CAD' }, { unitPrice: 100 }, { name: 'Cash' }, { representation: 'cash_account' }, { evidenceDate: '2026-08-31' }, { bankAccountNumber: 'private' }]) {
    const invalid = { ...registry, identities: [{ ...registry.identities[0], ...patch }] };
    assert.ok(validateCashIdentityRegistry(invalid).length);
    assert.equal(resolveCashIdentity(invalid, source).status, 'unresolved');
  }
});

test('exact verified identity normalizes economic cash and retains original security representation', () => {
  const result = resolve();
  assert.equal(result.status, 'resolved'); assert.equal(result.holding.isCash, true);
  assert.equal(result.holding.recordType, 'holding');
  assert.equal(result.holding.securityType, 'OrdinaryShares');
  assert.equal(result.holding.sourceSecurityType, 'Ordinary Shares');
  assert.equal(result.evidence.identityKey, '1031350:holding:26755602');
  assert.equal(result.evidence.representation, 'cash_proxy');
  assert.equal(result.evidence.evidenceDate, '2026-08-27');
  assert.equal(result.evidence.priorCashFlag, 'absent');
  assert.match(result.evidence.scope, /not_live_balance_or_native_cash_account/);
  const classification = classifyHolding(mapping, result.holding);
  assert.equal(classification.bucket, 'highly_liquid'); assert.equal(classification.rule, 'cash');
});

test('whitespace normalization is permitted but names are not guessed or substring matched', () => {
  assert.equal(resolve({ name: ' 现金帐户\t| OTHER\r\n Cash ' }).status, 'resolved');
  for (const name of [undefined, null, '', '现金帐户', 'Cash', '现金账户 | OTHER Cash', '现金帐户 | OTHER Cash fund', '现金帐户 | OTHER cash', 'Not cash']) {
    const result = resolve({ name }); assert.equal(result.status, 'unresolved'); assert.equal(result.evidence, null); assert.equal(Object.hasOwn(result.holding, 'isCash'), false);
  }
});

test('different identities are not applicable even if their names say Cash', () => {
  for (const patch of [{ portfolioId: 936238 }, { holdingId: 26755603 }, { portfolioId: 936238, holdingId: 26755603 }]) {
    const result = resolve(patch);
    assert.equal(result.status, 'not_applicable'); assert.equal(result.evidence, null);
    assert.equal(Object.hasOwn(result.holding, 'isCash'), false);
  }
  const explicitOther = resolve({ holdingId: 26755603, isCash: true });
  assert.equal(explicitOther.status, 'not_applicable'); assert.equal(explicitOther.holding.isCash, true);
  const nativeCash = { portfolioId: 936238, cashAccountId: 12345, name: 'USD account', recordType: 'cash_account', isCash: true, assetClass: 'Cash' };
  const native = resolveCashIdentity(registry, nativeCash);
  assert.equal(native.status, 'not_applicable'); assert.equal(native.evidence, null);
  assert.deepEqual(native.holding, nativeCash);
});

test('currency, unit price, holding type and nonpending status must be explicit source facts', () => {
  for (const patch of [
    { currency: undefined }, { currency: null }, { currency: 'usd' }, { currency: 'CAD' },
    { unitPrice: undefined }, { unitPrice: null }, { unitPrice: '1' }, { unitPrice: 100 }, { unitPrice: .999999 }, { unitPrice: NaN }, { unitPrice: Infinity },
    { recordType: undefined }, { recordType: 'cash_account' }, { cashAccountId: 26755602 },
    { pendingRedemption: undefined }, { pendingRedemption: true }, { pendingRedemption: 'false' }, { pendingRedemption: 0 },
  ]) {
    const result = resolve(patch);
    assert.equal(result.status, 'unresolved', JSON.stringify(patch));
    assert.equal(result.evidence, null); assert.equal(Object.hasOwn(result.holding, 'isCash'), false);
  }
  for (const patch of [{ portfolioId: '1031350' }, { holdingId: '26755602' }, { holdingId: 0 }, { holdingId: NaN }, { holdingId: undefined }]) assert.equal(resolve(patch).status, 'unresolved');
});

test('explicit noncash or malformed cash flags are conflicts and never overwritten', () => {
  for (const isCash of [false, null, undefined, 'false', 'true', 0, 1]) {
    const result = resolve({ isCash });
    assert.equal(result.status, 'unresolved'); assert.equal(result.holding.isCash, isCash);
    assert.ok(result.errors.some(error => /never silently overwrite/.test(error)));
    assert.equal(result.evidence, null);
  }
  const already = resolve({ isCash: true });
  assert.equal(already.status, 'resolved'); assert.equal(already.evidence.priorCashFlag, 'already_true');
  assert.equal(resolve({ isCash: true, pendingRedemption: true }).status, 'unresolved');
});

test('resolution never mutates inputs or aliases nested source fields', () => {
  const beforeRegistry = structuredClone(registry), beforeSource = structuredClone(source);
  const frozen = Object.freeze({ ...source, sourceLabels: Object.freeze([...source.sourceLabels]) });
  const result = resolveCashIdentity(registry, frozen);
  result.holding.sourceLabels.push('output-only');
  assert.deepEqual(registry, beforeRegistry); assert.deepEqual(source, beforeSource);
  assert.deepEqual(frozen.sourceLabels, ['Highly Liquid']); assert.equal(Object.hasOwn(frozen, 'isCash'), false);
  const conflictSource = { ...source, isCash: false };
  const conflictBefore = structuredClone(conflictSource);
  resolveCashIdentity(registry, conflictSource); assert.deepEqual(conflictSource, conflictBefore);
});

test('invalid row or invalid registry supplies no cash evidence', () => {
  for (const row of [null, undefined, [], '', 7]) {
    const result = resolveCashIdentity(registry, row);
    assert.equal(result.status, 'unresolved'); assert.equal(result.evidence, null);
  }
  const result = resolveCashIdentity({ ...registry, identities: [] }, source);
  assert.equal(result.status, 'unresolved'); assert.equal(Object.hasOwn(result.holding, 'isCash'), false);
});

test('unlabelled noncash rows use only existing whole-portfolio rules, without fabricated labels', () => {
  for (const [portfolioId, expected] of [[936247, 'highly_liquid'], [1350095, 'evergreen']]) {
    const row = { portfolioId, holdingId: 123456, recordType: 'holding', name: 'Source instrument', isCash: false, assetClass: 'Unlabelled', sourceLabels: [] };
    const before = structuredClone(row);
    const result = classifyHolding(mapping, row);
    assert.equal(result.status, 'classified'); assert.equal(result.bucket, expected); assert.equal(result.rule, 'portfolio_rule');
    assert.deepEqual(row, before); assert.deepEqual(row.sourceLabels, []);
  }
  const unsupported = classifyHolding(mapping, { portfolioId: 936240, holdingId: 123456, name: 'Unknown source', isCash: false, assetClass: 'Unlabelled', sourceLabels: [] });
  assert.equal(unsupported.status, 'unresolved'); assert.equal(unsupported.unresolvedReason, 'unrecognized_asset_class');
});
