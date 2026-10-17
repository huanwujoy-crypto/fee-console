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
import {deliverOwnerLatest,ownerBundleMetadata,ownerDeliveryRequest,createOwnerDeliveryHook,createOwnerContextLoader,requireProtectedOwnerCheckout} from './owner_latest_delivery.mjs';
import {buildEodActionModel} from '../../scripts/xuan-ib-eod-action-model.mjs';
import {renderNightActionReport} from '../../scripts/xuan-ib-night-action-view.mjs';
import {resolveCurrentCall} from './call_record.mjs';
import {digest} from './eod_sources.mjs';
import {collectDelivery} from './delivery.mjs';
import {buildPublicEodSummary} from '../../scripts/xuan-ib-public-eod-summary.mjs';
import {associationPolicyText} from '../../scripts/xuan-ib-account-association.mjs';

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
test('controller uses exact generation-pinned bundle bytes and preserves original times and unknown states',async()=>{
  const f=fixture();let candidate;
  const result=await deliverOwnerLatest({now:()=>NOW,request:()=>assert.fail(),loadContext:async()=>assert.fail(),storeFactory:()=>({readDailyBundle:async({dataDate})=>{assert.equal(dataDate,'2026-10-15');return f.bundle;},readPinnedSource:()=>assert.fail()}),
    publisherFactory:opts=>{assert.equal(typeof opts.verifyProtectedReceipt,'function');assert.equal(typeof opts.prepareDisplay,'function');return {publish:async c=>{candidate=c;return {status:'published-verified'};}};}});
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
test('empty public private-entry shell has no financial bytes, APIs, scripts, query redirect or embedding',()=>{
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),html=fs.readFileSync(path.join(root,'xuan-ib/private-action.html'),'utf8');
  assert.ok(html.includes('target="_top"'));assert.ok(html.includes('https://storage.cloud.google.com/family-portfolio-gateway-xuan-preopen-private/delivery/owner-latest.html'));
  assert.ok(html.includes("connect-src 'none'"));assert.ok(html.includes("script-src 'none'"));
  assert.ok(!/<script\b|<iframe\b|<input\b|<form\b|\bfetch\s*\(|localStorage|sessionStorage|access_token|cash_accounts|order_id/i.test(html));
  assert.ok(!html.includes('xuan-ib-night-action-v1:'));
  const loader=fs.readFileSync(path.join(root,'xuan-ib/index.html'),'utf8');assert.ok(loader.includes('id="private-action-entry" href="./private-action.html"'));
});
