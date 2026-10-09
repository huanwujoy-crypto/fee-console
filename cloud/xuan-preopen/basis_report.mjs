import {planPreopen} from './calendar.mjs';
// Phase-one injected preparation only. Not wired to daily, CLI, cloud_io,
// environment modes or production publication. Both producers are mandatory.
import {buildBasisModel} from '../../scripts/xuan-ib-night-action-basis.mjs';
import {bindPublicationEvidence,verifyBoundPublication} from '../../scripts/xuan-ib-night-action-evidence.mjs';
import {renderNightActionReport} from '../../scripts/xuan-ib-night-action-view.mjs';
import {createAssociationReceipt,validateAssociationSnapshot} from '../../scripts/xuan-ib-account-association.mjs';
import crypto from 'node:crypto';
export async function prepareBasisReport({enabled=false,produceCash,produceSharesight,verifyCashProof,loadContext,sourceDate,now=Date.now}={}) {
  if(enabled!==true)throw new Error('BASIS_MODE_DISABLED');
  if(typeof produceCash!=='function'||typeof produceSharesight!=='function'||typeof verifyCashProof!=='function'||typeof loadContext!=='function')throw new Error('BASIS_INJECTED_PRODUCERS_REQUIRED');
  const started=now(),plan=planPreopen(started);
  if(plan.status!=='generate')throw new Error('BASIS_REPORT_DAY_NOT_ELIGIBLE');
  if(sourceDate!==plan.sourceDate)throw new Error('BASIS_SOURCE_DATE_NOT_TARGET');
  const dataDate=plan.dataDate;
  const context=await loadContext();
  validateAssociationSnapshot(context.association,{now:now(),edition:'am'});
  const association=createAssociationReceipt(context.association,{now:now(),edition:'am',previousSourceSha:context.previousSourceSha,runId:crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex')});
  // Capture starts after the pre-read association lookup, like the source contract.
  const captureStarted=now();
  let cash,sharesight;
  try {[cash,sharesight]=await Promise.all([produceCash(),produceSharesight()]);}
  catch {throw new Error('BASIS_SOURCE_FAILED');}
  const completed=now();
  if(new Date(completed+28800000).toISOString().slice(0,10)!==dataDate)throw new Error('BASIS_CROSSED_DATE');
  if(cash?.sourceKey!=='flex.cash'||sharesight?.length!==2||sharesight.filter(s=>s.sourceKey==='sharesight.ibGroupedPerformance').length!==1||sharesight.filter(s=>s.sourceKey==='sharesight.noahPerformance').length!==1)throw new Error('BASIS_SOURCES_INCOMPLETE');
  if(cash.startedAt!==cash.raw?.capture?.startedAt||cash.completedAt!==cash.raw?.capture?.completedAt)throw new Error('BASIS_CASH_CAPTURE_BINDING');
  const allocation=sharesight.find(s=>s.sourceKey==='sharesight.ibGroupedPerformance'),noah=sharesight.find(s=>s.sourceKey==='sharesight.noahPerformance');
  const report=buildBasisModel({dataDate,sourceDate,flexCash:cash.raw,ibGroupedPerformance:allocation.raw,noahPerformance:noah.raw,
    sharesightAcquiredAt:allocation.completedAt,noahAcquiredAt:noah.completedAt,now:completed,association,verifyProof:verifyCashProof});
  const bound=bindPublicationEvidence(report,{sources:[cash,...sharesight],startedAt:new Date(captureStarted).toISOString(),completedAt:new Date(completed).toISOString(),sourceDate,association,associationExpiresAt:context.association.policy.expiresAt,previousSourceSha:context.previousSourceSha});
  const current=await loadContext();
  verifyBoundPublication(bound,{snapshot:current.association,previousSourceSha:current.previousSourceSha,now:now(),allowBasis:true});
  return {html:renderNightActionReport(bound),evidence:bound.evidence,status:'basis',publication:'none',scheduler:'none',elapsedMs:completed-started};
}
