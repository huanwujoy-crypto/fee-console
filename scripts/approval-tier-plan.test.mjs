import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { ordinaryTypography, verifyExecutor, verifyOrdinaryChange } from './approval-tier-plan.mjs';
const before = fs.readFileSync(new URL('../xuan-ib/index.html', import.meta.url), 'utf8');
const after = before.replace('font-size: 18px;', 'font-size: 19px;');
const base = 'a'.repeat(40), head = 'b'.repeat(40);
const owner = { login: 'huanwujoy-crypto', id: 283054367, type: 'User' };
const repo = { full_name: 'huanwujoy-crypto/fee-console' };
function input() {
  return { base, head, before, after,
    entries: [{ path: 'xuan-ib/index.html', status: 'M', baseMode: '100644', headMode: '100644' }],
    pr: { state: 'open', draft: false, user: owner,
      base: { repo, ref: 'main', sha: base }, head: { repo, sha: head } },
    commit: { sha: head, parents: [{ sha: base }], author: owner,
      committer: { login: 'web-flow', id: 19864447 },
      commit: { verification: { verified: true, reason: 'valid' } } } };
}
test('real loader typography is eligible with signed exact-head executor', () => {
  assert.equal(ordinaryTypography(before, after), true);
  assert.equal(verifyOrdinaryChange(input()), true);
  assert.equal(verifyExecutor(input()), true);
});
test('head, base, actor, signature and PR checks reject independently', () => {
  const mutations = [
    x => x.head = 'c'.repeat(40), x => x.base = 'c'.repeat(40),
    x => x.pr.draft = true, x => x.pr.state = 'closed',
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
test('only integer font sizes in range may change; all other bytes stay identical', () => {
  for (const changed of [before, after + '\n',
    before.replace('font-size: 18px;', 'font-size: 0px;'),
    before.replace('font-size: 18px;', 'font-size: 25px;'),
    before.replace('font-size: 18px;', 'font-size: 13.5px;'),
    before.replace('font-size: 18px;', 'font-size: 19px!important;'),
    after.replace('color: #111;', 'color: transparent;'),
    after.replace('min-height: 64px;', 'min-height: 0px;'),
    after.replace('font-size: 12px;', 'font-size: 12px; display:none;'),
    after.replace('latest.meta.json', 'evil.meta.json'),
    after.replace('font-size:14px;', 'font-size:14px; background:url(https://evil.example);'),
    after.replace('<body>', '<body onload="fetch(\'https://evil.example\')">'),
    after.replace('.title strong', '#warning'),
    after.replace('18px', '19px') + '\0']) {
    assert.equal(ordinaryTypography(before, changed), false);
  }
});
test('comments, CSS strings and scripts cannot masquerade as style declarations', () => {
  const html = '<head>\n  <style>/* { font-size: 18px; */ .a { content:"; font-size: 18px;"; font-size: 18px; }\n  </style></head><script>"; font-size: 18px;"</script>';
  assert.equal(ordinaryTypography(html, html.replace('/* { font-size: 18px;', '/* { font-size: 19px;')), false);
  assert.equal(ordinaryTypography(html, html.replace('content:"; font-size: 18px;', 'content:"; font-size: 19px;')), false);
  assert.equal(ordinaryTypography(html, html.replace('</head><script>"; font-size: 18px;', '</head><script>"; font-size: 19px;')), false);
  assert.equal(ordinaryTypography(html, html.replace('; font-size: 18px; }', '; font-size: 19px; }')), true);
});
test('workflow executes trusted base only and retains sensitive exact-head fallback', () => {
  const lock = fs.readFileSync(new URL('../.github/workflows/xuan-ib-policy-lock.yml', import.meta.url), 'utf8');
  assert.match(lock, /pull_request_target:/);
  assert.match(lock, /ref: \$\{\{ github.event.pull_request.base.sha \}\}/);
  assert.doesNotMatch(lock, /ref: \$\{\{ github.event.pull_request.head/);
  assert.match(lock, /steps.ordinary.outcome != 'success'/);
  assert.match(lock, /select\(\.author_association == "OWNER"\)/);
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
    fs.mkdirSync(path.join(dir, 'xuan-ib')); fs.writeFileSync(path.join(dir, 'xuan-ib/index.html'), before);
    git(['add', '.']); git(['commit', '-qm', 'base']); const b = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(dir, 'xuan-ib/index.html'), after); git(['add', '.']); git(['commit', '-qm', 'font']);
    const h = git(['rev-parse', 'HEAD']); const x = input();
    x.pr.base.sha = b; x.pr.head.sha = h; x.commit.sha = h; x.commit.parents[0].sha = b;
    fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify(x.pr));
    fs.writeFileSync(path.join(dir, 'commit.json'), JSON.stringify(x.commit));
    const cli = new URL('./approval-tier-plan.mjs', import.meta.url).pathname;
    const run = sha => spawnSync(process.execPath, [cli, b, sha, 'pr.json', 'commit.json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(run(h).status, 0);
    fs.writeFileSync(path.join(dir, 'security-policy.json'), '{"approved":true}');
    git(['add', 'security-policy.json']); git(['commit', '-qm', 'bundled']);
    const badHead = git(['rev-parse', 'HEAD']); x.pr.head.sha = badHead; x.commit.sha = badHead;
    fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify(x.pr));
    fs.writeFileSync(path.join(dir, 'commit.json'), JSON.stringify(x.commit));
    assert.equal(run(badHead).status, 1);
    assert.equal(run('--all').status, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
