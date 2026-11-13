#!/usr/bin/env node
// Container entry points for the manager refresh (NOT deployed).
//   node scripts/fee-manager-refresh-entry.mjs serve   # public intake
//   node scripts/fee-manager-refresh-entry.mjs job     # fixed-argument job
// Default mode is `disabled`: serve answers 503 INTAKE_NOT_ACTIVE to every
// request and job exits without reading anything. `acceptance` requires
// bucket names ending in `-acceptance` and never dispatches the producer.
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGcsBucket, handleIntake, runRefreshJob, ALLOWED_ORIGIN, LOG_HOSTS } from './fee-manager-refresh-server.mjs';
import { validateHealth } from './fee-data-health.mjs';

export const TOKEN_FILE = '/secrets/github/token';
const MAX_BYTES = 2 * 1024 * 1024;
const GOOGLE = new Set(['storage.googleapis.com', 'run.googleapis.com']);
const ALLOWED_HOSTS = new Set([...GOOGLE, 'api.github.com', 'huanwujoy-crypto.github.io']);
const transportError = code => new Error('FEE_REFRESH_' + code);
function refuseResponse(response, code) {
  try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch {}
  throw transportError(code);
}

// The deadline includes metadata, headers and every body read. A late promise
// cannot start another request after expiry, even if a test transport ignores
// AbortSignal. Cleanup is best-effort and cannot extend that deadline.
async function bounded(timeoutMs, operation, fallback) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw transportError('CONFIG');
  const ac = new AbortController(); let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => { reject(transportError('TIMEOUT')); ac.abort(); }, timeoutMs);
  });
  try { return await Promise.race([Promise.resolve().then(() => operation(ac.signal)), expired]); }
  catch (e) {
    if (['FEE_REFRESH_HOST', 'FEE_REFRESH_SIZE', 'FEE_REFRESH_TIMEOUT', 'FEE_REFRESH_HTTP', 'FEE_REFRESH_METADATA'].includes(e?.message)) throw e;
    throw transportError(fallback);
  } finally { clearTimeout(timer); }
}
async function readBounded(response, max, signal) {
  let reader, complete = false;
  const cancel = () => { try { Promise.resolve(reader ? reader.cancel() : response.body?.cancel()).catch(() => {}); } catch {} };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) throw transportError('TIMEOUT');
    const length = response.headers?.get?.('content-length');
    if (length != null && (!/^\d+$/.test(length) || Number(length) > max)) throw transportError('SIZE');
    if (response.body === null) { if (length != null && Number(length) !== 0) throw transportError('SIZE'); complete = true; return new Uint8Array(); }
    if (typeof response.body?.getReader !== 'function') throw transportError('HTTP');
    reader = response.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const part = await reader.read();
      if (signal.aborted) throw transportError('TIMEOUT');
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw transportError('HTTP');
      size += part.value.byteLength;
      if (size > max) throw transportError('SIZE');
      if (part.value.byteLength) chunks.push(Buffer.from(part.value));
    }
    complete = true; return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    try { reader?.releaseLock(); } catch {}
  }
}

