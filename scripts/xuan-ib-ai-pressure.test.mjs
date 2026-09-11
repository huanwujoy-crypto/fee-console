// Fail-closed behaviour of the AI-pressure calculation and its registry reader.
//
// These are the cases where the honest answer is "unavailable" and the tempting
// one is a number. Every one of them must refuse rather than round, default or
// zero-fill: a risk metric that quietly substitutes zero for an input it could
// not resolve understates exactly the thing it exists to measure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAiTierCoverage } from './xuan-ib-ai-tier-coverage.mjs';
import {
  AI_DENOMINATOR_TEMPLATE_ID, computeAiPressure, renderAiPressureSection,
} from './xuan-ib-ai-pressure.mjs';
import { readAiRiskRegistry } from './xuan-ib-ai-risk-registry.mjs';

const dataDate = '2026-09-11';
const constituent = (over = {}) => ({ symbol: 'GOOG', custodian: 'IB-HK', venue: 'NASDAQ',
  portfolioId: '936247', holdingId: '60000001', instrumentId: '60000001', currency: 'USD',
  assetType: 'STK', marketValueUsd: 1000, valueDate: dataDate, identityVerified: true,
  firstSeen: false, ...over });
// A synthetic single-account denominator, named by a stable key. The production
// three-account set is bound where the run's source reports are read; what the
// calculation enforces here is that the keys are well formed, unique, and the
// only thing the total can be made of.
const denominator = () => ({ components: [
  { key: 'synthetic-account', label: '合成账户', valueMicro: '10000000000' }] });
const compute = (constituents, options = {}) =>
  computeAiPressure(constituents, buildAiTierCoverage(constituents),
    { denominator: denominator(), ...options });

test('the calculation is pure: identical inputs give byte-identical output', () => {
  const first = compute([constituent()]);
  const second = compute([constituent()]);
  assert.deepEqual(first, second);
  assert.equal(first.numeratorUsd, 550);
  assert.equal(first.ratio, 0.055);
  assert.equal(first.rows[0].marketValueMicro, '1000000000');
  assert.equal(first.numeratorMicroBasis, '5500000000000');
});

// ---------------------------------------------------------------------------
// Fractional cents. This is the arithmetic the earlier contract refused.
// ---------------------------------------------------------------------------

test('a contribution that is not a whole number of cents is exact, not refused', () => {
  // 25.03% of $1,000.01 is $250.302503 — six decimal places, and nowhere near
  // a whole cent. The earlier rule required `valueCents x coefficientBp` to
  // divide evenly by 10,000 and refused publication otherwise, so this ordinary
  // ETF look-through of an ordinary market value could not be published at all.
  const etf = compute([constituent({ symbol: 'MXUS', assetType: 'ETF', marketValueUsd: 1000.01 })]);
  const row = etf.rows[0];
  assert.equal(row.coefficients.mid, 0.2503);
  assert.equal(row.coefficientsBp.mid, 2503);
  // The exact product is kept: 1,000,010,000 micro-USD x 2,503 basis points.
  assert.equal(row.contributionsMicroBasis.mid, String(1_000_010_000n * 2503n));
  assert.equal(row.contributions.mid, 250.302_503);
  // Only the displayed figure is rounded, half away from zero:
  // 25,030.2503 cents -> 25030.
  assert.equal(row.contributionCents, '25030');
  // And the published exact product is not a whole number of cents, which is
  // precisely the case the old `% BASIS !== 0` check called a defect.
  assert.notEqual(BigInt(row.contributionsMicroBasis.mid) % 100_000_000n, 0n);
});

test('6.01% of a real cent amount keeps its fraction of a cent', () => {
  // 6.01% of $405,988.00 is exactly $24,399.8788 — the worked example the
  // earlier contract could not express.
  // EXUS at IB-HK, whose approved look-through the trusted registry records as
  // 6.01% and which this test does not retype anywhere but in the assertion.
  assert.equal(readAiRiskRegistry().lookup('IB-HK', 'EXUS').ladder.mid, 0.0601);
  const etf = compute([constituent({ symbol: 'EXUS', assetType: 'ETF', marketValueUsd: 405988 })]);
  const row = etf.rows[0];
  assert.equal(row.coefficientsBp.mid, 601);
  assert.equal(row.contributionsMicroBasis.mid, String(405_988_000_000n * 601n));
  assert.equal(row.contributions.mid, 24399.878_8);
  assert.equal(row.contributionCents, '2439988');
});

