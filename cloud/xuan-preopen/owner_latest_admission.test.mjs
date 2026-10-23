import {SHARESIGHT_BROWSER_SOURCE} from './eod_sources.mjs';
// Synthetic offline evidence only. No captured accounts/values, real storage,
// credentials, network, uploads or production context are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareOwnerStaticDisplay,createProtectedOwnerVerifier,OWNER_BINDING,SOURCE_IDENTITY_SHA256,OWNER_SCOPE,OWNER_DISPLAY_CSP} from './owner_latest_admission.mjs';
import {runPrivateEodReport,saveCompletedDailyReport,validateEodReceipt} from './eod_report.mjs';
import {ownerBundleMetadata,deliverOwnerLatest} from './owner_latest_delivery.mjs';
import {digest,SNAPSHOT_SCOPES} from './eod_sources.mjs';
import {associationPolicyBlob} from '../../scripts/xuan-ib-account-association.mjs';
import {fingerprint,APPROVED_IB_ACCOUNT_ID} from '../../scripts/xuan-ib-run-manifest.mjs';
import {extractNightActionModel,renderNightActionReport} from '../../scripts/xuan-ib-night-action-view.mjs';
const NOW=Date.parse('2026-10-15T05:02:00.000Z'),SOURCE='2026-10-14';
const encode=s=>new TextEncoder().encode(s),text=b=>new TextDecoder().decode(b);
globalThis.fetch=()=>assert.fail('Synthetic admission tests must never access the network');
function context(time=NOW){
  const policy={schemaVersion:1,policyId:'ib-primary-7day-pilot-v1',accountAlias:'IB-HK',basis:'owner-attested-recurring-v1',status:'active',purpose:'xuan-ib-read-only-report',editions:['adhoc','am','pm'],publisher:'codex-verified-candidate-v1',validFrom:'2026-10-01T00:00:00.000Z',expiresAt:'2026-11-01T00:00:00.000Z'};
  return {association:{policy,policyCommit:'a'.repeat(40),policyBlob:associationPolicyBlob(policy),checkedAt:new Date(time).toISOString()},previousSourceSha:'b'.repeat(40),previousHtml:'',reserveLedger:{schemaVersion:1,purpose:'xuan-etf-owner-declared-pending-calls',entries:[{date:'2026-09-17',usd:100}]},
    eodConfiguration:{account:APPROVED_IB_ACCOUNT_ID,configuredQueryId:'SYNTHETIC_SOURCE_QUERY',baseCurrency:'USD',providerTimezone:null}};
}
const order=()=>({order_id:1,order_status:'NEW',order_type:'LIMIT',side:'BUY',limit_price:'10',total_shares_qty:'10',cum_shares_qty:'4',remaining_shares_qty:'6',primary_description:'Buy 10 EXUS',secondary_description:'Synthetic instrument',order_time:'2026-10-14T14:00:00Z'});
function snapshot(key){
  const scope=SNAPSHOT_SCOPES[key];
  const h=(id,group_name,value,code)=>({id,group_name,value,quantity:10,instrument:{code,currency:{code:'USD'}}});
  return {raw:{mode:'read_only',source:'Sharesight User API',data:{report:{portfolio_id:scope.portfolioId,currency:{code:'USD'},start_date:SOURCE,end_date:SOURCE,include_sales:false,
    ...(key==='sharesight.ibGroupedPerformance'?{grouping:'custom_group_category',custom_group:{id:Number(scope.grouping),name:'资产类别'},holdings:[h(1,'美国底仓',450,'CSPX'),h(2,'美国底仓',50,'USSC'),h(3,'美国科技',250,'GOOG'),h(4,'非美发达',180,'EXUS'),h(5,'新兴市场',70,'EIMI'),h(6,'防御资产',90,'TLT')]}:{grouping:scope.grouping}),cash_accounts:[{value:200}]}}}};
}
async function fixture({live=true,fieldMode=true,saveDelayMs=0,book=false,completeOrders=false,browser=false,browserClassification=true}={}){
  const objects=new Map();let generation=0,time=NOW;
  const io={savePrivate:async(name,value)=>{const bytes=encode(typeof value==='string'?value:JSON.stringify(value));objects.set(name,bytes);time+=saveDelayMs;return {sha256:digest(typeof value==='string'?value:JSON.stringify(value)),generation:String(++generation)};}};
  const startedAt=new Date(NOW-60000).toISOString(),completedAt=new Date(NOW-10000).toISOString(),raw={orders:[order()],...(completeOrders?{complete:true}:{})};
  const cfg=context().eodConfiguration;
  const xml=`<AF><FlexStatements><FlexStatement accountId="${cfg.account}" fromDate="2026-10-01" toDate="${SOURCE}" whenGenerated="2026-10-15;00:15:30"><CashReport><CashReportCurrency accountId="${cfg.account}" reportDate="${SOURCE}" levelOfDetail="BaseCurrency" currency="BASE_SUMMARY" endingCash="200" endingSettledCash="180"/><CashReportCurrency accountId="${cfg.account}" reportDate="${SOURCE}" levelOfDetail="Currency" currency="USD" endingCash="200" endingSettledCash="180"/></CashReport></FlexStatement></FlexStatements></AF>`;
  const archive={bytes:xml,metadata:{privateObject:'synthetic/offline/archive.xml',generation:'1',rawSha256:digest(xml),configuredQueryId:cfg.configuredQueryId,baseCurrency:'USD',providerTimezone:null}};
  const receipt=await runPrivateEodReport({sourceDate:SOURCE,io,now:()=>time,loadContext:async()=>context(time),fieldMode,assumeSharesightSynchronized:book,initialStartedAt:fieldMode?NOW-60000:null,
    readArchive:fieldMode?null:async()=>archive,verifyArchive:fieldMode?null:async()=>({status:'archive-verified',account:cfg.account,configuredQueryId:cfg.configuredQueryId,sourceDate:SOURCE,rawSha256:digest(xml),generation:'1'}),
    expectedAccount:cfg.account,expectedQueryId:cfg.configuredQueryId,snapshotReader:async({sourceKey})=>{const s=snapshot(sourceKey),r=s.raw.data.report;
      if(book&&sourceKey==='sharesight.ibGroupedPerformance'){
        r.value=r.holdings.reduce((n,h)=>n+h.value,0)+200;
        for(const h of r.holdings){h.instrument.id=h.id;h.instrument.market_code='TEST';}
      }
      if(browser){
        const ib=sourceKey==='sharesight.ibGroupedPerformance';
        return {raw:{mode:'read_only',source:SHARESIGHT_BROWSER_SOURCE,observation:{portfolio:ib?'IB-HK':'NOAH-HK',valuationDate:SOURCE,retrievedAt:new Date(time).toISOString(),reportingCurrency:'USD',portfolioValue:ib?r.value:300,
          positions:ib?r.holdings.map(h=>({instrument:h.instrument.code+' | TEST',price:10,priceCurrency:'USD',quantity:h.quantity,marketValueUSD:h.value,sourcePath:'/holdings/'+h.id,priceDate:null})):[{instrument:'SYNTH | OTHER',price:10,priceCurrency:'USD',quantity:10,marketValueUSD:100,sourcePath:'/holdings/99',priceDate:null}],
          cash:[{name:'Synthetic cash',marketValueUSD:200,sourcePath:'/cash_accounts/1',nativeCurrency:'USD',nativeBalance:200}]},
          classification:ib&&browserClassification?{sourceKey,status:'date-verified',raw:s.raw,rawFingerprint:digest(s.raw),provenance:{readAt:new Date(time-120000).toISOString(),sourceDate:SOURCE}}:null}};
      }return s;},
    captureOptionalLive:live?async()=>({status:'captured',sources:[{sourceKey:'ib.orders',raw,rawFingerprint:fingerprint(raw),startedAt,completedAt}]}):null});
  const html=text(objects.get(receipt.artifact.privateObject)),model=extractNightActionModel(html);
  receipt.artifact={...receipt.artifact,privateObject:'delivery/2026-10-15/report.html'};
  const f={objects,receipt,model,html,reads:[],contexts:[]};refresh(f);return f;
}
function refresh(f){
  const manifest=f.receipt.sources.map(s=>({sourceKey:s.sourceKey,privateObject:s.privateObject,generation:s.generation,sha256:s.sha256,rawFingerprint:s.rawFingerprint})).sort((a,b)=>a.sourceKey.localeCompare(b.sourceKey));
  f.receipt.sourceManifestSha256=digest(manifest);f.model.sourceManifestSha256=f.receipt.sourceManifestSha256;
  f.receipt.evidenceSha256=digest({sourceOutcomes:f.model.sourceOutcomes,sourceManifestSha256:f.model.sourceManifestSha256});
  f.model.evidenceSha256=f.receipt.evidenceSha256;f.receipt.sourceOutcomes=structuredClone(f.model.sourceOutcomes);
  f.html=renderNightActionReport(f.model);f.receipt.artifact.sha256=digest(f.html);f.htmlBytes=encode(f.html);f.receiptBytes=encode(JSON.stringify(f.receipt));
  f.metadata={schema:'xuan.owner-latest.v1',scope:OWNER_SCOPE,ownerBinding:OWNER_BINDING,sourceIdentitySha256:SOURCE_IDENTITY_SHA256,dataDate:f.receipt.dataDate,sourceDate:f.receipt.sourceDate,
    captureStartedAt:f.receipt.startedAt,captureEndedAt:f.receipt.completedAt,completedAt:f.receipt.completedAt,artifactObject:f.receipt.artifact.privateObject,artifactGeneration:f.receipt.artifact.generation,
    artifactSha256:digest(f.html),receiptObject:`delivery/${f.receipt.dataDate}/receipt.json`,receiptGeneration:'99',receiptSha256:digest(JSON.stringify(f.receipt)),financialStatus:'partial',unknownFields:['orders','cash','prices']};
}
function verifier(f,{time=NOW,loadContext,readPinnedSource}={}){
  return createProtectedOwnerVerifier({now:()=>time,loadContext:loadContext??(async opts=>{f.contexts.push(opts);return context(time);}),readPinnedSource:readPinnedSource??(async pin=>{f.reads.push(pin);return f.objects.get(pin.name);})});
}
const args=(f,phase='candidate-admission',time=NOW)=>({metadata:f.metadata,html:f.htmlBytes,receipt:f.receiptBytes,now:time,phase});

