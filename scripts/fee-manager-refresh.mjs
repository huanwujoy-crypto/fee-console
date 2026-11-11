// Manager refresh publication orchestration (fee first, ratio second).
//
// Default-inactive. This module owns only: request validation, the
// server-side append-only per-(kind, real data date) ledger, the fee-first
// same-batch dependency, and independent fee publication readback. It never
// reads financial sources, never holds or discovers credentials, and never
// starts a producer itself: every side effect is an injected capability, and
// no real capability is wired here. See docs/fee-manager-refresh.md.
//
// Guarantees (proved by scripts/fee-manager-refresh.test.mjs):
// - A kind/date has at most one `published` record, created only after an
//   independent readback of the protected publication, never from a
//   publisher's or collector's self-report.
// - Every execution through this entry first wins an atomic append-only
//   claim `attempt-<n>`; a lost race, an unknown create result or an
//   unresolved earlier attempt stops before any side effect.
// - An attempt is retryable only after a *definite* terminal result that
//   proves nothing was published. Unknown outcomes are never retried blindly;
//   only evidence-based reconcile can close them.
// - Ratio runs only inside the same batch after that batch's fee step is
//   verified published. Fee and ratio keep their own real data dates; date
//   equality is a separate, explicit policy (default: not required).
import crypto from 'node:crypto';

export const SCHEMA = Object.freeze({
  request: 'fee-console.manager-refresh-request.v1',
  resume: 'fee-console.manager-refresh-resume-ratio.v1',
  batch: 'fee-console.manager-refresh-batch.v1',
  attempt: 'fee-console.manager-refresh-attempt.v1',
  started: 'fee-console.manager-refresh-started.v1',
  result: 'fee-console.manager-refresh-result.v1',
  published: 'fee-console.manager-refresh-published.v1',
  ratioStep: 'fee-console.manager-refresh-ratio-step.v1',
  feeBlocked: 'fee-console.manager-refresh-fee-blocked.v1',
});
export const OWNER_ID = 283054367;
export const KINDS = Object.freeze(['fee', 'ratio']);
export const MAX_ATTEMPTS = 5;
export const MAX_RATIO_STEPS = 5;
export const PREFIX = 'fee-manager-refresh-v1';

// Fixed, amount-free outcome codes. Nothing else is ever returned or stored.
export const CODES = Object.freeze([
  'PUBLISHED', 'ALREADY_PUBLISHED_IN_BATCH', 'DATE_ALREADY_PUBLISHED_ELSEWHERE',
  'HISTORY_AHEAD_OF_TARGET', 'DUPLICATE_REQUEST', 'REQUEST_ID_REUSED', 'ATTEMPT_IN_FLIGHT',
  'LOST_RACE', 'CLAIM_UNKNOWN', 'ATTEMPTS_EXHAUSTED', 'LEDGER_CORRUPT', 'CANCELLED_BEFORE_START',
  'PUBLISHER_REFUSED', 'START_UNKNOWN', 'RUN_ENDED_UNPUBLISHED', 'AWAITING_PUBLICATION',
  'VERIFY_UNAVAILABLE', 'RECONCILED_PUBLISHED', 'RECONCILED_NOT_STARTED', 'INTAKE_NOT_ACTIVE',
  'IDENTITY_UNVERIFIED', 'REQUEST_INVALID', 'FEE_NOT_VERIFIED', 'FEE_NOT_REQUESTED',
  'RATIO_REQUIRES_SAME_BATCH_FEE', 'RATIO_COLLECTOR_NOT_CONFIGURED', 'RATIO_PUBLISHER_NOT_CONFIGURED',
  'RATIO_DATE_POLICY_BLOCKED', 'RATIO_STEPS_EXHAUSTED', 'RATIO_COLLECTOR_FAILED',
  'RATIO_COLLECTOR_INVALID', 'BLOCKED_UNSUPPORTED_EXPOSURE', 'NEEDS_SOURCE_EXPORT',
  'COLLECTED_NOT_PUBLISHED', 'FEE_PUBLISHER_NOT_CONFIGURED', 'REQUEST_STALE', 'PROVENANCE_UNBOUND',
]);
const CODE_SET = new Set(CODES);
// Collector codes accepted verbatim from the ratio collector contract.
const RATIO_COLLECTOR_BLOCKED = new Set(['RATIO_COLLECTOR_NOT_CONFIGURED', 'BLOCKED_UNSUPPORTED_EXPOSURE', 'NEEDS_SOURCE_EXPORT']);
const RATIO_SOURCE_ROLES = Object.freeze(['classification', 'exposure', 'performance']);

export class RefreshError extends Error {
  constructor(code) { super(code); this.code = CODE_SET.has(code) ? code : 'LEDGER_CORRUPT'; }
}
const fail = code => { throw new RefreshError(code); };