test('rows are summed unrounded and the total is rounded exactly once', () => {
  // Three rows whose exact contributions each end in half a cent. Rounding each
  // row first and adding the rounded rows drifts with the number of rows; the
  // contract sums the exact products and rounds the total once.
  const rows = [0, 1, 2].map(index => constituent({ symbol: 'MXUS', assetType: 'ETF',
    marketValueUsd: 1000.01, holdingId: `6000010${index}`, instrumentId: `6000010${index}` }));
  const pressure = compute(rows);
  const single = 1_000_010_000n * 2503n;
  assert.equal(pressure.numeratorMicroBasis, String(single * 3n));
  // 3 x $250.302503 = $750.907509 -> 75091 cents, one rounding on the total.
  assert.equal(pressure.numeratorCents, '75091');
  // Each displayed row still rounds to 25030 cents; adding those would give
  // 75090 and understate the published total by a cent.
  assert.deepEqual(pressure.rows.map(row => row.contributionCents), ['25030', '25030', '25030']);
});

test('a market value may be supplied as integer micro-USD, and the two forms must agree', () => {
  const micro = compute([constituent({ marketValueMicro: '1000000000' })]);
  assert.equal(micro.rows[0].marketValueMicro, '1000000000');
  assert.equal(micro.numeratorUsd, 550);
  // The integer form is authoritative, and a record whose two forms disagree is
  // two different claims about one position rather than one value to pick from.
  assert.throws(() => compute([constituent({ marketValueMicro: '2000000000' })]),
    /VALUE_MICRO_DISAGREES_WITH_USD/);
  // Finer than a cent is refused rather than rounded.
  assert.throws(() => compute([constituent({ marketValueMicro: '1000000001' })]),
    /VALUE_NOT_VERIFIED_USD_CENTS/);
  // And a float is not an integer input, even when it carries the right amount.
  for (const value of [1_000_000_000, 1.5, '12.5', '1e9', {}]) {
    assert.throws(() => compute([constituent({ marketValueMicro: value })]),
      /VALUE_NOT_VERIFIED_USD_CENTS/);
  }
});

test('a denominator is required, positive and never inferred from the constituents', () => {
  assert.throws(() => compute([constituent()], { denominator: null }), /DENOMINATOR_INVALID/);
  assert.throws(() => compute([constituent()], { denominator: { components: [] } }), /DENOMINATOR_INVALID/);
  assert.throws(() => compute([constituent()],
    { denominator: { components: [{ key: 'a', label: 'x', valueUsd: 0 }] } }), /DENOMINATOR_NOT_POSITIVE/);
  // An account total is not the sum of the constituents this pane enumerates:
  // it includes cash and positions the pane never lists. Deriving one from the
  // other would silently redefine the metric.
  const pressure = compute([constituent()]);
  assert.equal(pressure.denominatorUsd, 10000);
  assert.notEqual(pressure.denominatorUsd, pressure.rows[0].marketValueUsd);
});

