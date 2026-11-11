// Deployment preparation checks (no network, no cloud access): the image
// contains exactly the entry point's import closure on a pinned official
// base, the plan matches ROLE_ACCESS, acceptance and production never share
// a resource or a credential, and the verification script is read-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLE_ACCESS, GCS_ROLES } from './fee-manager-refresh-server.mjs';
import { readConfig } from './fee-manager-refresh-entry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const dockerfile = read('cloud/fee-refresh/Dockerfile');
const plan = JSON.parse(read('cloud/fee-refresh/deployment-plan.json'));
const verify = read('cloud/fee-refresh/verify-readonly.sh');
const BASE = 'node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d';

function importClosure(entry) {
  const seen = new Set();
  const walk = rel => {
    if (seen.has(rel)) return; seen.add(rel);
    const src = read(rel);
    for (const m of src.matchAll(/(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']|import\(["'](\.{1,2}\/[^"']+)["']\)/g))
      walk(path.posix.join(path.posix.dirname(rel), m[1] || m[2]));
    for (const m of src.matchAll(/from\s+["']([^."'][^"']*)["']/g)) assert.ok(m[1].startsWith('node:'), rel + ' imports a non-builtin package ' + m[1]);
  };
  walk(entry);
  return [...seen].sort();
}

test('image: pinned official base, exactly the entry import closure, non-root, disabled by default', () => {
  const from = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map(m => m[1]);
  assert.deepEqual(from, [BASE]);
  assert.equal(plan.baseImage.reference, BASE);
  const at = dockerfile.search(/^COPY\s/m), end = dockerfile.indexOf('/app/scripts/', at);
  const copy = dockerfile.slice(at + 4, end).split(/[\s\\]+/).filter(Boolean).sort();
  assert.deepEqual(copy, importClosure('scripts/fee-manager-refresh-entry.mjs'));
  assert.equal((dockerfile.match(/^COPY\s/gm) || []).length, 1, 'one COPY, nothing else enters the image');
  assert.doesNotMatch(dockerfile, /^\s*(ADD|RUN)\s/m, 'no network or build-time commands');
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /FEE_REFRESH_MODE=disabled/);
  assert.equal(plan.releaseImage.digest, null, 'release digest is recorded only after a reviewed build');
});

const ENVS = ['acceptance', 'production'];
const names = env => {
  const e = plan.environments[env];
  return [...Object.values(e.buckets), e.job.name, e.service.name, ...Object.values(e.serviceAccounts)];
};

test('plan: acceptance and production share no resource and no credential', () => {
  const acc = plan.environments.acceptance, prod = plan.environments.production;
  assert.ok(Object.values(acc.buckets).every(b => b.endsWith('-acceptance')));
  assert.ok(acc.job.name.endsWith('-acceptance') && acc.service.name.endsWith('-acceptance'));
  assert.ok(Object.values(acc.serviceAccounts).every(s => s.split('@')[0].endsWith('-acc')));
  assert.ok(names('production').every(n => !/acceptance|-acc@/.test(n)));
  const a = new Set(names('acceptance'));
  assert.ok(names('production').every(n => !a.has(n)), 'disjoint');
  assert.equal(acc.githubCredential, null);
  assert.deepEqual(acc.job.secretMounts, []);
  assert.deepEqual(acc.service.secretMounts, []);
  assert.deepEqual(prod.job.secretMounts, ['githubCredential']);
  assert.deepEqual(prod.service.secretMounts, [], 'the public intake never holds the credential');
  assert.equal(prod.githubCredential.accessor, 'job');
  assert.equal(acc.mode, 'acceptance');
  assert.equal(prod.mode, 'launch');
  assert.equal(acc.service.env.FEE_REFRESH_JOB.split('/').pop(), acc.job.name);
  assert.equal(prod.service.env.FEE_REFRESH_JOB.split('/').pop(), prod.job.name);
});

test('plan: buckets carry no lifecycle and no runtime delete', () => {
  assert.equal(plan.bucketPolicy.lifecycle, null);
  assert.equal(plan.bucketPolicy.runtimeDelete, false);
  assert.equal(plan.bucketPolicy.publicAccessPrevention, 'enforced');
});

test('plan: every environment passes the entry point configuration checks for both roles', () => {
  for (const env of ENVS) {
    const e = plan.environments[env];
    const resolve = vars => Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, /_BUCKET$/.test(k) ? e.buckets[v] : k === 'FEE_REFRESH_GIST_ID' ? 'a'.repeat(32) : v]));
    const svc = resolve(e.service.env), job = resolve(e.job.env);
    assert.equal(svc.FEE_REFRESH_LEDGER_BUCKET, undefined, env + ': the intake is never given the ledger');
    assert.equal(readConfig(svc, 'serve').mode, e.mode);
    assert.equal(readConfig(job, 'job').mode, e.mode);
  }
});

test('plan IAM derived from ROLE_ACCESS: per role, per own bucket, read/create only, never cross-environment', () => {
  const bindings = [];
  for (const env of ENVS) {
    const e = plan.environments[env];
    for (const [role, buckets] of Object.entries(ROLE_ACCESS)) {
      const member = e.serviceAccounts[role === 'intake' ? 'intake' : 'job'];
      for (const [bucket, ops] of Object.entries(buckets))
        for (const r of new Set(ops.map(o => GCS_ROLES[o]))) bindings.push({ env, member, bucket: e.buckets[bucket], role: r });
    }
  }
  assert.ok(bindings.every(b => ['roles/storage.objectCreator', 'roles/storage.objectViewer'].includes(b.role)));
  for (const b of bindings) assert.ok(names(b.env).includes(b.bucket) && names(b.env).includes(b.member), 'same environment');
  for (const env of ENVS) {
    const e = plan.environments[env];
    assert.ok(!bindings.some(b => b.member === e.serviceAccounts.intake && b.bucket === e.buckets.ledger), env + ': intake has nothing on the ledger');
    assert.ok(bindings.some(b => b.member === e.serviceAccounts.job && b.bucket === e.buckets.status && b.role === 'roles/storage.objectViewer'), env + ': job reads status');
  }
  assert.equal(plan.iamPerEnvironment.jobStart.permission, 'run.jobs.run');
});

test('verification script is read-only and covers every planned resource', () => {
  const allowed = /^(iam roles describe|iam service-accounts describe|run jobs describe|run jobs get-iam-policy|run services describe|run services get-iam-policy|storage buckets describe|storage buckets get-iam-policy|secrets describe|secrets get-iam-policy)$/;
  const calls = verify.split('\n').filter(l => /\bgcloud\s/.test(l)).map(l => {
    const t = l.slice(l.indexOf('gcloud') + 6).trim().split(/\s+/), out = [];
    for (const w of t) { out.push(w); if (w === 'describe' || w === 'get-iam-policy') break; if (out.length > 4) break; }
    return out.join(' ');
  });
  assert.ok(calls.length >= 10);
  for (const c of calls) assert.match(c, allowed, c);
  const code = verify.split('\n').filter(l => !/^\s*#/.test(l)).join('\n'); // commands, not comments
  assert.doesNotMatch(code, /versions\s+access|\bcreate\b|\bdelete\b|\bupdate\b|\bdeploy\b|\bexecute\b|add-iam|remove-iam|set-iam|\bcp\b|\bcat\b|\bcurl\b/);
  const expanded = env => env === 'acceptance' ? { suffix: '-acceptance', sa: '-acc' } : { suffix: '', sa: '' };
  for (const env of ENVS) {
    const { suffix, sa } = expanded(env), e = plan.environments[env];
    for (const b of Object.values(e.buckets)) assert.equal(b, b.replace(/-(queue|ledger|status)(-acceptance)?$/, (x, k) => '-' + k + suffix));
    assert.equal(e.job.name, 'fee-refresh-launch' + suffix);
    assert.equal(e.service.name, 'fee-refresh-intake' + suffix);
    assert.equal(e.serviceAccounts.intake.split('@')[0], 'fee-refresh-intake' + sa);
    assert.equal(e.serviceAccounts.job.split('@')[0], 'fee-refresh-launch' + sa);
  }
  assert.match(verify, /fee-refresh-\$\{b\}\$\{suffix\}/);
  assert.match(verify, /secrets describe fee-refresh-github-actions/);
});
