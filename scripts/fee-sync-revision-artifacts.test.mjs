// Synthetic ciphertext, fixed-route HTTP and original validators only.
// Never reads real credentials, historical reports or account data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRevisionGithubRead} from './fee-sync-revision-github.mjs';
import {createIbRevisionArtifacts,isIbRevisionArtifacts,ibRevisionArtifactFailureCode,ibRevisionArtifactSuccessEvidence,IB_REVISION_ARTIFACT_SCOPE as SCOPE,IB_REVISION_ARTIFACT_DIAGNOSTIC_CODES} from './fee-sync-revision-artifacts.mjs';
import {fetchEconomicSnapshot} from './fee-economic-source.mjs';
import {SharesightIbManagerReader,ibBaselineBusinessHash} from './ib-manager-source.mjs';
import {buildIbOwnerBaseline,buildIbManagerReturnReceipt,buildIbManagerDrawdownReceipt,buildIbManagerReportBundle,createIbManagerReturnConsumer} from './ib-manager-return.mjs';
import {buildFeeCalculationReceipt,validateFeeCalculationReceiptWithEcon} from './fee-receipt-core.mjs';
import {sourceContractInputHash as hash} from './fee-source-contract.mjs';
import {dailyReportPlan} from './fee-report-period.mjs';
import {authorizeReportRecovery,authorizeHistoricalRevisionDiagnostic,isHistoricalRevisionAdmission,isHistoricalRevisionDiagnosticAdmission,readPeriodSourceAttempts,readReportRecoveryRelease,reportHistoricalRecoveryManifest} from './fee-report-producer.mjs';
import {convertEncryptedV3Copy} from './fee-econ-v3-copy.mjs';
import {createLegacyPolicy} from './fee-legacy-policy.mjs';
import {prepareIbManagerReport,assertIbManagerPublication} from './ib-manager-report.mjs';
import {preserveReportMonthLocks} from './fee-report-metadata.mjs';
import {createFeeSourceRevisionRuntime,sourceRevisionRuntimeFailureCode} from './fee-source-revision-runtime.mjs';
import {safeProducerFailureSummary} from './fee-cloud-producer.mjs';
import {revisionDiagnosticFailureCode,inspectRevisionDiagnostic} from './fee-source-revision-diagnostic.mjs';
import {ibRevisionArtifactCashSite,ibRevisionArtifactCashDateRole} from './fee-sync-revision-artifacts.mjs';
import {sourceRevisionRuntimeCashSite,sourceRevisionRuntimeCashDateRole} from './fee-source-revision-runtime.mjs';
import {IB_CASH_RECONCILIATION_SITES,IB_CASH_DATE_ROLES} from './ib-manager-source.mjs';

const B='2026-11-03',U='2026-11-04',P='2026-11-05',T='2026-11-06';
const h=c=>c.repeat(64),o=c=>c.repeat(40),OWNER='huanwujoy-crypto',REPO=OWNER+'/fee-console';
const KEY=Buffer.alloc(32,7),TOKEN='synthetic-github-token-123456789',ID='a'.repeat(32),MAIN=o('a'),TREE=o('b'),APPROVED=o('c');
const REPAIR='d617fdd25315ca09a5f89a81630b04ae19b24d1b',RUN=90000000001;
const SYNC_REPAIR='50392c2fb5ec3b1b26e5515cdb0feebb48823d2d',SYNC_CONTRACT='ib-source-revision-20261106-sync-v2';
const DIAGNOSTIC_REPAIR='4f98318c73d1727d323febdcc72b7d5fbfb77f01',DIAGNOSTIC_CONTRACT='ib-source-revision-20261106-diagnostic-v1';
const DIAGNOSTIC_V2_REPAIR='22174f04cae8ac18a071930f491598b327e315c5',DIAGNOSTIC_V2_CONTRACT='ib-source-revision-20261106-diagnostic-v2';
const DIAGNOSTIC_V3_REPAIR='f1d4454d25849e1908ba508f8c7f140389e425bb',DIAGNOSTIC_V3_CONTRACT='ib-source-revision-20261106-diagnostic-v3';
const DIAGNOSTIC_V4_REPAIR='e30015d7260e43622f8ad63a119b0efbef35acb4',DIAGNOSTIC_V4_CONTRACT='ib-source-revision-20261106-diagnostic-v4';
const DIAGNOSTIC_V8_REPAIR='860387709b954fdfc97f040031791258b9fa5b15',DIAGNOSTIC_V8_CONTRACT='ib-source-revision-20261106-diagnostic-v8';
const SYNC_V3_REPAIR='b218f264c53e914d6469ec9f43824f48ccb7af18',SYNC_V3_CONTRACT='ib-source-revision-20261106-sync-v3';
const SYNC_V4_REPAIR='ea6ce4dcc6784979a4e5bd526d2a13ac0282ae2e',SYNC_V4_CONTRACT='ib-source-revision-20261106-sync-v4';
const SYNC_V5_REPAIR='2e890aea0ddc14d99b38dd6d525279dfc966624e',SYNC_V5_CONTRACT='ib-source-revision-20261106-sync-v5';
const SOURCE_P='9c5ec1636e3a6f5c6f307dba9fc681e3b14d73e8',SOURCE_U='5ad072aa8eae0fd04830250d0811a080b40931b9';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=b=>crypto.createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
const encrypt=(value,v)=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',KEY,iv);return Buffer.from(JSON.stringify({enc:true,v,data:Buffer.concat([iv,c.update(JSON.stringify(value)),c.final(),c.getAuthTag()]).toString('base64')}));};
const decrypt=bytes=>{const s=Buffer.from(JSON.parse(bytes).data,'base64'),d=crypto.createDecipheriv('aes-256-gcm',KEY,s.subarray(0,12));d.setAuthTag(s.subarray(-16));return JSON.parse(Buffer.concat([d.update(s.subarray(12,-16)),d.final()]));};
const response=(url,value)=>{const r=new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;};
const rejection=(p,code)=>assert.rejects(p,e=>{assert.equal(ibRevisionArtifactFailureCode(e),'IB_REVISION_ARTIFACT_'+code);assert.equal(e.cause,undefined);return true;});

function sourceWire({revised=false,state={sourceChanged:false},calls=[],bankWire=false,mutateCashRows}={}){
  const fetchImpl=async(url,init)=>{
    const u=new URL(url),p=u.pathname,q=u.searchParams;assert.equal(u.origin,'https://api.sharesight.com');calls.push({p,method:init.method});let body;
    if(p==='/oauth2/token'){assert.equal(init.method,'POST');body={access_token:'synthetic-source-token-123456789',token_type:'bearer'};}
    else{
      assert.equal(init.method,'GET');assert.equal(init.redirect,'error');const d=q.get('end_date')||q.get('date'),gain=revised&&d>=P?307:0;
      if(p==='/api/v2/portfolios.json')body={portfolios:[{id:1,name:'IB-HK',currency_code:'USD'}]};
      else if(p==='/api/v3/portfolios/1/holdings')body={holdings:[{id:2,valid_position:true,portfolio:{id:1,name:'IB-HK'},note:state.sourceChanged?'changed':'same'}]};
      else if(p==='/api/v3/portfolios/1/performance')body={report:{portfolio_id:1,start_date:d,end_date:d,currency:{code:'USD'},portfolio_tz_name:'America/New_York',include_sales:false,value:1000+gain,
        holdings:[{id:2,value:900,quantity:1,valid_position:true,portfolio:{id:1,name:'IB-HK'},instrument_currency:{code:'USD'}}],cash_accounts:[{id:3,value:100+gain,currency:{code:'USD'},portfolio:{id:1,name:'IB-HK'}}]}};
      else if(p==='/api/v2/portfolios/1/cash_accounts.json')body={cash_accounts:[{id:3,portfolio_id:1,portfolio_currency:'USD',currency:'USD',date:d,balance:100+gain,balance_in_portfolio_currency:100+gain}]};
      else if(p==='/api/v3/portfolios/1/trades.json')body={trades:[]};
      else if(p==='/api/v2/cash_accounts/3/cash_account_transactions.json'){
        const cashRows=revised&&q.get('from')<=P&&q.get('to')>=P?[
        {id:12,cash_account_id:3,date_time:P+'T00:00:00.000Z',amount:7,balance:107,cash_account_transaction_type:{name:'Payout'},trade_id:null,holding_id:2,payout_id:13},
        {id:14,cash_account_id:3,date_time:P+'T05:00:00.000Z',amount:300,balance:407,cash_account_transaction_type:{name:'DEPOSIT'},
          description:bankWire?`IBKR U1000001 bank wire USD 300, received and available ${P} per Transfer Status & History and IBKR notice; source bank not verified. key=ib.manual|U1000001|wire|${P}|USD|300.00`:'Owner cash contribution',
          trade_id:null,holding_id:null,payout_id:null}]:[];
        if(bankWire)mutateCashRows?.(cashRows);
        body={cash_account_transactions:cashRows};
      }
      else if(p==='/api/v2/payouts/13.json')body={id:13,portfolio_id:1,holding_id:2,symbol:'SYNTH',paid_on:P,currency:'USD',confirmed:true,state:'confirmed',non_taxable:false,tax_credit:0,gross_amount:10,resident_withholding_tax:3,amount:7};
      else assert.fail('unexpected synthetic source route');
    }
    return response(url,body);
  };
  return {fetchImpl,calls,reader:new SharesightIbManagerReader({clientId:'synthetic-client',clientSecret:'synthetic-secret',fetchImpl})};
}

// Mint the native admission through the original release validators and the
// selected attempt-history or current-execution/publication-state validators.
// Neither a self-authored permission flag nor a test-only capability is used.
function admissionWire(state,dailyPlan,sync=false,diagnostic=false,syncV3=false,diagnosticV2=false,diagnosticV3=false,diagnosticV4=false,diagnosticV8=false,syncV4=false,syncV5=false){
  diagnostic=diagnostic||diagnosticV2||diagnosticV3||diagnosticV4||diagnosticV8;sync=sync||diagnostic||syncV3||syncV4||syncV5;
  const manifest=reportHistoricalRecoveryManifest(sync?{contractId:diagnosticV8?DIAGNOSTIC_V8_CONTRACT:diagnosticV4?DIAGNOSTIC_V4_CONTRACT:diagnosticV3?DIAGNOSTIC_V3_CONTRACT:diagnosticV2?DIAGNOSTIC_V2_CONTRACT:diagnostic?DIAGNOSTIC_CONTRACT:syncV5?SYNC_V5_CONTRACT:syncV4?SYNC_V4_CONTRACT:syncV3?SYNC_V3_CONTRACT:SYNC_CONTRACT}:{}),actor={id:283054367,login:OWNER,type:'User'},ui='2bb9f66ac890ba87cec504ef72a5083c07670689',repairBase=diagnosticV8?DIAGNOSTIC_V8_REPAIR:diagnosticV4?DIAGNOSTIC_V4_REPAIR:diagnosticV3?DIAGNOSTIC_V3_REPAIR:diagnosticV2?DIAGNOSTIC_V2_REPAIR:diagnostic?DIAGNOSTIC_REPAIR:syncV5?SYNC_V5_REPAIR:syncV4?SYNC_V4_REPAIR:syncV3?SYNC_V3_REPAIR:sync?SYNC_REPAIR:REPAIR;
  const signed=(id,parents,tree=TREE)=>({sha:id,parents:parents.map(sha=>({sha})),author:actor,committer:{login:OWNER},commit:{tree:{sha:tree},verification:{verified:true,reason:'valid'}}});
  const commit=signed(MAIN,[repairBase]),repair=signed(repairBase,diagnosticV8?['97101f6f75f7e5295acd232f7d69c32594ec4044']:diagnosticV4?[DIAGNOSTIC_V3_REPAIR]:diagnosticV3?[DIAGNOSTIC_V2_REPAIR]:diagnosticV2?[SYNC_V3_REPAIR]:diagnostic?[SYNC_REPAIR]:syncV5?[SYNC_V4_REPAIR]:syncV4?['860387709b954fdfc97f040031791258b9fa5b15']:syncV3?[DIAGNOSTIC_REPAIR]:sync?[REPAIR]:['4d798c77c9a9a5d459a75af45b4239c7c9cf984a','474e7b5a20f93358193791daf84d175a22e06d9e']);
  const run=(id,head,created)=>({id,head_sha:head,head_branch:'main',path:'.github/workflows/fee-cloud-producer.yml',event:'workflow_dispatch',created_at:created,run_attempt:1,workflow_id:365873934,actor,status:id===RUN?'in_progress':'completed',conclusion:id===RUN?null:'failure'});
  const runs=[run(RUN,MAIN,'2026-11-07T01:00:00Z'),run(42309848352,'94210904dd95b2ff4496cb68dab6b49950fe4f74','2026-11-06T23:08:38Z'),run(42318324848,'2c32d695f4f2dc057920fc690046ddf3e1ccdaee','2026-11-07T00:00:00Z')];
  state.currentRun={...runs[0],repository:{full_name:REPO},...(diagnostic?{display_title:'IB diagnostic '+T}:{})};
  const jobs=Object.fromEntries(runs.slice(1).map((r,i)=>[r.id,[{id:i?128236468656:128208373197,run_id:r.id,head_sha:r.head_sha,name:'Produce daily '+T,status:'completed',conclusion:'failure',started_at:r.created_at}]]));
  const fetchImpl=async(url,init)=>{
    assert.equal(init.method,'GET');const route=url.split('/repos/'+REPO+'/')[1];state.admissionCalls.push(route);let value;
    if(route==='git/ref/heads/main')value={object:{sha:state.main}};
    else if(route==='commits/'+MAIN+'?per_page=1')value=commit;
    else if(route==='commits/'+repairBase+'?per_page=1')value=repair;
    else if(route==='commits/'+APPROVED+'?per_page=1')value=signed(APPROVED,[repairBase]);
    else if(route==='compare/'+repairBase+'...'+MAIN+'?per_page=100')value={status:'ahead',ahead_by:1,behind_by:0,total_commits:1,base_commit:{sha:repairBase},merge_base_commit:{sha:repairBase},commits:[{sha:MAIN}],files:manifest.map(m=>({filename:m.path,status:m.status,sha:o('e')}))};
    else if(route==='git/trees/'+TREE+'?recursive=1')value={sha:TREE,truncated:false,tree:[{path:'index.html',type:'blob',mode:'100644',sha:ui},...manifest.map(m=>({path:m.path,type:'blob',mode:'100644',sha:o('e')}))]};
    else if(route==='commits/'+MAIN+'/pulls?per_page=100')value=[{number:999}];
    else if(route==='pulls/999')value={number:999,state:'closed',merged:true,draft:false,merge_commit_sha:MAIN,user:actor,base:{ref:'main',repo:{full_name:REPO}},head:{sha:APPROVED,repo:{full_name:REPO}},commits:1,merged_at:'2026-11-07T00:50:00Z'};
    else if(['issues/999/comments?per_page=100','issues/comments/1'].includes(route)){const comment={id:1,user:actor,body:'/approve-xuan-ib-maintenance '+APPROVED,created_at:'2026-11-07T00:40:00Z',updated_at:'2026-11-07T00:40:00Z',issue_url:'https://api.github.com/repos/'+REPO+'/issues/999'};value=route==='issues/comments/1'?comment:[comment];}
    else if(!sync&&route?.startsWith('actions/workflows/fee-cloud-producer.yml/runs?'))value={total_count:runs.length,workflow_runs:state.competing?[...runs,{...runs[0],id:90000000002}]:runs};
    else if(!sync&&/^actions\/runs\/\d+\/jobs\?filter=all&per_page=100$/.test(route)){const list=jobs[Number(route.split('/')[2])];assert.ok(list);value={total_count:list.length,jobs:list};}
    else assert.fail('unexpected synthetic admission route '+route);
    return response(url,value);
  };
  return {readRecoveryRelease:(sha,options)=>readReportRecoveryRelease(sha,{...options,fetchImpl}),
    readSourceAttempts:options=>{assert.equal(sync,false,'sync admission must not request attempt history');return readPeriodSourceAttempts({...options,fetchImpl,actionsToken:TOKEN});},
    ...(sync?{readCurrentRun:async()=>{state.currentRunReads++;return structuredClone(state.currentRun);},
      readState:async()=>{state.publicationReads++;return {...structuredClone(state.publication),data:Buffer.from(state.publication.data)};}}:{})};
}

