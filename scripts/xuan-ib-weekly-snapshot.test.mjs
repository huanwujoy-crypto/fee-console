import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  validateWeeklySnapshot, resolveWeeklySnapshot, assertWeekAdvances,
  mondayOfHktInstant, mondayOfHktDate, isMondayHkt, WEEKLY_SNAPSHOT_KIND
} from './xuan-ib-weekly-snapshot.mjs';

const registry = JSON.parse(fs.readFileSync(new URL('../claude/xuan-ib-portfolio-registry.json', import.meta.url)));
const required = registry.portfolios.filter(p => p.requiredEachReport === true);
const NOW = Date.parse('2026-09-09T05:00:00Z');           // Wed 13:00 HKT
const CUR = mondayOfHktInstant(NOW);                       // current-week Monday (HKT)
const PREV = mondayOfHktDate(new Date(Date.parse(`${CUR}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10));
const NEXT = mondayOfHktDate(new Date(Date.parse(`${CUR}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10));
const HEX = 'a'.repeat(64);

const snap = (over = {}) => ({
  schemaVersion: 1, kind: WEEKLY_SNAPSHOT_KIND,
  captureWeekOfMondayHkt: CUR, capturedAt: `${CUR}T02:00:00Z`,
  portfolios: required.map(p => ({
    portfolioId: p.portfolioId, role: p.role,
    readCompletedAt: `${CUR}T02:00:00Z`,
    valuationDate: '2026-09-04',   // a Friday: proves valuation is NOT forced to Monday
    fingerprint: HEX, status: 'ok'
  })),
  ...over
});
const storeOf = s => ({ loadLatest: () => s });

test('Monday helpers: week key must be a Monday HKT', () => {
  assert.equal(isMondayHkt(CUR), true);
  assert.equal(weekdayIsMonday(CUR), true);
  assert.equal(isMondayHkt('2026-09-04'), false); // Friday
});
function weekdayIsMonday(d) { return new Date(`${d}T00:00:00Z`).getUTCDay() === 1; }

test('valid current snapshot validates; native Friday valuation preserved, not forced to Monday', () => {
  const s = snap();
  assert.doesNotThrow(() => validateWeeklySnapshot(s, registry, { nowMs: NOW }));
  const r = resolveWeeklySnapshot(registry, { nowMs: NOW, store: storeOf(s) });
  assert.equal(r.status, 'current');
  assert.equal(r.captureWeekOfMondayHkt, CUR);
  assert.equal(r.portfolios.length, required.length);
  assert.equal(r.portfolios[0].valuationDate, '2026-09-04');    // preserved, not Monday
  assert.notEqual(r.portfolios[0].valuationDate, CUR);
});

test('no store => durable cache explicitly not activated (degraded path)', () => {
  const r = resolveWeeklySnapshot(registry, { nowMs: NOW, store: null });
  assert.equal(r.status, 'unavailable');
  assert.equal(r.reason, 'DURABLE_CACHE_NOT_ACTIVATED');
});

test('missing snapshot in store => unavailable, not fabricated', () => {
  const r = resolveWeeklySnapshot(registry, { nowMs: NOW, store: storeOf(null) });
  assert.equal(r.status, 'unavailable');
  assert.equal(r.reason, 'SNAPSHOT_MISSING');
});

test('previous-week snapshot is usable but returned as explicitly dated stale; dates not advanced', () => {
  const s = snap({ captureWeekOfMondayHkt: PREV, capturedAt: `${PREV}T02:00:00Z`,
    portfolios: snap().portfolios.map(p => ({ ...p, readCompletedAt: `${PREV}T02:00:00Z`, valuationDate: '2026-08-28' })) });
  const r = resolveWeeklySnapshot(registry, { nowMs: NOW, store: storeOf(s) });
  assert.equal(r.status, 'stale');
  assert.equal(r.captureWeekOfMondayHkt, PREV);   // NOT promoted to current Monday
  assert.equal(r.currentMonday, CUR);
  assert.equal(r.portfolios[0].readCompletedAt, `${PREV}T02:00:00Z`);
  assert.equal(r.portfolios[0].valuationDate, '2026-08-28'); // stale native date, never advanced
});

test('future-dated snapshot rejected (a future week implies a future capture)', () => {
  const s = snap({ captureWeekOfMondayHkt: NEXT, capturedAt: `${NEXT}T02:00:00Z`,
    portfolios: snap().portfolios.map(p => ({ ...p, readCompletedAt: `${NEXT}T02:00:00Z` })) });
  const r = resolveWeeklySnapshot(registry, { nowMs: NOW, store: storeOf(s) });
  assert.equal(r.status, 'unavailable');
  assert.equal(r.reason, 'CAPTURED_AT_IN_FUTURE');
});

test('partial snapshot is never complete', () => {
  const s = snap(); s.portfolios = s.portfolios.slice(0, required.length - 1);
  assert.throws(() => validateWeeklySnapshot(s, registry, { nowMs: NOW }), /SNAPSHOT_INCOMPLETE/);
  assert.equal(resolveWeeklySnapshot(registry, { nowMs: NOW, store: storeOf(s) }).reason, 'SNAPSHOT_INCOMPLETE');
});

test('excluded scope, unknown, duplicate, and role mismatch rejected', () => {
  const excluded = snap(); excluded.portfolios[0] = { ...excluded.portfolios[0], portfolioId: 1021747 };
  assert.throws(() => validateWeeklySnapshot(excluded, registry, { nowMs: NOW }), /UNEXPECTED_PORTFOLIO/);
  const dup = snap(); dup.portfolios[1] = { ...dup.portfolios[0] };
  assert.throws(() => validateWeeklySnapshot(dup, registry, { nowMs: NOW }), /DUPLICATE/);
  const role = snap(); role.portfolios[0] = { ...role.portfolios[0], role: role.portfolios[0].role === 'family' ? 'ai_only' : 'family' };
  assert.throws(() => validateWeeklySnapshot(role, registry, { nowMs: NOW }), /ROLE_MISMATCH/);
});

test('non-Monday week key, future dates, and bad fingerprint rejected', () => {
  assert.throws(() => validateWeeklySnapshot(snap({ captureWeekOfMondayHkt: '2026-09-04' }), registry, { nowMs: NOW }), /WEEK_KEY_NOT_MONDAY_HKT/);
  assert.throws(() => validateWeeklySnapshot(snap({ capturedAt: `${NEXT}T02:00:00Z` }), registry, { nowMs: NOW }), /CAPTURED_AT_IN_FUTURE/);
  const futVal = snap(); futVal.portfolios[0] = { ...futVal.portfolios[0], valuationDate: '2026-12-31' };
  assert.throws(() => validateWeeklySnapshot(futVal, registry, { nowMs: NOW }), /VALUATION_IN_FUTURE/);
  const badFp = snap(); badFp.portfolios[0] = { ...badFp.portfolios[0], fingerprint: 'xyz' };
  assert.throws(() => validateWeeklySnapshot(badFp, registry, { nowMs: NOW }), /FINGERPRINT/);
});

test('production monotonic guard: week must strictly advance, reuse never rewrites', () => {
  const prev = snap({ captureWeekOfMondayHkt: PREV });
  assert.doesNotThrow(() => assertWeekAdvances(prev, snap({ captureWeekOfMondayHkt: CUR })));
  assert.throws(() => assertWeekAdvances(prev, snap({ captureWeekOfMondayHkt: PREV })), /WEEK_NOT_ADVANCED/);
  assert.throws(() => assertWeekAdvances(snap({ captureWeekOfMondayHkt: CUR }), snap({ captureWeekOfMondayHkt: PREV })), /WEEK_NOT_ADVANCED/);
});