test('the denominator total can only be the sum of uniquely keyed components', () => {
  const of = components => compute([constituent()], { denominator: { components } });
  // Every component names itself, once, with an integer amount.
  assert.throws(() => of([{ label: 'x', valueMicro: '1' }]), /DENOMINATOR_COMPONENT_KEY_INVALID/);
  assert.throws(() => of([{ key: 'Not A Key', label: 'x', valueMicro: '10000' }]),
    /DENOMINATOR_COMPONENT_KEY_INVALID/);
  assert.throws(() => of([{ key: 'a', label: '', valueMicro: '10000' }]),
    /DENOMINATOR_COMPONENT_LABEL_REQUIRED/);
  // A repeated key double-counts one account and understates the ratio; it was
  // invisible while only the sum was published.
  assert.throws(() => of([
    { key: 'a', label: 'A', valueMicro: '10000000000' },
    { key: 'a', label: 'A again', valueMicro: '10000000000' }]), /DENOMINATOR_COMPONENT_DUPLICATE/);
  // And the total is the exact sum, never a figure supplied beside them.
  const summed = of([
    { key: 'ib-hk', label: 'IB-HK', valueMicro: '5000000000' },
    { key: 'schwab-hk', label: 'Schwab-HK', valueMicro: '3000000000' },
    { key: 'webull', label: 'Webull', valueMicro: '2000000000' }]);
  assert.equal(summed.denominatorMicro, '10000000000');
  assert.equal(summed.denominatorCents, '1000000');
  assert.equal(summed.denominatorUsd, 10000);
  assert.deepEqual(summed.denominator.components.map(item => item.key),
    ['ib-hk', 'schwab-hk', 'webull']);
});

test('an unusable market value stops the calculation instead of becoming zero', () => {
  for (const value of [null, undefined, NaN, -1, 'x', 1.005]) {
    assert.throws(() => compute([constituent({ marketValueUsd: value })]),
      /VALUE_NOT_VERIFIED_USD_CENTS|CONSTITUENT/);
  }
});

test('an unavailable scenario is reported as unavailable, never as the mid case or zero', () => {
  // One ETF look-through, which the approved material defines for the mid
  // scenario only, mixed with an ordinary tiered position.
  const pressure = compute([
    constituent({ symbol: 'MXUS', assetType: 'ETF', marketValueUsd: 1000 }),
    constituent({ symbol: 'BRK.B', holdingId: '60000002', instrumentId: '60000002', marketValueUsd: 1000 }),
  ]);
  assert.equal(pressure.scenarios.mid.available, true);
  assert.equal(pressure.scenarios.mid.numeratorUsd, 250.3 + 50);
  for (const scenario of ['low', 'high']) {
    assert.equal(pressure.scenarios[scenario].available, false);
    assert.equal(pressure.scenarios[scenario].numeratorUsd, null);
    assert.equal(pressure.scenarios[scenario].ratio, null);
    // Named, so the gap is a stated fact rather than a missing row.
    assert.deepEqual(pressure.scenarios[scenario].unavailableFor, ['936247:60000001']);
  }
  // The rendered section says so in words as well.
  const html = renderAiPressureSection(pressure, { title: 'T', asOfHkt: dataDate });
  assert.match(html, /low：不可得（1 项无该情景系数，按规则不以中情景或 0 代替）/);
});

test('an excluded constituent stays in the denominator and contributes nothing', () => {
  const pressure = compute([
    constituent(),
    // A first-seen non-stock nothing covers.
    constituent({ symbol: 'ODDETF', holdingId: '60000003', instrumentId: '60000003',
      assetType: 'ETF', firstSeen: true, marketValueUsd: 5000 }),
  ]);
  const excluded = pressure.rows.find(row => row.symbol === 'ODDETF');
  assert.equal(excluded.status, 'excluded');
  assert.equal(excluded.contributions.mid, 0);
  assert.equal(excluded.reason, 'asset-type-not-ordinary-stock');
  // Out of the numerator...
  assert.equal(pressure.numeratorUsd, 550);
  // ...and the denominator is untouched by the exclusion, which is what makes
  // an unclassified position understate the ratio rather than vanish from it.
  assert.equal(pressure.denominatorUsd, 10000);
  assert.deepEqual(pressure.excludedKeys, ['936247:60000003']);
  // It is still rendered, by name, with its reason.
  const html = renderAiPressureSection(pressure, { title: 'T', asOfHkt: dataDate });
  assert.match(html, /data-ai-status="excluded" data-ai-reason="asset-type-not-ordinary-stock"/);
  assert.match(html, /data-ai-contribution-cents="0"/);
});

