// Server adapters for the manager refresh (NOT deployed, NOT active).
//
// Two separately deployable roles, each holding only what it needs:
//   intake  public HTTPS entry. Verifies an owner-authored request in the one
//           fixed ledger Gist, queues it create-only and starts one fixed Job
//           execution WITHOUT overrides. It never sees a GitHub credential.
//   job     fixed-argument Cloud Run Job. Re-verifies every queued request
//           independently, then runs scripts/fee-manager-refresh.mjs with the
//           existing confirmed-sync producer inputs, reading the Actions
//           credential from a mounted file only at dispatch time.
// All I/O is injected (`http`), so tests run with synthetic transports only.
// See docs/fee-manager-refresh.md for the resources and approvals required.
import crypto from 'node:crypto';
import {
  createRefreshCoordinator, createFeePublicationVerifier, validateRequest, isDay,
  OWNER_ID, RefreshError, keys as ledgerKeys,
} from './fee-manager-refresh.mjs';

export const REPO = 'huanwujoy-crypto/fee-console';
export const API = 'https://api.github.com/repos/' + REPO;
export const PAGES = 'https://huanwujoy-crypto.github.io/fee-console/';
export const ALLOWED_ORIGIN = 'https://huanwujoy-crypto.github.io';
export const PRODUCER_WORKFLOW = 'fee-cloud-producer.yml';
export const REQUEST_FILE = 'fee-manager-refresh-request.json';
export const QUEUE_PREFIX = 'fee-manager-refresh-v1/queue/';
const FRESH_MS = 10 * 60_000;
const ACTIVE_RUN = ['queued', 'in_progress', 'requested', 'waiting', 'pending'];
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const isSha40 = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const isUuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, k) => plain(v) && Object.keys(v).sort().join(',') === [...k].sort().join(',');
const fail = code => { throw new RefreshError(code); };
const json = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));

// ------------------------------------------------------------- GCS ledger
// Create-only objects (ifGenerationMatch=0) in a bucket WITHOUT a lifecycle
// rule: a success record must never expire into a fresh allowance.
export function createGcsLedger({ http, bucket }) {
  if (typeof http !== 'function' || !/^[a-z0-9][a-z0-9._-]{2,62}$/.test(bucket || '')) fail('VERIFY_UNAVAILABLE');
  const enc = encodeURIComponent, base = 'https://storage.googleapis.com/storage/v1/b/' + bucket + '/o';
  return Object.freeze({
    async create(key, record) {
      const r = await http('POST', 'https://storage.googleapis.com/upload/storage/v1/b/' + bucket + '/o?uploadType=media&ifGenerationMatch=0&name=' + enc(key),
        { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) });
      if (r.status === 412) throw Object.assign(new Error('exists'), { conflict: true });
      if (r.status !== 200) throw new Error('create ' + r.status);
    },
    async get(key) {
      const r = await http('GET', base + '/' + enc(key) + '?alt=media');
      if (r.status === 404) return null;
      if (r.status !== 200) throw new Error('get ' + r.status);
      return json(r.bytes);
    },
    async list(prefix) {
      const out = [];
      let token = '';
      for (let page = 0; page < 50; page++) {
        const r = await http('GET', base + '?prefix=' + enc(prefix) + '&fields=items(name),nextPageToken' + (token ? '&pageToken=' + enc(token) : ''));
        if (r.status !== 200) throw new Error('list ' + r.status);
        const v = json(r.bytes);
        for (const item of v.items || []) out.push({ key: item.name, record: await this.get(item.name) });
        if (!v.nextPageToken) return out.sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
        token = v.nextPageToken;
      }
      fail('VERIFY_UNAVAILABLE');
    },
  });
}