test('actual pure runner receipt passes only after four pinned byte reads and complete source/model rebuilding',async()=>{
  const f=await fixture(),proof=await verifier(f)(args(f));
  assert.deepEqual(proof,{scope:OWNER_SCOPE,ownerBinding:OWNER_BINDING,artifactSha256:f.metadata.artifactSha256,receiptSha256:f.metadata.receiptSha256,sourceIdentitySha256:SOURCE_IDENTITY_SHA256,policyRevision:fingerprint(context().association.policy),financialStatus:'partial'});
  assert.equal(f.reads.length,4);assert.equal(new Set(f.reads.map(p=>p.name)).size,4);
  for(const pin of f.reads)assert.deepEqual(Object.keys(pin).sort(),['generation','name','sha256']);
  assert.equal(f.model.orders.status,'partial');assert.equal(f.model.cash.orderReserve,null);assert.equal(f.model.cash.planning,null);
});
test('daily completion handoff passes source reconstruction and preserves all five static sections',async()=>{
  const f=await fixture(),saved=new Map();
  const io={savePrivate:async(name,value)=>{
    const bytes=encode(typeof value==='string'?value:JSON.stringify(value)),generation=String(100+saved.size);
    saved.set(name,{bytes,generation});return {generation,sha256:digest(text(bytes))};
  }};
  const receipt=await saveCompletedDailyReport({io,plan:{status:'generate',dataDate:f.receipt.dataDate,sourceDate:SOURCE},receipt:f.receipt,html:f.html});
  const artifactObject=receipt.artifact.privateObject,receiptObject=`delivery/${receipt.dataDate}/receipt.json`;
  assert.deepEqual([...saved.keys()],[artifactObject,receiptObject]);
  const bundle={html:saved.get(artifactObject).bytes,receipt:saved.get(receiptObject).bytes,
    artifactObject,artifactGeneration:receipt.artifact.generation,artifactSha256:receipt.artifact.sha256,
    receiptObject,receiptGeneration:saved.get(receiptObject).generation,receiptSha256:digest(text(saved.get(receiptObject).bytes))};
  const proof=await verifier(f)({metadata:ownerBundleMetadata(bundle,receipt),html:bundle.html,receipt:bundle.receipt,now:NOW,phase:'candidate-admission'});
  assert.equal(proof.artifactSha256,bundle.artifactSha256);assert.equal(f.reads.length,4);
  const display=text(prepareOwnerStaticDisplay(bundle.html));
  assert.equal((display.match(/<section class="card(?: concentration)?"/g)||[]).length,5);
  assert.equal(extractNightActionModel(display).cash.executableBudget,null);
});
test('static export adds exact four IDs/CSP and labels inferred order currency and price distance without changing original model',async()=>{
  const f=await fixture(),before=f.htmlBytes.slice(),out=prepareOwnerStaticDisplay(f.htmlBytes),display=text(out);
  assert.deepEqual(f.htmlBytes,before);assert.notEqual(digest(display),digest(f.html));assert.ok(display.includes(OWNER_DISPLAY_CSP));
  for(const id of ['card-plan','card-orders','card-cash','card-allocation'])assert.equal(display.split('id="'+id+'"').length,2);
  assert.ok(display.includes('USD·推定'));assert.ok(display.includes('.quote span{font-size:10px;white-space:nowrap}'));assert.ok(display.includes('原生挂单币种、合约 ID 与市场身份尚未核实'));
  assert.ok(display.includes('参考价差'));assert.ok(!/<script\b|<iframe\b|<form\b/i.test(display));
  assert.deepEqual(extractNightActionModel(display),f.model);assert.deepEqual(prepareOwnerStaticDisplay(f.htmlBytes),out);
});
test('modified HTML, wrong schema and tampered monetary derivations cannot reach static export',async()=>{
  const f=await fixture();assert.throws(()=>prepareOwnerStaticDisplay(encode(f.html+' ')),/CANONICAL_HTML/);
  const m=structuredClone(f.model);m.cash.orderReserve=0;assert.throws(()=>prepareOwnerStaticDisplay(encode(f.html.replace(Buffer.from(JSON.stringify(f.model)).toString('base64url'),Buffer.from(JSON.stringify(m)).toString('base64url')))));
  for(const b of [new Uint8Array(),new Uint8Array([255]),new Uint8Array(100001)])assert.throws(()=>prepareOwnerStaticDisplay(b));
});
test('candidate stale, future, mismatched clock or caller authority fields fail before source reads',async()=>{
  for(const kind of ['stale','future','clock','approved','identity','unknowns']){
    const f=await fixture();let time=NOW,provided=NOW;
    if(kind==='stale')time=provided=NOW+1800001;
    if(kind==='future')time=provided=NOW-1;
    if(kind==='clock'){time=NOW+1800001;provided=NOW;}
    if(kind==='approved')f.metadata.approved=true;
    if(kind==='identity')f.metadata.sourceIdentitySha256='e'.repeat(64);
    if(kind==='unknowns')f.metadata.unknownFields=['cash'];
    await assert.rejects(verifier(f,{time})({...args(f),now:provided}));assert.equal(f.reads.length,0,kind);
  }
});
test('five-minute capture bound cannot be expanded by metadata or a same-day stored receipt',async()=>{
  const f=await fixture();f.receipt.startedAt=new Date(NOW-300001).toISOString();refresh(f);
  await assert.rejects(verifier(f)(args(f)),/CAPTURE_WINDOW/);assert.equal(f.reads.length,0);
});
test('historical phase authenticates the original pinned Git context without admitting an old candidate',async()=>{
  const f=await fixture(),later=NOW+86400000;
  await assert.rejects(verifier(f,{time:later})(args(f,'candidate-admission',later)),/CANDIDATE_STALE/);
  const proof=await verifier(f,{time:later})(args(f,'historical-authenticity',later));assert.equal(proof.financialStatus,'partial');
  assert.ok(f.contexts.every(c=>c.phase==='historical-authenticity'&&c.policyCommit==='a'.repeat(40)));
  assert.equal(f.reads.length,4);
});
test('current context is not silently substituted for a historical source revision',async()=>{
  const f=await fixture(),later=NOW+86400000;
  await assert.rejects(verifier(f,{time:later,loadContext:async()=>{const c=context(later);c.association.policyCommit='c'.repeat(40);return c;}})(args(f,'historical-authenticity',later)),/HISTORICAL_CONTEXT_UNAVAILABLE/);
  assert.equal(f.reads.length,0);
});
test('CALL/association changes and unknown source readers fail closed',async()=>{
  for(const kind of ['call','previous','revoked','read','bytes']){
    const f=await fixture();const loadContext=async()=>{const c=context();if(kind==='call')c.reserveLedger.entries[0].usd=101;if(kind==='previous')c.previousSourceSha='c'.repeat(40);if(kind==='revoked'){c.association.policy.status='revoked';c.association.policyBlob=associationPolicyBlob(c.association.policy);}return c;};
    const readPinnedSource=kind==='read'?async()=>{throw Error('SYNTHETIC_READ_DENIED');}:kind==='bytes'?async()=>encode('{}'):undefined;
    await assert.rejects(verifier(f,{loadContext,readPinnedSource})(args(f)));
  }
});
test('a source modified together with its outer hashes still cannot change or disagree with reported financial facts',async()=>{
  const f=await fixture(),source=f.receipt.sources.find(s=>s.sourceKey==='sharesight.noahPerformance');
  const value=JSON.parse(text(f.objects.get(source.privateObject)));value.raw.data.report.cash_accounts[0].value=201;value.rawFingerprint=digest(value.raw);
  const bytes=encode(JSON.stringify(value));f.objects.set(source.privateObject,bytes);source.sha256=digest(JSON.stringify(value));source.rawFingerprint=value.rawFingerprint;
  f.model.sourceOutcomes.find(s=>s.sourceKey===source.sourceKey).rawFingerprint=value.rawFingerprint;refresh(f);
  await assert.rejects(verifier(f)(args(f)),/SOURCE_MODEL_MISMATCH/);assert.equal(f.reads.length,4);
});
test('self-asserted sync completion and UI-export source formats are unsupported, even when their outer hashes match',async()=>{
  const f=await fixture(),source=f.receipt.sources.find(s=>s.sourceKey==='sharesight.noahPerformance');
  const value=JSON.parse(text(f.objects.get(source.privateObject)));value.status='verified';const bytes=encode(JSON.stringify(value));f.objects.set(source.privateObject,bytes);source.sha256=digest(JSON.stringify(value));refresh(f);
  await assert.rejects(verifier(f)(args(f)),/SNAPSHOT_STATUS_UNSUPPORTED/);
});
test('late context/ledger changes are caught after the actual source reads',async()=>{
  const f=await fixture();let calls=0;
  await assert.rejects(verifier(f,{loadContext:async()=>{const c=context();if(++calls===2)c.reserveLedger.entries[0].usd=101;return c;}})(args(f)),/CONTEXT_CHANGED/);
  assert.equal(calls,2);assert.equal(f.reads.length,4);
});
test('missing capabilities, invalid verification phase and invalid pin generation remain closed',async()=>{
  assert.throws(()=>createProtectedOwnerVerifier(),/CAPABILITIES_UNAVAILABLE/);
  const f=await fixture();await assert.rejects(verifier(f)({...args(f),phase:'approved-by-caller'}),/PHASE_OR_CLOCK/);
  f.receipt.sources[0].generation='0';refresh(f);await assert.rejects(verifier(f)(args(f)),/SOURCE_PIN/);
});
test('standard non-field EOD output has its exact status updater removed and requires trusted Flex configuration',async()=>{
  const f=await fixture({fieldMode:false,live:false});assert.ok(f.html.includes('<script>'));
  const display=text(prepareOwnerStaticDisplay(f.htmlBytes));assert.ok(!display.includes('<script>'));assert.ok(display.includes('id="card-orders"'));
  assert.equal((await verifier(f)(args(f))).financialStatus,'partial');
  await assert.rejects(verifier(f,{loadContext:async()=>{const c=context();delete c.eodConfiguration;return c;}})(args(f)),/FLEX_TRUSTED_CONFIG_OR_FINANCIAL_PROOF_UNAVAILABLE/);
});
test('header cannot relabel actual capture as a future or different same-day collection window',async t=>{
  for(const fieldMode of [true,false])for(const kind of ['future-end','different-start','reversed','single-minute'])await t.test((fieldMode?'field':'standard')+' '+kind,async()=>{
    const f=await fixture({fieldMode,live:fieldMode});
    const day=f.model.dataDate,source=f.model.sourceDate,start=fieldMode?'13:01':'13:02';
    f.model.asOfHkt=kind==='future-end'?`${day} ${start}–23:59 HKT · 数据至 ${source}`
      :kind==='different-start'?`${day} 13:00–13:02 HKT · 数据至 ${source}`
      :kind==='reversed'?`${day} 13:02–13:01 HKT · 数据至 ${source}`
      :`${day} ${start} HKT · 数据至 ${source}`;
    // The renderer itself rejects a reversed range. Other counterexamples are
    // canonical HTML with recomputed outer hashes, not a mere hash mismatch.
    if(kind==='reversed'){assert.throws(()=>refresh(f),/REPORT_TIME/);return;}
    refresh(f);
    for(const phase of ['candidate-admission','historical-authenticity'])await assert.rejects(verifier(f)(args(f,phase)),/REPORT_TIME_BINDING/);
    assert.equal(f.reads.length,0);
  });
});
test('Flex readAt cannot be moved outside the receipt window even with matching model and artifact hashes',async t=>{
  for(const readAt of ['2026-10-15T15:59:00.000Z','2026-10-15T05:01:59.999Z'])await t.test(readAt,async()=>{
    const f=await fixture({fieldMode:false,live:false});f.model.provenance.flex.readAt=readAt;refresh(f);
    for(const phase of ['candidate-admission','historical-authenticity'])await assert.rejects(verifier(f)(args(f,phase)),/FLEX_READ_TIME/);
    assert.equal(f.reads.length,8);
  });
});
test('receipt capture start cannot borrow an identically formatted time from another HKT report day',async()=>{
  const f=await fixture({fieldMode:false,live:false});
  f.receipt.startedAt='2026-10-14T16:59:00.000Z';f.receipt.completedAt='2026-10-14T17:00:00.000Z';
  // Both instants are canonical and still map to Oct 15 HKT: the UTC date is
  // not the report date. Move the model to Oct 14 to exercise that distinction.
  f.receipt.dataDate=f.model.dataDate='2026-10-14';f.receipt.sourceDate=f.model.sourceDate='2026-10-13';
  f.receipt.artifact.privateObject='delivery/2026-10-14/report.html';
  f.model.asOfHkt='2026-10-14 00:59–01:00 HKT · 数据至 2026-10-13';
  f.model.notes=f.model.notes.map(s=>s.replaceAll('2026-10-14','2026-10-13'));
  f.model.provenance.flex.sourceDate='2026-10-13';f.model.provenance.flex.coveredThrough='2026-10-13';
  for(const s of f.model.provenance.sharesight)s.sourceDate='2026-10-13';
  f.model.holdings.sourceDate='2026-10-13';refresh(f);
  await assert.rejects(verifier(f)(args(f)),/REPORT_TIME_BINDING/);assert.equal(f.reads.length,0);
});
test('authentic collection and saving may end in different minutes without rewriting the original header',async t=>{
  for(const fieldMode of [true,false])await t.test(fieldMode?'field':'standard',async()=>{
    const f=await fixture({fieldMode,live:fieldMode,saveDelayMs:20000}),time=Date.parse(f.receipt.completedAt);
    assert.equal(f.model.asOfHkt,`2026-10-15 ${fieldMode?'13:01':'13:02'}–13:02 HKT · 数据至 2026-10-14`);
    assert.equal(f.receipt.completedAt,'2026-10-15T05:03:40.000Z');
    assert.equal((await verifier(f,{time})(args(f,'candidate-admission',time))).financialStatus,'partial');
  });
});
test('standard window evidence cannot put the header before pinned source reads or claim a later Flex read',async t=>{
  for(const source of ['header','flex'])await t.test(source,async()=>{
    const f=await fixture({fieldMode:false,live:false,saveDelayMs:20000}),time=Date.parse(f.receipt.completedAt);
    if(source==='header'){
      const pin=f.receipt.sources.find(s=>s.sourceKey==='sharesight.noahPerformance');
      const value=JSON.parse(text(f.objects.get(pin.privateObject)));value.provenance.readAt='2026-10-15T05:03:00.000Z';
      const bytes=encode(JSON.stringify(value));f.objects.set(pin.privateObject,bytes);pin.sha256=digest(JSON.stringify(value));
      f.model.provenance.sharesight.find(s=>s.sourceKey===pin.sourceKey).readAt=value.provenance.readAt;
    }else f.model.provenance.flex.readAt='2026-10-15T05:03:00.000Z';
    refresh(f);
    await assert.rejects(verifier(f,{time})(args(f,'candidate-admission',time)),source==='header'?/SNAPSHOT_CAPTURE_TIME/:/FLEX_READ_TIME/);
  });
});
test('field capture start is the receipt start and capture timestamps must be canonical UTC instants',async t=>{
  for(const value of ['2026-10-15T05:01:00.001Z','2026-10-15T05:01:00+00:00','2026-10-15T05:01:99.000Z'])await t.test(value,async()=>{
    const f=await fixture({live:false});f.model.provenance.capture.startedAt=value;
    if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))){assert.throws(()=>refresh(f));return;}
    refresh(f);await assert.rejects(verifier(f)(args(f)),/MODEL_CAPTURE_BINDING/);assert.equal(f.reads.length,0);
  });
});
test('a structurally valid weekend bundle cannot bypass the unchanged completed-session gate',async()=>{
  const f=await fixture(),oldStart=f.receipt.startedAt,shift=s=>new Date(Date.parse(s)+172800000).toISOString();
  f.receipt.dataDate=f.model.dataDate='2026-10-17';f.receipt.sourceDate=f.model.sourceDate='2026-10-16';
  f.receipt.startedAt=shift(f.receipt.startedAt);f.receipt.completedAt=shift(f.receipt.completedAt);
  f.receipt.artifact.privateObject='delivery/2026-10-17/report.html';
  for(const s of f.receipt.sources)s.privateObject=s.privateObject.replace(oldStart,f.receipt.startedAt);
  f.model.asOfHkt=f.model.asOfHkt.replaceAll('2026-10-15','2026-10-17').replaceAll('2026-10-14','2026-10-16');
  f.model.notes=f.model.notes.map(s=>s.replaceAll('2026-10-14','2026-10-16'));
  f.model.provenance.flex.sourceDate='2026-10-16';
  for(const s of f.model.provenance.sharesight){s.sourceDate='2026-10-16';s.readAt=shift(s.readAt);}
  for(const k of ['startedAt','completedAt'])f.model.provenance.capture[k]=shift(f.model.provenance.capture[k]);
  f.model.cash.book.sourceDate='2026-10-16';f.model.holdings.sourceDate='2026-10-16';
  f.model.orders.asOfHkt=f.model.orders.asOfHkt.replace('2026-10-15','2026-10-17');
  for(const k of ['capturedStartedAt','capturedCompletedAt'])f.model.orders[k]=shift(f.model.orders[k]);
  for(const s of Object.values(f.model.fieldState)){if(s.dataDate==='2026-10-14')s.dataDate='2026-10-16';else if(s.dataDate==='2026-10-15')s.dataDate='2026-10-17';if(s.readAt)s.readAt=shift(s.readAt);}
  refresh(f);const time=NOW+172800000;
  await assert.rejects(verifier(f,{time})(args(f,'candidate-admission',time)),/COMPLETED_SESSION_REQUIRED/);assert.equal(f.reads.length,0);
});
test('input buffers and metadata are detached before asynchronous trusted-context reads',async()=>{
  const f=await fixture();let resume,entered;
  const pendingContext=new Promise(resolve=>{resume=resolve;}),started=new Promise(resolve=>{entered=resolve;});let calls=0;
  const input={...args(f),metadata:structuredClone(f.metadata),html:Buffer.from(f.htmlBytes),receipt:Buffer.from(f.receiptBytes)};
  const pending=verifier(f,{loadContext:async()=>{if(++calls===1){entered();await pendingContext;}return context();}})(input);
  await started;input.html.fill(0);input.receipt.fill(0);input.metadata.ownerBinding='e'.repeat(64);resume();
  const proof=await pending;assert.equal(proof.artifactSha256,f.metadata.artifactSha256);assert.equal(proof.receiptSha256,f.metadata.receiptSha256);
});
test('duplicate receipt keys are rejected instead of silently accepting the last authority value',async()=>{
  const f=await fixture();f.receiptBytes=encode('{"schemaVersion":9,'+JSON.stringify(f.receipt).slice(1));f.metadata.receiptSha256=digest(text(f.receiptBytes));
  await assert.rejects(verifier(f)(args(f)),/JSON/);assert.equal(f.reads.length,0);
});


