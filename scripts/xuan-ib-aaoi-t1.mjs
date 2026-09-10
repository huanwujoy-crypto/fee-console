// Owner-approved measurement only. Never reads or writes a financial account.
// The generic delegated-tier reader owns the policy, coefficient whitelist and
// identity rules; this wrapper only pins AAOI's approval and keeps the original
// result keys, so the approved 2026-09-05 snapshot correction stays byte-exact.
import {calculateDelegatedTier} from './xuan-ib-delegated-tier.mjs';
export const AAOI_APPROVAL_ID='WU-20260906-AAOI-T1';
export function calculateAaoiT1(input) {
  const {approvalId,tier,valueDate,marketValueUsd,low,mid,high,notifyId}=
    calculateDelegatedTier(input,{approvalId:AAOI_APPROVAL_ID});
  return {approvalId,tier,valueDate,marketValueUsd,low,mid,high,notifyId};
}
