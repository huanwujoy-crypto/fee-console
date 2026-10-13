import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseAppRun, sourceRetryDecision, feeDiagnosticCode } from './app-run-diagnostics.mjs';

const iso = hour => `2026-10-13T${String(hour).padStart(2, '0')}:00:00.000Z`;
const fixture = () => ({ app: 'fee', targetDate: '2026-10-12', scheduledAt: iso(2),
  deadlineAt: iso(3), now: iso(4), coverage: 'complete', runs: [],
  publicationVerified: false, previousAlert: null });
const run = (id, status = 'completed', outcome = 'failure', code = 'UNKNOWN') => ({
  id, attempt: 1, targetDate: '2026-10-12', attemptAt: `2026-10-13T02:${String(id).padStart(2, '0')}:00.000Z`,
  status, outcome, code,
});

test('no-start, unavailable observation, queue delay and execution delay are distinct incidents', () => {
  assert.equal(diagnoseAppRun(fixture()).reason, 'not-started');
  assert.equal(diagnoseAppRun({ ...fixture(), coverage: 'unavailable' }).reason, 'observation-unavailable');
  for (const status of ['queued', 'in-progress']) {
    const r = diagnoseAppRun({ ...fixture(), runs: [run(1, status, null, null)] });
    assert.equal(r.state, status); assert.equal(r.reason, `${status}-late`);
  }
  assert.equal(diagnoseAppRun({ ...fixture(), now: iso(1) }).state, 'not-due');
});

test('metadata failures stop immediately; temporary source failure retries only once', () => {
  for (const code of ['CLASSIFICATION_MISSING', 'CASH_RECONCILIATION', 'SOURCE_IDENTITY', 'SOURCE_DATE']) {
    assert.equal(sourceRetryDecision(code, 1).action, 'stop');
    const r = diagnoseAppRun({ ...fixture(), now: '2026-10-13T02:59:00.000Z', runs: [run(1, 'completed', 'failure', code)] });
    assert.equal(r.reason, 'blocked');
  }
  assert.equal(sourceRetryDecision('SOURCE_TIMEOUT', 1).action, 'retry-once');
  assert.equal(sourceRetryDecision('SOURCE_TIMEOUT', 2).action, 'stop');
  assert.equal(sourceRetryDecision('arbitrary private exception', 1).action, 'stop');
});

test('second failure escalates before deadline; skipped and cancelled attempts never manufacture a failure', () => {
  const base = { ...fixture(), now: '2026-10-13T02:59:00.000Z' };
  assert.equal(diagnoseAppRun({ ...base, runs: [run(1)] }).reason, null);
  assert.equal(diagnoseAppRun({ ...base, runs: [run(1), run(2, 'completed', 'timed-out')] }).reason, 'second-failure');
  assert.equal(diagnoseAppRun({ ...base, runs: [run(1), run(2, 'completed', 'skipped')] }).reason, null);
  assert.equal(diagnoseAppRun({ ...base, runs: [run(1), run(2, 'completed', 'cancelled')] }).reason, null);
});

test('green candidate/reuse does not prove publication; verified current public receipt permits observation of recovery only', () => {
  for (const outcome of ['candidate', 'reused', 'skipped']) {
    assert.equal(diagnoseAppRun({ ...fixture(), runs: [run(1, 'completed', outcome, null)] }).reason, 'publication-unverified');
  }
  const r = diagnoseAppRun({ ...fixture(), publicationVerified: true });
  assert.equal(r.state, 'published'); assert.equal(r.alertAction, 'none');
  assert.equal(r.closesExistingAlert, false); assert.equal(r.dispatchesProduction, false);
});

test('one target incident is deduplicated; changing its cause updates the same key', () => {
  const first = diagnoseAppRun(fixture());
  const previousAlert = { key: first.alertKey, reason: first.reason };
  assert.equal(first.alertAction, 'create');
  assert.equal(diagnoseAppRun({ ...fixture(), previousAlert }).alertAction, 'none');
  const changed = diagnoseAppRun({ ...fixture(), previousAlert,
    runs: [run(1, 'completed', 'failure', 'CLASSIFICATION_MISSING')] });
  assert.equal(changed.alertKey, first.alertKey); assert.equal(changed.alertAction, 'update');
});

test('wrong target, duplicates, future times, extra payloads and unknown codes reject rather than leak into diagnostics', () => {
  const bad = [
    { ...fixture(), runs: [{ ...run(1), targetDate: '2026-10-09' }] },
    { ...fixture(), runs: [run(1), run(1)] },
    { ...fixture(), runs: [{ ...run(1), attemptAt: iso(5) }] },
    { ...fixture(), runs: [{ ...run(1), code: 'private token secret' }] },
    { ...fixture(), amount: 9999 },
    { ...fixture(), runs: [{ ...run(1), amount: 9999 }] },
    { ...fixture(), deadlineAt: iso(2) },
  ];
  for (const value of bad) assert.throws(() => diagnoseAppRun(value), /INVALID_INPUT/);
  assert.throws(() => sourceRetryDecision('SOURCE_TIMEOUT', 3), /INVALID_INPUT/);
});

test('IB incidents have separate keys and cannot reuse fee alert state', () => {
  assert.equal(diagnoseAppRun({ ...fixture(), app: 'ib' }).alertKey, 'ib:2026-10-12');
  assert.throws(() => diagnoseAppRun({ ...fixture(), app: 'ib',
    previousAlert: { key: 'fee:2026-10-12', reason: 'not-started' } }), /INVALID_INPUT/);
});

test('skip, cancellation, candidate, reuse and a new queued attempt cannot hide prior blockers or second failure', () => {
  const base = { ...fixture(), now: '2026-10-13T02:59:00.000Z' };
  const later = [run(3, 'queued', null, null), ...['skipped', 'cancelled', 'candidate', 'reused']
    .map(outcome => run(3, 'completed', outcome, null))];
  for (const latest of later) {
    assert.equal(diagnoseAppRun({ ...base, runs: [run(1), run(2), latest] }).reason, 'second-failure');
    assert.equal(diagnoseAppRun({ ...base, runs: [run(1, 'completed', 'failure', 'CLASSIFICATION_MISSING'), latest] }).reason, 'blocked');
  }
});

test('real coarse fee codes map safely without fabricating missing holding evidence or echoing raw text', () => {
  assert.equal(feeDiagnosticCode('FEE_CLOUD_WRITER_PREFLIGHT_STYLE'), 'CLASSIFICATION_INVALID');
  assert.equal(feeDiagnosticCode('FEE_CLOUD_CASH_RECONCILIATION'), 'CASH_RECONCILIATION');
  assert.equal(feeDiagnosticCode('FEE_CLOUD_BENCHMARK_PENDING'), 'BENCHMARK_PENDING');
  assert.equal(feeDiagnosticCode('FEE_CLOUD_SOURCE_UNAVAILABLE'), 'FEE_CLOUD_SOURCE_UNAVAILABLE');
  assert.equal(feeDiagnosticCode('error private amounts and key'), 'UNKNOWN');
});

test('distinct rerun attempts use their actual attempt times, not the original run creation timestamp', () => {
  const first = run(1), again = { ...first, attempt: 2, attemptAt: '2026-10-13T02:05:00.000Z' };
  assert.equal(diagnoseAppRun({ ...fixture(), runs: [first, again] }).reason, 'second-failure');
});
