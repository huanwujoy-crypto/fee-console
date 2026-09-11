// The one trusted re-resolver of a published AI-risk coefficient, and the one
// statement of the exact integer arithmetic built on top of it.
//
// Both halves exist for the same reason. Before them, a published coefficient
// was bound to the approval it claimed to come from only by the first few
// letters of a record id, and a published contribution was required to land on
// a whole cent — which ordinary inputs do not. So a candidate could raise a
// coefficient, re-derive every other number on the page from it, and pass every
// check, because every check compared the page against itself; and a correct
// 25.03% look-through of a real market value could not be published at all.
//
// Nothing here reads a financial account or a network. Every identity below is
// either a rule the repository already records or a deliberately wrong one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASIS_POINTS, DENOMINATOR_COMPONENT_KEY, MICRO_BASIS_PER_CENT, MICRO_PER_CENT, MICRO_PER_USD,
  basisPointsOf, centsFromMicroUsd, contributionMicroBasis, microUsdFromUsdNumber, microUsdOf,
  readAiRiskAccounts, resetAiCoefficientResolverCache, resolveTrustedMidCoefficientBp,
  roundMicroBasisToCents,
} from './xuan-ib-ai-coefficient-resolver.mjs';
import { readAiRiskRegistry } from './xuan-ib-ai-risk-registry.mjs';

// ---------------------------------------------------------------------------
// Exact integer units.
// ---------------------------------------------------------------------------

test('a coefficient is basis points or it is refused, never rounded', () => {
  assert.equal(BASIS_POINTS, 10_000);
  assert.equal(basisPointsOf(0.55), 5500);
  assert.equal(basisPointsOf(0.2503), 2503);
  assert.equal(basisPointsOf(0.0601), 601);
  assert.equal(basisPointsOf(1), 10_000);
  assert.equal(basisPointsOf(0), 0);
  // A coefficient this contract cannot express exactly is not one of ours:
  // silently rounding it would publish a number no approved document records.
  assert.throws(() => basisPointsOf(0.123_45), /COEFFICIENT_NOT_EXACT/);
  for (const value of [-0.1, 1.1, NaN, Infinity, '0.55', null, undefined]) {
    assert.throws(() => basisPointsOf(value), /COEFFICIENT_INVALID/);
  }
});

test('money is an integer of micro-USD, verified to the cent', () => {
  assert.equal(MICRO_PER_USD, 1_000_000n);
  assert.equal(MICRO_PER_CENT, 10_000n);
  assert.equal(MICRO_BASIS_PER_CENT, 100_000_000n);
  assert.equal(microUsdOf('1000010000'), 1_000_010_000n);
  assert.equal(microUsdOf(1_000_010_000n), 1_000_010_000n);
  assert.equal(microUsdOf('0'), 0n);
  // Finer than a cent is refused rather than rounded: every published figure is
  // defined on amounts verified to the cent, and rounding here would make a
  // contribution disagree with the source it claims to come from.
  assert.throws(() => microUsdOf('1000010001'), /VALUE_NOT_VERIFIED_USD_CENTS/);
  // A float is not an integer input, however right the amount looks.
  for (const value of [1_000_010_000, '1e9', '1.5', '-10000', '', null, {}]) {
    assert.throws(() => microUsdOf(value), /VALUE_NOT_VERIFIED_USD_CENTS/);
  }
});

test('the older verified-to-the-cent USD number converts through its own text', () => {
  // Never `Math.round(value * 100)`: that is a float operation on a value this
  // contract has already promised is exact.
  assert.equal(microUsdFromUsdNumber(1000.01), 1_000_010_000n);
  assert.equal(microUsdFromUsdNumber(405988), 405_988_000_000n);
  assert.equal(microUsdFromUsdNumber(0.01), 10_000n);
  assert.equal(microUsdFromUsdNumber(0), 0n);
  assert.equal(microUsdFromUsdNumber(1.1), 1_100_000n);
  // More precision than a cent, a negative amount, or a value whose own decimal
  // text is not what it claims to be.
  for (const value of [1.005, -1, NaN, Infinity, 0.1 + 0.2, '1000', null]) {
    assert.throws(() => microUsdFromUsdNumber(value), /VALUE_NOT_VERIFIED_USD_CENTS/);
  }
  assert.equal(centsFromMicroUsd(1_000_010_000n), 100_001n);
  assert.throws(() => centsFromMicroUsd(1n), /VALUE_NOT_VERIFIED_USD_CENTS/);
});