async function fixture(t,{legacy=false,mutatePayload,mutateHealth,mutateEconomic,sync=false,diagnostic=false,syncV3=false,diagnosticV2=false,diagnosticV3=false,diagnosticV4=false,diagnosticV8=false,syncV4=false,syncV5=false,lockedMonth=false,bankWire=false,mutateCashRows}={}){
  diagnostic=diagnostic||diagnosticV2||diagnosticV3||diagnosticV4||diagnosticV8;sync=sync||diagnostic||syncV3||syncV4||syncV5;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'revision-artifact-synthetic-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const state={now:Date.parse('2026-11-07T01:10:00.000Z'),main:MAIN,economicRevision:o('e'),sourceChanged:false,calls:[],sourceCalls:[],admissionCalls:[],currentRunReads:0,publicationReads:0,mutate:null,log:null,competing:false};
  const clock=()=>state.now,dailyPlan=dailyReportPlan(T,['NYSE','NASDAQ'],{periodFrom:T,reviewedSyncDate:T});
  const start=lockedMonth?'2026-10-01':B,through=date=>{
    const dates=[];for(let n=Date.parse(start+'T00:00:00Z');n<=Date.parse(date+'T00:00:00Z');n+=86400000)dates.push(new Date(n).toISOString().slice(0,10));return dates;
  };
  const business={points:through(B).map(d=>({d,tot:1000})),openT:1000,from:start,to:B,days:through(B).length,flowByDate:{},rate:0,cr:0,cumBefore:0,hwmBefore:0},baselineSha256=ibBaselineBusinessHash(business);
  const input={schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:h('c'),periodReturnsInput:business};
  const owner=await buildIbOwnerBaseline({ibManagerReturnReceipt:await buildIbManagerReturnReceipt(input),ibManagerDrawdownReceipt:await buildIbManagerDrawdownReceipt(input)},input,baselineSha256);
  const coverageBody={schema:'fee-console.ib-manager-coverage.v2',authority:'reviewed-source-reconciliation',sourceProvider:'Sharesight',baselineInputsHash:baselineSha256,from:U,through:U,evidenceSha256:h('e'),events:[],quotes:[]};
  const coverage={...coverageBody,coverageId:await createIbManagerReturnConsumer().digest(coverageBody)},baseline={from:start,asOf:B};
  const u=await sourceWire().reader.readStable({targetDate:U,expectedBaselineHash:baselineSha256,baseline,ownerBaseline:owner,bootstrapCoverage:coverage});
  const p=await sourceWire().reader.readStable({targetDate:P,expectedBaselineHash:baselineSha256,baseline,checkpoint:u});
  let economic={v:4,settings:{start,mgmt:2,carry:20},accounts:[{id:'schwab',name:'Synthetic A',opening:100},{id:'webull',name:'Synthetic B',opening:100}],months:[],fees:[]},economicBytes,legacySourcePath=null;
  if(legacy){
    const raw={...economic,v:3,updatedAt:'2026-11-04T01:00:00Z',settings:{...economic.settings,who:'SYNTHETIC',openingAt:'2026-11-02',fx:{USD:1,HKD:.125,CNY:.14,EUR:1.1,SGD:.74,GBP:1.2,JPY:.006}},fees:[{id:'blank',note:'',type:'exp',deduct:true,date:B,fx:'',amount:'',ccy:'USD'}]};
    const original=encrypt(raw,3);legacySourcePath=path.join(dir,'original-economic.json');fs.writeFileSync(legacySourcePath,original,{mode:0o600});
    economicBytes=convertEncryptedV3Copy(original,KEY,{policyId:createLegacyPolicy().LEGACY_POLICY_ID});economic=decrypt(economicBytes);
  }
  mutateEconomic?.(economic);if(!economicBytes)economicBytes=encrypt(economic,4);
  const payloadOf=async(source,date)=>{
    const b=await buildIbManagerReportBundle(source,baselineSha256),out={daily:through(date).map(d=>({d,schwab:100,webull:100})),flowsAuto:[],flowsUnresolved:[],status:{asOf:date,provisional:false,calibrated:true,unresolvedCount:0,splitDelta:0,notes:[]},
      ibManagerBaselineState:owner,ibManagerReturnReceipt:b.returnReceipt,ibManagerDrawdownReceipt:b.drawdownReceipt,ibManagerSourceState:b.sourceState,ibManagerCoverageState:coverage,ibManagerSourceStatus:{state:'verified',targetDate:date},
      feeReportMonthLocks:{schema:'fee-console.report-month-locks.v1',periods:[]},consumedOperations:['synthetic-old-failure']};
    out.feeCalculationReceipt=buildFeeCalculationReceipt({data:out,economicInput:economic});
    if(lockedMonth)out.feeReportMonthLocks=preserveReportMonthLocks(out,out,economic,{finalCutoff:'2026-10-31'});
    mutatePayload?.(out,date);return out;
  };
  const currentPayload=await payloadOf(p,P),anchorPayload=await payloadOf(u,U),dataBytes=encrypt(currentPayload,3),anchorBytes=encrypt(anchorPayload,3);
  const health=(date,bytes,checkedAt)=>{const h={schema:'fee-console.daily-health.v1',checkedAt,targetDate:date,sourceDates:{schwab:date,webull:date,benchmark:date},outcome:'updated',dataSha256:sha(bytes),errorCode:null};mutateHealth?.(h,date);return Buffer.from(JSON.stringify(h,null,2)+'\n');};
  const healthBytes=health(P,dataBytes,'2026-11-06T01:01:00.000Z'),anchorHealth=health(U,anchorBytes,'2026-11-05T05:45:00.000Z');
  state.publication={mainSha:MAIN,finalMainSha:MAIN,data:dataBytes,pending:false,health:JSON.parse(healthBytes)};
  let admissionReaders=admissionWire(state,dailyPlan,sync,diagnostic,syncV3,diagnosticV2,diagnosticV3,diagnosticV4,diagnosticV8,syncV4,syncV5);
  if(syncV5){
    const {readState,...native}=admissionReaders;admissionReaders=native;
    const oldFetch=globalThis.fetch,oldToken=process.env.GITHUB_TOKEN;delete process.env.GITHUB_TOKEN;
    state.publicationRequests=[];
    globalThis.fetch=async(url,init)=>{
      const root='https://api.github.com/repos/'+REPO+'/';assert(url.startsWith(root));const route=url.slice(root.length);
      assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer '+TOKEN);
      state.publicationRequests.push(route);let value;
      if(route==='git/ref/heads/main')value={object:{sha:state.main}};
      else if(route==='git/matching-refs/heads/codex/fee-daily-20261106-')value=[];
      else{
        assert(['contents/data.json?ref='+MAIN,'contents/fee-data-health.json?ref='+MAIN].includes(route));
        const bytes=route.startsWith('contents/data.')?state.publication.data:Buffer.from(JSON.stringify(state.publication.health));
        value={type:'file',encoding:'base64',size:bytes.length,content:bytes.toString('base64')};
      }
      return response(url,value);
    };
    t.after(()=>{globalThis.fetch=oldFetch;if(oldToken===undefined)delete process.env.GITHUB_TOKEN;else process.env.GITHUB_TOKEN=oldToken;});
  }
  const admission=await (diagnostic?authorizeHistoricalRevisionDiagnostic:authorizeReportRecovery)({plan:dailyPlan,expectedMain:MAIN,currentRunId:RUN,now:new Date(state.now),clock:()=>new Date(state.now),actionsToken:TOKEN,...admissionReaders});
  const oldEnv={id:process.env.FEE_ECON_GIST_ID,token:process.env.FEE_ECON_GITHUB_TOKEN};process.env.FEE_ECON_GIST_ID=ID;process.env.FEE_ECON_GITHUB_TOKEN='github_pat_SYNTHETIC_NOT_A_REAL_TOKEN_123456';
  const economicFetch=async(url,init)=>{assert.equal(url,'https://api.github.com/gists/'+ID);assert.equal(init.method,'GET');state.economicReads=(state.economicReads||0)+1;const override=await state.economicTransport?.(url,init);if(override!==undefined)return override;return new Response(JSON.stringify({id:ID,public:false,owner:{login:OWNER},truncated:false,history:[{version:state.economicRevision}],files:{'fee-console-db.json':{filename:'fee-console-db.json',content:economicBytes.toString(),size:economicBytes.length,truncated:false}}}),{headers:{etag:'"synthetic"','content-type':'application/json'}});};
  let economicSnapshot;try{economicSnapshot=await fetchEconomicSnapshot({tempRoot:dir,attempts:1,timeoutMs:100,fetchImpl:economicFetch});}finally{for(const[k,v]of Object.entries({FEE_ECON_GIST_ID:oldEnv.id,FEE_ECON_GITHUB_TOKEN:oldEnv.token}))if(v===undefined)delete process.env[k];else process.env[k]=v;}
  t.after(()=>economicSnapshot.cleanup());
  const files={[SCOPE.current.candidateSha]:{'data.json':dataBytes,'fee-data-health.json':healthBytes},[SCOPE.anchor.candidateSha]:{'data.json':anchorBytes,'fee-data-health.json':anchorHealth}};
  const trees={},commits={},parents={};
  const treeRows=files=>[...Object.entries(files).map(([path,bytes])=>({path,type:'blob',mode:'100644',sha:blob(bytes),size:bytes.length})),{path:'index.html',type:'blob',mode:'100644',sha:o('1'),size:1}];
  const pTree=o('2'),uTree=o('3'),beforeTree=o('4');trees[TREE]=trees[pTree]=treeRows(files[SCOPE.current.candidateSha]);trees[uTree]=treeRows(files[SCOPE.anchor.candidateSha]);trees[beforeTree]=treeRows({'data.json':Buffer.from('old'),'fee-data-health.json':Buffer.from('old')});
  const addCommit=(id,parent,tree,message)=>{parents[id]=parent;commits[id]={sha:id,author:{id:283054367,login:OWNER,type:'User'},parents:[{sha:parent}],commit:{tree:{sha:tree},message,verification:{verified:true,reason:'valid'}}};};
  addCommit(MAIN,SCOPE.current.candidateSha,TREE,'synthetic merge');addCommit(SCOPE.current.candidateSha,SOURCE_P,pTree,'daily '+P);addCommit(SOURCE_P,SCOPE.anchor.candidateSha,uTree,'synthetic source');addCommit(SCOPE.anchor.candidateSha,SOURCE_U,uTree,'daily '+U);addCommit(SOURCE_U,o('5'),beforeTree,'synthetic source');
  const runs={},jobs={};
  for(const[role,date,head,start,end,jobId]of [['current',P,SOURCE_P,'2026-11-06T01:00:15Z','2026-11-06T01:01:06Z',9001],['anchor',U,SOURCE_U,'2026-11-05T05:44:29Z','2026-11-05T05:45:38Z',9002]]){
    const scope=SCOPE[role];runs[scope.producerRunId]={id:scope.producerRunId,status:'completed',conclusion:'success',run_attempt:1,event:'workflow_dispatch',head_branch:'main',path:'.github/workflows/fee-cloud-producer.yml',head_repository:{full_name:REPO},head_sha:head};
    jobs[scope.producerRunId]=[{id:jobId,run_id:scope.producerRunId,head_sha:head,name:'Produce daily '+date,status:'completed',conclusion:'success',started_at:start,completed_at:end,steps:[{name:'Read, calculate and validate the encrypted candidate',status:'completed',conclusion:'success'},{name:'Create a signed owner candidate',status:'completed',conclusion:'success',started_at:start,completed_at:end}]}];
  }
  const source=sourceWire({revised:true,state,calls:state.sourceCalls,bankWire,mutateCashRows});
  const fetchImpl=async(url,init)=>{
    if(url.startsWith('https://api.sharesight.com/'))return source.fetchImpl(url,init);
    assert.equal(init.method,'GET');const route=url.split('/repos/'+REPO+'/')[1];state.calls.push(route);let value;
    const override=await state.transport?.(route,url);if(override!==undefined)return override;
    if(route==='git/ref/heads/main')value={object:{sha:state.main}};
    else if(route.startsWith('commits/'))value=commits[route.slice(8)];
    else if(route.startsWith('git/commits/')){const id=route.slice(12);value={sha:id,parents:[{sha:parents[id]}]};}
    else if(route.startsWith('git/trees/')){const id=route.slice(10);value={sha:id,truncated:false,tree:trees[id]};}
    else if(route.startsWith('contents/')){const[name,id]=route.slice(9).split('?ref='),bytes=files[id]?.[name];assert.ok(bytes);value={type:'file',path:name,encoding:'base64',size:bytes.length,sha:blob(bytes),content:bytes.toString('base64')};}
    else if(/^actions\/runs\/\d+$/.test(route))value=runs[Number(route.split('/')[2])];
    else if(/^actions\/runs\/\d+\/jobs\?per_page=100$/.test(route)){const list=jobs[Number(route.split('/')[2])];value={total_count:list.length,jobs:list};}
    else if(/^actions\/jobs\/(9001|9002)\/logs$/.test(route)){const role=route.includes('9001')?'current':'anchor',timestamp=role==='current'?'2026-11-06T01:01:01.0000000Z':'2026-11-05T05:45:33.0000000Z';return new Response(state.log??timestamp+' candidate '+SCOPE[role].candidateSha+'\n');}
    else assert.fail('unexpected synthetic artifact route '+route);
    assert.ok(value,'known synthetic response');return response(url,state.mutate?.(route,structuredClone(value))??value);
  };
  const github=createRevisionGithubRead({token:TOKEN,fetchImpl,clock}),config={github,economicSnapshot,dataKey:KEY,legacySourcePath,baselineSha256,clock,admission,...(diagnostic?{diagnosticOnly:true}:{})};
  t.after(()=>github.close());const cap=createIbRevisionArtifacts(config);t.after(()=>cap.close());
  const read=()=>cap.readVerifiedArtifacts({targetDate:T,mainSha:MAIN});
  const planOf=v=>({schema:sync?'fee-console.ib-source-revision-plan.v2':'fee-console.ib-source-revision-plan.v1',targetDate:T,anchorDate:U,baselineSha256,currentSourceStateId:currentPayload.ibManagerSourceState.stateId,anchorSourceStateId:anchorPayload.ibManagerSourceState.stateId,currentArtifact:v.artifacts.current,anchorArtifact:v.artifacts.anchor,bindings:v.bindings,expiresAt:v.expiresAt});
  return{cap,config,read,planOf,reader:source.reader,currentPayload,anchorPayload,economic,key:KEY,dataBytes,healthBytes,dir,state,clock,baselineSha256,fetchImpl,admission,dailyPlan,files,trees,commits,runs,jobs,economicBytes};
}

