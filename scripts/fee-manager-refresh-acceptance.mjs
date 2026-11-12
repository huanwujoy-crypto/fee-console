#!/usr/bin/env node
// API acceptance only. The execution flag is not authorization. No Gist writes,
// credentials, deletion, production dispatch, or deployment/IAM assertions.
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createLegacyPolicy} from './fee-legacy-policy.mjs';

export const ACCEPTANCE_ORIGIN = 'https://huanwujoy-crypto.github.io';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[a-f0-9]{40}$/;
const MAX_RESPONSE_BYTES = 8192;
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const stop = () => { throw Error('REFRESH_ACCEPTANCE_STOP'); };
const integer = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
const tokenList = value => (value || '').toLowerCase().split(',').map(s => s.trim());

export function acceptanceOrigin(value) {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    // Classic and project-number Cloud Run URL forms, with the exact service
    // name prefix. This does not prove who owns a service or its traffic split.
    if (!/^fee-refresh-intake-acceptance-(?:[a-z0-9]+-[a-z0-9]+\.a\.run\.app|[0-9]{1,20}\.[a-z0-9]+(?:-[a-z0-9]+)*\.run\.app)$/.test(u.hostname)
      || u.protocol !== 'https:' || u.username || u.password || u.port || u.pathname !== '/' || u.search || u.hash
      || (value !== u.origin && value !== u.origin + '/')) return null;
    return u.origin;
  } catch { return null; }
}

export function parseAcceptanceArgs(argv) {
  const options = {}, seen = new Set();
  for (const arg of argv) {
    if (arg === '--execute') { if (seen.has('execute')) stop(); seen.add('execute'); options.execute = true; continue; }
    const m = /^--(intake|request-id|gist-version|wait-seconds|request-timeout-ms)=(.+)$/.exec(arg);
    if (!m || seen.has(m[1])) stop(); seen.add(m[1]);
    const key = {intake:'intake', 'request-id':'requestId', 'gist-version':'gistVersion',
      'wait-seconds':'totalTimeoutMs', 'request-timeout-ms':'requestTimeoutMs'}[m[1]];
    if (key.endsWith('TimeoutMs')) {
      if (!/^[1-9][0-9]*$/.test(m[2])) stop();
      options[key] = Number(m[2]) * (m[1] === 'wait-seconds' ? 1000 : 1);
    } else options[key] = m[2];
  }
  return options;
}

