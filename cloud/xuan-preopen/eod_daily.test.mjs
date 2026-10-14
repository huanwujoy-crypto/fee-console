// Only fresh synthetic XML/config/API wrappers. No prior private context/data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {runEodDailyReport} from './eod_daily.mjs';
import {runDaily} from './daily.mjs';
import {readEodSourceConfiguration,validateEodSourceConfiguration} from './eod_source_config.mjs';
import {digest,validProviderGeneratedText} from './eod_sources.mjs';
import {associationPolicyBlob} from '../../scripts/xuan-ib-account-association.mjs';
import {extractNightActionModel,renderNightActionReport} from '../../scripts/xuan-ib-night-action-view.mjs';
import {validateNightActionHtml} from '../../scripts/xuan-ib-night-action-guard.mjs';
import {classifySleepPublication,canReplaceActionPublication} from '../../scripts/xuan-ib-sleep-priority.mjs';
const now=()=>Date.parse('2026-10-09T05:00:00Z'), sourceDate='2026-10-08';
const config={configuredQueryId:'12345',baseCurrency:'USD',providerTimezone:null}, account='SYNTHETIC_ACCOUNT';
globalThis.fetch=()=>assert.fail('Offline only');
const xml=`<FlexQueryResponse><FlexStatements><FlexStatement accountId="${account}" fromDate="20261008" toDate="20261008" whenGenerated="20261009;001530"><CashReport><CashReportCurrency accountId="${account}" levelOfDetail="BaseCurrency" currency="BASE_SUMMARY" endingCash="200" endingSettledCash="180"/></CashReport><CashTransactions/><ConversionRates/></FlexStatement></FlexStatements></FlexQueryResponse>`;
function context(){const policy={schemaVersion:1,policyId:'ib-primary-7day-pilot-v1',accountAlias:'IB-HK',basis:'owner-attested-recurring-v1',status:'active',purpose:'xuan-ib-read-only-report',editions:['adhoc','am','pm'],publisher:'codex-verified-candidate-v1',validFrom:'2026-09-11T13:30:00.000Z',expiresAt:'2026-10-10T13:30:00.000Z'};return {association:{policy,policyCommit:'a'.repeat(40),policyBlob:associationPolicyBlob(policy),checkedAt:new Date(now()).toISOString()},previousSourceSha:'c'.repeat(40),reserveHash:'b'.repeat(64),reserveLedger:{schemaVersion:1,purpose:'xuan-etf-owner-declared-pending-calls',entries:[{date:'2026-10-01',usd:50}]},previousHtml:''};}
function batch(){const h=(id,group_name,value,code)=>({id,group_name,value,quantity:id,instrument:{code}});return [
  {sourceKey:'sharesight.ibGroupedPerformance',raw:{mode:'read_only',source:'Sharesight User API',data:{report:{portfolio_id:936247,currency:{code:'USD'},start_date:sourceDate,end_date:sourceDate,include_sales:false,grouping:'custom_group_category',custom_group:{id:83569,name:'资产类别'},holdings:[h(1,'美国底仓',450,'CSPX'),h(2,'美国底仓',50,'USSC'),h(3,'美国科技',250,'GOOG'),h(4,'非美发达',180,'EXUS'),h(5,'新兴市场',70,'EIMI'),h(6,'防御资产',90,'TLT')],cash_accounts:[]}}}},
  {sourceKey:'sharesight.noahPerformance',raw:{mode:'read_only',source:'Sharesight User API',data:{report:{portfolio_id:936238,currency:{code:'USD'},start_date:sourceDate,end_date:sourceDate,include_sales:false,grouping:'investment_type',cash_accounts:[{value:50}]}}}}];}
function harness(overrides={}){const objects=new Map(),calls=[];const io={
  ibStore:new Proxy({}, {get:()=>assert.fail('B never uses realtime IB/OAuth')}),
  loadFlexToken:async()=>{calls.push('flex-token');return 'SYNTHETIC_FLEX_TOKEN';},loadGatewayToken:async()=>{calls.push('gateway-token');return 'SYNTHETIC_GATEWAY_TOKEN';},
  savePrivate:async(name,value)=>{if(objects.has(name))throw Error('IMMUTABLE');objects.set(name,value);return {sha256:digest(value),generation:'1'};}};
  return {objects,calls,io,options:{sourceDate,io,now,configuration:config,expectedAccount:account,loadContext:async()=>context(),
    fetchArchive:async request=>{calls.push('flex-source');assert.deepEqual(request,{token:'SYNTHETIC_FLEX_TOKEN',configuredQueryId:'12345'});return {bytes:xml,requestedQueryId:'12345'};},
    readSharesight:async(date,token,options)=>{calls.push('sharesight-batch');assert.equal(date,sourceDate);assert.equal(token,'SYNTHETIC_GATEWAY_TOKEN');assert.equal(options.settle,true);return batch();},...overrides}};}