const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v, keys) => plain(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
export const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const isUuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const isSha40 = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const isSha64 = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const isIso = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const canonical = v => JSON.stringify(v, Object.keys(v).sort());
const nonce = () => crypto.randomUUID();

// ---------------------------------------------------------------- requests
export const CONTENT_CHOICES = Object.freeze([['fee'], ['ratio'], ['fee', 'ratio']]);
export function validateRequest(v) {
  if (!plain(v) || v.schema !== SCHEMA.request || !isUuid(v.requestId)) return false;
  if (!Array.isArray(v.contents) || !CONTENT_CHOICES.some(c => c.join(',') === v.contents.join(','))) return false;
  const keys = ['schema', 'requestId', 'contents', 'createdAt'];
  if (v.contents.includes('fee')) keys.push('feeDataDate');
  if (v.contents.includes('ratio')) keys.push('ratioDataAsOf');
  if (!exact(v, keys) || !isIso(v.createdAt)) return false;
  if ('feeDataDate' in v && !isDay(v.feeDataDate)) return false;
  if ('ratioDataAsOf' in v && !isDay(v.ratioDataAsOf)) return false;
  return true;
}
export function validateResume(v) {
  return exact(v, ['schema', 'requestId', 'batchId', 'createdAt']) && v.schema === SCHEMA.resume
    && isUuid(v.requestId) && isUuid(v.batchId) && v.requestId !== v.batchId && isIso(v.createdAt);
}
// The server caller proves identity before calling submit(). The page never
// asserts it: the intake (not in this module) derives it from evidence.
export function validateIdentity(identity) {
  return exact(identity, ['verified', 'ownerId', 'method']) && identity.verified === true
    && identity.ownerId === OWNER_ID && identity.method === 'owner-gist-authored-request';
}

// ------------------------------------------------------------------ ledger
// Keys are siblings only (never a key that is also a directory of another).
export const keys = Object.freeze({
  batch: id => `${PREFIX}/batch/${id}/request`,
  ratioStep: (id, n) => `${PREFIX}/batch/${id}/ratio-${n}`,
  feeBlocked: id => `${PREFIX}/batch/${id}/fee-blocked`,
  done: id => `${PREFIX}/done/${id}`,
  attempt: (kind, date, n) => `${PREFIX}/${kind}/${date}/attempt-${n}`,
  started: (kind, date, n) => `${PREFIX}/${kind}/${date}/attempt-${n}-started`,
  result: (kind, date, n) => `${PREFIX}/${kind}/${date}/attempt-${n}-result`,
  published: (kind, date) => `${PREFIX}/${kind}/${date}/published`,
});

// Create exactly once. Any thrown or ambiguous create is resolved only by
// reading back; the create is never repeated.
export async function createOnce(ledger, key, record) {
  let thrown = null;
  try { await ledger.create(key, record); } catch (e) { thrown = e; }
  let actual;
  try { actual = await ledger.get(key); } catch { fail('CLAIM_UNKNOWN'); }
  if (actual === null || actual === undefined) {
    if (thrown && thrown.conflict === true) fail('LEDGER_CORRUPT');
    fail('CLAIM_UNKNOWN');
  }
  // Records carry a per-call nonce, so an identical read-back is ours.
  if (JSON.stringify(actual) === JSON.stringify(record)) return 'created';
  return 'conflict';
}

// Derive the state of one kind/date strictly from ledger records.
export async function kindState(ledger, kind, date) {
  if (!KINDS.includes(kind) || !isDay(date)) fail('REQUEST_INVALID');
  const listed = await ledger.list(`${PREFIX}/${kind}/${date}/`);
  const byKey = new Map(listed.map(r => [r.key, r.record]));
  if (byKey.size !== listed.length) fail('LEDGER_CORRUPT');
  const attempts = [];
  for (let n = 1; n <= MAX_ATTEMPTS + 1; n++) {
    const a = byKey.get(keys.attempt(kind, date, n));
    if (!a) break;
    if (!validAttempt(a, kind, date, n)) fail('LEDGER_CORRUPT');
    const started = byKey.get(keys.started(kind, date, n)) || null;
    const result = byKey.get(keys.result(kind, date, n)) || null;
    if (started && !(exact(started, ['schema', 'attempt', 'batchId', 'handle', 'nonce']) && started.schema === SCHEMA.started && started.attempt === n && started.batchId === a.batchId)) fail('LEDGER_CORRUPT');
    if (result && !(exact(result, ['schema', 'attempt', 'batchId', 'outcome', 'code', 'nonce']) && result.schema === SCHEMA.result && result.attempt === n && result.batchId === a.batchId && ['failed', 'blocked'].includes(result.outcome) && CODE_SET.has(result.code))) fail('LEDGER_CORRUPT');
    attempts.push({ n, attempt: a, started, result });
  }
  const known = new Set(attempts.flatMap(x => [keys.attempt(kind, date, x.n), keys.started(kind, date, x.n), keys.result(kind, date, x.n)]));
  const published = byKey.get(keys.published(kind, date)) || null;
  if (published) known.add(keys.published(kind, date));
  for (const k of byKey.keys()) if (!known.has(k)) fail('LEDGER_CORRUPT');
  const last = attempts.at(-1) || null;
  if (published) {
    if (!last || !validPublished(published, kind, date) || published.attempt !== last.n || published.batchId !== last.attempt.batchId || last.result) fail('LEDGER_CORRUPT');
    return { state: 'published', attempts, published, last };
  }
  // Every earlier attempt must be closed by a definite result.
  for (const x of attempts.slice(0, -1)) if (!x.result) fail('LEDGER_CORRUPT');
  if (!last) return { state: 'open', attempts, next: 1 };
  if (!last.result) return { state: 'in-flight', attempts, last };
  if (attempts.length >= MAX_ATTEMPTS) return { state: 'exhausted', attempts, last };
  return { state: 'retryable', attempts, last, next: last.n + 1 };
}
function validAttempt(a, kind, date, n) {
  return exact(a, ['schema', 'kind', 'dataDate', 'attempt', 'batchId', 'requestId', 'claimMainSha', 'claimedAt', 'nonce'])
    && isUuid(a.nonce)
    && a.schema === SCHEMA.attempt && a.kind === kind && a.dataDate === date && a.attempt === n
    && isUuid(a.batchId) && isUuid(a.requestId) && isSha40(a.claimMainSha) && isIso(a.claimedAt);
}
function validPublished(p, kind, date) {
  if (!exact(p, ['schema', 'kind', 'dataDate', 'attempt', 'batchId', 'evidence', 'recordedAt', 'nonce'])
    || p.schema !== SCHEMA.published || p.kind !== kind || p.dataDate !== date || !isIso(p.recordedAt)) return false;
  return kind === 'fee' ? validFeeEvidence(p.evidence, date) : plain(p.evidence);
}
export function validFeeEvidence(e, date) {
  return exact(e, ['mainSha', 'accountingThrough', 'dataSha256', 'healthSha256'])
    && isSha40(e.mainSha) && e.accountingThrough === date && isSha64(e.dataSha256) && isSha64(e.healthSha256);
}

// --------------------------------------------------- fee publication readback
// Independent proof that the protected fee chain (producer -> signed
// candidate -> Validate -> Promote -> Pages) published `date`. Inputs are
// injected read-only fetchers so the proof never trusts a publisher's report.
//   readMain()               -> current main commit sha
//   readRepoFile(sha, path)  -> Uint8Array at that commit
//   readPages(path)          -> Uint8Array served by Pages (no credential)
//   isAncestor(a, b)         -> true when commit a is an ancestor of b
export function createFeePublicationVerifier({ readMain, readRepoFile, readPages, isAncestor, validateHealth }) {
  if (![readMain, readRepoFile, readPages, isAncestor, validateHealth].every(f => typeof f === 'function')) fail('VERIFY_UNAVAILABLE');
  async function current() {
    const mainSha = await readMain();
    if (!isSha40(mainSha)) fail('VERIFY_UNAVAILABLE');
    const [data, healthBytes] = await Promise.all([readRepoFile(mainSha, 'data.json'), readRepoFile(mainSha, 'fee-data-health.json')]);
    let health;
    try { health = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(healthBytes)); } catch { fail('VERIFY_UNAVAILABLE'); }
    if (validateHealth(health, { now: new Date(health?.checkedAt) }).length || health.dataSha256 !== sha256(data)) fail('VERIFY_UNAVAILABLE');
    if ((await readMain()) !== mainSha) fail('VERIFY_UNAVAILABLE');
    return { mainSha, data, healthBytes, health };
  }
  return Object.freeze({
    isAncestor: (a, b) => isAncestor(a, b),
    // Admission check: what main currently covers.
    async coverage() { const c = await current(); return { mainSha: c.mainSha, targetDate: c.health.targetDate }; },
    // Publication proof for one claimed attempt.
    async verify(date, { claimMainSha }) {
      if (!isDay(date) || !isSha40(claimMainSha)) fail('VERIFY_UNAVAILABLE');
      const c = await current();
      if (c.health.targetDate !== date || !['updated', 'no-op'].includes(c.health.outcome)) return { state: 'not-published', targetDate: c.health.targetDate };
      if (c.mainSha === claimMainSha || !(await isAncestor(claimMainSha, c.mainSha))) return { state: 'not-published', targetDate: c.health.targetDate };
      const [pagesData, pagesHealth] = await Promise.all([readPages('data.json'), readPages('fee-data-health.json')]);
      if (sha256(pagesData) !== sha256(c.data) || sha256(pagesHealth) !== sha256(c.healthBytes)) return { state: 'pages-pending' };
      return { state: 'verified', evidence: { mainSha: c.mainSha, accountingThrough: date, dataSha256: sha256(c.data), healthSha256: sha256(c.healthBytes) } };
    },
  });
}

