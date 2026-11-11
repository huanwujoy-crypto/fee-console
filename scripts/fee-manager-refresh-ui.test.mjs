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
const MR = new Function(`${block}\nreturn {MR_RATIO_READY,mrPlan,mrBuildRequest,mrSubmit,mrQueryStatus,mrOutcomeText,mrHktDate,mrResolved,mrStepText};`)();

const ok = { fee: true, ratio: false, feeDate: '2026-11-10', ratioDate: '2026-11-10', ratioReady: false, intakeActive: true, identityVerified: true, draft: false, pending: false, busy: false, online: true };
const deps = (intake, store = {}) => ({ intake, uuid: () => '0b0c0d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e', now: () => new Date('2026-11-11T02:00:00.000Z'),
  savePending: r => { store.pending = r; }, clearPending: () => { store.pending = null; } });

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
  for (const s of [ok, { ...ok, ratio: true, ratioReady: true, ratioDate: '2026-11-07' }]) {
    const r = MR.mrBuildRequest(s, '0b0c0d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e', new Date('2026-11-11T02:00:00.000Z'));
    assert.equal(validateRequest(r), true, JSON.stringify(r));
  }
  const both = MR.mrBuildRequest({ ...ok, ratio: true, ratioDate: '2026-11-07' }, 'x', new Date());
  assert.deepEqual(both.contents, ['fee', 'ratio']);
  assert.equal(both.ratioDataAsOf, '2026-11-07', 'ratio keeps its own date');
});

test('submit records pending before sending; lost reply keeps it and never resends', async () => {
  const store = {}, sent = [];
  const intake = { submit: async r => { sent.push(r); assert.ok(store.pending, 'pending saved before network'); throw new Error('offline'); } };
  const r = await MR.mrSubmit(ok, deps(intake, store));
  assert.equal(r.state, 'unknown');
  assert.equal(sent.length, 1);
  assert.equal(store.pending.requestId, r.request.requestId);
  const again = await MR.mrSubmit({ ...ok, pending: true }, deps(intake, store));
  assert.equal(again.state, 'refused');
  assert.equal(sent.length, 1, 'no blind retry');
});

const ID = '0b0c0d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';
test('pending is kept for queued, duplicate, none, missing fields, other ids and non-final states', async () => {
  const keep = [
    { requestId: ID, state: 'queued' }, { requestId: ID, state: 'duplicate' }, { requestId: ID, state: 'unknown' }, { requestId: ID, state: 'none' },
    {}, null, { fee: { state: 'published', code: 'PUBLISHED' } },
    { requestId: 'other', contents: ['fee'], fee: { state: 'published', code: 'PUBLISHED' }, ratio: null },
    { requestId: ID, contents: ['fee'], fee: { state: 'published' }, ratio: null },
    { requestId: ID, contents: ['fee'], fee: { state: 'unknown', code: 'AWAITING_PUBLICATION' }, ratio: null },
    { requestId: ID, contents: ['fee'], fee: null, ratio: null },
  ];
  for (const reply of keep) {
    const store = {};
    await MR.mrSubmit(ok, deps({ submit: async () => reply }, store));
    assert.ok(store.pending, 'kept for ' + JSON.stringify(reply));
    const q = await MR.mrQueryStatus(store.pending, deps({ status: async () => reply }, store));
    assert.notEqual(q.state, 'done');
    assert.ok(store.pending);
  }
  const both = { requestId: ID, contents: ['fee', 'ratio'] };
  assert.equal(MR.mrResolved({ ...both, fee: { state: 'published', code: 'PUBLISHED' }, ratio: null }, both), false, 'every requested kind needs a final state');
  assert.equal(MR.mrResolved({ ...both, fee: { state: 'published', code: 'PUBLISHED' }, ratio: { state: 'blocked', code: 'RATIO_COLLECTOR_NOT_CONFIGURED' } }, both), true);
  assert.equal(MR.mrResolved({ requestId: ID, code: 'REQUEST_STALE', fee: null, ratio: null }, { requestId: ID, contents: ['fee'] }), true, 'explicit pre-execution rejection');
});

test('status text: published is success; unavailable is not asserted as unpublished', () => {
  assert.equal(MR.mrStepText('管理费', { state: 'published', code: 'PUBLISHED' }), '管理费：已核验发布成功');
  assert.equal(MR.mrStepText('管理费', { state: 'published' }), '管理费：已核验发布成功');
  assert.equal(MR.mrStepText('管理费', { state: 'blocked', code: 'VERIFY_UNAVAILABLE' }), '管理费：尚无法确认是否已发布');
  assert.equal(MR.mrStepText('管理费', { state: 'weird' }), '管理费：状态未确认，不会自动重试');
  assert.doesNotMatch(MR.mrStepText('管理费', { state: 'published' }), /未发布/);
  assert.match(MR.mrOutcomeText({ requestId: ID, state: 'queued' }, { requestId: ID, contents: ['fee'] }), /等待服务端处理/);
});

