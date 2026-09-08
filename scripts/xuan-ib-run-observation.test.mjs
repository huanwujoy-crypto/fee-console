import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { summarizeRunObservation, OBSERVED_RUN_TARGET_MS } from './xuan-ib-run-observation.mjs';

const options = { now: '2026-09-08T02:00:00.000Z' };
const iso = minutes => new Date(Date.parse('2026-09-08T00:00:00.000Z') + minutes * 60_000).toISOString();
const clone = value => JSON.parse(JSON.stringify(value));
const attempt = (attemptId, minutes, outcome = 'completed') => ({ attemptId, startedAt: minutes === null ? null : iso(minutes), outcome });
const readback = minutes => ({ verifiedAt: iso(minutes), sourceSha: 'a'.repeat(40), htmlBlob: 'b'.repeat(40), evidenceId: 'synthetic-readback-1', bytesMatched: true });
const record = () => ({ schemaVersion: 1, scheduledAt: iso(0), attempts: [attempt('attempt-1', 5)], publicReadback: readback(20) });
const summarize = value => summarizeRunObservation(value, options);

test('no data stays not-recorded and is never a zero-duration passing run', () => {
  const result = summarize({ schemaVersion: 1, scheduledAt: null, attempts: [], publicReadback: null });
  assert.equal(result.status, 'observation-only');
  assert.equal(result.firstStartedAt, null);
  assert.equal(result.publicVerifiedAt, null);
  assert.equal(result.publicEvidence, null);
  assert.equal(result.scheduledDelay.status, 'not-recorded');
  assert.equal(result.scheduledDelay.durationMs, null);
  assert.equal(result.wholeRun.durationMs, null);
  assert.equal(result.wholeRun.timingResult, 'not-recorded');
});

test('scheduler delay is separate from first actual start through public verification', () => {
  const result = summarize(record());
  assert.equal(result.scheduledDelay.durationMs, 5 * 60_000);
  assert.equal(result.wholeRun.durationMs, 15 * 60_000);
  assert.equal(result.wholeRun.timingResult, 'pass');
  assert.equal(result.firstStartedAt, iso(5));
  assert.equal(result.publicVerifiedAt, iso(20));
  assert.match(result.verificationBasis, /not-independent-cryptographic-proof/);
  assert.deepEqual(result.publicEvidence, { sourceSha: 'a'.repeat(40), htmlBlob: 'b'.repeat(40), evidenceId: 'synthetic-readback-1' });
});

test('failed attempts, retry gaps and waits are included rather than resetting the clock', () => {
  const value = record();
  value.attempts = [attempt('attempt-1', 5, 'failed'), attempt('attempt-2', 15, 'failed'),
    attempt('attempt-3', 26, 'failed'), attempt('attempt-4', 29)];
  value.publicReadback = readback(43);
  const result = summarize(value);
  assert.equal(result.attemptCount, 4);
  assert.equal(result.failedAttemptCount, 3);
  assert.equal(result.firstStartedAt, iso(5));
  assert.equal(result.wholeRun.durationMs, 38 * 60_000);
  assert.equal(result.wholeRun.timingResult, 'fail', 'a 14-minute final retry must not erase the failed original attempt');
});

for (const [elapsed, expected] of [[0, 'pass'], [1_199_999, 'pass'], [1_200_000, 'pass'], [1_200_001, 'fail']]) {
  test(`20-minute timing boundary at ${elapsed} milliseconds`, () => {
    const value = record();
    value.publicReadback.verifiedAt = new Date(Date.parse(value.attempts[0].startedAt) + elapsed).toISOString();
    const result = summarize(value);
    assert.equal(result.wholeRun.targetMs, 1_200_000);
    assert.equal(result.wholeRun.targetMs, OBSERVED_RUN_TARGET_MS);
    assert.equal(result.wholeRun.durationMs, elapsed);
    assert.equal(result.wholeRun.timingResult, expected);
  });
}

test('an early actual start is reported as negative scheduler delay, never silently clamped', () => {
  const value = record(); value.scheduledAt = iso(10);
  assert.equal(summarize(value).scheduledDelay.durationMs, -5 * 60_000);
});

test('missing scheduled time does not invent a schedule or discard complete actual duration', () => {
  const value = record(); value.scheduledAt = null;
  const result = summarize(value);
  assert.equal(result.scheduledDelay.status, 'not-recorded');
  assert.equal(result.wholeRun.durationMs, 15 * 60_000);
});

test('missing original or intervening attempt start cannot be replaced by a known retry', () => {
  for (const missing of [0, 1]) {
    const value = record();
    value.attempts = [attempt('attempt-1', 2, 'failed'), attempt('attempt-2', 5)];
    value.attempts[missing].startedAt = null;
    const result = summarize(value);
    assert.equal(result.firstStartedAt, null);
    assert.equal(result.wholeRun.timingResult, 'not-recorded');
    assert.equal(result.scheduledDelay.status, 'not-recorded');
  }
});

