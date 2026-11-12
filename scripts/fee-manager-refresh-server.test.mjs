// Synthetic transports only: no network, credentials or real ledger/Gist.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createGcsBucket, verifyOwnerRequest, handleIntake, createGitHubFeeAdapters, runRefreshJob, acceptancePublisher, candidateFromLog, stepScript, ALLOWED_ORIGIN, REQUEST_FILE, API, ROLE_ACCESS, CLOSED_SCHEMA } from './fee-manager-refresh-server.mjs';
import { createMemoryLedger, OWNER_ID, SCHEMA, keys } from './fee-manager-refresh.mjs';
import { readConfig, createHttp, createMetadataToken, startJob, createIntakeHandler, runJob, credentialFor } from './fee-manager-refresh-entry.mjs';

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
  assert.deepEqual(JSON.parse((await get(r.requestId)).body), { requestId: r.requestId, state: 'not-received' });
  await x.queue.create('queue/' + r.requestId, { schema: 'fee-console.manager-refresh-queue.v1', requestId: r.requestId, gistVersion: VER, queuedAt: NOW.toISOString() });
  assert.deepEqual(JSON.parse((await get(r.requestId)).body), { requestId: r.requestId, state: 'queued' }, 'received, no projection yet');
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
  assert.equal((await latest(w, r.requestId)).code, 'REQUEST_STALE');
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
  await Promise.all([runRefreshJob(args), runRefreshJob(args)]);
  const st = await w.ledger.get(keys.batch(r.requestId));
  assert.equal(st.request.requestId, r.requestId);
  const rows = [...w.ledger.rows.keys()];
  assert.equal(rows.filter(k => k.endsWith('/request')).length, 1, 'one batch');
  assert.equal(rows.filter(k => k.includes('/fee/')).length, 0, 'no claim: admission read was unavailable');
  assert.deepEqual((await w.ledger.get(keys.feeGate(r.requestId))).code, 'VERIFY_UNAVAILABLE');
  assert.ok(await w.ledger.get(keys.done(r.requestId)), 'final once');
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
  const acc = { ...base, FEE_REFRESH_MODE: 'acceptance', FEE_REFRESH_QUEUE_BUCKET: 'q-acceptance', FEE_REFRESH_STATUS_BUCKET: 's-acceptance', FEE_REFRESH_JOB: 'projects/family-portfolio-gateway/locations/asia-east2/jobs/fee-refresh-launch-acceptance' };
  assert.equal(readConfig(acc, 'serve').mode, 'acceptance');
  assert.throws(() => readConfig({ ...acc, FEE_REFRESH_JOB: base.FEE_REFRESH_JOB }, 'serve'), /CONFIG/, 'acceptance intake may not start the production job');
  assert.throws(() => readConfig({ ...base, FEE_REFRESH_MODE: 'launch', FEE_REFRESH_JOB: acc.FEE_REFRESH_JOB }, 'serve'), /CONFIG/, 'production intake may not start the acceptance job');
  assert.throws(() => readConfig({ ...base, FEE_REFRESH_MODE: 'launch', FEE_REFRESH_QUEUE_BUCKET: 'x-acceptance' }, 'serve'), /CONFIG/);
  assert.throws(() => readConfig({ ...base, FEE_REFRESH_MODE: 'nope' }, 'serve'), /CONFIG/);
  const h = createIntakeHandler({ mode: 'disabled' }, {});
  assert.equal((await h({ method: 'POST' })).status, 503);
  assert.deepEqual(await runJob({ mode: 'disabled' }, {}), { mode: 'disabled', handled: 0 });
});

