// Offline diagnostic only. Never return identifiers or financial values, and
// never promote a matching field into verified source identity by itself.
export function diagnoseDefaultScope(data, approvedIdentifier) {
  if (typeof approvedIdentifier !== 'string' || !approvedIdentifier)
    throw new Error('SCOPE_APPROVED_IDENTIFIER_REQUIRED');
  const object = data !== null && typeof data === 'object' && !Array.isArray(data);
  const included = object ? data.included_accounts : undefined;
  const accounts = object ? data.accounts : undefined;
  const includedArray = Array.isArray(included);
  const identifiersValid = includedArray && included.every(value => typeof value === 'string' && value.length > 0);
  const count = includedArray ? included.length : null;
  const unique = identifiersValid && count === 1;
  const matches = unique && included[0] === approvedIdentifier;
  const accountsObject = accounts !== null && typeof accounts === 'object' && !Array.isArray(accounts);
  const reason = !object ? 'RESPONSE_OBJECT_REQUIRED'
    : !includedArray ? 'INCLUDED_ACCOUNTS_ARRAY_MISSING'
      : !identifiersValid ? 'INCLUDED_ACCOUNT_IDENTIFIER_TYPE_INVALID'
        : count === 0 ? 'INCLUDED_ACCOUNTS_EMPTY'
          : !unique ? 'INCLUDED_ACCOUNTS_NOT_SINGLE'
            : !matches ? 'APPROVED_ACCOUNT_NOT_MATCHED'
              : !accountsObject ? 'ACCOUNTS_OBJECT_MISSING' : 'SINGLE_APPROVED_IDENTIFIER_OBSERVED';
  return {
    reason, responseObject: object, includedAccountsPresent: object && Object.hasOwn(data, 'included_accounts'),
    includedAccountsArray: includedArray, includedAccountCount: count, identifiersValid, unique,
    approvedAccountMatches: matches, accountsPresent: object && Object.hasOwn(data, 'accounts'),
    accountsObject, accountsKeyCount: accountsObject ? Object.keys(accounts).length : null,
    accountsContainsApproved: accountsObject && Object.hasOwn(accounts, approvedIdentifier),
    sourceIdentityVerified: false,
  };
}