// ------------------------------------------------------- ratio collector
// Contract shared with the separately owned ratio collector. Collection is an
// external read plus local export writes; it is never a publication.
export function validateRatioCollection(r, dataAsOf) {
  if (!plain(r) || !['success', 'blocked', 'failed'].includes(r.state) || typeof r.code !== 'string') return null;
  if (r.state === 'blocked') return RATIO_COLLECTOR_BLOCKED.has(r.code) ? { state: 'blocked', code: r.code } : null;
  if (r.state === 'failed') return { state: 'failed', code: 'RATIO_COLLECTOR_FAILED' };
  if (r.code !== 'COLLECTED_NOT_PUBLISHED' || !isSha64(r.manifestSha256)) return null;
  if (!Array.isArray(r.sources) || r.sources.length !== RATIO_SOURCE_ROLES.length) return null;
  const roles = r.sources.map(s => s?.role).sort();
  if (roles.join(',') !== [...RATIO_SOURCE_ROLES].sort().join(',')) return null;
  for (const s of r.sources) if (!isDay(s.reportDate) || s.reportDate > dataAsOf) return null;
  if (!Array.isArray(r.exports) || !r.exports.length || r.exports.some(x => !exact(x, ['role', 'sha256']) || typeof x.role !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(x.role) || !isSha64(x.sha256))) return null;
  if (new Set(r.exports.map(x => x.role)).size !== r.exports.length) return null;
  return {
    state: 'collected', code: 'COLLECTED_NOT_PUBLISHED', manifestSha256: r.manifestSha256,
    sourceDates: Object.fromEntries(r.sources.map(s => [s.role, s.reportDate])),
  };
}
export const notConfiguredRatioCollector = Object.freeze({
  async collect() { return { state: 'blocked', code: 'RATIO_COLLECTOR_NOT_CONFIGURED' }; },
});