test('entry http: fixed hosts, no redirects, Google token only to Google hosts; job start has no overrides', async () => {
  const seen = [];
  const http = createHttp({ metadataToken: async () => 'meta', fetchImpl: async (url, init) => { seen.push({ url, init }); return new Response(new Uint8Array(2)); } });
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

// ---- independent review of c465923: crash recovery, final-state keeping, >100 queue
const queued = async (w, r, at = NOW) => w.queue.create('queue/' + r.requestId, { schema: 'fee-console.manager-refresh-queue.v1', requestId: r.requestId, gistVersion: VER, queuedAt: at.toISOString() });
// What the page sees: the intake's own GET.
const latest = async (w, id) => JSON.parse((await handleIntake({ method: 'GET', path: '/v1/requests/' + id, headers: { origin: ALLOWED_ORIGIN } }, { queue: w.queue, status: w.status })).body);

test('entry HTTP refuses hostile URL components and external credentials before any IO', async () => {
  let fetches = 0, tokens = 0;
  const http = createHttp({ fetchImpl: async () => { fetches++; }, metadataToken: async () => { tokens++; return 'synthetic'; } });
  for (const url of ['https://user:password@storage.googleapis.com/x', 'https://storage.googleapis.com:444/x', 'https://api.github.com/x#fragment'])
    await assert.rejects(http('GET', url), /FEE_REFRESH_HOST/);
  for (const options of [{ headers: { Authorization: 'synthetic' } }, { body: 'payload' }])
    await assert.rejects(http('GET', 'https://productionresultssa0.blob.core.windows.net/log', { external: true, ...options }), /FEE_REFRESH_HOST/);
  assert.equal(fetches, 0); assert.equal(tokens, 0);
});

test('entry HTTP bounds declared and actual streamed bytes without arrayBuffer', async () => {
  let reads = 0, cancelled = 0;
  const oversized = { status: 200, headers: new Headers({ 'content-length': String(2 * 1024 * 1024 + 1) }),
    body: { cancel() { cancelled++; }, getReader() { reads++; throw Error('must not read'); } }, arrayBuffer() { throw Error('must not buffer'); } };
  await assert.rejects(createHttp({ fetchImpl: async () => oversized })('GET', 'https://api.github.com/x'), /FEE_REFRESH_SIZE/);
  assert.equal(reads, 0); assert.equal(cancelled, 1);
  const chunks = [new Uint8Array(1024 * 1024), new Uint8Array(1024 * 1024), new Uint8Array(1), new Uint8Array(1)];
  const response = new Response(new ReadableStream({ pull(c) { reads++; c.enqueue(chunks.shift()); }, cancel() { cancelled++; } }, { highWaterMark: 0 }));
  await assert.rejects(createHttp({ fetchImpl: async () => response })('GET', 'https://api.github.com/x'), /FEE_REFRESH_SIZE/);
  assert.equal(reads, 3); assert.equal(chunks.length, 1); assert.equal(cancelled, 2);
  // A decoded compressed body need not equal its wire Content-Length.
  const ok = await createHttp({ fetchImpl: async () => new Response('decoded', { headers: { 'content-length': '3', 'content-encoding': 'gzip' } }) })('GET', 'https://api.github.com/x');
  assert.equal(new TextDecoder().decode(ok.bytes), 'decoded');
});

test('entry HTTP deadline includes a stalled token and never starts a late fetch', { timeout: 2000 }, async () => {
  let release, calls = 0;
  const http = createHttp({ timeoutMs: 20, metadataToken: () => new Promise(r => { release = r; }), fetchImpl: async () => { calls++; return new Response('late'); } });
  await assert.rejects(http('GET', 'https://storage.googleapis.com/x'), /FEE_REFRESH_TIMEOUT/);
  release('synthetic'); await tick(); assert.equal(calls, 0);
});

test('entry HTTP bounds uncooperative fetch/body reads and never retries or leaks raw errors', { timeout: 2000 }, async () => {
  let signal, calls = 0, cancel = 0;
  const hanging = createHttp({ timeoutMs: 20, fetchImpl: async (_url, init) => { calls++; signal = init.signal; return new Promise(() => {}); } });
  await assert.rejects(hanging('GET', 'https://api.github.com/x'), /FEE_REFRESH_TIMEOUT/);
  assert.equal(signal.aborted, true); assert.equal(calls, 1);
  const body = createHttp({ timeoutMs: 20, fetchImpl: async () => ({ status: 200, body: { getReader: () => ({
    read: () => new Promise(() => {}), cancel() { cancel++; return new Promise(() => {}); }, releaseLock() {},
  }) } }) });
  await assert.rejects(body('GET', 'https://api.github.com/x'), /FEE_REFRESH_TIMEOUT/); assert.equal(cancel, 1);
  const failing = createHttp({ fetchImpl: async () => { throw Error('private transport detail'); } });
  await assert.rejects(failing('GET', 'https://api.github.com/x'), { message: 'FEE_REFRESH_HTTP' });
});

test('entry HTTP validates response identity and allows only explicit manual redirects', async () => {
  const http = response => createHttp({ fetchImpl: async () => response });
  let cancelled = 0;
  for (const response of [{ status: 200, redirected: true }, { status: 200, url: 'https://evil.invalid/' }]) {
    response.body = { cancel() { cancelled++; } };
    await assert.rejects(http(response)('GET', 'https://api.github.com/x'), /FEE_REFRESH_HOST/);
  }
  assert.equal(cancelled, 2);
  await assert.rejects(http(new Response(null, { status: 302 }))('GET', 'https://api.github.com/x'), /FEE_REFRESH_HTTP/);
  const manual = await http(new Response(null, { status: 302, headers: { location: 'https://example.invalid/log' } }))('GET', 'https://api.github.com/x', { redirect: 'manual' });
  assert.equal(manual.status, 302); assert.equal(manual.location, 'https://example.invalid/log');
});

test('metadata transport is fixed, bounded, validates tokens and caches only a timely success', async () => {
  const seen = [];
  const token = createMetadataToken(async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify({ access_token: 'synthetic-metadata-only', expires_in: 3600 })); });
  assert.equal(await token(), 'synthetic-metadata-only'); assert.equal(await token(), 'synthetic-metadata-only');
  assert.equal(seen.length, 1); assert.equal(seen[0].url, 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token');
  assert.equal(seen[0].init.headers['Metadata-Flavor'], 'Google'); assert.equal(seen[0].init.redirect, 'error');
  for (const data of ['bad JSON', { access_token: 'bad\nvalue', expires_in: 3600 }, { access_token: 'synthetic', expires_in: 0 }, { access_token: 'synthetic', expires_in: Infinity }])
    await assert.rejects(createMetadataToken(async () => new Response(typeof data === 'string' ? data : JSON.stringify(data)))(), /FEE_REFRESH_METADATA/);
  await assert.rejects(createMetadataToken(async () => new Response('x'.repeat(65537)))(), /FEE_REFRESH_SIZE/);
  let cancelled = 0;
  await assert.rejects(createMetadataToken(async () => ({ status: 403, body: { cancel() { cancelled++; } } }))(), /FEE_REFRESH_METADATA/);
  assert.equal(cancelled, 1);
});

test('metadata expiry aborts stalled reads, discards a late reply and never caches it', { timeout: 2000 }, async () => {
  let release, signal, calls = 0, cancelled = 0;
  const token = createMetadataToken(async (_url, init) => { signal = init.signal; calls++;
    if (calls === 1) return new Promise(r => { release = r; });
    return new Response(JSON.stringify({ access_token: 'synthetic-fresh', expires_in: 3600 }));
  }, { timeoutMs: 20 });
  await assert.rejects(token(), /FEE_REFRESH_TIMEOUT/); assert.equal(signal.aborted, true);
  release({ status: 200, body: { cancel() { cancelled++; } } }); await tick(); assert.equal(cancelled, 1);
  assert.equal(await token(), 'synthetic-fresh'); assert.equal(calls, 2);
});

test('crash after the batch record but before any claim: resumed once on a fresh proof, never lost', async () => {
  const core = await import('./fee-manager-refresh.mjs');
  const r = request(), w = jobWorld();
  await queued(w, r);
  // Simulate the crash: the batch exists, nothing else does.
  await w.ledger.create(keys.batch(r.requestId), { schema: SCHEMA.batch, batchId: r.requestId, request: r, nonce: crypto.randomUUID() });
  const http = async (method, url, opts) => url === 'https://api.github.com/gists/' + GIST ? gistHttp(r).http(method, url, opts) : { status: 503, bytes: enc('') };
  const out = await runRefreshJob({ ...jobArgs(w, r, NOW), http });
  assert.equal(out[0].resumed, true);
  assert.equal((await w.ledger.get(keys.feeGate(r.requestId))).code, 'VERIFY_UNAVAILABLE', 'resumed admission ran');
  assert.ok(await w.ledger.get(keys.done(r.requestId)));
  assert.equal((await latest(w, r.requestId)).fee.code, 'VERIFY_UNAVAILABLE');
  assert.ok(core.isFinalStatus(await latest(w, r.requestId)));
});

test('crash recovery when the proof is no longer fresh: recorded stale, nothing started', async () => {
  const r = request(), w = jobWorld();
  await queued(w, r);
  await w.ledger.create(keys.batch(r.requestId), { schema: SCHEMA.batch, batchId: r.requestId, request: r, nonce: crypto.randomUUID() });
  const later = new Date(NOW.getTime() + 60 * 60_000);
  await runRefreshJob(jobArgs(w, r, later));
  assert.equal((await w.ledger.get(keys.feeGate(r.requestId))).code, 'REQUEST_STALE');
  assert.equal([...w.ledger.rows.keys()].filter(k => k.includes('/fee/')).length, 0);
  assert.equal((await latest(w, r.requestId)).fee.code, 'REQUEST_STALE');
});

test('crash after a claim: the attempt is reconciled from evidence only, never re-claimed', async () => {
  const r = request(), w = jobWorld();
  await queued(w, r);
  await w.ledger.create(keys.batch(r.requestId), { schema: SCHEMA.batch, batchId: r.requestId, request: r, nonce: crypto.randomUUID() });
  await w.ledger.create(keys.attempt('fee', '2026-11-10', 1), { schema: SCHEMA.attempt, kind: 'fee', dataDate: '2026-11-10', attempt: 1, batchId: r.requestId, requestId: r.requestId, claimMainSha: 'c'.repeat(40), claimedAt: NOW.toISOString(), nonce: crypto.randomUUID() });
  const http = async (method, url, opts) => { if (method === 'POST') throw new Error('must not dispatch'); return url === 'https://api.github.com/gists/' + GIST ? gistHttp(r).http(method, url, opts) : { status: 503, bytes: enc('') }; };
  await runRefreshJob({ ...jobArgs(w, r, NOW), http, mode: 'launch' });
  assert.equal([...w.ledger.rows.keys()].filter(k => /attempt-2$/.test(k)).length, 0, 'no second claim');
  assert.equal(await w.ledger.get(keys.done(r.requestId)), null, 'unknown stays open');
  assert.equal((await latest(w, r.requestId)).fee.state, 'unknown');
});

test('a pre-claim final outcome is kept: later executions never project waiting over it', async () => {
  const r = request(), w = jobWorld();
  await queued(w, r);
  const verifierHttp = async (method, url, opts) => url === 'https://api.github.com/gists/' + GIST ? gistHttp(r).http(method, url, opts) : { status: 503, bytes: enc('') };
  await runRefreshJob({ ...jobArgs(w, r, NOW), http: verifierHttp });
  const first = await latest(w, r.requestId);
  assert.equal(first.fee.state, 'blocked');
  const count = (await w.status.list('status/' + r.requestId + '/')).length;
  // Later executions, fresh or not: no new projection, the final one stays latest.
  await runRefreshJob({ ...jobArgs(w, r, NOW), http: verifierHttp });
  await runRefreshJob({ ...jobArgs(w, r, new Date(NOW.getTime() + 3600_000)), http: verifierHttp });
  assert.equal((await w.status.list('status/' + r.requestId + '/')).length, count);
  assert.deepEqual(await latest(w, r.requestId), first);
});

test('batchStatus keeps a pre-claim outcome recorded in the ledger (no fallback to none)', async () => {
  const core = await import('./fee-manager-refresh.mjs');
  const r = request(), ledger = core.createMemoryLedger();
  const c = core.createRefreshCoordinator({ ledger, now: () => NOW, wait: async () => {},
    feePublisher: acceptancePublisher, pipelineIdle: async () => true,
    feeVerifier: { coverage: async () => ({ mainSha: 'c'.repeat(40), targetDate: '2026-11-10' }), verify: async () => ({ state: 'not-published' }), isAncestor: async () => false } });
  const res = await c.submit(r, { verified: true, ownerId: OWNER_ID, method: 'owner-gist-authored-request' });
  assert.equal(res.fee.code, 'DATE_ALREADY_PUBLISHED_ELSEWHERE');
  assert.deepEqual((await c.batchStatus(r.requestId)).fee, { state: 'blocked', code: 'DATE_ALREADY_PUBLISHED_ELSEWHERE', dataDate: '2026-11-10' });
});

test('queue over 100 entries: finished and stale ones never starve a fresh request', async () => {
  const r = request(), w = jobWorld();
  const old = new Date(NOW.getTime() - 3600_000);
  for (let i = 0; i < 130; i++) await w.queue.create('queue/' + crypto.randomUUID(), { schema: 'fee-console.manager-refresh-queue.v1', requestId: 'x', gistVersion: VER, queuedAt: old.toISOString() });
  // 130 malformed/stale entries (ids sort anywhere), plus 40 already done.
  for (let i = 0; i < 40; i++) { const id = crypto.randomUUID(); await w.queue.create('queue/' + id, { schema: 'fee-console.manager-refresh-queue.v1', requestId: id, gistVersion: VER, queuedAt: old.toISOString() }); await w.ledger.create(keys.done(id), { requestId: id }); }
  await queued(w, r);
  const reads = { gist: 0 };
  const http = async (method, url, opts) => { if (url === 'https://api.github.com/gists/' + GIST) { reads.gist++; return gistHttp(r).http(method, url, opts); } return { status: 503, bytes: enc('') }; };
  await runRefreshJob({ ...jobArgs(w, r, NOW), http, maxRequests: 1 });
  assert.ok(await w.ledger.get(keys.batch(r.requestId)), 'fresh request processed despite 170 earlier entries');
  assert.equal(reads.gist, 1, 'stale/invalid/done entries cost no Gist read');
  assert.equal((await w.ledger.names('fee-manager-refresh-v1/done/')).length, 40 + 130 + 1);
});

test('GCS names() follows nextPageToken past the first page', async () => {
  const names = Array.from({ length: 2500 }, (_, i) => 'queue/' + String(i).padStart(5, '0'));
  const http = async (method, url) => {
    const u = new URL(url), token = Number(u.searchParams.get('pageToken') || 0);
    const page = names.slice(token, token + 1000);
    return { status: 200, bytes: enc({ items: page.map(name => ({ name })), ...(token + 1000 < names.length ? { nextPageToken: String(token + 1000) } : {}) }) };
  };
  assert.equal((await createGcsBucket({ http, bucket: 'synthetic-queue' }).names('queue/')).length, 2500);
});

test('done is written only after the final projection is stored', async () => {
  const r = request(), w = jobWorld();
  await queued(w, r);
  const create = w.status.create.bind(w.status);
  let fail = true;
  w.status.create = async (k, v) => { if (fail) throw new Error('status write lost'); return create(k, v); };
  const http = async (method, url, opts) => url === 'https://api.github.com/gists/' + GIST ? gistHttp(r).http(method, url, opts) : { status: 503, bytes: enc('') };
  await runRefreshJob({ ...jobArgs(w, r, NOW), http });
  assert.equal(await w.ledger.get(keys.done(r.requestId)), null, 'not done without its projection');
  fail = false;
  await runRefreshJob({ ...jobArgs(w, r, NOW), http });
  assert.ok(await w.ledger.get(keys.done(r.requestId)));
  assert.equal((await latest(w, r.requestId)).fee.code, 'VERIFY_UNAVAILABLE');
});

// ---- concurrency: final states never go back; ending and dispatching are exclusive
const gateOpen = () => { let release; const p = new Promise(r => { release = r; }); return { p, release }; };
const tick = () => new Promise(r => setImmediate(r));
async function until(cond) { for (let i = 0; i < 500 && !cond(); i++) await tick(); assert.ok(cond(), 'interleaving point reached'); }
const claimRecords = async (w, r, n = 1, dispatchAt = NOW.toISOString()) => {
  await w.ledger.create(keys.batch(r.requestId), { schema: SCHEMA.batch, batchId: r.requestId, request: r, nonce: crypto.randomUUID() });
  await w.ledger.create(keys.attempt('fee', '2026-11-10', n), { schema: SCHEMA.attempt, kind: 'fee', dataDate: '2026-11-10', attempt: n, batchId: r.requestId, requestId: r.requestId, claimMainSha: 'c'.repeat(40), claimedAt: dispatchAt, nonce: crypto.randomUUID() });
  await w.ledger.create(keys.feeGate(r.requestId), { schema: SCHEMA.feeGate, mode: 'dispatch', attempt: n, nonce: crypto.randomUUID() });
  await w.ledger.create(keys.dispatching('fee', '2026-11-10', n), { schema: SCHEMA.dispatching, attempt: n, batchId: r.requestId, mode: 'dispatch', at: dispatchAt, nonce: crypto.randomUUID() });
};

test('two jobs: A reads unknown and pauses, B writes failed + done, A resumes: the page still sees failed', async () => {
  const r = request(), w = jobWorld();
  await queued(w, r);
  await claimRecords(w, r);
  const http = async (method, url, opts) => { if (method === 'POST') throw new Error('must not dispatch'); return url === 'https://api.github.com/gists/' + GIST ? gistHttp(r).http(method, url, opts) : { status: 503, bytes: enc('') }; };
  // Job A: its status writes are held until we release them.
  const hold = gateOpen(); let aPaused = false;
  const statusA = { ...w.status, names: w.status.names, get: w.status.get.bind(w.status), list: w.status.list.bind(w.status),
    create: async (k, v) => { aPaused = true; await hold.p; return w.status.create(k, v); } };
  const a = runRefreshJob({ ...jobArgs(w, r, NOW), http, mode: 'launch', status: statusA });
  await until(() => aPaused);
  // Meanwhile evidence closes the attempt and job B projects the final state.
  await w.ledger.create(keys.result('fee', '2026-11-10', 1), { schema: SCHEMA.result, attempt: 1, batchId: r.requestId, outcome: 'failed', code: 'RUN_ENDED_UNPUBLISHED', nonce: crypto.randomUUID() });
  await runRefreshJob({ ...jobArgs(w, r, NOW), http, mode: 'launch' });
  assert.ok(await w.ledger.get(keys.done(r.requestId)));
  assert.deepEqual((await latest(w, r.requestId)).fee, { state: 'failed', code: 'RUN_ENDED_UNPUBLISHED', dataDate: '2026-11-10' });
  hold.release(); await a; // A writes its stale "unknown" now
  assert.ok((await w.status.names('status/' + r.requestId + '/')).length >= 2, 'A did write a later non-final projection');
  assert.deepEqual((await latest(w, r.requestId)).fee, { state: 'failed', code: 'RUN_ENDED_UNPUBLISHED', dataDate: '2026-11-10' }, 'final never goes back');
});

test('A verified but not yet claimed; B re-verification gets 503: B writes nothing, A proceeds normally', async () => {
  const core = await import('./fee-manager-refresh.mjs');
  const r = request(), w = jobWorld();
  await queued(w, r);
  const starts = [];
  const hold = gateOpen(); let aPaused = false;
  const verifier = { coverage: async () => { aPaused = true; await hold.p; return { mainSha: 'c'.repeat(40), targetDate: '2026-11-09' }; }, verify: async () => ({ state: 'not-published', targetDate: '2026-11-09' }), isAncestor: async () => false };
  const A = core.createRefreshCoordinator({ ledger: w.ledger, now: () => NOW, wait: async () => {}, deadlineMs: 0, pipelineIdle: async () => false, feeVerifier: verifier,
    feePublisher: { start: async x => { starts.push(x); return { state: 'started', handle: '77' }; }, status: async () => 'running', lookup: async () => 'unknown', provenance: async () => null } });
  const a = A.submit(r, { verified: true, ownerId: OWNER_ID, method: 'owner-gist-authored-request' });
  await until(() => aPaused);
  const unavailable = async (method, url, opts) => url === 'https://api.github.com/gists/' + GIST ? { status: 503, bytes: enc('') } : { status: 503, bytes: enc('') };
  const out = await runRefreshJob({ ...jobArgs(w, r, NOW), http: unavailable });
  assert.equal(out[0].code, 'VERIFY_UNAVAILABLE');
  assert.equal(await w.ledger.get(keys.feeGate(r.requestId)), null, 'no terminal decision from a transient failure');
  assert.equal(await w.ledger.get(keys.done(r.requestId)), null);
  assert.equal((await w.status.names('status/' + r.requestId + '/')).length, 0);
  hold.release(); await a;
  assert.equal(starts.length, 1);
  assert.equal((await w.ledger.get(keys.feeGate(r.requestId))).mode, 'dispatch');
});

test('A verified but not yet claimed; B finds it truly stale: the shared gate makes "ended" and "dispatch" exclusive', async () => {
  const core = await import('./fee-manager-refresh.mjs');
  const r = request(), w = jobWorld();
  await queued(w, r);
  const starts = [];
  const hold = gateOpen(); let aPaused = false;
  const verifier = { coverage: async () => { aPaused = true; await hold.p; return { mainSha: 'c'.repeat(40), targetDate: '2026-11-09' }; }, verify: async () => ({ state: 'not-published', targetDate: '2026-11-09' }), isAncestor: async () => false };
  const A = core.createRefreshCoordinator({ ledger: w.ledger, now: () => NOW, wait: async () => {}, deadlineMs: 0, pipelineIdle: async () => false, feeVerifier: verifier,
    feePublisher: { start: async x => { starts.push(x); return { state: 'started', handle: '77' }; }, status: async () => 'running', lookup: async () => 'unknown', provenance: async () => null } });
  const a = A.submit(r, { verified: true, ownerId: OWNER_ID, method: 'owner-gist-authored-request' });
  await until(() => aPaused);
  const later = new Date(NOW.getTime() + 60 * 60_000);
  await runRefreshJob(jobArgs(w, r, later)); // real elapsed time: stale, ended through the gate
  assert.equal((await w.ledger.get(keys.feeGate(r.requestId))).mode, 'blocked');
  assert.equal((await latest(w, r.requestId)).fee.code, 'REQUEST_STALE');
  hold.release();
  const res = await a;
  assert.equal(starts.length, 0, 'never dispatched after the request was ended');
  assert.equal(res.fee.code, 'REQUEST_STALE');
  const s = await core.kindState(w.ledger, 'fee', '2026-11-10');
  assert.equal(s.attempts[0].result.code, 'RECONCILED_NOT_STARTED', 'its claim is closed, retryable by a new request');
  assert.equal(s.state, 'retryable');
  assert.equal((await latest(w, r.requestId)).fee.code, 'REQUEST_STALE', 'the page never flips to running');
});

// ---- lost run id: the adapter never adopts by time proximity
test('lookup never adopts a run, even a unique same-owner same-date run in the dispatch window', async () => {
  let calls = 0;
  const http = async () => { calls++; return { status: 200, bytes: enc({ total_count: 1, workflow_runs: [{ id: 77 }] }) }; };
  const p = createGitHubFeeAdapters({ http, readToken: () => 'synthetic-token-not-real-0000', now: () => NOW }).publisher;
  assert.equal(await p.lookup({ dataDate: '2026-11-10', dispatchAt: NOW.toISOString() }), 'unknown');
  assert.equal(calls, 0);
});

test('verification outcome classes: unavailable is never stale or unverified', async () => {
  const r = request(), body = { requestId: r.requestId, gistVersion: VER };
  for (const s of [403, 408, 429, 500, 502, 503, 504]) await assert.rejects(verifyOwnerRequest(body, { http: gistHttp(r, {}, s).http, gistId: GIST, now: () => NOW }), { code: 'VERIFY_UNAVAILABLE' }, String(s));
  for (const s of [401, 404, 410]) await assert.rejects(verifyOwnerRequest(body, { http: gistHttp(r, {}, s).http, gistId: GIST, now: () => NOW }), { code: 'IDENTITY_UNVERIFIED' }, String(s));
  await assert.rejects(verifyOwnerRequest(body, { http: gistHttp(r).http, gistId: GIST, now: () => new Date(NOW.getTime() + 3600_000) }), { code: 'REQUEST_STALE' });
});

test('POST rejection contract: echoes the request id, state rejected, and queues nothing', async () => {
  const old = request({ feeDataDate: '2026-11-01' }), x = intakeDeps(old);
  const res = await post(old, x.deps);
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { requestId: old.requestId, state: 'rejected', code: 'REQUEST_INVALID' });
  assert.equal(x.queue.rows.size, 0);
  assert.equal(x.wakes.length, 0);
  const un = intakeDeps(request()); un.deps.http = gistHttp(request(), {}, 503).http;
  const r2 = await post(request(), un.deps);
  assert.equal(JSON.parse(r2.body).state, 'rejected');
  assert.equal(un.queue.rows.size, 0);
});