test('native admission and actual ciphertext authenticate both historical producer artifacts and original fee/IB receipts',async t=>{
  const f=await fixture(t),v=await f.read();assert.deepEqual(v.currentPayload,f.currentPayload);assert.deepEqual(v.anchorPayload,f.anchorPayload);
  assert.equal(isIbRevisionArtifacts(f.cap),true);assert.equal(isIbRevisionArtifacts({...f.cap}),false);assert.equal(isIbRevisionArtifacts(new Proxy(f.cap,{})),false);
  assert.equal(v.bindings.baseDataSha256,sha(f.dataBytes));assert.equal(v.bindings.baseHealthSha256,sha(f.healthBytes));assert.equal(v.artifacts.current.producerRunId,SCOPE.current.producerRunId);
  assert.deepEqual(await f.cap.checkCurrent(),v.bindings);assert.equal(f.state.sourceCalls.length,0);
  const candidate=await f.cap.prepareCandidate({plan:f.planOf(v),reader:f.reader});assert.equal(candidate.mode,'extend-cutoff');assert.deepEqual(candidate.changedHistoricalDates,[P]);
  assert.equal(await f.cap.verifyCandidate(candidate),true);assert.equal(candidate.publicationReady,false);assert.equal(candidate.executionAuthorized,false);
});

async function writeVerifiedRevision(f,{candidate,artifacts,basePayload}){
  const output=path.join(f.dir,'writer');fs.mkdirSync(output,{mode:0o700});
  const dataFile=path.join(output,'data.json'),economicFile=f.config.economicSnapshot.sourcePath,clockFile=path.join(output,'clock.mjs');
  const environ={IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:f.baselineSha256};
  const prepared=await prepareIbManagerReport({payload:f.currentPayload,targetDate:T,outputDir:output,environ,clock:f.clock,
    revision:{candidate,artifacts},revisionBasePayload:basePayload});
  assert.equal(prepared.state,'verified');assert.equal(fs.statSync(prepared.file).mode&0o777,0o600);
  const request=JSON.parse(fs.readFileSync(prepared.file));assert.equal(request.schema,'fee-console.ib-manager-report-request.v2');
  assert.equal(request.revision.revisionId,candidate.revisionId);
  fs.writeFileSync(dataFile,f.dataBytes,{mode:0o600});
  fs.writeFileSync(clockFile,`const Original=Date;globalThis.Date=class extends Original{constructor(...args){super(...(args.length?args:[${f.state.now}]));}static now(){return ${f.state.now};}};globalThis.fetch=()=>{throw Error('SYNTHETIC_NETWORK_FORBIDDEN');};`,{mode:0o600});
  const originalData=Buffer.from(f.dataBytes),originalHealth=Buffer.from(f.healthBytes),originalEconomic=fs.readFileSync(economicFile);
  const argv=['--import',clockFile,new URL('./daily.mjs',import.meta.url).pathname,'--file='+dataFile,'--date='+T,
    '--schwab=100','--webull=100','--src-schwab='+T,'--src-webull='+T,'--cash=0','--stock=200','--other=0',
    '--spy=101','--qqq=102','--spyd=0','--qqqd=0','--src-bench='+T,'--bench-state=session',
    '--ib-manager-input='+prepared.file,'--report-plan='+JSON.stringify(f.dailyPlan)];
  const env={PATH:process.env.PATH,...environ,FEE_DATA_KEY:f.key.toString('base64url'),FEE_ECON_FILE:economicFile,FEE_STYLE_INPUT_FILE:'',FEE_MANAGEMENT_INPUT_FILE:''};
  const child=spawnSync(process.execPath,argv,{encoding:'utf8',env});assert.equal(child.status,0,child.stderr);
  const encrypted=fs.readFileSync(dataFile),result=decrypt(encrypted);
  assert.equal(JSON.parse(encrypted).enc,true);assert.equal(result.feeCalculationReceipt.asOf,T);
  assert.equal(result.ibManagerReturnReceipt.asOf,T);assert.equal(result.ibManagerSourceRevision.revisionId,candidate.revisionId);
  assert.deepEqual(result.ibManagerSourceRevision.candidate.superseded.sourceState,f.currentPayload.ibManagerSourceState);
  assert.deepEqual(result.ibManagerSourceRevision.candidate.acceptedAnchor.sourceState,f.anchorPayload.ibManagerSourceState);
  assert.equal(result.ibManagerSourceRevision.previousRevisionId,null);
  assert.equal(validateFeeCalculationReceiptWithEcon(result.feeCalculationReceipt,result,f.economic).ok,true);
  assert.deepEqual(preserveReportMonthLocks(f.currentPayload,result,f.economic),f.currentPayload.feeReportMonthLocks);
  await assertIbManagerPublication(result,T,environ);
  assert.equal(result.feeReportPublication.plan.accountingThrough,T);assert.equal(result.feeReportPublication.plan.priceThrough,T);
  assert.deepEqual(result.consumedOperations,f.currentPayload.consumedOperations);
  assert.deepEqual(f.dataBytes,originalData);assert.deepEqual(f.healthBytes,originalHealth);assert.deepEqual(fs.readFileSync(economicFile),originalEconomic);
  assert.equal(decrypt(originalData).feeCalculationReceipt.asOf,P);
  const repeated=spawnSync(process.execPath,argv,{encoding:'utf8',env});assert.notEqual(repeated.status,0);
  assert.match(repeated.stderr,/IB_REPORT_INPUT_REFUSED/);assert.deepEqual(fs.readFileSync(dataFile),encrypted);
  return {result,dataFile,originalData,originalHealth,originalEconomic};
}

test('real artifact capability and original source candidate pass the private handoff and actual encrypted daily writer',async t=>{
  const f=await fixture(t),view=await f.read(),candidate=await f.cap.prepareCandidate({plan:f.planOf(view),reader:f.reader});
  const before=structuredClone(f.currentPayload);
  await writeVerifiedRevision(f,{candidate,artifacts:f.cap,basePayload:view.currentPayload});
  assert.deepEqual(f.currentPayload,before);assert.equal(await f.cap.verifyCandidate(candidate),true);
  await assert.rejects(prepareIbManagerReport({payload:f.currentPayload,targetDate:T,outputDir:f.dir,
    environ:{IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:f.baselineSha256},clock:f.clock,
    revision:{candidate,artifacts:f.cap},revisionBasePayload:view.currentPayload}),/IB_REPORT_INPUT_REFUSED/);
});

test('native recovery runtime authenticates original bytes, creates the real reader and handoff, then rechecks after the actual writer',async t=>{
  const f=await fixture(t),runtime=await createFeeSourceRevisionRuntime({plan:f.dailyPlan,admission:f.admission,economicSnapshot:f.config.economicSnapshot,
    sourceBytes:f.dataBytes,sourcePayload:f.currentPayload,healthBytes:f.healthBytes,githubToken:TOKEN,clientId:'synthetic-client',clientSecret:'synthetic-secret',
    keyText:f.key.toString('base64url'),baselineSha256:f.baselineSha256,legacySourcePath:null,fetchImpl:f.fetchImpl,clock:f.clock});
  t.after(()=>runtime.close());const original=Buffer.from(f.dataBytes),ibRevision=await runtime.prepare();
  assert.ok(f.state.sourceCalls.some(c=>c.method==='GET'));assert.ok(f.state.admissionCalls.length>0);
  await writeVerifiedRevision(f,ibRevision);assert.equal(await runtime.checkCurrent(),true);
  t.diagnostic(JSON.stringify({artifactGets:f.state.calls.length,admissionGets:f.state.admissionCalls.length,sourceCalls:f.state.sourceCalls.length,sourceAuthPosts:f.state.sourceCalls.filter(c=>c.method==='POST').length}));
  await assert.rejects(runtime.prepare(),/REUSE/);
  // The captured-source recheck now reports its fixed stage: a changed record
  // body is RECORD_CHANGED, not the former generic SOURCE_CHANGED. Match the
  // exact public code so a different stage or a looser wrapper cannot pass.
  f.state.sourceChanged=true;await assert.rejects(runtime.checkCurrent(),error=>{
    assert.equal(sourceRevisionRuntimeFailureCode(error),'FEE_REPORT_SOURCE_REVISION_ARTIFACT_SOURCE_RECHECK_RECORD_CHANGED');
    assert.equal(error.message,'FEE_REPORT_SOURCE_REVISION_ARTIFACT_SOURCE_RECHECK_RECORD_CHANGED');assert.equal(error.cause,undefined);return true;});
  await assert.rejects(runtime.checkCurrent(),/CLOSED/);assert.deepEqual(f.dataBytes,original);
});

test('sync-cycle v2 authenticates originals and the private writer without querying workflow history',async t=>{
  const f=await fixture(t,{sync:true}),runtime=await createFeeSourceRevisionRuntime({plan:f.dailyPlan,admission:f.admission,economicSnapshot:f.config.economicSnapshot,
    sourceBytes:f.dataBytes,sourcePayload:f.currentPayload,healthBytes:f.healthBytes,githubToken:TOKEN,clientId:'synthetic-client',clientSecret:'synthetic-secret',
    keyText:f.key.toString('base64url'),baselineSha256:f.baselineSha256,legacySourcePath:null,fetchImpl:f.fetchImpl,clock:f.clock});
  t.after(()=>runtime.close());const original=Buffer.from(f.dataBytes),revision=await runtime.prepare(),plan=revision.candidate.plan;
  assert.equal(plan.schema,'fee-console.ib-source-revision-plan.v2');assert.equal(plan.bindings.admissionModel,'sync-cycle-v1');
  assert.match(plan.bindings.executionSha256,/^[a-f0-9]{64}$/);assert.equal(Object.hasOwn(plan.bindings,'consumptionSha256'),false);
  assert.deepEqual(Object.keys(plan.bindings).sort(),['mainSha','economicRevisionSha256','admissionModel','executionSha256','baseDataSha256','baseHealthSha256','currentSourceStateId'].sort());
  await writeVerifiedRevision(f,revision);assert.equal(await runtime.checkCurrent(),true);
  assert.ok(f.state.currentRunReads>1);assert.ok(f.state.publicationReads>1);
  assert.ok(![...f.state.calls,...f.state.admissionCalls].some(p=>p.startsWith('actions/workflows/')||p.includes('filter=all')));
  for(const role of ['current','anchor'])assert.ok(f.state.calls.includes('actions/runs/'+SCOPE[role].producerRunId));
  await assert.rejects(runtime.prepare(),/REUSE/);assert.deepEqual(f.dataBytes,original);
});