test('the rendered section publishes a machine-readable form of every number it shows', () => {
  const pressure = compute([constituent()]);
  const html = renderAiPressureSection(pressure, { title: '§0-C', asOfHkt: `${dataDate} 08:00 HKT` });
  assert.match(html, /data-ai-risk-row="936247:60000001"/);
  // Money as an exact integer of micro-USD, beside the cents it displays as.
  assert.match(html, /data-ai-market-value-micro="1000000000"/);
  assert.match(html, /data-ai-market-value-cents="100000"/);
  assert.match(html, /data-ai-coefficient-bp="5500"/);
  // The exact unrounded product, beside the rounded figure the reader sees.
  assert.match(html, /data-ai-contribution-mbp="5500000000000"/);
  assert.match(html, /data-ai-contribution-cents="55000"/);
  assert.match(html, /data-ai-pressure-v1="1"/);
  assert.match(html, /data-ai-units="micro-usd:basis-points"/);
  assert.match(html, /data-ai-numerator-mbp="5500000000000"/);
  assert.match(html, /data-ai-numerator-cents="55000"/);
  assert.match(html, /data-ai-denominator-micro="10000000000"/);
  assert.match(html, /data-ai-denominator-cents="1000000"/);
  assert.match(html, /data-ai-ratio-bp="55000"/);
  assert.match(html, /data-ai-constituents="1"/);
  // The denominator is published as its own composition, in strict JSON, so the
  // gate can add the accounts up again rather than taking the total on trust.
  assert.match(html, /<p data-ai-denominator-v1="1" data-ai-denominator-total-micro="10000000000" data-ai-denominator-total-cents="1000000">/);
  assert.match(html, new RegExp(`<template id="${AI_DENOMINATOR_TEMPLATE_ID}" type="application/json">`
    + `\\[\\{"key":"synthetic-account","label":"合成账户","valueMicro":"10000000000"\\}\\]</template>`));
  // There is no parameter that supplies a total: it is derived or it is absent.
  assert.throws(() => renderAiPressureSection({ ...pressure, rows: [] },
    { title: 'x', asOfHkt: 'y' }), /PRESSURE_INVALID/);
  // And the section must be dated and titled rather than floating free.
  assert.throws(() => renderAiPressureSection(pressure, { title: '', asOfHkt: 'y' }), /TITLE_REQUIRED/);
  assert.throws(() => renderAiPressureSection(pressure, { title: 'x', asOfHkt: '' }), /AS_OF_REQUIRED/);
});

test('the computation refuses a coverage result that does not describe its own constituents', () => {
  const constituents = [constituent()];
  const coverage = buildAiTierCoverage(constituents);
  // A coverage built for a different universe cannot be used to value this one.
  assert.throws(() => computeAiPressure(
    [constituent({ holdingId: '60000009', instrumentId: '60000009' })], coverage,
    { denominator: denominator() }), /COVERAGE_ORDER_MISMATCH/);
  assert.throws(() => computeAiPressure(constituents,
    { ...coverage, entries: [...coverage.entries, coverage.entries[0]] },
    { denominator: denominator() }), /COVERAGE_LENGTH_MISMATCH/);
});

test('the registry reader refuses a policy that widens its own scope', () => {
  const reg = readAiRiskRegistry();
  // It is memoised, frozen and identical on every read.
  assert.equal(readAiRiskRegistry(), reg);
  assert.equal(Object.isFrozen(reg), true);
  assert.equal(reg.namespace, 'REG');
  // Every recorded coefficient is a real coefficient in [0,1].
  for (const entry of reg.entries.values()) {
    for (const scenario of ['low', 'mid', 'high']) {
      const value = entry.ladder[scenario];
      if (value === null) continue;
      assert.ok(value >= 0 && value <= 1, `${entry.id} ${scenario}`);
    }
    // A ladder is ordered wherever it is fully defined.
    if (entry.ladder.low !== null) {
      assert.ok(entry.ladder.low <= entry.ladder.mid && entry.ladder.mid <= entry.ladder.high, entry.id);
    }
  }
  // Custodian is part of the key, so a rule never leaks to another account.
  assert.notEqual(reg.lookup('IB-HK', 'GOOG'), null);
  assert.notEqual(reg.lookup('Webull', 'GOOG'), null);
  assert.equal(reg.lookup('Schwab-HK', 'GOOG'), null);
});