// ---- close: the only server proof of "never received, never will be"
const call = (deps, method, path, body) => handleIntake({ method, path, headers: { origin: ALLOWED_ORIGIN }, body }, deps).then(r => ({ status: r.status, body: JSON.parse(r.body || '{}') }));

test('close vs late POST: exactly one wins on the same create-only key, both orders', async () => {
  // close first, then the late original POST
  let r = request(), x = intakeDeps(r);
  assert.deepEqual((await call(x.deps, 'POST', '/v1/requests/' + r.requestId + '/close')).body, { requestId: r.requestId, state: 'closed' });
  const late = await post(r, x.deps);
  assert.equal(late.status, 409);
  assert.deepEqual(JSON.parse(late.body), { requestId: r.requestId, state: 'rejected', code: 'REQUEST_CLOSED' });
  assert.equal(x.wakes.length, 0, 'a closed request never wakes the job');
  assert.equal((await call(x.deps, 'GET', '/v1/requests/' + r.requestId)).body.state, 'closed');
  // POST first, then close
  r = request(); x = intakeDeps(r);
  await post(r, x.deps);
  assert.deepEqual((await call(x.deps, 'POST', '/v1/requests/' + r.requestId + '/close')).body, { requestId: r.requestId, state: 'queued' });
  // concurrent
  r = request(); x = intakeDeps(r);
  const [p1, c1] = await Promise.all([post(r, x.deps), call(x.deps, 'POST', '/v1/requests/' + r.requestId + '/close')]);
  const queued = JSON.parse(p1.body).state === 'queued', closed = c1.body.state === 'closed';
  assert.ok(queued !== closed, 'never both, never neither');
});

