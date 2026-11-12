// Synthetic tests for the manager refresh chooser in index.html. The block is
// extracted so the page stays a single file. No network or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRequest } from './fee-manager-refresh.mjs';

import crypto from 'node:crypto';
import { aggregateUiFixture, aggregateUiStage } from './fee-ratio-aggregate-ui-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pageHash = s => crypto.createHash('sha256').update(s).digest('hex');
const current = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
// Support stage: main still serves the previous page, so derive the exact
// reviewed next page through the registered transition (never a loosened check).
const html = pageHash(current) === aggregateUiFixture.supportSha256 ? aggregateUiStage(current) : current;
assert.equal(pageHash(html), aggregateUiFixture.nextSha256, 'tests run against the exact reviewed chooser page');
const START = '/* manager-refresh:start */', END = '/* manager-refresh:end */';
const from = html.indexOf(START), to = html.indexOf(END);
assert.ok(from >= 0 && to > from && html.indexOf(START, from + 1) === -1, 'one manager-refresh block');
const block = html.slice(from, to);
const MR = new Function(`${block}\nreturn {MR_RATIO_READY,mrPlan,mrBuildRequest,mrSubmit,mrQueryStatus,mrOutcomeText,mrHktDate,mrResolved,mrStepText,mrProjection};`)();

const ok = { fee: true, ratio: false, feeDate: '2026-11-10', ratioDate: '2026-11-10', ratioReady: false, intakeActive: true, identityVerified: true, draft: false, pending: false, busy: false, online: true };
const ID = '0b0c0d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';
// Pending storage like the page: one key per request id.
function pendingStore() {
  const m = new Map();
  return { m, save: r => m.set(r.requestId, JSON.parse(JSON.stringify(r))), has: id => m.has(id), clear: id => m.delete(id), get: id => m.get(id) };
}
const deps = (intake, ps = pendingStore(), { uuid = () => ID, now = () => new Date('2026-11-11T02:00:00.000Z') } = {}) =>
  ({ intake, uuid, now, savePending: ps.save, hasPending: ps.has, clearPending: ps.clear, ps });

test('shipped page is default-inactive: no server origin, no client, ratio not ready', () => {
  assert.ok(html.includes('const MR_INTAKE_ORIGIN=null;'));
  assert.ok(html.includes('const MANAGER_REFRESH_CLIENT=MR_INTAKE_ORIGIN?createIntakeClient(MR_INTAKE_ORIGIN):null;'));
  assert.equal(MR.MR_RATIO_READY, false);
  const plan = MR.mrPlan({ ...ok, intakeActive: false });
  assert.equal(plan.canSubmit, false);
  assert.ok(plan.reasons.some(r => r.includes('尚未激活')));
});