// ------------------------------------------- owner-authored request proof
// Only the Gist owner can create a Gist revision, so a request file in the
// latest revision of the ONE configured ledger Gist, owned by OWNER_ID and
// fresh, proves the owner wrote it. The caller names neither the Gist nor any
// URL: only {requestId, gistVersion}. The proof is re-run by the Job.
export async function verifyOwnerRequest(body, { http, gistId, now }) {
  if (!exact(body, ['requestId', 'gistVersion']) || !isUuid(body.requestId) || !isSha40(body.gistVersion)) fail('REQUEST_INVALID');
  if (!/^[a-f0-9]{20,40}$/.test(gistId || '')) fail('VERIFY_UNAVAILABLE');
  const read = async url => { const r = await http('GET', url, { headers: { Accept: 'application/vnd.github+json' } }); if (r.status !== 200) fail('IDENTITY_UNVERIFIED'); return json(r.bytes); };
  const [latest, pinned] = await Promise.all([read('https://api.github.com/gists/' + gistId), read('https://api.github.com/gists/' + gistId + '/' + body.gistVersion)]);
  for (const g of [latest, pinned]) if (g?.id !== gistId || g.owner?.id !== OWNER_ID || g.public !== false) fail('IDENTITY_UNVERIFIED');
  const head = latest.history?.[0];
  // Latest revision only: an old revision can never be replayed.
  if (head?.version !== body.gistVersion || head.user?.id !== OWNER_ID) fail('IDENTITY_UNVERIFIED');
  const at = Date.parse(head.committed_at), t = now().getTime();
  if (!Number.isFinite(at) || at > t + 60_000 || t - at > FRESH_MS) fail('IDENTITY_UNVERIFIED');
  const file = pinned.files?.[REQUEST_FILE];
  if (!file || file.truncated || typeof file.content !== 'string' || file.content.length > 2048) fail('REQUEST_INVALID');
  let request;
  try { request = JSON.parse(file.content); } catch { fail('REQUEST_INVALID'); }
  if (!validateRequest(request) || request.requestId !== body.requestId) fail('REQUEST_INVALID');
  const created = Date.parse(request.createdAt);
  if (created > at + 60_000 || at - created > FRESH_MS) fail('REQUEST_INVALID');
  return { request, identity: { verified: true, ownerId: OWNER_ID, method: 'owner-gist-authored-request' }, gistVersion: body.gistVersion };
}

// ------------------------------------------------------------ public intake
// CORS is not authentication; it only limits which page may read replies.
export async function handleIntake(req, { http, ledger, gistId, now, runJob, readStatus }) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
  const reply = (status, value) => ({ status, headers, body: JSON.stringify(value) });
  if (req.headers?.origin !== ALLOWED_ORIGIN) return { status: 403, headers: { 'Cache-Control': 'no-store' }, body: '' };
  headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
  if (req.method === 'OPTIONS') return { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' }, body: '' };
  try {
    if (req.method === 'POST' && req.path === '/v1/requests') {
      if (typeof req.body !== 'string' || req.body.length > 512) fail('REQUEST_INVALID');
      let body; try { body = JSON.parse(req.body); } catch { fail('REQUEST_INVALID'); }
      const proof = await verifyOwnerRequest(body, { http, gistId, now });
      const entry = { schema: 'fee-console.manager-refresh-queue.v1', requestId: proof.request.requestId, gistVersion: proof.gistVersion, queuedAt: now().toISOString(), nonce: crypto.randomUUID() };
      let queued = 'created';
      try { await ledger.create(QUEUE_PREFIX + proof.request.requestId, entry); } catch (e) { if (!e.conflict) return reply(202, { requestId: proof.request.requestId, state: 'unknown', code: 'CLAIM_UNKNOWN' }); queued = 'existing'; }
      try { await runJob(); } catch { /* the queued request waits for the next execution */ }
      return reply(202, { requestId: proof.request.requestId, state: queued === 'created' ? 'queued' : 'duplicate' });
    }
    const m = /^\/v1\/requests\/([0-9a-f-]{36})$/.exec(req.path || '');
    if (req.method === 'GET' && m && isUuid(m[1])) {
      const status = await readStatus(m[1]);
      if (status && [status.fee, status.ratio].some(x => x && !['published', 'failed', 'blocked'].includes(x.state))) { try { await runJob(); } catch {} }
      return reply(200, status ? redact(status) : { requestId: m[1], state: 'none' });
    }
    return reply(404, { code: 'REQUEST_INVALID' });
  } catch (e) {
    const code = e instanceof RefreshError ? e.code : 'VERIFY_UNAVAILABLE';
    return reply(code === 'IDENTITY_UNVERIFIED' ? 403 : code === 'REQUEST_INVALID' ? 400 : 503, { code });
  }
}
// Replies carry only fixed states/codes and dates; never evidence hashes.
function redact(s) {
  const step = x => x ? { state: x.state, ...(x.code ? { code: x.code } : {}), ...(x.dataDate ? { dataDate: x.dataDate } : {}) } : null;
  return { requestId: s.batchId, contents: s.contents, fee: step(s.fee), ratio: step(s.ratio) };
}

