// Pure normalization only. This registry records an already reconciled cash
// proxy, not a new allocation rule, a live balance or a native cash-account type.
// Do not discover cash from names or extend this exact-ID exception at runtime.

const REGISTRY_KEYS = ['schemaVersion', 'identities'];
const IDENTITY_KEYS = ['portfolioId', 'holdingId', 'name', 'recordType', 'representation', 'currency', 'unitPrice', 'evidenceDate'];
const APPROVED_IDENTITY = Object.freeze({
  portfolioId: 1031350,
  holdingId: 26755602,
  name: '现金帐户 | OTHER Cash',
  recordType: 'holding',
  representation: 'cash_proxy',
  currency: 'USD',
  unitPrice: 1,
  evidenceDate: '2026-08-27',
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => Number.isSafeInteger(value) && value > 0;
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const normalizeName = value => typeof value === 'string' ? value.normalize('NFC').replace(/\s+/gu, ' ').trim() : null;

/** The single identity was proved by dated UBS cash postings, explicit holding
 * ID requests, executed trade IDs and read-back reconciliation. Expanding this
 * allowlist requires a reviewed source-evidence change, never a caller guess.
 * It intentionally contains no bank account number, balance or transaction sum.
 */
export function validateCashIdentityRegistry(registry) {
  const errors = [];
  if (!exactKeys(registry, REGISTRY_KEYS) || registry.schemaVersion !== 1) return ['unsupported cash-identity registry'];
  if (!Array.isArray(registry.identities) || registry.identities.length !== 1) return ['cash-identity registry must contain the one reviewed identity'];
  const entry = registry.identities[0];
  if (!exactKeys(entry, IDENTITY_KEYS)) return ['cash-identity entry has missing or unsupported fields'];
  for (const key of IDENTITY_KEYS) {
    if (entry[key] !== APPROVED_IDENTITY[key]) errors.push(`cash-identity ${key} differs from the reviewed source identity`);
  }
  return errors;
}

/** Canonical row inputs:
 * { portfolioId, holdingId, name, recordType:'holding', currency:'USD',
 *   unitPrice:1, pendingRedemption:false, isCash?:true, ...originalSourceFields }
 * Currency/price/pending status must be explicitly read from a source; the
 * caller must not synthesize them merely to satisfy this resolver. Preserve
 * original securityType/sourceSecurityType and recordType without relabeling.
 *
 * Only resolved results may supply the registered proxy's cash identity to the
 * classification audit. Unresolved results require review; in particular an
 * unchanged explicit isCash=false conflict must not be treated as a verified
 * non-cash item merely because this function refused to overwrite it.
 */
export function resolveCashIdentity(registry, holding) {
  const copy = object(holding) ? structuredClone(holding) : holding;
  const outcome = (status, reason, errors = [], evidence = null, normalized = copy) => ({ status, holding: normalized, reason, errors, evidence });
  const registryErrors = validateCashIdentityRegistry(registry);
  if (registryErrors.length) return outcome('unresolved', 'invalid_registry', registryErrors);
  if (!object(holding) || !validId(holding.portfolioId)) {
    return outcome('unresolved', 'invalid_holding', ['portfolioId and holdingId must be explicit positive safe integers']);
  }
  // Native cash accounts have their own explicit source proof and classification
  // validation. This proxy resolver neither reclassifies nor certifies them.
  if (holding.recordType === 'cash_account' && validId(holding.cashAccountId) && !Object.hasOwn(holding, 'holdingId')) {
    return outcome('not_applicable', 'native_cash_account_requires_its_own_source_proof');
  }
  if (!validId(holding.holdingId)) return outcome('unresolved', 'invalid_holding', ['portfolioId and holdingId must be explicit positive safe integers']);
  const identity = registry.identities.find(entry => entry.portfolioId === holding.portfolioId && entry.holdingId === holding.holdingId);
  if (!identity) return outcome('not_applicable', 'no_approved_identity');
  const errors = [];
  if (normalizeName(holding.name) !== identity.name) errors.push('source name does not exactly match the reviewed identity');
  if (holding.recordType !== identity.recordType || Object.hasOwn(holding, 'cashAccountId')) errors.push('cash proxy must retain holding recordType and cannot claim a native cashAccountId');
  if (holding.currency !== identity.currency) errors.push('explicit USD source currency is required');
  if (holding.unitPrice !== identity.unitPrice) errors.push('explicit source unit price of 1 is required');
  if (holding.pendingRedemption !== false) errors.push('explicit pendingRedemption=false is required; pending proceeds are not received cash');
  if (Object.hasOwn(holding, 'isCash') && holding.isCash !== true) errors.push('explicit isCash conflicts with the reviewed cash identity; never silently overwrite it');
  if (errors.length) return outcome('unresolved', 'source_identity_conflict', errors);
  const evidence = {
    registrySchemaVersion: 1,
    identityKey: `${identity.portfolioId}:holding:${identity.holdingId}`,
    representation: identity.representation,
    evidenceDate: identity.evidenceDate,
    checks: ['exact_portfolio_and_holding_ids', 'exact_normalized_source_name', 'holding_record_preserved', 'explicit_USD', 'explicit_unit_price_1', 'explicit_not_pending_redemption'],
    priorCashFlag: Object.hasOwn(holding, 'isCash') ? 'already_true' : 'absent',
    scope: 'economic_cash_identity_only_not_live_balance_or_native_cash_account',
  };
  return outcome('resolved', null, [], evidence, { ...copy, isCash: true });
}
