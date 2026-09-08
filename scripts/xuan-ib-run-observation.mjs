// Pure observation summary, not a journal, lock, source attestation or release
// gate. No filesystem/network access, implicit clock, permission or publication.
export const OBSERVED_RUN_TARGET_MS = 20 * 60 * 1000;
export const OBSERVED_ATTEMPT_OUTCOMES = Object.freeze(['failed', 'completed', 'in-progress', 'stopped']);

const fail = code => { throw new Error(`XUAN-IB run observation: ${code}`); };
const plain = value => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => {
  if (!plain(value) || Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) fail('INVALID_OBSERVATION_FIELDS');
};
const identifier = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail('CANONICAL_UTC_TIME_REQUIRED');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) fail('INVALID_OBSERVATION_TIME');
  return ms;
}
const notRecorded = reason => ({ status: 'not-recorded', durationMs: null, reason });
const recorded = durationMs => ({ status: 'recorded', durationMs, reason: null });

/**
 * Input is narrow observation metadata. Every timing endpoint may be null, but
 * absent fields and arbitrary notes/financial payloads are rejected. `now` is
 * explicit canonical UTC so tests/callers do not depend on an implicit clock.
 * A syntactically valid hash and bytesMatched=true remain reported evidence;
 * this helper never fetches bytes, verifies a hash, or establishes provenance.
 */
export function summarizeRunObservation(record, options) {
  exact(options, ['now']);
  const nowMs = instant(options.now);
  exact(record, ['schemaVersion', 'scheduledAt', 'attempts', 'publicReadback']);
  if (record.schemaVersion !== 1) fail('UNSUPPORTED_OBSERVATION_VERSION');
  if (!Array.isArray(record.attempts) || record.attempts.length > 100) fail('INVALID_ATTEMPT_LIST');
  const observedTime = value => {
    if (value === null) return null;
    const ms = instant(value);
    if (ms > nowMs) fail('FUTURE_OBSERVATION_TIME');
    return ms;
  };
  const scheduledMs = observedTime(record.scheduledAt);
  const ids = new Set(), starts = [];
  let previousStart = null, missingStart = false, failedAttemptCount = 0;
  for (const attempt of record.attempts) {
    exact(attempt, ['attemptId', 'startedAt', 'outcome']);
    if (!identifier(attempt.attemptId)) fail('INVALID_ATTEMPT_ID');
    if (ids.has(attempt.attemptId)) fail('DUPLICATE_ATTEMPT');
    ids.add(attempt.attemptId);
    if (!OBSERVED_ATTEMPT_OUTCOMES.includes(attempt.outcome)) fail('INVALID_ATTEMPT_OUTCOME');
    if (attempt.outcome === 'failed') failedAttemptCount++;
    const start = observedTime(attempt.startedAt);
    if (start === null) { missingStart = true; continue; }
    if (previousStart !== null && start < previousStart) fail('ATTEMPTS_OUT_OF_ORDER');
    previousStart = start;
    starts.push(start);
  }

  let verifiedMs = null, publicEvidence = null, readbackReason = 'PUBLIC_READBACK_NOT_RECORDED';
  if (record.publicReadback !== null) {
    const readback = record.publicReadback;
    exact(readback, ['verifiedAt', 'sourceSha', 'htmlBlob', 'evidenceId', 'bytesMatched']);
    verifiedMs = observedTime(readback.verifiedAt);
    for (const key of ['sourceSha', 'htmlBlob']) {
      if (readback[key] !== null && !hash(readback[key])) fail('INVALID_PUBLIC_EVIDENCE_HASH');
    }
    if (readback.evidenceId !== null && !identifier(readback.evidenceId)) fail('INVALID_PUBLIC_EVIDENCE_ID');
    if (readback.bytesMatched !== null && typeof readback.bytesMatched !== 'boolean') fail('INVALID_BYTES_MATCH_OBSERVATION');
    if (verifiedMs !== null && starts.some(start => verifiedMs < start)) fail('READBACK_PRECEDES_ATTEMPT');
    if (verifiedMs === null) readbackReason = 'PUBLIC_VERIFICATION_TIME_NOT_RECORDED';
    else if (readback.sourceSha === null || readback.htmlBlob === null || readback.evidenceId === null) {
      readbackReason = 'PUBLIC_EVIDENCE_NOT_RECORDED';
    } else if (readback.bytesMatched !== true) readbackReason = 'PUBLIC_BYTES_MATCH_NOT_CONFIRMED';
    else {
      readbackReason = null;
      publicEvidence = { sourceSha: readback.sourceSha, htmlBlob: readback.htmlBlob, evidenceId: readback.evidenceId };
    }
  }

  // An unrecorded attempt might have started before all known attempts. Do not
  // choose the first known retry and turn missing original timing into a pass.
  const firstMs = !missingStart && starts.length ? starts[0] : null;
  const scheduledDelay = scheduledMs === null ? notRecorded('SCHEDULE_NOT_RECORDED')
    : firstMs === null ? notRecorded('FIRST_ATTEMPT_START_NOT_RECORDED') : recorded(firstMs - scheduledMs);
  const wholeRun = firstMs === null ? notRecorded('FIRST_ATTEMPT_START_NOT_RECORDED')
    : readbackReason !== null ? notRecorded(readbackReason) : recorded(verifiedMs - firstMs);
  return {
    schemaVersion: 1,
    kind: 'xuan-ib-run-timing-summary-v1',
    status: 'observation-only',
    verificationBasis: 'reported-evidence-not-independent-cryptographic-proof',
    firstStartedAt: firstMs === null ? null : new Date(firstMs).toISOString(),
    publicVerifiedAt: readbackReason === null ? new Date(verifiedMs).toISOString() : null,
    publicEvidence,
    attemptCount: record.attempts.length,
    failedAttemptCount,
    scheduledDelay,
    wholeRun: {
      ...wholeRun,
      targetMs: OBSERVED_RUN_TARGET_MS,
      timingResult: wholeRun.status === 'not-recorded' ? 'not-recorded'
        : wholeRun.durationMs <= OBSERVED_RUN_TARGET_MS ? 'pass' : 'fail',
      timingBasis: 'first-attempt-start-through-observed-verified-public-bytes-including-retries-and-waits',
    },
  };
}