test('normal user refresh is unchanged; only managers get the chooser', () => {
  assert.ok(html.includes('if(T.id==="btnRefresh"){if(isMgr())openManagerRefresh();else manualRefresh();return;}'));
  const fn = h => { const a = h.indexOf('async function manualRefresh(){'), b = h.indexOf('async function fetchDailyFresh('); return h.slice(a, b); };
  let base;
  try { base = execFileSync('git', ['show', 'origin/main:index.html'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { return; }
  assert.equal(fn(html), fn(base), 'manualRefresh body byte-identical to main');
  assert.ok(fn(html).length > 500);
  assert.ok(html.includes('<button class="btn sm" id="btnRefresh" type="button">↻ 刷新</button>'));
});

test('plan: fee alone is submittable; ratio blocked while not ready or without fee', () => {
  assert.equal(MR.mrPlan(ok).canSubmit, true);
  assert.equal(MR.mrPlan({ ...ok, fee: false, ratio: true, ratioReady: true }).canSubmit, false);
  assert.ok(MR.mrPlan({ ...ok, ratio: true }).reasons.some(r => r.includes('尚未就绪')));
  assert.equal(MR.mrPlan({ ...ok, ratio: true, ratioReady: true }).canSubmit, true);
  assert.equal(MR.mrPlan({ ...ok, fee: false }).canSubmit, false);
});

test('plan refuses unsaved draft, unverified identity, pending, busy, offline, bad date', () => {
  for (const change of [{ draft: true }, { identityVerified: false }, { pending: true }, { busy: true }, { online: false }, { feeDate: '' }])
    assert.equal(MR.mrPlan({ ...ok, ...change }).canSubmit, false, JSON.stringify(change));
});

test('request matches the server schema exactly', () => {
  for (const st of [ok, { ...ok, ratio: true, ratioReady: true, ratioDate: '2026-11-07' }]) {
    const r = MR.mrBuildRequest(st, ID, new Date('2026-11-11T02:00:00.000Z'));
    assert.equal(validateRequest(r), true, JSON.stringify(r));
  }
  const both = MR.mrBuildRequest({ ...ok, ratio: true, ratioDate: '2026-11-07' }, 'x', new Date());
  assert.deepEqual(both.contents, ['fee', 'ratio']);
  assert.equal(both.ratioDataAsOf, '2026-11-07', 'ratio keeps its own date');
});

test('submit: pending saved first; a lost reply after the POST keeps it and never resends', async () => {
  const sent = [];
  const d = deps({ submit: async (r, beforePost) => { assert.ok(d.ps.has(r.requestId), 'pending saved before anything'); assert.equal(beforePost('b'.repeat(40)), true); sent.push(r); throw new Error('reply lost'); } });
  const r = await MR.mrSubmit(ok, d);
  assert.equal(r.state, 'unknown');
  assert.equal(sent.length, 1);
  assert.equal(d.ps.get(ID).posts, 1);
  assert.equal((await MR.mrSubmit({ ...ok, pending: true }, d)).state, 'refused');
  assert.equal(sent.length, 1, 'no blind retry');
});

test('submit: a failure before any POST provably sent nothing: pending cleared, resubmission allowed', async () => {
  const d = deps({ submit: async () => { throw new Error('Gist 写入失败'); } });
  const r = await MR.mrSubmit(ok, d);
  assert.equal(r.state, 'not-sent');
  assert.equal(d.ps.m.size, 0);
  assert.match(r.text, /未发布任何内容/);
});

test('pending is kept for queued, duplicate, received, not-received, missing fields, other ids and non-final states', async () => {
  const keep = [
    { requestId: ID, state: 'queued' }, { requestId: ID, state: 'duplicate' }, { requestId: ID, state: 'unknown' }, { requestId: ID, state: 'received' },
    {}, null, { fee: { state: 'published', code: 'PUBLISHED' } },
    { requestId: 'other', contents: ['fee'], fee: { state: 'published', code: 'PUBLISHED' }, ratio: null },
    { requestId: ID, contents: ['fee'], fee: { state: 'published' }, ratio: null },
    { requestId: ID, contents: ['fee'], fee: { state: 'unknown', code: 'AWAITING_PUBLICATION' }, ratio: null },
    { requestId: ID, contents: ['fee'], fee: null, ratio: null },
    { requestId: ID, state: 'rejected', code: 'REQUEST_STALE', fee: null, ratio: null },
  ];
  for (const reply of keep) {
    const d = deps({ submit: async (r, bp) => { bp('b'.repeat(40)); return reply; }, status: async () => reply, close: async () => ({ requestId: ID, state: 'queued' }) });
    await MR.mrSubmit(ok, d);
    if (!(reply?.state === 'rejected')) assert.ok(d.ps.has(ID), 'kept for ' + JSON.stringify(reply));
    d.ps.save({ requestId: ID, contents: ['fee'], posts: 1 });
    const q = await MR.mrQueryStatus(d.ps.get(ID), d);
    assert.notEqual(q.state, 'done', JSON.stringify(reply));
    assert.ok(d.ps.has(ID));
  }
  const both = { requestId: ID, contents: ['fee', 'ratio'] };
  assert.equal(MR.mrResolved({ ...both, fee: { state: 'published', code: 'PUBLISHED' }, ratio: null }, both), false);
  assert.equal(MR.mrResolved({ ...both, fee: { state: 'published', code: 'PUBLISHED' }, ratio: { state: 'blocked', code: 'RATIO_COLLECTOR_NOT_CONFIGURED' } }, both), true);
  assert.equal(MR.mrResolved({ requestId: ID, contents: null, code: 'REQUEST_STALE', fee: null, ratio: null }, { requestId: ID, contents: ['fee'] }), true, 'job pre-execution rejection');
  assert.equal(MR.mrResolved({ requestId: ID, state: 'rejected', code: 'REQUEST_STALE' }, { requestId: ID, contents: ['fee'] }), false, 'an intake POST rejection is not a job verdict');
});

test('status text: published is success; unavailable is not asserted as unpublished', () => {
  assert.equal(MR.mrStepText('管理费', { state: 'published', code: 'PUBLISHED' }), '管理费：已核验发布成功');
  assert.equal(MR.mrStepText('管理费', { state: 'published' }), '管理费：已核验发布成功');
  assert.equal(MR.mrStepText('管理费', { state: 'blocked', code: 'VERIFY_UNAVAILABLE' }), '管理费：尚无法确认是否已发布');
  assert.equal(MR.mrStepText('管理费', { state: 'weird' }), '管理费：状态未确认，不会自动重试');
  assert.match(MR.mrOutcomeText({ requestId: ID, state: 'queued' }, { requestId: ID, contents: ['fee'] }), /已收到，等待处理/);
  assert.doesNotMatch(MR.mrOutcomeText({ requestId: ID, state: 'rejected', code: 'REQUEST_STALE' }, { requestId: ID, contents: ['fee'] }), /未执行|未发布任何内容/);
});

// ---- end-to-end (synthetic): page block + page-shaped client + real intake + real job
async function e2e({ start = new Date('2026-11-11T02:00:00.000Z'), admissionReady = false } = {}) {
  const srv = await import('./fee-manager-refresh-server.mjs');
  const core = await import('./fee-manager-refresh.mjs');
  const GIST = 'a'.repeat(32);
  const healthCore = await import('./fee-data-health.mjs');
  const encode = v => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
  const previousData = encode({ enc: true, v: 1, data: 'synthetic-previous-publication-only' });
  const previousHealth = healthCore.buildHealth({ checkedAt: start.toISOString(), targetDate: '2026-11-09',
    sourceDates: { schwab: '2026-11-09', webull: '2026-11-09', benchmark: '2026-11-09' }, outcome: 'updated', dataSha256: pageHash(previousData) });
  const bucket = () => { const b = core.createMemoryLedger(); b.names = async p => (await b.list(p)).map(x => x.key); return b; };
  // serverNow and browserNow are separate clocks.
  const env = { serverNow: start, browserNow: start, queue: bucket(), status: bucket(), ledger: bucket(), gist: null, version: null, committedAt: null, jobStarts: 0, postMode: 'ok', posts: [], held: [], upstream: [] };
  const serverClock = () => new Date(env.serverNow.getTime()), browserClock = () => new Date(env.browserNow.getTime());
  const gistHttp = async (method, url) => {
    env.upstream.push({ method, url });
    if (admissionReady) {
      assert.equal(method, 'GET', 'acceptance must never dispatch a producer');
      if (url === srv.API + '/git/ref/heads/main') return { status: 200, bytes: encode({ object: { sha: 'c'.repeat(40) } }) };
      if (url === srv.API + '/contents/data.json?ref=' + 'c'.repeat(40)) return { status: 200, bytes: previousData };
      if (url === srv.API + '/contents/fee-data-health.json?ref=' + 'c'.repeat(40)) return { status: 200, bytes: encode(previousHealth) };
    }
    if (url !== 'https://api.github.com/gists/' + GIST || !env.gist) return { status: 503, bytes: new Uint8Array() };
    return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ id: GIST, public: false, owner: { id: core.OWNER_ID },
      history: [{ version: env.version, committed_at: env.committedAt, user: { id: core.OWNER_ID } }],
      files: { [srv.REQUEST_FILE]: { content: env.gist, truncated: false } } })) };
  };
  const intakeDeps = { http: gistHttp, queue: env.queue, status: env.status, gistId: GIST, now: serverClock, runJob: async () => { env.jobStarts++; } };
  const http = async (method, path, body) => JSON.parse((await srv.handleIntake({ method, path, headers: { origin: srv.ALLOWED_ORIGIN }, body }, intakeDeps)).body);
  const deliver = (requestId, gistVersion) => http('POST', '/v1/requests', JSON.stringify({ requestId, gistVersion }));
  const post = async (requestId, gistVersion) => {
    env.posts.push({ requestId, gistVersion });
    if (env.postMode === 'held') { env.held.push(() => deliver(requestId, gistVersion)); throw new Error('network: still in flight'); }
    if (env.postMode === 'never-arrives') throw new Error('network');
    const reply = await deliver(requestId, gistVersion);
    if (env.postMode === 'reply-lost') throw new Error('reply lost');
    return reply;
  };
  const source = { token: 't1' };
  // Same behaviour as the page's createIntakeClient (source re-check, beforePost, one POST, close, status).
  const client = {
    async submit(request, beforePost) {
      const snap = source.token;
      if (env.gistFails) throw new Error('Gist 写入失败');
      env.gist = JSON.stringify(request); env.version = crypto.randomBytes(20).toString('hex'); env.committedAt = serverClock().toISOString();
      if (env.onGistWritten) await env.onGistWritten();
      if (source.token !== snap) throw new Error('来源或身份已变化，未提交');
      if (!beforePost(env.version)) throw new Error('该请求已被撤销或移除，未提交');
      return post(request.requestId, env.version);
    },
    close: id => http('POST', '/v1/requests/' + id + '/close'),
    status: id => http('GET', '/v1/requests/' + id),
  };
  const ps = pendingStore();
  const d = deps(client, ps, { uuid: () => crypto.randomUUID(), now: browserClock });
  const job = () => srv.runRefreshJob({ ledger: env.ledger, queue: env.queue, status: env.status, http: gistHttp, gistId: GIST, now: serverClock, wait: async () => {}, readToken: () => 'synthetic-token-not-real-0000', validateHealth: admissionReady ? healthCore.validateHealth : () => [], mode: 'acceptance' });
  const advance = ms => { env.serverNow = new Date(env.serverNow.getTime() + ms); env.browserNow = new Date(env.browserNow.getTime() + ms); };
  return { env, ps, d, job, advance, source, client, srv, core, intakeDeps, only: () => [...ps.m.values()][0] };
}
const okAt = { ...ok, feeDate: '2026-11-10' };

