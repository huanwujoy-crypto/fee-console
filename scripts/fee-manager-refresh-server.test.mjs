// Synthetic transports only: no network, credentials or real ledger/Gist.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createGcsLedger, verifyOwnerRequest, handleIntake, createGitHubFeeAdapters, ALLOWED_ORIGIN, REQUEST_FILE, QUEUE_PREFIX, API } from './fee-manager-refresh-server.mjs';
import { createMemoryLedger, OWNER_ID, SCHEMA } from './fee-manager-refresh.mjs';

const enc = v => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
const GIST = 'a'.repeat(32), VER = 'b'.repeat(40), NOW = new Date('2026-11-11T02:05:00.000Z');
const request = (over = {}) => ({ schema: SCHEMA.request, requestId: crypto.randomUUID(), contents: ['fee'], feeDataDate: '2026-11-10', createdAt: '2026-11-11T02:00:00.000Z', ...over });
function gistHttp(req, over = {}) {
  const gist = { id: GIST, public: false, owner: { id: OWNER_ID }, history: [{ version: VER, committed_at: '2026-11-11T02:01:00Z', user: { id: OWNER_ID } }],
    files: { [REQUEST_FILE]: { content: JSON.stringify(req), truncated: false } }, ...over };
  const calls = [];
  const http = async (method, url, opts = {}) => { calls.push({ method, url, opts }); if (url.startsWith('https://api.github.com/gists/' + GIST)) return { status: 200, bytes: enc(gist) }; return { status: 404, bytes: enc('') }; };
  return { http, calls };
}

test('owner-authored request: fixed Gist, latest revision, owner, freshness', async () => {
  const r = request(), { http, calls } = gistHttp(r);
  const p = await verifyOwnerRequest({ requestId: r.requestId, gistVersion: VER }, { http, gistId: GIST, now: () => NOW });
  assert.equal(p.request.requestId, r.requestId);
  assert.deepEqual(p.identity, { verified: true, ownerId: OWNER_ID, method: 'owner-gist-authored-request' });
  assert.ok(calls.every(c => c.url.startsWith('https://api.github.com/gists/' + GIST) && !c.opts.headers?.Authorization), 'anonymous reads of the fixed Gist only');
});

test('owner proof refusals: other owner, public, stale, old revision, mismatched id, extra caller fields', async () => {
  const r = request(), body = { requestId: r.requestId, gistVersion: VER }, run = (over, b = body, now = NOW) => verifyOwnerRequest(b, { http: gistHttp(r, over).http, gistId: GIST, now: () => now });
  await assert.rejects(run({ owner: { id: 1 } }), { code: 'IDENTITY_UNVERIFIED' });
  await assert.rejects(run({ public: true }), { code: 'IDENTITY_UNVERIFIED' });
  await assert.rejects(run({}, body, new Date('2026-11-11T03:00:00Z')), { code: 'IDENTITY_UNVERIFIED' });
  await assert.rejects(run({ history: [{ version: 'c'.repeat(40), committed_at: '2026-11-11T02:01:00Z', user: { id: OWNER_ID } }] }), { code: 'IDENTITY_UNVERIFIED' });
  await assert.rejects(run({}, { ...body, requestId: crypto.randomUUID() }), { code: 'REQUEST_INVALID' });
  await assert.rejects(run({}, { ...body, gistId: 'x' }), { code: 'REQUEST_INVALID' });
  await assert.rejects(run({}, { ...body, url: 'https://evil.example' }), { code: 'REQUEST_INVALID' });
});

