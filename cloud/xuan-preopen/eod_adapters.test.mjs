import {buildBookConcentration} from '../../scripts/xuan-ib-eod-holdings.mjs';
// Every account, query, amount and archive below is synthetic offline data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createEodArchiveAdapters, createEodSnapshotReader, createPrivateEodAdapters} from './eod_adapters.mjs';
import {digest, readVerifiedSnapshot, SNAPSHOT_SCOPES,normalizeBrowserSnapshot,SHARESIGHT_BROWSER_SOURCE} from './eod_sources.mjs';
import {runPrivateEodReport} from './eod_report.mjs';
import {readSharesightAction} from './report.mjs';
import {runDaily, dailyCli} from './daily.mjs';
import {associationPolicyBlob} from '../../scripts/xuan-ib-account-association.mjs';
import {extractNightActionModel} from '../../scripts/xuan-ib-night-action-view.mjs';
globalThis.fetch = () => { throw new Error('OFFLINE_NETWORK_FORBIDDEN'); };
const DATE = '2026-10-08', NOW = () => Date.parse('2026-10-09T05:00:00Z');
const config = () => ({account:'SYNTHETIC_ACCOUNT', configuredQueryId:'SYNTHETIC_QUERY', baseCurrency:'USD', providerTimezone:null});
function fixture() {
  const bytes = '<FlexQueryResponse queryName="NotIdentity"><FlexStatements><FlexStatement accountId="SYNTHETIC_ACCOUNT" fromDate="20261001" toDate="20261008" whenGenerated="20261009;001530"><CashReport><CashReportCurrency accountId="SYNTHETIC_ACCOUNT" levelOfDetail="BaseCurrency" currency="BASE_SUMMARY" endingCash="200" endingSettledCash="180"/></CashReport><CashTransactions/><ConversionRates/></FlexStatement></FlexStatements></FlexQueryResponse>';
  return {bytes,metadata:{privateObject:'synthetic/offline/cash.xml',generation:'7',rawSha256:digest(bytes),configuredQueryId:'SYNTHETIC_QUERY',baseCurrency:'USD',providerTimezone:null}};
}
const binding = () => ({...config(),sourceDate:DATE,privateObject:fixture().metadata.privateObject,generation:'7',rawSha256:digest(fixture().bytes)});
const request = sourceKey => ({sourceKey,sourceDate:DATE,...SNAPSHOT_SCOPES[sourceKey]});
function snapshots() {
  const h=(id,group_name,value,code)=>({id,group_name,value,instrument:{code}});
  return Object.keys(SNAPSHOT_SCOPES).map(sourceKey => ({sourceKey,raw:{mode:'read_only',source:'Sharesight User API',data:{report:sourceKey==='sharesight.ibGroupedPerformance'
    ? {portfolio_id:936247,currency:{code:'USD'},start_date:DATE,end_date:DATE,include_sales:false,grouping:'custom_group_category',custom_group:{id:83569,name:'资产类别'},holdings:[h(1,'美国底仓',450,'CSPX'),h(2,'美国底仓',50,'USSC'),h(3,'美国科技',250,'GOOG'),h(4,'非美发达',180,'EXUS'),h(5,'新兴市场',70,'EIMI'),h(6,'防御资产',90,'TLT')],cash_accounts:[]}
    : {portfolio_id:936238,currency:{code:'USD'},start_date:DATE,end_date:DATE,include_sales:false,grouping:'investment_type',cash_accounts:[{value:50}]}}}}));
}
function context() {
  const policy={schemaVersion:1,policyId:'ib-primary-7day-pilot-v1',accountAlias:'IB-HK',basis:'owner-attested-recurring-v1',status:'active',purpose:'xuan-ib-read-only-report',editions:['adhoc','am','pm'],publisher:'codex-verified-candidate-v1',validFrom:'2026-09-11T13:30:00.000Z',expiresAt:'2026-10-10T13:30:00.000Z'};
  return {association:{policy,policyCommit:'a'.repeat(40),policyBlob:associationPolicyBlob(policy),checkedAt:new Date(NOW()).toISOString()},previousSourceSha:'c'.repeat(40),reserveHash:'b'.repeat(64),reserveLedger:{schemaVersion:1,purpose:'xuan-etf-owner-declared-pending-calls',entries:[{date:'2026-10-01',usd:50}]},previousHtml:''};
}
const adapters = (overrides={}) => createEodArchiveAdapters({trustedConfiguration:config(),archiveBinding:binding(),readArchiveObject:async()=>fixture(),now:NOW,...overrides});
test('archive reads pin object and generation; independent binding verifies identity only',async()=>{
  const a=adapters({readArchiveObject:async pin=>{assert.deepEqual(pin,{privateObject:binding().privateObject,generation:'7'});return fixture();}});
  const archive=await a.readArchive({sourceDate:DATE}),proof=await a.verifyArchive({archive,sourceDate:DATE,expectedAccount:a.expectedAccount,expectedQueryId:a.expectedQueryId});
  assert.equal(proof.status,'archive-verified');assert.equal(proof.rawSha256,binding().rawSha256);
  assert.equal(Object.hasOwn(proof,'facts'),false);assert.equal(Object.hasOwn(proof,'cashResidual'),false);
});
test('missing trusted configuration or independent binding cannot manufacture a proof',()=>{
  for(const overrides of [{trustedConfiguration:undefined},{archiveBinding:undefined},{archiveBinding:{...binding(),account:'OTHER'}},{archiveBinding:{...binding(),configuredQueryId:'OTHER'}},{archiveBinding:{...binding(),generation:''}},{archiveBinding:{...binding(),rawSha256:''}},{archiveBinding:{...binding(),sourceDate:'2026-02-30'}}])assert.throws(()=>adapters(overrides),/TRUSTED_BINDING_REQUIRED/);
});
test('tampered archive object, generation, hash, configured query, XML account or cutoff fail closed',async()=>{
  for(const edit of [a=>a.metadata.privateObject='synthetic/other.xml',a=>a.metadata.generation='8',a=>a.metadata.rawSha256='f'.repeat(64),a=>a.metadata.configuredQueryId='OTHER',a=>a.bytes+=' ',a=>{a.bytes=a.bytes.replaceAll('SYNTHETIC_ACCOUNT','OTHER');a.metadata.rawSha256=digest(a.bytes);},a=>{a.bytes=a.bytes.replace('toDate="20261008"','toDate="20261007"');a.metadata.rawSha256=digest(a.bytes);},a=>a.metadata.baseCurrency='HKD',a=>a.metadata.providerTimezone='Asia/Hong_Kong']){
    const archive=fixture();edit(archive);await assert.rejects(adapters({readArchiveObject:async()=>archive}).readArchive({sourceDate:DATE}));
  }
  const a=adapters();await assert.rejects(a.readArchive({sourceDate:'2026-10-07'}),/ARCHIVE_DATE/);
  for(const expected of [{expectedAccount:'OTHER',expectedQueryId:'SYNTHETIC_QUERY'},{expectedAccount:'SYNTHETIC_ACCOUNT',expectedQueryId:'OTHER'}])await assert.rejects(a.verifyArchive({archive:fixture(),sourceDate:DATE,...expected}),/ARCHIVE_SCOPE/);
});
test('independently pinned bad XML account/date still fails and XML query name grants no query identity',async()=>{
  for(const replace of [s=>s.replaceAll('SYNTHETIC_ACCOUNT','OTHER'),s=>s.replace('toDate="20261008"','toDate="20261007"')]){
    const archive=fixture();archive.bytes=replace(archive.bytes);archive.metadata.rawSha256=digest(archive.bytes);
    await assert.rejects(adapters({archiveBinding:{...binding(),rawSha256:digest(archive.bytes)},readArchiveObject:async()=>archive}).readArchive({sourceDate:DATE}),/ACCOUNT_OR_CUTOFF/);
  }
  const archive=fixture();archive.bytes=archive.bytes.replace('NotIdentity','SYNTHETIC_QUERY');archive.metadata.rawSha256=digest(archive.bytes);
  await assert.rejects(adapters({readArchiveObject:async()=>archive}).readArchive({sourceDate:DATE}),/ARCHIVE_BINDING/);
});
test('trusted inputs are captured without mutation after adapter construction',async()=>{
  const trustedConfiguration=config(),archiveBinding=binding(),a=adapters({trustedConfiguration,archiveBinding});
  trustedConfiguration.account='OTHER';archiveBinding.generation='9';assert.equal((await a.readArchive({sourceDate:DATE})).metadata.generation,'7');
});
test('both concurrent snapshot scopes reuse one exact batch and preserve raw API wrappers',async()=>{
  let batches=0;const sources=snapshots(),reader=createEodSnapshotReader({sourceDate:DATE,readSharesightBatch:async date=>{batches++;assert.equal(date,DATE);return sources;}});
  const results=await Promise.all(Object.keys(SNAPSHOT_SCOPES).map(sourceKey=>readVerifiedSnapshot(sourceKey,{reader,sourceDate:DATE,now:NOW})));
  assert.equal(batches,1);assert.deepEqual(results.map(s=>s.status),['date-verified','date-verified']);assert.equal(results[0].raw,sources[0].raw);assert.ok(results.every(s=>s.completion===null));
  await reader(request('sharesight.ibGroupedPerformance'));assert.equal(batches,1);
});
test('snapshot wrong request scope cannot dispatch any batch',async()=>{
  let batches=0;const reader=createEodSnapshotReader({sourceDate:DATE,readSharesightBatch:async()=>{batches++;return snapshots();}});
  for(const edit of [r=>r.sourceDate='2026-10-07',r=>r.sourceKey='other',r=>r.portfolio='NOAH-HK',r=>r.portfolioId=1,r=>r.grouping='investment_type']){const r=request('sharesight.ibGroupedPerformance');edit(r);await assert.rejects(reader(r),/SNAPSHOT_SCOPE/);}
  assert.equal(batches,0);
});
test('missing/duplicate scope and failed batch never manufacture snapshots or expose private errors',async()=>{
  for(const batch of [[],[snapshots()[0],snapshots()[0],snapshots()[1]]]){
    const reader=createEodSnapshotReader({sourceDate:DATE,readSharesightBatch:async()=>batch});
    assert.equal((await readVerifiedSnapshot('sharesight.ibGroupedPerformance',{reader,sourceDate:DATE,now:NOW})).status,'missing-fields');
    if(batch.length)assert.equal((await readVerifiedSnapshot('sharesight.noahPerformance',{reader,sourceDate:DATE,now:NOW})).status,'date-verified');
  }
  let batches=0;const reader=createEodSnapshotReader({sourceDate:DATE,readSharesightBatch:async()=>{batches++;throw new Error('PRIVATE_SYNTHETIC_CANARY');}});
  for(const sourceKey of Object.keys(SNAPSHOT_SCOPES))await assert.rejects(reader(request(sourceKey)),e=>e.message==='EOD_ADAPTER_SNAPSHOT_READ_FAILED');
  assert.equal(batches,1);
  await assert.rejects(adapters({readArchiveObject:async()=>{throw new Error('PRIVATE_SYNTHETIC_CANARY');}}).readArchive({sourceDate:DATE}),e=>e.message==='EOD_ADAPTER_ARCHIVE_READ_FAILED');
});
test('each source scope/date/grouping failure independently preserves its sibling',async()=>{
  for(const index of [0,1])for(const edit of [r=>r.portfolio_id=-1,r=>r.end_date='2026-10-07',r=>delete r.end_date,r=>r.grouping='other',r=>r.start_date='2026-10-07',r=>delete r.start_date,r=>r.include_sales=true,r=>delete r.include_sales,r=>r.currency.code='HKD',r=>{if(index===0)r.custom_group.id=1;else r.grouping='83569';}]){
    const sources=snapshots();edit(sources[index].raw.data.report);const reader=createEodSnapshotReader({sourceDate:DATE,readSharesightBatch:async()=>sources});
    const results=await Promise.all(Object.keys(SNAPSHOT_SCOPES).map(sourceKey=>readVerifiedSnapshot(sourceKey,{reader,sourceDate:DATE,now:NOW})));
    assert.notEqual(results[index].status,'date-verified');assert.equal(results[1-index].status,'date-verified');
  }
});
test('null or unknown batch items cannot discard a valid sibling or authorize another scope',async()=>{
  for(const bad of [null,{sourceKey:'unknown.source',raw:{privateCanary:'SYNTHETIC_PRIVATE_ITEM'}}]){
    let batches=0;const noah=snapshots()[1],reader=createEodSnapshotReader({sourceDate:DATE,readSharesightBatch:async()=>{batches++;return [bad,noah];}});
    const results=await Promise.all(Object.keys(SNAPSHOT_SCOPES).map(sourceKey=>readVerifiedSnapshot(sourceKey,{reader,sourceDate:DATE,now:NOW})));
    assert.deepEqual(results.map(r=>r.status),['missing-fields','date-verified']);assert.equal(results[1].raw,noah.raw);assert.equal(batches,1);
    assert.equal(JSON.stringify(results).includes('SYNTHETIC_PRIVATE_ITEM'),false);
    await assert.rejects(reader({...request('sharesight.ibGroupedPerformance'),sourceKey:'unknown.source'}),/SNAPSHOT_SCOPE/);
    assert.equal(batches,1);
  }
});
test('non-array batch remains an overall failure for both fixed scopes',async()=>{
  const reader=createEodSnapshotReader({sourceDate:DATE,readSharesightBatch:async()=>({sources:snapshots()})});
  for(const sourceKey of Object.keys(SNAPSHOT_SCOPES))await assert.rejects(reader(request(sourceKey)),/SNAPSHOT_BATCH/);
});
test('existing fixed transport settle mode isolates one HTTP failure; default retains legacy rejection',async()=>{
  const urls=[];const fetchImpl=async url=>{urls.push(new URL(url));return new URL(url).searchParams.get('portfolio')==='IB-HK'?new Response('synthetic failure',{status:503}):new Response(JSON.stringify(snapshots()[1].raw));};
  const reader=createEodSnapshotReader({sourceDate:DATE,readSharesightBatch:date=>readSharesightAction(date,'synthetic-token',{fetchImpl,now:NOW,settle:true})});
  const results=await Promise.all(Object.keys(SNAPSHOT_SCOPES).map(sourceKey=>readVerifiedSnapshot(sourceKey,{reader,sourceDate:DATE,now:NOW})));
  assert.deepEqual(results.map(r=>r.status),['request-failure','date-verified']);assert.equal(urls.length,2);
  assert.deepEqual(urls.map(u=>[u.pathname,u.searchParams.get('portfolio'),u.searchParams.get('grouping'),u.searchParams.get('start_date'),u.searchParams.get('end_date'),u.searchParams.get('include_sales')]),[['/v1/performance','IB-HK','83569',DATE,DATE,'false'],['/v1/performance','NOAH-HK','investment_type',DATE,DATE,'false']]);
  await assert.rejects(readSharesightAction(DATE,'synthetic-token',{fetchImpl,now:NOW}),/HTTP_503/);
});
test('cash-only composed runner uses existing private saves, remains partial and never touches IB or credentials',async()=>{
  const objects=new Map();let contexts=0,batches=0;
  const io={savePrivate:async(name,value)=>{assert.equal(objects.has(name),false);objects.set(name,value);return {sha256:digest(value),generation:'1'};},loadGatewayToken:()=>assert.fail('No credentials'),ibStore:new Proxy({}, {get:()=>assert.fail('No IB')})};
  const options=createPrivateEodAdapters({io,loadContext:async()=>{contexts++;return context();},trustedConfiguration:config(),archiveBinding:binding(),readArchiveObject:async()=>fixture(),readSharesightBatch:async()=>{batches++;return snapshots();},now:NOW});
  const receipt=await runPrivateEodReport(options),model=extractNightActionModel(objects.get(receipt.artifact.privateObject));
  assert.equal(contexts,2);assert.equal(batches,1);assert.equal(model.schemaVersion,9);assert.equal(model.status,'partial');assert.equal(model.cash.ib,200);assert.equal(model.cash.noah,50);assert.equal(model.allocation.status,'ready');
  assert.equal(model.orders.buys,null);assert.equal(model.orders.sells,null);assert.equal(model.cash.orderReserve,null);assert.equal(model.cash.planning,null);assert.equal(model.cash.executableBudget,null);assert.equal(model.cash.availableFunds.status,'unknown');assert.equal(model.reconciliation.status,'unknown');
  assert.equal(receipt.publication,'none');assert.equal(receipt.scheduler,'none');assert.ok([...objects.keys()].at(-1).endsWith('/receipt.json'));
  assert.equal(JSON.stringify(model).includes(config().account),false);assert.equal(JSON.stringify(model).includes(binding().privateObject),false);
});
test('default daily selects B and stops on absent deployment config before marker, context or credentials',async()=>{
  const saved=[];let credentials=0;const io={savePrivate:async name=>{saved.push(name);return {sha256:'a'.repeat(64),generation:'1'};},ibStore:new Proxy({}, {get:()=>assert.fail('No IB call')}),loadFlexToken:()=>assert.fail('No Flex credential before context'),loadGatewayToken:async()=>{credentials++;throw new Error('SYNTHETIC_LEGACY_STOP');}};
  await assert.rejects(runDaily({io,now:NOW,execution:'xuan-preopen-report-offline'}),/EOD_DAILY_CONFIGURATION_REQUIRED/);
  assert.equal(credentials,0);assert.deepEqual(saved,[]);
  let daily=0;await dailyCli([],{daily:async()=>{daily++;},diagnostic:()=>assert.fail('No diagnostic')});assert.equal(daily,1);
});