test('e2e: first POST definitively rejected (400) -> pending cleared, nothing queued, no job, resubmission allowed', async () => {
  const t = await e2e();
  const r = await MR.mrSubmit({ ...okAt, feeDate: '2026-11-01' }, t.d);
  assert.equal(r.state, 'rejected');
  assert.equal(t.ps.m.size, 0);
  assert.equal(t.env.queue.rows.size, 0);
  assert.equal(t.env.jobStarts, 0);
  assert.equal((await MR.mrSubmit(okAt, t.d)).state, 'pending');
});

test('e2e: Gist write fails before any POST -> not sent, pending cleared', async () => {
  const t = await e2e(); t.env.gistFails = true;
  assert.equal((await MR.mrSubmit(okAt, t.d)).state, 'not-sent');
  assert.equal(t.ps.m.size, 0);
  assert.equal(t.env.posts.length, 0);
});

test('e2e: browser clock 13 minutes ahead, POST still in flight: no browser-time verdict; close and late POST are exclusive', async () => {
  const t = await e2e(); t.env.postMode = 'held';
  await MR.mrSubmit(okAt, t.d);
  const p = t.only();
  t.env.browserNow = new Date(t.env.browserNow.getTime() + 13 * 60_000); // server: only moments later
  const q = await MR.mrQueryStatus(p, t.d); // GET not-received -> close (server-side, atomic)
  assert.equal(q.state, 'done');
  assert.match(q.text, /已撤销/);
  const late = await t.env.held[0](); // the original POST finally arrives
  assert.deepEqual(late, { requestId: p.requestId, state: 'rejected', code: 'REQUEST_CLOSED' });
  await t.job();
  assert.equal(await t.env.ledger.get(t.core.keys.batch(p.requestId)), null, 'never executed');
  assert.equal(t.env.jobStarts, 0);
});

test('e2e: the late POST wins the race: close answers queued and the request stays pending', async () => {
  const t = await e2e(); t.env.postMode = 'held';
  await MR.mrSubmit(okAt, t.d);
  const p = t.only();
  await t.env.held[0](); // arrives first
  const q = await MR.mrQueryStatus(p, t.d);
  assert.equal(q.state, 'unknown');
  assert.match(q.text, /已收到/);
  assert.ok(t.ps.has(p.requestId));
});

test('e2e: queue object missing is never "never executed": a projection exists -> close refused (received)', async () => {
  const t = await e2e();
  await MR.mrSubmit(okAt, t.d);
  const p = t.only();
  t.advance(60_000); await t.job();
  t.env.queue.rows.delete('queue/' + p.requestId); // simulated loss (not permitted in production)
  const q = await MR.mrQueryStatus(p, t.d);
  assert.equal(q.state, 'done', 'the final projection answers, not the missing queue object');
  const c = await t.client.close(p.requestId);
  assert.equal(c.state, 'received');
});

