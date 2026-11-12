// Synthetic tests only: no network, credentials, financial data or real ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createRefreshCoordinator, createMemoryLedger, createFeePublicationVerifier, validateRequest,
  validateRatioCollection, inactiveIntake, kindState, keys, SCHEMA, OWNER_ID, MAX_ATTEMPTS,
} from './fee-manager-refresh.mjs';
import { validateHealth, buildHealth } from './fee-data-health.mjs';

const ID = { verified: true, ownerId: OWNER_ID, method: 'owner-gist-authored-request' };
const uuid = () => crypto.randomUUID();
const sha40 = s => crypto.createHash('sha1').update(String(s)).digest('hex');
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const D = '2026-11-10', PREV = '2026-11-09';
const req = (contents = ['fee'], extra = {}) => ({
  schema: SCHEMA.request, requestId: uuid(), contents, createdAt: '2026-11-11T02:00:00.000Z',
  ...(contents.includes('fee') ? { feeDataDate: D } : {}), ...(contents.includes('ratio') ? { ratioDataAsOf: D } : {}), ...extra,
});

// A synthetic protected chain: main commits, Pages bytes and a producer that
// publishes `ticks` polls after it starts, or never.
function world({ publishAfter = 1, startMode = 'started', runEnds = false, pages = true } = {}) {
  const commits = [];
  const commit = (target, checkedAt = '2026-11-11T02:00:00.000Z') => {
    const data = new TextEncoder().encode(JSON.stringify({ enc: true, v: 1, data: 'synthetic-' + target + '-' + commits.length }));
    const health = buildHealth({ checkedAt, targetDate: target, sourceDates: { schwab: target, webull: target, benchmark: target }, outcome: 'updated', dataSha256: sha256(data) });
    const healthBytes = new TextEncoder().encode(JSON.stringify(health));
    const sha = sha40('c' + commits.length + target);
    commits.push({ sha, data, healthBytes });
    return sha;
  };
  commit(PREV);
  let pagesAt = 0, now = Date.parse('2026-11-11T02:00:00Z');
  const w = {
    starts: [], ended: false, startMode, publishAfter, polls: 0, idle: true,
    head: () => commits.at(-1),
    commit,
    clock: () => new Date(now),
    advance: ms => { now += ms; },
    verifier: createFeePublicationVerifier({
      readMain: async () => commits.at(-1).sha,
      readRepoFile: async (sha, path) => { const c = commits.find(x => x.sha === sha); return path === 'data.json' ? c.data : c.healthBytes; },
      readPages: async path => { const c = commits[pages ? commits.length - 1 : pagesAt]; return path === 'data.json' ? c.data : c.healthBytes; },
      isAncestor: async (a, b) => commits.findIndex(x => x.sha === a) < commits.findIndex(x => x.sha === b),
      validateHealth,
    }),
    publisher: {
      start: async args => {
        w.starts.push(args);
        if (w.startMode === 'refused') return { state: 'refused' };
        if (w.startMode === 'throw') throw new Error('network');
        if (w.startMode === 'commit-then-throw') { w.pending = { at: w.polls + w.publishAfter, date: args.dataDate }; w.lostHandle = String(1000 + w.starts.length); throw new Error('network'); }
        w.pending = { at: w.polls + w.publishAfter, date: args.dataDate };
        return { state: 'started', handle: String(1000 + w.starts.length) };
      },
      provenance: async ({ dataDate }) => {
        if (w.foreign) return null; // publication not caused by this attempt
        const c = w.head(), h = JSON.parse(new TextDecoder().decode(c.healthBytes));
        return h.targetDate === dataDate ? { accountingThrough: dataDate, dataSha256: sha256(c.data), healthSha256: sha256(c.healthBytes), promotedMainSha: c.sha } : null;
      },
      status: async () => (w.ended ? 'ended' : 'running'),
      lookup: async () => (w.lookup ?? (w.lostHandle ? { handle: w.lostHandle } : w.pending ? 'unknown' : 'none')),
    },
    pipelineIdle: async () => w.idle,
    wait: async () => {
      w.polls++; now += 30_000;
      if (w.pending && w.pending.at !== Infinity && w.polls >= w.pending.at) { commit(w.pending.date); w.pending = null; w.ended = true; }
      if (runEnds && w.pending) { w.ended = true; }
    },
  };
  return w;
}
const coordinator = (w, ledger = createMemoryLedger(), extra = {}) => ({ ledger, c: createRefreshCoordinator({ ledger, now: w.clock, wait: w.wait, feePublisher: w.publisher, feeVerifier: w.verifier, pipelineIdle: w.pipelineIdle, deadlineMs: 10 * 60_000, ...extra }) });

