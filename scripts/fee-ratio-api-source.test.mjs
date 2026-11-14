// All identifiers, names, dates and amounts below are synthetic. No network,
// credential, file or real Sharesight response is used by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createApiRatioSourceCore} from './fee-ratio-api-source.mjs';
import {createRatioSourceCore} from './fee-ratio-source-core.mjs';
import {createFeeRatioCore} from './fee-ratio-management.mjs';
import {createRatioSnapshotCore} from './fee-ratio-snapshot.mjs';
import {buildRatioModel} from './fee-ratio-packet.mjs';
import {createAggregateReturnsCore} from './fee-ratio-aggregate-returns.mjs';
import {createOfficialRatioSourceCore} from './fee-ratio-official-source.mjs';
import {createRankedExposureCore} from './xuan-ib-sharesight-exposure.mjs';
globalThis.fetch=async()=>{throw Error('OFFLINE_TEST_NETWORK_FORBIDDEN');};

const core=createApiRatioSourceCore();
// Field names follow the public Sharesight API V3 performance example, plus the
// consolidated custom-group fields (custom_group, limited) the response adds.
export function syntheticCapture(){
  const accounts=[{id:101,name:'IB-HK'},{id:102,name:'NOAH-HK'},...Array.from({length:8},(_,i)=>({id:201+i,name:'Synthetic '+i}))];
  const portfolio=a=>({id:a.id,consolidated:false,name:a.name});
  let hid=5000,cid=7000;
  const holding=(a,code,market,group,value,quantity=2)=>({id:hid++,instrument:{code,market_code:market,name:'Synthetic '+code,currency_code:'USD',...(market==='PRIVATE'?{}:{friendly_instrument_description_code:code==='TQQQ'?'exchange_traded_fund':'ordinary_shares'})},quantity,value,valid_position:true,limited:false,portfolio:portfolio(a),group_id:group.length,group_name:group,total_gain:0,total_gain_percent:0});
  const holdings=[];
  for(let i=0;i<3;i++)for(let j=0;j<5;j++)holdings.push(holding(accounts[i+2],'F'+i+j,'PRIVATE',['VC/PE','对冲基金','常青基金'][i],110-j));
  for(const [code,market,group,value]of [['VST','NYSE','美国底仓',40],['GOOG','NASDAQ','美国科技',41],['GOOGL','NASDAQ','非美发达',42],['OTHER','TEST','新兴市场',43],['USSC','TEST','美国底仓',44.5],['TQQQ','NASDAQ','主题投资',130]])holdings.push(holding(accounts[0],code,market,group,value));
  holdings.push(holding(accounts[4],'GOOG','NASDAQ','美国科技',6.25,null));
  const cash=a=>({id:cid++,key:cid,name:'Synthetic USD cash',source:'manual',value:6,currency:{code:'USD'},portfolio:portfolio(a)});
  const cash_accounts=[cash(accounts[0]),cash(accounts[1])];
  const value=Math.round([...holdings,...cash_accounts].reduce((n,r)=>n+r.value*100,0))/100;
  return {schema:core.CAPTURE,provider:'Sharesight',view:{id:39000,name:'Synthetic All Together'},group:{id:880,name:'Synthetic asset class'},asOf:'2026-11-10',capturedAt:'2026-11-10T09:00:00.000Z',accounts,
    report:{id:'PerformanceReport_39000',portfolio_id:39000,portfolio_tz_name:'America/New_York',value,grouping:'custom_group_category',custom_group:{id:880,name:'Synthetic asset class'},currency:{code:'USD',id:5,symbol:'$',qualified_symbol:'US$'},start_date:'2026-11-10',end_date:'2026-11-10',include_sales:false,percentages_annualised:false,holdings,sub_totals:[],cash_accounts}};
}
const refused=(edit,code)=>{const c=syntheticCapture();edit(c);assert.throws(()=>core.project(c),{message:'RATIO_API_SOURCE_'+code});};