test('e2e: two tabs: A\'s late final reply clears only A, never B\'s newer pending', async () => {
  const t = await e2e();
  await MR.mrSubmit(okAt, t.d); const a = t.only();
  t.advance(60_000); await t.job(); // A becomes final on the server
  const b = { requestId: crypto.randomUUID(), contents: ['fee'], posts: 1, createdAt: '2026-11-11T02:02:00.000Z' };
  t.ps.save(b); // tab B submitted meanwhile
  const q = await MR.mrQueryStatus(a, t.d);
  assert.equal(q.state, 'done');
  assert.equal(t.ps.has(a.requestId), false);
  assert.equal(t.ps.has(b.requestId), true);
});

test('e2e: source switched while the Gist PATCH was pending -> no POST, nothing queued', async () => {
  const t = await e2e();
  t.env.onGistWritten = async () => { t.source.token = 't2'; };
  const r = await MR.mrSubmit(okAt, t.d);
  assert.equal(r.state, 'not-sent');
  assert.equal(t.env.posts.length, 0);
  assert.equal(t.env.queue.rows.size, 0);
});

test('e2e: reload with posts:0 while another tab is mid-submit: recovery closes it atomically; the other tab then sends nothing', async () => {
  const t = await e2e();
  let resume; const paused = new Promise(r => { resume = r; });
  t.env.onGistWritten = () => paused; // tab A stops inside its Gist write
  const a = MR.mrSubmit(okAt, t.d);
  for (let i = 0; i < 100 && !t.ps.m.size; i++) await new Promise(r => setImmediate(r));
  const p = t.only();
  assert.equal(p.posts, 0);
  // Reloaded tab B recovers the posts:0 record through the server.
  const q = await MR.mrQueryStatus(p, t.d);
  assert.equal(q.state, 'done');
  assert.match(q.text, /已撤销/);
  resume();
  const r = await a;
  assert.equal(r.state, 'not-sent', 'its pending record is gone, so it never POSTs');
  assert.equal(t.env.posts.length, 0);
  assert.equal(t.env.queue.rows.get('queue/' + p.requestId).schema, 'fee-console.manager-refresh-closed.v1');
});

test('e2e: POST reply lost but queued -> queued, no close; the job projection clears it', async () => {
  const t = await e2e(); t.env.postMode = 'reply-lost';
  assert.equal((await MR.mrSubmit(okAt, t.d)).state, 'unknown');
  t.env.postMode = 'ok';
  t.advance(11 * 60_000);
  const p = t.only();
  const q = await MR.mrQueryStatus(p, t.d);
  assert.equal(q.state, 'unknown');
  assert.match(q.text, /已收到/);
  await t.job();
  const q2 = await MR.mrQueryStatus(p, t.d);
  assert.equal(q2.state, 'done');
  assert.match(q2.text, /服务端核验后未执行该请求（REQUEST_STALE）/);
});

test('e2e: a queued request keeps the page pending until the job\'s final projection', async () => {
  const t = await e2e();
  assert.equal((await MR.mrSubmit(okAt, t.d)).state, 'pending');
  t.advance(60_000); await t.job();
  const q = await MR.mrQueryStatus(t.only(), t.d);
  assert.equal(q.state, 'done');
  assert.match(q.text, /尚无法确认是否已发布/);
});

test('confirmation copy states the click replaces the completed-sync instruction; read-only stays separate', () => {
  assert.ok(html.includes('这次点击将代替你以往发出的“同步已完成，请发布”指示'));
  assert.ok(html.includes('if(T.id==="mrSubmit"){confirmManagerRefresh();return;}'));
  assert.ok(html.includes('if(T.id==="mrReadOnly"){document.getElementById("mgrRefresh").classList.remove("on");manualRefresh();return;}'));
  assert.ok(html.includes('if(!mrPlan(s).canSubmit||!confirmed||'));
});

test('Hong Kong date default', () => {
  assert.equal(MR.mrHktDate(new Date('2026-11-10T17:00:00Z'), 1), '2026-11-10');
  assert.equal(MR.mrHktDate(new Date('2026-11-10T15:00:00Z'), 0), '2026-11-10');
});

// ---- real client (extracted block, injected page globals; no network)
const CS = '/* manager-refresh-client:start */', CE = '/* manager-refresh-client:end */';
const clientBlock = html.slice(html.indexOf(CS), html.indexOf(CE));
function client({ patchReply, fetchReplies = [], fetchImpl, gistId = 'g'.repeat(32), authorized = true, draft = null } = {}) {
  const calls = { patch: [], fetch: [] }, live = { token: 'synthetic-token-not-real-0000' };
  const env = {
    mrProjection: MR.mrProjection,
    managerDocumentsAuthorized: () => authorized, EDIT: { draft, pending: null }, _draftBlocked: false, _ledgerBusy: false,
    cfg: k => (k === 'gid' ? gistId : k === 'tok' ? live.token : ''), K: { gid: 'gid', tok: 'tok' }, _sourceEpoch: 7,
    _managerCapability: { ownerId: 283054367 },
    ghApi: async (path, opt) => { calls.patch.push({ path, opt }); return typeof patchReply === 'function' ? patchReply(opt, live) : patchReply; },
    freshFetch: async (url, init) => { calls.fetch.push({ url, init }); if (fetchImpl) return fetchImpl(url, init); const v = fetchReplies.shift(); return { status: new URL(url).pathname === '/v1/requests' ? 202 : 200, json: async () => v }; },
  };
  const names = Object.keys(env);
  const fn = new Function(...names, `${clientBlock.replace('const MR_INTAKE_ORIGIN=null;', 'const MR_INTAKE_ORIGIN="https://intake.example.invalid";')}\nreturn {createIntakeClient, MANAGER_REFRESH_CLIENT, writeRefreshRequest, get pending(){return _mrRequestWrite;}};`);
  return { calls, live, api: fn(...names.map(n => env[n])) };
}
const goodPatch = opt => { const raw = JSON.parse(opt.body).files['fee-manager-refresh-request.json'].content; return { id: 'g'.repeat(32), owner: { id: 283054367 }, files: { 'fee-manager-refresh-request.json': { content: raw } }, history: [{ version: 'b'.repeat(40) }] }; };
const reqObj = () => MR.mrBuildRequest(ok, crypto.randomUUID(), new Date('2026-11-11T02:00:00.000Z'));