test('a contribution is an exact product and is not required to be whole cents', () => {
  // 25.03% of $1,000.01. The earlier contract required this product to divide
  // evenly by 10,000 and refused publication otherwise.
  const product = contributionMicroBasis(1_000_010_000n, 2503n);
  assert.equal(product, 2_503_025_030_000n);
  assert.notEqual(product % MICRO_BASIS_PER_CENT, 0n);
  // 6.01% of $405,988.00 is exactly $24,399.8788.
  assert.equal(contributionMicroBasis(405_988_000_000n, 601n), 243_998_788_000_000n);
  assert.throws(() => contributionMicroBasis(1_000n, 10_001n), /COEFFICIENT_OUT_OF_RANGE/);
  assert.throws(() => contributionMicroBasis(1000, 5500n), /CONTRIBUTION_UNITS_INVALID/);
  assert.throws(() => contributionMicroBasis(-1n, 5500n), /VALUE_NOT_VERIFIED_USD_CENTS/);
});

test('the single rounding is half away from zero, on the display figure only', () => {
  assert.equal(roundMicroBasisToCents(0n), 0n);
  assert.equal(roundMicroBasisToCents(2_503_025_030_000n), 25_030n);
  // Exactly half a cent goes away from zero, in both directions.
  assert.equal(roundMicroBasisToCents(MICRO_BASIS_PER_CENT / 2n), 1n);
  assert.equal(roundMicroBasisToCents(-MICRO_BASIS_PER_CENT / 2n), -1n);
  assert.equal(roundMicroBasisToCents(MICRO_BASIS_PER_CENT / 2n - 1n), 0n);
  assert.equal(roundMicroBasisToCents(MICRO_BASIS_PER_CENT + MICRO_BASIS_PER_CENT / 2n), 2n);
  assert.throws(() => roundMicroBasisToCents(1), /CONTRIBUTION_UNITS_INVALID/);

  // Summing rounded rows drifts with the number of rows; summing the exact
  // products and rounding once does not. Three rows of $250.302503:
  const row = contributionMicroBasis(1_000_010_000n, 2503n);
  assert.equal(roundMicroBasisToCents(row) * 3n, 75_090n);
  assert.equal(roundMicroBasisToCents(row * 3n), 75_091n);
});

test('a denominator component key is stable, lowercase and machine-readable', () => {
  for (const key of ['ib-hk', 'schwab-hk', 'webull', 'a', 'synthetic-account', '0']) {
    assert.equal(DENOMINATOR_COMPONENT_KEY.test(key), true, key);
  }
  for (const key of ['', 'IB-HK', 'ib hk', '-ib', 'ib_hk', 'ib.hk', 'x'.repeat(41)]) {
    assert.equal(DENOMINATOR_COMPONENT_KEY.test(key), false, key);
  }
});

// ---------------------------------------------------------------------------
// The trusted re-resolution itself.
// ---------------------------------------------------------------------------

const REG_GOOG = () => {
  const rule = readAiRiskRegistry().lookup('IB-HK', 'GOOG');
  return { namespace: 'REG', recordId: rule.recordId, symbol: 'GOOG', custodian: 'IB-HK',
    portfolioId: '936247', holdingId: '70000002', instrumentId: '70000002' };
};
const DELEG_VST = () => ({ namespace: 'DELEG', recordId: 'DELEG-20260910-VST-T1', symbol: 'VST',
  custodian: 'Webull', portfolioId: '1350094', holdingId: '29098649', instrumentId: '1753523' });