test('one classification report projects to exact cent rows, declared accounts and a disclosed total difference',()=>{
  const c=syntheticCapture(),before=JSON.stringify(c),p=core.project(c);
  assert.equal(JSON.stringify(c),before,'the captured object is never rewritten');
  assert.equal(p.asOf,'2026-11-10');assert.equal(p.responseGrouping,'custom_group_category');
  assert.deepEqual(p.view,{id:'39000',name:'Synthetic All Together'});assert.deepEqual(p.group,{id:'880',name:'Synthetic asset class'});
  assert.equal(p.positions.length,22);assert.equal(p.cashAccounts.length,2);assert.equal(p.rows.length,24);
  assert.deepEqual(p.positions[0],{sourceRow:1,account:'Synthetic 0',name:'Synthetic F00',valueUSD:110,sharesightCategory:'VC/PE',securityCode:'F00',market:'PRIVATE',quantity:2,assetType:null});
  assert.equal(p.positions.find(x=>x.securityCode==='TQQQ').assetType,'exchange_traded_fund');assert.equal(p.positions.find(x=>x.securityCode==='VST').assetType,'ordinary_shares');
  assert.deepEqual(p.cashAccounts[0],{sourceRow:23,account:'IB-HK',name:'Synthetic USD cash',valueUSD:6,sharesightCategory:'Cash Accounts'});
  assert.equal(p.positions.at(-1).quantity,null);
  assert.deepEqual(p.rows.map(r=>r.sourceRow),Array.from({length:24},(_,i)=>i+1));
  assert.equal(p.rows.every(r=>r.withinETF===null&&['Direct','Cash'].includes(r.ownership)),true,'no look-through row is ever created');
  assert.equal(p.totals.rowsCents,p.totals.positionsCents+p.totals.cashCents);assert.equal(p.totals.reportDeltaCents,0);
  assert.deepEqual(p.accountsWithoutRows,['Synthetic 3','Synthetic 4','Synthetic 5','Synthetic 6','Synthetic 7']);
  // The provider's own total may differ from its rows; it is disclosed, not hidden or tolerated away.
  const d=syntheticCapture();d.report.value+=0.07;assert.equal(core.project(d).totals.reportDeltaCents,7);
  // The request asks for custom_group; the response may echo either spelling.
  const g=syntheticCapture();g.report.grouping='custom_group';assert.equal(core.project(g).responseGrouping,'custom_group');
  // Identifiers may arrive as digit strings.
  const s=syntheticCapture();s.report.portfolio_id='39000';s.report.custom_group.id='880';s.report.holdings[0].portfolio.id='201';assert.equal(core.project(s).positions.length,22);
});

test('every refusal names the stage that stopped it',()=>{
  refused(c=>c.schema='other','CAPTURE');refused(c=>c.extra=true,'CAPTURE');refused(c=>c.provider='Other','CAPTURE');
  refused(c=>c.asOf='2026-02-30','CAPTURE');refused(c=>c.capturedAt='2026-11-10T09:00:00Z','CAPTURE');refused(c=>c.capturedAt='2026-11-09T15:59:59.000Z','CAPTURE');
  refused(c=>c.accounts.pop(),'SCOPE');refused(c=>c.accounts[1].id=101,'SCOPE');refused(c=>c.accounts[1].name='IB-HK','SCOPE');refused(c=>c.accounts[0].id=39000,'SCOPE');
  refused(c=>c.view.id=1.5,'SCOPE');refused(c=>c.view.id='039000','SCOPE');refused(c=>c.report.portfolio_id=39001,'SCOPE');
  refused(c=>c.report=null,'REPORT');refused(c=>delete c.report.sub_totals,'REPORT');refused(c=>c.report.value=1.234,'REPORT');
  refused(c=>c.report.start_date='2026-11-09','DATES');refused(c=>c.report.end_date='2026-11-11','DATES');refused(c=>c.report.include_sales=true,'DATES');
  refused(c=>c.report.grouping='market','GROUP');refused(c=>c.report.custom_group.id=881,'GROUP');refused(c=>c.report.custom_group.name='Other group','GROUP');refused(c=>delete c.report.custom_group,'GROUP');
  refused(c=>c.report.currency.code='NZD','CURRENCY');
  refused(c=>c.report.holdings[1].id=c.report.holdings[0].id,'HOLDING');refused(c=>c.report.holdings[0].instrument.code='','HOLDING');refused(c=>c.report.holdings[0].group_name=' padded','HOLDING');refused(c=>c.report.holdings[0].quantity=-1,'HOLDING');refused(c=>delete c.report.holdings[0].instrument,'HOLDING');
  refused(c=>c.report.holdings[0].limited=true,'HOLDING_LIMITED');refused(c=>delete c.report.holdings[0].limited,'HOLDING_LIMITED');
  refused(c=>c.report.holdings[0].valid_position=false,'HOLDING_POSITION');
  refused(c=>c.report.holdings[0].portfolio.id=999,'HOLDING_ACCOUNT');refused(c=>c.report.holdings[0].portfolio.name='IB-HK','HOLDING_ACCOUNT');refused(c=>c.report.holdings[0].portfolio.consolidated=true,'HOLDING_ACCOUNT');
  refused(c=>c.report.holdings[0].value=-1,'HOLDING_VALUE');refused(c=>c.report.holdings[0].value=1.005,'HOLDING_VALUE');refused(c=>c.report.holdings[0].value=null,'HOLDING_VALUE');refused(c=>c.report.holdings[0].value='110','HOLDING_VALUE');refused(c=>c.report.holdings[0].value=Infinity,'HOLDING_VALUE');
  refused(c=>{const h=structuredClone(c.report.holdings[15]);h.id=9999;c.report.holdings.push(h);},'HOLDING_DUPLICATE');
  refused(c=>c.report.cash_accounts[1].id=c.report.cash_accounts[0].id,'CASH');refused(c=>c.report.cash_accounts[0].name='','CASH');
  refused(c=>c.report.cash_accounts[0].portfolio.id=999,'CASH_ACCOUNT');
  refused(c=>c.report.cash_accounts[0].value=-0.01,'CASH_VALUE');refused(c=>c.report.cash_accounts[0].value=NaN,'CASH_VALUE');
  refused(c=>{const x=structuredClone(c.report.cash_accounts[0]);x.id=9998;c.report.cash_accounts.push(x);},'CASH_DUPLICATE');
  assert.deepEqual([...core.CODES].sort(),[...new Set(core.CODES)].sort());
});