export function readConfig(env, role) {
  const mode = env.FEE_REFRESH_MODE || 'disabled';
  if (!['disabled', 'acceptance', 'launch'].includes(mode)) throw new Error('FEE_REFRESH_CONFIG');
  if (mode === 'disabled') return { mode };
  const c = { mode, gistId: env.FEE_REFRESH_GIST_ID, queueBucket: env.FEE_REFRESH_QUEUE_BUCKET, statusBucket: env.FEE_REFRESH_STATUS_BUCKET,
    ledgerBucket: env.FEE_REFRESH_LEDGER_BUCKET, job: env.FEE_REFRESH_JOB };
  const need = role === 'serve' ? ['gistId', 'queueBucket', 'statusBucket', 'job'] : ['gistId', 'queueBucket', 'statusBucket', 'ledgerBucket'];
  for (const k of need) if (typeof c[k] !== 'string' || !c[k]) throw new Error('FEE_REFRESH_CONFIG');
  // The intake must not be configured with the ledger at all.
  if (role === 'serve' && env.FEE_REFRESH_LEDGER_BUCKET) throw new Error('FEE_REFRESH_CONFIG');
  if (role === 'serve' && !/^projects\/[a-z][a-z0-9-]{4,29}\/locations\/[a-z0-9-]+\/jobs\/[a-z][a-z0-9-]{0,48}$/.test(c.job)) throw new Error('FEE_REFRESH_CONFIG');
  const buckets = [c.queueBucket, c.statusBucket, c.ledgerBucket].filter(Boolean);
  if (new Set(buckets).size !== buckets.length) throw new Error('FEE_REFRESH_CONFIG');
  // Acceptance and production never share a bucket or a job: every
  // acceptance name ends in -acceptance and no production name does.
  const names = [...buckets, ...(c.job ? [c.job.split('/').pop()] : [])];
  if (mode === 'acceptance' && !names.every(b => b.endsWith('-acceptance'))) throw new Error('FEE_REFRESH_CONFIG');
  if (mode === 'launch' && names.some(b => b.endsWith('-acceptance'))) throw new Error('FEE_REFRESH_CONFIG');
  return c;
}