// ---------------------------------------------------- GitHub fee adapters
// readToken() reads the mounted Actions credential at use; it is never logged
// or returned. Only the producer dispatch uses it; reads are anonymous.
export function createGitHubFeeAdapters({ http, readToken, now }) {
  const get = async (url, accept = 'application/vnd.github+json') => {
    const r = await http('GET', url, { headers: { Accept: accept } });
    if (r.status !== 200) fail('VERIFY_UNAVAILABLE');
    return r.bytes;
  };
  const getJson = async url => json(await get(url));
  const readMain = async () => (await getJson(API + '/git/ref/heads/main')).object?.sha;
  const readRepoFile = (sha, path) => get(API + '/contents/' + path + '?ref=' + sha, 'application/vnd.github.raw');
  const readPages = path => get(PAGES + path + '?t=' + now().getTime(), '*/*');
  const isAncestor = async (a, b) => { const c = await getJson(API + '/compare/' + a + '...' + b); return c.status === 'ahead' && c.behind_by === 0; };
  const runOf = async id => { const r = await getJson(API + '/actions/runs/' + id); if (r.id !== Number(id)) fail('VERIFY_UNAVAILABLE'); return r; };

  const publisher = Object.freeze({
    // Exactly the existing reviewed completed-sync inputs; the producer keeps
    // every one of its own owner/actor/main/source/publication gates.
    async start({ dataDate, claimMainSha }) {
      if (!isDay(dataDate) || !isSha40(claimMainSha)) return { state: 'refused' };
      const token = readToken();
      const r = await http('POST', API + '/actions/workflows/' + PRODUCER_WORKFLOW + '/dispatches', {
        headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ ref: 'main', return_run_details: true, inputs: { run_reviewed_once: 'true', report_kind: 'daily', report_target: dataDate, manual_sync_completed_for: dataDate, confirmed_main: claimMainSha } }),
      });
      if (r.status === 200) {
        let v; try { v = json(r.bytes); } catch { throw new Error('uncertain'); }
        if (Number.isSafeInteger(v.workflow_run_id) && v.workflow_run_id > 0) return { state: 'started', handle: String(v.workflow_run_id) };
      }
      // 204 has no run id, so it cannot be bound: treat as unknown, never resend.
      if ([400, 401, 403, 404, 422].includes(r.status)) return { state: 'refused' };
      throw new Error('uncertain');
    },
    async status(handle) { const r = await runOf(handle); return r.status === 'completed' ? 'ended' : 'running'; },
    async lookup() { return 'unknown'; },
    // This attempt's own run -> its signed candidate -> the promoted main commit.
    async provenance({ handle, dataDate }) {
      if (!handle) return null;
      const run = await runOf(handle);
      if (run.status !== 'completed' || run.conclusion !== 'success' || run.event !== 'workflow_dispatch' || run.path !== '.github/workflows/' + PRODUCER_WORKFLOW
        || run.head_branch !== 'main' || run.run_attempt !== 1 || run.actor?.id !== OWNER_ID || !isSha40(run.head_sha)) return null;
      const from = Date.parse(run.run_started_at), to = Date.parse(run.updated_at);
      const refs = await getJson(API + '/git/matching-refs/heads/codex/fee-daily-' + dataDate.replaceAll('-', '') + '-');
      const mine = [];
      for (const ref of refs) {
        const c = await getJson(API + '/git/commits/' + ref.object.sha);
        const at = Date.parse(c.committer?.date);
        if (c.parents?.length === 1 && c.parents[0].sha === run.head_sha && c.message === 'daily ' + dataDate && at >= from && at <= to) mine.push(c.sha);
      }
      if (mine.length !== 1) return null;
      const [data, health] = await Promise.all([readRepoFile(mine[0], 'data.json'), readRepoFile(mine[0], 'fee-data-health.json')]);
      const dataSha256 = sha256(data), healthSha256 = sha256(health);
      // The promotion commit on main that first carries exactly these bytes.
      const commits = await getJson(API + '/commits?sha=main&path=fee-data-health.json&since=' + new Date(from).toISOString() + '&per_page=20');
      for (const c of [...commits].reverse()) {
        const h = sha256(await readRepoFile(c.sha, 'fee-data-health.json'));
        if (h !== healthSha256) continue;
        if (sha256(await readRepoFile(c.sha, 'data.json')) !== dataSha256) return null;
        return { accountingThrough: dataDate, dataSha256, healthSha256, promotedMainSha: c.sha };
      }
      return null;
    },
  });

  // Idle only when no producer/validate/promote run is active and no
  // candidate branch for the date is still waiting.
  async function pipelineIdle(dataDate) {
    for (const wf of [PRODUCER_WORKFLOW, 'validate-fee-data.yml', 'promote-fee-data.yml'])
      for (const status of ACTIVE_RUN) {
        const r = await getJson(API + '/actions/workflows/' + wf + '/runs?status=' + status + '&per_page=1');
        if (!Number.isSafeInteger(r.total_count) || r.total_count !== 0) return false;
      }
    const refs = await getJson(API + '/git/matching-refs/heads/codex/fee-daily-' + dataDate.replaceAll('-', '') + '-');
    return Array.isArray(refs) && refs.length === 0;
  }
  return { publisher, pipelineIdle, readers: { readMain, readRepoFile, readPages, isAncestor } };
}