export async function runRefreshAcceptance(options = {}) {
  const result = {schema:'fee-console.refresh-api-acceptance.v1', stage:'preflight', passed:false,
    preflightPassed:false, intakeOnlyPassed:false, ownerRequestPassed:false,
    validOwnerCloseRaceVerified:false, deploymentIsolationVerified:false, launchReady:false, checks:[]};
  const check = (id, pass) => { result.checks.push({id, pass:pass === true}); if (pass !== true) stop(); };
  try {
    const {intake, execute = false, requestId, gistVersion, fetchImpl = globalThis.fetch,
      uuid = () => crypto.randomUUID(), totalTimeoutMs = 60_000, requestTimeoutMs = 5000,
      pollIntervalMs = 1000, maxPolls = 60} = options;
    const origin = acceptanceOrigin(intake), owner = requestId !== undefined || gistVersion !== undefined;
    check('OPTIONS', !!origin && typeof execute === 'boolean' && typeof fetchImpl === 'function' && typeof uuid === 'function'
      && integer(totalTimeoutMs, 1, 300_000) && integer(requestTimeoutMs, 1, 15_000)
      && integer(pollIntervalMs, 1, 5000) && integer(maxPolls, 1, 300)
      && (!owner || (execute && UUID.test(requestId || '') && SHA.test(gistVersion || ''))));
    const deadline = performance.now() + totalTimeoutMs;
    async function call(method, path, {body, requestOrigin = ACCEPTANCE_ORIGIN, json = true} = {}) {
      const left = deadline - performance.now(); if (left <= 0) stop();
      const controller = new AbortController(); let timer, reader;
      const cancel = () => { try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch {} };
      const expired = new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); cancel(); reject(Error('REFRESH_ACCEPTANCE_STOP'));
      }, Math.min(requestTimeoutMs, left)); });
      const active = () => { if (controller.signal.aborted || performance.now() >= deadline) stop(); };
      try {
        return await Promise.race([expired, (async () => {
          const headers = {...(requestOrigin ? {Origin:requestOrigin} : {}),
            ...(body !== undefined ? {'Content-Type':'application/json'} : {}),
            ...(method === 'OPTIONS' ? {'Access-Control-Request-Method':'POST', 'Access-Control-Request-Headers':'content-type'} : {})};
          const url = origin + path;
          const r = await fetchImpl(url, {method, headers, ...(body !== undefined ? {body:JSON.stringify(body)} : {}),
            redirect:'error', credentials:'omit', cache:'no-store', referrerPolicy:'no-referrer', signal:controller.signal});
          active();
          if (r.redirected || r.url && r.url !== url || !integer(r.status, 100, 599) || r.status >= 300 && r.status < 400) stop();
          if (!tokenList(r.headers?.get('cache-control')).includes('no-store')) stop();
          if (json && !/^application\/json(?:\s*;|$)/i.test(r.headers?.get('content-type') || '')) stop();
          const cors = r.headers?.get('access-control-allow-origin');
          if (requestOrigin === ACCEPTANCE_ORIGIN ? cors !== ACCEPTANCE_ORIGIN : cors !== null) stop();
          const length = r.headers?.get('content-length');
          if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) stop();
          const parts = []; let size = 0;
          if (r.body !== null) {
            if (typeof r.body?.getReader !== 'function') stop(); reader = r.body.getReader();
            for (;;) {
              const part = await reader.read(); active(); if (part.done) break;
              if (!(part.value instanceof Uint8Array)) stop(); size += part.value.byteLength;
              if (size > MAX_RESPONSE_BYTES) stop(); parts.push(Buffer.from(part.value));
            }
          }
          active();
          const value = json ? createLegacyPolicy().parseExactJson(Buffer.concat(parts, size)) : null;
          active();
          return {status:r.status, value, headers:r.headers};
        })()]);
      } finally { clearTimeout(timer); controller.abort(); cancel(); }
    }
    async function mode(id) {
      const r = await call('GET', '/v1/mode');
      check(id, r.status === 200 && exact(r.value, ['schema','mode'])
        && r.value.schema === 'fee-console.manager-refresh-mode.v1' && r.value.mode === 'acceptance');
    }
    // Before EVERY writing probe, recheck the intake; the separate Job and
    // deployed revisions still need independent evidence outside this runner.
    const post = async (path, body) => { await mode('MODE_BEFORE_WRITE'); return call('POST', path, {body}); };
    const ack = (r, status, id, states) => r.status === status && exact(r.value, ['requestId','state'])
      && r.value.requestId === id && states.includes(r.value.state);
    await mode('MODE_ACCEPTANCE');
    const preflight = await call('OPTIONS', '/v1/requests', {json:false});
    check('CORS_PREFLIGHT', preflight.status === 204
      && ['get','post'].every(v => tokenList(preflight.headers.get('access-control-allow-methods')).includes(v))
      && tokenList(preflight.headers.get('access-control-allow-headers')).includes('content-type'));
    for (const requestOrigin of ['https://invalid.example', null]) {
      const r = await call('GET', '/v1/mode', {requestOrigin, json:false});
      check(requestOrigin ? 'FOREIGN_ORIGIN_REFUSED' : 'MISSING_ORIGIN_REFUSED', r.status === 403);
    }
    result.preflightPassed = true;
    if (!execute) { result.passed = true; return result; }
    result.stage = 'intake-only';
    const ghost = uuid(); check('PROBE_UUID', UUID.test(ghost || '') && ghost !== requestId);
    let r = await post('/v1/requests', {});
    check('INVALID_POST_REFUSED', r.status === 400 && exact(r.value, ['state','code'])
      && r.value.state === 'rejected' && r.value.code === 'REQUEST_INVALID');
    r = await call('GET', '/v1/requests/' + ghost);
    check('UNKNOWN_NOT_RECEIVED', ack(r, 200, ghost, ['not-received']));
    r = await post('/v1/requests/' + ghost + '/close');
    check('CLOSE_UNKNOWN', ack(r, 200, ghost, ['closed']));
    r = await post('/v1/requests/' + ghost + '/close');
    check('CLOSE_IDEMPOTENT', ack(r, 200, ghost, ['closed']));
    // Invalid proof only: this cannot establish the valid-owner late POST race.
    r = await post('/v1/requests', {requestId:ghost});
    check('INVALID_POST_AFTER_CLOSE', r.status === 400 && exact(r.value, ['requestId','state','code'])
      && r.value.requestId === ghost && r.value.state === 'rejected' && r.value.code === 'REQUEST_INVALID');
    r = await call('GET', '/v1/requests/' + ghost);
    check('CLOSED_STAYS_CLOSED', ack(r, 200, ghost, ['closed']));
    result.intakeOnlyPassed = true;
    if (!owner) { result.passed = true; return result; }
    result.stage = 'owner-request';
    const body = {requestId, gistVersion};
    r = await post('/v1/requests', body);
    check('OWNER_FIRST_QUEUED', ack(r, 202, requestId, ['queued']));
    // A second POST is an explicit idempotency probe only after a certain queue
    // acknowledgement. Any ambiguous write or response stops the entire run.
    r = await post('/v1/requests', body);
    check('OWNER_DUPLICATE', ack(r, 202, requestId, ['duplicate']));
    r = await post('/v1/requests/' + requestId + '/close');
    check('OWNER_CLOSE_REFUSED', ack(r, 200, requestId, ['queued','received']));
    for (let n = 0; n < maxPolls; n++) {
      r = await call('GET', '/v1/requests/' + requestId);
      check('OWNER_STATUS_HTTP_ID', r.status === 200 && r.value?.requestId === requestId);
      if (!ack(r, 200, requestId, ['queued'])) {
        check('OWNER_FEE_ONLY', exact(r.value, ['requestId','contents','fee','ratio'])
          && Array.isArray(r.value.contents) && r.value.contents.length === 1 && r.value.contents[0] === 'fee' && r.value.ratio === null);
        if (r.value.fee !== null) {
          const fee = r.value.fee, dated = Object.hasOwn(fee, 'dataDate');
          check('OWNER_PUBLISHER_REFUSED', exact(fee, dated ? ['state','code','dataDate'] : ['state','code'])
            && (!dated || (typeof fee.dataDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fee.dataDate)
              && Number.isFinite(Date.parse(fee.dataDate+'T00:00:00Z')) && new Date(fee.dataDate+'T00:00:00Z').toISOString().slice(0,10) === fee.dataDate))
            && fee.state === 'failed' && fee.code === 'PUBLISHER_REFUSED');
          result.ownerRequestPassed = true; result.passed = true; return result;
        }
      }
      const wait = Math.min(pollIntervalMs, deadline - performance.now());
      if (wait <= 0 || n + 1 === maxPolls) break;
      await new Promise(resolve => setTimeout(resolve, wait));
    }
    check('OWNER_WAIT_BOUNDED', false);
  } catch { if (!result.checks.some(c => !c.pass)) result.checks.push({id:'TRANSPORT_OR_PROTOCOL', pass:false}); }
  return result;
}

async function main() {
  let options;
  try { options = parseAcceptanceArgs(process.argv.slice(2)); }
  catch { options = {}; }
  const result = await runRefreshAcceptance(options);
  process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.passed ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
