// Entirely synthetic. These tests never load real captures, keys or providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDailyActionPipeline,prepareDailyActionInput,verifyDailyActionDelivery,ACTION_FIXED_URL,ACTION_CIPHERTEXT_PATH} from './action_daily.mjs';
import {digest,SHARESIGHT_BROWSER_SOURCE,SHARESIGHT_REFERENCE_DATE_BASIS} from './eod_sources.mjs';
import {validateEodReceipt} from './eod_report.mjs';
import {fingerprint} from '../../scripts/xuan-ib-run-manifest.mjs';
import {associationPolicyBlob} from '../../scripts/xuan-ib-account-association.mjs';
import {packagePublishedAction,decryptPublishedAction} from '../../scripts/xuan-ib-encrypted-action.mjs';
import {extractNightActionModel} from '../../scripts/xuan-ib-night-action-view.mjs';
import {actionConcentrationResult} from '../../scripts/xuan-ib-action-concentration.mjs';
const DAY='2026-10-26',SOURCE='2026-10-23',NOW=Date.parse(DAY+'T05:20:00.000Z');
const RUN='11111111-2222-4333-8444-555555555555',HEAD='a'.repeat(40),KEY=Buffer.alloc(32,7).toString('base64url');
globalThis.fetch=()=>assert.fail('Offline only');
const keys=['sharesight.ibGroupedPerformance','sharesight.schwabPerformance','sharesight.webullPerformance'];
const ids=[936247,936249,1350094],names=['IB-HK','Schwab-HK','Webull'];
const context=()=>{
  const policy={schemaVersion:1,policyId:'ib-primary-7day-pilot-v1',accountAlias:'IB-HK',basis:'owner-attested-recurring-v1',status:'active',purpose:'xuan-ib-read-only-report',editions:['adhoc','am','pm'],publisher:'codex-verified-candidate-v1',validFrom:'2026-10-01T00:00:00.000Z',expiresAt:'2026-11-01T00:00:00.000Z'};
  return {association:{policy,policyCommit:HEAD,policyBlob:associationPolicyBlob(policy),checkedAt:new Date(NOW).toISOString()},previousSourceSha:'b'.repeat(40),previousHtml:'',
    reserveLedger:{schemaVersion:1,purpose:'xuan-etf-owner-declared-pending-calls',entries:[{date:'2026-09-17',usd:100}]}};
};
function snapshot(index){
  const id=ids[index],key=keys[index],rows=[['CSPX','美国底仓',450,1310832,'etf'],['USSC','美国底仓',50,9000002,'etf'],['GOOG','美国科技',250,9000003,'ordinary_shares'],['EXUS','非美发达',180,9000004,'etf'],['EIMI','新兴市场',70,9000005,'etf'],['TLT','防御资产',90,9000006,'etf']];
  const holdings=rows.map(([code,group_name,value,i,type],n)=>({id:9900001+n,group_name,value,quantity:10,portfolio:{id},instrument_price:value/10,
    instrument:{id:i,code,market_code:'TEST',name:'Synthetic instrument',currency_code:'USD',friendly_instrument_description_code:type},instrument_currency:{code:'USD'},valid_position:true,labels:[],number_of_unconfirmed_transactions:0}));
  const old={mode:'read_only',source:'Sharesight User API',portfolio:{id,name:names[index],currency_code:'USD'},data:{report:{portfolio_id:id,value:1290,currency:{code:'USD'},start_date:SOURCE,end_date:SOURCE,include_sales:false,percentages_annualised:false,
    ...(index===0?{grouping:'custom_group_category',custom_group:{id:83569,name:'资产类别'}}:{}),holdings,cash_accounts:[{id:8800000+index,portfolio:{id},name:'Synthetic cash',value:200,currency:{code:'USD'}}]}}};
  return {mode:'read_only',source:SHARESIGHT_BROWSER_SOURCE,dateBasis:SHARESIGHT_REFERENCE_DATE_BASIS,
    observation:{portfolio:names[index],portfolioId:id,captureStartedAt:DAY+'T03:00:00.000Z',valuationDate:index===2?DAY:SOURCE,retrievedAt:DAY+`T03:${index}1:00.000Z`,reportingCurrency:'USD',portfolioValue:1290,
      positions:holdings.map(h=>({instrument:h.instrument.code+' | TEST',description:'Synthetic instrument',price:h.instrument_price,priceCurrency:'USD',quantity:h.quantity,marketValueUSD:h.value,sourcePath:'/holdings/'+h.id,priceDate:null})),
      cash:[{name:'Synthetic cash',marketValueUSD:200,sourcePath:'/cash_accounts/'+(8800000+index),nativeCurrency:null,nativeBalance:null}]},
    classification:{sourceKey:key,status:'date-verified',raw:old,rawFingerprint:digest(old),provenance:{sourceDate:SOURCE,readAt:SOURCE+'T22:00:00.000Z'}}};
}
function input({noah=false,orders=false}={}){
  const snapshots=Object.fromEntries(keys.map((k,i)=>[k,snapshot(i)]));
  if(noah){const raw=structuredClone(snapshots[keys[0]]);raw.classification=null;Object.assign(raw.observation,{portfolio:'NOAH-HK',portfolioId:936238,portfolioValue:300,positions:[{instrument:'SYNTH | OTHER',description:'Synthetic',price:10,priceCurrency:'USD',quantity:10,marketValueUSD:100,sourcePath:'/holdings/99',priceDate:null}]});snapshots['sharesight.noahPerformance']=raw;}
  const result={snapshots};
  if(orders){const raw={orders:[{order_id:1,order_status:'NEW',order_type:'LIMIT',side:'BUY',limit_price:'10',total_shares_qty:'10',cum_shares_qty:'4',remaining_shares_qty:'6',primary_description:'Buy 10 EXUS',secondary_description:'Synthetic instrument',order_time:SOURCE+'T14:00:00Z'}],complete:true};
    result.ordersCapture={status:'captured',channel:'cloud-mcp',sources:[{sourceKey:'ib.orders',raw,rawFingerprint:fingerprint(raw),startedAt:DAY+'T05:10:00.000Z',completedAt:DAY+'T05:10:10.000Z',accountEvidence:{associationBasis:'owner-attested',nativeIdentityEvidence:'not-provided',responseAccountEvidence:'not-provided'}}]};}
  return result;
}
function runtime({casUnknown=false,readbackBad=false,deny=false,claimState=new Set(),writeFailAt=0,encryptFail=false}={}){
  const objects=new Map(),events=[];let writes=0,cas=0,stored=null,readbacks=0,encryptions=0;
  const io={savePrivateCreateOnly:async(name,text)=>{
    writes++;events.push('write');if(writes===writeFailAt)throw Error('PRIVATE_OR_SECRET_CANARY');
    assert(!objects.has(name));const generation=String(writes+10),bytes=Buffer.from(text);objects.set(name,{generation,bytes});return {generation,sha256:digest(bytes)};
  },readPinnedSource:async pin=>{const found=objects.get(pin.name);assert.equal(found.generation,pin.generation);assert.equal(digest(found.bytes),pin.sha256);return found.bytes;},
  readDailyBundle:async({dataDate})=>{const artifactObject=`delivery/${dataDate}/report.html`,receiptObject=`delivery/${dataDate}/receipt.json`,h=objects.get(artifactObject),r=objects.get(receiptObject);
    return {html:h.bytes,receipt:r.bytes,artifactObject,artifactGeneration:h.generation,artifactSha256:digest(h.bytes),receiptObject,receiptGeneration:r.generation,receiptSha256:digest(r.bytes)};},
  readLatest:async()=>({state:'absent'}),replaceLatest:async({target,bytes,ifGenerationMatch})=>{assert.equal(ifGenerationMatch,'0');cas++;events.push('cas');stored=Buffer.from(bytes);if(casUnknown)throw Error('PRIVATE_OR_SECRET_CANARY');return {...target,generation:'999',size:stored.length};},
  readLatestGeneration:async({generation})=>{assert.equal(generation,'999');readbacks++;return readbackBad?Buffer.from('bad'):stored;}};
  const deps={now:()=>NOW,loadContext:async()=>context(),admitRun:async scope=>deny?{status:'denied'}:{status:'approved',...scope},
    claimDaily:async scope=>{events.push('claim');if(claimState.has(scope.key))return {status:'exists'};claimState.add(scope.key);return {status:'created',key:scope.key,runId:scope.runId};},
    checkpoint:async record=>events.push(record.stage),io,prepareCommit:async()=>events.push('protected-commit'),
    encryptFixed:async request=>{encryptions++;events.push('encrypt');if(encryptFail)throw Error('PRIVATE_OR_SECRET_CANARY');return packagePublishedAction({...request,masterKey:KEY});}};
  return {deps,objects,events,pipeline:createDailyActionPipeline(deps),stats:()=>({writes,cas,readbacks,encryptions})};
}
const run=(r,i=input())=>r.pipeline.run({runId:RUN,approvedHead:HEAD,input:i});

