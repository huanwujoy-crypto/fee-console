// Entirely synthetic integration fixtures. No SDK, credentials, Storage,
// financial source, GUI or real network is called by this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {withOwnerSourceByteReuse} from './owner_source_bytes.mjs';
import {deliverOwnerAcceptedPreviewReplacement,requireProtectedOwnerCheckout,OWNER_PROTECTED_SOURCE_PATHS} from './owner_latest_delivery.mjs';
import {acceptedPreviewRegistrationText,previewReplacementRegistrationText,buildAcceptedPreviewMetadata,renderAcceptedPreviewDisplay} from './owner_accepted_preview.mjs';
import {buildEodActionModel} from '../../scripts/xuan-ib-eod-action-model.mjs';
import {renderNightActionReport} from '../../scripts/xuan-ib-night-action-view.mjs';
import {fingerprint} from '../../scripts/xuan-ib-run-manifest.mjs';
import {SNAPSHOT_SCOPES,digest} from './eod_sources.mjs';
import {resolveCurrentCall} from './call_record.mjs';
import {associationPolicyText} from '../../scripts/xuan-ib-account-association.mjs';
import {OWNER_BINDING,SOURCE_IDENTITY_SHA256} from './owner_latest_admission.mjs';
import {OWNER_SCOPE,LATEST_TARGET} from './owner_latest.mjs';

