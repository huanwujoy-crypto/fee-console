// Offline preparation only. No fetch, credentials, cloud CLI, Docker invocation
// or production execution capability. The deployment plan itself is checked by
// scripts/fee-manager-refresh-deploy.test.mjs (two environments; acceptance
// holds no GitHub credential).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMemoryLedger, keys, SCHEMA, OWNER_ID } from '../../scripts/fee-manager-refresh.mjs';
import { handleIntake, runRefreshJob, ROLE_ACCESS, API, REQUEST_FILE, ALLOWED_ORIGIN } from '../../scripts/fee-manager-refresh-server.mjs';
import { buildHealth, validateHealth } from '../../scripts/fee-data-health.mjs';
import { createLegacyPolicy } from '../../scripts/fee-legacy-policy.mjs';

export const RUNTIME_FILES = Object.freeze([
  'scripts/fee-data-health.mjs', 'scripts/fee-engine.mjs', 'scripts/fee-income-date-policy.mjs',
  'scripts/fee-legacy-policy.mjs', 'scripts/fee-management-exemption.mjs', 'scripts/fee-manager-refresh-entry.mjs',
  'scripts/fee-manager-refresh-server.mjs', 'scripts/fee-manager-refresh.mjs', 'scripts/fee-receipt-core.mjs',
]);
const exact = (v, names) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...names].sort().join(',');
const refuse = () => { throw Error('REFRESH_ISOLATION_REFUSED'); };
const canonical = v => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : v && typeof v === 'object'
  ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
// Analyze a saved/redacted process result only. Never launches a browser,
// changes its flags, reads a profile or recommends an automatic retry.
export function diagnoseRefreshBrowserProbe(r) {
  if (!exact(r, ['status', 'signal', 'errorCode', 'stdout', 'stderr', 'stdoutComplete', 'stderrComplete', 'versionAvailable'])
    || !(r.status === null || Number.isInteger(r.status) && r.status >= 0 && r.status <= 255)
    || !(r.signal === null || typeof r.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(r.signal))
    || !(r.errorCode === null || typeof r.errorCode === 'string' && /^[A-Z_]{1,32}$/.test(r.errorCode))
    || ![null, true, false].includes(r.versionAvailable)) refuse();
  for (const name of ['stdout', 'stderr']) {
    if (!(r[name] === null || typeof r[name] === 'string' && Buffer.byteLength(r[name]) <= 65536)
      || typeof r[name + 'Complete'] !== 'boolean' || r[name] === null && r[name + 'Complete']) refuse();
  }
  const stdout = r.stdout ?? '', stderr = r.stderr ?? '';
  const marker = stdout.includes('<pre id="result">ok</pre>');
  const deniedSpawn = ['EACCES', 'EPERM'].includes(r.errorCode);
  const pagePolicyMention = /net::ERR_BLOCKED_BY_ADMINISTRATOR/.test(stdout + '\n' + stderr);
  const outcome = r.errorCode === 'ETIMEDOUT' ? 'TIMED_OUT'
    : r.errorCode === 'ENOENT' ? 'EXECUTABLE_NOT_FOUND'
    : deniedSpawn ? 'SPAWN_ACCESS_DENIED'
    : r.errorCode !== null ? 'PROCESS_ERROR'
    : r.signal !== null ? 'PROCESS_SIGNALLED'
    : r.status !== null && r.status !== 0 ? 'PROCESS_FAILED'
    : r.status === 0 && marker && r.stdoutComplete ? 'PROBE_SCRIPT_COMPLETED'
    : 'PAGE_UNCONFIRMED';
  return { schema: 'fee-console.refresh-browser-diagnostic.v1', outcome,
    versionCheckConfirmed: r.versionAvailable === true,
    probeScript: marker ? 'MARKER_OBSERVED' : 'UNCONFIRMED',
    accessRestriction: deniedSpawn ? 'SPAWN_DENIAL_OBSERVED' : pagePolicyMention ? 'PAGE_POLICY_ERROR_MENTIONED' : 'NOT_OBSERVED_IN_AVAILABLE_LOGS',
    dbusErrorsObserved: /dbus\/|org\.freedesktop\.DBus/i.test(stderr),
    logsComplete: r.stdoutComplete && r.stderrComplete,
    automaticRetryAllowed: false, managerUiAccepted: false, liveAcceptanceComplete: false, productionReady: false };
}

