// Synthetic offline unit-test data only; never an operational policy lookup.
import crypto from 'node:crypto';

// Return a fresh fixed value, independent of whether the deployed policy is
// inactive, active, expired or revoked. No deployment file is read here.
export function inactiveAssociationPolicy() {
  return {
    accountAlias:'IB-HK', basis:'owner-attested-recurring-v1', editions:['adhoc'],
    expiresAt:null, policyId:'ib-primary-7day-pilot-v1',
    publisher:'claude-verified-candidate-v1', purpose:'xuan-ib-read-only-report',
    schemaVersion:1, status:'inactive', validFrom:null
  };
}

export function inactiveAssociationSnapshot(now=Date.now()) {
  const policy=inactiveAssociationPolicy();
  const raw=Buffer.from(`${JSON.stringify(policy,null,2)}\n`);
  return {policy,policyCommit:'a'.repeat(40),policyBlob:crypto.createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex'),checkedAt:new Date(now).toISOString()};
}
