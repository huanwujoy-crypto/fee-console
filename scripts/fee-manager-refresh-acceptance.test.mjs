// The acceptance runner against the real intake and job, in memory only.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { runAcceptance, acceptanceHost } from './fee-manager-refresh-acceptance.mjs';
import { handleIntake, runRefreshJob, REQUEST_FILE } from './fee-manager-refresh-server.mjs';
import { createMemoryLedger, OWNER_ID, SCHEMA } from './fee-manager-refresh.mjs';

const HOST = 'https://fee-refresh-intake-acceptance-abc123-df.a.run.app';
const GIST = 'a'.repeat(32), NOW = new Date('2026-11-11T02:05:00.000Z');
const bucket = () => { const b = createMemoryLedger(); b.names = async p => (await b.list(p)).map(x => x.key); return b; };

function world({ mode = 'acceptance' } = {}) {
  const env = { queue: bucket(), status: bucket(), ledger: bucket(), gist: null, version: null, calls: [], dispatches: 0 };
  const gistHttp = async (method, url) => {
    if (method === 'POST') { env.dispatches++; throw new Error('no dispatch'); }
    if (url !== 'https://api.github.com/gists/' + GIST || !env.gist) return { status: 503, bytes: new Uint8Array() };
    return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ id: GIST, public: false, owner: { id: OWNER_ID }, history: [{ version: env.version, committed_at: '2026-11-11T02:01:00Z', user: { id: OWNER_ID } }], files: { [REQUEST_FILE]: { content: env.gist, truncated: false } } })) };
  };
  const deps = { http: gistHttp, queue: env.queue, status: env.status, gistId: GIST, now: () => NOW, runJob: async () => {}, mode };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    env.calls.push(init.method + ' ' + u.pathname);
    assert.equal(init.credentials, 'omit');
    assert.ok(!('Authorization' in (init.headers || {})));
    const r = await handleIntake({ method: init.method, path: u.pathname, headers: { origin: init.headers?.Origin }, body: init.body }, deps);
    return { status: r.status, json: async () => JSON.parse(r.body || 'null') };
  };
  const job = () => runRefreshJob({ ledger: env.ledger, queue: env.queue, status: env.status, http: gistHttp, gistId: GIST, now: () => NOW, wait: async () => {}, readToken: null, validateHealth: () => [], mode: 'acceptance' });
  return { env, fetchImpl, job };
}

test('host guard: only https://fee-refresh-intake-acceptance-*.run.app', () => {
  assert.equal(acceptanceHost(HOST), true);
  for (const u of ['https://fee-refresh-intake-abc-df.a.run.app', 'http://fee-refresh-intake-acceptance-abc-df.a.run.app', 'https://fee-refresh-intake-acceptance-abc.example.com', HOST + '/x', 'not a url'])
    assert.equal(acceptanceHost(u), false, u);
});

test('refuses a production host before sending anything', async () => {
  const w = world();
  const out = await runAcceptance({ intake: 'https://fee-refresh-intake-abc123-df.a.run.app', fetchImpl: w.fetchImpl });
  assert.equal(out.aborted, true);
  assert.equal(w.env.calls.length, 0);
});

test('refuses a service that is not in acceptance mode after one read-only mode call', async () => {
  const w = world({ mode: 'launch' });
  const out = await runAcceptance({ intake: HOST, fetchImpl: w.fetchImpl });
  assert.equal(out.aborted, true);
  assert.deepEqual(w.env.calls, ['GET /v1/mode']);
});

test('full acceptance checklist passes against the real intake and job, with zero dispatch', async () => {
  const w = world();
  const req = { schema: SCHEMA.request, requestId: crypto.randomUUID(), contents: ['fee'], feeDataDate: '2026-11-10', createdAt: '2026-11-11T02:00:00.000Z' };
  w.env.gist = JSON.stringify(req); w.env.version = 'b'.repeat(40); // written by the owner for this run
  const out = await runAcceptance({ intake: HOST, fetchImpl: w.fetchImpl, ownerRequest: { requestId: req.requestId, gistVersion: w.env.version },
    waitForFinal: async get => { await w.job(); return get(); } });
  assert.deepEqual(out.results.filter(r => !r.pass), []);
  assert.equal(out.pass, true);
  assert.deepEqual(out.results.map(r => r.id), ['guard-acceptance-host', 'guard-mode-acceptance', 'origin-foreign-refused', 'origin-missing-refused', 'invalid-body-rejected', 'unknown-id-not-received', 'close-unreceived', 'late-post-after-close-rejected', 'closed-stays-closed', 'owner-request-queued', 'owner-request-duplicate', 'close-refused-once-queued', 'final-never-published']);
  assert.equal(w.env.dispatches, 0);
});

test('a published final state fails the acceptance run', async () => {
  const w = world();
  const req = { schema: SCHEMA.request, requestId: crypto.randomUUID(), contents: ['fee'], feeDataDate: '2026-11-10', createdAt: '2026-11-11T02:00:00.000Z' };
  w.env.gist = JSON.stringify(req); w.env.version = 'c'.repeat(40);
  const out = await runAcceptance({ intake: HOST, fetchImpl: w.fetchImpl, ownerRequest: { requestId: req.requestId, gistVersion: w.env.version },
    waitForFinal: async () => ({ status: 200, json: { requestId: req.requestId, contents: ['fee'], fee: { state: 'published', code: 'PUBLISHED' }, ratio: null } }) });
  assert.equal(out.pass, false);
  assert.equal(out.results.find(r => r.id === 'final-never-published').pass, false);
});
