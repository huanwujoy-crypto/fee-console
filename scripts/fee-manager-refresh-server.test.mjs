// Synthetic transports only: no network, credentials or real ledger/Gist.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createGcsBucket, verifyOwnerRequest, handleIntake, createGitHubFeeAdapters, runRefreshJob, acceptancePublisher, candidateFromLog, ALLOWED_ORIGIN, REQUEST_FILE, API } from './fee-manager-refresh-server.mjs';
import { createMemoryLedger, OWNER_ID, SCHEMA, keys } from './fee-manager-refresh.mjs';
import { readConfig, createHttp, startJob, createIntakeHandler, runJob } from './fee-manager-refresh-entry.mjs';

const enc = v => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const GIST = 'a'.repeat(32), VER = 'b'.repeat(40), NOW = new Date('2026-11-11T02:05:00.000Z');
const request = (over = {}) => ({ schema: SCHEMA.request, requestId: crypto.randomUUID(), contents: ['fee'], feeDataDate: '2026-11-10', createdAt: '2026-11-11T02:00:00.000Z', ...over });
function gistHttp(req, over = {}, status = 200) {
  const gist = { id: GIST, public: false, owner: { id: OWNER_ID }, history: [{ version: VER, committed_at: '2026-11-11T02:01:00Z', user: { id: OWNER_ID } }],
    files: { [REQUEST_FILE]: { content: JSON.stringify(req), truncated: false } }, ...over };
  const calls = [];
  const http = async (method, url, opts = {}) => { calls.push({ method, url, opts }); if (url === 'https://api.github.com/gists/' + GIST) return { status, bytes: enc(gist) }; return { status: 404, bytes: enc('') }; };
  return { http, calls };
}
const post = (r, deps, origin = ALLOWED_ORIGIN) => handleIntake({ method: 'POST', path: '/v1/requests', headers: { origin }, body: JSON.stringify({ requestId: r.requestId, gistVersion: VER }) }, deps);
const bucket = () => { const b = createMemoryLedger(); b.names = async p => (await b.list(p)).map(x => x.key); return b; };

