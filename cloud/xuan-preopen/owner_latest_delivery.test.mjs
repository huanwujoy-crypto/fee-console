// Entirely synthetic controller/navigation tests. No real source, credentials,
// storage, broker, login or network activity is performed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {deliverOwnerLatest,deliverCurrentOwnerDaily,deliverOwnerAcceptedPreview,deliverOwnerAcceptedPreviewReplacement,deliverOwnerAcceptedPreviewReplacementStorage,ownerBundleMetadata,ownerDeliveryRequest,createOwnerDeliveryHook,createOwnerContextLoader,requireProtectedOwnerCheckout,OWNER_PREVIEW_REGISTRATION_PATH,OWNER_PROTECTED_SOURCE_PATHS} from './owner_latest_delivery.mjs';
import {buildEodActionModel} from '../../scripts/xuan-ib-eod-action-model.mjs';
import {renderNightActionReport} from '../../scripts/xuan-ib-night-action-view.mjs';
import {resolveCurrentCall} from './call_record.mjs';
import {digest} from './eod_sources.mjs';
import {collectDelivery} from './delivery.mjs';
import {buildPublicEodSummary} from '../../scripts/xuan-ib-public-eod-summary.mjs';
import {associationPolicyText} from '../../scripts/xuan-ib-account-association.mjs';
import {OWNER_BINDING,SOURCE_IDENTITY_SHA256} from './owner_latest_admission.mjs';
import {OWNER_SCOPE} from './owner_latest.mjs';
import {acceptedPreviewRegistrationText,previewReplacementRegistrationText,PREVIEW_REPLACEMENT_REGISTRATION_PATH} from './owner_accepted_preview.mjs';
import {createOwnerFailureEvidence} from './cloud_io.mjs';