test('close is refused once anything was projected for the request (received)', async () => {
  const r = request(), x = intakeDeps(r);
  await x.status.create('status/' + r.requestId + '/final', { requestId: r.requestId, contents: ['fee'], fee: { state: 'published', code: 'PUBLISHED' }, ratio: null });
  assert.equal((await call(x.deps, 'POST', '/v1/requests/' + r.requestId + '/close')).body.state, 'received');
  assert.equal(x.queue.rows.size, 0);
});

test('job: a closed request is recorded final REQUEST_CLOSED and never executed', async () => {
  const r = request(), w = jobWorld();
  await w.queue.create('queue/' + r.requestId, { schema: CLOSED_SCHEMA, requestId: r.requestId, closedAt: NOW.toISOString() });
  await runRefreshJob(jobArgs(w, r, NOW));
  assert.equal(await w.ledger.get(keys.batch(r.requestId)), null);
  assert.equal((await latest(w, r.requestId)).code, 'REQUEST_CLOSED');
  assert.ok(await w.ledger.get(keys.done(r.requestId)));
});

// ---- least privilege, enforced: every call each role makes is within ROLE_ACCESS
function restricted(bucket, ops, label, log) {
  const guard = op => { if (!ops.includes(op)) throw new Error('PERMISSION ' + label + ' ' + op); log.push(label + ':' + op); };
  return {
    rows: bucket.rows,
    create: async (k, v) => { guard('create'); return bucket.create(k, v); },
    get: async k => { guard('get'); return bucket.get(k); },
    names: async p => { guard('list'); return bucket.names(p); },
    list: async p => { guard('list'); guard('get'); return bucket.list(p); },
  };
}