// Bounded HTTPS client: fixed hosts, no redirects, size and time limits.
// Google calls carry the runtime service account's metadata token only.
export function createHttp({ fetchImpl = globalThis.fetch, metadataToken, timeoutMs = 15_000 } = {}) {
  return async (method, url, { headers = {}, body, redirect, external = false } = {}) => {
    const u = new URL(url);
    // `external`: a pre-signed job-log URL; GET only, no credential of any kind.
    const okHost = external ? LOG_HOSTS.some(re => re.test(u.hostname)) : ALLOWED_HOSTS.has(u.hostname);
    if (u.protocol !== 'https:' || !okHost || u.username || u.password || u.port || u.hash
      || (external && (method !== 'GET' || Object.keys(headers).length || body !== undefined))) throw transportError('HOST');
    return bounded(timeoutMs, async signal => {
      const h = { 'User-Agent': 'fee-console-manager-refresh', ...headers };
      if (!external && GOOGLE.has(u.hostname)) h.Authorization = 'Bearer ' + await metadataToken();
      if (signal.aborted) throw transportError('TIMEOUT');
      const r = await fetchImpl(url, { method, headers: h, body, redirect: redirect === 'manual' ? 'manual' : 'error', signal,
        credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
      if (signal.aborted) refuseResponse(r, 'TIMEOUT');
      if (r.redirected || r.url && r.url !== u.href) refuseResponse(r, 'HOST');
      if (!Number.isInteger(r.status) || r.status < 100 || r.status > 599 || (r.status >= 300 && r.status < 400 && redirect !== 'manual')) refuseResponse(r, 'HTTP');
      const buf = await readBounded(r, external ? 4 * MAX_BYTES : MAX_BYTES, signal);
      return { status: r.status, bytes: buf, ...(redirect === 'manual' && r.status >= 300 && r.status < 400 ? { location: r.headers?.get?.('location') || null } : {}) };
    }, 'HTTP');
  };
}
export function createMetadataToken(fetchImpl = globalThis.fetch, { timeoutMs = 15_000 } = {}) {
  let cached = null;
  return async () => {
    if (cached && cached.expires > Date.now() + 60_000) return cached.token;
    return bounded(timeoutMs, async signal => {
      const url = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
      const r = await fetchImpl(url, { headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal, credentials: 'omit', cache: 'no-store' });
      if (signal.aborted) refuseResponse(r, 'TIMEOUT');
      if (r.status !== 200 || r.redirected || r.url && r.url !== url) refuseResponse(r, 'METADATA');
      const v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(r, 65536, signal)));
      if (typeof v.access_token !== 'string' || v.access_token.length < 1 || v.access_token.length > 8192 || /[\s\x00-\x1f\x7f]/.test(v.access_token)
        || !Number.isFinite(v.expires_in) || v.expires_in <= 0 || v.expires_in > 86400) throw transportError('METADATA');
      if (signal.aborted) throw transportError('TIMEOUT');
      cached = { token: v.access_token, expires: Date.now() + v.expires_in * 1000 };
      return cached.token;
    }, 'METADATA');
  };
}
// Start the fixed job with an empty body: no args/env/task overrides.
export const startJob = (httpCall, job) => async () => {
  const r = await httpCall('POST', 'https://run.googleapis.com/v2/' + job + ':run', { headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (r.status !== 200) throw new Error('FEE_REFRESH_JOB_START');
};
export function readToken(file = TOKEN_FILE) {
  const t = fs.readFileSync(file, 'utf8').trim();
  if (t.length < 20 || /[\s\0]/.test(t)) throw new Error('FEE_REFRESH_TOKEN');
  return t;
}

export function createIntakeHandler(config, deps) {
  if (config.mode === 'disabled') return async () => ({ status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: '{"code":"INTAKE_NOT_ACTIVE"}' });
  const queue = createGcsBucket({ http: deps.http, bucket: config.queueBucket }), status = createGcsBucket({ http: deps.http, bucket: config.statusBucket });
  return req => handleIntake(req, { http: deps.http, queue, status, gistId: config.gistId, now: deps.now, runJob: startJob(deps.http, config.job), mode: config.mode });
}

export async function runJob(config, deps) {
  if (config.mode === 'disabled') return { mode: 'disabled', handled: 0 };
  const b = name => createGcsBucket({ http: deps.http, bucket: name });
  const results = await runRefreshJob({ ledger: b(config.ledgerBucket), queue: b(config.queueBucket), status: b(config.statusBucket), http: deps.http,
    gistId: config.gistId, now: deps.now, wait: deps.wait, readToken: deps.readToken, validateHealth, mode: config.mode });
  return { mode: config.mode, handled: results.length, codes: results.map(r => r.code || r.fee || 'none') };
}

// Credential isolation: an acceptance job must run with no GitHub credential
// mounted at all; a launch job must have one. Anything else refuses to start.
export function credentialFor(config, role, exists = fs.existsSync) {
  if (config.mode === 'disabled' || role !== 'job') return null;
  const present = exists(TOKEN_FILE);
  if (config.mode === 'acceptance') { if (present) throw new Error('FEE_REFRESH_ISOLATION'); return null; }
  if (!present) throw new Error('FEE_REFRESH_TOKEN');
  return () => readToken();
}

async function main(role) {
  const config = readConfig(process.env, role);
  const deps = { http: createHttp({ metadataToken: createMetadataToken() }), now: () => new Date(), wait: ms => new Promise(r => setTimeout(r, ms)), readToken: credentialFor(config, role) };
  if (role === 'job') { process.stdout.write(JSON.stringify(await runJob(config, deps)) + '\n'); return; }
  const handler = createIntakeHandler(config, deps);
  http.createServer((req, res) => {
    let body = '', size = 0;
    req.on('data', c => { size += c.length; if (size > 1024) { req.destroy(); return; } body += c; });
    req.on('end', async () => {
      let out;
      try { out = await handler({ method: req.method, path: new URL(req.url, 'http://x').pathname, headers: { origin: req.headers.origin }, body }); }
      catch { out = { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: '{"code":"VERIFY_UNAVAILABLE"}' }; }
      res.writeHead(out.status, out.headers); res.end(out.body);
    });
  }).listen(Number(process.env.PORT) || 8080);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const role = process.argv[2];
  if (!['serve', 'job'].includes(role)) { process.stderr.write('usage: serve|job\n'); process.exit(2); }
  main(role).catch(e => { process.stderr.write((/^FEE_REFRESH_[A-Z_]+$/.test(e?.message) ? e.message : 'FEE_REFRESH_FAILED') + '\n'); process.exit(1); });
}
export { ALLOWED_ORIGIN };
