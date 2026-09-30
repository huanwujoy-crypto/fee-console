import test from 'node:test';
import assert from 'node:assert/strict';
import {marketOpen, planPreopen} from './calendar.mjs';
test('regular and Monday plans request the latest completed US session', () => {
  assert.equal(planPreopen(Date.parse('2026-10-01T05:00:00Z')).sourceDate, '2026-09-30');
  assert.equal(planPreopen(Date.parse('2026-10-05T05:00:00Z')).sourceDate, '2026-10-02');
});
test('US holidays still generate when Europe is open, with Friday US values', () => {
  const plan = planPreopen(Date.parse('2026-09-07T05:00:00Z'));
  assert.deepEqual(plan.openMarkets, ['XETRA']); assert.equal(plan.sourceDate, '2026-09-04');
});
test('weekends and joint holidays take no action; early-close sessions still count', () => {
  for (const date of ['2026-10-03','2026-04-03','2026-12-25']) assert.equal(planPreopen(Date.parse(date+'T05:00:00Z')).status, 'no-action');
  assert.equal(marketOpen('2026-12-24', 'NYSE'), true);
  assert.equal(marketOpen('2026-12-24', 'XETRA'), false);
  assert.equal(marketOpen('2027-12-31', 'NYSE'), true); // No Friday observance of Saturday New Year.
});
test('invalid dates and unreviewed years never become assumed trading days', () => {
  for (const date of ['2026-02-30','2029-01-02','not-a-date']) assert.throws(() => marketOpen(date, 'NYSE'), /CALENDAR/);
});