test('daily verifier preserves finite public network root cause and exact validator phase without private error text',async()=>{
  const f=await fixture();let calls=0;
  const error=Object.assign(new TypeError('PRIVATE_TOKEN_MUST_NOT_ESCAPE'),{safeCode:'REPORT_SOURCE_NETWORK_FAILED',safeOrigin:{type:'TypeError',code:null,causeCode:'ETIMEDOUT',httpStatus:null}});
  await assert.rejects(verifier(f,{loadContext:async()=>{if(++calls===2)throw error;return context();}})(args(f)),e=>{
    assert.equal(e.safeCode,'OWNER_ADMISSION_REJECTED');assert.equal(e.failureEvidence.originalCode,'REPORT_SOURCE_NETWORK_FAILED');
    assert.equal(e.failureEvidence.validatorPoint,'context-second');assert.equal(e.failureEvidence.validatorPhase,'candidate-admission');
    assert.equal(e.failureEvidence.origin.causeCode,'ETIMEDOUT');assert.equal(JSON.stringify(e.failureEvidence).includes('PRIVATE_TOKEN'),false);return true;
  });assert.equal(f.reads.length,4);
});
test('daily verifier propagates a real abort into context and pinned readers and cannot admit after cancellation',async()=>{
  const f=await fixture(),ac=new AbortController();let reads=0;
  const verify=verifier(f,{loadContext:async options=>{assert.equal(options.signal,ac.signal);return context();},readPinnedSource:async pin=>{reads++;assert.equal(pin.signal,ac.signal);if(reads===4)ac.abort();return f.objects.get(pin.name);}});
  await assert.rejects(verify({...args(f),signal:ac.signal}));assert.equal(reads,4);
});