test('intake: exact origin only, queue create-only, job started without overrides, duplicate safe', async () => {
  const r = request(), { http } = gistHttp(r), ledger = createMemoryLedger(); let jobs = 0;
  const deps = { http, ledger, gistId: GIST, now: () => NOW, runJob: async (...args) => { assert.equal(args.length, 0, 'no overrides'); jobs++; }, readStatus: async () => null };
  const post = origin => handleIntake({ method: 'POST', path: '/v1/requests', headers: { origin }, body: JSON.stringify({ requestId: r.requestId, gistVersion: VER }) }, deps);
  for (const o of ['https://evil.github.io', 'https://huanwujoy-crypto.github.io.evil.example', undefined, 'null'])
    assert.equal((await post(o)).status, 403);
  const first = await post(ALLOWED_ORIGIN);
  assert.equal(first.status, 202);
  assert.equal(first.headers['Access-Control-Allow-Origin'], ALLOWED_ORIGIN);
  assert.equal(JSON.parse(first.body).state, 'queued');
  assert.equal(JSON.parse((await post(ALLOWED_ORIGIN)).body).state, 'duplicate');
  assert.equal(jobs, 2);
  assert.ok(ledger.rows.has(QUEUE_PREFIX + r.requestId));
  const bad = await handleIntake({ method: 'POST', path: '/v1/requests', headers: { origin: ALLOWED_ORIGIN }, body: 'x'.repeat(600) }, deps);
  assert.equal(bad.status, 400);
});

test('intake status reply is redacted to codes and dates', async () => {
  const id = crypto.randomUUID();
  const res = await handleIntake({ method: 'GET', path: '/v1/requests/' + id, headers: { origin: ALLOWED_ORIGIN } }, {
    runJob: async () => {}, readStatus: async () => ({ batchId: id, contents: ['fee'], fee: { state: 'published', dataDate: '2026-11-10', evidence: { dataSha256: 'secret' } }, ratio: null }) });
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.body, /secret|evidence/);
  assert.deepEqual(JSON.parse(res.body).fee, { state: 'published', dataDate: '2026-11-10' });
});

test('GCS ledger: create-only with ifGenerationMatch=0; 412 is a conflict', async () => {
  const store = new Map(), calls = [];
  const http = async (method, url, opts = {}) => {
    calls.push({ method, url });
    const u = new URL(url);
    if (method === 'POST') { const n = u.searchParams.get('name'); assert.equal(u.searchParams.get('ifGenerationMatch'), '0'); if (store.has(n)) return { status: 412 }; store.set(n, opts.body); return { status: 200, bytes: enc('{}') }; }
    if (u.searchParams.get('alt') === 'media') { const n = decodeURIComponent(u.pathname.split('/o/')[1]); return store.has(n) ? { status: 200, bytes: enc(store.get(n)) } : { status: 404 }; }
    const prefix = u.searchParams.get('prefix');
    return { status: 200, bytes: enc({ items: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }) };
  };
  const l = createGcsLedger({ http, bucket: 'synthetic-refresh-ledger' });
  await l.create('p/a', { x: 1 });
  await assert.rejects(l.create('p/a', { x: 2 }), e => e.conflict === true);
  assert.deepEqual(await l.get('p/a'), { x: 1 });
  assert.equal(await l.get('p/missing'), null);
  assert.deepEqual((await l.list('p/')).map(x => x.key), ['p/a']);
});

test('producer dispatch: exact existing confirmed-sync inputs; 204 without run id is unknown, never resent', async () => {
  const sent = [];
  let status = 200;
  const http = async (method, url, opts = {}) => { if (method === 'POST') { sent.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization }); return status === 200 ? { status, bytes: enc({ workflow_run_id: 42 }) } : { status, bytes: enc('') }; } return { status: 404 }; };
  const { publisher } = createGitHubFeeAdapters({ http, readToken: () => 'synthetic-token-not-real-0000', now: () => NOW });
  const main = 'c'.repeat(40);
  assert.deepEqual(await publisher.start({ dataDate: '2026-11-10', claimMainSha: main }), { state: 'started', handle: '42' });
  assert.equal(sent[0].url, API + '/actions/workflows/fee-cloud-producer.yml/dispatches');
  assert.deepEqual(sent[0].body, { ref: 'main', return_run_details: true, inputs: { run_reviewed_once: 'true', report_kind: 'daily', report_target: '2026-11-10', manual_sync_completed_for: '2026-11-10', confirmed_main: main } });
  status = 204; await assert.rejects(publisher.start({ dataDate: '2026-11-10', claimMainSha: main }));
  status = 422; assert.deepEqual(await publisher.start({ dataDate: '2026-11-10', claimMainSha: main }), { state: 'refused' });
  status = 502; await assert.rejects(publisher.start({ dataDate: '2026-11-10', claimMainSha: main }));
});