// ------------------------------------------------------------ orchestration
// deps:
//   ledger           {create(key, record), get(key), list(prefix)}
//   now()            -> Date
//   feePublisher     {start({dataDate,batchId,attempt,claimMainSha,signal}) -> {state:'started',handle}|{state:'refused'}
//                     status(handle) -> 'running'|'ended'
//                     lookup({dataDate,batchId,attempt}) -> 'running'|'ended'|'none'|'unknown'
//                     provenance({handle,dataDate,batchId,attempt}) -> null | {accountingThrough,
//                       dataSha256, healthSha256, promotedMainSha} from this attempt's own
//                       producer candidate and protected promotion run}
//   feeVerifier      createFeePublicationVerifier(...)
//   pipelineIdle(d)  -> true only when no producer/validate/promote run or candidate for d is pending
//   ratioCollector   default notConfiguredRatioCollector
//   ratioPublisher   default null (not part of this phase)
//   wait(ms, signal) / pollMs / deadlineMs
export function createRefreshCoordinator(deps) {
  const d = { ratioCollector: notConfiguredRatioCollector, ratioPublisher: null, pollMs: 30_000, deadlineMs: 40 * 60_000, ...deps };
  if (!d.ledger || typeof d.now !== 'function' || typeof d.wait !== 'function') fail('VERIFY_UNAVAILABLE');
  const nowIso = () => d.now().toISOString();

  async function submit(request, identity, { signal } = {}) {
    if (!validateIdentity(identity)) fail('IDENTITY_UNVERIFIED');
    if (!validateRequest(request)) fail('REQUEST_INVALID');
    const batch = { schema: SCHEMA.batch, batchId: request.requestId, request, nonce: nonce() };
    const created = await createOnce(d.ledger, keys.batch(batch.batchId), batch);
    if (created === 'conflict') {
      const existing = await d.ledger.get(keys.batch(batch.batchId));
      if (existing?.request?.requestId === request.requestId && canonical(existing.request) === canonical(request)) return { batchId: batch.batchId, code: 'DUPLICATE_REQUEST', status: await batchStatus(batch.batchId) };
      fail('REQUEST_ID_REUSED');
    }
    return runBatch(batch, { signal });
  }

  async function resumeRatio(resume, identity, { signal } = {}) {
    if (!validateIdentity(identity)) fail('IDENTITY_UNVERIFIED');
    if (!validateResume(resume)) fail('REQUEST_INVALID');
    const batch = await d.ledger.get(keys.batch(resume.batchId));
    if (!batch || batch.schema !== SCHEMA.batch || !validateRequest(batch.request) || !batch.request.contents.includes('ratio')) fail('REQUEST_INVALID');
    const ratio = await ratioStep(batch, resume.requestId, { signal });
    return { batchId: batch.batchId, fee: null, ratio };
  }

  // Crash recovery for an existing batch. Never a retry: a new attempt is
  // made only when this batch has claimed nothing and recorded no final
  // outcome yet, and only when the caller re-proved a fresh owner request.
  // Existing attempts are reconciled from evidence only.
  async function resumeBatch(batchId, { fresh = false } = {}) {
    const batch = await d.ledger.get(keys.batch(batchId));
    if (!batch || batch.schema !== SCHEMA.batch || !validateRequest(batch.request) || batch.batchId !== batchId) fail('LEDGER_CORRUPT');
    const { request } = batch;
    if (request.contents.includes('fee')) {
      const s = await kindState(d.ledger, 'fee', request.feeDataDate);
      const own = s.attempts.filter(x => x.attempt.batchId === batchId);
      const blocked = await d.ledger.get(keys.feeBlocked(batchId));
      const publishedHere = s.state === 'published' && s.published.batchId === batchId;
      if (!publishedHere && !blocked) {
        if (own.length && !own.at(-1).result) await reconcile('fee', request.feeDataDate).catch(() => null);
        else if (!own.length) { if (fresh) await publicationStep('fee', request.feeDataDate, batch, {}); else await preClaim(batch, 'blocked', 'REQUEST_STALE'); }
      }
    }
    if (request.contents.includes('ratio')) {
      const steps = await d.ledger.list(`${PREFIX}/batch/${batchId}/ratio-`);
      if (!steps.length) {
        const st = await batchStatus(batchId);
        const fee = st.fee;
        if (!request.contents.includes('fee')) await recordRatio(batch, request.requestId, { state: 'blocked', code: 'RATIO_REQUIRES_SAME_BATCH_FEE' });
        else if (fee?.state === 'published') { if (fresh) await ratioStep(batch, request.requestId, {}); else await recordRatio(batch, request.requestId, { state: 'blocked', code: 'REQUEST_STALE' }); }
        else if (fee && ['failed', 'blocked'].includes(fee.state)) await recordRatio(batch, request.requestId, { state: 'blocked', code: 'FEE_NOT_VERIFIED' });
      }
    }
    return batchStatus(batchId);
  }

  async function runBatch(batch, { signal }) {
    const { request } = batch;
    let fee = null;
    if (request.contents.includes('fee')) fee = await publicationStep('fee', request.feeDataDate, batch, { signal });
    let ratio = null;
    if (request.contents.includes('ratio')) {
      ratio = fee === null
        ? await recordRatio(batch, request.requestId, { state: 'blocked', code: 'RATIO_REQUIRES_SAME_BATCH_FEE' })
        : (fee.code === 'PUBLISHED' || fee.code === 'ALREADY_PUBLISHED_IN_BATCH')
          ? await ratioStep(batch, request.requestId, { signal })
          : await recordRatio(batch, request.requestId, { state: 'blocked', code: 'FEE_NOT_VERIFIED' });
    }
    return { batchId: batch.batchId, fee, ratio };
  }

  // Fee step. Each branch is labelled with the boundary it covers.
  // A final outcome reached before this batch claimed anything is persisted
  // create-only, so a later status read can never fall back to "waiting".
  async function preClaim(batch, state, code) {
    try { await createOnce(d.ledger, keys.feeBlocked(batch.batchId), { schema: SCHEMA.feeBlocked, state, code, nonce: nonce() }); } catch { /* first record wins */ }
    const kept = await d.ledger.get(keys.feeBlocked(batch.batchId));
    return kept && ['blocked', 'failed'].includes(kept.state) && CODE_SET.has(kept.code) ? { state: kept.state, code: kept.code } : { state, code };
  }

  async function publicationStep(kind, date, batch, { signal }) {
    if (kind !== 'fee') fail('REQUEST_INVALID');
    if (!d.feePublisher || !d.feeVerifier || typeof d.pipelineIdle !== 'function') return preClaim(batch, 'blocked', 'FEE_PUBLISHER_NOT_CONFIGURED');
    let s = await kindState(d.ledger, kind, date);
    if (s.state === 'published') return s.published.batchId === batch.batchId ? { state: 'published', code: 'ALREADY_PUBLISHED_IN_BATCH', evidence: s.published.evidence } : preClaim(batch, 'blocked', 'DATE_ALREADY_PUBLISHED_ELSEWHERE');
    if (s.state === 'in-flight') {
      // Unknown earlier outcome: only evidence can close it; never re-run.
      const owner = s.last.attempt.batchId;
      const r = await reconcile(kind, date);
      if (r.code === 'RECONCILED_PUBLISHED') return r.batchId === batch.batchId ? { state: 'published', code: 'PUBLISHED', evidence: r.evidence } : preClaim(batch, 'blocked', 'DATE_ALREADY_PUBLISHED_ELSEWHERE');
      if (r.state !== 'closed') return owner === batch.batchId ? { state: 'unknown', code: 'ATTEMPT_IN_FLIGHT' } : preClaim(batch, 'blocked', 'ATTEMPT_IN_FLIGHT');
      s = await kindState(d.ledger, kind, date);
    }
    if (s.state === 'exhausted') return preClaim(batch, 'blocked', 'ATTEMPTS_EXHAUSTED');
    if (s.state !== 'open' && s.state !== 'retryable') return { state: 'unknown', code: 'ATTEMPT_IN_FLIGHT' };
    // Admission against the real publication, not the ledger alone.
    let coverage;
    try { coverage = await d.feeVerifier.coverage(); } catch { return preClaim(batch, 'blocked', 'VERIFY_UNAVAILABLE'); }
    if (coverage.targetDate === date) return preClaim(batch, 'blocked', 'DATE_ALREADY_PUBLISHED_ELSEWHERE');
    if (coverage.targetDate > date) return preClaim(batch, 'blocked', 'HISTORY_AHEAD_OF_TARGET');
    if (signal?.aborted) return preClaim(batch, 'failed', 'CANCELLED_BEFORE_START');
    const n = s.next;
    const attempt = { schema: SCHEMA.attempt, kind, dataDate: date, attempt: n, batchId: batch.batchId, requestId: batch.request.requestId, claimMainSha: coverage.mainSha, claimedAt: nowIso(), nonce: nonce() };
    let claimed;
    try { claimed = await createOnce(d.ledger, keys.attempt(kind, date, n), attempt); }
    catch (e) { if (e.code === 'CLAIM_UNKNOWN') return { state: 'unknown', code: 'CLAIM_UNKNOWN' }; throw e; }
    if (claimed === 'conflict') return preClaim(batch, 'blocked', 'LOST_RACE');
    const close = async (outcome, code) => { await createOnce(d.ledger, keys.result(kind, date, n), { schema: SCHEMA.result, attempt: n, batchId: batch.batchId, outcome, code, nonce: nonce() }); return { state: outcome, code }; };
    // Cancelled between claim and start: provably nothing started.
    if (signal?.aborted) return close('failed', 'CANCELLED_BEFORE_START');
    let started;
    try { started = await d.feePublisher.start({ dataDate: date, batchId: batch.batchId, attempt: n, claimMainSha: coverage.mainSha }); }
    catch { return { state: 'unknown', code: 'START_UNKNOWN' }; }
    if (started?.state === 'refused') return close('failed', 'PUBLISHER_REFUSED');
    if (started?.state !== 'started' || typeof started.handle !== 'string' || !started.handle) return { state: 'unknown', code: 'START_UNKNOWN' };
    try { await createOnce(d.ledger, keys.started(kind, date, n), { schema: SCHEMA.started, attempt: n, batchId: batch.batchId, handle: started.handle, nonce: nonce() }); } catch { /* reconcile uses lookup() */ }
    return awaitPublication(kind, date, attempt, started.handle);
  }

  async function awaitPublication(kind, date, attempt, handle) {
    const deadline = d.now().getTime() + d.deadlineMs, seen = {};
    for (;;) {
      const outcome = await observe(kind, date, attempt, handle, seen);
      if (outcome) return outcome;
      if (d.now().getTime() >= deadline) return { state: 'unknown', code: seen.unbound ? 'PROVENANCE_UNBOUND' : 'AWAITING_PUBLICATION' };
      await d.wait(d.pollMs);
    }
  }

  // One evidence observation. Returns a terminal outcome or null to keep waiting.
  async function observe(kind, date, attempt, handle, seen = {}) {
    let v;
    try { v = await d.feeVerifier.verify(date, { claimMainSha: attempt.claimMainSha }); } catch { v = { state: 'unavailable' }; }
    if (v.state === 'verified') {
      // Bind the readback to THIS attempt's own protected run: the producer
      // candidate and the promotion it caused must carry the same bytes. A
      // later main that merely covers the same date is not this success.
      let prov = null;
      try { prov = await d.feePublisher.provenance({ handle, dataDate: date, batchId: attempt.batchId, attempt: attempt.attempt }); } catch { prov = null; }
      const bound = exact(prov, ['accountingThrough', 'dataSha256', 'healthSha256', 'promotedMainSha']) && prov.accountingThrough === date
        && prov.dataSha256 === v.evidence.dataSha256 && prov.healthSha256 === v.evidence.healthSha256 && isSha40(prov.promotedMainSha)
        && (prov.promotedMainSha === v.evidence.mainSha || (await d.feeVerifier.isAncestor?.(prov.promotedMainSha, v.evidence.mainSha)) === true);
      if (!bound) { seen.unbound = true; return null; }
      const record = { schema: SCHEMA.published, kind, dataDate: date, attempt: attempt.attempt, batchId: attempt.batchId, evidence: v.evidence, recordedAt: nowIso(), nonce: nonce() };
      const r = await createOnce(d.ledger, keys.published(kind, date), record);
      if (r === 'conflict') { const p = await d.ledger.get(keys.published(kind, date)); if (p?.batchId !== attempt.batchId || !validFeeEvidence(p.evidence, date)) fail('LEDGER_CORRUPT'); return { state: 'published', code: 'PUBLISHED', evidence: p.evidence }; }
      return { state: 'published', code: 'PUBLISHED', evidence: v.evidence };
    }
    let run;
    try { run = handle ? await d.feePublisher.status(handle) : await d.feePublisher.lookup({ dataDate: date, batchId: attempt.batchId, attempt: attempt.attempt }); } catch { run = 'unknown'; }
    if (run !== 'ended' && run !== 'none') return null;
    if (v.state !== 'not-published') return null;
    let idle = false;
    try { idle = (await d.pipelineIdle(date)) === true; } catch { idle = false; }
    if (!idle) return null;
    // Definite: run ended (or never existed), main does not carry `date`,
    // and nothing for `date` is pending downstream.
    const code = run === 'none' ? 'RECONCILED_NOT_STARTED' : 'RUN_ENDED_UNPUBLISHED';
    await createOnce(d.ledger, keys.result(kind, date, attempt.attempt), { schema: SCHEMA.result, attempt: attempt.attempt, batchId: attempt.batchId, outcome: 'failed', code, nonce: nonce() });
    return { state: 'failed', code };
  }

  // Close an unresolved attempt only from evidence; otherwise leave it open.
  async function reconcile(kind, date) {
    const s = await kindState(d.ledger, kind, date);
    if (s.state !== 'in-flight') return { state: 'closed', code: 'DUPLICATE_REQUEST' };
    if (!d.feePublisher || !d.feeVerifier) return { state: 'open', code: 'ATTEMPT_IN_FLIGHT' };
    const o = await observe(kind, date, s.last.attempt, s.last.started?.handle || null);
    if (!o) return { state: 'open', code: 'ATTEMPT_IN_FLIGHT' };
    if (o.state === 'published') return { state: 'closed', code: 'RECONCILED_PUBLISHED', batchId: s.last.attempt.batchId, evidence: o.evidence };
    return { state: 'closed', code: o.code };
  }

  async function ratioStep(batch, requestId, { signal }) {
    const fee = await kindState(d.ledger, 'fee', batch.request.feeDataDate || '0000-01-01').catch(() => null);
    if (!batch.request.contents.includes('fee') || !fee || fee.state !== 'published' || fee.published.batchId !== batch.batchId) return recordRatio(batch, requestId, { state: 'blocked', code: 'RATIO_REQUIRES_SAME_BATCH_FEE' });
    if (signal?.aborted) return { state: 'failed', code: 'CANCELLED_BEFORE_START' };
    let collected;
    try { collected = validateRatioCollection(await d.ratioCollector.collect({ dataAsOf: batch.request.ratioDataAsOf, requestId, signal }), batch.request.ratioDataAsOf); }
    catch { collected = { state: 'failed', code: 'RATIO_COLLECTOR_FAILED' }; }
    if (!collected) collected = { state: 'blocked', code: 'RATIO_COLLECTOR_INVALID' };
    if (collected.state !== 'collected') return recordRatio(batch, requestId, collected);
    // Collection is not publication. No protected ratio publisher is part of
    // this phase, so a collected result is recorded and stops here.
    if (!d.ratioPublisher) return recordRatio(batch, requestId, { state: 'blocked', code: 'RATIO_PUBLISHER_NOT_CONFIGURED', collected });
    return recordRatio(batch, requestId, { state: 'blocked', code: 'RATIO_DATE_POLICY_BLOCKED', collected });
  }

  async function recordRatio(batch, requestId, outcome) {
    const listed = await d.ledger.list(`${PREFIX}/batch/${batch.batchId}/ratio-`);
    if (listed.some(x => x.record?.requestId === requestId)) return { ...listed.find(x => x.record.requestId === requestId).record.outcome, duplicate: true };
    const n = listed.length + 1;
    if (n > MAX_RATIO_STEPS) return { state: 'blocked', code: 'RATIO_STEPS_EXHAUSTED' };
    const safe = { state: outcome.state, code: outcome.code };
    if (outcome.collected) safe.collected = { manifestSha256: outcome.collected.manifestSha256, sourceDates: outcome.collected.sourceDates };
    const r = await createOnce(d.ledger, keys.ratioStep(batch.batchId, n), { schema: SCHEMA.ratioStep, step: n, requestId, outcome: safe, recordedAt: nowIso(), nonce: nonce() }).catch(e => e.code);
    if (r !== 'created') return { state: 'unknown', code: r === 'conflict' ? 'LOST_RACE' : 'CLAIM_UNKNOWN' };
    return safe;
  }

  async function feeBlockedStatus(batchId, dataDate) {
    const b = await d.ledger.get(keys.feeBlocked(batchId));
    return b && ['blocked', 'failed'].includes(b.state) && CODE_SET.has(b.code) ? { state: b.state, code: b.code, dataDate } : { state: 'none', dataDate };
  }

  async function batchStatus(batchId) {
    const batch = await d.ledger.get(keys.batch(batchId));
    if (!batch) return null;
    const out = { batchId, contents: batch.request.contents, fee: null, ratio: null };
    if (batch.request.contents.includes('fee')) {
      const s = await kindState(d.ledger, 'fee', batch.request.feeDataDate);
      const mine = s.attempts.filter(x => x.attempt.batchId === batchId);
      out.fee = s.state === 'published' && s.published.batchId === batchId ? { state: 'published', code: 'PUBLISHED', dataDate: batch.request.feeDataDate }
        : mine.length && !mine.at(-1).result ? { state: 'unknown', code: 'ATTEMPT_IN_FLIGHT', dataDate: batch.request.feeDataDate }
        : mine.length ? { state: mine.at(-1).result.outcome, code: mine.at(-1).result.code, dataDate: batch.request.feeDataDate }
        : await feeBlockedStatus(batchId, batch.request.feeDataDate);
    }
    if (batch.request.contents.includes('ratio')) {
      const steps = await d.ledger.list(`${PREFIX}/batch/${batchId}/ratio-`);
      out.ratio = steps.length ? steps.at(-1).record.outcome : { state: 'none' };
    }
    return out;
  }

  return Object.freeze({ submit, resumeRatio, resumeBatch, reconcile, batchStatus, kindState: (k, dt) => kindState(d.ledger, k, dt) });
}