test('client: reviewed write of exactly the request file, read back, then POST {requestId, gistVersion} without credentials', async () => {
  const { calls, api } = client({ patchReply: goodPatch, fetchReplies: [{ requestId: 'x', state: 'queued' }] });
  const r = reqObj(); let recorded = null;
  const reply = await api.MANAGER_REFRESH_CLIENT.submit(r, v => { recorded = v; return true; });
  assert.equal(recorded, 'b'.repeat(40));
  assert.deepEqual(JSON.parse(calls.patch[0].opt.body), { files: { 'fee-manager-refresh-request.json': { content: JSON.stringify(r) } } });
  assert.ok(calls.patch[0].opt.reviewedRefreshRequest);
  assert.equal(api.pending, null);
  assert.equal(calls.fetch[0].url, 'https://intake.example.invalid/v1/requests');
  assert.deepEqual(JSON.parse(calls.fetch[0].init.body), { requestId: r.requestId, gistVersion: 'b'.repeat(40) });
  assert.equal(calls.fetch[0].init.credentials, 'omit');
  assert.equal(calls.fetch[0].init.redirect, 'error');
  assert.ok(!JSON.stringify(calls.fetch[0]).includes('synthetic-token'));
  assert.deepEqual(reply, { requestId: 'x', state: 'queued' });
});

test('client: refuses without identity or with a draft; mismatched readback, source change or a removed pending record never POST', async () => {
  for (const o of [{ authorized: false }, { draft: {} }]) {
    const { calls, api } = client({ ...o, patchReply: goodPatch });
    await assert.rejects(api.MANAGER_REFRESH_CLIENT.submit(reqObj(), () => true));
    assert.equal(calls.patch.length + calls.fetch.length, 0);
  }
  for (const bad of [o => ({ ...goodPatch(o), owner: { id: 1 } }), o => ({ ...goodPatch(o), files: {} }), o => ({ ...goodPatch(o), history: [] })]) {
    const { calls, api } = client({ patchReply: bad });
    await assert.rejects(api.MANAGER_REFRESH_CLIENT.submit(reqObj(), () => true));
    assert.equal(calls.fetch.length, 0);
  }
  const switched = client({ patchReply: (opt, live) => { live.token = 'another-token-not-real-00000'; return goodPatch(opt); } });
  await assert.rejects(switched.api.MANAGER_REFRESH_CLIENT.submit(reqObj(), () => true), /来源或身份已变化/);
  assert.equal(switched.calls.fetch.length, 0);
  const removed = client({ patchReply: goodPatch });
  await assert.rejects(removed.api.MANAGER_REFRESH_CLIENT.submit(reqObj(), () => false), /已被撤销或移除/);
  assert.equal(removed.calls.fetch.length, 0);
});

test('client: close and status are plain credential-less calls; no resend exists', async () => {
  const { calls, api } = client({ fetchReplies: [{ requestId: ID, state: 'closed' }, { requestId: ID, state: 'queued' }] });
  assert.deepEqual(await api.MANAGER_REFRESH_CLIENT.close(ID), { requestId: ID, state: 'closed' });
  assert.equal(calls.fetch[0].url, 'https://intake.example.invalid/v1/requests/' + ID + '/close');
  assert.equal(calls.fetch[0].init.method, 'POST');
  assert.equal(calls.fetch[0].init.body, undefined);
  await api.MANAGER_REFRESH_CLIENT.status(ID);
  assert.equal(calls.fetch[1].init.method, 'GET');
  assert.equal(api.MANAGER_REFRESH_CLIENT.resend, undefined);
});

test('client HTTP: submit accepts only the intake acknowledgements and explicit status/code rejections', async () => {
  const cases = [
    ...['queued', 'duplicate', 'unknown'].map(state => [202, { requestId: ID, state }, 'pending']),
    ...[[400, 'REQUEST_INVALID'], [400, 'REQUEST_STALE'], [403, 'IDENTITY_UNVERIFIED'], [409, 'REQUEST_CLOSED'], [503, 'VERIFY_UNAVAILABLE']]
      .map(([status, code]) => [status, { requestId: ID, state: 'rejected', code }, 'rejected']),
  ];
  for (const [status, body, expected] of cases) {
    const browser = client({ patchReply: goodPatch, fetchImpl: async () => ({ status, json: async () => body }) });
    const d = deps(browser.api.MANAGER_REFRESH_CLIENT), result = await MR.mrSubmit(ok, d);
    assert.equal(result.state, expected, JSON.stringify({ status, body }));
    assert.equal(d.ps.has(ID), expected === 'pending');
    assert.equal(browser.calls.fetch.length, 1, 'one POST, no retry');
  }
});

test('client HTTP: contradictory submit replies retain the posted request without success or blind resend', async () => {
  const final = { requestId: ID, contents: ['fee'], fee: { state: 'published', code: 'PUBLISHED' }, ratio: null };
  const cases = [
    ...[200, 201, 400, 403, 409, 429, 500, 503].map(status => [status, { requestId: ID, state: 'queued' }]),
    ...[202, 400, 503].map(status => [status, final]),
    [202, { requestId: ID, state: 'rejected', code: 'REQUEST_INVALID' }],
    [403, { requestId: ID, state: 'rejected', code: 'REQUEST_STALE' }],
    [503, { code: 'INTAKE_NOT_ACTIVE' }],
    [503, { requestId: ID, state: 'rejected', code: 'VERIFY_UNAVAILABLE', fee: final.fee }],
  ];
  for (const [status, body] of cases) {
    const browser = client({ patchReply: goodPatch, fetchImpl: async () => ({ status, json: async () => body }) });
    const d = deps(browser.api.MANAGER_REFRESH_CLIENT), result = await MR.mrSubmit(ok, d);
    assert.equal(result.state, 'unknown', JSON.stringify({ status, body }));
    assert.equal(d.ps.get(ID).posts, 1);
    assert.equal((await MR.mrSubmit({ ...ok, pending: true }, d)).state, 'refused');
    assert.equal(browser.calls.fetch.length, 1, 'uncertain delivery is never retried');
  }
});

