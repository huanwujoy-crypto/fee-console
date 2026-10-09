// Same report worker, one fixed Sharesight GET; no IB store, sync or ledger writer.
import crypto from 'node:crypto';
import {loadTrustedContext} from './report.mjs';
import {boundedText} from './cloud_io.mjs';
import {planPreopen,hktDate} from './calendar.mjs';
import {parseSharesightStockAllocation} from '../../scripts/xuan-ib-sharesight-allocation.mjs';
import {createAssociationReceipt,validateAssociationSnapshot} from '../../scripts/xuan-ib-account-association.mjs';
import {LEDGER_PROFILE,LEDGER_RECEIPT_MODE,PROFILE_PATH,validateReportProfile,profileBlob,ledgerHash,buildLedgerView,renderLedgerView,validateLedgerPublication} from '../../scripts/xuan-ib-night-action-ledger-view.mjs';
const RAW='https://raw.githubusercontent.com/huanwujoy-crypto/fee-console';
const GATEWAY='https://family-portfolio-gateway-6ikas4b3ma-df.a.run.app';
const fail=code=>{throw Error('SHARESIGHT_LEDGER_'+code);};
async function getJson(url,{fetchImpl=fetch,headers={},limit=8000000}={}){
 let r;try{r=await fetchImpl(url,{method:'GET',headers,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)});}catch{fail('READ_FAILED');}
 if(!r.ok)fail('READ_HTTP');let text;try{text=await boundedText(r,limit);return {text,value:JSON.parse(text)};}catch{fail('READ_INVALID');}
}
export async function loadProductionProfile({loadContext=loadTrustedContext,fetchImpl=fetch,now=Date.now}={}){
 const context=await loadContext({now});validateAssociationSnapshot(context.association,{now:now(),edition:'am'});
 if(!/^[a-f0-9]{40}$/.test(context.association.policyCommit||''))fail('TRUSTED_MAIN');
 const {text,value}=await getJson(`${RAW}/${context.association.policyCommit}/${PROFILE_PATH}`,{fetchImpl,limit:16384});
 validateReportProfile(value);if(text!==JSON.stringify(value,null,2)+'\n')fail('PROFILE_ENCODING');
 return {profile:validateReportProfile(value),profileBlob:profileBlob(text),context};
}
export async function runSharesightLedgerReport({sourceDate,io,now=Date.now,loadProfile=loadProductionProfile,fetchImpl=fetch}={}){
 const began=now(),plan=planPreopen(began);if(plan.status!=='generate'||sourceDate!==plan.sourceDate)fail('TARGET');
 const profile=await loadProfile({now});if(profile.profile!==LEDGER_PROFILE)fail('PROFILE_DISABLED');
 const context=profile.context;validateAssociationSnapshot(context.association,{now:now(),edition:'am'});
 if(!io?.loadGatewayToken||!io.savePrivate)fail('IO');
 const association=createAssociationReceipt(context.association,{now:now(),edition:'am',previousSourceSha:context.previousSourceSha,runId:ledgerHash(crypto.randomUUID())});
 const token=await io.loadGatewayToken();if(typeof token!=='string'||!token||/[\r\n\0]/.test(token))fail('TOKEN');
 const startedAt=new Date(now()).toISOString(),url=new URL('/v1/performance',GATEWAY);
 url.search=new URLSearchParams({portfolio:'IB-HK',start_date:sourceDate,end_date:sourceDate,grouping:'83569',include_sales:'false'}).toString();
 const {value:raw}=await getJson(url,{fetchImpl,headers:{Authorization:'Bearer '+token}}),completedAt=new Date(now()).toISOString();
 if(raw?.mode!=='read_only'||raw.source!=='Sharesight User API')fail('SOURCE_SCOPE');
 const allocation=parseSharesightStockAllocation(raw);if(allocation.dataDate!==sourceDate)fail('SOURCE_DATE');
 const source={sourceKey:'sharesight.ibGroupedPerformance',raw,startedAt,completedAt,rawFingerprint:ledgerHash(raw)};
 const model=buildLedgerView({allocation,dataDate:plan.dataDate,sourceDate,startedAt,completedAt,sourceHash:source.rawFingerprint,profile,association,context});
 const current=await loadProfile({now});validateLedgerPublication(model,{snapshot:current.context.association,previousSourceSha:current.context.previousSourceSha,now:now(),profile:current});
 if(current.context.association.policyCommit!==context.association.policyCommit)fail('BASE_CHANGED');
 const prefix=`report-check/${new Date(began).toISOString()}-${crypto.randomUUID()}/`;
 const sources=[{sourceKey:source.sourceKey,startedAt,completedAt,rawFingerprint:source.rawFingerprint,privateObject:prefix+source.sourceKey+'.json',...await io.savePrivate(prefix+source.sourceKey+'.json',source)}];
 const html=renderLedgerView(model),artifact={privateObject:prefix+'report.html',...await io.savePrivate(prefix+'report.html',html)};
 const receipt={schemaVersion:1,mode:LEDGER_RECEIPT_MODE,status:'partial',sourceReadStatus:'complete',syncCompletion:'unverified',dataDate:plan.dataDate,sourceDate,
  startedAt,completedAt,association,profileBlob:profile.profileBlob,evidenceSha256:model.evidenceSha256,sourceCount:1,sources,artifact,publication:'none',scheduler:'none'};
 await io.savePrivate(prefix+'receipt.json',receipt);
 return receipt;
}
export async function runLedgerReadback({io,now=Date.now,generate=runSharesightLedgerReport,loadProfile=loadProductionProfile,execution=process.env.CLOUD_RUN_EXECUTION}={}){
 if(!/^xuan-preopen-report-[a-z0-9-]+$/.test(execution||''))fail('EXECUTION');
 const plan=planPreopen(now());if(plan.status!=='generate')fail('TARGET');
 const profile=await loadProfile({now});if(profile.profile!==LEDGER_PROFILE)fail('PROFILE_DISABLED');
 let html;const wrapped={loadGatewayToken:()=>io.loadGatewayToken(),savePrivate:async(name,value)=>{if(name.endsWith('/report.html'))html=value;return io.savePrivate(name,value);}};
 const receipt=await generate({sourceDate:plan.sourceDate,io:wrapped,now,loadProfile});
 if(receipt.mode!==LEDGER_RECEIPT_MODE||receipt.status!=='partial'||receipt.dataDate!==plan.dataDate||typeof html!=='string')fail('READBACK_INCOMPLETE');
 const prefix=`delivery/${plan.dataDate}/ledger-view-${receipt.evidenceSha256}/`;
 const artifact={privateObject:prefix+'report.html',...await io.savePrivate(prefix+'report.html',html)};
 await io.savePrivate(prefix+'receipt.json',{...receipt,artifact});
 return {status:'partial',sourceReadStatus:'complete',syncCompletion:'unverified',publication:'none',dataDate:plan.dataDate,sourceDate:plan.sourceDate,prefix};
}