test('sync-cycle v3 bank-wire memo creates a traceable historical revision without counting the deposit as return',async t=>{
  const f=await fixture(t,{syncV3:true,lockedMonth:true,bankWire:true}),before={current:structuredClone(f.currentPayload),anchor:structuredClone(f.anchorPayload),
    data:Buffer.from(f.dataBytes),health:Buffer.from(f.healthBytes),economic:fs.readFileSync(f.config.economicSnapshot.sourcePath)};
  const runtime=await createFeeSourceRevisionRuntime({plan:f.dailyPlan,admission:f.admission,economicSnapshot:f.config.economicSnapshot,
    sourceBytes:f.dataBytes,sourcePayload:f.currentPayload,healthBytes:f.healthBytes,githubToken:TOKEN,clientId:'synthetic-client',clientSecret:'synthetic-secret',
    keyText:f.key.toString('base64url'),baselineSha256:f.baselineSha256,legacySourcePath:null,fetchImpl:f.fetchImpl,clock:f.clock});
  t.after(()=>runtime.close());const revision=await runtime.prepare(),candidate=revision.candidate;
  assert.equal((await f.admission.checkCurrent()).contractId,SYNC_V3_CONTRACT);
  assert.equal(candidate.plan.schema,'fee-console.ib-source-revision-plan.v2');
  assert.equal(candidate.plan.bindings.admissionModel,'sync-cycle-v1');
  assert.match(candidate.plan.bindings.executionSha256,/^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(candidate.plan.bindings,'consumptionSha256'),false);
  assert.equal(candidate.mode,'extend-cutoff');assert.deepEqual(candidate.changedHistoricalDates,[P]);
  assert.equal(candidate.oldThrough,P);assert.equal(candidate.anchorDate,U);assert.equal(candidate.targetDate,T);
  assert.equal(candidate.oldArtifactsPreserved,true);assert.equal(candidate.publicationReady,false);assert.equal(candidate.executionAuthorized,false);
  assert.deepEqual(candidate.superseded.sourceState,before.current.ibManagerSourceState);
  assert.deepEqual(candidate.acceptedAnchor.sourceState,before.anchor.ibManagerSourceState);
  assert.deepEqual(candidate.replacement.sourceState.source.cashFlowByDate,{[P]:300});
  assert.deepEqual(candidate.replacement.sourceState.source.periodReturnsInput.flowByDate,{[P]:300});
  assert.equal(candidate.replacement.sourceState.source.periodReturnsInput.points.at(-1).tot,1307);
  assert.equal(candidate.replacement.returnReceipt.grossTwrPpm,7000,'only the synthetic seven-dollar net payout is return, not the three-hundred-dollar deposit');
  const {result}=await writeVerifiedRevision(f,revision);assert.equal(await runtime.checkCurrent(),true);
  assert.equal(result.ibManagerReturnReceipt.grossTwrPpm,7000);
  assert.deepEqual(result.ibManagerSourceRevision.candidate.changedHistoricalDates,[P]);
  assert.deepEqual(result.feeReportMonthLocks,before.current.feeReportMonthLocks);assert.equal(result.feeReportMonthLocks.periods.length,1);
  assert.deepEqual(result.consumedOperations,before.current.consumedOperations);
  assert.deepEqual(f.currentPayload,before.current);assert.deepEqual(f.anchorPayload,before.anchor);
  assert.deepEqual(f.dataBytes,before.data);assert.deepEqual(f.healthBytes,before.health);
  assert.deepEqual(fs.readFileSync(f.config.economicSnapshot.sourcePath),before.economic);
  assert.ok(f.state.sourceCalls.every(c=>c.method==='GET'||c.method==='POST'&&c.p==='/oauth2/token'));
  assert.ok(![...f.state.calls,...f.state.admissionCalls].some(p=>p.startsWith('actions/workflows/')||p.includes('filter=all')));
  await assert.rejects(runtime.prepare(),/REUSE/);
});

test('sync-cycle v3 bank-wire date, amount and identity conflicts fail closed before any private writer handoff',async t=>{
  const cases=[
    ['memo date',rows=>{rows.find(r=>r.id===14).description=rows.find(r=>r.id===14).description.replace(`available ${P}`,`available ${T}`);},'UNRESOLVED_FLOW'],
    ['key date',rows=>{rows.find(r=>r.id===14).description=rows.find(r=>r.id===14).description.replace(`|wire|${P}|`,`|wire|${T}|`);},'UNRESOLVED_FLOW'],
    ['both dates differ from the original business date',rows=>{rows.find(r=>r.id===14).description=rows.find(r=>r.id===14).description.replaceAll(P,T);},'UNRESOLVED_FLOW'],
    ['memo amount',rows=>{rows.find(r=>r.id===14).description=rows.find(r=>r.id===14).description.replace('USD 300,','USD 301,');},'UNRESOLVED_FLOW'],
    ['key amount',rows=>{rows.find(r=>r.id===14).description=rows.find(r=>r.id===14).description.replace('|USD|300.00','|USD|301.00');},'UNRESOLVED_FLOW'],
    ['cash amount',rows=>{rows.find(r=>r.id===14).amount=301;},'UNRESOLVED_FLOW'],
    ['unexpected foreign identifier',rows=>{rows.find(r=>r.id===14).foreign_identifier='SYNTHETIC_PRIVATE_CANARY';},'UNRESOLVED_FLOW'],
    ['duplicate cash ID',rows=>{rows.push(structuredClone(rows.find(r=>r.id===14)));},'IDENTITY'],
    ['duplicate memo key on a different cash ID',rows=>{rows.push({...structuredClone(rows.find(r=>r.id===14)),id:15});},'IDENTITY'],
  ];
  for(const[name,mutate,reason]of cases)await t.test(name,async t=>{
    const f=await fixture(t,{syncV3:true,bankWire:true,mutateCashRows:rows=>{if(rows.length)mutate(rows);}}),before={current:structuredClone(f.currentPayload),anchor:structuredClone(f.anchorPayload),
      data:Buffer.from(f.dataBytes),health:Buffer.from(f.healthBytes),economic:fs.readFileSync(f.config.economicSnapshot.sourcePath),files:fs.readdirSync(f.dir).sort()};
    const runtime=await createFeeSourceRevisionRuntime({plan:f.dailyPlan,admission:f.admission,economicSnapshot:f.config.economicSnapshot,
      sourceBytes:f.dataBytes,sourcePayload:f.currentPayload,healthBytes:f.healthBytes,githubToken:TOKEN,clientId:'synthetic-client',clientSecret:'synthetic-secret',
      keyText:f.key.toString('base64url'),baselineSha256:f.baselineSha256,legacySourcePath:null,fetchImpl:f.fetchImpl,clock:f.clock});
    t.after(()=>runtime.close());const expected='FEE_REPORT_SOURCE_REVISION_ARTIFACT_SOURCE_'+reason;
    await assert.rejects(runtime.prepare(),error=>{
      assert.equal(sourceRevisionRuntimeFailureCode(error),expected);assert.equal(error.message,expected);assert.equal(error.cause,undefined);
      const summary=safeProducerFailureSummary(error.message+'\n');assert.deepEqual(summary,{code:expected,diagnostic:null});
      for(const privateText of ['U1000001','ib.manual','bank wire','source bank','SYNTHETIC_PRIVATE_CANARY']){
        assert.ok(!JSON.stringify(error).includes(privateText));assert.ok(!JSON.stringify(summary).includes(privateText));
      }
      return true;
    });
    assert.ok(f.state.sourceCalls.length>0);const calls=f.state.sourceCalls.length;
    await assert.rejects(runtime.prepare(),/REUSE|CLOSED/);assert.equal(f.state.sourceCalls.length,calls);
    assert.deepEqual(f.currentPayload,before.current);assert.deepEqual(f.anchorPayload,before.anchor);
    assert.deepEqual(f.dataBytes,before.data);assert.deepEqual(f.healthBytes,before.health);
    assert.deepEqual(fs.readFileSync(f.config.economicSnapshot.sourcePath),before.economic);
    assert.deepEqual(fs.readdirSync(f.dir).sort(),before.files);
    assert.equal(fs.existsSync(path.join(f.dir,'writer')),false);assert.equal(fs.existsSync(path.join(f.dir,'ib-manager-input.json')),false);
  });
});

test('sync-cycle v2 refuses changed execution or publication state before account reads',async t=>{
  for(const[name,change]of [
    ['current run',s=>{s.currentRun.id++;}],['rerun',s=>{s.currentRun.run_attempt=2;}],
    ['wrong code',s=>{s.currentRun.head_sha=o('f');}],['finished execution',s=>{s.currentRun.status='completed';s.currentRun.conclusion='success';}],
    ['pending candidate',s=>{s.publication.pending=true;}],['changed published base',s=>{s.publication.data=Buffer.from('changed');}],
    ['changed main',s=>{s.publication.finalMainSha=o('f');}],
  ])await t.test(name,async t=>{
    const f=await fixture(t,{sync:true});await f.read();change(f.state);
    await rejection(f.cap.checkCurrent(),'PHASE_BASE_ADMISSION');await rejection(f.cap.checkCurrent(),'CLOSED');
    assert.equal(f.state.sourceCalls.length,0);
  });
});

test('sync-cycle v2 artifact adapter rejects mixed schemas and bindings before source access',async t=>{
  for(const change of [p=>{p.schema='fee-console.ib-source-revision-plan.v1';},p=>{p.bindings={...p.bindings,consumptionSha256:h('e')};},
    p=>{p.bindings={...p.bindings,executionSha256:h('f')};},p=>{p.bindings={...p.bindings,admissionModel:'consumption-v1'};}]){
    const f=await fixture(t,{sync:true}),v=await f.read(),plan=f.planOf(v);change(plan);
    await rejection(f.cap.prepareCandidate({plan,reader:f.reader}),'PLAN');assert.equal(f.state.sourceCalls.length,0);
  }
});

test('sync-cycle v3 rejects old execution, consumption and date bindings before source access',async t=>{
  const old=await fixture(t,{sync:true}),oldView=await old.read();
  assert.equal((await old.admission.checkCurrent()).contractId,SYNC_CONTRACT);
  for(const[name,change]of [
    ['old v2 execution',p=>{p.bindings={...p.bindings,executionSha256:oldView.bindings.executionSha256};}],
    ['consumption field',p=>{p.bindings={...p.bindings,consumptionSha256:h('e')};}],
    ['old schema',p=>{p.schema='fee-console.ib-source-revision-plan.v1';}],
    ['wrong target date',p=>{p.targetDate=P;}],
    ['wrong anchor date',p=>{p.anchorDate=B;}],
  ])await t.test(name,async t=>{
    const f=await fixture(t,{syncV3:true,bankWire:true}),view=await f.read(),plan=f.planOf(view);
    assert.notEqual(view.bindings.executionSha256,oldView.bindings.executionSha256);
    change(plan);await rejection(f.cap.prepareCandidate({plan,reader:f.reader}),'PLAN');
    assert.equal(f.state.sourceCalls.length,0);await rejection(f.cap.checkCurrent(),'CLOSED');
  });
  const wrongRead=await fixture(t,{syncV3:true,bankWire:true});
  await rejection(wrongRead.cap.readVerifiedArtifacts({targetDate:P,mainSha:MAIN}),'SCOPE');
  assert.equal(wrongRead.state.sourceCalls.length,0);assert.equal(wrongRead.state.calls.length,0);
  assert.deepEqual(await old.cap.checkCurrent(),oldView.bindings,'the independent old release remains valid within its original scope');
});

test('sync-cycle v3 and diagnostic admissions cannot cross artifact purposes',async t=>{
  for(const diagnostic of [true,false])await t.test(String(diagnostic),async t=>{
    const f=await fixture(t,diagnostic?{diagnostic:true}:{syncV3:true,bankWire:true}),config={...f.config};
    if(diagnostic)delete config.diagnosticOnly;else config.diagnosticOnly=true;
    const cap=createIbRevisionArtifacts(config);t.after(()=>cap.close());
    await rejection(cap.readVerifiedArtifacts({targetDate:T,mainSha:MAIN}),'ADMISSION');
    assert.equal(f.state.sourceCalls.length,0);assert.equal(f.state.calls.length,0);
  });
});

test('sync-cycle runtime preserves original encrypted-byte binding before new source reads',async t=>{
  const f=await fixture(t,{sync:true}),bad=Buffer.from(f.dataBytes);bad[bad.length-1]^=1;
  const runtime=await createFeeSourceRevisionRuntime({plan:f.dailyPlan,admission:f.admission,economicSnapshot:f.config.economicSnapshot,
    sourceBytes:bad,sourcePayload:f.currentPayload,healthBytes:f.healthBytes,githubToken:TOKEN,clientId:'synthetic-client',clientSecret:'synthetic-secret',
    keyText:f.key.toString('base64url'),baselineSha256:f.baselineSha256,legacySourcePath:null,fetchImpl:f.fetchImpl,clock:f.clock});
  t.after(()=>runtime.close());await assert.rejects(runtime.prepare(),/BASE_MISMATCH/);assert.equal(f.state.sourceCalls.length,0);
});

test('runtime refuses mismatched original ciphertext before any new source reads',async t=>{
  const f=await fixture(t),bad=Buffer.from(f.dataBytes);bad[bad.length-1]^=1;
  const runtime=await createFeeSourceRevisionRuntime({plan:f.dailyPlan,admission:f.admission,economicSnapshot:f.config.economicSnapshot,
    sourceBytes:bad,sourcePayload:f.currentPayload,healthBytes:f.healthBytes,githubToken:TOKEN,clientId:'synthetic-client',clientSecret:'synthetic-secret',
    keyText:f.key.toString('base64url'),baselineSha256:f.baselineSha256,legacySourcePath:null,fetchImpl:f.fetchImpl,clock:f.clock});
  t.after(()=>runtime.close());await assert.rejects(runtime.prepare(),/BASE_MISMATCH/);assert.equal(f.state.sourceCalls.length,0);
});

test('lookalikes, accessors and cloned admissions cannot authorize artifact or account reads',async t=>{
  const f=await fixture(t);let invoked=0;
  for(const [key,value]of [['github',{}],['economicSnapshot',{}],['dataKey',new Proxy(KEY,{})]])assert.throws(()=>createIbRevisionArtifacts({...f.config,[key]:value}),/CONFIG/);
  const options={...f.config};Object.defineProperty(options,'dataKey',{enumerable:true,get(){invoked++;return KEY;}});
  assert.throws(()=>createIbRevisionArtifacts(options),/CONFIG/);
  const proxy=new Proxy(f.config,{getPrototypeOf(){invoked++;return Object.prototype;}});assert.throws(()=>createIbRevisionArtifacts(proxy),/CONFIG/);
  for(const admission of [{checkCurrent(){invoked++;return true;}},new Proxy(f.admission,{get(){invoked++;}})]){
    const cap=createIbRevisionArtifacts({...f.config,admission});await rejection(cap.readVerifiedArtifacts({targetDate:T,mainSha:MAIN}),'ADMISSION');
  }
  assert.equal(invoked,0);assert.equal(f.state.calls.length,0);assert.equal(f.state.sourceCalls.length,0);
});

