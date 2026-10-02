import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnoseDefaultScope } from './account_scope_diagnostic.mjs';
const approved = 'fixture-approved';
test('missing, invalid, empty, multiple, mismatched and valid scope branches remain distinguishable', () => {
  for (const [data, reason] of [
    [null, 'RESPONSE_OBJECT_REQUIRED'],
    [{ accounts: {} }, 'INCLUDED_ACCOUNTS_ARRAY_MISSING'],
    [{ included_accounts: [42] }, 'INCLUDED_ACCOUNT_IDENTIFIER_TYPE_INVALID'],
    [{ included_accounts: [] }, 'INCLUDED_ACCOUNTS_EMPTY'],
    [{ included_accounts: [approved, 'fixture-other'] }, 'INCLUDED_ACCOUNTS_NOT_SINGLE'],
    [{ included_accounts: ['fixture-other'] }, 'APPROVED_ACCOUNT_NOT_MATCHED'],
    [{ included_accounts: [approved] }, 'ACCOUNTS_OBJECT_MISSING'],
    [{ included_accounts: [approved], accounts: {} }, 'SINGLE_APPROVED_IDENTIFIER_OBSERVED'],
  ]) assert.equal(diagnoseDefaultScope(data, approved).reason, reason);
});
test('duplicate array entries and malformed accounts cannot imply unique default scope', () => {
  assert.equal(diagnoseDefaultScope({ included_accounts: [approved, approved], accounts: {} }, approved).unique, false);
  for (const accounts of [null, [], 'private-value'])
    assert.equal(diagnoseDefaultScope({ included_accounts: [approved], accounts }, approved).accountsObject, false);
});
test('diagnostics expose only booleans/counts/fixed codes, never identifier keys or financial values', () => {
  const data = { included_accounts: [approved], accounts: { [approved]: { balance: 'private-money' } }, privateField: 'secret' };
  const result = diagnoseDefaultScope(data, approved), serialized = JSON.stringify(result);
  for (const value of [approved, 'private-money', 'privateField', 'secret']) assert.equal(serialized.includes(value), false);
  assert.equal(result.accountsContainsApproved, true);
  assert.equal(result.accountsKeyCount, 1);
  assert.equal(result.sourceIdentityVerified, false);
  assert.deepEqual(data.accounts[approved], { balance: 'private-money' });
});