test('fee only: publishes once and records success only after independent readback', async () => {
  const w = world({ publishAfter: 2 }), { c, ledger } = coordinator(w);
  const r = await c.submit(req(), ID);
  assert.equal(r.fee.code, 'PUBLISHED');
  assert.equal(r.fee.evidence.accountingThrough, D);
  assert.equal(r.fee.evidence.mainSha, w.head().sha);
  assert.equal(r.ratio, null);
  assert.equal(w.starts.length, 1);
  const s = await kindState(ledger, 'fee', D);
  assert.equal(s.state, 'published');
  // A second, different request for the same date never starts again.
  const again = await c.submit(req(), ID);
  assert.equal(again.fee.code, 'DATE_ALREADY_PUBLISHED_ELSEWHERE');
  assert.equal(w.starts.length, 1);
});

test('identical request id is idempotent; altered body under same id is refused', async () => {
  const w = world(), { c } = coordinator(w), r0 = req();
  await c.submit(r0, ID);
  const dup = await c.submit(structuredClone(r0), ID);
  assert.equal(dup.code, 'DUPLICATE_REQUEST');
  assert.equal(dup.status.fee.state, 'published');
  assert.equal(w.starts.length, 1);
  await assert.rejects(c.submit({ ...r0, feeDataDate: '2026-11-07' }, ID), { code: 'REQUEST_ID_REUSED' });
});

test('publisher self-report alone never records success', async () => {
  const w = world({ publishAfter: Infinity }), { c, ledger } = coordinator(w);
  w.publisher.status = async () => 'ended'; w.idle = false; // run "ended" but downstream still pending
  const r = await c.submit(req(), ID);
  assert.equal(r.fee.state, 'unknown');
  assert.equal(r.fee.code, 'AWAITING_PUBLICATION');
  assert.equal((await kindState(ledger, 'fee', D)).state, 'in-flight');
});

test('pages not yet serving the bytes is not success', async () => {
  const w = world({ publishAfter: 1, pages: false }), { c } = coordinator(w);
  const r = await c.submit(req(), ID);
  assert.equal(r.fee.state, 'unknown');
});

test('concurrent requests for one date: exactly one claim and one start', async () => {
  const w = world({ publishAfter: 1 }), { c, ledger } = coordinator(w);
  const results = await Promise.all([c.submit(req(), ID), c.submit(req(), ID), c.submit(req(), ID)]);
  const codes = results.map(r => r.fee.code).sort();
  assert.equal(w.starts.length, 1);
  assert.equal(codes.filter(x => x === 'PUBLISHED').length, 1);
  assert.ok(codes.every(x => ['PUBLISHED', 'LOST_RACE', 'ATTEMPT_IN_FLIGHT', 'DATE_ALREADY_PUBLISHED_ELSEWHERE'].includes(x)), codes.join());
  assert.equal([...ledger.rows.keys()].filter(k => /\/fee\/\d{4}-\d{2}-\d{2}\/attempt-\d+$/.test(k)).length, 1, 'one attempt claim');
});

test('network drop after claim committed: read-back recognises own claim, no double POST', async () => {
  const w = world(), ledger = createMemoryLedger(), { c } = coordinator(w, ledger);
  ledger.inject({ op: 'create', match: 'attempt-1', mode: 'drop-after-commit' });
  const r = await c.submit(req(), ID);
  assert.equal(r.fee.code, 'PUBLISHED');
  assert.equal(w.starts.length, 1);
});

test('network drop before claim committed: unknown, nothing started, no retry inside the call', async () => {
  const w = world(), ledger = createMemoryLedger(), { c } = coordinator(w, ledger);
  ledger.inject({ op: 'create', match: 'attempt-1', mode: 'drop-before-commit' });
  ledger.inject({ op: 'get', match: 'attempt-1' });
  const r = await c.submit(req(), ID);
  assert.equal(r.fee.code, 'CLAIM_UNKNOWN');
  assert.equal(w.starts.length, 0);
});