test('owner proof: one anonymous read of the fixed Gist; latest owner revision; real-time freshness', async () => {
  const r = request(), { http, calls } = gistHttp(r);
  const p = await verifyOwnerRequest({ requestId: r.requestId, gistVersion: VER }, { http, gistId: GIST, now: () => NOW });
  assert.equal(p.request.requestId, r.requestId);
  assert.deepEqual(p.identity, { verified: true, ownerId: OWNER_ID, method: 'owner-gist-authored-request' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers.Authorization, undefined);
});

test('owner proof refusals, including stale, out-of-window date and rate limit never success', async () => {
  const r = request(), body = { requestId: r.requestId, gistVersion: VER };
  const run = (over, b = body, now = NOW, req = r, status = 200) => verifyOwnerRequest(b, { http: gistHttp(req, over, status).http, gistId: GIST, now: () => now });
  await assert.rejects(run({ owner: { id: 1 } }), { code: 'IDENTITY_UNVERIFIED' });
  await assert.rejects(run({ public: true }), { code: 'IDENTITY_UNVERIFIED' });
  await assert.rejects(run({ history: [{ version: 'c'.repeat(40), committed_at: '2026-11-11T02:01:00Z', user: { id: OWNER_ID } }] }), { code: 'IDENTITY_UNVERIFIED' });
  await assert.rejects(run({}, body, new Date('2026-11-11T03:00:00Z')), { code: 'REQUEST_STALE' });
  await assert.rejects(run({}, body, new Date('2029-11-11T03:00:00Z')), { code: 'REQUEST_STALE' });
  await assert.rejects(run({}, { ...body, requestId: crypto.randomUUID() }), { code: 'REQUEST_INVALID' });
  await assert.rejects(run({}, { ...body, gistId: 'x' }), { code: 'REQUEST_INVALID' });
  await assert.rejects(run({}, { ...body, url: 'https://evil.example' }), { code: 'REQUEST_INVALID' });
  const old = request({ feeDataDate: '2026-11-01' });
  await assert.rejects(run({}, { requestId: old.requestId, gistVersion: VER }, NOW, old), { code: 'REQUEST_INVALID' });
  await assert.rejects(run({}, body, NOW, r, 403), { code: 'VERIFY_UNAVAILABLE' });
  await assert.rejects(run({}, body, NOW, r, 429), { code: 'VERIFY_UNAVAILABLE' });
});

function intakeDeps(r) {
  const queue = bucket(), status = bucket(), wakes = [];
  return { queue, status, wakes, deps: { http: gistHttp(r).http, queue, status, gistId: GIST, now: () => NOW, runJob: async (...a) => { assert.equal(a.length, 0); wakes.push(1); } } };
}

test('intake has no ledger capability: it writes only queue/ and wake/ objects', async () => {
  const r = request(), x = intakeDeps(r);
  assert.equal('ledger' in x.deps, false);
  await post(r, x.deps);
  assert.deepEqual([...x.queue.rows.keys()].map(k => k.split('/')[0]).sort(), ['queue', 'wake']);
  assert.equal(x.status.rows.size, 0);
});

test('intake: exact origin only; duplicates and concurrent POSTs wake the job at most once per minute', async () => {
  const r = request(), x = intakeDeps(r);
  for (const o of ['https://evil.github.io', 'https://huanwujoy-crypto.github.io.evil.example', 'null', 'http://huanwujoy-crypto.github.io'])
    assert.equal((await post(r, x.deps, o)).status, 403, o);
  assert.equal((await handleIntake({ method: 'POST', path: '/v1/requests', headers: {}, body: '{}' }, x.deps)).status, 403, 'missing origin');
  const results = await Promise.all([post(r, x.deps), post(r, x.deps), post(r, x.deps)]);
  assert.deepEqual(results.map(x => JSON.parse(x.body).state).sort(), ['duplicate', 'duplicate', 'queued']);
  assert.equal(x.wakes.length, 1);
  const r2 = request(), x2 = { ...x.deps, http: gistHttp(r2).http };
  assert.equal(JSON.parse((await post(r2, x2)).body).state, 'queued');
  assert.equal(x.wakes.length, 1, 'second new request in the same minute does not start another execution');
});

test('intake GET is read-only and returns only the latest redacted projection', async () => {
  const r = request(), x = intakeDeps(r);
  const get = id => handleIntake({ method: 'GET', path: '/v1/requests/' + id, headers: { origin: ALLOWED_ORIGIN } }, x.deps);
  assert.deepEqual(JSON.parse((await get(r.requestId)).body), { requestId: r.requestId, state: 'none' });
  await x.status.create('status/' + r.requestId + '/2026-11-11T02:06:00.000Z-0', { requestId: r.requestId, contents: ['fee'], fee: { state: 'unknown', code: 'AWAITING_PUBLICATION', dataDate: '2026-11-10' }, ratio: null });
  const before = x.queue.rows.size;
  const body = JSON.parse((await get(r.requestId)).body);
  assert.equal(body.fee.code, 'AWAITING_PUBLICATION');
  assert.equal(x.wakes.length, 0);
  assert.equal(x.queue.rows.size, before);
});

test('GCS client: create-only with ifGenerationMatch=0; 412 is a conflict', async () => {
  const store = new Map();
  const http = async (method, url, opts = {}) => {
    const u = new URL(url);
    if (method === 'POST') { const n = u.searchParams.get('name'); assert.equal(u.searchParams.get('ifGenerationMatch'), '0'); if (store.has(n)) return { status: 412 }; store.set(n, opts.body); return { status: 200, bytes: enc('{}') }; }
    if (u.searchParams.get('alt') === 'media') { const n = decodeURIComponent(u.pathname.split('/o/')[1]); return store.has(n) ? { status: 200, bytes: enc(store.get(n)) } : { status: 404 }; }
    return { status: 200, bytes: enc({ items: [...store.keys()].filter(k => k.startsWith(u.searchParams.get('prefix'))).map(name => ({ name })) }) };
  };
  const b = createGcsBucket({ http, bucket: 'synthetic-refresh-ledger' });
  await b.create('p/a', { x: 1 });
  await assert.rejects(b.create('p/a', { x: 2 }), e => e.conflict === true);
  assert.deepEqual(await b.get('p/a'), { x: 1 });
  assert.equal(await b.get('p/missing'), null);
  assert.deepEqual(await b.names('p/'), ['p/a']);
});

test('producer dispatch: exact existing confirmed-sync inputs; 204 or rate limit is unknown', async () => {
  const sent = []; let status = 200;
  const http = async (method, url, opts = {}) => { if (method === 'POST') { sent.push({ url, body: JSON.parse(opts.body) }); return status === 200 ? { status, bytes: enc({ workflow_run_id: 42 }) } : { status, bytes: enc('') }; } return { status: 404 }; };
  const { publisher } = createGitHubFeeAdapters({ http, readToken: () => 'synthetic-token-not-real-0000', now: () => NOW });
  const main = 'c'.repeat(40);
  assert.deepEqual(await publisher.start({ dataDate: '2026-11-10', claimMainSha: main }), { state: 'started', handle: '42' });
  assert.equal(sent[0].url, API + '/actions/workflows/fee-cloud-producer.yml/dispatches');
  assert.deepEqual(sent[0].body, { ref: 'main', return_run_details: true, inputs: { run_reviewed_once: 'true', report_kind: 'daily', report_target: '2026-11-10', manual_sync_completed_for: '2026-11-10', confirmed_main: main } });
  for (const s of [204, 403, 429, 502]) { status = s; await assert.rejects(publisher.start({ dataDate: '2026-11-10', claimMainSha: main })); }
  status = 422; assert.deepEqual(await publisher.start({ dataDate: '2026-11-10', claimMainSha: main }), { state: 'refused' });
});

const MAIN0 = '1'.repeat(40), CAND = '2'.repeat(40);
const LOG = ['2026-11-11T02:10:00.0000000Z ##[group]Run node scripts/refresh-benchmark-cache.mjs --sharesight-cloud', '2026-11-11T02:10:01Z ##[endgroup]',
  '2026-11-11T02:12:00Z ##[group]Run node scripts/fee-cloud-commit.mjs \\', '2026-11-11T02:12:00Z ##[endgroup]', '2026-11-11T02:12:05Z candidate ' + CAND,
  '2026-11-11T02:12:06Z ##[group]Run if [[ -d "$RUNNER_TEMP/fee-cloud-private" ]]; then'].join('\n');
function provenanceWorld(over = {}) {
  const o = { log: LOG, verified: true, author: 'huanwujoy-crypto', committer: 'web-flow', parent: MAIN0, actor: OWNER_ID, message: 'daily 2026-11-10',
    jobName: 'Produce daily 2026-11-10', stepOk: 'success', branchSha: CAND, mainSha: CAND, logHost: 'productionresultssa12.blob.core.windows.net', ...over };
  const seen = [];
  const http = async (method, url, opts = {}) => {
    seen.push({ url, opts });
    const ok = v => ({ status: 200, bytes: enc(v) });
    if (url.endsWith('/actions/runs/42')) return ok({ id: 42, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', path: '.github/workflows/fee-cloud-producer.yml', head_branch: 'main', run_attempt: 1, actor: { id: o.actor }, head_sha: MAIN0 });
    if (url.includes('/actions/runs/42/attempts/1/jobs')) return ok({ total_count: 2, jobs: [{ id: 7, run_id: 42, name: 'period' }, { id: 9, run_id: 42, name: o.jobName, head_sha: MAIN0, conclusion: 'success', steps: [{ name: 'Create a signed owner candidate', conclusion: o.stepOk }] }] });
    if (url.endsWith('/actions/jobs/9/logs')) { assert.equal(opts.redirect, 'manual'); return { status: 302, bytes: enc(''), location: 'https://' + o.logHost + '/logs/9?sig=x' }; }
    if (url.startsWith('https://' + o.logHost + '/')) { assert.equal(opts.external, true); assert.deepEqual(opts.headers, {}); return ok(o.log); }
    if (url.endsWith('/commits/' + CAND)) return ok({ sha: CAND, parents: [{ sha: o.parent }], author: { login: o.author }, committer: { login: o.committer }, commit: { message: o.message, verification: { verified: o.verified } } });
    if (url.includes('/git/matching-refs/heads/codex/fee-daily-20261110-')) return ok([{ ref: 'refs/heads/codex/fee-daily-20261110-a1b2c3', object: { sha: o.branchSha } }]);
    if (url.endsWith('/git/ref/heads/main')) return ok({ object: { sha: o.mainSha } });
    if (url.includes('/compare/')) return ok({ status: 'diverged', behind_by: 1 });
    const m = /\/contents\/(.+)\?ref=([a-f0-9]{40})$/.exec(url);
    if (m) return { status: 200, bytes: enc(m[1] === 'data.json' ? 'D' : 'H') };
    return { status: 404 };
  };
  return { seen, publisher: createGitHubFeeAdapters({ http, readToken: () => 'synthetic-token-not-real-0000', now: () => NOW }).publisher };
}

test('provenance: run -> its produce job -> candidate log line -> signed owner commit -> promoted main', async () => {
  const w = provenanceWorld();
  assert.deepEqual(await w.publisher.provenance({ handle: '42', dataDate: '2026-11-10' }), { accountingThrough: '2026-11-10', dataSha256: sha('D'), healthSha256: sha('H'), promotedMainSha: CAND });
  assert.ok(w.seen.filter(x => x.url.includes('blob.core.windows.net')).every(x => !JSON.stringify(x.opts).includes('synthetic-token')), 'no credential to the log host');
});

test('provenance blocked on any missing or ambiguous link', async () => {
  const twice = LOG + '\n2026-11-11T02:13:00Z candidate ' + CAND;
  const cases = {
    'duplicate candidate text': { log: twice },
    'candidate outside the commit step group': { log: LOG.replace('##[group]Run node scripts/fee-cloud-commit.mjs', '##[group]Run node scripts/other.mjs') },
    'embedded look-alike text': { log: LOG + '\n2026-11-11T02:13:00Z note: candidate ' + '3'.repeat(40) },
    'unexpected log host': { logHost: 'evil.example' },
    'unsigned commit': { verified: false }, 'other author': { author: 'someone-else' }, 'other committer': { committer: 'x' },
    'same-parent forged? parent differs': { parent: '9'.repeat(40) }, 'other date subject': { message: 'daily 2026-11-09' },
    'not owner actor': { actor: 999 }, 'job for another date': { jobName: 'Produce daily 2026-11-09' }, 'commit step failed': { stepOk: 'failure' },
    'branch points elsewhere': { branchSha: '8'.repeat(40) }, 'not promoted to main': { mainSha: '4'.repeat(40) },
  };
  // Blocked = null, or a thrown read error (the coordinator treats both as unbound, never success).
  for (const [name, c] of Object.entries(cases)) assert.equal(await provenanceWorld(c).publisher.provenance({ handle: '42', dataDate: '2026-11-10' }).catch(() => null), null, name);
  assert.equal(await provenanceWorld().publisher.provenance({ handle: null, dataDate: '2026-11-10' }), null);
});

test('candidate log parser is strict', () => {
  assert.equal(candidateFromLog(LOG), CAND);
  assert.equal(candidateFromLog(''), null);
  assert.equal(candidateFromLog(LOG.replace('candidate ' + CAND, 'candidate ' + CAND.slice(1))), null);
});

test('pipeline idle: one bounded run listing; active fee run or unincorporated candidate keeps it pending', async () => {
  const main = '5'.repeat(40), merged = '6'.repeat(40), stray = '7'.repeat(40);
  let refs = [{ object: { sha: merged } }], runs = [], reads = 0, total = null;
  const http = async (method, url) => {
    reads++;
    const ok = v => ({ status: 200, bytes: enc(v) });
    if (url.includes('/actions/runs?')) return ok({ total_count: total ?? runs.length, workflow_runs: runs });
    if (url.includes('/git/matching-refs/')) return ok(refs);
    if (url.endsWith('/git/ref/heads/main')) return ok({ object: { sha: main } });
    if (url.includes('/compare/' + merged + '...')) return ok({ status: 'ahead', behind_by: 0 });
    if (url.includes('/compare/' + stray + '...')) return ok({ status: 'diverged', behind_by: 1 });
    return { status: 404 };
  };
  const { pipelineIdle } = createGitHubFeeAdapters({ http, readToken: () => 'synthetic-token-not-real-0000', now: () => NOW });
  assert.equal(await pipelineIdle('2026-11-10'), true);
  assert.ok(reads <= 4, 'bounded reads: ' + reads);
  refs = [{ object: { sha: merged } }, { object: { sha: stray } }]; assert.equal(await pipelineIdle('2026-11-10'), false);
  refs = []; runs = [{ path: '.github/workflows/promote-fee-data.yml', status: 'queued' }]; assert.equal(await pipelineIdle('2026-11-10'), false);
  runs = []; total = 150; assert.equal(await pipelineIdle('2026-11-10'), false, 'incomplete listing is never idle');
});

const jobWorld = () => ({ ledger: bucket(), queue: bucket(), status: bucket() });
const jobArgs = (w, r, now) => ({ ...w, http: gistHttp(r).http, gistId: GIST, now: () => now, wait: async () => {}, readToken: () => 'synthetic-token-not-real-0000', validateHealth: () => [], mode: 'acceptance' });

test('job: stale queue entry is rejected against the real current time, recorded once, never executed', async () => {
  const r = request(), w = jobWorld();
  await w.queue.create('queue/' + r.requestId, { schema: 'fee-console.manager-refresh-queue.v1', requestId: r.requestId, gistVersion: VER, queuedAt: '2026-11-11T02:02:00.000Z' });
  const later = new Date('2028-01-01T00:00:00Z');
  const out = await runRefreshJob(jobArgs(w, r, later));
  assert.equal(out[0].code, 'REQUEST_STALE');
  assert.equal(await w.ledger.get(keys.batch(r.requestId)), null);
  assert.equal((await runRefreshJob(jobArgs(w, r, later))).length, 0, 'handled once');
  const proj = await w.status.list('status/' + r.requestId + '/');
  assert.equal(proj.at(-1).record.code, 'REQUEST_STALE');
});

test('job: forged queue entry without a matching owner revision never reaches the ledger', async () => {
  const r = request(), w = jobWorld();
  await w.queue.create('queue/' + r.requestId, { schema: 'fee-console.manager-refresh-queue.v1', requestId: r.requestId, gistVersion: 'f'.repeat(40), queuedAt: NOW.toISOString() });
  const out = await runRefreshJob(jobArgs(w, r, NOW));
  assert.equal(out[0].code, 'IDENTITY_UNVERIFIED');
  assert.equal(await w.ledger.get(keys.batch(r.requestId)), null);
});

test('job acceptance: full path with zero dispatch; concurrent executions handle a request once', async () => {
  const r = request(), w = jobWorld();
  await w.queue.create('queue/' + r.requestId, { schema: 'fee-console.manager-refresh-queue.v1', requestId: r.requestId, gistVersion: VER, queuedAt: NOW.toISOString() });
  const http = async (method, url, opts) => {
    if (method === 'POST') throw new Error('no dispatch in acceptance');
    if (url === 'https://api.github.com/gists/' + GIST) return gistHttp(r).http(method, url, opts);
    return { status: 503, bytes: enc('') }; // GitHub reads unavailable: never success
  };
  const args = { ...jobArgs(w, r, NOW), http };
  const [a, b] = await Promise.all([runRefreshJob(args), runRefreshJob(args)]);
  assert.equal(a.length + b.length, 1);
  const st = await w.ledger.get(keys.batch(r.requestId));
  assert.equal(st.request.requestId, r.requestId);
  assert.equal([...a, ...b][0].fee, 'VERIFY_UNAVAILABLE');
});

test('job disabled by default does nothing; acceptance never dispatches', async () => {
  assert.deepEqual(await runRefreshJob({ mode: 'disabled' }), []);
  assert.deepEqual(await acceptancePublisher.start(), { state: 'refused' });
  assert.equal(await acceptancePublisher.provenance(), null);
});

test('entry config: disabled by default, intake never configured with the ledger, acceptance isolated', async () => {
  assert.deepEqual(readConfig({}, 'serve'), { mode: 'disabled' });
  const base = { FEE_REFRESH_GIST_ID: GIST, FEE_REFRESH_QUEUE_BUCKET: 'q', FEE_REFRESH_STATUS_BUCKET: 's', FEE_REFRESH_JOB: 'projects/family-portfolio-gateway/locations/asia-east2/jobs/fee-refresh-launch' };
  assert.throws(() => readConfig({ ...base, FEE_REFRESH_MODE: 'launch', FEE_REFRESH_LEDGER_BUCKET: 'l' }, 'serve'), /CONFIG/);
  assert.throws(() => readConfig({ ...base, FEE_REFRESH_MODE: 'acceptance' }, 'serve'), /CONFIG/);
  assert.equal(readConfig({ ...base, FEE_REFRESH_MODE: 'acceptance', FEE_REFRESH_QUEUE_BUCKET: 'q-acceptance', FEE_REFRESH_STATUS_BUCKET: 's-acceptance' }, 'serve').mode, 'acceptance');
  assert.throws(() => readConfig({ ...base, FEE_REFRESH_MODE: 'launch', FEE_REFRESH_QUEUE_BUCKET: 'x-acceptance' }, 'serve'), /CONFIG/);
  assert.throws(() => readConfig({ ...base, FEE_REFRESH_MODE: 'nope' }, 'serve'), /CONFIG/);
  const h = createIntakeHandler({ mode: 'disabled' }, {});
  assert.equal((await h({ method: 'POST' })).status, 503);
  assert.deepEqual(await runJob({ mode: 'disabled' }, {}), { mode: 'disabled', handled: 0 });
});

test('entry http: fixed hosts, no redirects, Google token only to Google hosts; job start has no overrides', async () => {
  const seen = [];
  const http = createHttp({ metadataToken: async () => 'meta', fetchImpl: async (url, init) => { seen.push({ url, init }); return { status: 200, arrayBuffer: async () => new ArrayBuffer(2) }; } });
  await http('GET', 'https://api.github.com/gists/' + GIST);
  await http('GET', 'https://storage.googleapis.com/storage/v1/b/x/o');
  await assert.rejects(http('GET', 'https://evil.example/'), /HOST/);
  await assert.rejects(http('GET', 'http://api.github.com/'), /HOST/);
  assert.equal(seen[0].init.headers.Authorization, undefined);
  assert.equal(seen[1].init.headers.Authorization, 'Bearer meta');
  assert.ok(seen.every(s => s.init.redirect === 'error'));
  const calls = [];
  await startJob(async (m, u, o) => { calls.push({ m, u, o }); return { status: 200 }; }, 'projects/p1234/locations/asia-east2/jobs/fee-refresh-launch')();
  assert.equal(calls[0].u, 'https://run.googleapis.com/v2/projects/p1234/locations/asia-east2/jobs/fee-refresh-launch:run');
  assert.equal(calls[0].o.body, '{}');
});
