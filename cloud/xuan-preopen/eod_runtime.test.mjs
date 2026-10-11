// Synthetic offline sources only. Fixed account comes from the existing
// independent binding, never from an archive or a copied private fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {APPROVED_IB_ACCOUNT_ID} from '../../scripts/xuan-ib-run-manifest.mjs';
import {associationPolicyText,validateAssociationPolicy} from '../../scripts/xuan-ib-account-association.mjs';
import {extractNightActionModel} from '../../scripts/xuan-ib-night-action-view.mjs';
import {loadTrustedContext} from './report.mjs';
import {CASH_ARCHIVE_BUCKET,BUCKET,privateCloudIo} from './cloud_io.mjs';
import {adaptFlexArchive,digest} from './eod_sources.mjs';
import {archiveEligibilityFloor,readFixedCashArchive} from './eod_runtime.mjs';
import {runDaily} from './daily.mjs';
import {collectDelivery} from './delivery.mjs';
import {publishPrepared} from './publish.mjs';
import {classifySleepPublication} from '../../scripts/xuan-ib-sleep-priority.mjs';
const DATE='2026-10-08',NOW=()=>Date.parse('2026-10-09T05:00:00Z');
const blob=text=>crypto.createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
function original({cutoff=DATE,account=APPROVED_IB_ACCOUNT_ID,currency='baseCurrency="USD"',extra='',cash='200'}={}){
  return `<AF><FlexStatements><FlexStatement accountId="${account}" fromDate="2026-10-01" toDate="${cutoff}" whenGenerated="2026-10-09;00:15:30" ${currency}><CashReport><CashReportCurrency accountId="${account}" reportDate="${cutoff}" levelOfDetail="BaseCurrency" currency="BASE_SUMMARY" endingCash="${cash}" endingSettledCash="180"/></CashReport>${extra}</FlexStatement></FlexStatements></AF>`;
}
function stored(bytes=original(),overrides={}){
  return {bytes,object:{name:`reports/${digest(bytes)}.xml`,generation:'11',metageneration:'1',size:String(Buffer.byteLength(bytes)),timeCreated:'2026-10-09T00:16:00.123456Z',...overrides}};
}
function archiveIo(entries=[stored()],{page,read,second}={}){
  let lists=0,gets=0;const calls=[];
  return {calls,io:{
    listCashArchives:async({pageToken,signal})=>{
      calls.push({kind:'list',pageToken,signal});lists++;
      const p=page?page(lists,pageToken):{items:lists>1&&second?second:entries.map(e=>e.object)};
      return {page:p,responseBytes:Buffer.byteLength(JSON.stringify(p))};
    },
    getCashArchive:async input=>{
      calls.push({kind:'get',...input});gets++;
      const e=entries.find(e=>e.object.name===input.name);
      return read?read(e,gets):{...structuredClone(e),responseBytes:Buffer.byteLength(JSON.stringify(e.object))};
    },
  }};
}
async function readArchive(h,options={}){return readFixedCashArchive({io:h.io,sourceDate:DATE,now:NOW,...options});}
test('unique original cash archive binds generation/hash/date/account while producer query stays unknown',async()=>{
  const h=archiveIo(),a=await readArchive(h);
  assert.equal(a.metadata.configuredQueryId,'1630084');assert.equal(a.metadata.producerQueryId,null);assert.equal(a.metadata.queryProvenance,'unknown');
  assert.equal(a.metadata.baseCurrencyEvidence,'original-statement-declaration');assert.equal(a.metadata.providerTimezone,null);
  assert.equal(h.calls.filter(c=>c.kind==='list').length,2);assert.equal(h.calls.filter(c=>c.kind==='get').length,1);
  assert.ok(h.calls.every(c=>c.signal instanceof AbortSignal));
});
test('conservative eligibility floor follows NY daylight saving; old archives need no body GET',async()=>{
  assert.equal(new Date(archiveEligibilityFloor(DATE)).toISOString(),'2026-10-08T20:00:00.000Z');
  assert.equal(new Date(archiveEligibilityFloor('2026-12-10')).toISOString(),'2026-12-10T21:00:00.000Z');
  const old=stored(original({cutoff:'2026-10-07'}),{timeCreated:'2026-10-08T00:16:00Z'}),h=archiveIo([old,stored()]);
  await readArchive(h);assert.deepEqual(h.calls.filter(c=>c.kind==='get').map(c=>c.name),[stored().object.name]);
});
test('all eligible originals are inspected; stale late uploads may be disqualified, ambiguity is rejected',async()=>{
  const stale=stored(original({cutoff:'2026-10-07'})),h=archiveIo([stale,stored()]);
  await readArchive(h);assert.equal(h.calls.filter(c=>c.kind==='get').length,2);
  await assert.rejects(readArchive(archiveIo([stale])),/CUTOFF_NOT_FOUND/);
  await assert.rejects(readArchive(archiveIo([stored(),stored(original({cash:'201'}))])),/AMBIGUOUS/);
});
test('archive hash, account, cutoff, row dates, currency and malformed XML fail closed',async()=>{
  const entries=[
    stored(original(),{name:`reports/${'f'.repeat(64)}.xml`}),stored(original({account:'SYNTHETIC_WRONG_ACCOUNT'})),
    stored(original({cutoff:'2026-10-09'})),stored(original().replace('reportDate="2026-10-08"','reportDate="2026-10-07"')),
    stored(original().replace('reportDate="2026-10-08"','toDate="2026-10-07"')),
    stored(original().replace('reportDate="2026-10-08"','fromDate="2026-10-09"')),
    stored(original({currency:'baseCurrency="USD" currency="EUR"'})),
    stored('<!DOCTYPE x>'+original()),stored(original({extra:'<Trades/><Trades/>'})),
    stored(original(),{metadata:{sourceDate:'2026-10-07'}}),stored(original(),{metadata:{configuredQueryId:'OTHER'}}),
    stored(original(),{metadata:{baseCurrency:'EUR'}}),
  ];
  for(const e of entries)await assert.rejects(readArchive(archiveIo([e])),/^Error: EOD_/);
  // XML query attributes do not become historical producer evidence.
  const a=await readArchive(archiveIo([stored(original().replace('baseCurrency="USD"','baseCurrency="USD" queryid="OTHER"'))]));
  assert.equal(a.metadata.producerQueryId,null);
});
test('missing original USD declaration degrades cash only, never metadata/native/rate inference',async()=>{
  for(const currency of ['', 'baseCurrency="EUR"'])for(const metadata of [{},{baseCurrency:currency?'EUR':'USD'}]){
    const a=await readArchive(archiveIo([stored(original({currency}),{metadata})]));
    assert.equal(a.metadata.baseCurrency,null);assert.equal(a.metadata.baseCurrencyEvidence,null);
    const f=adaptFlexArchive(a,{expectedAccount:APPROVED_IB_ACCOUNT_ID,expectedQueryId:'1630084',sourceDate:DATE,readAt:new Date(NOW()).toISOString()});
    assert.equal(f.cash,null);assert.equal(f.cashUnavailableReason,'FLEX_BASE_CURRENCY_UNVERIFIED');
    if(!currency)assert.equal(adaptFlexArchive({...a,metadata:{...a.metadata,baseCurrency:'USD'}},{expectedAccount:APPROVED_IB_ACCOUNT_ID,expectedQueryId:'1630084',sourceDate:DATE,readAt:new Date(NOW()).toISOString()}).cash,null);
    assert.equal(f.rawFingerprint,digest(a.bytes));assert.equal(f.provenance.sourceDate,DATE);
    assert.equal(f.reconciliation.status,'unknown');assert.equal(f.reconciliation.cashResidual,null);
  }
  // Currency uncertainty must not hide malformed cash or unsafe identity/date.
  for(const edit of [s=>s.replace('endingCash="200"','endingCash="NaN"'),s=>s.replace('endingSettledCash="180"','endingSettledCash="-1"'),s=>s.replace('BASE_SUMMARY','USD'),s=>s.replace('reportDate="2026-10-08"','reportDate="2026-10-07"'),s=>s.replace('whenGenerated="2026-10-09;00:15:30"','whenGenerated="invalid"')])await assert.rejects(readArchive(archiveIo([stored(edit(original({currency:''})))])),/^Error: EOD_/);
});
test('statement-period cash transactions and conversion rates allow only dates within original coverage',async()=>{
  const extra=`<CashTransactions><CashTransaction accountId="${APPROVED_IB_ACCOUNT_ID}" reportDate="2026-10-01"/></CashTransactions><ConversionRates><ConversionRate reportDate="2026-10-07"/></ConversionRates>`;
  await readArchive(archiveIo([stored(original({extra}))]));
  for(const edit of [s=>s.replace('reportDate="2026-10-01"','reportDate="2026-09-30"'),s=>s.replace('reportDate="2026-10-07"','reportDate="2026-10-09"'),s=>s.replace('reportDate="2026-10-07"','reportDate="2026-02-30"'),s=>s.replace('<ConversionRate ','<ConversionRate accountId="SYNTHETIC_WRONG_ACCOUNT" ')])await assert.rejects(readArchive(archiveIo([stored(original({extra:edit(extra)}))])),/ROW_SCOPE|EOD_DATE/);
  // Cash aggregates remain source-date snapshots with the same covered start.
  for(const dates of ['fromDate="2026-09-30" toDate="2026-10-08"','fromDate="2026-10-01" toDate="2026-10-07"'])await assert.rejects(readArchive(archiveIo([stored(original().replace('reportDate="2026-10-08"',dates))])),/ROW_SCOPE/);
  await readArchive(archiveIo([stored(original().replace('reportDate="2026-10-08"','fromDate="2026-10-01" toDate="2026-10-08"'))]));
});
test('object identity, metadata race, size, future/invalid creation dates and path reject',async()=>{
  for(const overrides of [{name:'reports/other.xml'},{generation:'0'},{metageneration:'0'},{size:'8000001'},{timeCreated:'2026-10-10T00:00:00Z'},{timeCreated:'2026-02-30T00:00:00Z'}])await assert.rejects(readArchive(archiveIo([stored(original(),overrides)])),/EOD_ARCHIVE_/);
  for(const mutate of [e=>e.object.metageneration='2',e=>e.object.generation='12',e=>e.object.metadata={claim:'changed'},e=>e.bytes+=' ',e=>e.object.timeCreated='2026-10-09T00:17:00Z']){
    const h=archiveIo([stored()],{read:e=>{const r=structuredClone(e);mutate(r);return {...r,responseBytes:100};}});
    await assert.rejects(readArchive(h),/METADATA_CHANGED|BODY_SIZE/);
  }
  await assert.rejects(readArchive(archiveIo([stored()],{second:[stored().object,stored(original({cash:'201'})).object]})),/ENUMERATION_CHANGED/);
});
test('bounded enumeration requires complete pages before body GET and rejects token loops/candidate overflow',async()=>{
  for(const options of [
    {page:()=>({items:[],nextPageToken:'loop'})},
    {page:n=>({items:[],nextPageToken:`page-${n}`})},
    {page:()=>({items:[stored().object,stored().object]})},
    {page:()=>({items:Array(101).fill(stored().object)})},
    {page:()=>({items:[],nextPageToken:''})},
  ]){const h=archiveIo([stored()],options);await assert.rejects(readArchive(h),/EOD_ARCHIVE_/);assert.equal(h.calls.filter(c=>c.kind==='get').length,0);}
  const many=archiveIo(Array.from({length:5},(_,n)=>stored(original({cash:String(200+n)}))));
  await assert.rejects(readArchive(many),/CANDIDATE_BUDGET/);assert.equal(many.calls.filter(c=>c.kind==='get').length,0);
  const h=archiveIo();let clock=0;await assert.rejects(readArchive(h,{now:()=>NOW()+(clock++?90_001:0)}),/DEADLINE/);
  const metadata=archiveIo();metadata.io.listCashArchives=async()=>({page:{items:[stored().object]},responseBytes:2_000_001});await assert.rejects(readArchive(metadata),/METADATA_BUDGET/);
});
test('pagination succeeds within budget and rechecks the complete eligible set',async()=>{
  const old=stored(original({cutoff:'2026-10-07'}),{timeCreated:'2026-10-08T00:16:00Z'});
  const h=archiveIo([old,stored()],{page:(_n,token)=>token?{items:[stored().object]}:{items:[old.object],nextPageToken:'last'}});
  await readArchive(h);assert.equal(h.calls.filter(c=>c.kind==='list').length,4);assert.equal(h.calls.filter(c=>c.kind==='get').length,1);
});

