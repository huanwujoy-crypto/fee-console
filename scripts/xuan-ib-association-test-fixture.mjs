// Synthetic offline unit-test data only; never an operational policy lookup.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export function inactiveAssociationSnapshot(now=Date.now()) {
  const raw=fs.readFileSync(fileURLToPath(new URL('../claude/xuan-ib-account-association-v1.json',import.meta.url)));
  const policy=JSON.parse(raw);
  if(policy.status!=='inactive'||policy.validFrom!==null||policy.expiresAt!==null)throw new Error('synthetic fixture requires unactivated default policy');
  return {policy,policyCommit:'a'.repeat(40),policyBlob:crypto.createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex'),checkedAt:new Date(now).toISOString()};
}