test('client HTTP: only HTTP 200 query proofs or a valid atomic close resolve a pending request', async () => {
  const pending = { ...reqObj(), requestId: ID, posts: 1 };
  const final = { requestId: ID, contents: ['fee'], fee: { state: 'published', code: 'PUBLISHED' }, ratio: null };
  for (const [status, body, done] of [[200, final, true], [200, { requestId: ID, state: 'closed' }, true],
    [503, final, false], [503, { requestId: ID, state: 'closed' }, false],
    [404, { requestId: ID, state: 'not-received' }, false], [202, { requestId: ID, state: 'queued' }, false]]) {
    const browser = client({ fetchImpl: async () => ({ status, json: async () => body }) });
    const d = deps(browser.api.MANAGER_REFRESH_CLIENT); d.ps.save(pending);
    const result = await MR.mrQueryStatus(pending, d);
    assert.equal(result.state, done ? 'done' : 'unknown'); assert.equal(d.ps.has(ID), !done);
    assert.deepEqual(browser.calls.fetch.map(c => c.init.method), ['GET'], 'query error cannot close or resubmit');
    assert.equal(browser.calls.patch.length, 0);
  }
  for (const [status, state, done] of [[200, 'closed', true], [200, 'received', false], [200, 'queued', false],
    [200, 'unknown', false], [503, 'unknown', false], [503, 'closed', false], [202, 'closed', false]]) {
    const browser = client({ fetchImpl: async (_url, init) => init.method === 'GET'
      ? { status: 200, json: async () => ({ requestId: ID, state: 'not-received' }) }
      : { status, json: async () => ({ requestId: ID, state }) } });
    const d = deps(browser.api.MANAGER_REFRESH_CLIENT); d.ps.save(pending);
    const result = await MR.mrQueryStatus(pending, d);
    assert.equal(result.state, done ? 'done' : 'unknown'); assert.equal(d.ps.has(ID), !done);
    assert.deepEqual(browser.calls.fetch.map(c => [c.init.method, new URL(c.url).pathname]),
      [['GET', '/v1/requests/' + ID], ['POST', '/v1/requests/' + ID + '/close']], 'only atomic close follows not-received');
    assert.equal(browser.calls.patch.length, 0);
  }
});

test('page allows the request write only through its own exact reviewed allowance; pending keys are per request', () => {
  assert.ok(html.includes('const refreshRequestWrite=method==="PATCH"&&reviewedRefreshRequest&&reviewedRefreshRequest===_mrRequestWrite'));
  assert.ok(html.includes('request.body===JSON.stringify({files:{[MR_REQUEST_FILE]:{content:reviewedRefreshRequest.raw}}})'));
  assert.ok(html.includes('!ratioSnapshotWrite&&!refreshRequestWrite)throw'));
  assert.ok(html.includes('clearPending:id=>setCfg(MR_PENDING_PREFIX+id,"")'));
});

async function actualClientAcceptance({ replyLost = false } = {}) {
  const t = await e2e({ admissionReady: true });
  const gid = 'a'.repeat(32);
  const browser = client({ gistId: gid, patchReply: opt => {
    t.env.gist = JSON.parse(opt.body).files[t.srv.REQUEST_FILE].content;
    t.env.version = 'b'.repeat(40); t.env.committedAt = t.env.serverNow.toISOString();
    return { id: gid, owner: { id: t.core.OWNER_ID }, history: [{ version: t.env.version }], files: { [t.srv.REQUEST_FILE]: { content: t.env.gist } } };
  }, fetchImpl: async (url, init) => {
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    assert.ok(!JSON.stringify({ url, init }).includes('synthetic-token'), 'no manager credential reaches intake');
    const path = new URL(url).pathname;
    const response = await t.srv.handleIntake({ method: init.method, path, body: init.body, headers: { origin: t.srv.ALLOWED_ORIGIN } }, t.intakeDeps);
    if (init.method === 'POST' && path === '/v1/requests' && replyLost) throw Error('synthetic reply lost after queue');
    return new Response(response.body, { status: response.status, headers: response.headers });
  } });
  return { ...t, browser, d: { ...t.d, intake: browser.api.MANAGER_REFRESH_CLIENT } };
}

test('actual page client -> intake -> acceptance job -> final status refuses publication and clears only its pending request', async () => {
  for (const contents of [['fee'], ['fee', 'ratio']]) {
    const t = await actualClientAcceptance();
    // The second case models an older client requesting an unavailable ratio;
    // the shipped page itself still disables that choice.
    const state = { ...okAt, ratio: contents.includes('ratio'), ratioReady: true };
    assert.equal((await MR.mrSubmit(state, t.d)).state, 'pending'); const pending = t.only();
    assert.equal(t.env.jobStarts, 1); t.advance(60_000);
    assert.equal((await t.job())[0].fee, 'PUBLISHER_REFUSED');
    const final = await t.client.status(pending.requestId);
    assert.equal(final.fee.state, 'failed'); assert.equal(final.fee.code, 'PUBLISHER_REFUSED');
    if (contents.includes('ratio')) { assert.equal(final.ratio.state, 'blocked'); assert.equal(final.ratio.code, 'FEE_NOT_VERIFIED'); }
    const result = await MR.mrQueryStatus(pending, t.d);
    assert.equal(result.state, 'done'); assert.doesNotMatch(result.text, /已核验发布成功/); assert.equal(t.ps.m.size, 0);
    assert.equal(await t.env.ledger.get(t.core.keys.published('fee', '2026-11-10')), null);
    assert.deepEqual(await t.job(), [], 'finished request is never executed twice');
    assert.equal(t.browser.calls.patch.length, 1);
    assert.equal(t.browser.calls.fetch.filter(c => c.init.method === 'POST').length, 1);
    assert.ok(t.env.upstream.every(c => c.method === 'GET'), 'zero producer dispatches');
  }
});

