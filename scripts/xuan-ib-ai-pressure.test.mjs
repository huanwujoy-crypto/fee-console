// Fail-closed behaviour of the AI-pressure calculation and its registry reader.
//
// These are the cases where the honest answer is "unavailable" and the tempting
// one is a number. Every one of them must refuse rather than round, default or
// zero-fill: a risk metric that quietly substitutes zero for an input it could
// not resolve understates exactly the thing it exists to measure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAiTierCoverage } from './xuan-ib-ai-tier-coverage.mjs';
import { computeAiPressure, renderAiPressureSection } from './xuan-ib-ai-pressure.mjs';
import { readAiRiskRegistry } from './xuan-ib-ai-risk-registry.mjs';

const dataDate = '2026-09-11';
const constituent = (over = {}) => ({ symbol: 'GOOG', custodian: 'IB-HK', venue: 'NASDAQ',
  portfolioId: '936247', holdingId: '60000001', instrumentId: '60000001', currency: 'USD',
  assetType: 'STK', marketValueUsd: 1000, valueDate: dataDate, identityVerified: true,
  firstSeen: false, ...over });
const denominator = () => ({ components: [{ label: '合成账户', valueUsd: 10000 }] });
const compute = (constituents, options = {}) =>
  computeAiPressure(constituents, buildAiTierCoverage(constituents),
    { denominator: denominator(), ...options });

test('the calculation is pure: identical inputs give byte-identical output', () => {
  const first = compute([constituent()]);
  const second = compute([constituent()]);
  assert.deepEqual(first, second);
  assert.equal(first.numeratorUsd, 550);
  assert.equal(first.ratio, 0.055);
  // Exact cents, not binary drift: 0.2503 x a value whose product is awkward.
  const etf = compute([constituent({ symbol: 'EXUS', assetType: 'ETF', marketValueUsd: 405988 })]);
  assert.equal(etf.rows[0].contributions.mid, 24399.878_8);
});

test('a denominator is required, positive and never inferred from the constituents', () => {
  assert.throws(() => compute([constituent()], { denominator: null }), /DENOMINATOR_INVALID/);
  assert.throws(() => compute([constituent()], { denominator: { components: [] } }), /DENOMINATOR_INVALID/);
  assert.throws(() => compute([constituent()],
    { denominator: { components: [{ label: 'x', valueUsd: 0 }] } }), /DENOMINATOR_NOT_POSITIVE/);
  // An account total is not the sum of the constituents this pane enumerates:
  // it includes cash and positions the pane never lists. Deriving one from the
  // other would silently redefine the metric.
  const pressure = compute([constituent()]);
  assert.equal(pressure.denominatorUsd, 10000);
  assert.notEqual(pressure.denominatorUsd, pressure.rows[0].marketValueUsd);
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
  assert.match(html, /data-ai-market-value-cents="100000"/);
  assert.match(html, /data-ai-coefficient-bp="5500"/);
  assert.match(html, /data-ai-contribution-cents="55000"/);
  assert.match(html, /data-ai-pressure-v1="1"/);
  assert.match(html, /data-ai-numerator-cents="55000"/);
  assert.match(html, /data-ai-denominator-cents="1000000"/);
  assert.match(html, /data-ai-ratio-bp="55000"/);
  assert.match(html, /data-ai-constituents="1"/);
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
