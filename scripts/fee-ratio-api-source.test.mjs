// All identifiers, names, dates and amounts below are synthetic. No network,
// credential, file or real Sharesight response is used by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createApiRatioSourceCore} from './fee-ratio-api-source.mjs';
import {createOfficialRatioSourceCore} from './fee-ratio-official-source.mjs';
import {createRankedExposureCore} from './xuan-ib-sharesight-exposure.mjs';
globalThis.fetch=async()=>{throw Error('OFFLINE_TEST_NETWORK_FORBIDDEN');};

const core=createApiRatioSourceCore();
// Field names follow the public Sharesight API V3 performance example, plus the
// consolidated custom-group fields (custom_group, limited) the response adds.
function syntheticCapture(){
  const accounts=[{id:101,name:'IB-HK'},{id:102,name:'NOAH-HK'},...Array.from({length:8},(_,i)=>({id:201+i,name:'Synthetic '+i}))];
  const portfolio=a=>({id:a.id,consolidated:false,name:a.name});
  let hid=5000,cid=7000;
  const holding=(a,code,market,group,value,quantity=2)=>({id:hid++,instrument:{code,market_code:market,name:'Synthetic '+code,currency_code:'USD'},quantity,value,valid_position:true,limited:false,portfolio:portfolio(a),group_id:group.length,group_name:group,total_gain:0,total_gain_percent:0});
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
  assert.deepEqual(p.positions[0],{sourceRow:1,account:'Synthetic 0',name:'Synthetic F00',valueUSD:110,sharesightCategory:'VC/PE',securityCode:'F00',market:'PRIVATE',quantity:2});
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

test('projected rows drive the existing projection to a direct-holdings top five for all four classes',()=>{
  // Test-only envelope: it shows the projected rows are consumable unchanged by
  // the existing strict projection. It is NOT the production wiring and does
  // not claim that an API capture is an official workbook.
  const p=core.project(syntheticCapture()),sha=n=>String(n).repeat(64);
  const capture=(rows)=>({asOf:p.asOf,capturedAt:p.capturedAt,captureTimeBasis:'original-download-file-mtime',downloadCompletedAt:null,serverSuggestedOriginalFilename:null,dateEvidence:'Synthetic test envelope as at 10 Nov 2026',canonicalDataRows:rows,allWorksheetXmlRows:rows+5});
  const raw={schemaVersion:'sharesight-private-full-v2',source:{provider:'Sharesight',view:'All Together',transport:'official-workbook-exports'},accounts:p.accounts,
    sources:['classification.xlsx','exposure.xlsx','capture-metadata.json'].map((file,i)=>({file,sha256:sha(i+1),libraryFileId:'libfile_'+String(i+1).repeat(32),libraryVersion:0})),
    classification:{...capture(p.positions.length+p.cashAccounts.length),positions:p.positions,cashAccounts:p.cashAccounts},exposure:{...capture(p.rows.length),rows:p.rows},
    coverage:{classificationCombinedComplete:true,exposureCombinedComplete:true,groupingSheetsAreDuplicates:true,closedPositionsIncluded:false,transactionHistoryIncluded:false,completeETFUniverseClaimed:false},limitations:['Synthetic test envelope only.']};
  const bytes=Buffer.from(JSON.stringify(raw)),built=createOfficialRatioSourceCore().build(raw,{sourceSha256:crypto.createHash('sha256').update(bytes).digest('hex'),sourceBytes:bytes.length});
  const classes=built.input.exposure.summary.classes;
  assert.deepEqual(classes.map(g=>g.basis),['direct','direct','direct','direct']);
  // A leveraged product ranks as itself at its own value; the same security in
  // two accounts merges and keeps both; different securities stay separate.
  assert.deepEqual(classes[3].top5.map(r=>[r.securityCode,r.valueUSD,r.accounts]),[['TQQQ',130,['IB-HK']],['GOOG',47.25,['IB-HK','Synthetic 2']],['USSC',44.5,['IB-HK']],['OTHER',43,['IB-HK']],['GOOGL',42,['IB-HK']]]);
  assert.equal(built.input.exposure.summary.residualETFs.valueUSD,0);
  assert.equal(built.input.classification.totalValueUSD,p.totals.rowsCents/100);
  assert.equal(built.sourceDates.classification,built.sourceDates.exposure);
  const scope=crypto.createHash('sha256').update(JSON.stringify([...p.accounts].sort())).digest('hex');
  const view={...createRankedExposureCore(),ALL_TOGETHER_SCOPE_SHA256:scope}.buildRankedExposureView(built.input.exposure);
  assert.equal(view.groups[3].directOnly,true);assert.equal(view.residualUsd,0);
});
