// Independent adversarial tests: synthetic metadata only, no financial reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateWeeklySnapshot, mondayOfHktInstant, WEEKLY_SNAPSHOT_KIND } from './xuan-ib-weekly-snapshot.mjs';

const registry = JSON.parse(fs.readFileSync(new URL('../claude/xuan-ib-portfolio-registry.json', import.meta.url)));
const nowMs = Date.parse('2026-09-15T00:00:00Z');
const fixture = () => ({
  schemaVersion: 1, kind: WEEKLY_SNAPSHOT_KIND,
  captureWeekOfMondayHkt: '2026-09-07', capturedAt: '2026-09-07T02:00:00Z',
  portfolios: registry.portfolios.filter(p => p.requiredEachReport).map(p => ({
    portfolioId: p.portfolioId, role: p.role, status: 'ok', fingerprint: 'a'.repeat(64),
    readCompletedAt: '2026-09-07T01:00:00Z', valuationDate: '2026-09-04',
  })),
});

test('weekly boundary is HKT Monday while UTC is still Sunday', () => {
  assert.equal(mondayOfHktInstant(Date.parse('2026-09-06T15:59:59Z')), '2026-08-31');
  assert.equal(mondayOfHktInstant(Date.parse('2026-09-06T16:00:00Z')), '2026-09-07');
});

for (const [name, change] of [
  ['receipt completes after envelope capture', s => { s.portfolios[0].readCompletedAt = '2026-09-08T01:00:00Z'; }],
  ['old receipt relabeled under a newer capture week', s => { s.portfolios[0].readCompletedAt = '2026-08-31T01:00:00Z'; }],
  ['envelope capture belongs to a different week', s => { s.capturedAt = '2026-09-14T02:00:00Z'; }],
]) test(`reject inconsistent weekly chronology: ${name}`, () => {
  const s = fixture(); change(s);
  assert.throws(() => validateWeeklySnapshot(s, registry, { nowMs }));
});

test('weekly validator rejects invalid clocks rather than disabling future checks', () => {
  for (const clock of [NaN, Infinity, -1, '2026-09-15']) {
    assert.throws(() => validateWeeklySnapshot(fixture(), registry, { nowMs: clock }));
  }
});

test('native valuation cannot be later than its own source read', () => {
  const s = fixture();
  s.capturedAt = '2026-09-09T02:00:00Z';
  s.portfolios[0].valuationDate = '2026-09-09';
  assert.throws(() => validateWeeklySnapshot(s, registry, { nowMs }));
});
