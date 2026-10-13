import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAppReadiness, feeBenchmarkCheck, feeClassificationCheck } from './app-readiness.mjs';

const targetDate = '2026-10-12';
const ready = () => ({ status: 'ready', code: 'READY' });
const snapshot = () => ({ date: targetDate, sourceDates: { schwab: targetDate, webull: targetDate }, stock: 300,
  now: new Date('2026-10-13T00:00:00Z'),
  staticMap: { schemaVersion: 1, effectiveDate: '2026-08-28', holdings: [] },
  input: { schemaVersion: 1, date: targetDate, proposals: [], portfolios: [
    { account: 'schwab', portfolioId: 936249, sourceDate: targetDate, stockTotalUsd: 100,
      holdings: [{ holdingId: 1, ticker: 'TESTA', valueUsd: 100 }] },
    { account: 'webull', portfolioId: 1350094, sourceDate: targetDate, stockTotalUsd: 200,
      holdings: [{ holdingId: 2, ticker: 'TESTB', valueUsd: 200 }] },
  ] } });
const cache = date => ({ v: 1, benchmarks: {
  spy: { series: [{ d: date, p: 100 }] }, qqq: { series: [{ d: date, p: 200 }] },
} });

test('one pass exposes benchmark, cash and classification blockers together without writer or identity output', async () => {
  const visits = [], f = snapshot(), before = structuredClone(f);
  const probes = Object.fromEntries(['publication', 'benchmark', 'source-identity', 'source-dates',
    'source-stability', 'economic-source', 'cash', 'classification'].map(name => [name, async () => {
    visits.push(name);
    if (name === 'benchmark') return feeBenchmarkCheck(cache('2026-10-09'), targetDate);
    if (name === 'cash') return { status: 'blocked', code: 'CASH_RECONCILIATION' };
    if (name === 'classification') return feeClassificationCheck(f);
    return ready();
  }]));
  const result = await collectAppReadiness({ app: 'fee', profile: 'fee', targetDate, probes });
  assert.equal(visits.length, 8);
  assert.deepEqual(result.unresolvedChecks, ['benchmark', 'cash', 'classification']);
  assert.equal(result.checks.at(-1).missingCount, 2);
  assert.equal(result.grantsPublication, false);
  assert.equal(result.allChecksReady, false);
  assert.doesNotMatch(JSON.stringify(result), /TESTA|TESTB|936249|1350094|valueUsd|stockTotalUsd/);
  assert.deepEqual(f, before);
});

test('exceptions, unavailable dependencies and omitted probes remain separate, all later probes execute', async () => {
  let later = false;
  const r = await collectAppReadiness({ app: 'fee', profile: 'fee', targetDate, probes: {
    benchmark: () => { throw Error('private amount 999999 and token secret'); },
    cash: () => ({ status: 'unavailable', code: 'DEPENDENCY_UNAVAILABLE' }),
    classification: () => { later = true; return ready(); },
  } });
  assert.equal(later, true);
  assert.equal(r.checks.find(c => c.name === 'benchmark').code, 'CHECK_FAILED');
  assert.equal(r.checks.find(c => c.name === 'cash').status, 'unavailable');
  assert.equal(r.checks.find(c => c.name === 'source-dates').status, 'not-checked');
  assert.doesNotMatch(JSON.stringify(r), /999999|secret|token/);
});

test('all checks reported ready remain observation only; IB keeps its existing classification gate', async () => {
  const names = ['account-association', 'ib-positions', 'ib-orders', 'source-dates',
    'source-stability', 'classification', 'supporting-data', 'publication'];
  const r = await collectAppReadiness({ app: 'ib', profile: 'ib-live', targetDate, probes: Object.fromEntries(names.map(n => [n, ready])) });
  assert.equal(r.allChecksReady, true);
  assert.equal(r.status, 'observation-only');
  assert.equal(r.grantsPublication, false);
  assert.equal(r.classificationImpact, 'use-existing-ib-classification-and-section-gates');
});

test('target close must exist once for both ETFs; malformed, duplicate and partial caches never pass', () => {
  assert.deepEqual(feeBenchmarkCheck(cache(targetDate), targetDate), ready());
  const variants = [null, cache('2026-10-09'), cache(targetDate), cache(targetDate), cache(targetDate)];
  variants[2].benchmarks.spy.series.push({ d: targetDate, p: 100 });
  variants[3].benchmarks.qqq.series[0].p = 0;
  variants[4].benchmarks.qqq.series[0].div = -1;
  for (const v of variants) assert.equal(feeBenchmarkCheck(v, targetDate).status, 'blocked');
});

test('real resolver accepts reviewed metadata but diagnostics never persist it or return financial totals', () => {
  const f = snapshot();
  f.staticMap.holdings = [{ portfolioId: 936249, holdingId: 1, ticker: 'TESTA', style: 'value' },
    { portfolioId: 1350094, holdingId: 2, ticker: 'TESTB', style: 'growth' }];
  const before = structuredClone(f);
  assert.deepEqual(feeClassificationCheck(f), ready());
  assert.deepEqual(f, before);
  f.input.portfolios[1].holdings[0].ticker = 'TESTC';
  assert.equal(feeClassificationCheck(f).code, 'CLASSIFICATION_INVALID');
});

test('unknown probes and invalid dates fail closed; accidental payload fields are safely collapsed', async () => {
  await assert.rejects(collectAppReadiness({ app: 'fee', profile: 'fee', targetDate, probes: { trade: ready } }), /INVALID_INPUT/);
  await assert.rejects(collectAppReadiness({ app: 'fee', profile: 'fee', targetDate: '2026-02-30', probes: {} }), /INVALID_INPUT/);
  const r = await collectAppReadiness({ app: 'fee', profile: 'fee', targetDate, probes: {
    cash: () => ({ ...ready(), amount: 12345 }),
  } });
  assert.equal(r.checks.find(c => c.name === 'cash').code, 'CHECK_FAILED');
  assert.doesNotMatch(JSON.stringify(r), /12345|amount/);
});

test('EOD diagnostics require explicit EOD profile and never turn missing optional live data into a live-source requirement', async () => {
  const r = await collectAppReadiness({ app: 'ib', profile: 'ib-eod', targetDate, probes: {
    'flex-archive': ready,
    'optional-live': () => ({ status: 'unavailable', code: 'OPTIONAL_LIVE' }),
  } });
  assert.ok(r.checks.some(c => c.name === 'flex-archive'));
  assert.ok(!r.checks.some(c => c.name === 'ib-positions'));
  assert.equal(r.grantsPublication, false);
  await assert.rejects(collectAppReadiness({ app: 'ib', profile: 'fee', targetDate, probes: {} }), /INVALID_INPUT/);
  await assert.rejects(collectAppReadiness({ app: 'ib', targetDate, probes: {} }), /INVALID_INPUT/);
});