test('provenance binds the attempt run, its single candidate and the promotion bytes', async () => {
  const main0 = '1'.repeat(40), cand = '2'.repeat(40), promo = '3'.repeat(40), other = '4'.repeat(40);
  const files = { [cand]: { 'data.json': 'D', 'fee-data-health.json': 'H' }, [promo]: { 'data.json': 'D', 'fee-data-health.json': 'H' }, [other]: { 'data.json': 'X', 'fee-data-health.json': 'Y' } };
  let actor = OWNER_ID;
  const http = async (method, url) => {
    const ok = v => ({ status: 200, bytes: enc(v) });
    if (url.endsWith('/actions/runs/42')) return ok({ id: 42, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', path: '.github/workflows/fee-cloud-producer.yml', head_branch: 'main', run_attempt: 1, actor: { id: actor }, head_sha: main0, run_started_at: '2026-11-11T02:00:00Z', updated_at: '2026-11-11T02:20:00Z' });
    if (url.includes('/git/matching-refs/heads/codex/fee-daily-20261110-')) return ok([{ object: { sha: cand } }]);
    if (url.endsWith('/git/commits/' + cand)) return ok({ sha: cand, parents: [{ sha: main0 }], message: 'daily 2026-11-10', committer: { date: '2026-11-11T02:10:00Z' } });
    if (url.includes('/commits?sha=main')) return ok([{ sha: promo }, { sha: other }]);
    const m = /\/contents\/(.+)\?ref=([a-f0-9]{40})$/.exec(url);
    if (m) return { status: 200, bytes: enc(files[m[2]][m[1]]) };
    return { status: 404 };
  };
  const { publisher } = createGitHubFeeAdapters({ http, readToken: () => '', now: () => NOW });
  const p = await publisher.provenance({ handle: '42', dataDate: '2026-11-10' });
  assert.equal(p.promotedMainSha, promo);
  assert.equal(p.dataSha256, crypto.createHash('sha256').update('D').digest('hex'));
  actor = 999; assert.equal(await publisher.provenance({ handle: '42', dataDate: '2026-11-10' }), null, 'non-owner actor is not this protected run');
  assert.equal(await publisher.provenance({ handle: null, dataDate: '2026-11-10' }), null);
});

test('pipeline idle: active runs or an unincorporated candidate keep the date pending', async () => {
  const main = '5'.repeat(40), merged = '6'.repeat(40), stray = '7'.repeat(40);
  let refs = [{ object: { sha: merged } }], active = 0;
  const http = async (method, url) => {
    const ok = v => ({ status: 200, bytes: enc(v) });
    if (url.includes('/runs?status=')) return ok({ total_count: active, workflow_runs: [] });
    if (url.includes('/git/matching-refs/')) return ok(refs);
    if (url.endsWith('/git/ref/heads/main')) return ok({ object: { sha: main } });
    if (url.includes('/compare/' + merged + '...')) return ok({ status: 'ahead', behind_by: 0 });
    if (url.includes('/compare/' + stray + '...')) return ok({ status: 'diverged', behind_by: 1 });
    return { status: 404 };
  };
  const { pipelineIdle } = createGitHubFeeAdapters({ http, readToken: () => '', now: () => NOW });
  assert.equal(await pipelineIdle('2026-11-10'), true);
  refs = [{ object: { sha: merged } }, { object: { sha: stray } }];
  assert.equal(await pipelineIdle('2026-11-10'), false);
  refs = []; active = 1;
  assert.equal(await pipelineIdle('2026-11-10'), false);
});