// ---- the API source as its own signed kind, end to end on synthetic data ----
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const NOW=new Date('2026-11-10T10:00:00.000Z');
function apiOriginal(edit=()=>{}){
  const capture=syntheticCapture();capture.view.name='All Together';edit(capture);
  const p=core.project(capture),raw=core.toRaw(p,{reportSha256:'7'.repeat(64)}),bytes=Buffer.from(JSON.stringify(raw));
  const built=createOfficialRatioSourceCore().build(raw,{sourceSha256:sha(bytes),sourceBytes:bytes.length});
  const scope=sha(JSON.stringify([...raw.accounts].sort())),exposure={...createRankedExposureCore(),ALL_TOGETHER_SCOPE_SHA256:scope};
  return {p,raw,bytes,built,scope,exposure,ratio:createFeeRatioCore(exposure,crypto.webcrypto),source:createRatioSourceCore(()=>scope)};
}
async function apiSnapshot(){
  const f=apiOriginal(),facts=f.source.verifyBrowserSourceAssociations(f.raw,f.built.input,{scopeHash:f.scope,now:NOW});
  const manager=await f.ratio.deriveSnapshotManager('0'.repeat(32),Buffer.alloc(32,7).toString('base64url'),'synthetic-manager-token-not-real-123');
  const model=await buildRatioModel(f.built.input,{kind:'snapshot',targetDate:f.built.input.exposure.summary.asOf,feeAccountingThrough:null,now:NOW,viewCore:f.ratio,previewOnly:true});
  model.book.browserEvidence={...model.book.browserEvidence,integrity:'verified-original-api-association',associationId:'c'.repeat(64),managerScopeId:manager.recipient.scopeId,migrationPending:false,classificationDeltaCents:0,exposureDeltaCents:0};
  model.sourceDates=facts.sourceDates;model.classificationSummary=facts.classificationSummary;
  const inputBytes=Buffer.from(JSON.stringify(f.built.input)),snapshot=createRatioSnapshotCore(f.ratio,f.exposure,createRatioSourceCore,b=>JSON.parse(Buffer.from(b)),crypto.webcrypto);
  const args={originalBytes:new Uint8Array(f.bytes),inputBytes:new Uint8Array(inputBytes),model,recipient:manager.recipient,sourceSha256:sha(f.bytes),inputSha256:sha(inputBytes),now:NOW};
  const original=await snapshot.verifyOriginal(args),packet=await snapshot.candidate({model,recipient:manager.recipient,proof:original,now:NOW}),signed=await snapshot.authenticate(packet,original,manager,{profileSha256:'a'.repeat(64),now:NOW});
  return {...f,facts,manager,model,snapshot,args,signed};
}

