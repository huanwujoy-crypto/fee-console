// Pure preparation from an existing private capture. No broker calls, refresh,
// credentials, scheduling or publication. User-provided reconciliation summary
// is distinct from current source snapshots and never certifies cash finality.
import crypto from 'node:crypto';
import {fingerprint} from '../../scripts/xuan-ib-run-manifest.mjs';
import {validateAssociationSnapshot,createAssociationReceipt} from '../../scripts/xuan-ib-account-association.mjs';
import {renderLimitedStatus} from '../../scripts/xuan-ib-limited-status.mjs';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
export function prepareLimitedReadback({capture,sourceBytes,trade,cashRecovery,context,now=Date.now()}){
 const fail=()=>{throw Error('LIMITED_EVIDENCE_INVALID');};
 if(capture?.status!=='captured'||capture.mode!=='read_only'||capture.publication!=='none'||capture.sourceCount!==3||capture.sources?.length!==3)fail();
 const start=Date.parse(capture.startedAt),end=Date.parse(capture.completedAt);
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||end>now||now-start>1800000||end-start>300000)fail();
 const date=new Date(start+28800000).toISOString().slice(0,10),required=['ib.accountSummary','ib.positions','ib.orders'];
 for(const key of required){const refs=capture.sources.filter(s=>s.sourceKey===key);if(refs.length!==1||!Buffer.isBuffer(sourceBytes[key])||hash(sourceBytes[key])!==refs[0].evidenceSha256)fail();const s=JSON.parse(sourceBytes[key]);if(s.sourceKey!==key||fingerprint(s.raw)!==refs[0].rawFingerprint||s.startedAt!==refs[0].startedAt||s.completedAt!==refs[0].completedAt||!Number.isFinite(Date.parse(s.startedAt))||!Number.isFinite(Date.parse(s.completedAt))||Date.parse(s.completedAt)<Date.parse(s.startedAt)||Date.parse(s.startedAt)<start||Date.parse(s.completedAt)>end)fail();if(key==='ib.positions'&&(Object.keys(s.raw).join('|')!=='positions'||!Array.isArray(s.raw.positions)||s.raw.positions.some(r=>r.contract_id==null)||new Set(s.raw.positions.map(r=>r.contract_id)).size!==s.raw.positions.length))fail();if(key==='ib.orders'&&(Object.keys(s.raw).join('|')!=='orders'||!Array.isArray(s.raw.orders)||s.raw.orders.some(r=>r.order_id==null||r.currency!=null)||new Set(s.raw.orders.map(r=>r.order_id)).size!==s.raw.orders.length))fail();}
 if(!/^[a-f0-9]{64}$/.test(trade?.rawSha256)||!/^\d{4}-\d{2}-\d{2}$/.test(trade.tradeDate)||trade.tradeDate>=date||trade.allRowsAccountMatchConfiguredIB!==true||!Number.isInteger(trade.executions)||trade.executions<1||!Number.isInteger(trade.orders)||trade.orders<1||trade.orders>trade.executions||trade.uniqueExecIDs!==trade.executions||trade.duplicate!==0||trade.conflict!==0||trade.matchSavedSharesight!==true||trade.cancelCorrectionCoverage!=='unknown')fail();
 if(cashRecovery?.auditMatched!==true||cashRecovery.independentSourceVerified!==false)fail();
 validateAssociationSnapshot(context.association,{now,edition:'am'});
 const association=createAssociationReceipt(context.association,{now,edition:'am',previousSourceSha:context.previousSourceSha,runId:hash(crypto.randomUUID())});
 const evidenceSha256=fingerprint({capture,trade,cashRecovery}),m={schemaVersion:7,status:'partial',dataDate:date,asOfHkt:new Date(start+28800000).toISOString().slice(0,16).replace('T',' ')+' HKT',sourceDate:trade.tradeDate,captureStartedAt:capture.startedAt,captureCompletedAt:capture.completedAt,positions:'read-complete',orders:'read-complete',trades:'target-executions-matched',cash:'recovery-only',corrections:'unknown',orderCurrency:'missing',evidenceSha256,association,expiresAt:context.association.policy.expiresAt,previousDataDate:context.previousMeta.dataDate,previousReportSha:context.previousSourceSha,previousSourceSha:context.previousSourceSha};
 const html=renderLimitedStatus(m),receipt={schemaVersion:1,mode:'private_limited_readback',status:'partial',dataDate:date,sourceDate:trade.tradeDate,startedAt:capture.startedAt,completedAt:capture.completedAt,sourceCount:3,sources:capture.sources.map(s=>({sourceKey:s.sourceKey,sha256:s.evidenceSha256})),association,evidenceSha256,artifact:{sha256:hash(html)},publication:'none'};
 return{model:m,html,receipt};
}