test('actual page client keeps a lost queued reply across reload and resolves by GET without resending', async () => {
  const t = await actualClientAcceptance({ replyLost: true });
  assert.equal((await MR.mrSubmit(okAt, t.d)).state, 'unknown'); const persisted = JSON.parse(JSON.stringify(t.only()));
  assert.equal(t.env.jobStarts, 1); t.advance(60_000); await t.job();
  const reloaded = { ...t.d, intake: t.browser.api.createIntakeClient('https://intake.example.invalid') };
  assert.equal((await MR.mrQueryStatus(persisted, reloaded)).state, 'done'); assert.equal(t.ps.m.size, 0);
  assert.equal(t.browser.calls.patch.length, 1); assert.equal(t.browser.calls.fetch.filter(c => c.init.method === 'POST').length, 1);
});

test('actual page ratio readiness blocks submission before any Gist or intake request', async () => {
  const t = await actualClientAcceptance();
  const result = await MR.mrSubmit({ ...okAt, ratio: true, ratioReady: MR.MR_RATIO_READY }, t.d);
  assert.equal(result.state, 'refused'); assert.equal(t.browser.calls.patch.length, 0); assert.equal(t.browser.calls.fetch.length, 0);
  assert.equal(t.env.queue.rows.size, 0); assert.equal(t.env.ledger.rows.size, 0);
});