test('only the provider\'s own asset type removes a holding from the secondary ranking',()=>{
  const top=edit=>apiOriginal(edit).built.input.exposure.summary.classes[3].top5.map(r=>r.securityCode);
  const type=(c,code,value)=>{for(const h of c.report.holdings)if(h.instrument.code===code){if(value===undefined)delete h.instrument.friendly_instrument_description_code;else h.instrument.friendly_instrument_description_code=value;}};
  assert.deepEqual(top(),['GOOG','USSC','OTHER','GOOGL','VST']);
  // Every spelling the fee report already treats as an ETF, in any letter case.
  for(const spelling of ['exchange_traded_fund','exchange_traded_funds','etf','ETF','Exchange_Traded_Fund'])assert.deepEqual(top(c=>type(c,'TQQQ',spelling)),['GOOG','USSC','OTHER','GOOGL','VST'],spelling);
  // Anything else still ranks: an ordinary share, another fund type, an unknown or a missing type. Never a name or a code.
  for(const other of ['ordinary_shares','managed_fund','bond','something_new',undefined,'','x'.repeat(129)])assert.deepEqual(top(c=>type(c,'TQQQ',other)),['TQQQ','GOOG','USSC','OTHER','GOOGL'],String(other).slice(0,20));
  assert.deepEqual(top(c=>{type(c,'TQQQ','ordinary_shares');c.report.holdings.find(h=>h.instrument.code==='TQQQ').instrument.name='Synthetic ETF UCITS ETF';}),['TQQQ','GOOG','USSC','OTHER','GOOGL']);
  // The other three classes are never filtered by type.
  assert.equal(apiOriginal(c=>type(c,'F00','etf')).built.input.exposure.summary.classes[0].top5[0].securityCode,'F00');
  // Fail closed rather than publish a wrong or short list: fewer than five non-ETF securities, or a report in which
  // no secondary position carries any type at all (the type field is missing, so nothing could be told apart).
  assert.throws(()=>apiOriginal(c=>type(c,'GOOG','etf')),{message:'RATIO_OFFICIAL_SOURCE_REFUSED'});
  assert.throws(()=>apiOriginal(c=>{for(const h of c.report.holdings)delete h.instrument.friendly_instrument_description_code;}),{message:'RATIO_OFFICIAL_SOURCE_REFUSED'});
  // An earlier API original, written before the type was kept, is still rebuilt exactly as it was published.
  const old=apiOriginal(),raw=structuredClone(old.raw);for(const r of raw.classification.positions)delete r.assetType;
  const bytes=Buffer.from(JSON.stringify(raw)),rebuilt=createOfficialRatioSourceCore().build(raw,{sourceSha256:sha(bytes),sourceBytes:bytes.length});
  assert.deepEqual(rebuilt.input.exposure.summary.classes[3].top5.map(r=>r.securityCode),['TQQQ','GOOG','USSC','OTHER','GOOGL']);
  // A mixed original (some positions typed, some not) and a non-string type are refused.
  const mixed=structuredClone(old.raw);delete mixed.classification.positions[0].assetType;assert.throws(()=>createOfficialRatioSourceCore().build(mixed,{sourceSha256:'1'.repeat(64),sourceBytes:10}),{message:'RATIO_OFFICIAL_SOURCE_REFUSED'});
  const bad=structuredClone(old.raw);bad.classification.positions[0].assetType=7;assert.throws(()=>createOfficialRatioSourceCore().build(bad,{sourceSha256:'1'.repeat(64),sourceBytes:10}),{message:'RATIO_OFFICIAL_SOURCE_REFUSED'});
});
test('an API original projects to a direct top five for all four classes and names itself as an API source everywhere',()=>{
  const f=apiOriginal(),input=f.built.input,s=input.exposure.summary;
  assert.equal(f.raw.schemaVersion,'sharesight-api-full-v1');assert.equal(f.raw.source.transport,'official-api');assert.equal(Object.hasOwn(f.raw,'exposure'),false);
  assert.deepEqual(s.classes.map(g=>g.basis),['direct','direct','direct','direct']);
  // The secondary ranking never lists an ETF, however large: the largest holding here is one. The same security in
  // two accounts merges; different securities stay separate.
  assert.deepEqual(s.classes[3].top5.map(r=>[r.securityCode,r.valueUSD,r.accounts]),[['GOOG',47.25,['IB-HK','Synthetic 2']],['USSC',44.5,['IB-HK']],['OTHER',43,['IB-HK']],['GOOGL',42,['IB-HK']],['VST',40,['IB-HK']]]);
  // The ETF is only left out of the ranking: it still counts in the class total and in the classification.
  assert.equal(s.classes[3].totalValueUSD,(13000+4725+4450+4300+4200+4000+1200)/100);
  assert.equal(f.raw.classification.positions.find(x=>x.securityCode==='TQQQ').assetType,'exchange_traded_fund');
  assert.equal(s.residualETFs.valueUSD,0);assert.equal(s.sourceReportSHA256,'7'.repeat(64));assert.equal(Object.hasOwn(s,'sourceXlsxSHA256'),false);
  assert.deepEqual([s.source.report,s.source.groupBy,s.source.show],['API V3 Performance','Custom group','All holdings']);assert.equal(input.exposure.retrievedAtBasis,'Sharesight API 响应接收时间');
  const p=input.book.provenance;
  assert.deepEqual([p.transport,p.observedAtBasis,p.reportTotalDeltaCents],['official-api','api-response-received',f.p.totals.reportDeltaCents]);
  for(const k of ['exposureCapturedAt','downloadCompletedAt'])assert.equal(Object.hasOwn(p,k),false,k);
  assert.equal(input.book.ib.holdings.every(h=>h.valueBasis==='api-report-value'),true);
  assert.equal(input.classification.totalValueUSD,f.p.totals.rowsCents/100);
  const view=f.exposure.buildRankedExposureView(input.exposure);
  assert.equal(view.groups[3].directOnly,true);assert.equal(view.sourceReportSha256,'7'.repeat(64));assert.equal(Object.hasOwn(view,'sourceXlsxSha256'),false);
  assert.doesNotMatch(JSON.stringify(input),/workbook|xlsx|mtime|libfile|Tools Exposure|preserved-browser-source/i);
});

