// Synthetic transports only: no network, credentials or real ledger/Gist.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createGcsBucket, verifyOwnerRequest, handleIntake, createGitHubFeeAdapters, runRefreshJob, acceptancePublisher, candidateFromLog, stepScript, ALLOWED_ORIGIN, REQUEST_FILE, API } from './fee-manager-refresh-server.mjs';
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

const RUN_OK = { workflow_run_id: 42, run_url: API + '/actions/runs/42', html_url: 'https://github.com/huanwujoy-crypto/fee-console/actions/runs/42' };
function dispatchWorld() {
  const sent = [], w = { reply: { status: 200, bytes: enc(RUN_OK) } };
  const http = async (method, url, opts = {}) => { if (method === 'POST') { sent.push({ url, headers: opts.headers, body: JSON.parse(opts.body) }); return w.reply; } return { status: 404 }; };
  w.sent = sent; w.publisher = createGitHubFeeAdapters({ http, readToken: () => 'synthetic-token-not-real-0000', now: () => NOW }).publisher;
  return w;
}

test('producer dispatch: exact existing confirmed-sync inputs, pinned API version, full run identity', async () => {
  const w = dispatchWorld(), main = 'c'.repeat(40);
  assert.deepEqual(await w.publisher.start({ dataDate: '2026-11-10', claimMainSha: main }), { state: 'started', handle: '42' });
  assert.equal(w.sent[0].url, API + '/actions/workflows/fee-cloud-producer.yml/dispatches');
  assert.equal(w.sent[0].headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.deepEqual(w.sent[0].body, { ref: 'main', return_run_details: true, inputs: { run_reviewed_once: 'true', report_kind: 'daily', report_target: '2026-11-10', manual_sync_completed_for: '2026-11-10', confirmed_main: main } });
  w.reply = { status: 422, bytes: enc('') };
  assert.deepEqual(await w.publisher.start({ dataDate: '2026-11-10', claimMainSha: main }), { state: 'refused' });
});

test('producer dispatch: 204, missing fields, cross-repository URLs, error bodies and rate limits are unknown', async () => {
  const main = 'c'.repeat(40);
  const unknown = {
    '204 legacy': { status: 204, bytes: enc('') },
    'missing run_url': { status: 200, bytes: enc({ workflow_run_id: 42, html_url: RUN_OK.html_url }) },
    'missing html_url': { status: 200, bytes: enc({ workflow_run_id: 42, run_url: RUN_OK.run_url }) },
    'other repository run_url': { status: 200, bytes: enc({ ...RUN_OK, run_url: 'https://api.github.com/repos/someone/fee-console/actions/runs/42' }) },
    'other repository html_url': { status: 200, bytes: enc({ ...RUN_OK, html_url: 'https://github.com/someone/fee-console/actions/runs/42' }) },
    'mismatched run id': { status: 200, bytes: enc({ ...RUN_OK, run_url: API + '/actions/runs/43' }) },
    'string run id': { status: 200, bytes: enc({ ...RUN_OK, workflow_run_id: '42' }) },
    '200 error structure': { status: 200, bytes: enc({ message: 'Server Error' }) },
    '200 not JSON': { status: 200, bytes: enc('<html>') },
    '403': { status: 403, bytes: enc('') }, '429': { status: 429, bytes: enc('') }, '502': { status: 502, bytes: enc('') },
  };
  for (const [name, reply] of Object.entries(unknown)) {
    const w = dispatchWorld(); w.reply = reply;
    await assert.rejects(w.publisher.start({ dataDate: '2026-11-10', claimMainSha: main }), /uncertain/, name);
    assert.equal(w.sent.length, 1, name + ': one POST, never resent');
  }
});

test('unknown dispatch reply is never resent by the coordinator', async () => {
  const core = await import('./fee-manager-refresh.mjs');
  const w = dispatchWorld(); w.reply = { status: 200, bytes: enc({ workflow_run_id: 42 }) };
  const ledger = core.createMemoryLedger();
  const verifier = { coverage: async () => ({ mainSha: 'c'.repeat(40), targetDate: '2026-11-09' }), verify: async () => ({ state: 'not-published', targetDate: '2026-11-09' }), isAncestor: async () => false };
  const c = core.createRefreshCoordinator({ ledger, now: () => NOW, wait: async () => {}, feePublisher: w.publisher, feeVerifier: verifier, pipelineIdle: async () => false });
  const id = { verified: true, ownerId: OWNER_ID, method: 'owner-gist-authored-request' };
  assert.equal((await c.submit(request(), id)).fee.code, 'START_UNKNOWN');
  assert.equal((await c.submit(request(), id)).fee.code, 'ATTEMPT_IN_FLIGHT');
  assert.equal(w.sent.length, 1);
});

const MAIN0 = '1'.repeat(40);
// Minimal redacted fixture shaped like job 129766463139 (run 42797516508,
// Produce daily 2026-11-09). Observed verbatim and supplied by the
// coordinator: the group header at 10:16:06.4373403Z, the ANSI-wrapped
// `node scripts/fee-cloud-commit.mjs` echo, and the candidate line at
// 10:16:10.1547988Z. The remaining echo/shell/env lines follow GitHub's
// standard run-step format and are reconstructed from the workflow text;
// confirm them against the real log in acceptance. No values or secrets.
const CAND = '153630773b26137f86943acfcae2bbb95ad141b8';
const WORKFLOW = fs.readFileSync(new URL('../.github/workflows/fee-cloud-producer.yml', import.meta.url), 'utf8');
const SCRIPT = stepScript(WORKFLOW);
const A = l => '\x1b[36;1m' + l + '\x1b[0m';
const LOG = [
  '2026-11-10T10:15:58.1000000Z ##[group]Run set -euo pipefail',
  '2026-11-10T10:15:58.1000000Z ' + A('set -euo pipefail'),
  '2026-11-10T10:15:58.1000000Z ' + A('error_file="$RUNNER_TEMP/fee-cloud-private/producer-error.txt"'),
  '2026-11-10T10:15:58.1000000Z ##[endgroup]',
  '2026-11-10T10:16:06.4373403Z ##[group]Run set -euo pipefail',
  '2026-11-10T10:16:06.4374000Z ' + A('set -euo pipefail'),
  '2026-11-10T10:16:06.4374000Z ' + A('node scripts/fee-cloud-commit.mjs \\'),
  '2026-11-10T10:16:06.4374000Z ' + A('  --data="$RUNNER_TEMP/fee-cloud-private/data.json" \\'),
  '2026-11-10T10:16:06.4374000Z ' + A('  --health="$RUNNER_TEMP/fee-cloud-private/fee-data-health.json" \\'),
  '2026-11-10T10:16:06.4374000Z ' + A('  --base-sha="$(git rev-parse HEAD)"'),
  '2026-11-10T10:16:06.4374000Z shell: /usr/bin/bash --noprofile --norc -e -o pipefail {0}',
  '2026-11-10T10:16:06.4374000Z env:',
  '2026-11-10T10:16:06.4374000Z   FEE_CLOUD_GITHUB_TOKEN: ***',
  '2026-11-10T10:16:06.4375000Z ##[endgroup]',
  '2026-11-10T10:16:10.1547988Z candidate ' + CAND,
  '2026-11-10T10:16:10.3000000Z ##[group]Run if [[ -d "$RUNNER_TEMP/fee-cloud-private" ]]; then',
].join('\n');
const STEP = { name: 'Create a signed owner candidate', number: 11, conclusion: 'success', started_at: '2026-11-10T10:16:06Z', completed_at: '2026-11-10T10:16:10Z' };
const OPTS = { script: SCRIPT, stepStart: STEP.started_at, stepEnd: STEP.completed_at };
function provenanceWorld(over = {}) {
  const o = { log: LOG, verified: true, author: 'huanwujoy-crypto', committer: 'web-flow', parent: MAIN0, actor: OWNER_ID, message: 'daily 2026-11-09',
    jobName: 'Produce daily 2026-11-09', step: STEP, branchSha: CAND, mainSha: CAND, workflow: WORKFLOW, logHost: 'productionresultssa12.blob.core.windows.net', ...over };
  const seen = [];
  const http = async (method, url, opts = {}) => {
    seen.push({ url, opts });
    const ok = v => ({ status: 200, bytes: enc(v) });
    if (url.endsWith('/actions/runs/42797516508')) return ok({ id: 42797516508, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', path: '.github/workflows/fee-cloud-producer.yml', head_branch: 'main', run_attempt: 1, actor: { id: o.actor }, head_sha: MAIN0 });
    if (url.includes('/actions/runs/42797516508/attempts/1/jobs')) return ok({ total_count: 2, jobs: [{ id: 7, run_id: 42797516508, name: 'period' }, { id: 129766463139, run_id: 42797516508, name: o.jobName, head_sha: MAIN0, conclusion: 'success', steps: [o.step] }] });
    if (url.endsWith('/actions/jobs/129766463139/logs')) { assert.equal(opts.redirect, 'manual'); return { status: 302, bytes: enc(''), location: 'https://' + o.logHost + '/logs/9?sig=x' }; }
    if (url.startsWith('https://' + o.logHost + '/')) { assert.equal(opts.external, true); assert.deepEqual(opts.headers, {}); return ok(o.log); }
    if (url.endsWith('/commits/' + CAND)) return ok({ sha: CAND, parents: [{ sha: o.parent }], author: { login: o.author }, committer: { login: o.committer }, commit: { message: o.message, verification: { verified: o.verified } } });
    if (url.includes('/git/matching-refs/heads/codex/fee-daily-20261109-')) return ok([{ ref: 'refs/heads/codex/fee-daily-20261109-a1b2c3', object: { sha: o.branchSha } }]);
    if (url.endsWith('/git/ref/heads/main')) return ok({ object: { sha: o.mainSha } });
    if (url.includes('/compare/')) return ok({ status: 'diverged', behind_by: 1 });
    const m = /\/contents\/(.+)\?ref=([a-f0-9]{40})$/.exec(url);
    if (m && m[1] === '.github/workflows/fee-cloud-producer.yml') { assert.equal(m[2], MAIN0, 'workflow read at the run head'); return ok(o.workflow); }
    if (m) return { status: 200, bytes: enc(m[1] === 'data.json' ? 'D' : 'H') };
    return { status: 404 };
  };
  return { seen, publisher: createGitHubFeeAdapters({ http, readToken: () => 'synthetic-token-not-real-0000', now: () => NOW }).publisher };
}
const RUN = '42797516508', DAY = '2026-11-09';

test('provenance: run -> its produce job -> trusted command group -> candidate -> signed owner commit -> promoted main', async () => {
  const w = provenanceWorld();
  assert.deepEqual(await w.publisher.provenance({ handle: RUN, dataDate: DAY }), { accountingThrough: DAY, dataSha256: sha('D'), healthSha256: sha('H'), promotedMainSha: CAND });
  assert.ok(w.seen.filter(x => x.url.includes('blob.core.windows.net')).every(x => !JSON.stringify(x.opts).includes('synthetic-token')), 'no credential to the log host');
});

test('trusted step script is read from the producer workflow itself', () => {
  assert.deepEqual(SCRIPT, ['set -euo pipefail', 'node scripts/fee-cloud-commit.mjs \\', '--data="$RUNNER_TEMP/fee-cloud-private/data.json" \\', '--health="$RUNNER_TEMP/fee-cloud-private/fee-data-health.json" \\', '--base-sha="$(git rev-parse HEAD)"']);
  assert.equal(stepScript(WORKFLOW.replace('- name: Create a signed owner candidate', '- name: Renamed')), null);
  assert.equal(stepScript(''), null);
});

test('provenance blocked on any missing, extra, cross-group or out-of-step link', async () => {
  const L = LOG.split('\n');
  const edit = (i, v) => L.map((x, k) => (k === i ? v : x)).join('\n');
  const cases = {
    'second candidate line': { log: LOG + '\n2026-11-10T10:16:10.2000000Z candidate ' + CAND },
    'look-alike candidate text elsewhere': { log: LOG + '\n2026-11-10T10:16:11Z note: candidate ' + '3'.repeat(40) },
    'candidate inside another group': { log: [...L.slice(0, 3), '2026-11-10T10:15:58.2Z candidate ' + CAND, ...L.slice(3, 14), ...L.slice(15)].join('\n') },
    'candidate after the next group starts': { log: [...L.slice(0, 14), L[15], L[14]].join('\n') },
    'echoed command differs from the workflow': { log: edit(6, '2026-11-10T10:16:06.4374000Z ' + A('node scripts/other.mjs \\')) },
    'echoed command not ANSI-wrapped (forged plain text)': { log: L.map(x => x.replace(/\x1b\[[0-9;]*m/g, '')).join('\n') },
    'extra echoed command line': { log: [...L.slice(0, 10), '2026-11-10T10:16:06.4374000Z ' + A('curl x'), ...L.slice(10)].join('\n') },
    'two identical trusted groups': { log: [...L.slice(0, 14), ...L.slice(4, 14), ...L.slice(14)].join('\n') },
    'candidate outside the step time': { step: { ...STEP, completed_at: '2026-11-10T10:16:08Z' } },
    'workflow at head has no such step': { workflow: WORKFLOW.replace('- name: Create a signed owner candidate', '- name: Something else') },
    'unexpected log host': { logHost: 'evil.example' },
    'unsigned commit': { verified: false }, 'other author': { author: 'someone-else' }, 'other committer': { committer: 'x' },
    'parent differs': { parent: '9'.repeat(40) }, 'other date subject': { message: 'daily 2026-11-08' },
    'not owner actor': { actor: 999 }, 'job for another date': { jobName: 'Produce daily 2026-11-08' }, 'commit step failed': { step: { ...STEP, conclusion: 'failure' } },
    'branch points elsewhere': { branchSha: '8'.repeat(40) }, 'not promoted to main': { mainSha: '4'.repeat(40) },
  };
  // Blocked = null, or a thrown read error (the coordinator treats both as unbound, never success).
  for (const [name, c] of Object.entries(cases)) assert.equal(await provenanceWorld(c).publisher.provenance({ handle: RUN, dataDate: DAY }).catch(() => null), null, name);
  assert.equal(await provenanceWorld().publisher.provenance({ handle: null, dataDate: DAY }), null);
});

test('candidate log parser on the real shape', () => {
  assert.equal(candidateFromLog(LOG, OPTS), CAND);
  assert.equal(candidateFromLog(LOG, {}), null, 'no trusted script, no answer');
  assert.equal(candidateFromLog('', OPTS), null);
  assert.equal(candidateFromLog(LOG.replace('candidate ' + CAND, 'candidate ' + CAND.slice(1)), OPTS), null);
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
