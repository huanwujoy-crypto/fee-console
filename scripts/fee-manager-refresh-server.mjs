// Server adapters for the manager refresh (NOT deployed, NOT active).
//
// Three buckets with bucket-level grants only (no IAM conditions):
//   queue   intake: objectCreator only (create-only `queue/` and `wake/`);
//           job: objectViewer. A compromised intake can only add queue
//           entries, which the job re-verifies from scratch.
//   ledger  job only: objectCreator + objectViewer. Claims, attempts and
//           `published` records live here and nowhere else.
//   status  job: objectCreator (redacted projections); intake: objectViewer.
// The intake holds no GitHub credential and makes one anonymous read per new
// request. The job is a fixed-argument Cloud Run Job (no overrides). All I/O
// is injected so tests run on synthetic transports only.
import crypto from 'node:crypto';
import {
  createRefreshCoordinator, createFeePublicationVerifier, validateRequest, isDay, isFinalStatus,
  OWNER_ID, RefreshError, keys as ledgerKeys,
} from './fee-manager-refresh.mjs';

export const REPO = 'huanwujoy-crypto/fee-console';
export const API = 'https://api.github.com/repos/' + REPO;
export const PAGES = 'https://huanwujoy-crypto.github.io/fee-console/';
export const ALLOWED_ORIGIN = 'https://huanwujoy-crypto.github.io';
export const PRODUCER_WORKFLOW = 'fee-cloud-producer.yml';
// Pinned to the version the reviewed clock dispatcher already uses.
export const DISPATCH_API_VERSION = '2026-03-10';
export const REQUEST_FILE = 'fee-manager-refresh-request.json';
export const FRESH_MS = 10 * 60_000;
export const MAX_TARGET_AGE_DAYS = 4; // the promotion window's own bound
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const isSha40 = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const isUuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, k) => plain(v) && Object.keys(v).sort().join(',') === [...k].sort().join(',');
const fail = code => { throw new RefreshError(code); };
const json = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const hktDay = (t, back = 0) => new Date(t + 8 * 3600_000 - back * 86400_000).toISOString().slice(0, 10);

// ------------------------------------------------------------- GCS client
// Create-only objects (ifGenerationMatch=0). The ledger bucket must have no
// lifecycle rule so a success record can never expire into a fresh allowance.
export function createGcsBucket({ http, bucket }) {
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
    async names(prefix) {
      const out = [];
      let token = '';
      for (let page = 0; page < 20; page++) {
        const r = await http('GET', base + '?prefix=' + enc(prefix) + '&fields=items(name),nextPageToken' + (token ? '&pageToken=' + enc(token) : ''));
        if (r.status !== 200) throw new Error('list ' + r.status);
        const v = json(r.bytes);
        for (const item of v.items || []) out.push(item.name);
        if (!v.nextPageToken) return out.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
        token = v.nextPageToken;
      }
      fail('VERIFY_UNAVAILABLE');
    },
    async list(prefix) {
      const out = [];
      for (const key of await this.names(prefix)) out.push({ key, record: await this.get(key) });
      return out;
    },
  });
}
export const createGcsLedger = createGcsBucket;