test('the API original is rebuilt exactly; edits, the wrong basis, a large total difference, staleness and workbook labels are refused',()=>{
  const f=apiOriginal(),ok=()=>f.source.verifyBrowserSourceAssociations(f.raw,f.built.input,{scopeHash:f.scope,now:NOW});
  const facts=ok();assert.equal(Object.hasOwn(facts,'companyExposure'),false);assert.deepEqual(facts.sourceDates,{classification:'2026-11-10',exposure:'2026-11-10'});
  for(const mutate of [i=>i.classification.totalValueUSD++,i=>i.exposure.summary.classes[3].top5[0].valueUSD--,i=>i.book.provenance.transport='official-workbooks',i=>i.exposure.summary.source.report='Tools Exposure',i=>i.book.provenance.reportTotalDeltaCents++,i=>i.book.ib.holdings[0].valueBasis='preserved-browser-source']){
    const input=structuredClone(f.built.input);mutate(input);assert.throws(()=>f.source.verifyBrowserSourceAssociations(f.raw,input,{scopeHash:f.scope,now:NOW}));
  }
  assert.throws(()=>f.source.verifyBrowserSourceAssociations(f.raw,f.built.input,{scopeHash:'0'.repeat(64),now:NOW}));
  for(const at of ['2026-11-10T08:59:59.000Z','2026-11-11T21:00:01.000Z','2026-11-15T16:00:00.000Z'])assert.throws(()=>f.source.verifyBrowserSourceAssociations(f.raw,f.built.input,{scopeHash:f.scope,now:new Date(at)}),undefined,at);
  const official=createOfficialRatioSourceCore(),build=(raw,options={})=>{const b=Buffer.from(JSON.stringify(raw));return official.build(raw,{sourceSha256:sha(b),sourceBytes:b.length,...options});};
  assert.throws(()=>build(f.raw,{directSecondary:false}),/RATIO_OFFICIAL_SOURCE_REFUSED/);
  for(const edit of [r=>r.source.transport='official-workbook-exports',r=>r.classification.captureTimeBasis='original-download-file-mtime',r=>r.classification.reportTotalDeltaCents=101,r=>r.classification.reportTotalDeltaCents=.5,r=>r.sources.push({...r.sources[0]}),r=>r.sources[0].route='other',r=>r.coverage.etfLookThroughIncluded=true,r=>r.exposure={rows:[]},r=>r.classification.asOf='2026-11-11',r=>r.classification.positions[0].valueUSD=-1,r=>r.accounts.pop()]){
    const raw=structuredClone(f.raw);edit(raw);assert.throws(()=>build(raw),/RATIO_OFFICIAL_SOURCE_REFUSED/);
  }
  // An API summary cannot be passed off as, or mixed with, a workbook summary.
  for(const edit of [e=>{e.summary.sourceXlsxSHA256=e.summary.sourceReportSHA256;},e=>{e.summary.source.report='Tools Exposure';},e=>{e.retrievedAtBasis='原始官方导出文件mtime（非独立下载完成时间）';},e=>{e.summary.residualETFs={valueUSD:1,weightTotalPct:1/e.summary.totalValueUSD*100,weightSecondaryClassPct:1/e.summary.classes[3].totalValueUSD*100};},e=>{e.summary.classes[3].basis='Exposure individual security direct plus ETF look-through, includes cash in class denominator';}]){
    const e=structuredClone(f.built.input.exposure);edit(e);assert.throws(()=>f.exposure.buildRankedExposureView(e));
  }
  assert.throws(()=>core.toRaw({...f.p,view:{id:'1',name:'Other view'}},{reportSha256:'7'.repeat(64)}),{message:'RATIO_API_SOURCE_SCOPE'});
  assert.throws(()=>core.toRaw(f.p,{reportSha256:'short'}),{message:'RATIO_API_SOURCE_SCOPE'});
});