const WU_MRVL = () => ({ namespace: 'WU', recordId: 'WU-20260831-MRVL-T1', symbol: 'MRVL',
  custodian: 'Webull', portfolioId: '1350094', holdingId: '28987468', instrumentId: '28987468' });
const AUTO_NEW = () => ({ namespace: 'AUTO',
  recordId: 'AUTO:AUTO-20260911-NEWSTK-T1-R1:1350094:99999999', symbol: 'NEWAI',
  custodian: 'Webull', portfolioId: '1350094', holdingId: '99999999', instrumentId: '99999999' });

test('every namespace resolves to the one coefficient its own approval records', () => {
  // The registry's transcribed §0-C assignment.
  const reg = resolveTrustedMidCoefficientBp(REG_GOOG());
  assert.equal(reg.midBp, 5500);
  assert.equal(reg.basis, 'registry');
  assert.equal(reg.namespace, 'REG');
  // The standing delegation.
  const deleg = resolveTrustedMidCoefficientBp(DELEG_VST());
  assert.deepEqual([deleg.midBp, deleg.basis, deleg.tier], [8000, 'delegated', 'T1']);
  // The owner's own identity-bound selection.
  const wu = resolveTrustedMidCoefficientBp(WU_MRVL());
  assert.deepEqual([wu.midBp, wu.basis, wu.tier], [8000, 'owner-override', 'T1']);
  // The automatic policy's standard T1, whose record id is itself the policy
  // revision and the identity it was minted for.
  const auto = resolveTrustedMidCoefficientBp(AUTO_NEW());
  assert.deepEqual([auto.midBp, auto.basis, auto.tier], [8000, 'auto', 'T1']);

  // The memoised rule index is a read cache and nothing else: dropping it
  // changes no answer.
  resetAiCoefficientResolverCache();
  assert.deepEqual(resolveTrustedMidCoefficientBp(REG_GOOG()), reg);
});

test('a record id is not a prefix: it must be this identity\'s own approval', () => {
  // The hole this closes. `WU`, `DELEG` and `AUTO` were previously accepted on
  // the strength of their first few letters.
  assert.throws(() => resolveTrustedMidCoefficientBp(
    { ...DELEG_VST(), recordId: 'DELEG-20260910-NOT-A-RULE' }), /OWNER_RULE_NOT_APPROVED/);
  assert.throws(() => resolveTrustedMidCoefficientBp(
    { ...WU_MRVL(), recordId: 'WU-20260831-INVENTED-T1' }), /OWNER_RULE_NOT_APPROVED/);
  // A rule presented under the wrong namespace misrepresents its authority: an
  // owner selection and a routine delegated classification are not the same
  // claim about who decided.
  assert.throws(() => resolveTrustedMidCoefficientBp(
    { ...DELEG_VST(), namespace: 'WU' }), /RECORD_NAMESPACE_MISMATCH/);
  assert.throws(() => resolveTrustedMidCoefficientBp(
    { ...WU_MRVL(), namespace: 'DELEG' }), /RECORD_NAMESPACE_MISMATCH/);
  assert.throws(() => resolveTrustedMidCoefficientBp(
    { ...REG_GOOG(), namespace: 'AUTO' }), /RECORD_NAMESPACE_MISMATCH/);
  assert.throws(() => resolveTrustedMidCoefficientBp(
    { ...REG_GOOG(), namespace: 'MADE-UP' }), /RECORD_NAMESPACE_UNKNOWN/);
});