function snapshot(portfolio){
  const holding=(n,group,value,code)=>({id:n,group_name:group,value,instrument:{code},quantity:10,instrument_price:10});
  const report=portfolio==='IB-HK'?{portfolio_id:936247,currency:{code:'USD'},grouping:'custom_group_category',custom_group:{id:83569,name:'资产类别'},end_date:DATE,holdings:[holding(1,'美国底仓',500,'CSPX'),holding(2,'美国科技',250,'GOOG'),holding(3,'非美发达',180,'EXUS'),holding(4,'新兴市场',70,'EIMI'),holding(5,'防御资产',90,'TLT')],cash_accounts:[]}:{portfolio_id:936238,currency:{code:'USD'},end_date:DATE,cash_accounts:[{value:50}]};
  return {mode:'read_only',source:'Sharesight User API',data:{report}};
}
function defaultHarness({noahFailure=false,expired=false,archive=stored()}={}){
  const objects=new Map(),calls=[],policy=JSON.parse(fs.readFileSync(new URL('../../claude/xuan-ib-account-association-v1.json',import.meta.url),'utf8'));
  if(expired)policy.expiresAt='2026-10-08T13:30:00.000Z';
  const previous='SYNTHETIC PREVIOUS PUBLIC HTML',files={
    'claude/xuan-ib-account-association-v1.json':associationPolicyText(policy),
    'claude/xuan-ib-etf-pending-calls-v1.json':JSON.stringify({schemaVersion:1,purpose:'xuan-etf-owner-declared-pending-calls',entries:[{date:'2026-10-01',usd:50}]}),
    'xuan-ib/latest.meta.json':JSON.stringify({sourceSha:'c'.repeat(40),htmlBlob:blob(previous)}),'xuan-ib/latest.html':previous,
  };
  const fetchImpl=async(input,options={})=>{
    const u=new URL(input);calls.push({u,options});
    if(u.hostname==='api.github.com'&&u.pathname.endsWith('/commits/main'))return Response.json({sha:'a'.repeat(40)});
    if(u.hostname==='raw.githubusercontent.com'){
      const path=u.pathname.split('/').slice(4).join('/');if(!Object.hasOwn(files,path))throw Error('UNEXPECTED_PUBLIC_PATH');return new Response(files[path]);
    }
    if(u.hostname==='metadata.google.internal')return Response.json({access_token:'SYNTHETIC_GOOGLE'});
    if(u.hostname==='secretmanager.googleapis.com'&&u.pathname.endsWith('/family-portfolio-gateway-key/versions/latest:access'))return Response.json({payload:{data:Buffer.from('SYNTHETIC_GATEWAY').toString('base64')}});
    if(u.hostname==='family-portfolio-gateway-6ikas4b3ma-df.a.run.app'){
      assert.equal(u.pathname,'/v1/performance');assert.equal(options.method??'GET','GET');assert.equal(options.headers.Authorization,'Bearer SYNTHETIC_GATEWAY');
      assert.equal(u.searchParams.get('start_date'),DATE);assert.equal(u.searchParams.get('end_date'),DATE);assert.equal(u.searchParams.get('include_sales'),'false');
      const p=u.searchParams.get('portfolio');assert.ok(['IB-HK','NOAH-HK'].includes(p));assert.equal(u.searchParams.get('grouping'),p==='IB-HK'?'83569':'investment_type');
      return noahFailure&&p==='NOAH-HK'?new Response('SYNTHETIC DENIED',{status:403}):Response.json(snapshot(p));
    }
    if(u.hostname==='storage.googleapis.com'&&u.pathname===`/storage/v1/b/${CASH_ARCHIVE_BUCKET}/o`){
      assert.equal(u.searchParams.get('prefix'),'reports/');assert.equal(u.searchParams.get('maxResults'),'100');assert.equal(u.searchParams.get('versions'),'false');return Response.json({items:[archive.object]});
    }
    if(u.hostname==='storage.googleapis.com'&&u.pathname.startsWith(`/storage/v1/b/${CASH_ARCHIVE_BUCKET}/o/`)){
      assert.equal(decodeURIComponent(u.pathname.split('/o/')[1]),archive.object.name);
      for(const p of ['generation','ifGenerationMatch'])assert.equal(u.searchParams.get(p),archive.object.generation);
      assert.equal(u.searchParams.get('ifMetagenerationMatch'),archive.object.metageneration);
      return u.searchParams.get('alt')==='media'?new Response(archive.bytes):Response.json(archive.object);
    }
    if(u.hostname==='storage.googleapis.com'&&u.pathname===`/upload/storage/v1/b/${BUCKET}/o`){
      assert.equal(options.method,'POST');assert.equal(u.searchParams.get('ifGenerationMatch'),'0');
      const name=u.searchParams.get('name');if(objects.has(name))return new Response('exists',{status:412});
      const bytes=Buffer.from(options.body);objects.set(name,bytes.toString());return Response.json({name,size:String(bytes.length),generation:'123'});
    }
    throw Error('UNEXPECTED_OR_FORBIDDEN_NETWORK');
  };
  return {objects,calls,fetchImpl,context:()=>loadTrustedContext({fetchImpl,now:NOW})};
}
test('actual daily default -> EOD -> private receipt -> delivery -> publisher uses fixed readers once and no IB credential',async()=>{
  for(const noahFailure of [false,true]){
    const h=defaultHarness({noahFailure});
    // Neither generate nor io is injected: exercise the real default wiring.
    const daily=await runDaily({fetchImpl:h.fetchImpl,now:NOW,execution:'xuan-preopen-report-synthetic'});
    assert.equal(daily.status,'partial');assert.equal([...h.objects.keys()].at(-1),'delivery/2026-10-09/receipt.json');
    const financial=h.calls.filter(c=>c.u.hostname.includes('6ikas4b3ma'));assert.equal(financial.length,2);
    assert.equal(h.calls.filter(c=>c.u.hostname==='secretmanager.googleapis.com').length,1);
    assert.ok(h.calls.every(c=>!c.u.href.includes('xuan-preopen-ib-mcp')&&!c.u.href.includes(':addVersion')));
    const delivered=await collectDelivery({now:NOW,loadContext:h.context,request:async(url,options)=>{
      assert.notEqual(options?.method,'POST');const name=decodeURIComponent(new URL(url).pathname.split('/o/')[1]);return h.objects.get(name)??null;
    }});
    assert.equal(delivered.outcome,'reused');const m=extractNightActionModel(delivered.html);
    assert.equal(m.cash.ib,200);assert.equal(m.cash.noah,noahFailure?null:50);assert.equal(m.orders.buys,null);assert.equal(m.cash.planning,null);assert.equal(m.cash.executableBudget,null);
    assert.equal(m.sourceOutcomes[1].status,'date-verified');assert.equal(m.sourceOutcomes[2].status,noahFailure?'request-failure':'date-verified');assert.equal(m.sourceOutcomes[3].status,'not-called');
    assert.ok(!delivered.html.includes(APPROVED_IB_ACCOUNT_ID)&&!delivered.html.includes('gs://')&&!delivered.html.includes('1630084'));
    const graph=[];const published=await publishPrepared({...delivered,loadContext:h.context,now:NOW,request:async payload=>{
      graph.push(payload);
      if(payload.query.startsWith('query'))return {data:{viewer:{login:'huanwujoy-crypto'},repository:{id:'synthetic',ref:{target:{oid:'a'.repeat(40)}}}}};
      if(payload.query.includes('CreateRef'))return {data:{createRef:{ref:{name:payload.variables.input.name,target:{oid:'a'.repeat(40)}}}}};
      return {data:{createCommitOnBranch:{commit:{oid:'d'.repeat(40)},ref:{name:payload.variables.input.branch.branchName}}}};
    }});
    assert.equal(published.publication,'candidate-only');assert.equal(graph.length,3);assert.deepEqual(graph[2].variables.input.fileChanges.additions.map(f=>f.path),['xuan-ib/index.html']);
    const before=h.calls.length;await assert.rejects(runDaily({fetchImpl:h.fetchImpl,now:NOW,execution:'xuan-preopen-report-synthetic'}),/CLOUD_HTTP_412/);
    assert.ok(h.calls.slice(before).every(c=>!c.u.hostname.includes('6ikas4b3ma')&&!c.u.pathname.includes(CASH_ARCHIVE_BUCKET)));
  }
});
test('actual default without base USD retains four cards and both dated API outcomes through protected candidate validation',async()=>{
  for(const noahFailure of [false,true]){
    const h=defaultHarness({noahFailure,archive:stored(original({currency:''}),{metadata:{baseCurrency:'USD'}})});
    await runDaily({fetchImpl:h.fetchImpl,now:NOW,execution:'xuan-preopen-report-synthetic'});
    const r=JSON.parse(h.objects.get('delivery/2026-10-09/receipt.json')),html=h.objects.get(r.artifact.privateObject),m=extractNightActionModel(html);
    assert.equal(m.cash.eod.reason,'FLEX_BASE_CURRENCY_UNVERIFIED');assert.equal(m.cash.ib,null);
    assert.equal(m.cash.noah,noahFailure?null:50);
    for(const k of ['pool','orderReserve','planning','totalCapacity','executableBudget'])assert.equal(m.cash[k],null);
    assert.equal(m.cash.availableFunds.status,'unknown');assert.equal(m.reconciliation.status,'unknown');assert.equal(m.reconciliation.cashResidual,null);
    assert.equal(m.allocation.status,'ready');assert.equal(m.allocation.categories.length,4);assert.equal(m.allocation.fundingNeed.status,'verified');
    assert.equal(m.orders.buys,null);assert.equal(m.orders.sells,null);
    assert.equal(m.sourceOutcomes[0].status,'verified');assert.equal(m.sourceOutcomes[1].status,'date-verified');assert.equal(m.sourceOutcomes[2].status,noahFailure?'request-failure':'date-verified');
    assert.equal(h.calls.filter(c=>c.u.hostname.includes('6ikas4b3ma')).length,2);
    for(const title of ['本轮补仓','挂单提醒','现金优先补仓参考','股票四类配置'])assert.ok(html.includes(title));
    assert.ok(html.includes('IB 基准币种未独立核实'));assert.ok(!html.includes('现金实数与当前配置仍可查看'));
    const state=classifySleepPublication(html);assert.equal(state.kind,'eod-action');assert.equal(m.status,'partial');
    const delivered=await collectDelivery({now:NOW,loadContext:h.context,request:async url=>h.objects.get(decodeURIComponent(new URL(url).pathname.split('/o/')[1]))??null});
    assert.equal(delivered.outcome,'reused');
    const graph=[];await publishPrepared({...delivered,loadContext:h.context,now:NOW,request:async payload=>{
      graph.push(payload);if(payload.query.startsWith('query'))return {data:{viewer:{login:'huanwujoy-crypto'},repository:{id:'synthetic',ref:{target:{oid:'a'.repeat(40)}}}}};
      if(payload.query.includes('CreateRef'))return {data:{createRef:{ref:{name:payload.variables.input.name,target:{oid:'a'.repeat(40)}}}}};
      return {data:{createCommitOnBranch:{commit:{oid:'d'.repeat(40)},ref:{name:payload.variables.input.branch.branchName}}}};
    }});assert.equal(graph.length,3);
  }
});
test('private UI default-entry seam cannot select production transport or create public delivery',async()=>{
  await assert.rejects(runDaily({privateNoahUiExport:{}}),/DAILY_OFFLINE_UI_ACCEPTANCE_ONLY/);
  const h=defaultHarness();await assert.rejects(runDaily({fetchImpl:h.fetchImpl,now:NOW,execution:'xuan-preopen-report-synthetic',privateNoahUiExport:{bytes:'{}',expectedTransferSha256:digest('{}'),reportStart:'2025-01-01'}}),/UI_EXPORT_SCOPE/);
  assert.ok([...h.objects.keys()].every(k=>k.startsWith('report-check/')));assert.ok(!h.objects.has('delivery/2026-10-09/receipt.json'));
});
test('default rejects expired association or unsafe archive without any completed delivery',async()=>{
  for(const options of [{expired:true},{archive:stored(original({account:'SYNTHETIC_WRONG_ACCOUNT'}))}]){
    const h=defaultHarness(options);await assert.rejects(runDaily({fetchImpl:h.fetchImpl,now:NOW,execution:'xuan-preopen-report-synthetic'}));
    assert.ok(h.objects.has('delivery/2026-10-09/start.json'));assert.ok(!h.objects.has('delivery/2026-10-09/receipt.json'));
    if(options.expired)assert.ok(h.calls.every(c=>!c.u.hostname.includes('6ikas4b3ma')&&!c.u.pathname.includes(CASH_ARCHIVE_BUCKET)&&c.u.hostname!=='secretmanager.googleapis.com'));
  }
});
test('archive transport sanitizes denied reads, preserves fixed scope and rejects invalid object input before fetching',async()=>{
  let calls=0;const io=privateCloudIo({fetchImpl:async u=>{calls++;return String(u).includes('metadata.google')?Response.json({access_token:'SYNTHETIC'}):new Response('private detail',{status:403});}});
  await assert.rejects(io.getCashArchive({name:'other',generation:'1',metageneration:'1'}),/SCOPE_INVALID/);assert.equal(calls,0);
  await assert.rejects(io.listCashArchives(),/^Error: CLOUD_HTTP_403$/);
});
test('detached IAM proposal grants only reviewed source bucket metadata and original archive GET scope',()=>{
  const p=JSON.parse(fs.readFileSync(new URL('../../security/xuan-preopen-eod-source-iam.proposed.json',import.meta.url),'utf8'));
  assert.equal(p.status,'proposed-not-created-or-granted');
  assert.deepEqual(p.customRolesToCreate.flatMap(r=>r.includedPermissions).sort(),['storage.objects.get','storage.objects.list']);
  assert.equal(p.bindingsToAddAfterConcreteApproval.length,2);
  for(const b of p.bindingsToAddAfterConcreteApproval){assert.equal(b.member,p.member);assert.equal(b.resource,`projects/_/buckets/${CASH_ARCHIVE_BUCKET}`);}
  assert.equal(p.bindingsToAddAfterConcreteApproval[0].condition,null);
  assert.equal(p.bindingsToAddAfterConcreteApproval[1].condition.expression,`resource.type == 'storage.googleapis.com/Object' && resource.name.startsWith('projects/_/buckets/${CASH_ARCHIVE_BUCKET}/objects/reports/')`);
  assert.ok(p.member.startsWith('serviceAccount:xuan-preopen-source@'));
});
test('detached renewal preserves active file and scopes; candidate starts at old expiry and expires in exactly 30 days',()=>{
  const path=new URL('../../claude/xuan-ib-account-association-v1.json',import.meta.url),text=fs.readFileSync(path,'utf8'),before=JSON.parse(text);
  const patch=fs.readFileSync(new URL('../../docs/xuan-preopen-eod-association-renewal.patch',import.meta.url),'utf8');
  let proposed=text;
  for(const [oldValue,newValue] of [['2026-09-11T13:30:00.000Z','2026-10-10T13:30:00.000Z'],['2026-10-10T13:30:00.000Z','2026-11-09T13:30:00.000Z']]){
    // Use keyed replacements, as both original dates occur in the patch.
    const key=oldValue.startsWith('2026-09')?'validFrom':'expiresAt';
    assert.ok(patch.includes(`-  "${key}": "${oldValue}"`)&&patch.includes(`+  "${key}": "${newValue}"`));
    proposed=proposed.replace(`"${key}": "${oldValue}"`,`"${key}": "${newValue}"`);
  }
  const after=JSON.parse(proposed),start=Date.parse(after.validFrom),end=Date.parse(after.expiresAt);
  assert.equal(after.validFrom,before.expiresAt);assert.equal(end-start,30*24*3_600_000);
  for(const key of Object.keys(before).filter(k=>!['validFrom','expiresAt'].includes(k)))assert.deepEqual(after[key],before[key]);
  assert.throws(()=>validateAssociationPolicy(after,{now:start-1}),/not yet valid/);
  validateAssociationPolicy(after,{now:start,edition:'am'});assert.throws(()=>validateAssociationPolicy(after,{now:end}),/expired/);
  assert.equal(fs.readFileSync(path,'utf8'),text);
});