test('an API source signs as its own kind without a Library version, renders API wording only, and cannot be relabelled either way',async()=>{
  const f=await apiSnapshot(),result=await f.snapshot.verify(f.signed,f.manager,{now:NOW});
  assert.equal(result.source.kind,'complete-official-api-association');assert.equal(Object.hasOwn(result.source,'libraryVersion'),false);
  assert.deepEqual(result.source.sourceDates,{classification:'2026-11-10',exposure:'2026-11-10'});assert.equal(Object.hasOwn(result.model,'companyExposure'),false);
  const html=f.ratio.render(result.model);
  for(const text of ['来源：Sharesight 官方 API（合并视图 All Together 分类报表）','API 响应逐行投影、账户范围与响应字节哈希已核验。','API 响应接收 2026-11-10T09:00:00.000Z','报表总额与逐行合计相差 0.00 USD','时间依据 Sharesight API 响应接收时间','持仓来源截至 2026-11-10','资产分类与持仓均截至 2026-11-10，取自同一份 API 报表','二级市场 · 直接持仓前五','不做ETF穿透，ETF按其自身市值列示'])assert.ok(html.includes(text),text);
  assert.doesNotMatch(html,/工作簿|mtime|Library|浏览器快照|Exposure 估值|ETF Residual|Top500|公司经济敞口|undefined/);
  // Signing refuses a Library version on an API original, and any relabelling of the kind or the sealed model.
  await assert.rejects(f.snapshot.verifyOriginal({...f.args,libraryVersion:0}),/RATIO_SNAPSHOT_REFUSED/);
  const library=structuredClone(f.model);library.book.browserEvidence.integrity='verified-original-library-association';library.book.browserEvidence.sourceVersion=0;
  await assert.rejects(f.ratio.validateModel(library));
  const company=structuredClone(f.model);company.companyExposure={};await assert.rejects(f.ratio.validateModel(company));
  for(const edit of [b=>{b.source.kind='complete-official-workbook-association';},b=>{b.source.kind='complete-official-workbook-association';b.source.libraryVersion=0;},b=>{b.source.libraryVersion=0;},b=>{delete b.source.datePolicy;}]){
    const packet=structuredClone(f.signed);edit(packet.body);await assert.rejects(f.snapshot.verify(packet,f.manager,{now:NOW}),/RATIO_SNAPSHOT_REFUSED/);
  }
  const stale=await f.snapshot.verify(f.signed,f.manager,{now:new Date('2026-11-12T00:00:00.000Z')});assert.equal(stale.stale,true);
});

