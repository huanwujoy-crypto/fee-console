#!/usr/bin/env node
// Acceptance runner for a DEPLOYED ACCEPTANCE intake only (not run by CI).
//   node scripts/fee-manager-refresh-acceptance.mjs --intake=https://fee-refresh-intake-acceptance-....run.app \
//        [--request-id=<uuid> --gist-version=<40 hex>] [--wait-seconds=600]
// It refuses to send anything unless the host is the acceptance service AND
// the service itself reports mode "acceptance". It uses no credential. The
// optional owner request is one the owner wrote into the ledger Gist for this
// run; the acceptance job never dispatches the producer, so its final state
// can never be "published". Output: fixed check ids, PASS/FAIL and codes only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ACCEPTANCE_SERVICE = 'fee-refresh-intake-acceptance';
export const ORIGIN = 'https://huanwujoy-crypto.github.io';
// Final codes acceptable in acceptance mode: nothing is ever dispatched.
export const ACCEPTANCE_FINAL_CODES = Object.freeze(['PUBLISHER_REFUSED', 'DATE_ALREADY_PUBLISHED_ELSEWHERE', 'HISTORY_AHEAD_OF_TARGET', 'VERIFY_UNAVAILABLE', 'REQUEST_STALE', 'ATTEMPTS_EXHAUSTED', 'LOST_RACE', 'IDENTITY_UNVERIFIED', 'REQUEST_INVALID']);
const isUuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);

export function acceptanceHost(intake) {
  let u;
  try { u = new URL(intake); } catch { return false; }
  return u.protocol === 'https:' && u.pathname === '/' && !u.search && !u.hash && u.hostname.startsWith(ACCEPTANCE_SERVICE + '-') && u.hostname.endsWith('.run.app');
}

export async function runAcceptance({ intake, fetchImpl = globalThis.fetch, uuid = () => crypto.randomUUID(), ownerRequest = null, waitForFinal = null }) {
  const results = [];
  const record = (id, pass, detail = null) => { results.push({ id, pass: pass === true, ...(detail ? { detail: String(detail).slice(0, 64) } : {}) }); return pass === true; };
  if (!acceptanceHost(intake)) { record('guard-acceptance-host', false, 'not the acceptance service'); return { pass: false, aborted: true, results }; }
  record('guard-acceptance-host', true);
  const base = new URL(intake).origin;
  const call = async (method, path, { origin = ORIGIN, body } = {}) => {
    const headers = { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) };
    const r = await fetchImpl(base + path, { method, headers, body, redirect: 'error', credentials: 'omit' });
    let json = null; try { json = await r.json(); } catch { json = null; }
    return { status: r.status, json };
  };
  const mode = await call('GET', '/v1/mode').catch(() => null);
  if (!record('guard-mode-acceptance', mode?.status === 200 && mode.json?.mode === 'acceptance', mode?.json?.mode || 'unreachable')) return { pass: false, aborted: true, results };

  const bad = await call('POST', '/v1/requests', { origin: 'https://evil.example', body: '{}' });
  record('origin-foreign-refused', bad.status === 403, bad.status);
  const none = await call('POST', '/v1/requests', { origin: null, body: '{}' });
  record('origin-missing-refused', none.status === 403, none.status);
  const junk = await call('POST', '/v1/requests', { body: '{"x":1}' });
  record('invalid-body-rejected', junk.status === 400 && junk.json?.state === 'rejected', junk.json?.code);

  const ghost = uuid();
  const nr = await call('GET', '/v1/requests/' + ghost);
  record('unknown-id-not-received', nr.json?.state === 'not-received', nr.json?.state);
  const c1 = await call('POST', '/v1/requests/' + ghost + '/close');
  record('close-unreceived', c1.json?.state === 'closed', c1.json?.state);
  const late = await call('POST', '/v1/requests', { body: JSON.stringify({ requestId: ghost, gistVersion: crypto.randomBytes(20).toString('hex') }) });
  record('late-post-after-close-rejected', late.json?.state === 'rejected', late.json?.code);
  const after = await call('GET', '/v1/requests/' + ghost);
  record('closed-stays-closed', after.json?.state === 'closed', after.json?.state);

  if (ownerRequest) {
    if (!isUuid(ownerRequest.requestId) || !/^[a-f0-9]{40}$/.test(ownerRequest.gistVersion || '')) { record('owner-request-shape', false); return { pass: false, results }; }
    const body = JSON.stringify({ requestId: ownerRequest.requestId, gistVersion: ownerRequest.gistVersion });
    const p1 = await call('POST', '/v1/requests', { body });
    record('owner-request-queued', p1.json?.state === 'queued', p1.json?.state || p1.json?.code);
    const p2 = await call('POST', '/v1/requests', { body });
    record('owner-request-duplicate', p2.json?.state === 'duplicate', p2.json?.state || p2.json?.code);
    const cl = await call('POST', '/v1/requests/' + ownerRequest.requestId + '/close');
    record('close-refused-once-queued', ['queued', 'received'].includes(cl.json?.state), cl.json?.state);
    const fin = waitForFinal ? await waitForFinal(() => call('GET', '/v1/requests/' + ownerRequest.requestId)) : await call('GET', '/v1/requests/' + ownerRequest.requestId);
    const fee = fin?.json?.fee;
    record('final-never-published', !!fee && fee.state !== 'published' && ACCEPTANCE_FINAL_CODES.includes(fee.code), fee ? fee.state + ':' + fee.code : fin?.json?.state || fin?.json?.code);
  }
  return { pass: results.every(r => r.pass), results };
}

async function main(argv) {
  const args = Object.fromEntries(argv.map(a => /^--([a-z-]+)=(.*)$/.exec(a)).filter(Boolean).map(m => [m[1], m[2]]));
  if (!args.intake) { process.stderr.write('usage: --intake=https://fee-refresh-intake-acceptance-...run.app [--request-id= --gist-version=] [--wait-seconds=]\n'); process.exit(2); }
  const ownerRequest = args['request-id'] ? { requestId: args['request-id'], gistVersion: args['gist-version'] } : null;
  const waitMs = Math.min(Number(args['wait-seconds'] || 600), 1800) * 1000;
  const waitForFinal = async get => {
    const until = Date.now() + waitMs;
    for (;;) {
      const r = await get();
      const fee = r?.json?.fee;
      if (fee && ['published', 'failed', 'blocked'].includes(fee.state)) return r;
      if (Date.now() > until) return r;
      await new Promise(res => setTimeout(res, 15_000));
    }
  };
  const out = await runAcceptance({ intake: args.intake, ownerRequest, waitForFinal });
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(out.pass ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) main(process.argv.slice(2));
