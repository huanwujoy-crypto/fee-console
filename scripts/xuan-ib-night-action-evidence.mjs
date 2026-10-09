import {hktDate,planPreopen} from './xuan-ib-preopen-calendar.mjs';
// Pure publication evidence. No credentials, network, account values or policy writes.
import crypto from 'node:crypto';
import {validateAssociationReceiptShape, validateAssociationReceipt} from './xuan-ib-account-association.mjs';
const fail = code => {throw new Error(`Night action evidence: ${code}`);};
export const sourceHash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const date = value => typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
export function validatePublicationEvidence(evidence) {
  if (!exact(evidence,['schemaVersion','captureStartedAt','captureCompletedAt','sourceDate','previousSourceSha','association','associationExpiresAt','sources','sourceHash','reportHash']) || evidence.schemaVersion !== 1
    || !instant(evidence.associationExpiresAt) || !instant(evidence.captureStartedAt) || !instant(evidence.captureCompletedAt)
    || !date(evidence.sourceDate) || !/^[a-f0-9]{40}$/.test(evidence.previousSourceSha)
    || !/^[a-f0-9]{64}$/.test(evidence.reportHash) || !Array.isArray(evidence.sources) || evidence.sources.length < 2 || evidence.sources.length > 5) fail('SHAPE');
  validateAssociationReceiptShape(evidence.association,{edition:'am',previousSourceSha:evidence.previousSourceSha});
  const seen = new Set();
  for (const source of evidence.sources) {
    if(!exact(source,['sourceKey','rawHash','startedAt','completedAt']) || !/^(ib\.(accountSummary|positions|orders)|sharesight\.(ibGroupedPerformance|noahPerformance)|flex\.cash)$/.test(source.sourceKey)
      || seen.has(source.sourceKey) || !/^[a-f0-9]{64}$/.test(source.rawHash) || !instant(source.startedAt) || !instant(source.completedAt)
      || Date.parse(source.startedAt)<Date.parse(evidence.captureStartedAt) || Date.parse(source.completedAt)<Date.parse(source.startedAt)
      || Date.parse(source.completedAt)>Date.parse(evidence.captureCompletedAt))fail('SOURCE_INTERVAL');
    seen.add(source.sourceKey);
  }
  if(evidence.sourceHash!==sourceHash(evidence.sources))fail('SOURCE_HASH');
  return evidence;
}
export function bindPublicationEvidence(report,{sources,startedAt,completedAt,sourceDate,association,associationExpiresAt,previousSourceSha}) {
  const safeSources=sources.map(s=>({sourceKey:s.sourceKey,rawHash:sourceHash(s.raw),startedAt:s.startedAt,completedAt:s.completedAt}));
  const evidence={schemaVersion:1,captureStartedAt:startedAt,captureCompletedAt:completedAt,sourceDate,previousSourceSha,association,associationExpiresAt,
    sources:safeSources,sourceHash:sourceHash(safeSources),reportHash:sourceHash(report)};
  validatePublicationEvidence(evidence);
  return {schemaVersion:10,dataDate:report.dataDate,status:report.status,report,evidence};
}
export function validateBoundReport(model) {
  if(!exact(model,['schemaVersion','dataDate','status','report','evidence']) || model.schemaVersion!==10
    || !date(model.dataDate) || ![5,9].includes(model.report?.schemaVersion) || model.dataDate!==model.report.dataDate || model.status!==model.report.status)fail('BOUND_SHAPE');
  validatePublicationEvidence(model.evidence);
  if(model.evidence.reportHash!==sourceHash(model.report))fail('REPORT_HASH');
  const e=model.evidence;
  if(hktDate(Date.parse(e.captureStartedAt))!==model.dataDate || hktDate(Date.parse(e.captureCompletedAt))!==model.dataDate)fail('CAPTURE_REPORT_DAY_BINDING');
  // Use the same reviewed calendar as preparation, independently at each final
  // guard call. No candidate-supplied target day, cache or weekday inference.
  const target=planPreopen(Date.parse(e.captureStartedAt));
  if(target.status!=='generate' || target.dataDate!==model.dataDate || target.sourceDate!==e.sourceDate)fail('SOURCE_DATE_NOT_CALENDAR_TARGET');
  if(model.report.schemaVersion===9){
    if(model.report.sourceDate!==e.sourceDate || model.report.cash?.coverageDate!==e.sourceDate || model.report.noahCash?.valuationDate!==e.sourceDate)fail('VISIBLE_SOURCE_DATE_BINDING');
    const completed=key=>e.sources.find(s=>s.sourceKey===key)?.completedAt;
    if(model.report.cash?.acquiredAt!==completed('flex.cash') || model.report.sharesightAcquiredAt!==completed('sharesight.ibGroupedPerformance') || model.report.noahCash?.acquiredAt!==completed('sharesight.noahPerformance'))fail('VISIBLE_ACQUISITION_BINDING');
  }else if(!model.report.asOfHkt?.startsWith(`${model.dataDate} `) || !model.report.asOfHkt?.endsWith(`数据至 ${e.sourceDate}`))fail('SOURCE_DATE_BINDING');
  const keys=model.evidence.sources.map(s=>s.sourceKey).sort().join('|');
  const required=model.report.schemaVersion===9?['flex.cash','sharesight.ibGroupedPerformance','sharesight.noahPerformance']:['ib.accountSummary','ib.positions','ib.orders','sharesight.ibGroupedPerformance','sharesight.noahPerformance'];
  if(keys!==required.sort().join('|') || model.report.schemaVersion===5 && model.status!=='ready')fail('CAPABILITIES');
  return model;
}
export function verifyBoundPublication(model,{snapshot,previousSourceSha,now=Date.now(),allowBasis=false}={}) {
  validateBoundReport(model);
  if(model.report.schemaVersion===9 && !allowBasis)fail('BASIS_MODE_DISABLED');
  const e=model.evidence,started=Date.parse(e.captureStartedAt),completed=Date.parse(e.captureCompletedAt);
  if(completed<started || completed>now || completed-started>300000 || now-started>1800000
    || Date.parse(e.association.policyCheckedAt)>started)fail('CAPTURE_STALE');
  if(!snapshot || previousSourceSha!==e.previousSourceSha || snapshot.policy.expiresAt!==e.associationExpiresAt)fail('CURRENT_CONTEXT_REQUIRED');
  validateAssociationReceipt(e.association,snapshot,{now,edition:'am',previousSourceSha,runId:e.association.runId});
  return model;
}