test('a running or stopped attempt without public evidence is not a passing completed run', () => {
  for (const outcome of ['in-progress', 'stopped', 'failed']) {
    const value = record(); value.attempts[0].outcome = outcome; value.publicReadback = null;
    const result = summarize(value);
    assert.equal(result.wholeRun.timingResult, 'not-recorded');
    assert.equal(result.wholeRun.durationMs, null);
  }
});

for (const field of ['verifiedAt', 'sourceSha', 'htmlBlob', 'evidenceId', 'bytesMatched']) {
  test(`missing public endpoint/evidence ${field} is not-recorded`, () => {
    const value = record(); value.publicReadback[field] = null;
    const result = summarize(value);
    assert.equal(result.wholeRun.timingResult, 'not-recorded');
    assert.equal(result.publicVerifiedAt, null);
    assert.equal(result.publicEvidence, null);
  });
}
test('a reported public byte mismatch never becomes successful verification', () => {
  const value = record(); value.publicReadback.bytesMatched = false;
  const result = summarize(value);
  assert.equal(result.wholeRun.reason, 'PUBLIC_BYTES_MATCH_NOT_CONFIRMED');
  assert.equal(result.wholeRun.timingResult, 'not-recorded');
});

for (const [name, mutate, code] of [
  ['duplicate attempt IDs', value => { value.attempts.push(attempt('attempt-1', 10)); }, 'DUPLICATE_ATTEMPT'],
  ['out-of-order attempts', value => { value.attempts.push(attempt('attempt-2', 1)); }, 'ATTEMPTS_OUT_OF_ORDER'],
  ['future attempt', value => { value.attempts[0].startedAt = iso(121); }, 'FUTURE_OBSERVATION_TIME'],
  ['future public observation', value => { value.publicReadback.verifiedAt = iso(121); }, 'FUTURE_OBSERVATION_TIME'],
  ['future schedule', value => { value.scheduledAt = iso(121); }, 'FUTURE_OBSERVATION_TIME'],
  ['readback preceding final attempt', value => { value.attempts.push(attempt('attempt-2', 21)); }, 'READBACK_PRECEDES_ATTEMPT'],
  ['date normalization', value => { value.scheduledAt = '2026-02-30T00:00:00.000Z'; }, 'INVALID_OBSERVATION_TIME'],
  ['ambiguous local clock', value => { value.scheduledAt = '2026-09-08 08:00'; }, 'CANONICAL_UTC_TIME_REQUIRED'],
  ['free-form attempt note', value => { value.attempts[0].note = 'SYNTHETIC_PRIVATE_TEXT'; }, 'INVALID_OBSERVATION_FIELDS'],
  ['financial field', value => { value.amount = 42; }, 'INVALID_OBSERVATION_FIELDS'],
  ['missing required field', value => { delete value.scheduledAt; }, 'INVALID_OBSERVATION_FIELDS'],
  ['unsupported schema', value => { value.schemaVersion = 2; }, 'UNSUPPORTED_OBSERVATION_VERSION'],
  ['invalid attempt identifier', value => { value.attempts[0].attemptId = '/private/synthetic'; }, 'INVALID_ATTEMPT_ID'],
  ['invalid evidence identifier', value => { value.publicReadback.evidenceId = 'https://example.test/private'; }, 'INVALID_PUBLIC_EVIDENCE_ID'],
  ['invalid public hash', value => { value.publicReadback.sourceSha = 'not-a-hash'; }, 'INVALID_PUBLIC_EVIDENCE_HASH'],
  ['invalid match assertion', value => { value.publicReadback.bytesMatched = 'true'; }, 'INVALID_BYTES_MATCH_OBSERVATION'],
  ['unsupported outcome', value => { value.attempts[0].outcome = 'authorized'; }, 'INVALID_ATTEMPT_OUTCOME'],
]) {
  test(`reject inconsistent observation: ${name}`, () => {
    const value = record(); mutate(value);
    assert.throws(() => summarize(value), new RegExp(code));
  });
}

test('requires an explicit now value and rejects options that would imply override authority', () => {
  assert.throws(() => summarizeRunObservation(record()), /INVALID_OBSERVATION_FIELDS/);
  assert.throws(() => summarizeRunObservation(record(), { ...options, authorize: true }), /INVALID_OBSERVATION_FIELDS/);
  assert.throws(() => summarizeRunObservation(record(), { now: null }), /CANONICAL_UTC_TIME_REQUIRED/);
});

test('summary is deterministic, leaves source records unchanged and returns no aliased evidence', t => {
  const value = record(), original = clone(value);
  for (const method of ['readFileSync', 'writeFileSync', 'openSync', 'appendFileSync', 'mkdirSync']) {
    t.mock.method(fs, method, () => { throw new Error('unexpected filesystem operation'); });
  }
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected network operation'); });
  const first = summarize(value), second = summarize(value);
  assert.deepEqual(first, second);
  first.publicEvidence.evidenceId = 'changed-copy';
  assert.deepEqual(value, original);
  assert.notEqual(second.publicEvidence.evidenceId, 'changed-copy');
  assert.equal(Object.hasOwn(second, 'publicationAuthorized'), false);
});
