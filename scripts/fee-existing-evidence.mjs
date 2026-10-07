import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
// Read-only schema adapter for existing evidence. It NEVER issues v2 COMPLETE.
// V1 readback and a human-facing close summary are hints, not scoped scan proof.
const count=x=>Number.isSafeInteger(x)&&x>=0;
const safeStatuses=new Set(['VERIFIED','DUPLICATE','REVIEW_REQUIRED','UNKNOWN','PARTIAL','SUBMITTED','SUPERVISED_REVIEW','PLANNED']);
export function observeExistingFeeEvidence({broker,targetDate,summary,manual,receipt,journal,state}={}){
 if(!['schwab','webull'].includes(broker)||!/^\d{4}-\d{2}-\d{2}$/.test(targetDate||''))throw Error('FEE_EXISTING_SCOPE');
 const reasons=new Set(['TARGET_SCOPED_SCAN_NOT_ATTESTED','GENERATION_PINNED_BINDING_NOT_ATTESTED']);
 const observations={manualTradeReadback:false,manualEndToEnd:false,summaryEndToEnd:false,targetReceiptPresent:false,verifiedEvents:0,reviewEvents:0,scanTimestampPresent:false};
 if(broker==='webull'){
  const view=summary?.target_date===targetDate?summary.webull:null;
  if(view){observations.summaryEndToEnd=view.end_to_end_verified===true;
   if(!count(view.manual_tasks_pending_count))reasons.add('TASK_COUNT_UNKNOWN');else if(view.manual_tasks_pending_count>0)reasons.add('TASKS_PENDING');
   if(!count(view.manual_completion_conflict_count))reasons.add('MANUAL_CONFLICT_UNKNOWN');else if(view.manual_completion_conflict_count>0)reasons.add('MANUAL_CONFLICT');
  }else reasons.add('SUMMARY_TARGET_MISSING');
  if(manual?.schema_version==='webull_manual_completion_v1'&&manual.business_date===targetDate){
   observations.manualTradeReadback=manual.status==='MANUAL_TRADE_READBACK_VERIFIED'||manual.end_to_end_complete===true;
   observations.manualEndToEnd=manual.end_to_end_complete===true;
   if(!Array.isArray(manual.tasks_pending))reasons.add('MANUAL_TASKS_UNKNOWN');else if(manual.tasks_pending.length)reasons.add('TASKS_PENDING');
   if(!manual.cash_observed||!manual.cash_comparisons)reasons.add('CASH_PROOF_MISSING');
  }else reasons.add('MANUAL_TARGET_MISSING');
  if(receipt?.schema_version==='webull_gmail_sync_receipt_v1'&&receipt.target?.business_date===targetDate){
   observations.targetReceiptPresent=true;
   const status=receipt.result?.status||receipt.classification;
   if(['VERIFIED','DUPLICATE'].includes(status))observations.verifiedEvents++;
   else {observations.reviewEvents++;reasons.add(safeStatuses.has(status)?'RECEIPT_PENDING':'RECEIPT_STATUS_UNKNOWN');}
   if(receipt.target.authoritative_tasks_clear!==true)reasons.add('TASKS_NOT_AUTHORITATIVELY_CLEAR');
  }else reasons.add('RECEIPT_TARGET_MISSING');
  if(!journal?.events||journal.schema_version!=='webull_cloud_sync_state_v1')reasons.add('JOURNAL_SCHEMA_UNATTESTED');
 }else{
  observations.scanTimestampPresent=typeof state?.last_complete_scan_at==='string'&&Number.isFinite(Date.parse(state.last_complete_scan_at));
  for(const e of Object.values(state?.events||{}))if(e?.trade_date===targetDate){
   if(e.status==='VERIFIED'||e.status==='DUPLICATE')observations.verifiedEvents++;else observations.reviewEvents++;
  }
  // Existing processed entries have no target date in many real records; do not
  // invent a zero target pending count or use unrelated IB canary status.
  if(Object.values(state?.processed||{}).some(p=>['UNKNOWN','PARTIAL','REVIEW_REQUIRED','SUBMITTED'].includes(p?.status)))reasons.add('KNOWN_REVIEW_PENDING');
  reasons.add('TARGET_PENDING_PARTITION_NOT_ATTESTED');
  if(!observations.scanTimestampPresent)reasons.add('SCAN_TIMESTAMP_MISSING');
 }
 return {schema:'fee.existing-evidence-observation.v1',broker,targetDate,state:'NOT_PRODUCTION_COMPLETE',observations,reasons:[...reasons].sort()};
}
export function safeFeeFailureEvidence({stage,code,runId,checkedAt}={}){
 const stages=new Set(['BOOTSTRAP','COMPLETION','SNAPSHOT','STYLE','FLOW','WRITER','RECEIPT','CANDIDATE','VALIDATE','PROMOTE','PAGES','PUBLIC']);
 const categories=new Set(['PENDING','STALE','BINDING_CHANGED','UNRESOLVED_FLOW','FAILED','UNAVAILABLE']);
 return {schema:'fee.failure-evidence.v1',stage:stages.has(stage)?stage:'UNKNOWN',code:categories.has(code)?code:'FAILED',runId:Number.isSafeInteger(runId)&&runId>0?runId:null,checkedAt:typeof checkedAt==='string'&&Number.isFinite(Date.parse(checkedAt))?new Date(checkedAt).toISOString():null};
}

export function persistSafeFeeFailure(privateDir,input) {
 const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 if(!path.isAbsolute(privateDir)||fs.lstatSync(privateDir).isSymbolicLink())throw Error('FEE_FAILURE_PRIVATE_DIRECTORY');
 const dir=fs.realpathSync(privateDir),relative=path.relative(repo,dir),stat=fs.statSync(dir);
 if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..')||!stat.isDirectory()||(stat.mode&0o077)!==0)throw Error('FEE_FAILURE_PRIVATE_DIRECTORY');
 const evidence=safeFeeFailureEvidence(input),file=path.join(dir,`fee-failure-${evidence.runId||0}-${crypto.randomBytes(8).toString('hex')}.json`);
 fs.writeFileSync(file,JSON.stringify(evidence)+'\n',{flag:'wx',mode:0o600});return {file,evidence};
}