// ------------------------------------------- owner-authored request proof
// Only the Gist owner can create a revision of their Gist, so a request file
// in the LATEST revision of the one configured ledger Gist, owned and
// committed by OWNER_ID within FRESH_MS of the REAL current time, proves a
// current owner request. The caller names neither Gist nor URL. One read.
export async function verifyOwnerRequest(body, { http, gistId, now, auth = null }) {
  if (!exact(body, ['requestId', 'gistVersion']) || !isUuid(body.requestId) || !isSha40(body.gistVersion)) fail('REQUEST_INVALID');
  if (!/^[a-f0-9]{20,40}$/.test(gistId || '')) fail('VERIFY_UNAVAILABLE');
  const headers = { Accept: 'application/vnd.github+json', ...(auth ? { Authorization: 'Bearer ' + auth() } : {}) };
  const r = await http('GET', 'https://api.github.com/gists/' + gistId, { headers });
  // Temporarily unavailable (rate limit, timeout, server error) is never a
  // verdict on the request: neither success nor staleness.
  if ([403, 408, 429].includes(r.status) || r.status >= 500 || !Number.isInteger(r.status)) fail('VERIFY_UNAVAILABLE');
  if (r.status !== 200) fail('IDENTITY_UNVERIFIED');
  const g = json(r.bytes), head = g.history?.[0];
  if (g.id !== gistId || g.owner?.id !== OWNER_ID || g.public !== false) fail('IDENTITY_UNVERIFIED');
  if (head?.version !== body.gistVersion || head.user?.id !== OWNER_ID) fail('IDENTITY_UNVERIFIED');
  const t = now().getTime(), at = Date.parse(head.committed_at);
  if (!Number.isFinite(at) || at > t + 60_000) fail('IDENTITY_UNVERIFIED');
  if (t - at > FRESH_MS) fail('REQUEST_STALE');
  const file = g.files?.[REQUEST_FILE];
  if (!file || file.truncated || typeof file.content !== 'string' || file.content.length > 2048) fail('REQUEST_INVALID');
  let request;
  try { request = JSON.parse(file.content); } catch { fail('REQUEST_INVALID'); }
  if (!validateRequest(request) || request.requestId !== body.requestId) fail('REQUEST_INVALID');
  const created = Date.parse(request.createdAt);
  if (created > at + 60_000 || at - created > FRESH_MS) fail('REQUEST_STALE');
  // Only the dates the protected promotion window can still accept.
  for (const day of [request.feeDataDate, request.ratioDataAsOf].filter(Boolean))
    if (day > hktDay(t) || day < hktDay(t, MAX_TARGET_AGE_DAYS)) fail('REQUEST_INVALID');
  return { request, identity: { verified: true, ownerId: OWNER_ID, method: 'owner-gist-authored-request' }, gistVersion: body.gistVersion };
}

// ------------------------------------------------------------ public intake
// CORS is not authentication; it only limits which page may read replies.
// POST: verify, queue create-only; only a NEW request may wake the job, and
// at most once per minute (atomic `wake/<minute>` slot). GET: read-only.
export async function handleIntake(req, { http, queue, status, gistId, now, runJob }) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
  const reply = (code, value) => ({ status: code, headers, body: JSON.stringify(value) });
  if (req.headers?.origin !== ALLOWED_ORIGIN) return { status: 403, headers: { 'Cache-Control': 'no-store' }, body: '' };
  headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
  if (req.method === 'OPTIONS') return { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' }, body: '' };
  try {
    if (req.method === 'POST' && req.path === '/v1/requests') {
      if (typeof req.body !== 'string' || req.body.length > 256) fail('REQUEST_INVALID');
      let body; try { body = JSON.parse(req.body); } catch { fail('REQUEST_INVALID'); }
      const proof = await verifyOwnerRequest(body, { http, gistId, now });
      const id = proof.request.requestId;
      try { await queue.create('queue/' + id, { schema: 'fee-console.manager-refresh-queue.v1', requestId: id, gistVersion: proof.gistVersion, queuedAt: now().toISOString() }); }
      catch (e) { return reply(202, { requestId: id, state: e.conflict ? 'duplicate' : 'unknown' }); }
      let woke = false;
      try { await queue.create('wake/' + now().toISOString().slice(0, 16), { requestId: id }); woke = true; } catch { /* another wake this minute */ }
      if (woke) { try { await runJob(); } catch { /* request stays queued; status shows it */ } }
      return reply(202, { requestId: id, state: 'queued' });
    }
    const m = /^\/v1\/requests\/([0-9a-f-]{36})$/.exec(req.path || '');
    if (req.method === 'GET' && m && isUuid(m[1])) {
      // A final answer is stored once under `final` and always wins over any
      // non-final projection, whenever that one was written.
      const final = await status.get('status/' + m[1] + '/final');
      if (final) return reply(200, final);
      const names = (await status.names('status/' + m[1] + '/')).filter(n => !n.endsWith('/final'));
      const latest = names.length ? await status.get(names.at(-1)) : null;
      return reply(200, latest || { requestId: m[1], state: 'none' });
    }
    return reply(404, { code: 'REQUEST_INVALID' });
  } catch (e) {
    const code = e instanceof RefreshError ? e.code : 'VERIFY_UNAVAILABLE';
    return reply(code === 'IDENTITY_UNVERIFIED' ? 403 : ['REQUEST_INVALID', 'REQUEST_STALE'].includes(code) ? 400 : 503, { code });
  }
}