const browserDate='2026-10-20',browserScope={portfolioId:936247,sourceDate:browserDate};
function browserFixture(){return {mode:'read_only',source:SHARESIGHT_BROWSER_SOURCE,observation:{portfolio:'IB-HK',valuationDate:browserDate,retrievedAt:'2026-10-21T02:24:11Z',reportingCurrency:'USD',portfolioValue:170,
 positions:[{instrument:'SYNTH | TEST',price:7.25,priceCurrency:'CAD',quantity:10,marketValueUSD:70,sourcePath:'/holdings/1',priceDate:null}],
 cash:[{name:'Synthetic',marketValueUSD:100,sourcePath:'/cash_accounts/1',nativeCurrency:'CAD',nativeBalance:140}]},classification:null};}
test('browser row values and native currencies remain distinct; original observation time is never refreshed',async()=>{
 const raw=browserFixture(),s=await readVerifiedSnapshot('sharesight.ibGroupedPerformance',{reader:async()=>({raw}),sourceDate:browserDate,now:()=>Date.parse('2026-10-21T02:25:00Z')});
 assert.equal(s.status,'date-verified');assert.equal(s.provenance.readAt,'2026-10-21T02:24:11.000Z');assert.equal(s.provenance.syncCompletedAt,null);
 assert.equal(s.raw.source,SHARESIGHT_BROWSER_SOURCE);assert.equal(s.raw.data.report.holdings[0].value,70);assert.equal(s.raw.data.report.cash_accounts[0].currency.code,'CAD');
 assert.equal(s.raw.data.report.holdings[0].group_name,'');assert.equal(s.rawFingerprint,digest(s.raw));
 const c=buildBookConcentration(s,browserDate);assert.equal(c.status,'ready');assert.equal(c.total,170);assert.equal(c.rows[0].currency,'CAD');
});
test('browser scope, total, duplicate identities, unrecognized currency and future capture fail closed',async()=>{
 for(const change of [o=>o.portfolio='OTHER',o=>o.valuationDate='2026-10-19',o=>o.portfolioValue++,o=>o.positions.push({...o.positions[0]}),o=>o.cash.push({...o.cash[0]}),o=>o.cash[0].nativeCurrency='unknown',o=>o.positions[0].priceCurrency='unknown']){
  const raw=browserFixture();change(raw.observation);assert.throws(()=>normalizeBrowserSnapshot(raw,browserScope));
 }
 const raw=browserFixture();const s=await readVerifiedSnapshot('sharesight.ibGroupedPerformance',{reader:async()=>({raw}),sourceDate:browserDate,now:()=>Date.parse('2026-10-21T02:00:00Z')});assert.equal(s.status,'malformed');
});