test('book ready and partial candidates roundtrip through immutable source rebuilding and static export',async()=>{
  for(const browser of [true,false])for(const completeOrders of [true,false]){
    const f=await fixture({book:true,completeOrders,browser});
    f.metadata=ownerBundleMetadata({html:f.htmlBytes,artifactObject:f.receipt.artifact.privateObject,artifactGeneration:f.receipt.artifact.generation,artifactSha256:digest(f.html),receiptObject:f.metadata.receiptObject,receiptGeneration:'99',receiptSha256:digest(JSON.stringify(f.receipt))},f.receipt);
    const proof=await verifier(f)(args(f));assert.equal(proof.financialStatus,completeOrders?'complete':'partial');
    assert.equal(f.reads.length,4);assert.equal(f.model.status,completeOrders?'ready':'partial');
    const display=text(prepareOwnerStaticDisplay(f.htmlBytes));assert.match(display,/复用周末版计算；本行动版范围为 IB-HK/);assert.match(display,/计算前提/);assert.doesNotMatch(display,/<script/);
    assert.equal(f.model.cash.executableBudget,null);assert.equal(f.model.provenance.sharesight[0].syncCompletedAt,null);
    assert.equal(f.model.provenance.sharesight[0].channel,browser?'authenticated-browser':'api');
    if(browser)assert.match(display,/分类沿用此前记录/);
    const receipt=structuredClone(f.receipt);delete receipt.calculationBasis;
    await assert.rejects(()=>verifier(f)({...args(f),receipt:encode(JSON.stringify(receipt))}));
  }
});

test('a browser holding without prior class preserves book cash and direct concentration without guessing allocation',async()=>{
  const f=await fixture({book:true,browser:true,browserClassification:false});
  assert.equal(f.model.bookConcentration.status,'ready');assert.equal(f.model.cash.preOrderPlanning,350);
  assert.equal(f.model.allocation.status,'unavailable');assert.equal(f.model.cash.planning,null);
  assert.equal(f.model.status,'partial');assert.equal(f.model.cash.executableBudget,null);
});

test('previous direct-only book artifacts retain exact legacy source reconstruction during historical checks',async()=>{
  const f=await fixture({book:true,browser:true,completeOrders:false});
  delete f.model.bookPlan;delete f.model.bookConcentration.issuerResultFingerprint;
  for(const row of f.model.bookConcentration.rows){delete row.instrumentId;delete row.assetType;delete row.identitySourceDate;delete row.quantity;delete row.price;}
  refresh(f);
  f.metadata=ownerBundleMetadata({html:f.htmlBytes,artifactObject:f.receipt.artifact.privateObject,artifactGeneration:f.receipt.artifact.generation,
    artifactSha256:digest(f.html),receiptObject:f.metadata.receiptObject,receiptGeneration:'99',receiptSha256:digest(JSON.stringify(f.receipt))},f.receipt);
  assert.match(f.html,/部分更新|IB-HK 直接持仓/);assert.doesNotMatch(f.html,/账面更新完成/);
  const proof=await verifier(f)(args(f,'historical-authenticity'));
  assert.equal(proof.financialStatus,'partial');assert.equal(f.reads.length,4);
});

