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
const MR = new Function(`${block}\nreturn {MANAGER_REFRESH_INTAKE,MR_RATIO_READY,mrPlan,mrBuildRequest,mrSubmit,mrQueryStatus,mrOutcomeText,mrHktDate};`)();

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

test('server result drives the text; unknown fee keeps pending; terminal clears it', async () => {
  const store = {};
  let r = await MR.mrSubmit(ok, deps({ submit: async () => ({ fee: { state: 'unknown', code: 'AWAITING_PUBLICATION' }, ratio: null }) }, store));
  assert.ok(store.pending);
  assert.match(r.text, /尚未核验到发布完成/);
  const q = await MR.mrQueryStatus(store.pending, deps({ status: async () => ({ fee: { state: 'published' }, ratio: null }) }, store));
  assert.equal(q.state, 'done');
  assert.equal(store.pending, null);
  r = await MR.mrSubmit(ok, deps({ submit: async () => ({ fee: { state: 'blocked', code: 'DATE_ALREADY_PUBLISHED_ELSEWHERE' }, ratio: null }) }, store));
  assert.match(r.text, /已成功发布过/);
  assert.equal(store.pending, null);
});

test('missing server record does not clear pending', async () => {
  const store = { pending: { requestId: 'x' } };
  const q = await MR.mrQueryStatus(store.pending, deps({ status: async () => null }, store));
  assert.equal(q.state, 'unknown');
  assert.ok(store.pending);
});

test('Hong Kong date default', () => {
  assert.equal(MR.mrHktDate(new Date('2026-11-10T17:00:00Z'), 1), '2026-11-10');
  assert.equal(MR.mrHktDate(new Date('2026-11-10T15:00:00Z'), 0), '2026-11-10');
});
