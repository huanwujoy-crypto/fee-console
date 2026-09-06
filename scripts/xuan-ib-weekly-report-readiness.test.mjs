import test from 'node:test';
import assert from 'node:assert/strict';
import { composeWeeklyReportReadiness } from './xuan-ib-weekly-report-readiness.mjs';

const ib = (over = {}) => ({ blocked: false, degraded: false, positionSource: 'ib', issues: [], ...over });
const weeklyCurrent = { status: 'current', captureWeekOfMondayHkt: '2026-09-07', portfolios: [{ portfolioId: 936238, valuationDate: '2026-09-04' }] };
const weeklyStale = { status: 'stale', captureWeekOfMondayHkt: '2026-08-31', currentMonday: '2026-09-07', portfolios: [] };
const weeklyUnavail = { status: 'unavailable', reason: 'DURABLE_CACHE_NOT_ACTIVATED' };

test('IB healthy + current weekly => publishable, not degraded, provenance weekly-current', () => {
  const r = composeWeeklyReportReadiness(ib(), weeklyCurrent);
  assert.equal(r.blocked, false);
  assert.equal(r.degraded, false);
  assert.equal(r.ssProvenance, 'weekly-current');
  assert.equal(r.ssUsable, true);
  assert.equal(r.positionSource, 'ib');
});

test('IB healthy + stale weekly => publishable but degraded, usable-yet-dated, issue recorded', () => {
  const r = composeWeeklyReportReadiness(ib(), weeklyStale);
  assert.equal(r.blocked, false);
  assert.equal(r.degraded, true);
  assert.equal(r.ssProvenance, 'weekly-stale');
  assert.equal(r.ssUsable, true);
  assert.ok(r.issues.some(i => i.startsWith('SS_WEEKLY_STALE:2026-08-31')));
});

test('IB healthy + unavailable weekly => publishable, degraded, SS not usable', () => {
  const r = composeWeeklyReportReadiness(ib(), weeklyUnavail);
  assert.equal(r.blocked, false);
  assert.equal(r.degraded, true);
  assert.equal(r.ssProvenance, 'unavailable');
  assert.equal(r.ssUsable, false);
  assert.equal(r.ssValuation, null);
  assert.ok(r.issues.some(i => i === 'SS_WEEKLY_UNAVAILABLE:DURABLE_CACHE_NOT_ACTIVATED'));
});

test('IB drives publication: blocked IB => blocked report regardless of weekly', () => {
  assert.equal(composeWeeklyReportReadiness(ib({ blocked: true, degraded: true, positionSource: 'unavailable' }), weeklyCurrent).blocked, true);
});

test('weekly SS never becomes a positions fallback; positionSource carried from IB only', () => {
  assert.equal(composeWeeklyReportReadiness(ib({ positionSource: 'sharesight-ib-hk', degraded: true }), weeklyCurrent).positionSource, 'sharesight-ib-hk');
  // even a current weekly snapshot does not set positions to a sharesight-weekly source
  assert.equal(composeWeeklyReportReadiness(ib(), weeklyCurrent).positionSource, 'ib');
});

test('invalid inputs rejected', () => {
  assert.throws(() => composeWeeklyReportReadiness({ blocked: false }, weeklyCurrent), /INVALID_IB_READINESS/);
  assert.throws(() => composeWeeklyReportReadiness(ib({ positionSource: 'sharesight-weekly' }), weeklyCurrent), /INVALID_IB_READINESS/);
  assert.throws(() => composeWeeklyReportReadiness(ib(), { status: 'bogus' }), /INVALID_WEEKLY_STATUS/);
});