import {composeBrowserActionEvidence} from './action_preview.mjs';
import {registeredOwnerRecovery} from './owner_source_recovery.mjs';
import {createOwnerLatestPublisher,LATEST_HEADERS} from './owner_latest.mjs';
import {ordersReadCli} from './orders_read.mjs';
import {RESOURCE,TOKEN_ENDPOINT} from './ib_mcp.mjs';
async function browserAttempt({edit=()=>{},failWrite=false,ordersCapture=null,currentBookDate=false,timeOverride=null,processingDelayMs=0,threeAccounts=false}={}){
  const reg=registeredOwnerRecovery(),time=timeOverride??Date.parse(reg.dataDate+'T02:25:00.000Z'),sourceDate=currentBookDate?reg.dataDate:new Date(time-86400000).toISOString().slice(0,10),captureStartedAt=new Date(time-60000).toISOString();
  const snapshots={};
  for(const key of Object.keys(SNAPSHOT_SCOPES)){
    const ib=key==='sharesight.ibGroupedPerformance',prior=snapshot(key).raw,r=prior.data.report;
    for(const h of r.holdings??[])h.instrument.market_code='TEST';
    const positions=ib?r.holdings.map(h=>({instrument:h.instrument.code+' | TEST',price:10,priceCurrency:'USD',quantity:h.quantity,marketValueUSD:h.value,sourcePath:'/holdings/'+h.id,priceDate:null})):[{instrument:'SYNTH | OTHER',price:10,priceCurrency:'USD',quantity:10,marketValueUSD:100,sourcePath:'/holdings/99',priceDate:null}];
    snapshots[key]={mode:'read_only',source:SHARESIGHT_BROWSER_SOURCE,observation:{portfolio:ib?'IB-HK':'NOAH-HK',valuationDate:sourceDate,retrievedAt:new Date(time-30000).toISOString(),reportingCurrency:'USD',portfolioValue:positions.reduce((n,p)=>n+p.marketValueUSD,0)+200,positions,cash:[{marketValueUSD:200,sourcePath:'/cash_accounts/1',nativeCurrency:'USD',nativeBalance:200}]},
      classification:ib?{sourceKey:key,status:'date-verified',raw:prior,rawFingerprint:digest(prior),provenance:{sourceDate:SOURCE,readAt:SOURCE+'T22:00:00.000Z'}}:null};
  }
  edit(snapshots);
  let concentrationInput=null;
  if(threeAccounts){
    const ib=snapshots['sharesight.ibGroupedPerformance'];
    for(const h of ib.classification.raw.data.report.holdings){h.instrument.id=h.id;h.instrument.friendly_instrument_description_code='ordinary_shares';}
    ib.classification.rawFingerprint=digest(ib.classification.raw);
    const sources=[['sharesight.ibGroupedPerformance',936247,'IB-HK'],['sharesight.schwabPerformance',936249,'Schwab-HK'],['sharesight.webullPerformance',1350094,'Webull']].map(([key,id,name])=>{
      const raw=structuredClone(ib);Object.assign(raw.observation,{portfolio:name,portfolioId:id});
      raw.classification.sourceKey=key;raw.classification.raw.data.report.portfolio_id=id;
      raw.classification.rawFingerprint=digest(raw.classification.raw);
      raw.observation.positions.forEach(p=>p.description='Synthetic instrument');raw.observation.cash.forEach(c=>c.name='Synthetic cash');
      if(id===936247){ib.observation=raw.observation;}
      const bytes=JSON.stringify(raw);return {bytes,receipt:{sourceKey:key,route:'authenticated-browser',status:'date-verified',sourceDate,startedAt:raw.observation.retrievedAt,completedAt:raw.observation.retrievedAt,bytes:Buffer.byteLength(bytes),sha256:digest(bytes)}};
    });
    concentrationInput={cutoff:sourceDate,sources};
  }
  const objects=new Map(),events=[];
  const access={beginEvidence:async args=>{events.push('claim');return {...args,dataDate:reg.dataDate,runId:'11111111-2222-4333-8444-555555555555'};},
    writeEvidence:async(name,bytes)=>{events.push('write');if(failWrite)throw Error('SYNTHETIC_UNCERTAIN');assert.ok(!objects.has(name));const generation=String(objects.size+2);objects.set(name,{bytes:Buffer.from(bytes),generation});return {generation,sha256:digest(Buffer.from(bytes).toString())};}};
  const options={sourceDate,snapshots,captureStartedAt,ordersCapture,concentrationInput,access,now:()=>time+processingDelayMs,loadContext:async()=>context(time+processingDelayMs)};
  const execute=()=>composeBrowserActionEvidence(options);
  return {reg,time:time+processingDelayMs,sourceDate,objects,events,execute,concentrationInput,options};
}
function browserOrdersCapture(raw={orders:[order()],complete:true}){
  const d=registeredOwnerRecovery().dataDate;
  return {status:'captured',channel:'cloud-mcp',sources:[{sourceKey:'ib.orders',raw,rawFingerprint:fingerprint(raw),
    startedAt:d+'T02:24:10.000Z',completedAt:d+'T02:24:20.000Z',
    accountEvidence:{associationBasis:'owner-attested',nativeIdentityEvidence:'not-provided',responseAccountEvidence:'not-provided'}}]};
}
test('normal CLI actual transport -> pinned source -> browser report -> admission -> single CAS and readback',async()=>{
  for(const complete of [true,false]){
    const reg=registeredOwnerRecovery(),time=Date.parse(reg.dataDate+'T02:24:10.000Z'),objects=new Map(),events=[];
    const secret='projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp';
    const credential={client_id:'SYNTHETIC_CLIENT',access_token:'SYNTHETIC_ACCESS_CANARY',refresh_token:'SYNTHETIC_REFRESH_CANARY',token_type:'Bearer',scope:'mcp.read',resource:RESOURCE,expires_at:time+(complete?0:3600000)};
    const request={requestId:reg.requestId,dataDate:reg.dataDate,expiresAt:new Date(time+600000).toISOString(),credentialBinding:{clientId:credential.client_id,version:'15'}};
    const result=await ordersReadCli(['--orders-request',JSON.stringify(request)],{now:()=>time,loadContext:async()=>context(time),
      env:{CLOUD_RUN_JOB:'xuan-preopen-orders-probe',CLOUD_RUN_EXECUTION:'xuan-preopen-orders-probe-synthetic',CLOUD_RUN_TASK_INDEX:'0',CLOUD_RUN_TASK_ATTEMPT:'0',CLOUD_RUN_TASK_COUNT:'1'},
      io:{ibStore:{loadBound:async b=>{assert.deepEqual(b,request.credentialBinding);return {versionName:secret+'/versions/15',credential};},
        save:async c=>{events.push('save');assert.equal(c.client_id,credential.client_id);return {name:secret+'/versions/16',state:'ENABLED'};}},
        savePrivate:async(name,value)=>{assert.ok(!objects.has(name));objects.set(name,structuredClone(value));return {sha256:digest(value),generation:String(objects.size)};}},
      fetchImpl:async(url,options)=>{
        options.signal.throwIfAborted();
        if(String(url)===TOKEN_ENDPOINT){events.push('refresh');return Response.json({access_token:'SYNTHETIC_NEXT_CANARY',refresh_token:'SYNTHETIC_ROTATED_CANARY',token_type:'Bearer',scope:'mcp.read',expires_in:3600});}
        assert.equal(String(url),RESOURCE);const rpc=JSON.parse(options.body);
        if(rpc.method==='initialize')return Response.json({jsonrpc:'2.0',id:rpc.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}}}});
        if(rpc.method==='notifications/initialized')return new Response(null,{status:202});
        assert.equal(rpc.method,'tools/call');assert.deepEqual(rpc.params,{name:'get_account_orders',arguments:{}});events.push('orders');
        return Response.json({jsonrpc:'2.0',id:rpc.id,result:{content:[{type:'text',text:JSON.stringify({orders:[order()],...(complete?{complete:true}:{})})}]}});
      }});
    assert.equal(result.status,'passed');assert.deepEqual(events,complete?['refresh','save','orders']:['orders']);assert.equal(objects.size,3);
    const prefix='report-check/orders-read-'+reg.requestId+'/',source=objects.get(prefix+'orders.json'),normalReceipt=objects.get(prefix+'receipt.json');
    assert.equal(normalReceipt.artifact.sha256,digest(source));assert.equal(result.receiptSha256,digest(normalReceipt));
    const f=await browserAttempt({ordersCapture:{status:'captured',channel:'cloud-mcp',sources:[source]}}),r=await f.execute();
    const html=f.objects.get(r.receipt.artifact.privateObject).bytes,receipt=f.objects.get(r.receiptObject).bytes,model=extractNightActionModel(html.toString());
    assert.equal(model.cash.orderReserve,complete?60:null);assert.equal(model.cash.planning,complete?290:null);assert.equal(model.bookPlan.status,'ready');
    assert.equal(objects.size+f.objects.size+1,11); // normal three + report seven + native start claim
    const metadata=ownerBundleMetadata({html,artifactObject:r.receipt.artifact.privateObject,artifactGeneration:r.receipt.artifact.generation,
      artifactSha256:r.receipt.artifact.sha256,receiptObject:r.receiptObject,receiptGeneration:r.generation,receiptSha256:r.sha256},r.receipt);
    const verify=createProtectedOwnerVerifier({now:()=>f.time,loadContext:async()=>context(f.time),readPinnedSource:async pin=>{
      const o=f.objects.get(pin.name);assert.equal(o.generation,pin.generation);assert.equal(digest(o.bytes.toString()),pin.sha256);return o.bytes;}});
    const proof=await verify({metadata,html,receipt,now:f.time,phase:'candidate-admission'});assert.equal(proof.financialStatus,complete?'complete':'partial');
    let writes=0,readbacks=0,stored;
    const publisher=createOwnerLatestPublisher({ownerBinding:OWNER_BINDING,verifyProtectedReceipt:verify,prepareDisplay:prepareOwnerStaticDisplay,now:()=>f.time,
      io:{readLatest:async()=>({state:'absent'}),replaceLatest:async({bytes,ifGenerationMatch,target})=>{writes++;assert.equal(ifGenerationMatch,'0');stored=Buffer.from(bytes);return {...target,generation:'999',size:stored.length};},
        readLatestGeneration:async()=>{readbacks++;return Buffer.from(stored);}}});
    assert.equal((await publisher.publish({metadata,html,receipt})).status,'published-verified');assert.equal(writes,1);assert.equal(readbacks,1);
    assert.equal((await publisher.publish({metadata,html,receipt})).code,'ONE_SHOT_CLOSED');
    assert.doesNotMatch(JSON.stringify({result,objects:[...objects]})+stored.toString(),/SYNTHETIC_(?:ACCESS|REFRESH|NEXT|ROTATED)_CANARY/);
  }
});
test('separately captured normal MCP orders join browser snapshots without a second source call or old probe execution',async()=>{
  for(const channel of ['cloud-mcp','mac-mcp'])for(const complete of [true,false])for(const currentBookDate of [false,true]){
    const capture={...browserOrdersCapture({orders:[order()],...(complete?{complete:true}:{})}),channel};
    if(channel==='mac-mcp')Object.assign(capture.sources[0],{wrapper:'native-object',transportFingerprint:capture.sources[0].rawFingerprint});
    const f=await browserAttempt({ordersCapture:capture,currentBookDate});
    const r=await f.execute(),html=f.objects.get(r.receipt.artifact.privateObject).bytes,model=extractNightActionModel(html.toString());
    assert.equal(f.events.filter(e=>e==='claim').length,1);assert.equal(f.objects.size,7);
    assert.equal(model.sourceDate,f.sourceDate);assert.equal(r.receipt.dateBasis,'sharesight-valuation-date.v1');
    assert.equal(model.dateBasis,r.receipt.dateBasis);
    assert.match(html.toString(),/Sharesight 估值日期/);assert.doesNotMatch(html.toString(),/最近已收市交易日/);assert.match(html.toString(),/单项价格日期未知/);
    for(const pin of r.receipt.sources.filter(s=>s.sourceKey.startsWith('sharesight.'))){
      const v=JSON.parse(f.objects.get(pin.privateObject).bytes.toString());
      assert.equal(v.raw.observation.valuationDate,f.sourceDate);assert.ok(v.raw.observation.positions.every(p=>p.priceDate===null));
    }
    assert.equal(model.orders.buys.length,1);assert.equal(model.cash.orderReserve,complete?60:null);
    assert.equal(model.cash.planning,complete?290:null);assert.equal(model.cash.preOrderPlanning,350);
    assert.equal(model.bookPlan.status,'ready');assert.equal(model.replenishment.status,complete?'ready':'unavailable');
    const receipt=f.objects.get(r.receiptObject).bytes;
    const metadata=ownerBundleMetadata({html,artifactObject:r.receipt.artifact.privateObject,artifactGeneration:r.receipt.artifact.generation,
      artifactSha256:r.receipt.artifact.sha256,receiptObject:r.receiptObject,receiptGeneration:r.generation,receiptSha256:r.sha256},r.receipt);
    const verify=createProtectedOwnerVerifier({now:()=>f.time,loadContext:async()=>context(f.time),readPinnedSource:async p=>f.objects.get(p.name).bytes});
    const proof=await verify({metadata,html,receipt,now:f.time,phase:'candidate-admission'});
    assert.equal(proof.financialStatus,complete?'complete':'partial');
    assert.deepEqual(metadata.unknownFields,complete?[]:['orders']);
    const pin=r.receipt.sources.find(s=>s.sourceKey==='ib.optionalLive');
    const saved=JSON.parse(f.objects.get(pin.privateObject).bytes.toString());
    assert.deepEqual(saved.normalMcpEvidence,{schema:'xuan.normal-mcp-orders.v1',requestId:f.reg.requestId,channel});
    assert.equal(saved.probeEvidence,undefined);
    let writes=0,readbacks=0,stored;
    const publisher=createOwnerLatestPublisher({ownerBinding:OWNER_BINDING,verifyProtectedReceipt:verify,prepareDisplay:prepareOwnerStaticDisplay,now:()=>f.time,
      io:{readLatest:async()=>({state:'absent'}),replaceLatest:async({bytes,ifGenerationMatch,target})=>{writes++;assert.equal(ifGenerationMatch,'0');stored=Buffer.from(bytes);return {...target,generation:'999',size:stored.length};},
        readLatestGeneration:async()=>{readbacks++;return Buffer.from(stored);}}});
    assert.equal((await publisher.publish({metadata,html,receipt})).status,'published-verified');
    assert.equal(writes,1);assert.equal(readbacks,1);assert.equal((await publisher.publish({metadata,html,receipt})).code,'ONE_SHOT_CLOSED');
  }
});
test('MCP capture rejects stale times, fingerprints, wrong accounts and extra sources before the immutable claim',async()=>{
  for(const edit of [c=>c.sources[0].startedAt='2026-10-20T02:24:10.000Z',c=>c.sources[0].rawFingerprint='0'.repeat(64),
    c=>c.sources.push(structuredClone(c.sources[0])),c=>c.sources[0].sourceKey='ib.positions',c=>c.channel='unverified-probe',
    c=>c.sources[0].wrapper='json-string',c=>c.sources[0].transportFingerprint='a'.repeat(64),
    c=>Object.assign(c.sources[0],{wrapper:'native-object',transportFingerprint:'0'.repeat(64)}),
    c=>Object.assign(c.sources[0],{wrapper:'json-string',transportFingerprint:'invalid'}),
    c=>Object.assign(c.sources[0],{wrapper:'unverified',transportFingerprint:'a'.repeat(64)}),
    c=>{c.sources[0].raw.accountId='FOREIGN_ACCOUNT';c.sources[0].rawFingerprint=fingerprint(c.sources[0].raw);}]){
    const capture=browserOrdersCapture();edit(capture);const f=await browserAttempt({ordersCapture:capture});
    await assert.rejects(f.execute);assert.equal(f.events.length,0);
  }
});
test('registered browser-only composition -> pinned reads -> static admission -> one CAS -> independent bytes',async()=>{
  const f=await browserAttempt(),result=await f.execute(),r=result.receipt,html=f.objects.get(r.artifact.privateObject).bytes,receipt=f.objects.get(result.receiptObject).bytes;
  assert.equal(f.events.filter(e=>e==='claim').length,1);assert.equal(f.objects.size,7); // plus native start claim = 8
  const metadata=ownerBundleMetadata({html,artifactObject:r.artifact.privateObject,artifactGeneration:r.artifact.generation,artifactSha256:r.artifact.sha256,
    receiptObject:result.receiptObject,receiptGeneration:result.generation,receiptSha256:result.sha256},r);
  const candidate={html,receipt,metadata},model=extractNightActionModel(html.toString());
  assert.equal(model.orders.reason,'IB_MCP_ROUTES_UNAVAILABLE');assert.equal(model.cash.orderReserve,null);assert.equal(model.cash.planning,null);
  assert.equal(model.cash.preOrderPlanning,350);assert.equal(model.bookConcentration.status,'ready');assert.equal(model.allocation.status,'ready');
  assert.equal(model.bookPlan.status,'ready');assert.equal(model.bookPlan.budget,350);
  assert.deepEqual(metadata.unknownFields,['orders']);assert.equal(metadata.financialStatus,'partial');
  assert.match(html.toString(),/账面更新完成 · 挂单待核实/);
  assert.match(html.toString(),/IB 云端及 Mac MCP 工具当前不可用/);assert.equal(r.startedAt,f.reg.dataDate+'T02:24:00.000Z');
  let writes=0,readbacks=0,stored,verifyNow=f.time;
  const verify=createProtectedOwnerVerifier({now:()=>verifyNow,loadContext:async()=>context(f.time),readPinnedSource:async pin=>{
    const value=f.objects.get(pin.name);assert.equal(value.generation,pin.generation);assert.equal(digest(value.bytes.toString()),pin.sha256);return value.bytes;}});
  const publisher=createOwnerLatestPublisher({ownerBinding:OWNER_BINDING,verifyProtectedReceipt:verify,prepareDisplay:prepareOwnerStaticDisplay,now:()=>f.time,
    io:{readLatest:async()=>({state:'absent'}),replaceLatest:async({bytes,ifGenerationMatch,target})=>{writes++;assert.equal(ifGenerationMatch,'0');stored=Buffer.from(bytes);return {...target,generation:'999',size:stored.length};},
      readLatestGeneration:async()=>{readbacks++;return Buffer.from(stored);}}});
  const published=await publisher.publish(candidate);assert.equal(published.status,'published-verified',JSON.stringify(published));assert.equal(writes,1);assert.equal(readbacks,1);
  assert.equal((await publisher.publish(candidate)).code,'ONE_SHOT_CLOSED');
  assert.match(stored.toString(),/复用周末版计算|扣挂单前账面分配参考/);
  assert.doesNotMatch(stored.toString(),/部分更新/);
  verifyNow=f.time+30*60000;
  await assert.rejects(()=>verify({metadata,html,receipt,now:verifyNow,phase:'candidate-admission'}),/CANDIDATE_STALE|CLOCK/);
});
test('browser prevalidation rejects wrong date, stale/future original times and malformed totals before any claim; uncertain saves stop',async()=>{
  for(const edit of [s=>s['sharesight.ibGroupedPerformance'].observation.valuationDate='2020-01-01',
    s=>s['sharesight.noahPerformance'].observation.retrievedAt='2020-01-01T00:00:00Z',
    s=>s['sharesight.noahPerformance'].observation.retrievedAt='2099-01-01T00:00:00Z',
    s=>s['sharesight.ibGroupedPerformance'].observation.portfolioValue++]){
    const f=await browserAttempt({edit});await assert.rejects(f.execute);assert.equal(f.events.length,0);
  }
  const f=await browserAttempt({failWrite:true});await assert.rejects(f.execute,/SYNTHETIC_UNCERTAIN/);assert.deepEqual(f.events,['claim','write']);
});

