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
const MR = new Function(`${block}\nreturn {MANAGER_REFRESH_INTAKE,MR_RATIO_READY,mrPlan,mrBuildRequest,mrSubmit,mrQueryStatus,mrOutcomeText,mrHktDate,mrResolved,mrStepText};`)();

const ok = { fee: true, ratio: false, feeDate: '2026-11-10', ratioDate: '2026-11-10', ratioReady: false, intakeActive: true, identityVerified: true, draft: false, pending: false, busy: false, online: true };
const deps = (intake, store = {}) => ({ intake, uuid: () => '0b0c0d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e', now: () => new Date('2026-11-11T02:00:00.000Z'),
  savePending: r => { store.pending = r; }, clearPending: () => { store.pending = null; } });

test('shipped page is default-inactive: no server entry, ratio not ready', () => {
  assert.equal(MR.MANAGER_REFRESH_INTAKE, null);
  assert.equal(MR.MR_RATIO_READY, false);
  const plan = MR.mrPlan({ ...ok, intakeActive: !!MR.MANAGER_REFRESH_INTAKE });
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