test('daily B completes immutable EOD delivery with one Flex fetch, one API batch and no realtime or budget invention',async()=>{
  const h=harness();const receipt=await runDaily({io:h.io,now,execution:'xuan-preopen-report-synthetic',generate:o=>runEodDailyReport({...h.options,...o})});
  const html=h.objects.get('delivery/2026-10-09/report.html'),m=extractNightActionModel(html);
  assert.equal(receipt.status,'partial');assert.equal(m.schemaVersion,9);assert.equal(m.cash.ib,200);assert.equal(m.cash.noah,50);
  assert.equal(m.orders.buys,null);assert.equal(m.orders.sells,null);assert.equal(m.cash.orderReserve,null);assert.equal(m.cash.planning,null);assert.equal(m.cash.totalCapacity,null);assert.equal(m.cash.executableBudget,null);
  assert.equal(m.sourceOutcomes[3].status,'not-called');assert.equal(m.holdings.status,'ready');assert.equal(m.holdings.ibEodPositions,'not-provided');
  assert.equal(m.holdings.total,1000);assert.equal(m.holdings.rows.length,5);assert.equal(m.holdings.concentration.top1Pct,45);assert.equal(m.holdings.concentration.top5Pct,100);
  assert.equal(h.calls.filter(c=>c==='flex-source').length,1);assert.equal(h.calls.filter(c=>c==='sharesight-batch').length,1);
  const names=[...h.objects.keys()];assert.equal(names[0],'delivery/2026-10-09/start.json');assert.equal(names.at(-1),'delivery/2026-10-09/receipt.json');
  assert.equal(validateNightActionHtml(html,'2026-10-09').orderCount,null);assert.equal(JSON.stringify(m).includes(account),false);
  for(const title of ['本轮补仓','挂单提醒','现金优先补仓参考','股票四类配置'])assert(html.includes(title));
  assert(html.includes('Sharesight 记录持仓'));assert(html.includes('本轮 Flex 未提供 IB 收盘持仓'));
  const old=structuredClone(m);delete old.holdings;assert.equal(extractNightActionModel(renderNightActionReport(old)).schemaVersion,9);
  const rich=classifySleepPublication(html).action,weak=classifySleepPublication(renderNightActionReport(old)).action;
  assert.equal(canReplaceActionPublication(weak,rich),false);assert.equal(canReplaceActionPublication(rich,weak),true);
});
test('default unapproved query blocks before any credential or financial I/O',async()=>{
  const deny=()=>assert.fail('No IO');await assert.rejects(runEodDailyReport({now,sourceDate,configuration:{...config,configuredQueryId:null},loadContext:deny,io:{savePrivate:deny,loadFlexToken:deny,loadGatewayToken:deny}}),/CONFIGURATION_REQUIRED/);
});
test('only the fixed private deployment parameter selects the approved query',async()=>{
  assert.throws(()=>validateEodSourceConfiguration(readEodSourceConfiguration({})),/CONFIGURATION_REQUIRED/);
  const configured=readEodSourceConfiguration({XUAN_PREOPEN_EOD_QUERY_ID:'12345'});
  assert.deepEqual(validateEodSourceConfiguration(configured),config);
  for(const value of ['', '0', 'bad', '12345\n', '1'.repeat(21)])
    assert.throws(()=>validateEodSourceConfiguration(readEodSourceConfiguration({XUAN_PREOPEN_EOD_QUERY_ID:value})),/CONFIGURATION_REQUIRED/);
  const h=harness({configuration:configured,fetchArchive:async request=>{
    assert.equal(request.configuredQueryId,'12345');return {bytes:xml,requestedQueryId:'12345'};
  }});
  const r=await runEodDailyReport(h.options);assert.equal(r.mode,'private_eod_action');assert.equal(r.status,'partial');
});
test('future, stale, malformed or uncompleted source dates stop before context or credentials',async()=>{
  const deny=()=>assert.fail('No context/token/source/save IO');
  for(const sourceDate of ['2026-10-09','2026-10-10','2026-10-07','2026-02-30'])
    await assert.rejects(runEodDailyReport({sourceDate,now,configuration:config,loadContext:deny,
      io:{loadFlexToken:deny,loadGatewayToken:deny,savePrivate:deny},fetchArchive:deny,readSharesight:deny}),/COMPLETED_SESSION_REQUIRED/);
});
test('wrong XML cutoff/account/query binding stops before archive or completion save',async()=>{
  for(const result of [{bytes:xml.replace('toDate="20261008"','toDate="20261007"'),requestedQueryId:'12345'},
    {bytes:xml.replaceAll(account,'OTHER'),requestedQueryId:'12345'},{bytes:xml,requestedQueryId:'99999'}]){
    const h=harness({fetchArchive:async()=>result});await assert.rejects(runEodDailyReport(h.options));assert.equal(h.objects.size,0);
  }
});
test('provider generation text must be a real local date/time without guessing its timezone',async()=>{
  for(const text of ['20260230;250099','20261009;240000','2026-10-09;12:60:00','20261009;120060']){
    assert.equal(validProviderGeneratedText(text),false);
    const h=harness({fetchArchive:async()=>({bytes:xml.replace('20261009;001530',text),requestedQueryId:'12345'})});
    await assert.rejects(runEodDailyReport(h.options),/GENERATION_TIME/);assert.equal(h.objects.size,0);
  }
  for(const text of ['20261009;235959','2026-10-09;00:00:00'])assert.equal(validProviderGeneratedText(text),true);
});
test('immutable daily marker denies a second source attempt; malformed source never writes delivery completion',async()=>{
  const h=harness();h.io.savePrivate=async()=>{throw Error('IMMUTABLE');};await assert.rejects(runDaily({io:h.io,now,execution:'xuan-preopen-report-synthetic',generate:o=>runEodDailyReport({...h.options,...o})}),/IMMUTABLE/);assert.equal(h.calls.length,0);
});