for(const[name,mutate,code]of [
  ['invalid signature',(p,v)=>{if(p==='commits/'+SCOPE.current.candidateSha)v.commit.verification.verified=false;return v;},'COMMIT'],
  ['current main carries a different pair',(p,v)=>{if(p==='git/trees/'+TREE)v.tree[0].sha=o('f');return v;},'CURRENT_PAIR'],
  ['ciphertext not the claimed Git blob',(p,v)=>{if(p.startsWith('contents/data.json'))v.content=Buffer.alloc(v.size,65).toString('base64');return v;},'ARTIFACT'],
  ['wrong producer head',(p,v)=>{if(p==='actions/runs/'+SCOPE.current.producerRunId)v.head_sha=o('f');return v;},'PRODUCER'],
  ['incomplete jobs page',(p,v)=>{if(p.endsWith('/jobs?per_page=100'))v.total_count++;return v;},'PRODUCER'],
  ['producer step did not succeed',(p,v)=>{if(p.endsWith('/jobs?per_page=100'))v.jobs[0].steps[0].conclusion='skipped';return v;},'PRODUCER'],
  ['candidate changes an extra root path',(p,v)=>{if(p==='git/trees/'+o('2'))v.tree.push({path:'other.txt',type:'blob',mode:'100644',sha:o('f'),size:1});return v;},'PRODUCER'],
  ['first-parent cycle',(p,v)=>p==='git/commits/'+MAIN?{sha:MAIN,parents:[{sha:MAIN}]}:v,'HISTORY'],
  ['candidate only on a side parent',(p,v)=>p==='git/commits/'+MAIN?{sha:MAIN,parents:[{sha:SOURCE_U},{sha:SCOPE.current.candidateSha}]}:p==='git/commits/'+SOURCE_U?{sha:SOURCE_U,parents:[{sha:MAIN}]}:v,'HISTORY'],
  ['history exceeds the bounded proof',(p,v)=>{if(p.startsWith('git/commits/')){const id=p.slice(12);return{sha:id,parents:[{sha:id===MAIN?'0'.repeat(39)+'1':(BigInt('0x'+id)+1n).toString(16).padStart(40,'0')}]};}return v;},'HISTORY'],
])test(name+' is refused without Sharesight IO',async t=>{
  const f=await fixture(t);f.state.mutate=mutate;await rejection(f.read(),code);assert.equal(f.state.sourceCalls.length,0);await rejection(f.read(),'CLOSED');
});

test('success metadata cannot replace the unique original producer log binding',async t=>{
  for(const log of ['2026-11-06T01:01:01.0000000Z candidate '+o('f')+'\n',
    ('2026-11-06T01:01:01.0000000Z candidate '+SCOPE.current.candidateSha+'\n').repeat(2),
    '2026-11-07T01:01:01.0000000Z candidate '+SCOPE.current.candidateSha+'\n']){
    const f=await fixture(t);f.state.log=log;await rejection(f.read(),'PRODUCER');assert.equal(f.state.sourceCalls.length,0);
  }
});

test('original fee, IB and health validation remain mandatory before account reads',async t=>{
  for(const[options,code]of [
    [{mutatePayload:p=>p.feeCalculationReceipt.receiptId=h('f')},'FEE_RECEIPT'],
    [{mutatePayload:p=>p.ibManagerReturnReceipt.grossTwrPpm++},'IB_STATE'],
    [{mutatePayload:p=>delete p.ibManagerSourceStatus},'IB_STATE'],
    [{mutateHealth:h=>h.dataSha256='f'.repeat(64)},'HEALTH'],
    [{mutateHealth:h=>h.sourceDates.webull=B},'HEALTH']
  ]){
    const f=await fixture(t,options);await rejection(f.read(),code);assert.equal(f.state.sourceCalls.length,0);
  }
});

test('native legacy v2 keeps its independent original-file guard and use-time recheck',async t=>{
  const f=await fixture(t,{legacy:true});assert.equal(f.economic.legacyV3Copy.schema,'fee-console.economic-v3-copy.v2');
  const missing=createIbRevisionArtifacts({...f.config,legacySourcePath:null});await rejection(missing.readVerifiedArtifacts({targetDate:T,mainSha:MAIN}),'LEGACY_SOURCE');
  assert.equal(f.state.sourceCalls.length,0);await f.read();assert.ok(await f.cap.checkCurrent());
  fs.appendFileSync(f.config.legacySourcePath,' ');await rejection(f.cap.checkCurrent(),'LEGACY_SOURCE');await rejection(f.cap.checkCurrent(),'CLOSED');
});

test('five-minute expiry, monotonic clock and economic changes revoke capability without resetting it',async t=>{
  for(const kind of ['expiry','clock','economic']){
    const f=await fixture(t);await f.read();
    if(kind==='expiry')f.state.now+=300000;else if(kind==='clock')f.state.now--;else f.state.economicRevision=o('f');
    await rejection(f.cap.checkCurrent(),kind==='expiry'?'EXPIRED':kind==='clock'?'CLOCK':'ECON_RECHECK_FROZEN_REVISION');
    await rejection(f.cap.checkCurrent(),'CLOSED');assert.equal(f.state.sourceCalls.length,0);
  }
});

test('foreign candidates and source-version changes cannot pass the original candidate check',async t=>{
  const f=await fixture(t),v=await f.read(),candidate=await f.cap.prepareCandidate({plan:f.planOf(v),reader:f.reader});
  await rejection(f.cap.verifyCandidate(structuredClone(candidate)),'CANDIDATE');await rejection(f.cap.verifyCandidate(candidate),'CLOSED');
  const g=await fixture(t),w=await g.read(),original=await g.cap.prepareCandidate({plan:g.planOf(w),reader:g.reader});
  g.state.sourceChanged=true;await rejection(g.cap.verifyCandidate(original),'SOURCE_RECHECK_RECORD_CHANGED');g.state.sourceChanged=false;
  await rejection(g.cap.verifyCandidate(original),'CLOSED');
});

test('exact plan and native reader are mandatory, and ordinary empty objects never trigger a fallback read',async t=>{
  for(const kind of ['plan','reader']){
    const f=await fixture(t),v=await f.read(),plan=f.planOf(v);let called=0;
    if(kind==='plan')plan.bindings={...plan.bindings,consumptionSha256:h('f')};
    const reader=kind==='reader'?{readStableWithEvidence(){called++;}}:f.reader;
    await rejection(f.cap.prepareCandidate({plan,reader}),kind==='plan'?'PLAN':'READER');assert.equal(called,0);assert.equal(f.state.sourceCalls.length,0);
  }
});

test('concurrent entry is refused and a closed pending read cannot return verified material',async t=>{
  const f=await fixture(t),pending=f.read();await rejection(f.read(),'BUSY');assert.ok(await pending);
  const g=await fixture(t),read=g.read();g.cap.close();await rejection(read,'CLOSED');assert.equal(g.state.sourceCalls.length,0);
});

test('native source failures retain a finite reason code while forged messages cannot escape',async t=>{
  const f=await fixture(t),v=await f.read();
  f.reader.fetch=async(url,init)=>{const r=await f.fetchImpl(url,init);if(url.includes('cash_account_transactions')){const b=await r.json();b.cash_account_transactions.pop();return response(url,b);}return r;};
  await rejection(f.cap.prepareCandidate({plan:f.planOf(v),reader:f.reader}),'SOURCE_CASH_RECONCILIATION');
  for(const error of [Error('IB_REVISION_SOURCE_REFUSED_IB_SOURCE_PRIVATE_CANARY'),new Proxy({}, {get(){assert.fail('must not inspect');}})])assert.equal(ibRevisionArtifactFailureCode(error),'IB_REVISION_ARTIFACT_REFUSED');
});

// The reader's fixed cash-reconciliation site/date-role must survive every
// wrapper without changing any public code, and only for the genuine error.
const cashCode='FEE_REPORT_SOURCE_REVISION_ARTIFACT_SOURCE_CASH_RECONCILIATION';
const dropCashTransaction=f=>{f.reader.fetch=async(url,init)=>{const r=await f.fetchImpl(url,init);if(url.includes('cash_account_transactions')){const b=await r.json();b.cash_account_transactions.pop();return response(url,b);}return r;};};
test('artifact capability keeps the reader cash site and date-role beside the unchanged SOURCE_CASH_RECONCILIATION code',async t=>{
  const f=await fixture(t),v=await f.read();dropCashTransaction(f);let error;
  await assert.rejects(f.cap.prepareCandidate({plan:f.planOf(v),reader:f.reader}),e=>{error=e;return true;});
  assert.equal(ibRevisionArtifactFailureCode(error),'IB_REVISION_ARTIFACT_SOURCE_CASH_RECONCILIATION');
  assert.equal(error.message,'IB_REVISION_ARTIFACT_SOURCE_CASH_RECONCILIATION');assert.equal(error.cause,undefined);assert.equal(JSON.stringify(error),'{}');
  assert.equal(ibRevisionArtifactCashSite(error),'TRADE_NORMALIZATION_SCOPE');assert.equal(ibRevisionArtifactCashDateRole(error),'PROOF');
  assert.ok(IB_CASH_RECONCILIATION_SITES.includes(ibRevisionArtifactCashSite(error)));assert.ok(IB_CASH_DATE_ROLES.includes(ibRevisionArtifactCashDateRole(error)));
  // Other artifact failures, copies and hostile values report only the defaults.
  await rejection(f.cap.checkCurrent(),'CLOSED');
  let touched=0;const revoked=Proxy.revocable({},{});revoked.revoke();
  for(const value of [undefined,null,'TRADE_NORMALIZATION_SCOPE',Error(error.message),structuredClone({message:error.message}),new Proxy(error,{get(){touched++;throw Error('PRIVATE_CANARY');}}),revoked.proxy,
    Object.defineProperty({},'cashSite',{get(){touched++;throw Error('PRIVATE_CANARY');}})]){
    assert.equal(ibRevisionArtifactCashSite(value),'UNCLASSIFIED');assert.equal(ibRevisionArtifactCashDateRole(value),'NONE');
    assert.equal(sourceRevisionRuntimeCashSite(value),'UNCLASSIFIED');assert.equal(sourceRevisionRuntimeCashDateRole(value),'NONE');
  }
  assert.equal(touched,0);
  const g=await fixture(t);g.state.transport=route=>route==='git/ref/heads/main'?new Response('private upstream detail',{status:403,headers:{'content-type':'application/json'}}):undefined;
  let other;await assert.rejects(g.read(),e=>{other=e;return true;});
  assert.notEqual(ibRevisionArtifactFailureCode(other),'IB_REVISION_ARTIFACT_SOURCE_CASH_RECONCILIATION');
  assert.equal(ibRevisionArtifactCashSite(other),'UNCLASSIFIED');assert.equal(ibRevisionArtifactCashDateRole(other),'NONE');
});
test('diagnostic runtime and final CLI result carry the fixed cash site and date-role, then clean up, for the genuine refusal only',async t=>{
  for(const contract of ['diagnostic','diagnosticV2','diagnosticV3','diagnosticV4'])await t.test(contract,async t=>{
    const f=await fixture(t,{[contract]:true,bankWire:true}),options=diagnosticRuntimeOptions(f);
    options.fetchImpl=async(url,init)=>{const r=await f.fetchImpl(url,init);if(url.includes('cash_account_transactions')){const b=await r.json();b.cash_account_transactions.pop();return response(url,b);}return r;};
    const before={data:Buffer.from(f.dataBytes),health:Buffer.from(f.healthBytes),files:fs.readdirSync(f.dir).sort()};
    const runtime=await createFeeSourceRevisionRuntime(options);let error;
    await assert.rejects(runtime.diagnose(),e=>{error=e;return true;});
    assert.equal(sourceRevisionRuntimeFailureCode(error),cashCode);assert.equal(error.message,cashCode);assert.equal(error.cause,undefined);
    assert.equal(JSON.stringify(error),'{}');assert.equal(Object.hasOwn(error,'cashSite'),false);
    assert.equal(sourceRevisionRuntimeCashSite(error),'TRADE_NORMALIZATION_SCOPE');assert.equal(sourceRevisionRuntimeCashDateRole(error),'PROOF');
    assert.equal(revisionDiagnosticFailureCode(error),cashCode);assert.equal(safeProducerFailureSummary(cashCode+'\n').code,cashCode);
    await assert.rejects(runtime.diagnose(),/REUSE|CLOSED/);
    assert.deepEqual(f.dataBytes,before.data);assert.deepEqual(f.healthBytes,before.health);assert.deepEqual(fs.readdirSync(f.dir).sort(),before.files);
    // Final CLI boundary: the same error through inspectRevisionDiagnostic.
    const trace=[],h={checkOnly:false,assertCurrent(){},checkCheckout(){trace.push('checkout');},async authorize(){trace.push('authorize');return {async checkCurrent(){},close(){trace.push('cap-close');}};},
      async readPrivate(){trace.push('private');return {};},async createRuntime(){trace.push('runtime');return {async diagnose(){trace.push('diagnose');throw error;},close(){trace.push('runtime-close');}};},async cleanup(){trace.push('cleanup');}};
    const r=await inspectRevisionDiagnostic(h);
    assert.deepEqual(r,{schema:'fee-console.source-revision-diagnostic-result.v1',status:'incomplete',targetDate:T,reasonCode:cashCode,reportGenerated:false,publicationReady:false,
      cashSite:'TRADE_NORMALIZATION_SCOPE',cashDateRole:'PROOF'});
    assert.ok(Object.isFrozen(r));assert.deepEqual(trace.slice(-3),['runtime-close','cap-close','cleanup']);
    for(const secret of ['PRIVATE','synthetic-client','synthetic-secret',TOKEN,ID,'api.sharesight.com'])assert.equal(JSON.stringify(r).includes(secret),false,secret);
    // The same code without runtime provenance, or a cleanup failure, adds no location.
    for(const [name,thrown,cleanup] of [['forged',Error(cashCode),h.cleanup],['forged-with-fields',Object.assign(Error(cashCode),{cashSite:'TRADE_NORMALIZATION_SCOPE',cashDateRole:'PROOF'}),h.cleanup],['cleanup-failed',error,async()=>{throw Error('PRIVATE_CANARY');}]]){
      const r2=await inspectRevisionDiagnostic({...h,cleanup,async createRuntime(){return {async diagnose(){throw thrown;},close(){}};}});
      assert.equal(r2.status,'incomplete',name);assert.equal(Object.hasOwn(r2,'cashSite'),false,name);assert.equal(Object.hasOwn(r2,'cashDateRole'),false,name);
      assert.equal(r2.reasonCode,name==='cleanup-failed'?'FEE_REVISION_DIAGNOSTIC_CLEANUP':cashCode,name);
    }
  });
});