// Status projections carry only fixed states/codes and dates.
export function redactStatus(requestId, s) {
  const step = x => x ? { state: x.state, ...(x.code ? { code: x.code } : {}), ...(x.dataDate ? { dataDate: x.dataDate } : {}) } : null;
  return { requestId, contents: s?.contents || null, fee: step(s?.fee), ratio: step(s?.ratio), ...(s?.code ? { code: s.code } : {}) };
}

// The trusted command group: the exact `run:` script of the
// `Create a signed owner candidate` step, read from the producer workflow at
// the run's own head commit (never a hand-copied expectation).
export const CANDIDATE_STEP = 'Create a signed owner candidate';
export function stepScript(workflowText, stepName = CANDIDATE_STEP) {
  if (typeof workflowText !== 'string') return null;
  const lines = workflowText.split('\n');
  const starts = lines.map((l, i) => [i, /^(\s*)- name: (.*)$/.exec(l)]).filter(([, m]) => m);
  const hit = starts.filter(([, m]) => m[2].trim() === stepName);
  if (hit.length !== 1) return null;
  const [at, m] = hit[0], indent = m[1].length;
  const end = (starts.find(([i, x]) => i > at && x[1].length <= indent) || [lines.length])[0];
  const runAt = lines.findIndex((l, i) => i > at && i < end && /^\s+run: \|\s*$/.test(l));
  if (runAt < 0) return null;
  const runIndent = lines[runAt].search(/\S/), body = [];
  for (let i = runAt + 1; i < end; i++) {
    const l = lines[i];
    if (!l.trim()) { if (body.length) break; continue; }
    if (l.search(/\S/) <= runIndent) break;
    body.push(l.trim());
  }
  return body.length ? body : null;
}

// Strict job-log parse. Requires exactly one `##[group]Run <first line>` whose
// echoed ANSI-wrapped command lines equal the trusted script line for line,
// exactly one `candidate <sha>` line in the whole log, located after that
// group's `##[endgroup]` and before the next group, timestamped inside the
// step's own start/end. Any other shape returns null.
export const LOG_HOSTS = Object.freeze([/^productionresultssa\d{1,3}\.blob\.core\.windows\.net$/, /^results-receiver\.actions\.githubusercontent\.com$/]);
const ANSI = /\x1b\[[0-9;]*m/g;
export function candidateFromLog(text, { script, stepStart, stepEnd } = {}) {
  if (typeof text !== 'string' || text.length > 4 * 1024 * 1024 || !Array.isArray(script) || !script.length) return null;
  const t0 = Date.parse(stepStart), t1 = Date.parse(stepEnd);
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) return null;
  const rows = text.split(/\r?\n/).map(raw => {
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) ?(.*)$/.exec(raw);
    return m ? { ts: Date.parse(m[1]), raw: m[2], text: m[2].replace(ANSI, ''), ansi: /^\x1b\[36;1m/.test(m[2]) } : { ts: NaN, raw, text: raw.replace(ANSI, ''), ansi: false };
  });
  const loose = rows.filter(r => /candidate [a-f0-9]{40}/.test(r.text)).length;
  const hits = rows.map((r, i) => [i, /^candidate ([a-f0-9]{40})$/.exec(r.text)]).filter(([, m]) => m);
  if (loose !== 1 || hits.length !== 1) return null;
  const header = '##[group]Run ' + script[0];
  const groups = [];
  rows.forEach((r, i) => {
    if (r.text !== header) return;
    const close = rows.findIndex((x, j) => j > i && x.text === '##[endgroup]');
    if (close < 0) return;
    const echoed = rows.slice(i + 1, close).filter(x => x.ansi).map(x => x.text.trim());
    if (echoed.length === script.length && echoed.every((l, k) => l === script[k])) groups.push([i, close]);
  });
  if (groups.length !== 1) return null;
  const [start, close] = groups[0], [at, m] = hits[0];
  const next = rows.findIndex((r, i) => i > close && r.text.startsWith('##[group]'));
  if (at <= close || (next !== -1 && at >= next)) return null;
  // Step times have second precision; allow that rounding only.
  const inStep = ts => Number.isFinite(ts) && ts >= t0 - 1000 && ts <= t1 + 1000;
  if (!inStep(rows[start].ts) || !inStep(rows[at].ts)) return null;
  return m[1];
}