test('integration with the real intake reply and job status projection schema', async () => {
  const srv = await import('./fee-manager-refresh-server.mjs');
  const core = await import('./fee-manager-refresh.mjs');
  const GIST = 'a'.repeat(32), VER = 'b'.repeat(40), NOW = new Date('2026-11-11T02:05:00.000Z');
  const bucket = () => { const b = core.createMemoryLedger(); b.names = async p => (await b.list(p)).map(x => x.key); return b; };
  const queue = bucket(), status = bucket(), ledger = bucket();
  let req = null;
  const gistHttp = async (method, url) => url === 'https://api.github.com/gists/' + GIST
    ? { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ id: GIST, public: false, owner: { id: core.OWNER_ID }, history: [{ version: VER, committed_at: '2026-11-11T02:01:00Z', user: { id: core.OWNER_ID } }], files: { [srv.REQUEST_FILE]: { content: JSON.stringify(req), truncated: false } } })) }
    : { status: 503, bytes: new Uint8Array() };
  const intakeDeps = { http: gistHttp, queue, status, gistId: GIST, now: () => NOW, runJob: async () => {} };
  const call = (method, path, body) => srv.handleIntake({ method, path, headers: { origin: srv.ALLOWED_ORIGIN }, body }, intakeDeps).then(r => JSON.parse(r.body));
  const intake = { submit: async r => { req = r; return call('POST', '/v1/requests', JSON.stringify({ requestId: r.requestId, gistVersion: VER })); }, status: id => call('GET', '/v1/requests/' + id) };
  const store = {};
  const d = { ...deps(intake, store), uuid: () => crypto.randomUUID(), now: () => new Date('2026-11-11T02:00:00.000Z') };
  const sent = await MR.mrSubmit(ok, d);
  assert.equal(sent.state, 'pending');
  assert.ok(store.pending, 'queued keeps pending');
  assert.equal((await MR.mrQueryStatus(store.pending, d)).state, 'unknown', 'no projection yet keeps pending');
  // Acceptance-mode job: real verification and claim path, GitHub reads unavailable.
  await srv.runRefreshJob({ ledger, queue, status, http: gistHttp, gistId: GIST, now: () => NOW, wait: async () => {}, readToken: () => 'synthetic-token-not-real-0000', validateHealth: () => [], mode: 'acceptance' });
  const q = await MR.mrQueryStatus(store.pending, d);
  assert.equal(q.state, 'done', 'explicit final code for the requested kind');
  assert.match(q.text, /尚无法确认是否已发布/);
  assert.equal(store.pending, null);
});

test('confirmation copy states the click replaces the completed-sync instruction; read-only stays separate', () => {
  assert.ok(html.includes('这次点击将代替你以往发出的“同步已完成，请发布”指示'));
  assert.ok(html.includes('if(T.id==="mrSubmit"){confirmManagerRefresh();return;}'));
  assert.ok(html.includes('if(T.id==="mrReadOnly"){document.getElementById("mgrRefresh").classList.remove("on");manualRefresh();return;}'));
  assert.ok(html.includes('if(!mrPlan(s).canSubmit||!confirmed||'), 'submission requires the explicit confirmation of the same selection');
});

test('Hong Kong date default', () => {
  assert.equal(MR.mrHktDate(new Date('2026-11-10T17:00:00Z'), 1), '2026-11-10');
  assert.equal(MR.mrHktDate(new Date('2026-11-10T15:00:00Z'), 0), '2026-11-10');
});

// ---- real client (extracted block, injected page globals; no network)
const CS = '/* manager-refresh-client:start */', CE = '/* manager-refresh-client:end */';
const clientBlock = html.slice(html.indexOf(CS), html.indexOf(CE));
function client({ patchReply, fetchReplies = [], authorized = true, draft = null } = {}) {
  const calls = { patch: [], fetch: [] };
  const env = {
    managerDocumentsAuthorized: () => authorized, EDIT: { draft, pending: null }, _draftBlocked: false, _ledgerBusy: false,
    cfg: k => ({ gid: 'g'.repeat(32), tok: 'synthetic-token-not-real-0000' })[k] || '', K: { gid: 'gid', tok: 'tok' }, _sourceEpoch: 7,
    _managerCapability: { ownerId: 283054367 },
    ghApi: async (path, opt) => { calls.patch.push({ path, opt }); return typeof patchReply === 'function' ? patchReply(opt) : patchReply; },
    freshFetch: async (url, init) => { calls.fetch.push({ url, init }); const v = fetchReplies.shift(); return { json: async () => v }; },
  };
  env.cfg = k => (k === 'gid' ? 'g'.repeat(32) : k === 'tok' ? 'synthetic-token-not-real-0000' : '');
  const names = Object.keys(env);
  const fn = new Function(...names, `${clientBlock.replace('const MR_INTAKE_ORIGIN=null;', 'const MR_INTAKE_ORIGIN="https://intake.example.invalid";')}\nreturn {createIntakeClient, MANAGER_REFRESH_CLIENT, writeRefreshRequest, get pending(){return _mrRequestWrite;}};`);
  return { calls, api: fn(...names.map(n => env[n])) };
}
const goodPatch = opt => { const raw = JSON.parse(opt.body).files['fee-manager-refresh-request.json'].content; return { id: 'g'.repeat(32), owner: { id: 283054367 }, files: { 'fee-manager-refresh-request.json': { content: raw } }, history: [{ version: 'b'.repeat(40) }] }; };
const reqObj = () => MR.mrBuildRequest(ok, crypto.randomUUID(), new Date('2026-11-11T02:00:00.000Z'));