test('start result unknown: never re-started, and stays frozen even after the date is published', async () => {
  const w = world({ startMode: 'commit-then-throw', publishAfter: 1 }), { c, ledger } = coordinator(w);
  const r = await c.submit(req(), ID);
  assert.equal(r.fee.code, 'START_UNKNOWN');
  assert.equal(w.starts.length, 1);
  w.startMode = 'started';
  assert.equal((await c.submit(req(), ID)).fee.code, 'ATTEMPT_IN_FLIGHT');
  await w.wait(); // the protected chain publishes the date
  assert.equal((await c.reconcile('fee', D)).state, 'open', 'no verifiable request->run association: frozen');
  assert.equal((await kindState(ledger, 'fee', D)).state, 'in-flight');
  assert.equal(w.starts.length, 1);
});

test('definite failure before publication is retryable; unknown is not', async () => {
  const w = world({ startMode: 'refused' }), { c, ledger } = coordinator(w);
  const r1 = await c.submit(req(), ID);
  assert.equal(r1.fee.code, 'PUBLISHER_REFUSED');
  assert.equal((await kindState(ledger, 'fee', D)).state, 'retryable');
  w.startMode = 'started';
  const r2 = await c.submit(req(), ID);
  assert.equal(r2.fee.code, 'PUBLISHED');
  assert.equal(w.starts.length, 2);
  assert.equal(w.starts[1].attempt, 2);
});

test('run ended, main unchanged and pipeline idle: definite failure, retry allowed', async () => {
  const w = world({ publishAfter: Infinity }), { c, ledger } = coordinator(w);
  w.publisher.status = async () => 'ended';
  const r = await c.submit(req(), ID);
  assert.equal(r.fee.code, 'RUN_ENDED_UNPUBLISHED');
  assert.equal((await kindState(ledger, 'fee', D)).state, 'retryable');
});

test('cancel before start: claim closed as definite failure, retryable', async () => {
  const w = world(), { c, ledger } = coordinator(w), ac = new AbortController();
  w.verifier = w.verifier; // unchanged
  const orig = w.verifier.coverage;
  const c2 = createRefreshCoordinator({ ledger, now: w.clock, wait: w.wait, feePublisher: w.publisher, pipelineIdle: w.pipelineIdle,
    feeVerifier: { ...w.verifier, coverage: async () => { const x = await orig(); ac.abort(); return x; } } });
  const r = await c2.submit(req(), ID, { signal: ac.signal });
  assert.equal(r.fee.code, 'CANCELLED_BEFORE_START');
  assert.equal(w.starts.length, 0);
  const again = await c.submit(req(), ID);
  assert.equal(again.fee.code, 'PUBLISHED');
});

test('date already on main by another path is never re-published', async () => {
  const w = world(); w.commit(D);
  const { c } = coordinator(w);
  const r = await c.submit(req(), ID);
  assert.equal(r.fee.code, 'DATE_ALREADY_PUBLISHED_ELSEWHERE');
  assert.equal(w.starts.length, 0);
  const older = await c.submit(req(['fee'], { feeDataDate: '2026-11-06' }), ID);
  assert.equal(older.fee.code, 'HISTORY_AHEAD_OF_TARGET');
});

test('attempts are bounded per date', async () => {
  const w = world({ startMode: 'refused' }), { c, ledger } = coordinator(w);
  for (let i = 0; i < MAX_ATTEMPTS; i++) await c.submit(req(), ID);
  assert.equal((await c.submit(req(), ID)).fee.code, 'ATTEMPTS_EXHAUSTED');
  assert.equal(w.starts.length, MAX_ATTEMPTS);
  assert.equal((await kindState(ledger, 'fee', D)).state, 'exhausted');
});

test('ledger tampering fails closed', async () => {
  const w = world(), { c, ledger } = coordinator(w);
  ledger.rows.set(keys.published('fee', D), { schema: SCHEMA.published });
  await assert.rejects(c.submit(req(), ID), { code: 'LEDGER_CORRUPT' });
  assert.equal(w.starts.length, 0);
});

