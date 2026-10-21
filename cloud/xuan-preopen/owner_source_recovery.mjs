// One explicit, protected registration. Importing does not read storage or run a
// source. A code merge is not runtime authorization and never resets a claim.
import {readFileSync} from 'node:fs';
import {recoveryRequestId} from './owner_bundle_contract.mjs';
export const OWNER_SOURCE_RECOVERY_PATH='security/xuan-owner-source-recovery.json';
export function registeredOwnerRecovery(){
  const value=JSON.parse(readFileSync(new URL('../../'+OWNER_SOURCE_RECOVERY_PATH,import.meta.url),'utf8'));
  const keys='schema requestId dataDate priorReceiptObject priorReceiptGeneration priorReceiptSha256'.split(' ').sort().join('|');
  if(!value||Object.keys(value).sort().join('|')!==keys||value.schema!=='xuan.owner-source-recovery.v1'
    ||recoveryRequestId(`report-check/orders-probe-${value.requestId}/preview-receipt.json`)!==value.requestId
    ||!/^\d{4}-\d\d-\d\d$/.test(value.dataDate)||!Number.isFinite(Date.parse(value.dataDate+'T00:00:00Z'))
    ||new Date(value.dataDate+'T00:00:00Z').toISOString().slice(0,10)!==value.dataDate
    ||value.priorReceiptObject!==`delivery/${value.dataDate}/receipt.json`
    ||! /^[1-9][0-9]{0,29}$/.test(value.priorReceiptGeneration)||! /^[a-f0-9]{64}$/.test(value.priorReceiptSha256))throw Error('OWNER_RECOVERY_REGISTRATION');
  return Object.freeze({...value,receiptObject:`report-check/orders-probe-${value.requestId}/preview-receipt.json`});
}