test('historical JSON failures retain fixed request stage and role without response or exception contents',async t=>{
  const cases=[
    ['base main','git/ref/heads/main','BASE_MAIN'],
    ['base history','git/commits/'+MAIN,'BASE_HISTORY'],
    ['current commit','commits/'+SCOPE.current.candidateSha,'CURRENT_COMMIT'],
    ['current data','contents/data.json?ref='+SCOPE.current.candidateSha,'CURRENT_DATA'],
    ['anchor data','contents/data.json?ref='+SCOPE.anchor.candidateSha,'ANCHOR_DATA'],
    ['anchor run','actions/runs/'+SCOPE.anchor.producerRunId,'ANCHOR_RUN'],
  ];
  for(const[name,route,stage]of cases)await t.test(name,async t=>{
    const f=await fixture(t,{sync:true});let attempted=0;
    f.state.transport=(p,url)=>{if(p!==route)return;attempted++;
      const r=new Response(JSON.stringify({message:'PRIVATE_ACCOUNT_TOKEN_URL'}),{status:403,headers:{'content-type':'application/json'}});
      Object.defineProperty(r,'url',{value:url});return r;};
    await rejection(f.read(),'GITHUB_'+stage+'_HTTP_FORBIDDEN');
    assert.equal(attempted,1);assert.equal(f.state.sourceCalls.length,0);
    await rejection(f.read(),'CLOSED');assert.equal(attempted,1);
  });
});

test('original current and anchor month locks remain blocking and now identify the affected role',async t=>{
  for(const[date,role]of [[P,'CURRENT'],[U,'ANCHOR']])await t.test(role,async t=>{
    const f=await fixture(t,{sync:true,mutatePayload:(payload,d)=>{
      if(d===date)payload.feeReportMonthLocks={schema:'fee-console.report-month-locks.v1',periods:[{ym:'2026-10',digest:h('a')}]};
    }});
    await rejection(f.read(),'PHASE_'+role+'_MONTH_LOCKS');
    assert.equal(f.state.sourceCalls.length,0);await rejection(f.read(),'CLOSED');
  });
});

test('a genuine nonempty closed-month lock survives artifact validation and the encrypted revision writer',async t=>{
  const f=await fixture(t,{sync:true,lockedMonth:true}),view=await f.read();
  assert.equal(view.currentPayload.feeReportMonthLocks.periods.length,1);
  assert.equal(view.anchorPayload.feeReportMonthLocks.periods.length,1);
  const candidate=await f.cap.prepareCandidate({plan:f.planOf(view),reader:f.reader});
  const {result}=await writeVerifiedRevision(f,{candidate,artifacts:f.cap,basePayload:view.currentPayload});
  assert.deepEqual(result.feeReportMonthLocks,f.currentPayload.feeReportMonthLocks);
  assert.equal(await f.cap.verifyCandidate(candidate),true);
});

test('a changed execution is diagnosed at admission without re-reading the source',async t=>{
  const f=await fixture(t,{sync:true});f.state.currentRun.run_attempt=2;
  await rejection(f.read(),'PHASE_BASE_ADMISSION');
  assert.equal(f.state.calls.length,0);assert.equal(f.state.sourceCalls.length,0);
});

test('post-capture local checks are not misreported as Sharesight network failures',async t=>{
  for(const kind of ['admission','github'])await t.test(kind,async t=>{
    const f=await fixture(t,{sync:true}),view=await f.read();
    if(kind==='admission'){
      const original=f.reader.fetch;
      f.reader.fetch=async(...args)=>{const result=await original(...args);f.state.currentRun.run_attempt=2;return result;};
    }else{
      f.state.transport=(route,url)=>{
        if(!f.state.sourceCalls.length||route!=='git/ref/heads/main')return;
        const result=new Response('{"message":"PRIVATE_CANARY"}',{status:403,headers:{'content-type':'application/json'}});
        Object.defineProperty(result,'url',{value:url});return result;
      };
    }
    await rejection(f.cap.prepareCandidate({plan:f.planOf(view),reader:f.reader}),
      kind==='admission'?'PHASE_BASE_ADMISSION':'GITHUB_BASE_MAIN_HTTP_FORBIDDEN');
    assert(f.state.sourceCalls.length>0);await rejection(f.cap.checkCurrent(),'CLOSED');
  });
});

test('runtime and public summary preserve only the finite artifact diagnostics end to end',async t=>{
  const f=await fixture(t,{sync:true}),runtime=await createFeeSourceRevisionRuntime({plan:f.dailyPlan,admission:f.admission,economicSnapshot:f.config.economicSnapshot,
    sourceBytes:f.dataBytes,sourcePayload:f.currentPayload,healthBytes:f.healthBytes,githubToken:TOKEN,clientId:'synthetic-client',clientSecret:'synthetic-secret',
    keyText:f.key.toString('base64url'),baselineSha256:f.baselineSha256,legacySourcePath:null,fetchImpl:f.fetchImpl,clock:f.clock});
  t.after(()=>runtime.close());
  f.state.transport=route=>{if(route==='contents/data.json?ref='+SCOPE.current.candidateSha)throw Error('PRIVATE_ACCOUNT_TOKEN_URL');};
  const expected='FEE_REPORT_SOURCE_REVISION_ARTIFACT_GITHUB_CURRENT_DATA_JSON_NETWORK';
  await assert.rejects(runtime.prepare(),error=>{
    assert.equal(sourceRevisionRuntimeFailureCode(error),expected);
    assert.equal(safeProducerFailureSummary(error.message+'\n').code,expected);
    assert.equal(error.cause,undefined);assert(!JSON.stringify(error).includes('PRIVATE'));return true;
  });
  assert.equal(f.state.sourceCalls.length,0);await assert.rejects(runtime.prepare(),/REUSE/);
  for(const suffix of IB_REVISION_ARTIFACT_DIAGNOSTIC_CODES){
    const code='FEE_REPORT_SOURCE_REVISION_ARTIFACT_'+suffix;
    assert.match(code,/^FEE_REPORT_[A-Z_]{1,64}$/);
    assert.equal(safeProducerFailureSummary(code+'\n').code,code);
  }
  for(const code of ['FEE_REPORT_SOURCE_REVISION_ARTIFACT_GITHUB_CURRENT_DATA_PRIVATE_ACCOUNT',
    'FEE_REPORT_SOURCE_REVISION_ARTIFACT_PHASE_PRIVATE_VALUE',expected+'_SECRET'])
    assert.notEqual(safeProducerFailureSummary(code+'\n').code,code);
});

// The diagnostic path runs the same original/source checks, but its capability
// cannot enter a writer and its caller never receives a prepared private object.
const diagnosticRuntimeOptions=f=>({diagnosticOnly:true,plan:f.dailyPlan,admission:f.admission,economicSnapshot:f.config.economicSnapshot,
  sourceBytes:f.dataBytes,sourcePayload:f.currentPayload,healthBytes:f.healthBytes,githubToken:TOKEN,clientId:'synthetic-client',clientSecret:'synthetic-secret',
  keyText:f.key.toString('base64url'),baselineSha256:f.baselineSha256,legacySourcePath:null,fetchImpl:f.fetchImpl,clock:f.clock});

// Native reader/runtime/artifact chain, with synthetic per-response metadata.
const metadataDiagnosticFetch=(f,typeDrift=false)=>{
  let round=0,responseId=0;
  return async(url,init)=>{
    if(url==='https://api.sharesight.com/oauth2/token')round++;
    const r=await f.fetchImpl(url,init);
    if(!url.startsWith('https://api.sharesight.com/api/v3/'))return r;
    const body=JSON.parse(await r.text());
    body.api_transaction={id:typeDrift&&round>=2?'synthetic-wrong-type':++responseId,timestamp:'synthetic-response-'+responseId};
    return response(url,body);
  };
};
const productionRuntimeOptions=f=>{const options=diagnosticRuntimeOptions(f);delete options.diagnosticOnly;return options;};
for(const v5 of [false,true])test('production sync-v'+(v5?'5':'4')+' passes native admission, metadata comparison, historical artifacts and the actual encrypted writer',async t=>{
  const f=await fixture(t,{...(v5?{syncV5:true}:{syncV4:true}),lockedMonth:true,bankWire:true}),before={data:Buffer.from(f.dataBytes),health:Buffer.from(f.healthBytes),
    current:structuredClone(f.currentPayload),anchor:structuredClone(f.anchorPayload),econ:fs.readFileSync(f.config.economicSnapshot.sourcePath)};
  const runtime=await createFeeSourceRevisionRuntime({...productionRuntimeOptions(f),fetchImpl:metadataDiagnosticFetch(f)});t.after(()=>runtime.close());
  const revision=await runtime.prepare(),candidate=revision.candidate;
  assert.equal((await f.admission.checkCurrent()).contractId,v5?SYNC_V5_CONTRACT:SYNC_V4_CONTRACT);assert.equal(isHistoricalRevisionDiagnosticAdmission(f.admission),false);
  assert.equal(candidate.plan.schema,'fee-console.ib-source-revision-plan.v2');assert.equal(candidate.plan.bindings.admissionModel,'sync-cycle-v1');
  assert.equal(Object.hasOwn(candidate.plan.bindings,'consumptionSha256'),false);assert.equal(isIbRevisionArtifacts(revision.artifacts),true);
  assert.deepEqual(candidate.changedHistoricalDates,[P]);assert.equal(candidate.oldThrough,P);assert.equal(candidate.targetDate,T);
  assert.equal(candidate.publicationReady,false);assert.equal(candidate.executionAuthorized,false);
  assert.deepEqual(candidate.replacement.sourceState.source.cashFlowByDate,{[P]:300});
  assert.deepEqual(candidate.superseded.sourceState,before.current.ibManagerSourceState);
  assert.deepEqual(candidate.acceptedAnchor.sourceState,before.anchor.ibManagerSourceState);
  const {result}=await writeVerifiedRevision(f,revision);assert.equal(await runtime.checkCurrent(),true);
  assert.equal(result.ibManagerReturnReceipt.asOf,T);assert.equal(result.feeCalculationReceipt.asOf,T);
  if(v5){assert(f.state.publicationRequests.length>=60);assert.equal(process.env.GITHUB_TOKEN,undefined);}
  const marker=['ALLOWED_ROOT_TRANSACTION_METADATA'];
  assert.deepEqual(ibRevisionArtifactSuccessEvidence(revision.artifacts),{capture:{HOLD:marker,PERF:marker,TRADE:marker},
    currentness:{HOLD:marker,PERF:marker,TRADE:marker},currentnessCoverage:'ALL_RECORDS'});
  assert(![...f.state.calls,...f.state.admissionCalls].some(p=>p.startsWith('actions/workflows/')||p.includes('filter=all')));
  await assert.rejects(runtime.prepare(),/REUSE/);
  f.state.sourceChanged=true;await assert.rejects(runtime.checkCurrent(),e=>{
    assert.equal(sourceRevisionRuntimeFailureCode(e),'FEE_REPORT_SOURCE_REVISION_ARTIFACT_SOURCE_RECHECK_RECORD_CHANGED');return true;
  });
  assert.equal(isHistoricalRevisionAdmission(f.admission),false);await assert.rejects(runtime.checkCurrent(),/CLOSED/);
  assert.deepEqual(f.dataBytes,before.data);assert.deepEqual(f.healthBytes,before.health);
  assert.deepEqual(f.currentPayload,before.current);assert.deepEqual(f.anchorPayload,before.anchor);
  assert.deepEqual(fs.readFileSync(f.config.economicSnapshot.sourcePath),before.econ);
});
test('production sync-v4 refuses metadata types, business amount changes and five-minute expiry before writer handoff',async t=>{
  for(const kind of ['metadata-type','business-amount','expiry'])await t.test(kind,async t=>{
    const f=await fixture(t,{syncV4:true,bankWire:true,mutateCashRows:rows=>{if(kind==='business-amount'){const transfer=rows.find(r=>r.id===14);if(transfer)transfer.amount=301;}}});
    const options={...productionRuntimeOptions(f),fetchImpl:metadataDiagnosticFetch(f,kind==='metadata-type')};
    if(kind==='expiry'){let calls=0;f.state.transport=()=>{if(++calls===2)f.state.now+=300000;};}
    const before={data:Buffer.from(f.dataBytes),health:Buffer.from(f.healthBytes),files:fs.readdirSync(f.dir).sort()};
    const runtime=await createFeeSourceRevisionRuntime(options);t.after(()=>runtime.close());
    await assert.rejects(runtime.prepare(),e=>{
      const code=sourceRevisionRuntimeFailureCode(e);
      assert.match(code,kind==='metadata-type'?/^FEE_REPORT_SOURCE_REVISION_ARTIFACT_SOURCE_CAPTURE_RECORDS_/
        :kind==='business-amount'?/^FEE_REPORT_SOURCE_REVISION_ARTIFACT_SOURCE_UNRESOLVED_FLOW$/:/EXPIRED$/);
      assert.doesNotMatch(JSON.stringify(e),/synthetic-wrong-type|api_transaction/);return true;
    });
    assert.equal(isHistoricalRevisionAdmission(f.admission),false);
    await assert.rejects(runtime.prepare(),/REUSE|CLOSED/);
    assert.deepEqual(f.dataBytes,before.data);assert.deepEqual(f.healthBytes,before.health);assert.deepEqual(fs.readdirSync(f.dir).sort(),before.files);
  });
});
test('authentic production sync-v4/v5 and diagnostic-v8 cannot cross runtime or artifact purposes',async t=>{
  for(const mode of ['v4','v5','diagnostic'])await t.test(mode,async t=>{
    const production=mode!=='diagnostic',f=await fixture(t,mode==='v4'?{syncV4:true}:mode==='v5'?{syncV5:true}:{diagnosticV8:true});
    const options=production?diagnosticRuntimeOptions(f):productionRuntimeOptions(f);
    await assert.rejects(createFeeSourceRevisionRuntime(options),/ADMISSION/);
    const config={...f.config};if(production)config.diagnosticOnly=true;else delete config.diagnosticOnly;
    const cap=createIbRevisionArtifacts(config);t.after(()=>cap.close());await rejection(cap.readVerifiedArtifacts({targetDate:T,mainSha:MAIN}),'ADMISSION');
    assert.equal(f.state.calls.length,0);assert.equal(f.state.sourceCalls.length,0);
  });
});
test('diagnostic v8 reaches native runtime/artifacts with lexical v4 metadata values and no writer handoff',async t=>{
  const f=await fixture(t,{diagnosticV8:true,lockedMonth:true});
  assert.equal(isHistoricalRevisionAdmission(f.admission),false);assert.equal(isIbRevisionArtifacts(f.cap),false);
  const before={data:Buffer.from(f.dataBytes),health:Buffer.from(f.healthBytes),econ:fs.readFileSync(f.config.economicSnapshot.sourcePath),files:fs.readdirSync(f.dir).sort()};
  const runtime=await createFeeSourceRevisionRuntime({...diagnosticRuntimeOptions(f),fetchImpl:metadataDiagnosticFetch(f)});
  assert.deepEqual(Object.keys(runtime).sort(),['close','diagnose']);
  const result=await runtime.diagnose(),marker=['ALLOWED_ROOT_TRANSACTION_METADATA'];
  assert.deepEqual(result,{schema:'fee-console.source-revision-diagnostic-result.v1',status:'verified',targetDate:T,
    sourceEvidence:{capture:{HOLD:marker,PERF:marker,TRADE:marker},currentness:{HOLD:marker,PERF:marker,TRADE:marker},currentnessCoverage:'ALL_RECORDS'}});
  assert.equal(isHistoricalRevisionDiagnosticAdmission(f.admission),false);
  assert.deepEqual(f.dataBytes,before.data);assert.deepEqual(f.healthBytes,before.health);
  assert.deepEqual(fs.readFileSync(f.config.economicSnapshot.sourcePath),before.econ);assert.deepEqual(fs.readdirSync(f.dir).sort(),before.files);
  assert(f.state.sourceCalls.every(c=>c.method==='GET'||c.method==='POST'&&c.p==='/oauth2/token'));
  assert(![...f.state.calls,...f.state.admissionCalls].some(p=>p.startsWith('actions/workflows/')||p.includes('filter=all')));
  await assert.rejects(runtime.diagnose(),/REUSE|CLOSED/);
});
test('diagnostic v8 artifacts cannot enter the actual writer or either production capability',async t=>{
  const f=await fixture(t,{diagnosticV8:true}),view=await f.read(),candidate=await f.cap.prepareCandidate({plan:f.planOf(view),reader:f.reader});
  await assert.rejects(prepareIbManagerReport({payload:f.currentPayload,targetDate:T,outputDir:f.dir,
    environ:{IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:f.baselineSha256},clock:f.clock,
    revision:{candidate,artifacts:f.cap},revisionBasePayload:view.currentPayload}),/IB_REPORT_INPUT_REFUSED/);
  assert.equal(isIbRevisionArtifacts(f.cap),false);assert(!fs.existsSync(path.join(f.dir,'ib-manager-input.json')));
  const options=diagnosticRuntimeOptions(f);delete options.diagnosticOnly;
  const calls=f.state.calls.length,sourceCalls=f.state.sourceCalls.length;
  await assert.rejects(createFeeSourceRevisionRuntime(options),/ADMISSION/);
  const config={...f.config};delete config.diagnosticOnly;const production=createIbRevisionArtifacts(config);t.after(()=>production.close());
  await rejection(production.readVerifiedArtifacts({targetDate:T,mainSha:MAIN}),'ADMISSION');
  assert.equal(f.state.calls.length,calls);assert.equal(f.state.sourceCalls.length,sourceCalls);
});
test('diagnostic v8 preserves metadata type refusal and the exact five-minute artifact expiry',async t=>{
  for(const kind of ['metadata-type','expiry'])await t.test(kind,async t=>{
    const f=await fixture(t,{diagnosticV8:true}),options=diagnosticRuntimeOptions(f);
    if(kind==='metadata-type')options.fetchImpl=metadataDiagnosticFetch(f,true);
    else{let calls=0;f.state.transport=()=>{if(++calls===2)f.state.now+=300000;};}
    const runtime=await createFeeSourceRevisionRuntime(options);
    await assert.rejects(runtime.diagnose(),e=>{
      const code=sourceRevisionRuntimeFailureCode(e);
      assert.match(code,kind==='metadata-type'?/^FEE_REPORT_SOURCE_REVISION_ARTIFACT_SOURCE_CAPTURE_RECORDS_/:/EXPIRED$/);
      assert.doesNotMatch(JSON.stringify(e),/synthetic-wrong-type|api_transaction/);return true;
    });
    assert.equal(isHistoricalRevisionDiagnosticAdmission(f.admission),false);
    await assert.rejects(runtime.diagnose(),/REUSE|CLOSED/);
  });
});

