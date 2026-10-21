// One explicit, protected registration. Importing does not read storage or run a
// source. A code merge is not runtime authorization and never resets a claim.
import {readFileSync} from 'node:fs';
import {recoveryRequestId} from './owner_bundle_contract.mjs';
export const OWNER_SOURCE_RECOVERY_PATH='security/xuan-owner-source-recovery.json';
export function registeredOwnerRecovery(){
  const value=JSON.parse(readFileSync(new URL('../../'+OWNER_SOURCE_RECOVERY_PATH,import.meta.url),'utf8'));
  const keys=('schema requestId dataDate priorReceiptObject priorReceiptGeneration priorReceiptSha256'+(Object.hasOwn(value??{},'referenceCapture')?' referenceCapture':'')+(Object.hasOwn(value??{},'supersedes')?' supersedes':'')+(Object.hasOwn(value??{},'continuation')?' continuation':'')).split(' ').sort().join('|');
  if(!value||Object.keys(value).sort().join('|')!==keys||value.schema!=='xuan.owner-source-recovery.v1'
    ||recoveryRequestId(`report-check/orders-probe-${value.requestId}/preview-receipt.json`)!==value.requestId
    ||!/^\d{4}-\d\d-\d\d$/.test(value.dataDate)||!Number.isFinite(Date.parse(value.dataDate+'T00:00:00Z'))
    ||new Date(value.dataDate+'T00:00:00Z').toISOString().slice(0,10)!==value.dataDate
    ||value.priorReceiptObject!==`delivery/${value.dataDate}/receipt.json`
    ||! /^[1-9][0-9]{0,29}$/.test(value.priorReceiptGeneration)||! /^[a-f0-9]{64}$/.test(value.priorReceiptSha256))throw Error('OWNER_RECOVERY_REGISTRATION');
  if(value.referenceCapture){
    const r=value.referenceCapture,keys='schema captureStartedAt captureCompletedAt expiresAt sourceHashes'.split(' ').sort().join('|');
    if(Object.keys(r).sort().join('|')!==keys||r.schema!=='xuan.registered-reference-capture.v1'
      ||![r.captureStartedAt,r.captureCompletedAt,r.expiresAt].every(t=>typeof t==='string'&&Number.isFinite(Date.parse(t))&&new Date(t).toISOString()===t)
      ||r.captureCompletedAt<r.captureStartedAt||Date.parse(r.captureCompletedAt)-Date.parse(r.captureStartedAt)>300000
      ||r.expiresAt<=r.captureCompletedAt||new Date(Date.parse(r.captureStartedAt)+28800000).toISOString().slice(0,10)!==value.dataDate
      ||r.expiresAt!==value.dataDate+'T15:59:59.999Z'||Object.keys(r.sourceHashes??{}).sort().join('|')!=='ib.orders|sharesight.ibGroupedPerformance|sharesight.noahPerformance'
      ||Object.values(r.sourceHashes).some(h=>! /^[a-f0-9]{64}$/.test(h)))throw Error('OWNER_RECOVERY_REFERENCE_REGISTRATION');
  }
  if(value.supersedes){
    const s=value.supersedes;
    if(!value.referenceCapture||Object.keys(s).sort().join('|')!=='artifactSha256|latestGeneration|receiptSha256|requestId'
      ||s.requestId===value.requestId||recoveryRequestId(`report-check/orders-probe-${s.requestId}/preview-receipt.json`)!==s.requestId
      ||![s.artifactSha256,s.receiptSha256].every(h=>/^[a-f0-9]{64}$/.test(h))||! /^[1-9][0-9]{0,29}$/.test(s.latestGeneration))throw Error('OWNER_RECOVERY_SUPERSEDES');
  }
  if(value.continuation)validateEvidenceContinuation(value);
  return Object.freeze({...value,receiptObject:`report-check/orders-probe-${value.requestId}/preview-receipt.json`});
}

// A bounded exception for one protected request and one pinned capture only.
// Source hashes are checked again before creation and independent admission.
export function registeredReferenceCapture(requestId,captureStartedAt,captureCompletedAt){
  const r=registeredOwnerRecovery();return (r.requestId===requestId||r.supersedes?.requestId===requestId)&&r.referenceCapture?.captureStartedAt===captureStartedAt
    &&r.referenceCapture.captureCompletedAt===captureCompletedAt?r.referenceCapture:null;
}
export function ownerCaptureDeadline(requestId,start,end){
  return Date.parse(registeredReferenceCapture(requestId,start,end)?.expiresAt??'')||Date.parse(start)+1800000;
}
export function validateReferenceSources(reference,values){
  if(!reference)return;
  const hashes={'sharesight.ibGroupedPerformance':values['sharesight.ibGroupedPerformance']?.rawFingerprint,
    'sharesight.noahPerformance':values['sharesight.noahPerformance']?.rawFingerprint,
    'ib.orders':values['ib.optionalLive']?.sources?.[0]?.rawFingerprint};
  if(Object.keys(hashes).some(k=>hashes[k]!==reference.sourceHashes[k]))throw Error('OWNER_RECOVERY_REFERENCE_SOURCE_BINDING');
}

// Exact prior generation/artifact only. This is a protected correction request,
// not a general permission to replace changed results with identical source times.
export function registeredReferenceReplacement(candidate,current,generation){
  const r=registeredOwnerRecovery(),s=r.supersedes;
  return !!s&&recoveryRequestId(candidate.receiptObject)===r.requestId
    &&recoveryRequestId(current.receiptObject)===s.requestId&&generation===s.latestGeneration
    &&current.artifactSha256===s.artifactSha256&&current.receiptSha256===s.receiptSha256
    &&candidate.dataDate===r.dataDate&&candidate.completedAt>current.completedAt
    &&!!registeredReferenceCapture(r.requestId,candidate.captureStartedAt,candidate.captureEndedAt);
}

// One existing immutable attempt only; no caller-selected paths or reset budget.
export function validateEvidenceContinuation(registration){
  const c=registration.continuation,r=registration.referenceCapture;
  const fail=()=>{throw Error('OWNER_RECOVERY_CONTINUATION');};
  if(!c||!r||Object.keys(c).sort().join('|')!=='claimGeneration|maximumBytes|maximumObjects|objects|runId|schema'
    ||c.schema!=='xuan.evidence-continuation.v1'||! /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(c.runId)
    ||! /^[1-9][0-9]{0,29}$/.test(c.claimGeneration)||c.maximumObjects!==9||c.maximumBytes!==33554432||c.objects?.length!==5)fail();
  const prefix=`report-check/${r.captureStartedAt}-${c.runId}/`,names=['ib.flexEod.json','sharesight.ibGroupedPerformance.json','sharesight.noahPerformance.json','ib.optionalLive.json','report.html'];
  for(const [i,p] of c.objects.entries())if(Object.keys(p).sort().join('|')!=='generation|name|sha256|size'||p.name!==prefix+names[i]
    ||! /^[1-9][0-9]{0,29}$/.test(p.generation)||! /^[a-f0-9]{64}$/.test(p.sha256)||!Number.isSafeInteger(p.size)||p.size<1||p.size>4*1024*1024)fail();
  if(c.objects.reduce((n,p)=>n+p.size,4096)>c.maximumBytes)fail();
  return c;
}