// ---- API performance beside an API allocation, in one original ----
const REPORT_ID=n=>'apireport_'+String(n).repeat(32);
function apiPerformance(accounts,edit=()=>{}){
  const member=(securityCode,market)=>({account:'IB-HK',market,securityCode});
  const stock=[member('VST','NYSE'),member('USSC','TEST')],tech=[member('GOOG','NASDAQ')];
  const row=(name,members,n,returnPct,unit)=>({scope:{type:'classification',name,parent:null},members,sourceSheet:'sub_totals',sourceRow:n,returnPct,unit,termEvidence:{type:'unknown'}});
  const report=(period,startDate,n,unit)=>({period,startDate,endDate:'2026-11-10',includeClosed:true,calculationMethod:'sharesight-native',currency:'USD',cashPerformance:'unknown',
    source:{apiReportId:REPORT_ID(n),sha256:String(n).repeat(64),locator:'report.sub_totals'},rows:[row('美国底仓',stock,1,7.25,unit),row('美国科技',tech,2,-3.5,unit)],unavailable:[{scope:{type:'portfolio',name:'All Together',parent:null},reason:'native-aggregate-not-provided'}]});
  const dated=(m,startDate,dateKind,n)=>({...m,startDate,dateKind,sourceFileId:REPORT_ID(3),sourceLocator:'holdings['+n+'].inception_date'});
  const performance={schema:'fee-console.ratio-performance-source.v2',provider:'Sharesight',transport:'official-api',currency:'USD',asOf:'2026-11-10',accounts:[...accounts],
    reports:[report('all','2018-01-01',1,'p.a.'),report('oneYear','2025-11-10',2,'period')],
    inceptionEvidence:{schema:'fee-console.ratio-inception-source.v2',capturedAt:'2026-11-10T09:01:00.000Z',includeClosed:true,sources:[{apiReportId:REPORT_ID(3),sha256:'3'.repeat(64),locator:'member holdings listings'}],
      sourceCaptures:[{apiReportId:REPORT_ID(3),capturedAt:'2026-11-10T09:01:00.000Z',sourceKind:'sharesight-api-holdings'}],
      members:[dated(stock[0],'2019-03-04','holding-opening-balance',1),dated(stock[1],'2020-06-01','holding-inception',2),dated(tech[0],'2021-02-03','holding-inception',3)]}};
  edit(performance);return performance;
}
function apiWrapped(edit){
  const a=apiOriginal(),performance=apiPerformance(a.raw.accounts,edit);
  const raw={schemaVersion:'sharesight-private-performance-v1',accounts:[...a.raw.accounts],allocation:a.raw,performance,performanceCapturedAt:'2026-11-10T09:02:00.000Z'},bytes=Buffer.from(JSON.stringify(raw));
  const allocation=createOfficialRatioSourceCore().build(a.raw,{sourceSha256:sha(bytes),sourceBytes:bytes.length}).input;
  return {...a,raw,bytes,performance,input:{...allocation,schema:'fee-console.ratio-sources.v3',performance:structuredClone(performance)}};
}
test('API performance is carried only beside an API allocation; refs, locators and first-buy kinds are API ones and an opening-balance start is flagged',()=>{
  const f=apiWrapped(),facts=f.source.verifyBrowserSourceAssociations(f.raw,f.input,{scopeHash:f.scope,now:NOW});
  assert.deepEqual(facts.sourceDates,{classification:'2026-11-10',exposure:'2026-11-10',performance:'2026-11-10'});assert.equal(Object.hasOwn(facts,'companyExposure'),false);
  const view=createAggregateReturnsCore().build(f.performance,{expectedAccounts:f.raw.accounts,expectedAsOf:'2026-11-10'}),item=name=>view.items.find(i=>i.scope.name===name).periods;
  // The earliest member of this class began as an opening balance: that recorded date is used and marked.
  assert.deepEqual([item('美国底仓').all.investmentStartDate,item('美国底仓').all.investmentStartBasis,item('美国底仓').all.status,item('美国底仓').oneYear.status],['2019-03-04','opening-balance-record','annualised','period-return']);
  assert.deepEqual([item('美国科技').all.investmentStartDate,Object.hasOwn(item('美国科技').all,'investmentStartBasis')],['2021-02-03',false]);
  assert.deepEqual(item('美国底仓').all.source,{apiReportId:REPORT_ID(1),sha256:'1'.repeat(64),locator:'sub_totals[1].total_gain_percent'});
  assert.doesNotMatch(JSON.stringify(view),/libfile_|!O|!N|browser-first-recorded-buy|workbook/i);
  // The start-date line says when its start is an opening-balance record, and only then.
  const returns=createAggregateReturnsCore(),line=name=>returns.renderInline(returns.select(view,{type:'classification',name,parent:null}));
  assert.match(line('美国底仓'),/2019-03-04 至 2026-11-10（起点为 Sharesight 期初余额记录日，可能晚于实际买入）/);assert.match(line('美国科技'),/2021-02-03 至 2026-11-10(?!（起点)/);
  // Neither kind passes as the other, in whole or in part.
  const build=p=>createAggregateReturnsCore().build(p,{expectedAccounts:f.raw.accounts,expectedAsOf:'2026-11-10'});
  for(const edit of [p=>{delete p.transport;},p=>{p.transport='official-workbooks';},p=>{p.reports[0].source={libraryFileId:'libfile_'+'1'.repeat(32),version:0,sha256:'1'.repeat(64),locator:'x'};},p=>{p.inceptionEvidence.sourceCaptures[0].sourceKind='browser-first-recorded-buy';},p=>{p.inceptionEvidence.sourceCaptures[0].sourceKind='verified-historical-archive';},p=>{p.inceptionEvidence.schema='fee-console.ratio-inception-source.v1';delete p.inceptionEvidence.sourceCaptures;},p=>{p.inceptionEvidence.members[0].dateKind='browser-first-recorded-buy';},p=>{p.inceptionEvidence.members[0].startDate='2017-12-31';},p=>{p.inceptionEvidence.members.pop();}])
    {const p=apiPerformance(f.raw.accounts,edit);assert.throws(()=>build(p),/RATIO_PERFORMANCE_REFUSED/);}
  // A workbook performance source may not use the API-only opening-balance kind.
  const workbook=apiPerformance(f.raw.accounts,p=>{delete p.transport;for(const r of p.reports)r.source={libraryFileId:'libfile_'+r.source.apiReportId.slice(-32),version:0,sha256:r.source.sha256,locator:'Native Total cells'};delete p.inceptionEvidence;});
  assert.equal(build(workbook).items.length,3);
  // Mixed originals are refused by the association check in both directions.
  const mixed=apiWrapped();mixed.raw.performance=workbook;mixed.input.performance=structuredClone(workbook);
  assert.throws(()=>mixed.source.verifyBrowserSourceAssociations(mixed.raw,mixed.input,{scopeHash:mixed.scope,now:NOW}),/RATIO_BROWSER_EVIDENCE_REFUSED/);
  const edited=structuredClone(f.input);edited.performance.reports[0].rows[0].returnPct=8;
  assert.throws(()=>f.source.verifyBrowserSourceAssociations(f.raw,edited,{scopeHash:f.scope,now:NOW}));
});