test('diagnostic runtime has no writer handoff, closes its separate admission and leaves original bytes unchanged',async t=>{
  const f=await fixture(t,{diagnostic:true,lockedMonth:true});
  assert.equal(isHistoricalRevisionAdmission(f.admission),false);assert.equal(isHistoricalRevisionDiagnosticAdmission(f.admission),true);
  assert.equal(isIbRevisionArtifacts(f.cap),false);
  const before={data:Buffer.from(f.dataBytes),health:Buffer.from(f.healthBytes),econ:fs.readFileSync(f.config.economicSnapshot.sourcePath),files:fs.readdirSync(f.dir).sort()};
  const runtime=await createFeeSourceRevisionRuntime(diagnosticRuntimeOptions(f));
  assert.deepEqual(Object.keys(runtime).sort(),['close','diagnose']);
  const result=await runtime.diagnose();
  assert.deepEqual(result,{schema:'fee-console.source-revision-diagnostic-result.v1',status:'verified',targetDate:T,sourceEvidence:{capture:{},currentness:{},currentnessCoverage:'ALL_RECORDS'}},'explicit evidence: no exception used');
  assert.equal(Object.isFrozen(result),true);assert.equal(isHistoricalRevisionDiagnosticAdmission(f.admission),false);
  assert.deepEqual(f.dataBytes,before.data);assert.deepEqual(f.healthBytes,before.health);assert.deepEqual(fs.readFileSync(f.config.economicSnapshot.sourcePath),before.econ);
  assert.deepEqual(fs.readdirSync(f.dir).sort(),before.files);
  assert.ok(f.state.sourceCalls.some(c=>c.method==='GET'));
  assert.ok(f.state.sourceCalls.every(c=>c.method==='GET'||c.method==='POST'&&c.p==='/oauth2/token'));
  assert.ok(![...f.state.calls,...f.state.admissionCalls].some(p=>p.startsWith('actions/workflows/')||p.includes('filter=all')));
  await assert.rejects(runtime.diagnose(),/REUSE|CLOSED/);
});

test('diagnostic artifact is rejected by the actual writer even with an authentic candidate',async t=>{
  const f=await fixture(t,{diagnostic:true}),view=await f.read();
  const candidate=await f.cap.prepareCandidate({plan:f.planOf(view),reader:f.reader});
  assert.equal(isIbRevisionArtifacts(f.cap),false);
  await assert.rejects(prepareIbManagerReport({payload:f.currentPayload,targetDate:T,outputDir:f.dir,
    environ:{IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:f.baselineSha256},clock:f.clock,
    revision:{candidate,artifacts:f.cap},revisionBasePayload:view.currentPayload}),/IB_REPORT_INPUT_REFUSED/);
  assert.ok(!fs.existsSync(path.join(f.dir,'ib-manager-input.json')));
});

test('production and diagnostic admissions cannot cross modes before artifact or account IO',async t=>{
  for(const diagnostic of [true,false])await t.test(String(diagnostic),async t=>{
    const f=await fixture(t,{diagnostic,sync:true}),options=diagnosticRuntimeOptions(f);
    if(diagnostic)delete options.diagnosticOnly;
    await assert.rejects(createFeeSourceRevisionRuntime(options),/ADMISSION/);
    const config={...f.config};if(diagnostic)delete config.diagnosticOnly;else config.diagnosticOnly=true;
    const cap=createIbRevisionArtifacts(config);
    await rejection(cap.readVerifiedArtifacts({targetDate:T,mainSha:MAIN}),'ADMISSION');
    assert.equal(f.state.calls.length,0);assert.equal(f.state.sourceCalls.length,0);
  });
});

test('diagnostic refuses changed metadata, times out and closes without returning private data',async t=>{
  for(const failure of ['github','expired','source'])await t.test(failure,async t=>{
    const f=await fixture(t,{diagnostic:true}),options=diagnosticRuntimeOptions(f);
    if(failure==='github')f.state.transport=route=>route==='git/ref/heads/main'?new Response('private upstream detail',{status:403,headers:{'content-type':'application/json'}}):undefined;
    if(failure==='expired'){let count=0;f.state.transport=()=>{if(++count===2)f.state.now+=300001;};}
    if(failure==='source')options.fetchImpl=async(url,init)=>{
      if(url.includes('/holdings'))f.state.sourceChanged=!f.state.sourceChanged;
      return f.fetchImpl(url,init);
    };
    const runtime=await createFeeSourceRevisionRuntime(options);
    await assert.rejects(runtime.diagnose(),e=>{const code=sourceRevisionRuntimeFailureCode(e),summary=safeProducerFailureSummary(code);assert.equal(summary.code,code);assert.equal(summary.diagnostic,null);assert.ok(!JSON.stringify(summary).includes('private'));return true;});
    assert.equal(isHistoricalRevisionDiagnosticAdmission(f.admission),false);
    await assert.rejects(runtime.diagnose(),/REUSE|CLOSED/);
  });
});

// Every failure below follows native snapshot acquisition and the original
// artifact checks. No private source or exception text enters a public result.
test('economic FIRST and RECHECK distinguish fixed transport, version and local integrity failures',async t=>{
  for(const stage of ['FIRST','RECHECK'])for(const [kind,reason] of [
    ['revision','FROZEN_REVISION'],['bytes','LOCAL_BYTES'],['mode','LOCAL_MODE'],['closed','CLOSED'],
    ['401','AUTH'],['403','FORBIDDEN'],['429','HTTP'],['network','NETWORK'],['timeout','TIMEOUT'],['json','RESPONSE']
  ])await t.test(stage+' '+kind,async t=>{
    const f=await fixture(t,{diagnosticV2:true});if(stage==='RECHECK')await f.read();
    const before={data:Buffer.from(f.dataBytes),health:Buffer.from(f.healthBytes),calls:f.state.sourceCalls.length,reads:f.state.economicReads};
    if(kind==='revision')f.state.economicRevision=o('f');
    else if(kind==='bytes')fs.appendFileSync(f.config.economicSnapshot.sourcePath,' ');
    else if(kind==='mode')fs.chmodSync(f.config.economicSnapshot.sourcePath,0o644);
    else if(kind==='closed')f.config.economicSnapshot.cleanup();
    else f.state.economicTransport=async()=>{
      if(kind==='network')throw Error('PRIVATE_ACCOUNT_TOKEN_URL');
      if(kind==='timeout')return new Promise(()=>{});
      if(kind==='json')return new Response('PRIVATE_ACCOUNT_TOKEN_URL',{headers:{etag:'"synthetic"'}});
      return new Response('PRIVATE_ACCOUNT_TOKEN_URL',{status:Number(kind)});
    };
    const code='ECON_'+stage+'_'+reason;
    await assert.rejects(stage==='FIRST'?f.read():f.cap.checkCurrent(),error=>{
      assert.equal(ibRevisionArtifactFailureCode(error),'IB_REVISION_ARTIFACT_'+code);
      assert(!error.message.includes('PRIVATE'));assert.equal(error.cause,undefined);return true;
    });
    assert.deepEqual(f.dataBytes,before.data);assert.deepEqual(f.healthBytes,before.health);
    assert.equal(f.state.sourceCalls.length,before.calls);
    if(['bytes','mode','closed'].includes(kind))assert.equal(f.state.economicReads,before.reads);
    await rejection(f.cap.checkCurrent(),'CLOSED');
  });
});

test('diagnostic-v2 emits economic reasons through runtime and CLI without writer capability',async t=>{
  const f=await fixture(t,{diagnosticV2:true,bankWire:true});
  const runtime=await createFeeSourceRevisionRuntime(diagnosticRuntimeOptions(f));
  f.state.economicRevision=o('f');
  const code='FEE_REPORT_SOURCE_REVISION_ARTIFACT_ECON_FIRST_FROZEN_REVISION';
  await assert.rejects(runtime.diagnose(),error=>{
    assert.equal(sourceRevisionRuntimeFailureCode(error),code);
    assert.equal(revisionDiagnosticFailureCode(error),code);
    assert.equal(safeProducerFailureSummary(code).code,code);return true;
  });
  assert.equal(isIbRevisionArtifacts(f.cap),false);assert.equal(f.state.sourceCalls.length,0);
  await assert.rejects(runtime.diagnose(),/REUSE|CLOSED/);
});

test('new exact diagnostic release walks the complete Jenny preparation and recheck without publication',async t=>{
 for(const contract of ['diagnosticV2','diagnosticV3','diagnosticV4'])await t.test(contract,async t=>{
  const f=await fixture(t,{[contract]:true,bankWire:true,lockedMonth:true});
  const before={data:Buffer.from(f.dataBytes),health:Buffer.from(f.healthBytes),econ:fs.readFileSync(f.config.economicSnapshot.sourcePath),files:fs.readdirSync(f.dir).sort()};
  const runtime=await createFeeSourceRevisionRuntime(diagnosticRuntimeOptions(f));
  assert.deepEqual(await runtime.diagnose(),{schema:'fee-console.source-revision-diagnostic-result.v1',status:'verified',targetDate:T,sourceEvidence:{capture:{},currentness:{},currentnessCoverage:'ALL_RECORDS'}});
  assert.equal(isHistoricalRevisionAdmission(f.admission),false);assert.equal(isHistoricalRevisionDiagnosticAdmission(f.admission),false);
  assert.equal(isIbRevisionArtifacts(f.cap),false);
  assert.deepEqual(f.dataBytes,before.data);assert.deepEqual(f.healthBytes,before.health);
  assert.deepEqual(fs.readFileSync(f.config.economicSnapshot.sourcePath),before.econ);assert.deepEqual(fs.readdirSync(f.dir).sort(),before.files);
  assert.ok(f.state.sourceCalls.every(c=>c.method==='GET'||c.method==='POST'&&c.p==='/oauth2/token'));
  assert.ok(![...f.state.calls,...f.state.admissionCalls].some(p=>p.startsWith('actions/workflows/')||p.includes('filter=all')));
 });
});