const NOW=Date.parse('2026-10-19T07:00:00.000Z');
const START='2026-10-17T06:00:00.000Z',END='2026-10-17T06:02:00.000Z',DONE='2026-10-17T06:03:00.000Z';
const ORDER_START='2026-10-17T06:00:02.000Z',ORDER_END='2026-10-17T06:00:15.000Z';
const encode=s=>new TextEncoder().encode(s),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const blob=s=>{const b=Buffer.from(s);return crypto.createHash('sha1').update(Buffer.from('blob '+b.length+'\0')).update(b).digest('hex');};
const forbiddenNetwork=()=>assert.fail('Only the fixed offline fixture fetch may run');
globalThis.fetch=forbiddenNetwork;
function snapshot(key,readAt){
  const scope=SNAPSHOT_SCOPES[key],h=(id,group_name,value,code)=>({id,group_name,value,quantity:10,instrument:{code,currency:{code:'USD'}}});
  const raw={mode:'read_only',source:'Sharesight User API',data:{report:{portfolio_id:scope.portfolioId,currency:{code:'USD'},start_date:'2026-10-16',end_date:'2026-10-16',include_sales:false,
    ...(key==='sharesight.ibGroupedPerformance'?{grouping:'custom_group_category',custom_group:{id:Number(scope.grouping),name:'资产类别'},holdings:[h(1,'美国底仓',450,'CSPX'),h(2,'美国底仓',50,'USSC'),h(3,'美国科技',250,'GOOG'),h(4,'非美发达',180,'EXUS'),h(5,'新兴市场',70,'EIMI')]}:{grouping:scope.grouping}),cash_accounts:[{value:200}]}}};
  return {sourceKey:key,status:'date-verified',raw,rawFingerprint:digest(raw),completion:null,
    provenance:{sourceDate:'2026-10-16',readAt,syncCompletedAt:null,snapshotGeneration:null,receiptSha256:null}};
}
function reportFixture(){
  const sources=[['ib.accountSummary',START,'2026-10-17T06:00:10.000Z'],['ib.positions','2026-10-17T06:00:01.000Z','2026-10-17T06:00:12.000Z'],['ib.orders',ORDER_START,ORDER_END],
    ['sharesight.ibGroupedPerformance','2026-10-17T06:01:00.000Z','2026-10-17T06:01:30.000Z'],['sharesight.noahPerformance','2026-10-17T06:01:01.000Z',END]]
    .map(([sourceKey,startedAt,completedAt])=>({sourceKey,startedAt,completedAt,sha256:hash('SYNTHETIC '+sourceKey),
      ...(sourceKey.startsWith('sharesight.')?{sourceDate:'2026-10-16',status:'date-verified',syncCompletion:'not-provided'}:{})}));
  const manifest={sources,sourceHead:'a'.repeat(40),associationPolicySha256:'b'.repeat(64),callLedgerSha256:'c'.repeat(64)};
  const rawByKey={'ib.accountSummary':{currency:'USD',total_cash_value:123},'ib.positions':{positions:[]},'ib.orders':{orders:[{order_id:1,order_status:'NEW',order_type:'LIMIT',side:'BUY',limit_price:'10',total_shares_qty:'4',cum_shares_qty:'0',remaining_shares_qty:'4',primary_description:'Buy 4 EXUS',secondary_description:'Synthetic instrument',order_time:'2026-10-16T14:00:00Z'}]}};
  const live={status:'captured',sources:sources.slice(0,3).map(s=>({...s,raw:rawByKey[s.sourceKey],rawFingerprint:fingerprint(rawByKey[s.sourceKey])}))};
  const snapshots=[snapshot('sharesight.ibGroupedPerformance',sources[3].completedAt),snapshot('sharesight.noahPerformance',END)];
  const outcomes=[{sourceKey:'ib.flexEod',status:'not-called',rawFingerprint:null},...snapshots.map(s=>({sourceKey:s.sourceKey,status:s.status,rawFingerprint:s.rawFingerprint})),{sourceKey:'ib.optionalLive',status:'captured',rawFingerprint:digest(live)}];
  const call=resolveCurrentCall({schemaVersion:1,purpose:'xuan-etf-owner-declared-pending-calls',entries:[{date:'2026-09-01',usd:100}]},'2026-10-17');
  const model=buildEodActionModel({fieldMode:true,dataDate:'2026-10-17',sourceDate:'2026-10-16',asOfHkt:'2026-10-17 14:00–14:02 HKT · 数据至 2026-10-16',snapshots,live,reserve:call.amountUsd,callRecord:call,sourceOutcomes:outcomes,captureStartedAt:START,captureCompletedAt:END});
  model.sourceManifestSha256=digest(sources);model.evidenceSha256=digest({sourceOutcomes:model.sourceOutcomes,sourceManifestSha256:model.sourceManifestSha256});
  const html=encode(renderNightActionReport(model)),modelBytes=encode(JSON.stringify(model,null,2)+'\n'),manifestBytes=encode(JSON.stringify(manifest,null,2)+'\n');
  const oldRegistration={schema:'xuan.owner-accepted-preview-registration.v1',registrationId:'synthetic-source-reuse-old',scope:OWNER_SCOPE,ownerBinding:OWNER_BINDING,sourceIdentitySha256:SOURCE_IDENTITY_SHA256,
    dataDate:'2026-10-17',sourceDate:'2026-10-16',captureStartedAt:START,captureEndedAt:END,completedAt:DONE,ordersCaptureStartedAt:ORDER_START,ordersCaptureEndedAt:ORDER_END,sourceHead:manifest.sourceHead,
    artifactSha256:hash(html),modelSha256:hash(modelBytes),sourceManifestSha256:hash(manifestBytes),sourceManifestContentSha256:digest(sources),displaySha256:'0'.repeat(64),financialStatus:'partial',unknownFields:['cash','orders','prices']};
  const oldDisplay=renderAcceptedPreviewDisplay(html,{registration:oldRegistration});oldRegistration.displaySha256=hash(oldDisplay);
  const registration={...structuredClone(oldRegistration),registrationId:'synthetic-source-reuse-new'};
  const displayBytes=renderAcceptedPreviewDisplay(html,{registration});registration.displaySha256=hash(displayBytes);
  return {html,modelBytes,manifestBytes,oldRegistration,oldDisplay,registration,displayBytes};
}
function fixture(){
  const f=reportFixture(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'owner-source-reuse-'));
  const git=args=>execFileSync('git',['-c','core.hooksPath='+path.join(directory,'empty-hooks'),...args],{cwd:directory,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  fs.mkdirSync(path.join(directory,'empty-hooks'));git(['init','-q']);
  const write=(relative,bytes)=>{const target=path.join(directory,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);};
  for(const relative of OWNER_PROTECTED_SOURCE_PATHS)write(relative,'// SYNTHETIC protected checkout bytes '+relative+'\n');
  write('security/xuan-owner-accepted-preview.json',acceptedPreviewRegistrationText(f.oldRegistration));
  const canary='{"syntheticImmutableCanary":true}\n';write('security/xuan-owner-registered-canary.json',canary);
  const revision={schema:'xuan.owner-preview-replacement.v1',target:{...LATEST_TARGET},previousRegistrationSha256:hash(acceptedPreviewRegistrationText(f.oldRegistration)),previousDisplaySha256:hash(f.oldDisplay),canaryRegistrationSha256:hash(canary),registration:f.registration};
  write('security/xuan-owner-preview-replacement.json',previewReplacementRegistrationText(revision));
  git(['add','.']);git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','-c','commit.gpgsign=false','commit','-qm','Synthetic original']);const old=git(['rev-parse','HEAD']);
  write('synthetic-head-marker','SYNTHETIC current main\n');git(['add','synthetic-head-marker']);git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','-c','commit.gpgsign=false','commit','-qm','Synthetic current']);const current=git(['rev-parse','HEAD']);
  const other=current==='d'.repeat(40)?'e'.repeat(40):'d'.repeat(40),publicHtml='SYNTHETIC public source baseline';
  const policy={schemaVersion:1,policyId:'ib-primary-7day-pilot-v1',accountAlias:'IB-HK',basis:'owner-attested-recurring-v1',status:'active',purpose:'xuan-ib-read-only-report',editions:['adhoc','am','pm'],publisher:'codex-verified-candidate-v1',validFrom:'2026-10-01T00:00:00.000Z',expiresAt:'2026-10-20T00:00:00.000Z'};
  const bodies=new Map([
    ['claude/xuan-ib-account-association-v1.json',associationPolicyText(policy)],
    ['claude/xuan-ib-etf-pending-calls-v1.json',JSON.stringify({schemaVersion:1,purpose:'xuan-etf-owner-declared-pending-calls',entries:[{date:'2026-09-01',usd:100}]})],
    ['xuan-ib/latest.meta.json',JSON.stringify({sourceSha:'f'.repeat(40),htmlBlob:blob(publicHtml)})],['xuan-ib/latest.html',publicHtml],
    ['security/xuan-owner-accepted-preview.json',acceptedPreviewRegistrationText(f.oldRegistration)],['security/xuan-owner-preview-replacement.json',previewReplacementRegistrationText(revision)],['security/xuan-owner-registered-canary.json',canary],
  ]);
  return {...f,directory,old,current,other,policy,bodies,revision,time:NOW,cleanup:()=>fs.rmSync(directory,{recursive:true,force:true})};
}
async function scenario(f,{reuse=true,failure=null}={}){
  const calls=[],counts={main:0,write:0,readback:0,previousRead:0,access:0};
  const fetchImpl=async(url,options={})=>{
    assert.equal(typeof url,'string');assert.equal(options.redirect,'error');assert.equal(options.method??'GET','GET');assert.ok(options.signal instanceof AbortSignal);
    const u=new URL(url);calls.push(url);
    if(url==='https://api.github.com/repos/huanwujoy-crypto/fee-console/commits/main'){
      counts.main++;if(counts.main===3){
        if(failure==='timeout')throw Object.assign(new TypeError('SYNTHETIC offline timeout'),{cause:{code:'ETIMEDOUT'}});
        if(failure==='expired')f.time=Date.parse(f.policy.expiresAt);
      }
      return new Response(JSON.stringify({sha:counts.main>=3&&['head','revoked'].includes(failure)?f.other:f.current}));
    }
    if(u.hostname==='api.github.com'){
      assert.equal(u.pathname,'/repos/huanwujoy-crypto/fee-console/compare/'+f.old+'...'+f.current);
      return new Response(JSON.stringify({status:'ahead',merge_base_commit:{sha:f.old}}));
    }
    assert.equal(u.hostname,'raw.githubusercontent.com');const prefix='/huanwujoy-crypto/fee-console/';assert.ok(u.pathname.startsWith(prefix));
    const [commit,...parts]=u.pathname.slice(prefix.length).split('/'),relative=parts.join('/');assert.ok([f.old,f.current,f.other].includes(commit));assert.ok(f.bodies.has(relative));
    if(commit===f.old)assert.equal(relative,'security/xuan-owner-accepted-preview.json');
    let body=f.bodies.get(relative);
    if(failure==='revoked'&&commit===f.other&&relative==='claude/xuan-ib-account-association-v1.json')body=associationPolicyText({...f.policy,status:'revoked'});
    if(failure==='registration'&&commit===f.old)body+=' ';
    return new Response(body);
  };
  const oldMetadata=buildAcceptedPreviewMetadata({registration:f.oldRegistration,registrationSha256:hash(acceptedPreviewRegistrationText(f.oldRegistration)),registrationPolicyCommit:f.old});
  const previousFetch=globalThis.fetch;globalThis.fetch=fetchImpl;
  let result=null,error=null;
  try{
    // The operator's pre-refresh public check remains outside the worker scope.
    assert.equal(await requireProtectedOwnerCheckout({cwd:f.directory,now:()=>f.time}),f.current);
    const work=async()=>{
      // Original access-session precheck remains inside the worker, before SDK.
      assert.equal(await requireProtectedOwnerCheckout({cwd:f.directory,now:()=>f.time}),f.current);
      return deliverOwnerAcceptedPreviewReplacement({cwd:f.directory,html:f.html,modelBytes:f.modelBytes,manifestBytes:f.manifestBytes,now:()=>f.time,
        request:()=>assert.fail('The synthetic store must not use a real transport'),requestPreviewReplacement:()=>assert.fail('No SDK callback is permitted'),
        verifyDestinationAccess:async()=>{counts.access++;},storeFactory:()=>({
          readLatest:async()=>{counts.previousRead++;return {state:'present',generation:'100',kind:'accepted-preview',preview:{metadata:structuredClone(oldMetadata)},displayBytes:new Uint8Array(f.oldDisplay)};},
          replaceAcceptedPreview:async options=>{counts.write++;assert.equal(options.previousGeneration,'100');assert.equal(options.previousDisplaySha256,hash(f.oldDisplay));assert.deepEqual(options.bytes,f.displayBytes);return {...LATEST_TARGET,generation:'101',size:f.displayBytes.length};},
          readLatestGeneration:async options=>{counts.readback++;assert.equal(options.generation,'101');assert.equal(options.sha256,hash(f.displayBytes));return new Uint8Array(f.displayBytes);},
        })});
    };
    result=await (reuse?withOwnerSourceByteReuse(work):work());
  }catch(caught){error=caught;}finally{globalThis.fetch=previousFetch;}
  return {result,error,counts,calls};
}
function zeroWrite(answer){assert.equal(answer.counts.write,0);assert.equal(answer.counts.readback,0);assert.equal(answer.counts.access,0);assert.notEqual(answer.result?.status,'published-verified');}

test('worker-only immutable byte reuse reduces 71 source requests to 23 while all ten live-main checks and real verifier stages remain',async()=>{
  const f=fixture();try{
    const before=await scenario(f,{reuse:false}),after=await scenario(f);
    for(const answer of [before,after]){
      assert.equal(answer.error,null);assert.equal(answer.result.status,'published-verified');assert.equal(answer.result.sha256,hash(f.displayBytes));
      assert.deepEqual(answer.counts,{main:10,write:1,readback:1,previousRead:1,access:1});
      assert.equal(answer.result.ownerPublicationDiagnostics.fullVerification,true);assert.equal(answer.result.ownerPublicationDiagnostics.businessAckValidated,1);
      assert.equal(answer.result.ownerPublicationDiagnostics.independentReadbackAttempts,1);assert.equal(answer.result.ownerPublicationDiagnostics.storeReadbackCompleted,1);
    }
    assert.equal(before.calls.length,71);assert.equal(after.calls.length,23);
    const currentRaw='https://raw.githubusercontent.com/huanwujoy-crypto/fee-console/'+f.current+'/';
    for(const relative of ['claude/xuan-ib-account-association-v1.json','claude/xuan-ib-etf-pending-calls-v1.json','xuan-ib/latest.meta.json','xuan-ib/latest.html'])assert.equal(after.calls.filter(url=>url===currentRaw+relative).length,2);
    assert.equal(after.calls.filter(url=>url.includes('/compare/')).length,1);
    // A second execution owns an empty ALS cache rather than a persistent seed.
    const next=await scenario(f);assert.equal(next.error,null);assert.equal(next.calls.length,23);assert.equal(next.counts.main,10);
  }finally{f.cleanup();}
});
test('cached immutable bytes cannot hide a fresh-main head change',async()=>{
  const f=fixture();try{const answer=await scenario(f,{failure:'head'});zeroWrite(answer);assert.equal(answer.counts.main,3);assert.match(answer.error?.message??'',/PROTECTED_CHECKOUT_REQUIRED/);}finally{f.cleanup();}
});
test('a new main with revoked association is re-read and rejected by the original active-policy gate',async()=>{
  const f=fixture();try{const answer=await scenario(f,{failure:'revoked'});zeroWrite(answer);assert.equal(answer.counts.main,3);assert.match(answer.error?.message??'',/policy is revoked/);assert.ok(answer.calls.includes('https://raw.githubusercontent.com/huanwujoy-crypto/fee-console/'+f.other+'/claude/xuan-ib-account-association-v1.json'));}finally{f.cleanup();}
});
test('same-head cached policy bytes are still checked against the current clock and expire',async()=>{
  const f=fixture();try{const answer=await scenario(f,{failure:'expired'});zeroWrite(answer);assert.equal(answer.counts.main,3);assert.match(answer.error?.message??'',/policy has expired/);const url='https://raw.githubusercontent.com/huanwujoy-crypto/fee-console/'+f.current+'/claude/xuan-ib-account-association-v1.json';assert.equal(answer.calls.filter(value=>value===url).length,2);}finally{f.cleanup();}
});
test('live-main timeout never falls back to an earlier main response or reaches the write capability',async()=>{
  const f=fixture();try{const answer=await scenario(f,{failure:'timeout'});zeroWrite(answer);assert.equal(answer.counts.main,3);assert.equal(answer.error?.safeCode,'REPORT_SOURCE_NETWORK_FAILED');assert.equal(answer.error?.safeOrigin?.causeCode,'ETIMEDOUT');assert.equal(answer.error?.safeOrigin?.httpStatus,null);}finally{f.cleanup();}
});
test('cached raw registration bytes still undergo original historical byte-identity verification',async()=>{
  const f=fixture();try{const answer=await scenario(f,{failure:'registration'});zeroWrite(answer);assert.equal(answer.error,null);assert.equal(answer.result.status,'blocked');assert.equal(answer.result.failureStage,'protected-replacement');assert.equal(answer.result.failureReason,'OWNER_PREVIEW_REJECTED');assert.equal(answer.counts.previousRead,1);}finally{f.cleanup();}
});