test('identity and request validation: no page-asserted identity, no extra fields', async () => {
  const w = world(), { c } = coordinator(w);
  await assert.rejects(c.submit(req(), { ...ID, ownerId: 1 }), { code: 'IDENTITY_UNVERIFIED' });
  await assert.rejects(c.submit(req(), { verified: true, ownerId: OWNER_ID, method: 'browser-says-so' }), { code: 'IDENTITY_UNVERIFIED' });
  await assert.rejects(c.submit({ ...req(), token: 'x' }, ID), { code: 'REQUEST_INVALID' });
  assert.equal(validateRequest(req(['ratio', 'fee'])), false);
  assert.equal(validateRequest({ ...req(), feeDataDate: '2026-02-30' }), false);
  assert.equal(w.starts.length, 0);
});

test('fee independent of ratio; ratio defaults to not configured after verified fee', async () => {
  const w = world(), { c } = coordinator(w);
  const r = await c.submit(req(['fee', 'ratio']), ID);
  assert.equal(r.fee.code, 'PUBLISHED');
  assert.deepEqual(r.ratio, { state: 'blocked', code: 'RATIO_COLLECTOR_NOT_CONFIGURED' });
});

test('ratio-only is blocked: no automatic binding to another batch fee', async () => {
  const w = world(), { c } = coordinator(w);
  await c.submit(req(['fee']), ID);
  const r = await c.submit(req(['ratio']), ID);
  assert.equal(r.fee, null);
  assert.equal(r.ratio.code, 'RATIO_REQUIRES_SAME_BATCH_FEE');
});

test('select all: fee failure or unknown stops ratio; ratio failure never republishes fee', async () => {
  const w = world({ startMode: 'refused' }), calls = [];
  const collector = { collect: async a => { calls.push(a); return { state: 'failed', code: 'X' }; } };
  const { c } = coordinator(w, undefined, { ratioCollector: collector });
  const r = await c.submit(req(['fee', 'ratio']), ID);
  assert.equal(r.fee.code, 'PUBLISHER_REFUSED');
  assert.equal(r.ratio.code, 'FEE_NOT_VERIFIED');
  assert.equal(calls.length, 0);
  w.startMode = 'started';
  const b = req(['fee', 'ratio']);
  const r2 = await c.submit(b, ID);
  assert.equal(r2.fee.code, 'PUBLISHED');
  assert.equal(r2.ratio.code, 'RATIO_COLLECTOR_FAILED');
  const starts = w.starts.length;
  const resumed = await c.resumeRatio({ schema: SCHEMA.resume, requestId: uuid(), batchId: b.requestId, createdAt: '2026-11-11T03:00:00.000Z' }, ID);
  assert.equal(resumed.fee, null);
  assert.equal(resumed.ratio.code, 'RATIO_COLLECTOR_FAILED');
  assert.equal(w.starts.length, starts, 'fee not started again');
});

test('ratio keeps its own real source dates and collection is never publication', async () => {
  const w = world(), h = 'a'.repeat(64);
  const collector = { collect: async () => ({ state: 'success', code: 'COLLECTED_NOT_PUBLISHED', manifestSha256: h,
    sources: [{ role: 'classification', reportDate: '2026-11-07' }, { role: 'exposure', reportDate: '2026-11-06' }, { role: 'performance', reportDate: D }],
    exports: [{ role: 'performance-xlsx', sha256: h }] }) };
  const { c } = coordinator(w, undefined, { ratioCollector: collector });
  const r = await c.submit(req(['fee', 'ratio']), ID);
  assert.equal(r.fee.code, 'PUBLISHED');
  assert.equal(r.ratio.state, 'blocked');
  assert.equal(r.ratio.code, 'RATIO_PUBLISHER_NOT_CONFIGURED');
  assert.deepEqual(r.ratio.collected.sourceDates, { classification: '2026-11-07', exposure: '2026-11-06', performance: D });
});