// A projection is final only when every requested kind has a final state
// and code. Final projections are never overwritten (see the job).
export function isFinalStatus(st) {
  if (!st || typeof st !== 'object') return false;
  if (['REQUEST_STALE', 'REQUEST_INVALID', 'IDENTITY_UNVERIFIED'].includes(st.code) && !st.fee && !st.ratio) return true;
  const kinds = Array.isArray(st.contents) ? st.contents : [];
  return kinds.length > 0 && kinds.every(k => st[k] && ['published', 'failed', 'blocked'].includes(st[k].state) && typeof st[k].code === 'string');
}

// ------------------------------------------------------------- intake gate
// Real server entry is NOT active in this repository (docs gap list). The
// default intake refuses everything rather than simulating success.
export const inactiveIntake = Object.freeze({
  async submit() { fail('INTAKE_NOT_ACTIVE'); },
  async status() { fail('INTAKE_NOT_ACTIVE'); },
});

// ------------------------------------------------------ in-memory test ledger
// Atomic create with fault injection; used only by synthetic tests.
export function createMemoryLedger() {
  const rows = new Map();
  const faults = [];
  const clone = v => JSON.parse(JSON.stringify(v));
  return {
    rows,
    inject(f) { faults.push(f); },
    async create(key, record) {
      const f = faults.findIndex(x => x.op === 'create' && (!x.match || key.includes(x.match)));
      const fault = f >= 0 ? faults.splice(f, 1)[0] : null;
      await Promise.resolve();
      if (fault?.mode === 'drop-before-commit') throw Object.assign(new Error('network'), { transient: true });
      if (rows.has(key)) throw Object.assign(new Error('exists'), { conflict: true });
      rows.set(key, clone(record));
      if (fault?.mode === 'drop-after-commit') throw Object.assign(new Error('network'), { transient: true });
    },
    async get(key) {
      const f = faults.findIndex(x => x.op === 'get' && (!x.match || key.includes(x.match)));
      if (f >= 0) { faults.splice(f, 1); throw new Error('network'); }
      await Promise.resolve();
      return rows.has(key) ? clone(rows.get(key)) : null;
    },
    async list(prefix) {
      await Promise.resolve();
      return [...rows.keys()].filter(k => k.startsWith(prefix)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map(k => ({ key: k, record: clone(rows.get(k)) }));
    },
  };
}