// These are synthetic clocks and storage only, never production replay.
test('browser valuation day needs no completed market session through controller, admission, CAS and readback across HKT midnight',async()=>{
  const day=registeredOwnerRecovery().dataDate,midnight=Date.parse(day+'T00:00:00+08:00');
  for(const timeOverride of [2*60000,6*3600000+2*60000,14*3600000+10*60000].map(offset=>midnight+offset)){
    const f=await browserAttempt({currentBookDate:true,timeOverride}),r=await f.execute();
    const html=f.objects.get(r.receipt.artifact.privateObject).bytes,receipt=f.objects.get(r.receiptObject).bytes;
    const bundle={html,receipt,artifactObject:r.receipt.artifact.privateObject,artifactGeneration:r.receipt.artifact.generation,
      artifactSha256:r.receipt.artifact.sha256,receiptObject:r.receiptObject,receiptGeneration:r.generation,receiptSha256:r.sha256};
    const model=extractNightActionModel(html.toString());
    assert.equal(model.sourceDate,day);assert.equal(model.dateBasis,'sharesight-valuation-date.v1');
    assert.equal(model.cash.book.sourceDate,day);assert.equal(model.cash.preOrderPlanning,350);
    assert.equal(model.bookConcentration.sourceDate,day);assert.equal(model.holdings.sourceDate,day);
    assert.equal(ownerBundleMetadata(bundle,r.receipt).sourceDate,model.sourceDate);
    let writes=0,readbacks=0,stored;
    const io={readRegisteredRecoveryBundle:async()=>bundle,readPinnedSource:async pin=>f.objects.get(pin.name).bytes,
      readLatest:async()=>({state:'absent'}),replaceLatest:async({bytes,ifGenerationMatch,target})=>{writes++;assert.equal(ifGenerationMatch,'0');stored=Buffer.from(bytes);return {...target,generation:'900',size:stored.length};},
      readLatestGeneration:async()=>{readbacks++;return Buffer.from(stored);}};
    const result=await deliverOwnerLatest({request:()=>assert.fail('offline only'),registeredRecovery:true,now:()=>f.time,
      loadContext:async()=>context(f.time),storeFactory:()=>io});
    assert.equal(result.status,'published-verified',JSON.stringify(result));assert.equal(writes,1);assert.equal(readbacks,1);
    for(const edit of [m=>m.dateBasis='unverified',m=>delete m.dateBasis,m=>m.provenance.sharesight[0].channel='api']){
      const altered=structuredClone(model);edit(altered);assert.throws(()=>renderNightActionReport(altered));
    }
    const verify=createProtectedOwnerVerifier({now:()=>f.time,loadContext:async()=>context(f.time),readPinnedSource:async pin=>f.objects.get(pin.name).bytes});
    const altered={...r.receipt,dateBasis:'unverified'},tamperedReceipt=Buffer.from(JSON.stringify(altered));
    const changedBundle={...bundle,receipt:tamperedReceipt,receiptSha256:digest(tamperedReceipt)};
    await assert.rejects(verify({metadata:ownerBundleMetadata(changedBundle,altered),html,receipt:tamperedReceipt,phase:'candidate-admission'}));
  }
});
test('browser valuation future/mixed dates and stale intake stop before a claim, with no price-date invention',async()=>{
  for(const edit of [s=>s['sharesight.ibGroupedPerformance'].observation.valuationDate='2026-10-22',
    s=>s['sharesight.noahPerformance'].observation.valuationDate='2026-10-20',
    s=>s['sharesight.ibGroupedPerformance'].observation.positions[0].priceDate='2026-10-20']){
    const f=await browserAttempt({currentBookDate:true,edit});await assert.rejects(f.execute);assert.deepEqual(f.events,[]);
  }
});


test('saved browser capture separates collection from processing; delayed admission retains true source times',async()=>{
  const f=await browserAttempt({currentBookDate:true,ordersCapture:browserOrdersCapture(),processingDelayMs:15*60000});
  const r=await f.execute(),html=f.objects.get(r.receipt.artifact.privateObject).bytes,receipt=f.objects.get(r.receiptObject).bytes;
  assert.equal(r.receipt.captureCompletedAt,f.reg.dataDate+'T02:24:30.000Z');
  assert.equal(r.receipt.completedAt,f.reg.dataDate+'T02:40:00.000Z');
  const metadata=ownerBundleMetadata({html,artifactObject:r.receipt.artifact.privateObject,artifactGeneration:r.receipt.artifact.generation,
    artifactSha256:r.receipt.artifact.sha256,receiptObject:r.receiptObject,receiptGeneration:r.generation,receiptSha256:r.sha256},r.receipt);
  const verify=createProtectedOwnerVerifier({now:()=>f.time,loadContext:async()=>context(f.time),readPinnedSource:async pin=>f.objects.get(pin.name).bytes});
  assert.equal((await verify({metadata,html,receipt,now:f.time,phase:'candidate-admission'})).financialStatus,'complete');
  assert.equal(metadata.captureEndedAt,r.receipt.captureCompletedAt);
  const stale=await browserAttempt({processingDelayMs:30*60000});await assert.rejects(stale.execute);assert.equal(stale.events.length,0);
  const prolonged=browserOrdersCapture();prolonged.sources[0].completedAt=f.reg.dataDate+'T02:30:00.000Z';
  const invalid=await browserAttempt({ordersCapture:prolonged,processingDelayMs:15*60000});await assert.rejects(invalid.execute);assert.equal(invalid.events.length,0);
});


import {registeredReferenceCapture,registeredHistoricalReferenceCapture,validateOwnerRecoveryRegistration,ownerCaptureDeadline,validateReferenceSources} from './owner_source_recovery.mjs';
test('prior reference remains verifiable but cannot extend the new request or revive an old claim',()=>{
  const reg=registeredOwnerRecovery(),previous=reg.previousReferenceCapture,r=previous.referenceCapture;
  assert.deepEqual(registeredHistoricalReferenceCapture(previous.requestId,r.captureStartedAt,r.captureCompletedAt),r);
  assert.equal(registeredReferenceCapture(previous.requestId,r.captureStartedAt,r.captureCompletedAt),null);
  assert.equal(ownerCaptureDeadline(reg.requestId,r.captureStartedAt,r.captureCompletedAt),Date.parse(r.captureStartedAt)+1800000);
  assert.equal(ownerCaptureDeadline('other-request',r.captureStartedAt,r.captureCompletedAt),Date.parse(r.captureStartedAt)+1800000);
  assert.equal(registeredReferenceCapture(reg.requestId,r.captureStartedAt,new Date(Date.parse(r.captureCompletedAt)+1).toISOString()),null);
  const values=Object.fromEntries(['sharesight.ibGroupedPerformance','sharesight.noahPerformance'].map(k=>[k,{rawFingerprint:r.sourceHashes[k]}]));
  values['ib.optionalLive']={sources:[{rawFingerprint:r.sourceHashes['ib.orders']}]};validateReferenceSources(r,values);
  values['ib.optionalLive'].sources[0].rawFingerprint='0'.repeat(64);assert.throws(()=>validateReferenceSources(r,values),/REFERENCE_SOURCE_BINDING/);
  assert.equal(r.expiresAt,previous.dataDate+'T15:59:59.999Z');
  assert.equal(registeredHistoricalReferenceCapture('different-request',r.captureStartedAt,r.captureCompletedAt),null);
  const base=structuredClone(reg);delete base.receiptObject;
  assert.equal(validateOwnerRecoveryRegistration(base).priorReceiptObject,base.priorReceiptObject);
  for(const edit of [v=>v.priorReceiptObject='delivery/2099-01-01/receipt.json',v=>v.priorReceiptObject='delivery/2026-02-30/receipt.json',v=>v.priorReceiptObject='../receipt.json',v=>v.priorReceiptSha256='invalid',v=>v.previousReferenceCapture.requestId=v.requestId,v=>v.previousReferenceCapture.referenceCapture=null]){
    const invalid=structuredClone(base);edit(invalid);assert.throws(()=>validateOwnerRecoveryRegistration(invalid));
  }
});