test('ratio collector contract', () => {
  const h = 'b'.repeat(64);
  assert.deepEqual(validateRatioCollection({ state: 'blocked', code: 'BLOCKED_UNSUPPORTED_EXPOSURE' }, D), { state: 'blocked', code: 'BLOCKED_UNSUPPORTED_EXPOSURE' });
  assert.deepEqual(validateRatioCollection({ state: 'blocked', code: 'NEEDS_SOURCE_EXPORT' }, D), { state: 'blocked', code: 'NEEDS_SOURCE_EXPORT' });
  assert.equal(validateRatioCollection({ state: 'blocked', code: 'PUBLISHED' }, D), null);
  assert.equal(validateRatioCollection({ state: 'success', code: 'PUBLISHED', manifestSha256: h, sources: [], exports: [] }, D), null);
  const future = { state: 'success', code: 'COLLECTED_NOT_PUBLISHED', manifestSha256: h, exports: [{ role: 'a', sha256: h }],
    sources: [{ role: 'classification', reportDate: D }, { role: 'exposure', reportDate: D }, { role: 'performance', reportDate: '2026-11-12' }] };
  assert.equal(validateRatioCollection(future, D), null, 'source date after dataAsOf is refused, never relabelled');
});

test('default intake is inactive and never simulates success', async () => {
  await assert.rejects(inactiveIntake.submit(), { code: 'INTAKE_NOT_ACTIVE' });
  const w = world(), ledger = createMemoryLedger();
  const c = createRefreshCoordinator({ ledger, now: w.clock, wait: w.wait });
  assert.deepEqual((await c.submit(req(), ID)).fee, { state: 'blocked', code: 'FEE_PUBLISHER_NOT_CONFIGURED' });
});

test('a same-date main not produced by this attempt is not this success', async () => {
  const w = world({ publishAfter: 1 }), { c, ledger } = coordinator(w);
  w.foreign = true;
  const r = await c.submit(req(), ID);
  assert.equal(r.fee.state, 'unknown');
  assert.equal((await kindState(ledger, 'fee', D)).state, 'in-flight');
  w.foreign = false;
  assert.equal((await c.reconcile('fee', D)).code, 'RECONCILED_PUBLISHED');
});

// ---- lost run id: frozen; paused dispatcher; stalled claims (coordinator)
test('lost run id stays frozen: no time-window adoption, no empty-window failure, no retry', async () => {
  const w = world({ startMode: 'throw' }), { c, ledger } = coordinator(w);
  assert.equal((await c.submit(req(), ID)).fee.code, 'START_UNKNOWN');
  w.lostHandle = '1001'; w.lookup = { handle: '1001' }; // a unique same-window run must not be adopted
  for (const advance of [60_000, 11 * 60_000, 24 * 3600_000]) {
    w.advance(advance);
    assert.equal((await c.reconcile('fee', D)).state, 'open');
  }
  const s = await kindState(ledger, 'fee', D);
  assert.equal(s.state, 'in-flight');
  assert.equal(s.attempts[0].started, null, 'nothing adopted');
  w.startMode = 'started';
  assert.equal((await c.submit(req(), ID)).fee.code, 'ATTEMPT_IN_FLIGHT');
  assert.equal(w.starts.length, 1);
});

test('paused dispatcher: A writes dispatching then pauses before sending; 11 minutes of reconcile and new requests never dispatch again; A sends once', async () => {
  const w = world({ publishAfter: Infinity }), ledger = createMemoryLedger();
  let release, aPaused = false; const hold = new Promise(r => { release = r; });
  const sent = [];
  const publisher = { ...w.publisher,
    start: async args => { aPaused = true; await hold; sent.push(args); return { state: 'started', handle: '5001' }; },
    status: async () => 'running' };
  const A = createRefreshCoordinator({ ledger, now: w.clock, wait: w.wait, feePublisher: publisher, feeVerifier: w.verifier, pipelineIdle: async () => true, deadlineMs: 0 });
  const B = createRefreshCoordinator({ ledger, now: w.clock, wait: w.wait, feePublisher: { ...publisher, start: async x => { sent.push(x); return { state: 'started', handle: '6001' }; } }, feeVerifier: w.verifier, pipelineIdle: async () => true, deadlineMs: 0 });
  const a = A.submit(req(), ID);
  for (let i = 0; i < 200 && !aPaused; i++) await new Promise(r => setImmediate(r));
  assert.ok(aPaused);
  assert.equal((await ledger.get(keys.dispatching('fee', D, 1))).mode, 'dispatch');
  w.advance(11 * 60_000);
  assert.equal((await B.reconcile('fee', D)).state, 'open', 'frozen: no not-started verdict');
  assert.equal((await B.submit(req(), ID)).fee.code, 'ATTEMPT_IN_FLIGHT');
  assert.equal(sent.length, 0);
  release(); await a;
  assert.equal(sent.length, 1, 'exactly one dispatch for the date');
  assert.equal((await kindState(ledger, 'fee', D)).attempts.length, 1);
});

