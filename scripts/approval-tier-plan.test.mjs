import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { approvalRegistry, classifyChanges, verifyExecutor, verifyOrdinaryChange } from './approval-tier-plan.mjs';
const before = fs.readFileSync(new URL('./xuan-ib-order-view.mjs', import.meta.url), 'utf8');
const after = before + '\nexport function trimDisplayLabel(value) { return value.trim(); }\n';
const base = 'a'.repeat(40), head = 'b'.repeat(40);
const owner = { login: 'huanwujoy-crypto', id: 283054367, type: 'User' };
const repo = { full_name: 'huanwujoy-crypto/fee-console' };
function input() {
  return { base, head, before, after,
    entries: [{ path: 'scripts/xuan-ib-order-view.mjs', status: 'M', baseMode: '100644', headMode: '100644' }],
    pr: { state: 'open', draft: false, user: owner,
      base: { repo, ref: 'main', sha: base }, head: { repo, sha: head } },
    commit: { sha: head, parents: [{ sha: base }], author: owner,
      committer: { login: 'web-flow', id: 19864447 },
      commit: { verification: { verified: true, reason: 'valid' } } } };
}
test('registered ordinary code is eligible with signed exact-head executor', () => {
  assert.equal(classifyChanges(input().entries), 'ordinary');
  assert.equal(verifyOrdinaryChange(input()), true);
  assert.equal(verifyExecutor(input()), true);
});
test('head, base, actor, signature and PR checks reject independently', () => {
  const mutations = [
    x => x.head = 'c'.repeat(40), x => x.base = 'c'.repeat(40),
    x => x.pr.draft = true, x => x.pr.state = 'closed',
    x => x.pr.body = '/require-specific-owner-approval',
    x => x.pr.user = { ...owner, id: 1 }, x => x.pr.user = { ...owner, type: 'Bot' },
    x => x.pr.head.repo = { full_name: 'attacker/fork' },
    x => x.pr.base.ref = 'other', x => x.commit.sha = base,
    x => x.commit.parents.push({ sha: head }), x => x.commit.parents[0].sha = head,
    x => x.commit.author = { ...owner, id: 1 },
    x => x.commit.committer = { login: 'web-flow', id: 1 },
    x => x.commit.commit.verification.verified = false,
    x => x.commit.commit.verification.reason = 'unknown_key',
  ];
  for (const mutate of mutations) {
    const x = structuredClone(input()); mutate(x);
    assert.equal(verifyOrdinaryChange(x), false);
  }
});
test('incomplete lists, renames, mixed changes and file modes cannot qualify', () => {
  for (const entries of [[], null, [{ ...input().entries[0], status: 'R100' }],
    [{ ...input().entries[0], path: 'scripts/daily.mjs' }],
    [{ ...input().entries[0], headMode: '120000' }],
    [...input().entries, { path: 'security/key.json' }]]) {
    assert.equal(verifyOrdinaryChange({ ...input(), entries }), false);
  }
});
test('complete registry assigns every tracked path exactly once', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const ordinary = new Set(approvalRegistry.ordinaryFiles), sensitive = new Set(approvalRegistry.sensitiveFiles);
  for (const file of tracked) assert.equal(Number(ordinary.has(file)) + Number(sensitive.has(file)), 1, file);
  assert.equal(ordinary.size, 22);
  for (const file of ['AGENTS.md', '.github/workflows/xuan-ib-policy-lock.yml',
    'security/approval-tiers.json', 'scripts/approval-tier-plan.mjs', 'scripts/daily.mjs',
    'scripts/fee-engine.mjs', 'scripts/xuan-ib-account-association.mjs',
    'scripts/xuan-ib-source-adapter.mjs', 'scripts/xuan-ib-promotion.mjs', 'index.html']) {
    assert.equal(sensitive.has(file), true, file);
  }
});
test('all registered files, not suffixes, define the delegation boundary', () => {
  for (const file of approvalRegistry.ordinaryFiles) {
    assert.equal(classifyChanges([{ ...input().entries[0], path: file }]), 'ordinary', file);
  }
  for (const file of [...approvalRegistry.sensitiveFiles, 'scripts/new-view.mjs',
    'scripts/xuan-ib-order-view.mjs.bak', '../scripts/xuan-ib-order-view.mjs',
    '.github/new.yml', 'cloud/new.mjs', 'scripts/NEW.test.mjs']) {
    assert.equal(classifyChanges([{ ...input().entries[0], path: file }]), 'specific', file);
  }
  assert.equal(classifyChanges([input().entries[0], input().entries[0]]), 'specific');
  assert.equal(classifyChanges([{ ...input().entries[0], previousPath: 'scripts/daily.mjs' }]), 'specific');
  assert.equal(classifyChanges([{ ...input().entries[0], status: 'A' }]), 'specific');
  assert.equal(classifyChanges([{ ...input().entries[0], status: 'D' }]), 'specific');
});
test('all six EOD additions remain explicitly sensitive under the unchanged classifier',()=>{
  for(const file of ['cloud/xuan-preopen/eod_report.mjs','cloud/xuan-preopen/eod_report.test.mjs','cloud/xuan-preopen/eod_sources.mjs','docs/xuan-preopen-eod-candidate.md','scripts/xuan-ib-eod-action-model.mjs','scripts/xuan-ib-eod-loader.test.mjs']){
    assert.ok(approvalRegistry.sensitiveFiles.includes(file));assert.ok(!approvalRegistry.ordinaryFiles.includes(file));
    assert.equal(classifyChanges([{...input().entries[0],path:file}]),'specific');
  }
});
test('registry corruption, conflicts and incomplete inputs fail closed', () => {
  for (const policy of [null, {}, { ...approvalRegistry, schema: 'untrusted' },
    { ...approvalRegistry, ordinaryFiles: [null] },
    { ...approvalRegistry, ordinaryFiles: [...approvalRegistry.ordinaryFiles, 'security/approval-tiers.json'] },
    { ...approvalRegistry, ordinaryFiles: [...approvalRegistry.ordinaryFiles, approvalRegistry.ordinaryFiles[0]] }]) {
    assert.equal(classifyChanges(input().entries, policy), 'specific');
  }
  for (const entries of [undefined, [], [null], Array(1001).fill(input().entries[0])]) {
    assert.equal(classifyChanges(entries), 'specific');
  }
});
test('workflow executes trusted base only and retains sensitive exact-head fallback', () => {
  const lock = fs.readFileSync(new URL('../.github/workflows/xuan-ib-policy-lock.yml', import.meta.url), 'utf8');
  assert.match(lock, /pull_request_target:/);
  assert.match(lock, /ref: \$\{\{ github.event.pull_request.base.sha \}\}/);
  assert.doesNotMatch(lock, /ref: \$\{\{ github.event.pull_request.head/);
  assert.match(lock, /steps.ordinary.outcome != 'success'/);
  assert.match(lock, /select\(\.author_association == "OWNER"\)/);
  assert.match(lock, /\.user.id == 283054367/);
  assert.match(lock, /permissions:\n  contents: read\n  issues: read\n  pull-requests: read/);
  assert.match(lock, /approval_line="\/approve-xuan-ib-maintenance \$head_sha"/);
  const definitions = lock.slice(lock.indexOf("          protected_re='"), lock.indexOf('          if jq -r'));
  for (const p of ['security/key.json', 'AGENTS.md', 'scripts/daily.mjs', 'unknown.txt']) {
    assert.equal(spawnSync('bash', ['-c', definitions + '\nprintf "%s\\n" "$1" | grep -Eq "$protected_re"', 'test', p]).status, 0);
  }
});
test('CLI checks actual complete trees and rejects a bundled policy change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-tier-'));
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
    fs.mkdirSync(path.join(dir, 'scripts')); fs.writeFileSync(path.join(dir, 'scripts/xuan-ib-order-view.mjs'), before);
    git(['add', '.']); git(['commit', '-qm', 'base']); const b = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(dir, 'scripts/xuan-ib-order-view.mjs'), after); git(['add', '.']); git(['commit', '-qm', 'font']);
    const h = git(['rev-parse', 'HEAD']); const x = input();
    x.pr.base.sha = b; x.pr.head.sha = h; x.commit.sha = h; x.commit.parents[0].sha = b;
    fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify(x.pr));
    fs.writeFileSync(path.join(dir, 'commit.json'), JSON.stringify(x.commit));
    const cli = new URL('./approval-tier-plan.mjs', import.meta.url).pathname;
    const run = sha => spawnSync(process.execPath, [cli, b, sha, 'pr.json', 'commit.json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(run(h).status, 0);
    fs.mkdirSync(path.join(dir, 'security'));
    fs.writeFileSync(path.join(dir, 'security/approval-tiers.json'), '{"approved":true}');
    git(['add', 'security/approval-tiers.json']); git(['commit', '-qm', 'bundled']);
    const badHead = git(['rev-parse', 'HEAD']); x.pr.head.sha = badHead; x.commit.sha = badHead;
    fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify(x.pr));
    fs.writeFileSync(path.join(dir, 'commit.json'), JSON.stringify(x.commit));
    assert.equal(run(badHead).status, 1);
    assert.equal(run('--all').status, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