test('three browser accounts and observed orders survive pinned admission and one publication, without claiming full coverage',async()=>{
  const f=await browserAttempt({threeAccounts:true,currentBookDate:true,ordersCapture:browserOrdersCapture({orders:[order()]})});
  const r=await f.execute(),html=f.objects.get(r.receipt.artifact.privateObject).bytes,receipt=f.objects.get(r.receiptObject).bytes,model=extractNightActionModel(html.toString());
  assert.equal(model.concentration.bindings.length,3);assert.equal(model.concentration.envelope.riskDenominator.components.length,3);
  assert.equal(model.orders.coverage,'unknown');assert.equal(model.cash.orderReserve,null);assert.equal(model.cash.planning,null);
  assert.equal(model.observedOrderPlan.orderReserve,60);assert.equal(model.observedOrderPlan.budget,290);assert.equal(model.observedOrderPlan.plan.status,'ready');
  assert.equal(model.observedOrderPlan.executableBudget,null);assert.equal(model.orders.buys[0].distancePct,0);
  assert.match(html.toString(),/按已取得挂单估算/);assert.doesNotMatch(html.toString(),/本行动版范围为 IB-HK/);
  assert.equal(f.events.filter(x=>x==='claim').length,1);assert.equal(f.objects.size,8); // plus native claim = nine creates
  const metadata=ownerBundleMetadata({html,artifactObject:r.receipt.artifact.privateObject,artifactGeneration:r.receipt.artifact.generation,artifactSha256:r.receipt.artifact.sha256,receiptObject:r.receiptObject,receiptGeneration:r.generation,receiptSha256:r.sha256},r.receipt);
  const reads=[];const verifier=createProtectedOwnerVerifier({now:()=>f.time,loadContext:async()=>context(f.time),readPinnedSource:async p=>{reads.push(p.name);return f.objects.get(p.name).bytes;}});
  let calls=0,stored;const publisher=createOwnerLatestPublisher({ownerBinding:OWNER_BINDING,verifyProtectedReceipt:verifier,prepareDisplay:prepareOwnerStaticDisplay,now:()=>f.time,io:{readLatest:async()=>({state:'absent'}),replaceLatest:async({bytes,target})=>{calls++;stored=Buffer.from(bytes);return {...target,generation:'999',size:stored.length};},readLatestGeneration:async()=>stored}});
  assert.equal((await publisher.publish({metadata,html,receipt})).status,'published-verified');assert.equal(calls,1);
  assert(reads.includes(r.receipt.concentration.privateObject));assert.equal((await publisher.publish({metadata,html,receipt})).code,'ONE_SHOT_CLOSED');
  f.objects.get(r.receipt.concentration.privateObject).bytes=encode('{}');
  await assert.rejects(()=>verifier({metadata,html,receipt,phase:'candidate-admission'}),/CONCENTRATION_BYTES_HASH/);
});

import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
test('six-object continuation preserves exact source/HTML bytes, completes three receipts, admits, CASes once and independently reads back',async()=>{
  const capture=browserOrdersCapture({orders:[order()]}),f=await browserAttempt({threeAccounts:true,currentBookDate:true,ordersCapture:capture});
  const first=await f.execute(),r=first.receipt,prefix=r.artifact.privateObject.replace(/report\.html$/,'');
  const pins=r.sources.map(s=>({name:s.privateObject,generation:s.generation,sha256:s.sha256,size:f.objects.get(s.privateObject).bytes.length}));
  pins.push({name:r.artifact.privateObject,generation:r.artifact.generation,sha256:r.artifact.sha256,size:f.objects.get(r.artifact.privateObject).bytes.length});
  const retained=new Map(pins.map(p=>[p.name,{...f.objects.get(p.name),bytes:Buffer.from(f.objects.get(p.name).bytes)}]));
  const registration=structuredClone(f.reg);delete registration.receiptObject;
  registration.referenceCapture={schema:'xuan.registered-reference-capture.v1',captureStartedAt:r.startedAt,captureCompletedAt:r.captureCompletedAt,expiresAt:registration.dataDate+'T15:59:59.999Z',sourceHashes:{
    'sharesight.ibGroupedPerformance':r.sources.find(s=>s.sourceKey==='sharesight.ibGroupedPerformance').rawFingerprint,
    'sharesight.noahPerformance':r.sources.find(s=>s.sourceKey==='sharesight.noahPerformance').rawFingerprint,'ib.orders':capture.sources[0].rawFingerprint}};
  registration.continuation={schema:'xuan.evidence-continuation.v1',runId:prefix.slice(-37,-1),claimGeneration:'1',objects:pins,maximumObjects:9,maximumBytes:33554432};
  const claim={name:`report-check/orders-probe-${registration.requestId}/start.json`,generation:'1',sha256:'a'.repeat(64),size:500};
  let inspected=0,resumed=0,writes=0;
  const remaining=[prefix+'concentration.sources.json',prefix+'receipt.json',first.receiptObject];
  const access={beginEvidence:()=>assert.fail('Never recreate a consumed claim'),
    inspectEvidenceContinuation:async()=>{inspected++;return {status:'verified',requestId:registration.requestId,runId:registration.continuation.runId,captureStartedAt:r.startedAt,captureCompletedAt:r.captureCompletedAt,existingObjects:6,existingBytes:500+pins.reduce((n,p)=>n+p.size,0),pins:[claim,...pins]};},
    resumeEvidence:async({requestId})=>{assert.equal(requestId,registration.requestId);assert.equal(resumed++,0);return {requestId,dataDate:registration.dataDate,runId:registration.continuation.runId,captureStartedAt:r.startedAt,captureCompletedAt:r.captureCompletedAt,existingObjects:6,remainingObjects:3};},
    writeEvidence:async(name,bytes)=>{assert.equal(name,remaining[writes++]);assert(!retained.has(name));const generation=String(retained.size+2);retained.set(name,{generation,bytes:Buffer.from(bytes)});return {generation,sha256:digest(bytes)};}};
  const savedRead=fs.readFileSync;
  fs.readFileSync=(p,...options)=>String(p).endsWith('/security/xuan-owner-source-recovery.json')?(options[0]==='utf8'?JSON.stringify(registration):Buffer.from(JSON.stringify(registration))):savedRead(p,...options);
  syncBuiltinESMExports();
  try{
    const saved=await composeBrowserActionEvidence({...f.options,resume:true,access});assert.equal(inspected,1);assert.equal(resumed,1);assert.equal(writes,3);
    for(const p of pins){assert.equal(retained.get(p.name).generation,p.generation);assert.equal(digest(retained.get(p.name).bytes),p.sha256);}
    const html=retained.get(saved.receipt.artifact.privateObject).bytes,receipt=retained.get(saved.receiptObject).bytes;
    const metadata=ownerBundleMetadata({html,artifactObject:saved.receipt.artifact.privateObject,artifactGeneration:saved.receipt.artifact.generation,artifactSha256:saved.receipt.artifact.sha256,receiptObject:saved.receiptObject,receiptGeneration:saved.generation,receiptSha256:saved.sha256},saved.receipt);
    const model=extractNightActionModel(html.toString());assert.equal(model.concentration.bindings.length,3);assert.equal(model.observedOrderPlan.status,'ready');
    let cas=0,readbacks=0,display;
    const verify=createProtectedOwnerVerifier({now:()=>f.time,loadContext:async()=>context(f.time),readPinnedSource:async p=>{const o=retained.get(p.name);assert.equal(o.generation,p.generation);assert.equal(digest(o.bytes),p.sha256);return o.bytes;}});
    const publisher=createOwnerLatestPublisher({ownerBinding:OWNER_BINDING,verifyProtectedReceipt:verify,prepareDisplay:prepareOwnerStaticDisplay,now:()=>f.time,
      io:{readLatest:async()=>({state:'absent'}),replaceLatest:async({bytes,ifGenerationMatch,target})=>{assert.equal(ifGenerationMatch,'0');cas++;display=Buffer.from(bytes);return {...target,generation:'999',size:display.length};},readLatestGeneration:async()=>{readbacks++;return Buffer.from(display);}}});
    const out=await publisher.publish({metadata,html,receipt});assert.equal(out.status,'published-verified',JSON.stringify(out));assert.equal(cas,1);assert.equal(readbacks,1);
    assert.equal((await publisher.publish({metadata,html,receipt})).code,'ONE_SHOT_CLOSED');assert.equal(cas,1);
    // Rollover must validate the full historical receipt, not merely render
    // its old display. The previous exception never admits a new candidate.
    const originalRegistration=structuredClone(registration),next=structuredClone(registration);
    delete next.continuation;delete next.referenceCapture;
    next.previousReferenceCapture={requestId:registration.requestId,dataDate:registration.dataDate,referenceCapture:structuredClone(registration.referenceCapture)};
    next.requestId='cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
    next.dataDate=new Date(Date.parse(registration.dataDate+'T00:00:00Z')+86400000).toISOString().slice(0,10);
    Object.keys(registration).forEach(k=>delete registration[k]);Object.assign(registration,next);
    try{
      assert.throws(()=>validateEodReceipt(saved.receipt,html.toString(),saved.receipt.dataDate,saved.receipt.sourceDate),/REFERENCE_BINDING/);
      assert.throws(()=>validateEodReceipt(saved.receipt,html.toString(),saved.receipt.dataDate,saved.receipt.sourceDate,{historicalRequestId:next.requestId}),/REFERENCE_BINDING/);
      const later=Date.parse(next.dataDate+'T02:25:00.000Z'),historical=createProtectedOwnerVerifier({now:()=>later,loadContext:async()=>context(later),
        readPinnedSource:async p=>{const o=retained.get(p.name);assert.equal(o.generation,p.generation);assert.equal(digest(o.bytes),p.sha256);return o.bytes;}});
      assert.equal((await historical({metadata,html,receipt,phase:'historical-authenticity'})).financialStatus,metadata.financialStatus);
      await assert.rejects(()=>historical({metadata,html,receipt,phase:'candidate-admission'}),/RECOVERY_REGISTRATION/);
      assert.equal(cas,1);assert.equal(readbacks,1);
      // Exercise the remaining replacement path with the actual prior bundle,
      // not an absent pointer: fresh evidence -> old historical validation ->
      // conditional replacement -> fixed-version readback. All IO is synthetic.
      const fresh=await browserAttempt({threeAccounts:true,currentBookDate:true,ordersCapture:browserOrdersCapture({orders:[order()]})});
      const nextSaved=await fresh.execute(),nextReceipt=nextSaved.receipt;
      const nextHtml=fresh.objects.get(nextReceipt.artifact.privateObject).bytes,nextReceiptBytes=fresh.objects.get(nextSaved.receiptObject).bytes;
      const nextMetadata=ownerBundleMetadata({html:nextHtml,artifactObject:nextReceipt.artifact.privateObject,artifactGeneration:nextReceipt.artifact.generation,
        artifactSha256:nextReceipt.artifact.sha256,receiptObject:nextSaved.receiptObject,receiptGeneration:nextSaved.generation,receiptSha256:nextSaved.sha256},nextReceipt);
      const allObjects=new Map([...retained,...fresh.objects]);let replacements=0,finalReads=0,nextDisplay;
      const nextVerifier=createProtectedOwnerVerifier({now:()=>fresh.time,loadContext:async()=>context(fresh.time),readPinnedSource:async pin=>{
        const o=allObjects.get(pin.name);assert.equal(o.generation,pin.generation);assert.equal(digest(o.bytes),pin.sha256);return o.bytes;}});
      const rollover=createOwnerLatestPublisher({ownerBinding:OWNER_BINDING,verifyProtectedReceipt:nextVerifier,prepareDisplay:prepareOwnerStaticDisplay,now:()=>fresh.time,
        io:{readLatest:async()=>({state:'present',generation:'999',bundle:{metadata,html,receipt},displayBytes:display}),
          replaceLatest:async({bytes,ifGenerationMatch,target})=>{assert.equal(ifGenerationMatch,'999');replacements++;nextDisplay=Buffer.from(bytes);return {...target,generation:'1000',size:bytes.length};},
          readLatestGeneration:async pin=>{assert.equal(pin.generation,'1000');finalReads++;return Buffer.from(nextDisplay);}}});
      const published=await rollover.publish({metadata:nextMetadata,html:nextHtml,receipt:nextReceiptBytes});
      assert.equal(published.status,'published-verified',JSON.stringify(published));assert.equal(replacements,1);assert.equal(finalReads,1);
      assert.equal((await rollover.publish({metadata:nextMetadata,html:nextHtml,receipt:nextReceiptBytes})).code,'ONE_SHOT_CLOSED');
      registration.previousReferenceCapture.referenceCapture.sourceHashes['ib.orders']='0'.repeat(64);
      await assert.rejects(()=>historical({metadata,html,receipt,phase:'historical-authenticity'}));
    }finally{Object.keys(registration).forEach(k=>delete registration[k]);Object.assign(registration,originalRegistration);}
    // A bad pre-existing pin must fail during local re-creation, before admission or another write.
    registration.continuation.objects[0].sha256='f'.repeat(64);
    await assert.rejects(()=>composeBrowserActionEvidence({...f.options,resume:true,access}));assert.equal(inspected,1);assert.equal(writes,3);
  }finally{fs.readFileSync=savedRead;syncBuiltinESMExports();}
});