test('frozen attempt is released only with proof the executor can never send, an idle pipeline and an unpublished date', async () => {
  const w = world({ startMode: 'throw' }), ledger = createMemoryLedger();
  let terminated = false;
  const c = createRefreshCoordinator({ ledger, now: w.clock, wait: w.wait, feePublisher: w.publisher, feeVerifier: w.verifier, pipelineIdle: w.pipelineIdle, executorTerminated: async () => terminated });
  assert.equal((await c.submit(req(), ID)).fee.code, 'START_UNKNOWN');
  assert.equal((await c.reconcile('fee', D)).state, 'open');
  terminated = true; w.idle = false;
  assert.equal((await c.reconcile('fee', D)).state, 'open', 'pipeline busy');
  w.idle = true;
  assert.equal((await c.reconcile('fee', D)).code, 'RECONCILED_NOT_STARTED');
  assert.equal((await kindState(ledger, 'fee', D)).state, 'retryable');
});

test('stalled claim without a dispatch record: voided only after the delay, and void and dispatch are exclusive', async () => {
  const core = await import('./fee-manager-refresh.mjs');
  const w = world(), ledger = createMemoryLedger();
  const b = req();
  await ledger.create(keys.batch(b.requestId), { schema: SCHEMA.batch, batchId: b.requestId, request: b, nonce: crypto.randomUUID() });
  await ledger.create(keys.attempt('fee', D, 1), { schema: SCHEMA.attempt, kind: 'fee', dataDate: D, attempt: 1, batchId: b.requestId, requestId: b.requestId, claimMainSha: w.head().sha, claimedAt: w.clock().toISOString(), nonce: crypto.randomUUID() });
  const c = createRefreshCoordinator({ ledger, now: w.clock, wait: w.wait, feePublisher: w.publisher, feeVerifier: w.verifier, pipelineIdle: w.pipelineIdle });
  assert.equal((await c.reconcile('fee', D)).state, 'open', 'a live claimant may still be about to dispatch');
  w.advance(core.VOID_AFTER_MS + 1000);
  assert.equal((await c.reconcile('fee', D)).code, 'RECONCILED_NOT_STARTED');
  assert.equal((await ledger.get(keys.dispatching('fee', D, 1))).mode, 'void');
  // The slow claimant now tries to record its dispatch: it loses and never POSTs.
  await assert.rejects(ledger.create(keys.dispatching('fee', D, 1), { schema: SCHEMA.dispatching, attempt: 1, batchId: b.requestId, mode: 'dispatch', at: w.clock().toISOString(), nonce: crypto.randomUUID() }), e => e.conflict === true);
  assert.equal(w.starts.length, 0);
});

test('POST not accepted while an independent same-owner same-date run publishes: never adopted, never success, never retried', async () => {
  const w = world({ publishAfter: Infinity }), ledger = createMemoryLedger();
  let lookups = 0, provenanceCalls = 0;
  const publisher = {
    start: async () => { throw new Error('network: request not accepted'); },
    status: async () => 'ended',
    // Worst case: something offers the independent run as if it were ours.
    lookup: async () => { lookups++; return { handle: '424242' }; },
    // And that run's full chain (run -> candidate -> main/Pages) is genuine.
    provenance: async ({ dataDate }) => { provenanceCalls++; const c = w.head(); return { accountingThrough: dataDate, dataSha256: crypto.createHash('sha256').update(c.data).digest('hex'), healthSha256: crypto.createHash('sha256').update(c.healthBytes).digest('hex'), promotedMainSha: c.sha }; },
  };
  const c = createRefreshCoordinator({ ledger, now: w.clock, wait: w.wait, feePublisher: publisher, feeVerifier: w.verifier, pipelineIdle: async () => true, deadlineMs: 0 });
  const b = req();
  assert.equal((await c.submit(b, ID)).fee.code, 'START_UNKNOWN');
  w.commit(D); // the independent run is signed, promoted and served by Pages
  for (const t of [60_000, 11 * 60_000, 3600_000]) { w.advance(t); assert.equal((await c.reconcile('fee', D)).state, 'open'); }
  assert.equal(lookups, 0, 'no time-window lookup is consulted');
  assert.equal(provenanceCalls, 0, 'no provenance without this attempt\'s own run id');
  const s = await kindState(ledger, 'fee', D);
  assert.equal(s.state, 'in-flight');
  assert.equal(s.published, undefined);
  assert.equal(await ledger.get(keys.published('fee', D)), null, 'never RECONCILED_PUBLISHED');
  assert.deepEqual((await c.batchStatus(b.requestId)).fee, { state: 'unknown', code: 'ATTEMPT_IN_FLIGHT', dataDate: D });
  assert.equal((await c.submit(req(), ID)).fee.code, 'ATTEMPT_IN_FLIGHT', 'no retry either');
});