// ---------------------------------------------------- GitHub fee adapters
// Reads use the job's own mounted credential only for public resources (no
// added permission) to get the authenticated rate limit; the intake never
// holds it. A rate-limited or failed read throws -> unknown, never success.
export function createGitHubFeeAdapters({ http, readToken, now }) {
  const auth = () => ({ Authorization: 'Bearer ' + readToken() });
  const get = async (url, accept = 'application/vnd.github+json', authed = true) => {
    const r = await http('GET', url, { headers: { Accept: accept, ...(authed ? auth() : {}) } });
    if (r.status !== 200) fail('VERIFY_UNAVAILABLE');
    return r.bytes;
  };
  const getJson = async url => json(await get(url));
  const fileCache = new Map();
  const readMain = async () => (await getJson(API + '/git/ref/heads/main')).object?.sha;
  // Immutable per commit: cache by sha so polling an unchanged main costs one read.
  const readRepoFile = async (sha, path) => {
    const k = sha + ':' + path;
    if (!fileCache.has(k)) { if (fileCache.size > 64) fileCache.clear(); fileCache.set(k, await get(API + '/contents/' + path + '?ref=' + sha, 'application/vnd.github.raw')); }
    return fileCache.get(k);
  };
  const readPages = path => get(PAGES + path + '?t=' + now().getTime(), '*/*', false);
  const isAncestor = async (a, b) => { const c = await getJson(API + '/compare/' + a + '...' + b + '?per_page=1'); return c.status === 'ahead' && c.behind_by === 0; };
  const runOf = async id => { const r = await getJson(API + '/actions/runs/' + id); if (r.id !== Number(id)) fail('VERIFY_UNAVAILABLE'); return r; };

  // Job logs answer with a redirect to a pre-signed storage URL. Follow
  // exactly one redirect, only to the expected storage hosts, WITHOUT the
  // GitHub credential. The exact live host is unverified (acceptance step);
  // any other host is refused -> provenance blocked.
  async function readJobLog(jobId) {
    if (!Number.isSafeInteger(jobId) || jobId <= 0) fail('VERIFY_UNAVAILABLE');
    const r = await http('GET', API + '/actions/jobs/' + jobId + '/logs', { headers: { Accept: 'application/vnd.github+json', ...auth() }, redirect: 'manual' });
    if (r.status === 200) return new TextDecoder('utf-8', { fatal: true }).decode(r.bytes);
    if (r.status !== 302 || typeof r.location !== 'string') fail('VERIFY_UNAVAILABLE');
    const u = new URL(r.location);
    if (u.protocol !== 'https:' || !LOG_HOSTS.some(re => re.test(u.hostname))) fail('VERIFY_UNAVAILABLE');
    const b = await http('GET', u.toString(), { headers: {}, external: true });
    if (b.status !== 200 || b.bytes.length > 4 * 1024 * 1024) fail('VERIFY_UNAVAILABLE');
    return new TextDecoder('utf-8', { fatal: true }).decode(b.bytes);
  }

  const publisher = Object.freeze({
    // Exactly the existing reviewed completed-sync inputs; the producer keeps
    // every one of its own owner/actor/main/source/publication gates.
    async start({ dataDate, claimMainSha }) {
      if (!isDay(dataDate) || !isSha40(claimMainSha)) return { state: 'refused' };
      const r = await http('POST', API + '/actions/workflows/' + PRODUCER_WORKFLOW + '/dispatches', {
        headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': DISPATCH_API_VERSION, ...auth() },
        body: JSON.stringify({ ref: 'main', return_run_details: true, inputs: { run_reviewed_once: 'true', report_kind: 'daily', report_target: dataDate, manual_sync_completed_for: dataDate, confirmed_main: claimMainSha } }),
      });
      // Same acceptance rule as the reviewed clock dispatcher
      // (cloud/fee-clock/runtime.py _dispatch): run id, run_url and html_url
      // must all name this repository's run. Anything else is unknown.
      if (r.status === 200) {
        let v; try { v = json(r.bytes); } catch { throw new Error('uncertain'); }
        const id = v?.workflow_run_id;
        if (Number.isSafeInteger(id) && id > 0 && v.run_url === API + '/actions/runs/' + id
          && v.html_url === 'https://github.com/' + REPO + '/actions/runs/' + id) return { state: 'started', handle: String(id) };
        throw new Error('uncertain');
      }
      // 204 has no run id, so it cannot be bound: unknown, never resent.
      if ([400, 401, 404, 422].includes(r.status)) return { state: 'refused' };
      throw new Error('uncertain'); // includes 403/429 rate limit
    },
    async status(handle) { const r = await runOf(handle); return r.status === 'completed' ? 'ended' : 'running'; },
    // No time-window lookup: a run created near the dispatch moment by the
    // same owner for the same date is not proof it came from this request.
    async lookup() { return 'unknown'; },
    // Bound only by trusted evidence, with no time-window guessing:
    //   run (dispatched, attempt 1, owner actor, main, success)
    //   -> its single `Produce daily <date>` job and its successful
    //      `Create a signed owner candidate` step
    //   -> the one `candidate <sha>` line fee-cloud-commit.mjs prints, inside
    //      that step's log group (job logs, server-side Actions read only)
    //   -> that commit: signed, owner-authored, sole parent = run.head_sha,
    //      subject `daily <date>`, on one codex/fee-daily-<date>-xxxxxx branch
    //   -> promotion fast-forwards main to that very commit.
    // Any missing or ambiguous link returns null (blocked).
    async provenance({ handle, dataDate }) {
      if (!handle || !/^\d{1,20}$/.test(handle) || !isDay(dataDate)) return null;
      const run = await runOf(handle);
      if (run.status !== 'completed' || run.conclusion !== 'success' || run.event !== 'workflow_dispatch' || run.path !== '.github/workflows/' + PRODUCER_WORKFLOW
        || run.head_branch !== 'main' || run.run_attempt !== 1 || run.actor?.id !== OWNER_ID || !isSha40(run.head_sha)) return null;
      const jobs = await getJson(API + '/actions/runs/' + handle + '/attempts/1/jobs?per_page=100');
      if (!Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length) return null;
      const produce = jobs.jobs.filter(j => j.name === 'Produce daily ' + dataDate);
      if (produce.length !== 1) return null;
      const job = produce[0];
      const step = (job.steps || []).filter(x => x.name === 'Create a signed owner candidate');
      if (job.run_id !== Number(handle) || job.head_sha !== run.head_sha || job.conclusion !== 'success' || step.length !== 1 || step[0].conclusion !== 'success') return null;
      const workflow = new TextDecoder('utf-8', { fatal: true }).decode(await readRepoFile(run.head_sha, '.github/workflows/' + PRODUCER_WORKFLOW));
      const script = stepScript(workflow);
      if (!script) return null;
      const log = await readJobLog(job.id);
      const sha = candidateFromLog(log, { script, stepStart: step[0].started_at, stepEnd: step[0].completed_at });
      if (!sha) return null;
      const c = await getJson(API + '/commits/' + sha);
      if (c.sha !== sha || c.commit?.verification?.verified !== true || c.author?.login !== 'huanwujoy-crypto'
        || !['huanwujoy-crypto', 'web-flow'].includes(c.committer?.login) || c.parents?.length !== 1 || c.parents[0].sha !== run.head_sha
        || c.commit?.message !== 'daily ' + dataDate) return null;
      const prefix = 'codex/fee-daily-' + dataDate.replaceAll('-', '') + '-';
      const refs = await getJson(API + '/git/matching-refs/heads/' + prefix);
      const branch = Array.isArray(refs) ? refs.filter(r => r?.object?.sha === sha && new RegExp('^refs/heads/' + prefix + '[a-z0-9]{6}$').test(r.ref)) : [];
      if (branch.length !== 1) return null;
      const main = await readMain();
      if (sha !== main && !(await isAncestor(sha, main))) return null;
      const [data, health] = await Promise.all([readRepoFile(sha, 'data.json'), readRepoFile(sha, 'fee-data-health.json')]);
      return { accountingThrough: dataDate, dataSha256: sha256(data), healthSha256: sha256(health), promotedMainSha: sha };
    },
  });

  // Idle only when no fee producer/validate/promote run is unfinished and no
  // candidate for the date is unincorporated (the producer's strict rule).
  // One bounded run listing instead of one request per workflow and status.
  async function pipelineIdle(dataDate) {
    const since = new Date(now().getTime() - 2 * 86400_000).toISOString().slice(0, 19) + 'Z';
    const runs = await getJson(API + '/actions/runs?exclude_pull_requests=true&per_page=100&created=%3E%3D' + since);
    if (!Number.isSafeInteger(runs.total_count) || !Array.isArray(runs.workflow_runs) || runs.total_count !== runs.workflow_runs.length) return false;
    const fee = new Set([PRODUCER_WORKFLOW, 'validate-fee-data.yml', 'promote-fee-data.yml'].map(w => '.github/workflows/' + w));
    if (runs.workflow_runs.some(r => fee.has(r.path) && r.status !== 'completed')) return false;
    const refs = await getJson(API + '/git/matching-refs/heads/codex/fee-daily-' + dataDate.replaceAll('-', '') + '-');
    if (!Array.isArray(refs) || refs.length > 32) return false;
    const main = refs.length ? await readMain() : null;
    for (const ref of refs) {
      const oid = ref?.object?.sha;
      if (!isSha40(oid)) return false;
      if (oid !== main && !(await isAncestor(oid, main))) return false;
    }
    return true;
  }
  return { publisher, pipelineIdle, readers: { readMain, readRepoFile, readPages, isAncestor } };
}