test('real generator -> independent admission -> CAS/pinned GET -> existing encryption -> protected public-byte verification',async()=>{
  const r=runtime(),result=await run(r,input({noah:true,orders:true}));
  assert.equal(result.status,'ciphertext-review-required',JSON.stringify(result));assert.deepEqual(r.stats(),{writes:9,cas:1,readbacks:1,encryptions:1});
  const m=extractNightActionModel(r.objects.get(`delivery/${DAY}/report.html`).bytes.toString());
  assert.equal(m.concentration.bindings.length,3);assert.equal(actionConcentrationResult(m.concentration).denominatorCents,'387000');
  assert.equal(m.cash.callApplied,50);assert.equal(m.cash.orderReserve,60);assert.equal(m.cash.planning,290);assert.equal(m.cash.executableBudget,null);
  const decoded=await decryptPublishedAction(result.candidate.text,KEY);assert.equal(decoded.reportDate,DAY);assert.equal(decoded.displaySha256,result.privateResult.sha256);
  assert.equal(decoded.html.includes('合成密钥'),false);assert(!result.candidate.text.includes('Synthetic'));assert.equal(result.candidate.path,ACTION_CIPHERTEXT_PATH);
  assert.equal(result.publicPublished,false);
  const delivered=verifyDailyActionDelivery({candidate:result.candidate,approvedCiphertextHead:'c'.repeat(40),deployment:{status:'success',commit:'c'.repeat(40),url:ACTION_FIXED_URL},publicBytes:Buffer.from(result.candidate.text)});
  assert.equal(delivered.status,'public-ciphertext-verified');assert.equal(delivered.unlockStatus,'not-tested');
});
test('three brokers only: no implicit fourth read, absent NOAH/orders do not become zero or complete coverage',async()=>{
  const r=runtime(),result=await run(r);assert.equal(result.status,'ciphertext-review-required',JSON.stringify(result));
  const m=extractNightActionModel(r.objects.get(`delivery/${DAY}/report.html`).bytes.toString());
  assert.equal(m.cash.noah,null);assert.equal(m.cash.planning,null);assert.equal(m.orders.status,'unknown');assert.equal(m.concentration.bindings.length,3);
  assert.equal(m.provenance.sharesight.length,1);assert.equal(m.sourceOutcomes.find(s=>s.sourceKey==='sharesight.noahPerformance').status,'not-called');
  await assert.rejects(()=>run(r),/ATTEMPT_ALREADY_USED/);
});
test('same-day durable claim prevents another process or 13:10 fallback from repeating a run',async()=>{
  const claimState=new Set(),a=runtime({claimState}),b=runtime({claimState});await run(a);
  await assert.rejects(()=>run(b),/DAILY_CLAIM_NOT_ACQUIRED/);assert.equal(b.stats().writes,0);assert.equal(b.stats().cas,0);
});
test('concurrent calls on one controller cannot both pass the pre-await guard',async()=>{
  const r=runtime();let release;
  const barrier=new Promise(resolve=>release=resolve);
  r.deps.admitRun=async scope=>{await barrier;return {status:'approved',...scope};};r.pipeline=createDailyActionPipeline(r.deps);
  const first=run(r);await assert.rejects(()=>run(r),/ATTEMPT_ALREADY_USED/);release();
  assert.equal((await first).status,'ciphertext-review-required');assert.equal(r.stats().cas,1);
});
test('uncertain durable claim is neither leaked nor repeated, including in the same process',async()=>{
  const r=runtime();let claims=0;r.deps.claimDaily=async()=>{claims++;throw Error('PRIVATE_CANARY');};r.pipeline=createDailyActionPipeline(r.deps);
  await assert.rejects(()=>run(r),/DAILY_CLAIM_OUTCOME_UNKNOWN/);await assert.rejects(()=>run(r),/ATTEMPT_ALREADY_USED/);
  assert.equal(claims,1);assert.equal(r.stats().writes,0);
});
test('missing runtime/real head admission stops before claim or writes',async()=>{
  assert.throws(()=>createDailyActionPipeline(),/APPROVED_RUNTIME_REQUIRED/);
  const r=runtime({deny:true});await assert.rejects(()=>run(r),/RUN_NOT_APPROVED/);assert.equal(r.events.length,0);
});
test('unknown CAS, wrong fixed GET, evidence interruption and encryption failure never encrypt unverified data or retry CAS',async()=>{
  for(const options of [{casUnknown:true},{readbackBad:true},{writeFailAt:4},{encryptFail:true}]){
    const r=runtime(options),result=await run(r);assert.equal(result.status,'stopped');assert.equal(result.retryAllowed,false);
    assert(!JSON.stringify(result).includes('CANARY'));await assert.rejects(()=>run(r),/ATTEMPT_ALREADY_USED/);
    if(!options.encryptFail)assert.equal(r.stats().encryptions,0);
    assert.equal(r.stats().cas,options.writeFailAt?0:1);
  }
});
test('normal daily handoff accepts actual Sharesight date instead of relabelling it as last market close',async()=>{
  const r=runtime(),i=input();i.snapshots[keys[0]].observation.valuationDate=DAY;
  const result=await run(r,i);assert.equal(result.status,'ciphertext-review-required',JSON.stringify(result));
  const receipt=JSON.parse(r.objects.get(`delivery/${DAY}/receipt.json`).bytes);
  assert.equal(receipt.sourceDate,DAY);assert.equal(receipt.calendar.sourceDate,SOURCE);
  assert.equal(receipt.dateBasis,SHARESIGHT_REFERENCE_DATE_BASIS);
});
test('daily copy preserves original concentration source prefix and rejects substituted paths',async()=>{
  const r=runtime();await run(r);const receipt=JSON.parse(r.objects.get(`delivery/${DAY}/receipt.json`).bytes),html=r.objects.get(`delivery/${DAY}/report.html`).bytes.toString();
  assert(receipt.concentration.privateObject.startsWith('report-check/'));validateEodReceipt(receipt,html,DAY,SOURCE);
  receipt.concentration.privateObject=`delivery/${DAY}/concentration.sources.json`;
  assert.throws(()=>validateEodReceipt(receipt,html,DAY,SOURCE),/CONCENTRATION_BINDING/);
});
test('wrong/missing/duplicate accounts, bad row sum, altered classification, invalid/future dates reject before writes',async()=>{
  for(const mutate of [x=>delete x.snapshots[keys[1]],x=>x.snapshots.extra=x.snapshots[keys[0]],x=>x.snapshots[keys[2]]=x.snapshots[keys[1]],
    x=>x.snapshots[keys[0]].observation.portfolioValue++,x=>x.snapshots[keys[0]].classification.rawFingerprint='f'.repeat(64),
    x=>x.snapshots[keys[0]].observation.retrievedAt='2026-10-25T01:00:00.000Z',x=>x.snapshots[keys[0]].observation.valuationDate='2020-01-01',
    x=>x.snapshots[keys[0]].observation.retrievedAt='2026-10-26T15:00:00.000Z',x=>x.snapshots[keys[0]].observation.valuationDate='2026-10-27']){
    const r=runtime(),i=input();mutate(i);await assert.rejects(()=>run(r,i));assert.equal(r.events.length,0);
  }
});
test('orders accept only separately captured orders; reject positions/balances, tampered bytes and future times',()=>{
  for(const mutate of [x=>x.ordersCapture.sources[0].sourceKey='ib.positions',x=>x.ordersCapture.sources.push(x.ordersCapture.sources[0]),
    x=>x.ordersCapture.sources[0].rawFingerprint='0'.repeat(64),x=>x.ordersCapture.sources[0].completedAt='2099-01-01T00:00:00.000Z']){
    const i=input({orders:true});mutate(i);assert.throws(()=>prepareDailyActionInput(i,{now:NOW}),/ORDERS_SCOPE/);
  }
});
test('over-30-minute orders keep reference holdings but cannot fund a current executable budget',async()=>{
  const i=input({noah:true,orders:true}),s=i.ordersCapture.sources[0];s.startedAt=DAY+'T04:00:00.000Z';s.completedAt=DAY+'T04:00:10.000Z';
  const r=runtime(),result=await run(r,i);assert.equal(result.status,'ciphertext-review-required',JSON.stringify(result));
  const m=extractNightActionModel(r.objects.get(`delivery/${DAY}/report.html`).bytes.toString());assert.equal(m.orders.status,'unknown');assert.equal(m.cash.orderReserve,null);assert.equal(m.cash.planning,null);
});
test('public verification cannot pass for old bytes, another path, a pending deployment or different head',async()=>{
  const result=await run(runtime()),args={candidate:result.candidate,approvedCiphertextHead:'c'.repeat(40),deployment:{status:'success',commit:'c'.repeat(40),url:ACTION_FIXED_URL},publicBytes:Buffer.from(result.candidate.text)};
  for(const mutate of [a=>a.publicBytes=Buffer.from('{}'),a=>a.candidate.path='data.json',a=>a.deployment.status='pending',a=>a.deployment.commit='d'.repeat(40)]){
    const a=structuredClone(args);mutate(a);assert.throws(()=>verifyDailyActionDelivery(a),/PUBLIC_READBACK/);
  }
});
