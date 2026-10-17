// Synthetic offline evidence only. No captured accounts/values, real storage,
// credentials, network, uploads or production context are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareOwnerStaticDisplay,createProtectedOwnerVerifier,OWNER_BINDING,SOURCE_IDENTITY_SHA256,OWNER_SCOPE,OWNER_DISPLAY_CSP} from './owner_latest_admission.mjs';
import {runPrivateEodReport} from './eod_report.mjs';
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
async function fixture({live=true,fieldMode=true,saveDelayMs=0}={}){
  const objects=new Map();let generation=0,time=NOW;
  const io={savePrivate:async(name,value)=>{const bytes=encode(typeof value==='string'?value:JSON.stringify(value));objects.set(name,bytes);time+=saveDelayMs;return {sha256:digest(typeof value==='string'?value:JSON.stringify(value)),generation:String(++generation)};}};
  const startedAt=new Date(NOW-60000).toISOString(),completedAt=new Date(NOW-10000).toISOString(),raw={orders:[order()]};
  const cfg=context().eodConfiguration;
  const xml=`<AF><FlexStatements><FlexStatement accountId="${cfg.account}" fromDate="2026-10-01" toDate="${SOURCE}" whenGenerated="2026-10-15;00:15:30"><CashReport><CashReportCurrency accountId="${cfg.account}" reportDate="${SOURCE}" levelOfDetail="BaseCurrency" currency="BASE_SUMMARY" endingCash="200" endingSettledCash="180"/><CashReportCurrency accountId="${cfg.account}" reportDate="${SOURCE}" levelOfDetail="Currency" currency="USD" endingCash="200" endingSettledCash="180"/></CashReport></FlexStatement></FlexStatements></AF>`;
  const archive={bytes:xml,metadata:{privateObject:'synthetic/offline/archive.xml',generation:'1',rawSha256:digest(xml),configuredQueryId:cfg.configuredQueryId,baseCurrency:'USD',providerTimezone:null}};
  const receipt=await runPrivateEodReport({sourceDate:SOURCE,io,now:()=>time,loadContext:async()=>context(time),fieldMode,initialStartedAt:fieldMode?NOW-60000:null,
    readArchive:fieldMode?null:async()=>archive,verifyArchive:fieldMode?null:async()=>({status:'archive-verified',account:cfg.account,configuredQueryId:cfg.configuredQueryId,sourceDate:SOURCE,rawSha256:digest(xml),generation:'1'}),
    expectedAccount:cfg.account,expectedQueryId:cfg.configuredQueryId,snapshotReader:async({sourceKey})=>snapshot(sourceKey),
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
