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
  if (mode === 'acceptance' && !buckets.every(b => b.endsWith('-acceptance'))) throw new Error('FEE_REFRESH_CONFIG');
  if (mode === 'launch' && buckets.some(b => b.endsWith('-acceptance'))) throw new Error('FEE_REFRESH_CONFIG');
  return c;
}

// Bounded HTTPS client: fixed hosts, no redirects, size and time limits.
// Google calls carry the runtime service account's metadata token only.
export function createHttp({ fetchImpl = globalThis.fetch, metadataToken } = {}) {
  return async (method, url, { headers = {}, body, redirect, external = false } = {}) => {
    const u = new URL(url);
    // `external`: a pre-signed job-log URL; GET only, no credential of any kind.
    const okHost = external ? LOG_HOSTS.some(re => re.test(u.hostname)) : ALLOWED_HOSTS.has(u.hostname);
    if (u.protocol !== 'https:' || !okHost || (external && (method !== 'GET' || Object.keys(headers).length))) throw new Error('FEE_REFRESH_HOST');
    const h = { 'User-Agent': 'fee-console-manager-refresh', ...headers };
    if (!external && GOOGLE.has(u.hostname)) h.Authorization = 'Bearer ' + await metadataToken();
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 15_000);
    try {
      const r = await fetchImpl(url, { method, headers: h, body, redirect: redirect === 'manual' ? 'manual' : 'error', signal: ac.signal });
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length > (external ? 4 * MAX_BYTES : MAX_BYTES)) throw new Error('FEE_REFRESH_SIZE');
      return { status: r.status, bytes: buf, ...(redirect === 'manual' && r.status >= 300 && r.status < 400 ? { location: r.headers?.get?.('location') || null } : {}) };
    } finally { clearTimeout(timer); }
  };
}
export function createMetadataToken(fetchImpl = globalThis.fetch) {
  let cached = null;
  return async () => {
    if (cached && cached.expires > Date.now() + 60_000) return cached.token;
    const r = await fetchImpl('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error' });
    if (r.status !== 200) throw new Error('FEE_REFRESH_METADATA');
    const v = await r.json();
    if (typeof v.access_token !== 'string' || !Number.isFinite(v.expires_in)) throw new Error('FEE_REFRESH_METADATA');
    cached = { token: v.access_token, expires: Date.now() + v.expires_in * 1000 };
    return cached.token;
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
  return req => handleIntake(req, { http: deps.http, queue, status, gistId: config.gistId, now: deps.now, runJob: startJob(deps.http, config.job) });
}

export async function runJob(config, deps) {
  if (config.mode === 'disabled') return { mode: 'disabled', handled: 0 };
  const b = name => createGcsBucket({ http: deps.http, bucket: name });
  const results = await runRefreshJob({ ledger: b(config.ledgerBucket), queue: b(config.queueBucket), status: b(config.statusBucket), http: deps.http,
    gistId: config.gistId, now: deps.now, wait: deps.wait, readToken: deps.readToken, validateHealth, mode: config.mode });
  return { mode: config.mode, handled: results.length, codes: results.map(r => r.code || r.fee || 'none') };
}

async function main(role) {
  const config = readConfig(process.env, role);
  const deps = { http: createHttp({ metadataToken: createMetadataToken() }), now: () => new Date(), wait: ms => new Promise(r => setTimeout(r, ms)), readToken: () => readToken() };
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
