import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const validate = fs.readFileSync('.github/workflows/validate-xuan-ib-handover.yml', 'utf8');
const promote = fs.readFileSync('.github/workflows/promote-xuan-ib-handover.yml', 'utf8');

test('candidate validation loads and dispatches to the trusted action-page guard', () => {
  assert.match(validate, /scripts\/xuan-ib-night-action-view\.mjs/);
  assert.match(validate, /scripts\/xuan-ib-night-action-guard\.mjs/);
  assert.match(validate, /grep -Fq '<!-- xuan-ib-night-action-v1:'/);
  assert.match(validate, /xuan-ib-trusted\/scripts\/xuan-ib-night-action-guard\.mjs/);
});

test('promotion validates action pages both before selection and before publication', () => {
  assert.equal((promote.match(/grep -Fq '<!-- xuan-ib-night-action-v1:'/g) || []).length, 2);
  assert.equal((promote.match(/node scripts\/xuan-ib-night-action-guard\.mjs/g) || []).length, 2);
  assert.match(promote, /node scripts\/xuan-ib-sleep-priority\.mjs classify/);
});