const NOW=Date.parse('2026-10-15T05:01:00.000Z'),START='2026-10-15T05:00:00.000Z',END='2026-10-15T05:00:01.000Z';
const encode=s=>new TextEncoder().encode(s);
globalThis.fetch=()=>assert.fail('No external network in synthetic controller tests');
function fixture(){
  const sourceOutcomes=['ib.flexEod','sharesight.ibGroupedPerformance','sharesight.noahPerformance','ib.optionalLive'].map(sourceKey=>({sourceKey,status:'not-called',rawFingerprint:null}));
  const ledger={schemaVersion:1,purpose:'xuan-etf-owner-declared-pending-calls',entries:[{date:'2026-09-01',usd:100}]};
  const callRecord=resolveCurrentCall(ledger,'2026-10-15');
  const model=buildEodActionModel({fieldMode:true,dataDate:'2026-10-15',sourceDate:'2026-10-14',asOfHkt:'2026-10-15 13:00–13:00 HKT · 数据至 2026-10-14',
    snapshots:[],live:null,reserve:100,callRecord,sourceOutcomes,captureStartedAt:START,captureCompletedAt:END});
  const sources=sourceOutcomes.map((s,i)=>({sourceKey:s.sourceKey,privateObject:'report-check/'+START+'-00000000-0000-4000-8000-000000000000/'+s.sourceKey+'.json',generation:String(i+1),sha256:digest('SYNTHETIC '+s.sourceKey),rawFingerprint:null}));
  model.sourceManifestSha256=digest([...sources].sort((a,b)=>a.sourceKey.localeCompare(b.sourceKey)));
  model.evidenceSha256=digest({sourceOutcomes,sourceManifestSha256:model.sourceManifestSha256});
  const html=renderNightActionReport(model);
  const receipt={schemaVersion:1,mode:'private_eod_action',status:'partial',dataDate:model.dataDate,sourceDate:model.sourceDate,startedAt:START,completedAt:END,
    association:null,sourceCount:4,sources,sourceOutcomes,sourceManifestSha256:model.sourceManifestSha256,evidenceSha256:model.evidenceSha256,fieldErrors:model.fieldErrors,
    artifact:{privateObject:'delivery/2026-10-15/report.html',generation:'10',sha256:digest(html)},publication:'none',scheduler:'none'};
  const receiptText=JSON.stringify(receipt);
  const bundle={html:encode(html),receipt:encode(receiptText),artifactObject:receipt.artifact.privateObject,artifactGeneration:'10',artifactSha256:digest(html),receiptObject:'delivery/2026-10-15/receipt.json',receiptGeneration:'11',receiptSha256:digest(receiptText)};
  return {model,html,receipt,receiptText,bundle};
}
test('Saturday is no-action before any store, request, source or publisher capability',async()=>{
  let calls=0;const bad=()=>{calls++;throw Error('forbidden');};
  const result=await deliverOwnerLatest({now:()=>Date.parse('2026-10-17T07:00:00Z'),request:bad,storeFactory:bad,publisherFactory:bad});
  assert.equal(result.status,'no-action');assert.equal(calls,0);
});
test('named daily SDK entry rejects every caller override before protected lookup or SDK construction',async()=>{
  for(const value of [undefined,{}, {approved:true}, {request:()=>assert.fail('injected transport')}]){
    await assert.rejects(()=>deliverCurrentOwnerDaily(value),/EXPLICIT_EXECUTION_REQUIRED/);
  }
});
test('daily entry preserves verified storage or primary failure when SDK cleanup fails',async()=>{
  // Evaluate the actual entry with only its module import substituted. The
  // production entry still has no clock, access or publisher override.
  const source=fs.readFileSync(new URL('./owner_latest_delivery.mjs',import.meta.url),'utf8');
  const entry=source.slice(source.indexOf('export async function deliverCurrentOwnerDaily(){'),source.indexOf('// Explicit review-preview entry only.'))
    .replaceAll('export async function','async function').replace("import('./owner_preview_access.mjs')",'loadAccess()');
  for(const mode of ['verified','blocked','primary']){
    const primary=Error('SYNTHETIC_PRIMARY'),signal=new AbortController().signal;let writes=0,closes=0;
    const access={verifyRegisteredCanary:async()=>({status:mode==='blocked'?'blocked':'existing-verified'}),
      prepareDailyPublication:async options=>{assert.equal(options.signal,signal);},requestDaily:()=>assert.fail('entry forwards capability only'),close(){closes++;throw Error('SYNTHETIC_CLEANUP');}};
    const run=new Function('fail','loadAccess','deliverOwnerLatest','withOwnerPublicationReads',entry+';return deliverCurrentOwnerDaily;')(
      ()=>assert.fail(),async()=>({createOwnerDailyStorageAccess:async()=>access}),
      async options=>{assert.equal(options.request,access.requestDaily);await options.prepareCommit({signal});writes++;if(mode==='primary')throw primary;return {status:'published-verified',generation:'901'};},work=>work());
    if(mode==='primary'){await assert.rejects(run(),error=>error===primary);assert.equal(primary.ownerDeliveryCleanupFailed,true);}
    else {const result=await run();assert.equal(result.cleanupStatus,'failed');
      assert.equal(result.status,mode==='verified'?'published-verified':'blocked');
      if(mode==='verified'){assert.equal(result.storageStatus,'verified');assert.equal(result.visualStatus,'pending');assert.equal(result.acceptanceComplete,false);}}
    assert.equal(closes,1);assert.equal(writes,mode==='blocked'?0:1);
  }
});
test('controller uses exact generation-pinned bundle bytes and preserves original times and unknown states',async()=>{
  const f=fixture();let candidate;
  const result=await deliverOwnerLatest({now:()=>NOW,request:()=>assert.fail(),loadContext:async()=>assert.fail(),storeFactory:()=>({readDailyBundle:async({dataDate})=>{assert.equal(dataDate,'2026-10-15');return f.bundle;},readPinnedSource:()=>assert.fail()}),
    publisherFactory:opts=>{assert.equal(typeof opts.verifyProtectedReceipt,'function');assert.equal(typeof opts.verifyProtectedPreview,'function');assert.equal(typeof opts.prepareDisplay,'function');return {publish:async c=>{candidate=c;return {status:'published-verified'};}};}});
  assert.equal(result.status,'published-verified');assert.deepEqual(candidate.html,f.bundle.html);assert.deepEqual(candidate.receipt,f.bundle.receipt);
  assert.equal(candidate.metadata.captureStartedAt,START);assert.equal(candidate.metadata.captureEndedAt,END);assert.equal(candidate.metadata.completedAt,END);
  assert.equal(candidate.metadata.financialStatus,'partial');assert.ok(candidate.metadata.unknownFields.includes('orders'));assert.ok(candidate.metadata.unknownFields.includes('cash'));
});
test('daily generation, date or collected-byte changes stop before publisher',async()=>{
  for(const kind of ['generation','date','htmlHash','receiptHash']){
    const f=fixture();if(kind==='generation')f.receipt.artifact.generation='999';if(kind==='date')f.receipt.sourceDate='2026-10-13';
    f.bundle.receipt=encode(JSON.stringify(f.receipt));
    await assert.rejects(deliverOwnerLatest({now:()=>NOW,request:()=>assert.fail(),storeFactory:()=>({readDailyBundle:async()=>f.bundle}),publisherFactory:()=>assert.fail('not admitted'),
      ...(kind==='htmlHash'?{expectedArtifactSha256:'f'.repeat(64)}:{}),...(kind==='receiptHash'?{expectedReceiptSha256:'f'.repeat(64)}:{})}));
  }
});
test('private hook pins both original collected byte hashes rather than a reserialized receipt',async()=>{
  const f=fixture(),receiptText=f.receiptText+'\n';let published=false;
  const hook=createOwnerDeliveryHook({now:()=>NOW,request:()=>assert.fail(),storeFactory:()=>({readDailyBundle:async()=>f.bundle}),publisherFactory:()=>{published=true;return {};}});
  await assert.rejects(hook({html:f.html,receiptText}),/COLLECTED_BUNDLE_CHANGED/);assert.equal(published,false);
});
test('private publication executes before public-equality early return',async()=>{
  const f=fixture(),events=[],publicHtml=renderNightActionReport(buildPublicEodSummary(f.model,f.receipt));
  const result=await collectDelivery({now:()=>NOW,request:async url=>url.includes('receipt.json')?f.receiptText:f.html,
    publishPrivate:async({html,receiptText})=>{events.push('private');assert.equal(html,f.html);assert.equal(receiptText,f.receiptText);return {status:'published-verified'};},
    loadContext:async()=>{events.push('context');return {previousHtml:publicHtml};}});
  assert.deepEqual(events,['private','context']);assert.equal(result.outcome,'already-published');assert.equal(result.privateDelivery.status,'published-verified');
});
test('private unknown/conflict/blocked outcomes stop public continuation without retrying a write',async()=>{
  for(const status of ['unknown','conflict','blocked','written-unverified']){
    const f=fixture();let calls=0;
    await assert.rejects(collectDelivery({now:()=>NOW,request:async url=>url.includes('receipt.json')?f.receiptText:f.html,
      publishPrivate:async()=>{calls++;return {status};},loadContext:()=>assert.fail('public must not continue')}),/PRIVATE_DELIVERY_NOT_VERIFIED/);
    assert.equal(calls,1);
  }
});
test('transport only attaches existing identity to fixed GCS origin and rejects redirect following',async()=>{
  let calls=0;const request=ownerDeliveryRequest('SYNTHETIC_EXISTING_IDENTITY',async(url,opts)=>{calls++;assert.equal(new URL(url).origin,'https://storage.googleapis.com');assert.equal(opts.redirect,'error');assert.equal(opts.headers.Authorization,'Bearer SYNTHETIC_EXISTING_IDENTITY');return new Response('synthetic');});
  await assert.rejects(request('https://example.invalid/'),/TRANSPORT_ORIGIN/);assert.equal(calls,0);
  await request('https://storage.googleapis.com/synthetic');assert.equal(calls,1);
  for(const token of ['',null,'x\ny'])assert.throws(()=>ownerDeliveryRequest(token),/EXISTING_IDENTITY_REQUIRED/);
});
test('untracked delivery code cannot be executed just because local HEAD equals trusted main',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-source-test-'));fs.mkdirSync(path.join(root,'empty-hooks'));
  const git=args=>execFileSync('git',['-c','core.hooksPath='+path.join(root,'empty-hooks'),...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try{
    git(['init','-q']);fs.writeFileSync(path.join(root,'seed'),'SYNTHETIC');git(['add','seed']);git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','-c','commit.gpgsign=false','commit','-qm','Synthetic fixture']);
    const head=git(['rev-parse','HEAD']);fs.mkdirSync(path.join(root,'cloud/xuan-preopen'),{recursive:true});
    fs.writeFileSync(path.join(root,'cloud/xuan-preopen/owner_latest_delivery.mjs'),'// untracked synthetic source');
    await assert.rejects(requireProtectedOwnerCheckout({cwd:root,loadContext:async()=>({association:{policyCommit:head}})}));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('historical loader reads original Git blobs after proving ancestry; current context is not relabelled',async()=>{
  const current='b'.repeat(40),old='a'.repeat(40),calls=[];
  const policy={schemaVersion:1,policyId:'ib-primary-7day-pilot-v1',accountAlias:'IB-HK',basis:'owner-attested-recurring-v1',status:'active',purpose:'xuan-ib-read-only-report',editions:['adhoc','am','pm'],publisher:'codex-verified-candidate-v1',validFrom:'2026-10-01T00:00:00.000Z',expiresAt:'2026-11-01T00:00:00.000Z'};
  const blob=s=>{const b=Buffer.from(s);return crypto.createHash('sha1').update(Buffer.from('blob '+b.length+'\0')).update(b).digest('hex');};
  const fetchImpl=async url=>{
    calls.push(url);if(url.endsWith('/commits/main'))return new Response(JSON.stringify({sha:current}));
    if(url.includes('/compare/'))return new Response(JSON.stringify({status:'ahead',merge_base_commit:{sha:old}}));
    const revision=url.includes('/'+old+'/')?old:current,previousHtml='SYNTHETIC '+revision;
    if(url.endsWith('xuan-ib-account-association-v1.json'))return new Response(associationPolicyText(policy));
    if(url.endsWith('xuan-ib-etf-pending-calls-v1.json'))return new Response(JSON.stringify({schemaVersion:1,purpose:'xuan-etf-owner-declared-pending-calls',entries:[{date:'2026-09-01',usd:revision===old?100:200}]}));
    if(url.endsWith('latest.meta.json'))return new Response(JSON.stringify({sourceSha:'c'.repeat(40),htmlBlob:blob(previousHtml)}));
    if(url.endsWith('latest.html'))return new Response(previousHtml);
    assert.fail('unexpected public context URL');
  };
  const load=createOwnerContextLoader({fetchImpl,now:()=>NOW,configuration:{configuredQueryId:'123',baseCurrency:'USD',providerTimezone:null}});
  const result=await load({phase:'historical-authenticity',policyCommit:old});
  assert.equal(result.association.policyCommit,old);assert.equal(result.reserveLedger.entries[0].usd,100);assert.equal(result.previousHtml,'SYNTHETIC '+old);
  assert.equal(result.association.checkedAt,new Date(NOW).toISOString());assert.ok(calls.some(x=>x.endsWith('/compare/'+old+'...'+current)));
  assert.equal(calls.filter(x=>x.startsWith('https://raw.githubusercontent.com/')&&x.includes('/'+old+'/')).length,4);
  const bad=createOwnerContextLoader({now:()=>NOW,fetchImpl:async url=>url.includes('/compare/')?new Response(JSON.stringify({status:'diverged',merge_base_commit:{sha:'d'.repeat(40)}})):fetchImpl(url)});
  await assert.rejects(bad({phase:'historical-authenticity',policyCommit:old}),/HISTORICAL_ANCESTRY/);
});
test('preview loader binds an ancestor registration to identical current-main bytes without relabelling its commit',async()=>{
  const current='b'.repeat(40),old='a'.repeat(40),calls=[],registrationText='{"syntheticRegistration":true}\n';
  const policy={schemaVersion:1,policyId:'ib-primary-7day-pilot-v1',accountAlias:'IB-HK',basis:'owner-attested-recurring-v1',status:'active',purpose:'xuan-ib-read-only-report',editions:['adhoc','am','pm'],publisher:'codex-verified-candidate-v1',validFrom:'2026-10-01T00:00:00.000Z',expiresAt:'2026-11-01T00:00:00.000Z'};
  const previousHtml='SYNTHETIC PUBLIC BASELINE',body=Buffer.from(previousHtml),blob=crypto.createHash('sha1').update(Buffer.from('blob '+body.length+'\0')).update(body).digest('hex');
  const responseFor=async(url,{registration=registrationText,comparison='ahead'}={})=>{
    calls.push(url);
    if(url.endsWith('/commits/main'))return new Response(JSON.stringify({sha:current}));
    if(url.includes('/compare/'))return new Response(JSON.stringify({status:comparison,merge_base_commit:{sha:comparison==='ahead'?old:'c'.repeat(40)}}));
    if(url.endsWith(OWNER_PREVIEW_REGISTRATION_PATH))return new Response(url.includes('/'+current+'/')?registration:registrationText);
    if(url.endsWith('xuan-ib-account-association-v1.json'))return new Response(associationPolicyText(policy));
    if(url.endsWith('xuan-ib-etf-pending-calls-v1.json'))return new Response(JSON.stringify({schemaVersion:1,purpose:'xuan-etf-owner-declared-pending-calls',entries:[{date:'2026-09-01',usd:100}]}));
    if(url.endsWith('latest.meta.json'))return new Response(JSON.stringify({sourceSha:'c'.repeat(40),htmlBlob:blob}));
    if(url.endsWith('latest.html'))return new Response(previousHtml);
    assert.fail('unexpected context URL');
  };
  const loader=fetchImpl=>createOwnerContextLoader({fetchImpl,now:()=>NOW});
  const result=await loader(responseFor)({phase:'accepted-preview-historical',policyCommit:old});
  assert.equal(result.association.policyCommit,current);
  assert.deepEqual(result.previewRegistration,{registration:{syntheticRegistration:true},sha256:digest(registrationText),policyCommit:old});
  assert.ok(calls.includes('https://api.github.com/repos/huanwujoy-crypto/fee-console/compare/'+old+'...'+current));
  assert.ok(calls.some(url=>url.includes('/'+old+'/')&&url.endsWith(OWNER_PREVIEW_REGISTRATION_PATH)));
  assert.ok(calls.some(url=>url.includes('/'+current+'/')&&url.endsWith(OWNER_PREVIEW_REGISTRATION_PATH)));
  await assert.rejects(loader(responseFor)({phase:'accepted-preview-admission',policyCommit:old}),/PREVIEW_CURRENT_CONTEXT/);
  await assert.rejects(loader(url=>responseFor(url,{comparison:'diverged'}))({phase:'accepted-preview-historical',policyCommit:old}),/PREVIEW_ANCESTRY/);
  await assert.rejects(loader(url=>responseFor(url,{registration:'{"syntheticRegistration":false}'}))({phase:'accepted-preview-historical',policyCommit:old}),/PREVIEW_REGISTRATION_CHANGED/);
  await assert.rejects(loader(url=>url.endsWith(OWNER_PREVIEW_REGISTRATION_PATH)?new Response('{"x":1,"x":2}'):responseFor(url))({phase:'accepted-preview-admission',policyCommit:current}),/PREVIEW_REGISTRATION_JSON/);
  await assert.rejects(loader(url=>url.endsWith(OWNER_PREVIEW_REGISTRATION_PATH)?new Response('',{status:404}):responseFor(url))({phase:'accepted-preview-admission',policyCommit:current}),/CONTEXT_HTTP/);
  // Real compare responses carry public file patches as well as ancestry.
  // The old 89-byte fixture did not exercise their independent body budget.
  const comparisonBody=(bytes,{status='ahead',mergeBase=old}={})=>{
    const value={status,merge_base_commit:{sha:mergeBase},files:[{filename:'synthetic-public.mjs',patch:''}]};
    value.files[0].patch='x'.repeat(bytes-Buffer.byteLength(JSON.stringify(value)));
    const body=JSON.stringify(value);assert.equal(Buffer.byteLength(body),bytes);return body;
  };
  const withComparison=body=>async url=>url.includes('/compare/')?new Response(body):responseFor(url);
  for(const bytes of [500000,500001,517169,2*1024*1024]){
    const accepted=await loader(withComparison(comparisonBody(bytes)))({phase:'accepted-preview-historical',policyCommit:old});
    assert.equal(accepted.previewRegistration.policyCommit,old);
    assert.equal(accepted.previewRegistration.sha256,digest(registrationText));
  }
  await assert.rejects(loader(withComparison(comparisonBody(2*1024*1024+1)))({phase:'accepted-preview-historical',policyCommit:old}),/CLOUD_RESPONSE_TOO_LARGE/);
  await assert.rejects(loader(withComparison(comparisonBody(500001,{status:'diverged'})))({phase:'accepted-preview-historical',policyCommit:old}),/PREVIEW_ANCESTRY/);
  await assert.rejects(loader(withComparison(comparisonBody(500001,{mergeBase:'d'.repeat(40)})))({phase:'accepted-preview-historical',policyCommit:old}),/PREVIEW_ANCESTRY/);
  await assert.rejects(loader(async url=>url.includes('/compare/')?new Response(comparisonBody(500001),{status:403}):responseFor(url))({phase:'accepted-preview-historical',policyCommit:old}),/CONTEXT_HTTP/);
  // Neither individual protected files nor the ordinary daily lane inherits
  // the saved-preview comparison allowance.
  await assert.rejects(loader(async url=>url.endsWith(OWNER_PREVIEW_REGISTRATION_PATH)?new Response('x'.repeat(500001)):responseFor(url))({phase:'accepted-preview-admission',policyCommit:current}),/CLOUD_RESPONSE_TOO_LARGE/);
  await assert.rejects(loader(withComparison(comparisonBody(500001)))({phase:'historical-authenticity',policyCommit:old}),/CLOUD_RESPONSE_TOO_LARGE/);
  await assert.rejects(loader(responseFor)({phase:'accepted-preview-historical',policyCommit:'not-a-commit'}),/PREVIEW_CONTEXT/);
  const pre=new AbortController();pre.abort();let attempts=0;await assert.rejects(loader(()=>{attempts++;assert.fail();})({phase:'accepted-preview-historical',policyCommit:old,signal:pre.signal}));assert.equal(attempts,0);
  const controller=new AbortController();let enter;const entered=new Promise(resolve=>{enter=resolve;});
  const pending=loader(async(url,options)=>{attempts++;if(url.endsWith(OWNER_PREVIEW_REGISTRATION_PATH)){enter(options.signal);return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}return responseFor(url);})({phase:'accepted-preview-historical',policyCommit:old,signal:controller.signal});
  const child=await entered;controller.abort();await assert.rejects(pending);assert.equal(child.aborted,true);assert.equal(attempts,7);

});
test('protected checkout binds new preview executable and registration bytes even if git status hides a change',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-preview-checkout-'));fs.mkdirSync(path.join(root,'empty-hooks'));
  const git=args=>execFileSync('git',['-c','core.hooksPath='+path.join(root,'empty-hooks'),...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const files=OWNER_PROTECTED_SOURCE_PATHS;
  for(const required of ['cloud/xuan-preopen/owner_preview_access.mjs','cloud/xuan-preopen/owner_sdk_transport.mjs','cloud/xuan-preopen/owner_sdk_transport.py','cloud/xuan-preopen/cloud_io.mjs','cloud/xuan-preopen/report.mjs','security/xuan-owner-approved-audience.json','security/xuan-owner-registered-canary.json',PREVIEW_REPLACEMENT_REGISTRATION_PATH])assert.ok(files.includes(required));
  try{
    git(['init','-q']);
    for(const relative of files){fs.mkdirSync(path.dirname(path.join(root,relative)),{recursive:true});fs.writeFileSync(path.join(root,relative),'SYNTHETIC '+relative);}
    git(['add',...files]);git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','-c','commit.gpgsign=false','commit','-qm','Synthetic fixture']);
    const head=git(['rev-parse','HEAD']),loadContext=async()=>({association:{policyCommit:head}});
    assert.equal(await requireProtectedOwnerCheckout({cwd:root,loadContext}),head);
    let privateCalls=0;
    await assert.rejects(deliverOwnerAcceptedPreview({cwd:root,loadContext,request:()=>{privateCalls++;assert.fail();},storeFactory:()=>{privateCalls++;assert.fail();}}),/PREVIEW_ACCESS_CAPABILITY_REQUIRED/);
    assert.equal(privateCalls,0);
    for(const relative of ['cloud/xuan-preopen/owner_latest_delivery.mjs','cloud/xuan-preopen/owner_accepted_preview.mjs',OWNER_PREVIEW_REGISTRATION_PATH,PREVIEW_REPLACEMENT_REGISTRATION_PATH,'cloud/xuan-preopen/owner_preview_access.mjs','cloud/xuan-preopen/owner_sdk_transport.mjs','cloud/xuan-preopen/owner_sdk_transport.py','cloud/xuan-preopen/cloud_io.mjs','cloud/xuan-preopen/report.mjs','security/xuan-owner-approved-audience.json','security/xuan-owner-registered-canary.json']){
      const initial=fs.readFileSync(path.join(root,relative));git(['update-index','--assume-unchanged',relative]);
      fs.appendFileSync(path.join(root,relative),' CHANGED');
      await assert.rejects(requireProtectedOwnerCheckout({cwd:root,loadContext}),/PROTECTED_SOURCE_BYTES_REQUIRED/);
      fs.writeFileSync(path.join(root,relative),initial);git(['update-index','--no-assume-unchanged',relative]);
    }
    await assert.rejects(requireProtectedOwnerCheckout({cwd:root,loadContext:async()=>({association:{policyCommit:'a'.repeat(40)}})}),/PROTECTED_CHECKOUT_REQUIRED/);
    await assert.rejects(deliverOwnerAcceptedPreview({cwd:root,loadContext:async()=>({association:{policyCommit:'a'.repeat(40)}}),request:()=>{privateCalls++;assert.fail();},verifyDestinationAccess:async()=>{privateCalls++;assert.fail();},storeFactory:()=>{privateCalls++;assert.fail();}}),/PROTECTED_CHECKOUT_REQUIRED/);
    await assert.rejects(deliverOwnerAcceptedPreviewReplacement({cwd:root,loadContext:async()=>({association:{policyCommit:'a'.repeat(40)}}),request:()=>{privateCalls++;assert.fail();},verifyDestinationAccess:async()=>{privateCalls++;assert.fail();},storeFactory:()=>{privateCalls++;assert.fail();}}),/PROTECTED_CHECKOUT_REQUIRED/);
    assert.equal(privateCalls,0);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('empty public private-entry shell has no financial bytes, APIs, scripts, query redirect or embedding',()=>{
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),html=fs.readFileSync(path.join(root,'xuan-ib/private-action.html'),'utf8');
  assert.ok(html.includes('target="_top"'));assert.ok(html.includes('https://storage.cloud.google.com/family-portfolio-gateway-xuan-preopen-private/delivery/owner-latest.html'));
  assert.ok(html.includes("connect-src 'none'"));assert.ok(html.includes("script-src 'none'"));
  assert.ok(!/<script\b|<iframe\b|<input\b|<form\b|\bfetch\s*\(|localStorage|sessionStorage|access_token|cash_accounts|order_id/i.test(html));
  assert.ok(!html.includes('xuan-ib-night-action-v1:'));
  const loader=fs.readFileSync(path.join(root,'xuan-ib/index.html'),'utf8');assert.ok(loader.includes('id="private-action-entry" href="./private-action.html"'));
});
test('fixed replacement resolver preserves original registration and resolves new historical SHA for later weekday verification',async()=>{
  const current='b'.repeat(40),old='a'.repeat(40),hash=b=>crypto.createHash('sha256').update(b).digest('hex'),calls=[];
  const registration={schema:'xuan.owner-accepted-preview-registration.v1',registrationId:'synthetic-saturday',scope:OWNER_SCOPE,ownerBinding:OWNER_BINDING,
    sourceIdentitySha256:SOURCE_IDENTITY_SHA256,dataDate:'2026-10-17',sourceDate:'2026-10-16',captureStartedAt:'2026-10-17T06:00:00.000Z',captureEndedAt:'2026-10-17T06:02:00.000Z',
    completedAt:'2026-10-17T06:03:00.000Z',ordersCaptureStartedAt:'2026-10-17T06:00:01.000Z',ordersCaptureEndedAt:'2026-10-17T06:00:15.000Z',sourceHead:'e'.repeat(40),
    artifactSha256:'e'.repeat(64),modelSha256:'e'.repeat(64),sourceManifestSha256:'e'.repeat(64),sourceManifestContentSha256:'e'.repeat(64),displaySha256:'e'.repeat(64),financialStatus:'partial',unknownFields:['cash','prices']};
  const original=acceptedPreviewRegistrationText(registration),canary='{"syntheticImmutableCanary":true}\n';
  const revision={schema:'xuan.owner-preview-replacement.v1',target:{bucket:'family-portfolio-gateway-xuan-preopen-private',object:'delivery/owner-latest.html'},
    previousRegistrationSha256:hash(original),previousDisplaySha256:registration.displaySha256,canaryRegistrationSha256:hash(canary),registration:{...registration,registrationId:'synthetic-revision',displaySha256:'f'.repeat(64)}};
  const revisionText=previewReplacementRegistrationText(revision),nextSha=hash(acceptedPreviewRegistrationText(revision.registration));
  const policy={schemaVersion:1,policyId:'ib-primary-7day-pilot-v1',accountAlias:'IB-HK',basis:'owner-attested-recurring-v1',status:'active',purpose:'xuan-ib-read-only-report',editions:['adhoc','am','pm'],publisher:'codex-verified-candidate-v1',validFrom:'2026-10-01T00:00:00.000Z',expiresAt:'2026-11-01T00:00:00.000Z'};
  const previousHtml='SYNTHETIC PUBLIC',body=Buffer.from(previousHtml),blob=crypto.createHash('sha1').update(Buffer.from('blob '+body.length+'\0')).update(body).digest('hex');
  const source=async(url,{alterRevision=false}={})=>{calls.push(url);
    if(url.endsWith('/commits/main'))return new Response(JSON.stringify({sha:current}));
    if(url.includes('/compare/'))return new Response(JSON.stringify({status:'ahead',merge_base_commit:{sha:old}}));
    if(url.endsWith(OWNER_PREVIEW_REGISTRATION_PATH))return new Response(original);
    if(url.endsWith(PREVIEW_REPLACEMENT_REGISTRATION_PATH))return new Response(alterRevision&&url.includes('/'+current+'/')?revisionText+' ':revisionText);
    if(url.endsWith('security/xuan-owner-registered-canary.json'))return new Response(canary);
    if(url.endsWith('xuan-ib-account-association-v1.json'))return new Response(associationPolicyText(policy));
    if(url.endsWith('xuan-ib-etf-pending-calls-v1.json'))return new Response(JSON.stringify({schemaVersion:1,purpose:'xuan-etf-owner-declared-pending-calls',entries:[{date:'2026-09-01',usd:100}]}));
    if(url.endsWith('latest.meta.json'))return new Response(JSON.stringify({sourceSha:'c'.repeat(40),htmlBlob:blob}));
    if(url.endsWith('latest.html'))return new Response(previousHtml);assert.fail('unexpected URL');};
  const load=createOwnerContextLoader({fetchImpl:source,now:()=>NOW});
  const legacy=await load({phase:'accepted-preview-historical',policyCommit:old,registrationSha256:hash(original)});
  assert.equal(legacy.previewRegistration.registration.displaySha256,'e'.repeat(64));
  assert.ok(!calls.some(url=>url.endsWith(PREVIEW_REPLACEMENT_REGISTRATION_PATH)));
  const next=await load({phase:'accepted-preview-historical',policyCommit:old,registrationSha256:nextSha});
  assert.equal(next.previewRegistration.policyCommit,old);assert.equal(next.previewRegistration.registration.registrationId,'synthetic-revision');
  assert.equal(next.previewReplacement.sha256,hash(revisionText));assert.equal(next.previewRegistration.sha256,nextSha);
  await assert.rejects(load({phase:'accepted-preview-admission',policyCommit:old,registrationSha256:nextSha}),/CURRENT_CONTEXT/);
  const drift=createOwnerContextLoader({fetchImpl:url=>source(url,{alterRevision:true}),now:()=>NOW});
  await assert.rejects(drift({phase:'accepted-preview-historical',policyCommit:old,registrationSha256:nextSha}),/REPLACEMENT_CHANGED/);
  await assert.rejects(load({phase:'accepted-preview-historical',policyCommit:old,registrationSha256:'0'.repeat(64)}),/REPLACEMENT_METADATA/);
});


test('named storage delivery rejects caller publisher, context, clock, getters or approval before IO',async()=>{
  let calls=0;const forbidden=()=>{calls++;assert.fail('No caller override may execute');};
  for(const key of ['publisherFactory','storeFactory','loadContext','now','approved','result','storageOnly']){
    await assert.rejects(deliverOwnerAcceptedPreviewReplacementStorage({[key]:forbidden}),error=>error.safeCode==='STORAGE_DELIVERY_ARGUMENTS_FORBIDDEN');
  }
  for(const options of [null,[],Object.create({approved:true}),{get html(){calls++;throw Error('SYNTHETIC_GETTER');}},{[Symbol('synthetic')]:true}]){
    await assert.rejects(deliverOwnerAcceptedPreviewReplacementStorage(options),error=>error.safeCode==='STORAGE_DELIVERY_ARGUMENTS_FORBIDDEN');
  }
  await assert.rejects(deliverOwnerAcceptedPreviewReplacementStorage({},'caller-mode'),error=>error.safeCode==='STORAGE_DELIVERY_ARGUMENTS_FORBIDDEN');
  assert.equal(calls,0);
});

test('replacement pre-publisher exceptions attach frozen null-result diagnostics without inventing a write or readback',async()=>{
  const error=Object.assign(Error('SYNTHETIC_CONTEXT_FAILURE'),{safeCode:'OWNER_DELIVERY_CONTEXT_HTTP'});let privateCalls=0;
  const forbidden=()=>{privateCalls++;assert.fail('A failed public precondition must never construct private IO');};
  await assert.rejects(deliverOwnerAcceptedPreviewReplacement({loadContext:async()=>{throw error;},request:forbidden,
    requestPreviewReplacement:forbidden,verifyDestinationAccess:forbidden,storeFactory:forbidden,publisherFactory:forbidden}),caught=>{
    assert.equal(caught,error);const descriptor=Object.getOwnPropertyDescriptor(caught,'ownerPublicationDiagnostics');
    assert.equal(descriptor.enumerable,false);assert.equal(Object.isFrozen(descriptor.value),true);
    const {failureEvidence,...legacy}=descriptor.value;
    assert.deepEqual(legacy,{schema:'xuan.owner-publication.safe-diagnostics.v1',businessAckValidated:0,
      independentReadbackAttempts:0,storeReadbackCompleted:0,fullVerification:null,resultStatus:null,resultCode:null,failureStage:null,failureReason:null});
    assert.deepEqual(failureEvidence,createOwnerFailureEvidence(error));
    return true;
  });
  assert.equal(privateCalls,0);
});
test('replacement exception attachment does not inspect hostile exception getters or proxy traps',async()=>{
  let invoked=0;const forbidden=()=>{invoked++;throw Error('PRIVATE_VALUE_MUST_NOT_BE_READ');};
  const revoked=Proxy.revocable({},{});revoked.revoke();
  for(const error of [Object.defineProperties({}, {safeCode:{get:forbidden},status:{get:forbidden},message:{get:forbidden}}),
    new Proxy({}, {get:forbidden,getPrototypeOf:forbidden,getOwnPropertyDescriptor:forbidden,defineProperty:forbidden}),revoked.proxy]){
    try{await deliverOwnerAcceptedPreviewReplacement({loadContext:async()=>{throw error;}});assert.fail('Synthetic context must reject');}
    catch(caught){assert.equal(caught,error);}
  }
  assert.equal(invoked,0);
});

test('actual pre-publisher main reads retain evidence with null legacy outcomes and no private IO',async()=>{
  for(const kind of ['network','http','json','oversize']){
    let reads=0,privateCalls=0,original;
    const bytes=kind==='oversize'?new Uint8Array(8000001).fill(120):Uint8Array.of(239,187,191,123);
    const loader=createOwnerContextLoader({now:()=>NOW,fetchImpl:async url=>{
      reads++;assert.equal(url,'https://api.github.com/repos/huanwujoy-crypto/fee-console/commits/main');
      if(kind==='network')throw Object.assign(new TypeError('SYNTHETIC_PRIVATE_NETWORK'),{cause:{code:'ETIMEDOUT'}});
      return kind==='http'?new Response('SYNTHETIC_PRIVATE_BODY',{status:503}):new Response(bytes);
    }});
    const loadContext=async options=>{try{return await loader(options);}catch(error){original=error;throw error;}};
    const forbidden=()=>{privateCalls++;assert.fail('No IO or publisher before protected-source validation');};
    let caught;try{await deliverOwnerAcceptedPreviewReplacement({loadContext,request:forbidden,requestPreviewReplacement:forbidden,
      verifyDestinationAccess:forbidden,storeFactory:forbidden,publisherFactory:forbidden});}catch(error){caught=error;}
    assert.equal(caught,original);assert.equal(reads,1);assert.equal(privateCalls,0);
    assert.equal(caught.message,kind==='network'?'REPORT_SOURCE_NETWORK_FAILED':kind==='http'?'REPORT_SOURCE_HTTP_503':kind==='json'?'REPORT_SOURCE_JSON_INVALID':'CLOUD_RESPONSE_TOO_LARGE');
    const descriptor=Object.getOwnPropertyDescriptor(caught,'ownerPublicationDiagnostics'),publication=descriptor.value;
    assert.equal(descriptor.enumerable,false);assert.equal(Object.isFrozen(publication),true);
    for(const key of ['resultStatus','resultCode','failureStage','failureReason','fullVerification'])assert.equal(publication[key],null);
    for(const key of ['businessAckValidated','independentReadbackAttempts','storeReadbackCompleted'])assert.equal(publication[key],0);
    assert.deepEqual(publication.failureEvidence,createOwnerFailureEvidence(caught));
    const read=publication.failureEvidence.read;
    assert.equal(read.requestClass,'github-main');assert.equal(read.readStage,kind==='network'?'fetch':kind==='http'?'http':'body');
    assert.equal(read.httpStatus,kind==='network'?null:kind==='http'?503:200);
    assert.equal(read.observedBodyBytes,['json','oversize'].includes(kind)?bytes.length:null);
    assert.equal(read.bodyLimitBytes,8000000);assert.equal(read.timeoutMs,30000);
    assert.ok(!JSON.stringify(publication).includes('PRIVATE'));
  }
});
test('pre-publisher evidence prefers an existing strict record and cannot reverse hostile or frozen exceptions',async()=>{
  const existing=createOwnerFailureEvidence(Object.assign(new TypeError('SYNTHETIC_PRIVATE_CONTEXT'),{safeCode:'REPORT_SOURCE_NETWORK_FAILED'}),
    {validatorPhase:'historical-authenticity',validatorPoint:'context-second'});
  const preferred=Object.assign(new Error('SYNTHETIC_PRIVATE_WRAPPER'),{safeCode:'OWNER_PREVIEW_REJECTED',failureEvidence:existing});
  let traps=0,privateCalls=0;const forbidden=()=>{traps++;throw Error('SYNTHETIC_PRIVATE_GETTER');};
  const revoked=Proxy.revocable({},{});revoked.revoke();
  const hostile=Object.defineProperties(new TypeError('SYNTHETIC_PRIVATE_ERROR'),{failureEvidence:{get:forbidden},ownerReadDiagnostics:{get:forbidden},
    safeCode:{get:forbidden},safeOrigin:{get:forbidden},message:{get:forbidden},cause:{get:forbidden}});
  const frozen=Object.freeze(new Error('SYNTHETIC_PRIVATE_FROZEN'));
  for(const original of [preferred,hostile,frozen,new Proxy({}, {get:forbidden,getPrototypeOf:forbidden,getOwnPropertyDescriptor:forbidden,defineProperty:forbidden}),revoked.proxy]){
    const noIo=()=>{privateCalls++;assert.fail('No IO or publisher on a failed context');};
    let caught;try{await deliverOwnerAcceptedPreviewReplacement({loadContext:async()=>{throw original;},request:noIo,
      requestPreviewReplacement:noIo,verifyDestinationAccess:noIo,storeFactory:noIo,publisherFactory:noIo});}catch(error){caught=error;}
    assert.equal(caught,original);
  }
  assert.deepEqual(preferred.ownerPublicationDiagnostics.failureEvidence,existing);
  assert.equal(preferred.ownerPublicationDiagnostics.failureEvidence.validatorPoint,'context-second');
  assert.equal(Object.hasOwn(frozen,'ownerPublicationDiagnostics'),false);
  assert.equal(traps,0);assert.equal(privateCalls,0);
});

function diagnosticContextFetch(compareResponse,calls=[]){
  const current='b'.repeat(40),html='SYNTHETIC public HTML';
  const policy={schemaVersion:1,policyId:'ib-primary-7day-pilot-v1',accountAlias:'IB-HK',basis:'owner-attested-recurring-v1',status:'active',purpose:'xuan-ib-read-only-report',
    editions:['adhoc','am','pm'],publisher:'codex-verified-candidate-v1',validFrom:'2026-10-01T00:00:00.000Z',expiresAt:'2026-11-01T00:00:00.000Z'};
  const bytes=Buffer.from(html),blob=crypto.createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
  return async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/commits/main'))return Response.json({sha:current});
    if(url.includes('/compare/'))return compareResponse();
    if(url.endsWith('xuan-ib-account-association-v1.json'))return new Response(associationPolicyText(policy));
    if(url.endsWith('xuan-ib-etf-pending-calls-v1.json'))return Response.json({schemaVersion:1,purpose:'xuan-etf-owner-declared-pending-calls',entries:[{date:'2026-09-01',usd:100}]});
    if(url.endsWith('latest.meta.json'))return Response.json({sourceSha:'c'.repeat(40),htmlBlob:blob});
    if(url.endsWith('latest.html'))return new Response(html);
    assert.fail('Unexpected synthetic route');
  };
}
test('actual preview comparison failures retain raw request, body and timeout facts without changing request sequence',async()=>{
  for(const kind of ['network','http','json','oversize']){
    const calls=[],timeouts=[],originalTimeout=AbortSignal.timeout;
    AbortSignal.timeout=function(ms){timeouts.push(ms);return originalTimeout(ms);};
    const bytes=kind==='oversize'?new Uint8Array(2097153).fill(120):Uint8Array.of(239,187,191,123);
    const original=Object.assign(new TypeError('SYNTHETIC_PRIVATE_NETWORK'),{cause:{code:'ETIMEDOUT'}});
    try{
      const loader=createOwnerContextLoader({now:()=>NOW,fetchImpl:diagnosticContextFetch(()=>{
        if(kind==='network')throw original;
        return kind==='http'?new Response('SYNTHETIC_PRIVATE_BODY',{status:503}):new Response(bytes);
      },calls)});
      await assert.rejects(loader({phase:'accepted-preview-historical',policyCommit:'a'.repeat(40)}),error=>{
        if(kind==='network')assert.equal(error,original);
        else if(kind==='http')assert.equal(error.message,'OWNER_DELIVERY_CONTEXT_HTTP');
        else if(kind==='json')assert.equal(error.name,'SyntaxError');
        else{assert.equal(error.message,'CLOUD_RESPONSE_TOO_LARGE');assert.equal(Object.hasOwn(error,'safeCode'),false);}
        const evidence=createOwnerFailureEvidence(error);
        assert.equal(evidence.read.requestClass,'github-compare');assert.equal(evidence.read.readStage,kind==='network'?'fetch':kind==='http'?'http':'body');
        assert.equal(evidence.read.httpStatus,kind==='network'?null:kind==='http'?503:200);
        assert.equal(evidence.read.observedBodyBytes,['json','oversize'].includes(kind)?bytes.length:null);
        assert.equal(evidence.read.bodyLimitBytes,2097152);assert.equal(evidence.read.timeoutMs,15000);
        if(kind==='json')assert.equal(evidence.read.origin.type,'SyntaxError');
        assert.ok(!JSON.stringify(evidence).includes('PRIVATE'));return true;
      });
      assert.equal(calls.length,6);assert.equal(calls[0].url.endsWith('/commits/main'),true);
      assert.equal(calls[1].url.endsWith('xuan-ib-etf-pending-calls-v1.json'),true);
      assert.equal(calls[5].url.includes('/compare/'),true);
      assert.deepEqual(timeouts,[30000,30000,30000,30000,30000,15000]);
    }finally{AbortSignal.timeout=originalTimeout;}
  }
});
test('owner comparison diagnostic collection never invokes hostile error or response accessors',async()=>{
  let traps=0;const forbidden=()=>{traps++;throw Error('SYNTHETIC_DIAGNOSTIC_SECRET');};
  const bodyError=Object.defineProperties(new TypeError('SYNTHETIC_BODY_SECRET'),{ownerReadDiagnostics:{get:forbidden,configurable:true},safeOrigin:{get:forbidden,configurable:true}});
  const response={ok:true,body:{getReader:()=>({read:async()=>{throw bodyError;},cancel:async()=>{}})}};
  Object.defineProperty(response,'status',{get:forbidden});
  const proxy=new Proxy({}, {get:forbidden,getOwnPropertyDescriptor:forbidden,getPrototypeOf:forbidden,defineProperty:forbidden});
  for(const expected of [bodyError,proxy]){
    const loader=createOwnerContextLoader({now:()=>NOW,fetchImpl:diagnosticContextFetch(()=>{if(expected===proxy)throw proxy;return response;})});
    let caught;try{await loader({phase:'accepted-preview-historical',policyCommit:'a'.repeat(40)});}catch(error){caught=error;}
    assert.equal(caught,expected);
  }
  assert.equal(traps,0);
});