// Independent source dates and native-cash unknowns are deliberate source facts.
export async function buildReferenceBrowserFixture({orders=true,staleOrders=false}={}){
  const f=await browserAttempt({threeAccounts:true,ordersCapture:orders?browserOrdersCapture():null});
  const day=f.reg.dataDate,start=day+'T00:00:00.000Z',early=day+'T00:01:00.000Z';
  f.options.referenceDates=true;f.options.captureStartedAt=start;
  const ref='sharesight-reference-dates.v1';
  for(const [key,raw] of Object.entries(f.options.snapshots)){
    raw.dateBasis=ref;raw.observation.captureStartedAt=start;
    raw.observation.retrievedAt=key==='sharesight.noahPerformance'?day+'T00:08:00.000Z':early;
    if(key==='sharesight.noahPerformance'){raw.observation.valuationDate=day;raw.observation.portfolioValue+=17;}
    raw.observation.cash.forEach(c=>{c.nativeCurrency=null;c.nativeBalance=null;});
  }
  const c=f.options.concentrationInput;c.referenceReportDate=day;
  for(const s of c.sources){
    const ib=s.receipt.sourceKey==='sharesight.ibGroupedPerformance';
    const raw=ib?structuredClone(f.options.snapshots[s.receipt.sourceKey]):JSON.parse(s.bytes);
    raw.dateBasis=ref;raw.observation.captureStartedAt=start;
    raw.observation.retrievedAt=ib?early:day+'T00:04:00.000Z';
    if(s.receipt.sourceKey==='sharesight.webullPerformance')raw.observation.valuationDate=day;
    raw.observation.cash.forEach(c=>{c.nativeCurrency=null;c.nativeBalance=null;});
    s.bytes=JSON.stringify(raw);Object.assign(s.receipt,{sourceDate:raw.observation.valuationDate,startedAt:raw.observation.retrievedAt,completedAt:raw.observation.retrievedAt,bytes:Buffer.byteLength(s.bytes),sha256:digest(s.bytes)});
  }
  if(staleOrders){const s=f.options.ordersCapture.sources[0];s.startedAt=day+'T00:10:00.000Z';s.completedAt=day+'T00:10:10.000Z';}
  return f;
}
export {context as syntheticOwnerContext};
test('reference dashboard: different valuation dates, hours between reads, null native cash and isolated NOAH gap roundtrip to one CAS',async()=>{
  const f=await buildReferenceBrowserFixture(),r=await f.execute();
  const html=f.objects.get(r.receipt.artifact.privateObject).bytes,receipt=f.objects.get(r.receiptObject).bytes,m=extractNightActionModel(html.toString());
  assert.equal(m.concentration.bindings.length,3);assert.equal(m.cash.pool,400);assert.equal(m.cash.orderReserve,60);assert.equal(m.cash.planning,290);
  assert.equal(m.referenceData.sources[1].holdingsComplete,false);assert.equal(m.referenceData.sources[1].holdingsDifferenceUSD,-17);
  assert.equal(m.provenance.sharesight[0].sourceDate,f.sourceDate);assert.equal(m.provenance.sharesight[1].sourceDate,f.reg.dataDate);
  assert.equal(m.concentration.bindings.find(b=>b.accountKey==='webull').sourceDate,f.reg.dataDate);
  assert.match(html.toString(),/原币余额未知/);assert.match(html.toString(),/明细与页面总值差额/);
  const metadata=ownerBundleMetadata({html,artifactObject:r.receipt.artifact.privateObject,artifactGeneration:r.receipt.artifact.generation,artifactSha256:r.receipt.artifact.sha256,receiptObject:r.receiptObject,receiptGeneration:r.generation,receiptSha256:r.sha256},r.receipt);
  let clock=f.time;
  const verify=createProtectedOwnerVerifier({now:()=>clock,loadContext:async()=>context(clock),readPinnedSource:async p=>f.objects.get(p.name).bytes});
  assert.equal((await verify({metadata,html,receipt,phase:'candidate-admission'})).financialStatus,'complete');
  let writes=0,reads=0,stored;
  const publisher=createOwnerLatestPublisher({ownerBinding:OWNER_BINDING,verifyProtectedReceipt:verify,prepareDisplay:prepareOwnerStaticDisplay,now:()=>clock,
    io:{readLatest:async()=>({state:'absent'}),replaceLatest:async({bytes,target,ifGenerationMatch})=>{assert.equal(ifGenerationMatch,'0');writes++;stored=Buffer.from(bytes);return {...target,generation:'999',size:stored.length};},readLatestGeneration:async()=>{reads++;return stored;}}});
  assert.equal((await publisher.publish({metadata,html,receipt})).status,'published-verified');assert.equal(writes,1);assert.equal(reads,1);
  clock=Date.parse(r.receipt.ordersFreshUntil)+1;
  await assert.rejects(()=>verify({metadata,html,receipt,phase:'candidate-admission'}),/ORDERS_STALE/);
  assert.equal((await verify({metadata,html,receipt,phase:'historical-authenticity'})).financialStatus,'complete');
});
test('reference dashboard: absent or already-stale orders keep book calculations while dependent values remain unknown',async()=>{
  for(const opts of [{orders:false},{staleOrders:true}]){
    const f=await buildReferenceBrowserFixture(opts),r=await f.execute(),m=extractNightActionModel(f.objects.get(r.receipt.artifact.privateObject).bytes.toString());
    assert.equal(m.orders.status,'unknown');assert.equal(m.cash.planning,null);assert.equal(m.cash.orderReserve,null);assert.equal(m.bookPlan.status,'ready');assert.equal(m.concentration.bindings.length,3);assert.equal(r.receipt.ordersFreshUntil,null);
    if(opts.staleOrders)assert.equal(m.orders.reason,'ORDERS_STALE');
  }
});
test('reference dashboard: future, over-seven-day, previous-read-day and incomplete main-account sources stop before any write',async()=>{
  for(const mutate of [
    f=>{f.options.snapshots['sharesight.noahPerformance'].observation.valuationDate='2099-01-01';},
    f=>{f.options.snapshots['sharesight.noahPerformance'].observation.valuationDate='2020-01-01';},
    f=>{f.options.snapshots['sharesight.noahPerformance'].observation.retrievedAt=f.sourceDate+'T00:01:00.000Z';},
    f=>{f.options.snapshots['sharesight.ibGroupedPerformance'].observation.portfolioValue+=17;}
  ]){const f=await buildReferenceBrowserFixture();mutate(f);await assert.rejects(f.execute);assert.equal(f.events.length,0);}
});

test('reference dashboard orders before Sharesight collection retain their independent original clock',async()=>{
  const f=await buildReferenceBrowserFixture(),day=f.reg.dataDate;f.options.captureStartedAt=day+'T02:24:15.000Z';
  for(const raw of Object.values(f.options.snapshots))Object.assign(raw.observation,{captureStartedAt:f.options.captureStartedAt,retrievedAt:day+'T02:24:30.000Z'});
  for(const source of f.options.concentrationInput.sources){const raw=source.receipt.sourceKey==='sharesight.ibGroupedPerformance'?structuredClone(f.options.snapshots[source.receipt.sourceKey]):JSON.parse(source.bytes);Object.assign(raw.observation,{captureStartedAt:f.options.captureStartedAt,retrievedAt:day+'T02:24:30.000Z'});source.bytes=JSON.stringify(raw);Object.assign(source.receipt,{startedAt:raw.observation.retrievedAt,completedAt:raw.observation.retrievedAt,bytes:Buffer.byteLength(source.bytes),sha256:digest(source.bytes)});}
  const r=await f.execute(),html=f.objects.get(r.receipt.artifact.privateObject).bytes,receipt=f.objects.get(r.receiptObject).bytes;
  const metadata=ownerBundleMetadata({html,artifactObject:r.receipt.artifact.privateObject,artifactGeneration:r.receipt.artifact.generation,artifactSha256:r.receipt.artifact.sha256,receiptObject:r.receiptObject,receiptGeneration:r.generation,receiptSha256:r.sha256},r.receipt);
  const verify=createProtectedOwnerVerifier({now:()=>f.time,loadContext:async()=>context(f.time),readPinnedSource:async p=>f.objects.get(p.name).bytes});
  assert.equal((await verify({metadata,html,receipt,phase:'candidate-admission'})).financialStatus,'complete');
  assert.equal(extractNightActionModel(html.toString()).orders.capturedStartedAt,day+'T02:24:10.000Z');
});