test('original producer log transport errors preserve role and fixed transport reason',async t=>{
  for(const role of ['current','anchor'])await t.test(role,async t=>{
    const f=await fixture(t,{diagnosticV2:true});
    f.state.transport=route=>{if(route==='actions/jobs/'+(role==='current'?'9001':'9002')+'/logs')throw Error('PRIVATE_TOKEN_URL');};
    await rejection(f.read(),'GITHUB_'+role.toUpperCase()+'_LOG_REQUEST');
    assert.equal(f.state.sourceCalls.length,0);
  });
});

// ---------------------------------------------------------------------------
// SOURCE_UNSTABLE end to end. The revised synthetic day carries a dividend and
// an owner transfer together; only the serialization of those same in-memory
// responses is varied. No account, credential, report or network is read.
// ---------------------------------------------------------------------------
const reorderDeep=v=>Array.isArray(v)?v.map(reorderDeep)
  :v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().reverse().map(k=>[k,reorderDeep(v[k])])):v;
// Per-attempt raw rewriting of the same synthetic bodies. The attempt counter
// advances only on the source's own authentication request.
function sourceRounds(f,rewrite){
  let attempt=0;
  f.reader.fetch=async(url,init)=>{
    const u=new URL(url);if(u.pathname==='/oauth2/token')attempt++;
    const original=await f.fetchImpl(url,init);
    if(u.pathname==='/oauth2/token')return original;
    const text=await original.text(),next=rewrite(text,{path:u.pathname,attempt});
    const out=new Response(next??text,{headers:{'content-type':'application/json'}});
    Object.defineProperty(out,'url',{value:url});return out;
  };
  return ()=>attempt;
}
const sourceJson=(f,match,change)=>{f.reader.fetch=async(url,init)=>{
  const original=await f.fetchImpl(url,init);if(!url.includes(match))return original;
  const body=await original.json();change(body);return response(url,body);
};};

test('revised history binds a coexisting dividend and owner transfer to their own dates and amounts',async t=>{
  const f=await fixture(t),v=await f.read();
  const candidate=await f.cap.prepareCandidate({plan:f.planOf(v),reader:f.reader});
  const source=candidate.replacement.sourceState.source;
  // The owner transfer is the only external flow, on exactly its own date. The
  // dividend is income and never becomes a flow, yet both must reconcile cash.
  assert.deepEqual(source.cashFlowByDate,{[P]:300});
  assert.deepEqual(source.periodReturnsInput.flowByDate,{[P]:300});
  assert.equal(source.periodReturnsInput.points.find(x=>x.d===P).tot,1307);
  assert.equal(source.periodReturnsInput.points.find(x=>x.d===T).tot,1307);
  assert.deepEqual(candidate.changedHistoricalDates,[P]);
  assert.equal(await f.cap.verifyCandidate(candidate),true);
});

test('a real dividend, transfer, member or duplicate change is still refused by its original validator',async t=>{
  for(const [name,match,change] of [
    ['dividend cash amount','cash_account_transactions',b=>{b.cash_account_transactions[0].amount=8;}],
    ['dividend proof reference','cash_account_transactions',b=>{b.cash_account_transactions[0].payout_id=null;}],
    ['transfer amount','cash_account_transactions',b=>{b.cash_account_transactions[1].amount=301;}],
    ['transfer date','cash_account_transactions',b=>{b.cash_account_transactions[1].date_time=U+'T05:00:00.000Z';}],
    ['transfer removed','cash_account_transactions',b=>{b.cash_account_transactions.splice(1,1);}],
    ['duplicate cash member','cash_account_transactions',b=>{b.cash_account_transactions.push({...b.cash_account_transactions[0]});}],
    ['payout paid date','/payouts/13.json',b=>{b.paid_on=U;}],
    ['payout net amount','/payouts/13.json',b=>{b.amount=8;}],
    ['payout gross amount','/payouts/13.json',b=>{b.gross_amount=11;}],
  ])await t.test(name,async()=>{
    const f=await fixture(t),v=await f.read();sourceJson(f,match,change);
    await assert.rejects(f.cap.prepareCandidate({plan:f.planOf(v),reader:f.reader}),error=>{
      const code=ibRevisionArtifactFailureCode(error);
      assert.match(code,/^IB_REVISION_ARTIFACT_[A-Z_]+$/);
      assert.equal(code.startsWith('IB_REVISION_ARTIFACT_SOURCE_CAPTURE_'),false,'a real change is never a formatting difference');
      assert.equal(error.cause,undefined);return true;
    });
  });
});

test('a purely re-serialized second source round no longer fails the historical revision',async t=>{
  const f=await fixture(t),v=await f.read();
  const attempts=sourceRounds(f,(text,{attempt})=>attempt===2?JSON.stringify(reorderDeep(JSON.parse(text)),null,2):null);
  const candidate=await f.cap.prepareCandidate({plan:f.planOf(v),reader:f.reader});
  assert.equal(candidate.mode,'extend-cutoff');assert.deepEqual(candidate.changedHistoricalDates,[P]);
  assert.deepEqual(candidate.replacement.sourceState.source.cashFlowByDate,{[P]:300});
  assert.equal(attempts(),2,'no extra authenticated source attempt');
  assert.equal(await f.cap.verifyCandidate(candidate),true);
});

test('each capture gate now reports its own fixed public code instead of one undivided SOURCE_UNSTABLE',async t=>{
  for(const [name,suffix,rewrite] of [
    ['business fingerprint','SOURCE_CAPTURE_FINGERPRINT',(text,{path,attempt})=>path.endsWith('/cash_account_transactions.json')&&attempt===2
      ?text.replace('Owner cash contribution','Owner capital contribution'):null],
    ['raw records','SOURCE_CAPTURE_RECORDS_PERF_LEX',(text,{path,attempt})=>path.endsWith('/performance')&&attempt===2?text+' ':null],
  ])await t.test(name,async()=>{
    const f=await fixture(t),v=await f.read();sourceRounds(f,rewrite);
    const code='FEE_REPORT_SOURCE_REVISION_ARTIFACT_'+suffix;
    assert.ok(IB_REVISION_ARTIFACT_DIAGNOSTIC_CODES.includes(suffix));
    assert.equal(safeProducerFailureSummary(code+'\n').code,code);
    assert.notEqual(code,'FEE_REPORT_SOURCE_REVISION_ARTIFACT_SOURCE_UNSTABLE');
    await rejection(f.cap.prepareCandidate({plan:f.planOf(v),reader:f.reader}),suffix);
  });
});

test('the native recovery runtime carries the raw records gate to its exact safe public code',async t=>{
  const f=await fixture(t);let attempt=0;
  const fetchImpl=async(url,init)=>{
    if(!url.startsWith('https://api.sharesight.com/'))return f.fetchImpl(url,init);
    const u=new URL(url);if(u.pathname==='/oauth2/token'){attempt++;return f.fetchImpl(url,init);}
    const original=await f.fetchImpl(url,init),text=await original.text();
    const next=u.pathname.endsWith('/performance')&&attempt===2?text+' ':text;
    const out=new Response(next,{headers:{'content-type':'application/json'}});
    Object.defineProperty(out,'url',{value:url});return out;
  };
  const runtime=await createFeeSourceRevisionRuntime({plan:f.dailyPlan,admission:f.admission,economicSnapshot:f.config.economicSnapshot,
    sourceBytes:f.dataBytes,sourcePayload:f.currentPayload,healthBytes:f.healthBytes,githubToken:TOKEN,clientId:'synthetic-client',clientSecret:'synthetic-secret',
    keyText:f.key.toString('base64url'),baselineSha256:f.baselineSha256,legacySourcePath:null,fetchImpl,clock:f.clock});
  t.after(()=>runtime.close());
  const expected='FEE_REPORT_SOURCE_REVISION_ARTIFACT_SOURCE_CAPTURE_RECORDS_PERF_LEX';
  const original=Buffer.from(f.dataBytes);
  await assert.rejects(runtime.prepare(),error=>{
    assert.equal(sourceRevisionRuntimeFailureCode(error),expected);
    assert.equal(error.message,expected);assert.equal(safeProducerFailureSummary(error.message+'\n').code,expected);
    assert.equal(error.cause,undefined);assert(!JSON.stringify(error).includes('PRIVATE'));return true;
  });
  assert.deepEqual(f.dataBytes,original,'a refused capture never writes');
  await assert.rejects(runtime.prepare(),/REUSE|CLOSED/);
});

// ---------------------------------------------------------------------------
// v3 catalog exception and source evidence through the real artifacts, runtime
// and diagnostic result. Synthetic responses only; nothing is read or written.
import {sourceRevisionRuntimeSourceEvidence} from './fee-source-revision-runtime.mjs';
function catalogRounds(f,change){
  let attempt=0;
  return async(url,init)=>{
    if(!url.startsWith('https://api.sharesight.com/'))return f.fetchImpl(url,init);
    const u=new URL(url);if(u.pathname==='/oauth2/token'){attempt++;return f.fetchImpl(url,init);}
    const original=await f.fetchImpl(url,init),text=await original.text();
    const next=u.pathname.endsWith('/holdings')&&attempt>=2?change(JSON.parse(text),attempt):null;
    const out=new Response(next?JSON.stringify(next):text,{headers:{'content-type':'application/json'}});
    Object.defineProperty(out,'url',{value:url});return out;
  };
}
const quietDiagnostic=error=>inspectRevisionDiagnostic({authorize:async()=>({checkCurrent:async()=>{},close(){}}),checkCheckout(){},
  readPrivate:async()=>({}),createRuntime:async()=>({diagnose:async()=>{throw error;},close(){}}),cleanup:async()=>{}});

test('historical revision: only unconsumed catalog members changed -> verified with the exception explicitly marked',async t=>{
  const f=await fixture(t,{diagnosticV4:true,bankWire:true,lockedMonth:true});
  const before={data:Buffer.from(f.dataBytes),health:Buffer.from(f.healthBytes)};
  const runtime=await createFeeSourceRevisionRuntime({...diagnosticRuntimeOptions(f),fetchImpl:catalogRounds(f,(o,n)=>{o.holdings[0].value=n;o.holdings[0].quantity=n;return o;})});
  assert.deepEqual(await runtime.diagnose(),{schema:'fee-console.source-revision-diagnostic-result.v1',status:'verified',targetDate:T,
    sourceEvidence:{capture:{HOLD:['ALLOWED_UNCONSUMED_CATALOG']},currentness:{HOLD:['ALLOWED_UNCONSUMED_CATALOG']},currentnessCoverage:'ALL_RECORDS'}});
  assert.deepEqual(f.dataBytes,before.data);assert.deepEqual(f.healthBytes,before.health);
});
test('historical revision: a blocking catalog change is refused; the diagnostic result carries complete fixed evidence',async t=>{
  const f=await fixture(t,{diagnosticV4:true,bankWire:true,lockedMonth:true});
  const runtime=await createFeeSourceRevisionRuntime({...diagnosticRuntimeOptions(f),fetchImpl:catalogRounds(f,(o,n)=>{o.holdings[0].value=n;o.holdings[0].note='round '+n;return o;})});
  let genuine;
  await assert.rejects(runtime.diagnose(),e=>{genuine=e;
    assert.equal(sourceRevisionRuntimeFailureCode(e),'FEE_REPORT_SOURCE_REVISION_ARTIFACT_SOURCE_CAPTURE_RECORDS_HOLD_VAL');
    assert.deepEqual(sourceRevisionRuntimeSourceEvidence(e),{capture:{HOLD:['ALLOWED_UNCONSUMED_CATALOG','UNKNOWN']},currentness:'NOT_REACHED'});return true;});
  const r=await quietDiagnostic(genuine);
  assert.deepEqual(r,{schema:'fee-console.source-revision-diagnostic-result.v1',status:'incomplete',targetDate:T,
    reasonCode:'FEE_REPORT_SOURCE_REVISION_ARTIFACT_SOURCE_CAPTURE_RECORDS_HOLD_VAL',reportGenerated:false,publicationReady:false,
    sourceEvidence:{capture:{HOLD:['ALLOWED_UNCONSUMED_CATALOG','UNKNOWN']},currentness:'NOT_REACHED'}});
  assert.doesNotMatch(JSON.stringify(r.sourceEvidence),/round|note|IB-HK|\d/,"evidence holds only fixed literals");
  // A forged or copied error never gains evidence.
  for(const forged of [Error(genuine.message),Object.assign(Error(genuine.message),{sourceEvidence:{capture:{HOLD:['ID']}}}),new Proxy(genuine,{})]){
    const x=await quietDiagnostic(forged);assert.equal(Object.hasOwn(x,'sourceEvidence'),false);
  }
});
test('historical revision: a catalog change after capture is refused at the recheck with currentness evidence',async t=>{
  const f=await fixture(t,{diagnosticV4:true,bankWire:true,lockedMonth:true});
  const runtime=await createFeeSourceRevisionRuntime({...diagnosticRuntimeOptions(f),fetchImpl:catalogRounds(f,(o,n)=>{if(n>=3)o.holdings[0].note='later';return o;})});
  await assert.rejects(runtime.diagnose(),e=>{
    assert.equal(sourceRevisionRuntimeFailureCode(e),'FEE_REPORT_SOURCE_REVISION_ARTIFACT_SOURCE_RECHECK_RECORD_CHANGED');
    assert.deepEqual(sourceRevisionRuntimeSourceEvidence(e),{capture:'PASSED',currentness:{HOLD:['UNKNOWN']},currentnessCoverage:'FIRST_CHANGED_RECORD'});return true;});
});