test('an identity that is not the approved one is refused rather than stretched', () => {
  // A real approval pointed at another position.
  assert.throws(() => resolveTrustedMidCoefficientBp(
    { ...DELEG_VST(), holdingId: '29098650' }), /RECORD_IDENTITY_MISMATCH/);
  assert.throws(() => resolveTrustedMidCoefficientBp(
    { ...DELEG_VST(), instrumentId: '1753524' }), /RECORD_IDENTITY_MISMATCH/);
  assert.throws(() => resolveTrustedMidCoefficientBp(
    { ...WU_MRVL(), symbol: 'AVGO' }), /RECORD_IDENTITY_MISMATCH/);
  // A registry rule is bound to its own custodian: this is what keeps `GOOG` at
  // IB-HK and `GOOG` at Webull two rules rather than one.
  assert.throws(() => resolveTrustedMidCoefficientBp(
    { ...REG_GOOG(), custodian: 'Schwab-HK' }), /REG_RULE_NOT_RECORDED/);
  // A registry-looking id minted for an instrument the registry does record,
  // but under another rule's name.
  assert.throws(() => resolveTrustedMidCoefficientBp(
    { ...REG_GOOG(), recordId: 'REG-SPECIAL-IREN-LADDER' }), /REG_RULE_ID_MISMATCH/);
  // And an incomplete identity is never completed by assumption.
  for (const field of ['symbol', 'custodian', 'portfolioId', 'holdingId', 'instrumentId', 'recordId']) {
    assert.throws(() => resolveTrustedMidCoefficientBp({ ...REG_GOOG(), [field]: '' }),
      /RECORD_IDENTITY_INCOMPLETE|RECORD_NAMESPACE_MISMATCH/);
  }
  assert.throws(() => resolveTrustedMidCoefficientBp(null), /RECORD_MALFORMED/);
});

test('an AUTO record may not stand where an owner or registry rule already does', () => {
  // The automatic policy is the last resort, not an override. A record standing
  // where an approved rule applies could only have been written by hand.
  assert.throws(() => resolveTrustedMidCoefficientBp({ ...AUTO_NEW(),
    recordId: 'AUTO:AUTO-20260911-NEWSTK-T1-R1:1350094:28987468', holdingId: '28987468' }),
  /AUTO_SHADOWS_OWNER_RULE/);
  assert.throws(() => resolveTrustedMidCoefficientBp({ ...AUTO_NEW(),
    custodian: 'IB-HK', symbol: 'GOOG' }), /AUTO_SHADOWS_REGISTRY_RULE/);
  // The record id is three facts, not a name: the policy revision this
  // repository actually carries, and the identity actually presented.
  assert.throws(() => resolveTrustedMidCoefficientBp({ ...AUTO_NEW(),
    recordId: 'AUTO:AUTO-20260911-NEWSTK-T1-R9:1350094:99999999' }),
  /AUTO_POLICY_REVISION_MISMATCH/);
  assert.throws(() => resolveTrustedMidCoefficientBp({ ...AUTO_NEW(),
    recordId: 'AUTO:AUTO-20260911-NEWSTK-T1-R1:1350094:88888888' }),
  /RECORD_IDENTITY_MISMATCH/);
  assert.throws(() => resolveTrustedMidCoefficientBp({ ...AUTO_NEW(), recordId: 'AUTO:whatever' }),
    /AUTO_RECORD_ID_INVALID/);
});

test('the three approved accounts are read from the trusted portfolio registry', () => {
  const accounts = readAiRiskAccounts();
  assert.deepEqual(accounts.map(account => account.key), ['ib-hk', 'schwab-hk', 'webull']);
  assert.deepEqual(accounts.map(account => account.custodian), ['IB-HK', 'Schwab-HK', 'Webull']);
  // The portfolio id comes from the registry and is never hard-coded here, so
  // this module cannot disagree with the registry the moment either one moves.
  for (const account of accounts) assert.match(account.portfolioId, /^\d+$/);
  for (const key of accounts.map(account => account.key)) {
    assert.equal(DENOMINATOR_COMPONENT_KEY.test(key), true, key);
  }
  assert.throws(() => readAiRiskAccounts({ registry: { portfolios: [] } }),
    /PORTFOLIO_REGISTRY_ACCOUNT_NOT_UNIQUE/);
});