// A complete synthetic previous publication permits the acceptance job to reach
// its refusal publisher. All service/storage activity stays in these closures.
function world({ contents = ['fee'], unavailable = false } = {}) {
  let at = Date.parse('2026-11-11T02:00:00.000Z');
  const now = () => new Date(at), gistId = '0'.repeat(32), version = 'b'.repeat(40);
  const request = { schema: SCHEMA.request, requestId: crypto.randomUUID(), createdAt: now().toISOString(), contents,
    feeDataDate: '2026-11-10', ...(contents.includes('ratio') ? { ratioDataAsOf: '2026-11-10' } : {}) };
  const encode = v => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v));
  const data = encode({ enc: true, v: 1, data: 'synthetic-previous-only' });
  const health = buildHealth({ checkedAt: now().toISOString(), targetDate: '2026-11-09', outcome: 'updated',
    sourceDates: { schwab: '2026-11-09', webull: '2026-11-09', benchmark: '2026-11-09' }, dataSha256: crypto.createHash('sha256').update(data).digest('hex') });
  const raw = {};
  for (const name of ['queue', 'status', 'ledger']) { const b = createMemoryLedger(); b.names = async prefix => (await b.list(prefix)).map(v => v.key); raw[name] = b; }
  const operations = [], counters = { jobStarts: 0, producerDispatches: 0, ratioCollections: 0 };
  const role = who => Object.fromEntries(Object.entries(raw).map(([name, store]) => {
    const allow = op => { if (!ROLE_ACCESS[who][name].includes(op)) refuse(); operations.push(who + ':' + name + ':' + op); };
    return [name, { create: async (key, value) => { allow('create'); return store.create(key, value); },
      get: async key => { allow('get'); return store.get(key); }, names: async prefix => { allow('list'); return store.names(prefix); },
      list: async prefix => { allow('list'); allow('get'); return store.list(prefix); } }];
  }));
  const http = async (method, url) => {
    if (method !== 'GET') { counters.producerDispatches++; refuse(); }
    if (unavailable) return { status: 503, bytes: encode('') };
    if (url === 'https://api.github.com/gists/' + gistId) return { status: 200, bytes: encode({ id: gistId, public: false,
      owner: { id: OWNER_ID }, history: [{ version, user: { id: OWNER_ID }, committed_at: request.createdAt }],
      files: { [REQUEST_FILE]: { content: JSON.stringify(request), truncated: false } } }) };
    if (url === API + '/git/ref/heads/main') return { status: 200, bytes: encode({ object: { sha: 'c'.repeat(40) } }) };
    if (url === API + '/contents/data.json?ref=' + 'c'.repeat(40)) return { status: 200, bytes: data };
    if (url === API + '/contents/fee-data-health.json?ref=' + 'c'.repeat(40)) return { status: 200, bytes: encode(health) };
    refuse();
  };
  const intakeRole = role('intake'), jobRole = role('job');
  const intake = (method, path, body, origin = ALLOWED_ORIGIN) => handleIntake({ method, path, body, headers: { origin } },
    { ...intakeRole, http, gistId, now, mode: 'acceptance', runJob: async () => { counters.jobStarts++; } });
  const submit = origin => intake('POST', '/v1/requests', JSON.stringify({ requestId: request.requestId, gistVersion: version }), origin);
  const status = async () => JSON.parse((await intake('GET', '/v1/requests/' + request.requestId)).body);
  const job = () => runRefreshJob({ ...jobRole, http, gistId, now, wait: async () => {}, mode: 'acceptance',
    readToken: null, validateHealth, ratioCollector: { async collect() { counters.ratioCollections++; refuse(); } } });
  return { request, raw, operations, counters, submit, intake, status, job, advance: ms => { at += ms; } };
}