// Acceptance mode: identical intake/queue/ledger/claim/status paths, but the
// publisher refuses before any dispatch, so no producer run can start.
export const acceptancePublisher = Object.freeze({
  async start() { return { state: 'refused' }; },
  async status() { return 'ended'; },
  async lookup() { return 'unknown'; },
  async provenance() { return null; },
});

// --------------------------------------------------------------- the Job
// One execution walks the whole queue (paginated). Idempotency comes from
// the job-only ledger, never from a "handled" flag set before the work:
//   - `done/<id>` (written only after the final projection) skips a request;
//   - an existing batch is resumed: attempts are reconciled from evidence,
//     and a batch that claimed nothing starts only on a fresh re-proof;
//   - a request with no batch is either stale (recorded, no Gist read, no
//     work budget used) or verified against the REAL current time and run.
// Final projections are written once and never overwritten.
export async function runRefreshJob({ ledger, queue, status, http, gistId, now, wait, readToken, validateHealth, ratioCollector, mode = 'disabled', maxRequests = 5 }) {
  if (mode !== 'acceptance' && mode !== 'launch') return [];
  const gh = createGitHubFeeAdapters({ http, readToken, now });
  const coordinator = createRefreshCoordinator({
    ledger, now, wait, ratioCollector, pollMs: 60_000, deadlineMs: 15 * 60_000,
    feePublisher: mode === 'acceptance' ? acceptancePublisher : gh.publisher,
    pipelineIdle: gh.pipelineIdle,
    feeVerifier: createFeePublicationVerifier({ ...gh.readers, validateHealth }),
  });
  let seq = 0;
  // Final projections go to one create-only key that readers always prefer,
  // so a slower execution can never make a finished request look waiting.
  const project = async (id, value) => {
    const body = redactStatus(id, value);
    if (isFinalStatus(value)) {
      try { await status.create('status/' + id + '/final', body); return true; }
      catch (e) { return e?.conflict === true; } // an earlier final stands
    }
    try {
      if (await status.get('status/' + id + '/final')) return false;
      await status.create('status/' + id + '/' + now().toISOString() + '-' + String(seq++).padStart(4, '0'), body);
      return true;
    } catch { return false; }
  };
  // `done` only after the final projection is stored, so the page never
  // keeps an older non-final answer for a finished request.
  const finish = async (id, value) => {
    if (!(await project(id, value))) return;
    if (isFinalStatus(value)) { try { await ledger.create(ledgerKeys.done(id), { requestId: id, at: now().toISOString(), nonce: crypto.randomUUID() }); } catch {} }
  };
  const done = new Set((await ledger.names('fee-manager-refresh-v1/done/')).map(k => k.slice(k.lastIndexOf('/') + 1)));
  const out = [];
  let worked = 0;
  for (const key of await queue.names('queue/')) {
    const id = key.slice('queue/'.length);
    if (!isUuid(id) || done.has(id)) continue;
    // Re-check: another execution may have finished it meanwhile.
    if (await ledger.get(ledgerKeys.done(id))) continue;
    const entry = await queue.get(key);
    const wellFormed = exact(entry, ['schema', 'requestId', 'gistVersion', 'queuedAt']) && entry.requestId === id && isSha40(entry.gistVersion) && Number.isFinite(Date.parse(entry.queuedAt));
    const fresh = wellFormed && now().getTime() - Date.parse(entry.queuedAt) <= FRESH_MS;
    const proveFresh = async () => verifyOwnerRequest({ requestId: id, gistVersion: entry.gistVersion }, { http, gistId, now, auth: readToken });
    try {
      const batch = await ledger.get(ledgerKeys.batch(id));
      if (batch) {
        // Temporarily unavailable is NOT stale: skip this round and write
        // nothing. Only real elapsed time or an explicit stale proof ends it,
        // and even then through the batch gate, never beside a dispatch.
        let freshProof = false;
        if (fresh) {
          try { await proveFresh(); freshProof = true; }
          catch (e) { if (!(e instanceof RefreshError) || e.code === 'VERIFY_UNAVAILABLE') { out.push({ requestId: id, code: 'VERIFY_UNAVAILABLE' }); continue; } }
        }
        const st = await coordinator.resumeBatch(id, { fresh: freshProof });
        await finish(id, st);
        out.push({ requestId: id, resumed: true, fee: st.fee?.code || st.fee?.state || null, ratio: st.ratio?.code || null, code: null });
        continue;
      }
      if (!wellFormed) { await finish(id, { code: 'REQUEST_INVALID' }); out.push({ requestId: id, code: 'REQUEST_INVALID' }); continue; }
      if (!fresh) { await finish(id, { code: 'REQUEST_STALE' }); out.push({ requestId: id, code: 'REQUEST_STALE' }); continue; }
      if (worked >= maxRequests) continue; // left queued; still fresh for the next wake
      worked++;
      const proof = await proveFresh();
      const result = await coordinator.submit(proof.request, proof.identity);
      const st = await coordinator.batchStatus(id);
      await finish(id, st || { contents: proof.request.contents, fee: result.fee, ratio: result.ratio });
      out.push({ requestId: id, fee: result.fee?.code || null, ratio: result.ratio?.code || null, code: result.code || null });
    } catch (e) {
      const code = e instanceof RefreshError ? e.code : 'VERIFY_UNAVAILABLE';
      // Transient reads leave the request queued (it may still be fresh next wake).
      if (code === 'VERIFY_UNAVAILABLE') { out.push({ requestId: id, code }); continue; }
      if (await ledger.get(ledgerKeys.batch(id)).catch(() => null)) { out.push({ requestId: id, code }); continue; }
      await finish(id, { code: ['REQUEST_STALE', 'REQUEST_INVALID', 'IDENTITY_UNVERIFIED'].includes(code) ? code : 'REQUEST_INVALID' });
      out.push({ requestId: id, code });
    }
  }
  return out;
}
