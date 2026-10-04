import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { weeklyHealth, checkWeekly, REPORT_URL } from './xuan-weekly-publish-health.mjs';

const fixture = (overrides = {}) => new Headers({
  'x-goog-meta-started_at': '2026-10-04T06:02:44.242480+00:00',
  'x-goog-meta-risk_date': '2026-10-02', 'x-goog-meta-abc_date': '2026-10-02',
  'x-goog-meta-sha256': 'a'.repeat(64), ...overrides,
});
const evaluate = (headers = fixture(), now = '2026-10-04T06:04:00Z', status = 200) =>
  weeklyHealth({ status, headers, now });

test('current weekly publication is recognized without reading report amounts', () => {
  assert.equal(evaluate().code, 'weekly_public_current');
  assert.equal(evaluate().complete, true);
});
test('Sunday HKT schedule and existing timeout window bind freshness', () => {
  const old = fixture({ 'x-goog-meta-started_at': '2026-09-30T08:14:15Z',
    'x-goog-meta-risk_date': '2026-09-29', 'x-goog-meta-abc_date': '2026-09-28' });
  assert.equal(evaluate(old, '2026-10-04T02:14:59Z').code, 'within_publication_window');
  assert.equal(evaluate(old, '2026-10-04T02:15:00Z').code, 'weekly_public_stale');
  assert.equal(evaluate(old).expectedStart, '2026-10-04T02:00:00.000Z');
  assert.equal(evaluate(fixture(), '2026-10-11T01:59:59Z').code, 'weekly_public_current');
});
test('unavailable, bad, future and regressing source evidence fail closed', () => {
  assert.equal(evaluate(fixture(), undefined, 503).code, 'weekly_public_unavailable');
  const invalid = evaluate(fixture({ 'x-goog-meta-started_at': 'DO_NOT_LOG' }));
  assert.equal(invalid.code, 'weekly_public_metadata_invalid');
  assert.ok(!JSON.stringify(invalid).includes('DO_NOT_LOG'));
  assert.equal(evaluate(fixture({ 'x-goog-meta-started_at': '2026-10-05T06:00:00Z' })).code, 'weekly_public_future_run');
  assert.equal(evaluate(fixture({ 'x-goog-meta-risk_date': '2026-09-29' })).code, 'weekly_public_source_dates_invalid');
  assert.equal(evaluate(fixture({ 'x-goog-meta-abc_date': '2026-09-28' })).code, 'weekly_public_source_dates_invalid');
});
test('checker uses only the fixed anonymous HEAD and hides network exception text', async () => {
  let observed;
  await checkWeekly(async (...args) => { observed = args; return { status: 200, headers: fixture() }; });
  assert.equal(observed[0], REPORT_URL);
  assert.equal(observed[1].method, 'HEAD');
  assert.equal(observed[1].redirect, 'error');
  assert.equal(observed[1].headers, undefined);
  const failed = await checkWeekly(async () => { throw new Error('DO_NOT_LOG'); });
  assert.deepEqual(failed, { complete: false, code: 'weekly_public_check_failed' });
});
test('manual notification adapter has no new schedule, secret or external destination', () => {
  const workflow = readFileSync(new URL('../.github/workflows/watch-xuan-weekly.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /ref: main/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /^\s*(?:schedule:|cron:)/m);
  assert.doesNotMatch(workflow, /secrets\.|id-token:|issues: write|curl|webhook/i);
});