test('client: reviewed write of exactly the request file, read back, then POST {requestId, gistVersion} without credentials', async () => {
  const { calls, api } = client({ patchReply: goodPatch, fetchReplies: [{ requestId: 'x', state: 'queued' }] });
  const r = reqObj(); let recorded = null;
  const reply = await api.MANAGER_REFRESH_CLIENT.submit(r, v => { recorded = v; });
  assert.equal(recorded, 'b'.repeat(40), 'version recorded before the POST');
  assert.equal(calls.patch.length, 1);
  assert.equal(calls.patch[0].path, '/gists/' + 'g'.repeat(32));
  assert.deepEqual(JSON.parse(calls.patch[0].opt.body), { files: { 'fee-manager-refresh-request.json': { content: JSON.stringify(r) } } });
  assert.ok(calls.patch[0].opt.reviewedRefreshRequest, 'uses the dedicated reviewed allowance');
  assert.equal(api.pending, null, 'allowance cleared after use');
  assert.equal(calls.fetch[0].url, 'https://intake.example.invalid/v1/requests');
  assert.equal(calls.fetch[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls.fetch[0].init.body), { requestId: r.requestId, gistVersion: 'b'.repeat(40) });
  assert.equal(calls.fetch[0].init.credentials, 'omit');
  assert.equal(calls.fetch[0].init.redirect, 'error');
  assert.ok(!JSON.stringify(calls.fetch[0]).includes('synthetic-token'), 'no token leaves the page');
  assert.deepEqual(reply, { requestId: 'x', state: 'queued' });
});

test('client: refuses without verified identity or with a draft; mismatched readback never POSTs', async () => {
  for (const o of [{ authorized: false }, { draft: {} }]) {
    const { calls, api } = client({ ...o, patchReply: goodPatch });
    await assert.rejects(api.MANAGER_REFRESH_CLIENT.submit(reqObj(), () => {}));
    assert.equal(calls.patch.length + calls.fetch.length, 0);
  }
  for (const bad of [o => ({ ...goodPatch(o), owner: { id: 1 } }), o => ({ ...goodPatch(o), files: {} }), o => ({ ...goodPatch(o), history: [] })]) {
    const { calls, api } = client({ patchReply: bad });
    await assert.rejects(api.MANAGER_REFRESH_CLIENT.submit(reqObj(), () => {}));
    assert.equal(calls.fetch.length, 0);
  }
});

test('page allows the request write only through its own exact reviewed allowance', () => {
  assert.ok(html.includes('const refreshRequestWrite=method==="PATCH"&&reviewedRefreshRequest&&reviewedRefreshRequest===_mrRequestWrite'));
  assert.ok(html.includes('request.body===JSON.stringify({files:{[MR_REQUEST_FILE]:{content:reviewedRefreshRequest.raw}}})'));
  assert.ok(html.includes('!ratioSnapshotWrite&&!refreshRequestWrite)throw'));
});

test('status "none": re-deliver the same request id and version only, pending kept', async () => {
  const store = { pending: { requestId: ID, contents: ['fee'], gistVersion: 'b'.repeat(40) } }, resent = [];
  const q = await MR.mrQueryStatus(store.pending, deps({ status: async () => ({ requestId: ID, state: 'none' }), resend: async p => { resent.push(p); return { requestId: ID, state: 'queued' }; } }, store));
  assert.deepEqual(resent, [store.pending]);
  assert.equal(q.state, 'unknown');
  assert.ok(store.pending);
  const noVersion = { requestId: ID, contents: ['fee'] };
  await MR.mrQueryStatus(noVersion, deps({ status: async () => ({ requestId: ID, state: 'none' }), resend: async () => { throw new Error('must not resend without a recorded version'); } }, {}));
});