// ---- "definitely not published" needs a fresh readback inside quiescence
function promotionRace({ promoteOnVerifyCall = null, promoteOnIdleCall = null, idleDuringPromotion = true } = {}) {
  const w = world({ publishAfter: Infinity }), ledger = createMemoryLedger();
  let verifyCalls = 0, idleCalls = 0;
  const verifier = { ...w.verifier, verify: async (...a) => { verifyCalls++; const r = await w.verifier.verify(...a); if (verifyCalls === promoteOnVerifyCall) w.commit(D); return r; } };
  const pipelineIdle = async () => { idleCalls++; if (idleCalls === promoteOnIdleCall) { w.commit(D); return idleDuringPromotion; } return true; };
  w.publisher.status = async () => 'ended';
  const c = createRefreshCoordinator({ ledger, now: w.clock, wait: w.wait, feePublisher: w.publisher, feeVerifier: verifier, pipelineIdle, deadlineMs: 10 * 60_000 });
  return { w, c, ledger };
}

test('promotion completes right after the first (old) readback: never RUN_ENDED_UNPUBLISHED; the publication is recorded', async () => {
  const { w, c, ledger } = promotionRace({ promoteOnVerifyCall: 1 });
  const r = await c.submit(req(), ID);
  assert.notEqual(r.fee.code, 'RUN_ENDED_UNPUBLISHED');
  assert.equal(r.fee.code, 'PUBLISHED');
  assert.equal((await kindState(ledger, 'fee', D)).state, 'published');
  assert.equal(w.starts.length, 1);
});

test('promotion lands between the fresh readback and the second idle check: no failure verdict', async () => {
  for (const idleDuringPromotion of [true, false]) {
    // idle calls: 1 = first bracket check, 2 = second bracket check
    const { c, ledger } = promotionRace({ promoteOnIdleCall: 2, idleDuringPromotion });
    const r = await c.submit(req(), ID);
    assert.notEqual(r.fee.code, 'RUN_ENDED_UNPUBLISHED', 'idle=' + idleDuringPromotion);
    assert.equal((await kindState(ledger, 'fee', D)).attempts[0].result, null);
    assert.equal(r.fee.code, 'PUBLISHED');
  }
});

test('promotion lands during the first idle check: the fresh readback sees it', async () => {
  const { c, ledger } = promotionRace({ promoteOnIdleCall: 1 });
  const r = await c.submit(req(), ID);
  assert.equal(r.fee.code, 'PUBLISHED');
  assert.equal((await kindState(ledger, 'fee', D)).state, 'published');
});

test('genuinely unpublished after a quiescent bracket: definite failure, retryable', async () => {
  const { c, ledger } = promotionRace({});
  const r = await c.submit(req(), ID);
  assert.equal(r.fee.code, 'RUN_ENDED_UNPUBLISHED');
  assert.equal((await kindState(ledger, 'fee', D)).state, 'retryable');
});

test('an explicitly undefined or null ratio collector keeps the not-configured default', async () => {
  for (const ratioCollector of [undefined, null]) {
    const w = world(), { c } = coordinator(w, undefined, { ratioCollector });
    const r = await c.submit(req(['fee', 'ratio']), ID);
    assert.equal(r.fee.code, 'PUBLISHED');
    assert.deepEqual(r.ratio, { state: 'blocked', code: 'RATIO_COLLECTOR_NOT_CONFIGURED' });
  }
  const w = world();
  assert.throws(() => coordinator(w, undefined, { ratioCollector: {} }), { code: 'VERIFY_UNAVAILABLE' });
});