test('permission matrix: no role deletes; intake never touches the ledger; job may read status', () => {
  for (const role of Object.values(ROLE_ACCESS)) for (const ops of Object.values(role)) assert.ok(!ops.includes('delete') && !ops.includes('update'));
  assert.deepEqual(ROLE_ACCESS.intake.ledger, []);
  assert.ok(ROLE_ACCESS.job.status.includes('get'), 'the job reads status before a non-final projection');
});

test('end-to-end under enforced permissions: POST, close, GET, job (acceptance) stay within ROLE_ACCESS', async () => {
  const r = request(), base = { queue: bucket(), status: bucket(), ledger: bucket() }, log = [];
  const intake = { queue: restricted(base.queue, ROLE_ACCESS.intake.queue, 'intake/queue', log), status: restricted(base.status, ROLE_ACCESS.intake.status, 'intake/status', log) };
  const job = { queue: restricted(base.queue, ROLE_ACCESS.job.queue, 'job/queue', log), status: restricted(base.status, ROLE_ACCESS.job.status, 'job/status', log), ledger: restricted(base.ledger, ROLE_ACCESS.job.ledger, 'job/ledger', log) };
  const deps = { http: gistHttp(r).http, ...intake, gistId: GIST, now: () => NOW, runJob: async () => {} };
  await post(r, deps);
  await call(deps, 'GET', '/v1/requests/' + r.requestId);
  const http = async (method, url, opts) => url === 'https://api.github.com/gists/' + GIST ? gistHttp(r).http(method, url, opts) : { status: 503, bytes: enc('') };
  await runRefreshJob({ ...job, http, gistId: GIST, now: () => NOW, wait: async () => {}, readToken: () => 'synthetic-token-not-real-0000', validateHealth: () => [], mode: 'acceptance' });
  await runRefreshJob({ ...job, http, gistId: GIST, now: () => NOW, wait: async () => {}, readToken: () => 'synthetic-token-not-real-0000', validateHealth: () => [], mode: 'acceptance' });
  const r2 = request(); await call({ ...deps, http: gistHttp(r2).http }, 'POST', '/v1/requests/' + r2.requestId + '/close');
  assert.equal((await call(deps, 'GET', '/v1/requests/' + r.requestId)).body.fee.code, 'VERIFY_UNAVAILABLE');
  assert.ok(!log.some(x => x.startsWith('intake/ledger')));
  // A non-final projection (claimed, outcome unknown) makes the job read status first.
  const r3 = request(), w3 = { queue: bucket(), status: bucket(), ledger: bucket() };
  await w3.queue.create('queue/' + r3.requestId, { schema: 'fee-console.manager-refresh-queue.v1', requestId: r3.requestId, gistVersion: VER, queuedAt: NOW.toISOString() });
  await claimRecords(w3, r3);
  const log3 = [];
  const job3 = { queue: restricted(w3.queue, ROLE_ACCESS.job.queue, 'job/queue', log3), status: restricted(w3.status, ROLE_ACCESS.job.status, 'job/status', log3), ledger: restricted(w3.ledger, ROLE_ACCESS.job.ledger, 'job/ledger', log3) };
  const http3 = async (method, url, opts) => { if (method === 'POST') throw new Error('must not dispatch'); return url === 'https://api.github.com/gists/' + GIST ? gistHttp(r3).http(method, url, opts) : { status: 503, bytes: enc('') }; };
  await runRefreshJob({ ...job3, http: http3, gistId: GIST, now: () => NOW, wait: async () => {}, readToken: () => 'synthetic-token-not-real-0000', validateHealth: () => [], mode: 'launch' });
  assert.ok(log3.includes('job/status:get'), 'job reads status before a non-final projection');
  assert.ok(log3.includes('job/status:create'));
});