test('an API original with performance signs as the API kind and its signed dates include performance',async()=>{
  const f=apiWrapped(),facts=f.source.verifyBrowserSourceAssociations(f.raw,f.input,{scopeHash:f.scope,now:NOW});
  const manager=await f.ratio.deriveSnapshotManager('0'.repeat(32),Buffer.alloc(32,7).toString('base64url'),'synthetic-manager-token-not-real-123');
  const model=await buildRatioModel(f.input,{kind:'snapshot',targetDate:f.input.exposure.summary.asOf,feeAccountingThrough:null,now:NOW,viewCore:f.ratio,previewOnly:true});
  model.book.browserEvidence={...model.book.browserEvidence,integrity:'verified-original-api-association',associationId:'c'.repeat(64),managerScopeId:manager.recipient.scopeId,migrationPending:false,classificationDeltaCents:0,exposureDeltaCents:0};
  model.sourceDates=facts.sourceDates;model.classificationSummary=facts.classificationSummary;model.performance=facts.performance;
  const inputBytes=Buffer.from(JSON.stringify(f.input)),snapshot=createRatioSnapshotCore(f.ratio,f.exposure,createRatioSourceCore,b=>JSON.parse(Buffer.from(b)),crypto.webcrypto);
  const args={originalBytes:new Uint8Array(f.bytes),inputBytes:new Uint8Array(inputBytes),model,recipient:manager.recipient,sourceSha256:sha(f.bytes),inputSha256:sha(inputBytes),now:NOW};
  const original=await snapshot.verifyOriginal(args),signed=await snapshot.authenticate(await snapshot.candidate({model,recipient:manager.recipient,proof:original,now:NOW}),original,manager,{profileSha256:'a'.repeat(64),now:NOW});
  const result=await snapshot.verify(signed,manager,{now:NOW});
  assert.equal(result.source.kind,'complete-official-api-association');assert.deepEqual(result.source.sourceDates,{classification:'2026-11-10',exposure:'2026-11-10',performance:'2026-11-10'});
  assert.equal(result.model.performance.transport,'official-api');
  const html=f.ratio.render(result.model);assert.match(html,/来源：Sharesight 官方 API/);assert.doesNotMatch(html,/工作簿|mtime|Library|undefined/);
  await assert.rejects(snapshot.verifyOriginal({...args,libraryVersion:0}),/RATIO_SNAPSHOT_REFUSED/);
  // The sealed model cannot pair an API book with workbook-labelled performance.
  const relabelled=structuredClone(model);delete relabelled.performance.transport;await assert.rejects(f.ratio.validateModel(relabelled));
});