// --------------------------------------------------------------- the Job
// One execution drains the queue: each request is verified again (the Job
// never trusts the intake), then submitted once; in-flight attempts are
// reconciled from evidence only.
export async function runRefreshJob({ ledger, http, gistId, now, wait, readToken, validateHealth, ratioCollector }) {
  const gh = createGitHubFeeAdapters({ http, readToken, now });
  const coordinator = createRefreshCoordinator({
    ledger, now, wait, feePublisher: gh.publisher, pipelineIdle: gh.pipelineIdle, ratioCollector,
    feeVerifier: createFeePublicationVerifier({ ...gh.readers, validateHealth }), deadlineMs: 15 * 60_000,
  });
  const results = [];
  for (const { record } of await ledger.list(QUEUE_PREFIX)) {
    if (!record || !isUuid(record.requestId)) continue;
    const existing = await ledger.get(ledgerKeys.batch(record.requestId));
    if (existing) {
      const fee = existing.request?.feeDataDate;
      if (fee) await coordinator.reconcile('fee', fee).catch(() => null);
      continue;
    }
    try {
      const proof = await verifyOwnerRequest({ requestId: record.requestId, gistVersion: record.gistVersion }, { http, gistId, now: () => new Date(Date.parse(record.queuedAt)) });
      results.push(await coordinator.submit(proof.request, proof.identity));
    } catch (e) { results.push({ requestId: record.requestId, code: e instanceof RefreshError ? e.code : 'VERIFY_UNAVAILABLE' }); }
  }
  return results.map(r => ({ batchId: r.batchId || r.requestId, fee: r.fee?.code || null, ratio: r.ratio?.code || null, code: r.code || null }));
}