test('credential isolation: acceptance job refuses a mounted GitHub credential; launch job requires one', () => {
  const acc = { mode: 'acceptance' }, launch = { mode: 'launch' };
  assert.equal(credentialFor(acc, 'job', () => false), null);
  assert.throws(() => credentialFor(acc, 'job', () => true), /FEE_REFRESH_ISOLATION/);
  assert.throws(() => credentialFor(launch, 'job', () => false), /FEE_REFRESH_TOKEN/);
  assert.equal(typeof credentialFor(launch, 'job', () => true), 'function');
  assert.equal(credentialFor(launch, 'serve', () => true), null, 'the intake never reads it');
});

test('acceptance adapters send no Authorization header at all', async () => {
  const seen = [];
  const http = async (method, url, opts = {}) => { seen.push(opts.headers || {}); return { status: 200, bytes: enc({ object: { sha: 'a'.repeat(40) } }) }; };
  const { readers } = createGitHubFeeAdapters({ http, readToken: null, now: () => NOW });
  await readers.readMain();
  assert.ok(seen.every(h => !('Authorization' in h)));
});

test('GET /v1/mode reports only the validated mode; an inactive service answers 503', async () => {
  const r = request(), x = intakeDeps(r);
  for (const mode of ['acceptance', 'launch']) {
    const res = await handleIntake({ method: 'GET', path: '/v1/mode', headers: { origin: ALLOWED_ORIGIN } }, { ...x.deps, mode });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { schema: 'fee-console.manager-refresh-mode.v1', mode });
  }
  for (const mode of [undefined, null, 'disabled', 'unknown']) {
    const res = await handleIntake({ method: 'GET', path: '/v1/mode', headers: { origin: ALLOWED_ORIGIN } }, { ...x.deps, mode });
    assert.equal(res.status, 503);
    assert.deepEqual(JSON.parse(res.body), { code: 'INTAKE_NOT_ACTIVE' });
  }
});