// Execute the shipped form functions and click clauses against deliberately
// simulated controls/storage. This is not a DOM renderer or browser acceptance.
function formFixture({ active = false, storage = new Map(), replyLost = false } = {}) {
  const formStart = html.indexOf('let _mrBusy=false,_mrMessage="";');
  const formEnd = html.indexOf('let _manualRefreshing=false;', formStart);
  const clickStart = html.indexOf('if(T.id==="btnRefresh"){', html.indexOf('document.body.addEventListener("click",e=>{const T=e.target;'));
  const clickEnd = html.indexOf('if(T.id==="btnRepairViewer"){', clickStart);
  const confirmationStart = html.indexOf('document.getElementById("cfmCancel").onclick=');
  const confirmationEnd = html.indexOf('document.body.addEventListener("click",e=>{const T=e.target;', confirmationStart);
  assert.ok(formStart > 0 && formEnd > formStart && clickEnd > clickStart && confirmationEnd > confirmationStart);
  const markup = html.slice(html.indexOf('<div class="ovl" id="cfm">'), html.indexOf('<div class="ovl" id="share">'));
  const handlers = [], elements = new Map(), calls = { patch: [], post: [], status: [], close: [], readOnly: 0 };
  const live = { role: 'manager', authorized: true, token: 'synthetic-form-token-only', final: false, replyLost };
  function element(id, attributes = '') {
    const classes = new Set(), node = { id, checked: /\bchecked\b/.test(attributes), disabled: false, value: '',
      type: /type="([^"]+)"/.exec(attributes)?.[1] || '', style: {}, textContent: '', innerHTML: '', onclick: null,
      classList: { add: v => classes.add(v), remove: v => classes.delete(v), contains: v => classes.has(v) },
      click() { if (node.disabled) return; if (node.type === 'checkbox') node.checked = !node.checked;
        node.onclick?.(); for (const fn of handlers) fn({ target: node }); } };
    elements.set(id, node); return node;
  }
  for (const tag of markup.matchAll(/<(?:div|h3|p|label|button|input)\b[^>]*\bid="([^"]+)"[^>]*>/g)) element(tag[1], tag[0]);
  element('btnRefresh');
  const document = { getElementById: id => { assert.ok(elements.has(id), id); return elements.get(id); },
    body: { addEventListener: (kind, fn) => { assert.equal(kind, 'click'); handlers.push(fn); } } };
  const store = { get length() { return storage.size; }, key: i => [...storage.keys()][i] ?? null,
    getItem: key => storage.get(key) ?? null };
  const EDIT = { draft: null, pending: null };
  const cfg = key => key === 'gid' ? 'a'.repeat(32) : key === 'tok' ? live.token : storage.get(key) || '';
  const setCfg = (key, value) => { if (value === '') storage.delete(key); else storage.set(key, value); };
  const env = { document, store, cfg, setCfg, EDIT, navigator: { onLine: true }, crypto,
    K: { gid: 'gid', tok: 'tok' }, _sourceEpoch: 7, _draftBlocked: false, _ledgerBusy: false,
    _managerCapability: { ownerId: 283054367 }, isMgr: () => live.role === 'manager',
    managerDocumentsAuthorized: () => live.authorized && live.role === 'manager',
    manualRefresh: () => { calls.readOnly++; },
    ghApi: async (path, options) => {
      assert.equal(path, '/gists/' + 'a'.repeat(32)); assert.equal(options.method, 'PATCH');
      const body = JSON.parse(options.body); assert.deepEqual(Object.keys(body.files), ['fee-manager-refresh-request.json']);
      calls.patch.push(body);
      return { id: 'a'.repeat(32), owner: { id: 283054367 }, history: [{ version: 'b'.repeat(40) }], files: body.files };
    },
    freshFetch: async (url, init) => {
      assert.ok(url.startsWith('https://intake.example.invalid/v1/requests'));
      assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
      assert.ok(!JSON.stringify({ url, init }).includes(live.token));
      const path = new URL(url).pathname;
      if (init.method === 'POST' && path === '/v1/requests') {
        const body = JSON.parse(init.body); calls.post.push(body);
        if (live.replyLost) throw Error('synthetic reply lost');
        return { status: 202, json: async () => ({ requestId: body.requestId, state: 'queued' }) };
      }
      const id = path.split('/')[3];
      if (init.method === 'GET') {
        calls.status.push(id);
        return { status: 200, json: async () => live.final ? { requestId: id, contents: ['fee'], fee: { state: 'failed', code: 'PUBLISHER_REFUSED' }, ratio: null }
          : { requestId: id, state: 'queued' } };
      }
      assert.equal(path, '/v1/requests/' + id + '/close'); calls.close.push(id);
      return { status: 200, json: async () => ({ requestId: id, state: 'closed' }) };
    } };
  const confirmation = html.match(/^let _cfmCb=null;$/m)?.[0] + '\n' + html.match(/^function confirmBox\(title,msg,cb\)\{[^\n]+$/m)?.[0];
  const escape = html.match(/^const esc=s=>[^\n]+$/m)?.[0]; assert.ok(escape && !confirmation.includes('undefined'));
  const clientCode = active ? clientBlock.replace('const MR_INTAKE_ORIGIN=null;', 'const MR_INTAKE_ORIGIN="https://intake.example.invalid";') : clientBlock;
  const names = Object.keys(env), run = new Function(...names, [block, clientCode, escape, confirmation,
    html.slice(formStart, formEnd), html.slice(confirmationStart, confirmationEnd),
    'document.body.addEventListener("click",e=>{const T=e.target;' + html.slice(clickStart, clickEnd) + '});',
    'return {mrPendings,mrFormState,renderManagerRefresh,get busy(){return _mrBusy;},get message(){return _mrMessage;}};'].join('\n'));
  return { api: run(...names.map(name => env[name])), live, calls, EDIT, storage, el: id => document.getElementById(id),
    sourceSha256: pageHash(html) };
}
async function settleForm(t) {
  for (let i = 0; i < 100 && t.api.busy; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(t.api.busy, false, 'form operation settled');
}

test('shipped form click routing preserves inactive publishing, disabled ratio and ordinary read-only refresh', () => {
  const t = formFixture(); assert.equal(t.sourceSha256, aggregateUiFixture.nextSha256);
  t.el('btnRefresh').click(); assert.equal(t.el('mgrRefresh').classList.contains('on'), true);
  for (const id of ['mrRatio', 'mrAll', 'mrSubmit']) assert.equal(t.el(id).disabled, true, id);
  assert.match(t.el('mrMsg').innerHTML, /尚未激活/); assert.match(t.el('mrRatioNote').textContent, /尚未就绪/);
  t.el('mrAll').click(); assert.equal(t.el('mrAll').checked, false);
  t.el('mrReadOnly').click(); assert.equal(t.calls.readOnly, 1); assert.equal(t.el('mgrRefresh').classList.contains('on'), false);
  t.live.role = 'viewer'; t.el('btnRefresh').click(); assert.equal(t.calls.readOnly, 2);
  assert.equal(t.el('mgrRefresh').classList.contains('on'), false); assert.equal(t.calls.patch.length + t.calls.post.length, 0);
});

test('form confirmation cancellation and changed date, identity or draft never submit the confirmed old state', async () => {
  const t = formFixture({ active: true });
  t.el('btnRefresh').click(); t.el('mrSubmit').click(); assert.equal(t.el('cfm').classList.contains('on'), true);
  assert.match(t.el('cfmMsg').textContent, /同步已完成/);
  t.el('cfmCancel').click(); assert.equal(t.el('cfm').classList.contains('on'), false);
  assert.equal(t.calls.patch.length + t.calls.post.length, 0);
  for (const change of [() => { t.el('mrFeeDate').value = t.el('mrFeeDate').value === '2026-11-09' ? '2026-11-08' : '2026-11-09'; },
    () => { t.live.authorized = false; }, () => { t.EDIT.draft = {}; }]) {
    t.live.authorized = true; t.EDIT.draft = null;
    t.el('btnRefresh').click(); t.el('mrSubmit').click(); change(); t.el('cfmOk').click(); await settleForm(t);
    assert.equal(t.calls.patch.length + t.calls.post.length, 0); assert.equal(t.api.mrPendings().length, 0);
  }
});

test('form double confirmation submits once, locks while pending and displays refusal after status-only readback', async () => {
  const t = formFixture({ active: true });
  t.el('btnRefresh').click(); assert.equal(t.el('mrSubmit').disabled, false);
  t.el('mrSubmit').click(); t.el('cfmOk').click(); t.el('cfmOk').click(); await settleForm(t);
  assert.equal(t.calls.patch.length, 1); assert.equal(t.calls.post.length, 1); assert.equal(t.api.mrPendings().length, 1);
  assert.equal(t.el('mrSubmit').disabled, true); assert.equal(t.el('mrStatus').disabled, false);
  t.el('mrSubmit').click(); t.el('mrStatus').click(); await settleForm(t);
  assert.equal(t.api.mrPendings().length, 1); assert.equal(t.calls.post.length, 1);
  t.live.final = true; t.el('mrStatus').click(); await settleForm(t);
  assert.equal(t.api.mrPendings().length, 0); assert.match(t.api.message, /发布前被受保护流程拒绝/);
  assert.doesNotMatch(t.api.message, /已核验发布成功/); assert.equal(t.calls.patch.length, 1); assert.equal(t.calls.post.length, 1);
});

test('form reinitialization preserves a lost reply and resolves stored pending by GET without another write', async () => {
  const t = formFixture({ active: true, replyLost: true });
  t.el('btnRefresh').click(); t.el('mrSubmit').click(); t.el('cfmOk').click(); await settleForm(t);
  assert.match(t.api.message, /结果不明/); assert.equal(t.api.mrPendings().length, 1);
  const reloaded = formFixture({ active: true, storage: t.storage }); reloaded.live.final = true;
  reloaded.el('btnRefresh').click(); assert.equal(reloaded.el('mrSubmit').disabled, true);
  reloaded.el('mrStatus').click(); await settleForm(reloaded);
  assert.equal(reloaded.api.mrPendings().length, 0); assert.equal(reloaded.calls.status.length, 1);
  assert.equal(reloaded.calls.patch.length + reloaded.calls.post.length, 0);
});
