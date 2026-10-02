import test from 'node:test';
import assert from 'node:assert/strict';
import { planApproval } from './approval-tier-plan.mjs';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

test('trusted lock protects the planner, policy and rename sources', () => {
  const lock = fs.readFileSync(new URL('../.github/workflows/xuan-ib-policy-lock.yml', import.meta.url), 'utf8');
  const definitions = lock.slice(lock.indexOf("          protected_re='"), lock.indexOf('          if jq -r'));
  for (const p of ['security/key.json', 'AGENTS.md', 'docs/approval-tiers.md',
    'scripts/approval-tier-plan.mjs', 'scripts/approval-tier-plan.test.mjs']) {
    const result = spawnSync('bash', ['-c', definitions + '\nprintf "%s\\n" "$1" | grep -Eq "$protected_re"', 'policy-test', p]);
    assert.equal(result.status, 0, p);
  }
  assert.match(lock, /\.previous_filename \/\/ empty/);
  assert.match(lock, /select\(\.author_association == "OWNER"\)/);
  assert.match(lock, /approval_line="\/approve-xuan-ib-maintenance \$head_sha"/);
});

test('ordinary display code is advisory and cannot approve a head', () => {
  const result = planApproval([{ filename: 'scripts/xuan-ib-order-view.mjs', approved: true }]);
  assert.equal(result.tier, 'ordinary-code-review');
  assert.equal(result.humanAuthentication, 'unavailable');
  assert.equal(result.enforcement, 'existing-owner-comment-and-exact-head');
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.approved, undefined);
});
test('sensitive and unknown paths never become ordinary', () => {
  for (const filename of ['.github/workflows/xuan-ib-policy-lock.yml', 'security/key.json',
    'AGENTS.md', 'scripts/daily.mjs', 'claude/xuan-ib-account-association-v1.json',
    'data.json', 'index.html', 'docs/approval-tiers.md', 'unknown.txt']) {
    assert.equal(planApproval([{ filename }]).tier, 'specific-confirmation');
  }
});
test('renames and mixed changes retain the highest review tier', () => {
  assert.equal(planApproval([{ filename: 'scripts/xuan-ib-order-view.mjs',
    previous_filename: 'security/key.json' }]).tier, 'specific-confirmation');
  assert.equal(planApproval([{ filename: 'scripts/xuan-ib-order-view.mjs' },
    { filename: 'scripts/daily.mjs' }]).tier, 'specific-confirmation');
});
test('missing, oversized and malformed lists fail closed', () => {
  for (const input of [null, [], Array(1001).fill({ filename: 'x' }), [{}],
    [{ filename: '../security/key.json' }], [{ filename: '/tmp/a' }],
    [{ filename: 'a\nb' }], [{ filename: 'x', previous_filename: null }]]) {
    assert.throws(() => planApproval(input));
  }
});