export async function runSyntheticRefreshAcceptance(...args) {
  if (args.length) refuse();
  const checks = [], counts = { producerDispatches: 0, ratioCollections: 0 };
  const check = (ok, code) => { if (!ok) refuse(); checks.push(code); };
  for (const contents of [['fee'], ['fee', 'ratio']]) {
    const w = world({ contents }), label = contents.join('+');
    check((await w.submit('https://wrong.example.invalid')).status === 403, label + ':ORIGIN_REFUSED');
    check(JSON.parse((await w.submit()).body).state === 'queued', label + ':QUEUED');
    check(JSON.parse((await w.submit()).body).state === 'duplicate' && w.counters.jobStarts === 1, label + ':DUPLICATE_NO_WAKE');
    const sizes = [w.raw.queue.rows.size, w.raw.ledger.rows.size, w.raw.status.rows.size];
    check((await w.status()).state === 'queued' && canonical(sizes) === canonical([w.raw.queue.rows.size, w.raw.ledger.rows.size, w.raw.status.rows.size]), label + ':GET_READ_ONLY');
    w.advance(60_000); check((await w.job())[0]?.fee === 'PUBLISHER_REFUSED', label + ':ACCEPTANCE_REFUSED');
    const final = await w.status();
    check(final.fee?.state === 'failed' && final.fee.code === 'PUBLISHER_REFUSED', label + ':FINAL_REFUSAL');
    if (contents.includes('ratio')) check(final.ratio?.state === 'blocked' && final.ratio.code === 'FEE_NOT_VERIFIED', label + ':RATIO_NOT_PUBLISHED');
    check(await w.raw.ledger.get(keys.published('fee', '2026-11-10')) === null, label + ':NO_PUBLICATION_RECORD');
    check((await w.job()).length === 0 && canonical(await w.status()) === canonical(final), label + ':FINAL_STABLE');
    check(!w.operations.some(op => op.startsWith('intake:ledger:')), label + ':ROLE_BOUNDARIES');
    counts.producerDispatches += w.counters.producerDispatches; counts.ratioCollections += w.counters.ratioCollections;
  }
  const closed = world(), id = closed.request.requestId;
  check(JSON.parse((await closed.intake('POST', '/v1/requests/' + id + '/close')).body).state === 'closed', 'CLOSE_ATOMIC');
  check(JSON.parse((await closed.submit()).body).code === 'REQUEST_CLOSED', 'LATE_POST_REFUSED');
  await closed.job(); check(await closed.raw.ledger.get(keys.batch(id)) === null && closed.counters.jobStarts === 0, 'CLOSED_NEVER_RUN');
  const stale = world(); stale.advance(11 * 60_000);
  check(JSON.parse((await stale.submit()).body).code === 'REQUEST_STALE' && stale.raw.queue.rows.size === 0, 'STALE_NOT_QUEUED');
  const unavailable = world({ unavailable: true });
  check(JSON.parse((await unavailable.submit()).body).code === 'VERIFY_UNAVAILABLE' && unavailable.raw.queue.rows.size === 0, 'UNAVAILABLE_NOT_SUCCESS');
  for (const w of [closed, stale, unavailable]) { counts.producerDispatches += w.counters.producerDispatches; counts.ratioCollections += w.counters.ratioCollections; }
  check(counts.producerDispatches === 0 && counts.ratioCollections === 0, 'ZERO_PRODUCTION_OR_RATIO_COLLECTION');
  return { schema: 'fee-console.refresh-synthetic-acceptance.v1', status: 'PASS_SYNTHETIC_ONLY', checks,
    producerDispatches: 0, ratioCollections: 0, liveAcceptanceComplete: false, productionReady: false };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try {
    if (process.argv.length !== 3) refuse();
    if (process.argv[2] === '--synthetic') console.log(JSON.stringify(await runSyntheticRefreshAcceptance()));
    else if (process.argv[2] === '--diagnose-browser') {
      const input = Buffer.alloc(262145); let size = 0, count;
      while (size < input.length && (count = fs.readSync(0, input, size, input.length - size, null)) > 0) size += count;
      if (size === 0 || size === input.length) refuse();
      console.log(JSON.stringify(diagnoseRefreshBrowserProbe(createLegacyPolicy().parseExactJson(input.subarray(0, size)))));
    } else refuse();
  } catch { console.error('REFRESH_ISOLATION_REFUSED'); process.exitCode = 1; }
}
