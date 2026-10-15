// SYNTHETIC OFFLINE end-to-end private four-card acceptance. No real source IO.
import test from 'node:test';import assert from 'node:assert/strict';
import {composePrivateActionPreview,validatePreviewOrdersBundle} from './action_preview.mjs';
import {runPrivateEodReport} from './eod_report.mjs';
import {createEodSnapshotReader} from './eod_adapters.mjs';
import {digest} from './eod_sources.mjs';
import {fingerprint} from '../../scripts/xuan-ib-run-manifest.mjs';
import {associationPolicyBlob} from '../../scripts/xuan-ib-account-association.mjs';
import {extractNightActionModel,renderNightActionReport} from '../../scripts/xuan-ib-night-action-view.mjs';
import {validateNightActionHtml} from '../../scripts/xuan-ib-night-action-guard.mjs';
import {sharesightOrderCurrencies,readCurrentActionFields,ACTION_ERROR_CODES} from '../../scripts/xuan-ib-action-fields.mjs';
const NOW=Date.parse('2026-10-15T05:01:00.000Z'),sourceDate='2026-10-14';
const start='2026-10-15T05:00:00.000Z',end='2026-10-15T05:00:02.000Z';
globalThis.fetch=()=>assert.fail('Offline only');
function context(){const policy={schemaVersion:1,policyId:'ib-primary-7day-pilot-v1',accountAlias:'IB-HK',basis:'owner-attested-recurring-v1',status:'active',purpose:'xuan-ib-read-only-report',editions:['adhoc','am','pm'],publisher:'codex-verified-candidate-v1',validFrom:'2026-10-10T00:00:00.000Z',expiresAt:'2026-10-20T00:00:00.000Z'};return {association:{policy,policyCommit:'a'.repeat(40),policyBlob:associationPolicyBlob(policy),checkedAt:new Date(NOW).toISOString()},previousSourceSha:'b'.repeat(40),previousHtml:'',reserveLedger:{schemaVersion:1,purpose:'xuan-etf-owner-declared-pending-calls',entries:[{date:'2026-09-17',usd:100}]}};}
const order=(side='BUY')=>({order_id:side==='BUY'?1:2,order_status:'NEW',order_type:'LIMIT',side,limit_price:'10',total_shares_qty:'10',cum_shares_qty:'4',remaining_shares_qty:'6',primary_description:`${side==='BUY'?'Buy':'Sell'} 10 EXUS`,secondary_description:'Synthetic instrument',order_time:'2026-10-14T14:00:00Z'});
function bundle(raw={orders:[order(),order('SELL')],complete:true}){
  const c=context(),source={sourceKey:'ib.orders',raw,rawFingerprint:fingerprint(raw),startedAt:start,completedAt:end,accountEvidence:{associationBasis:'owner-attested',responseAccountEvidence:'not-provided',nativeIdentityEvidence:'not-provided'}};
  const name='report-check/orders-probe-11111111-2222-4333-8444-555555555555/orders.json',object={name,generation:'1',sha256:digest(source)};
  const receipt={schemaVersion:1,mode:'cloud-orders-probe',status:'passed',requestId:'11111111-2222-4333-8444-555555555555',dataDate:'2026-10-15',execution:'xuan-preopen-orders-probe-synthetic',startedAt:start,completedAt:end,upstreamAttempted:true,ordersCalls:1,refreshCalls:0,credentialPersistence:'not-needed',association:{policyBlob:c.association.policyBlob,accountAlias:'IB-HK'},associationBasis:'owner-attested',responseAccountEvidence:'not-provided',nativeIdentityEvidence:'not-provided',artifact:{privateObject:name,generation:'1',sha256:object.sha256}};
  return {receipt,source,object,receiptSha256:digest(receipt)};
}
function batch(){const h=(id,group_name,value,code)=>({id,group_name,value,quantity:10,instrument:{code,currency:{code:'USD'}}});return [
  {sourceKey:'sharesight.ibGroupedPerformance',raw:{mode:'read_only',source:'Sharesight User API',data:{report:{portfolio_id:936247,currency:{code:'USD'},start_date:sourceDate,end_date:sourceDate,include_sales:false,grouping:'custom_group_category',custom_group:{id:83569,name:'资产类别'},holdings:[h(1,'美国底仓',450,'CSPX'),h(2,'美国底仓',50,'USSC'),h(3,'美国科技',250,'GOOG'),h(4,'非美发达',180,'EXUS'),h(5,'新兴市场',70,'EIMI'),h(6,'防御资产',90,'TLT')],cash_accounts:[{value:1000}]}}}},
  {sourceKey:'sharesight.noahPerformance',raw:{mode:'read_only',source:'Sharesight User API',data:{report:{portfolio_id:936238,currency:{code:'USD'},start_date:sourceDate,end_date:sourceDate,include_sales:false,grouping:'investment_type',cash_accounts:[{value:200}]}}}}];}
async function run({raw,editBatch=()=>{},ledger=context().reserveLedger,now=()=>NOW,gatewayFailure=false}={}){
  const objects=new Map(),calls=[],c=context();c.reserveLedger=ledger;
  const io={savePrivate:async(name,value)=>{assert.equal(objects.has(name),false);objects.set(name,value);return {sha256:digest(value),generation:'1'};},loadGatewayToken:async()=>{calls.push('gateway-token');if(gatewayFailure)throw Error('SYNTHETIC_PRIVATE_ERROR');return 'SYNTHETIC_GATEWAY';},ibStore:new Proxy({}, {get:()=>assert.fail('Never contact IB or refresh again')}),loadFlexToken:()=>assert.fail('Never read Flex')};
  const receipt=await composePrivateActionPreview({bundle:bundle(raw),sourceDate,io,now,loadContext:async()=>c,readSharesight:async(date,token,opts)=>{calls.push('sharesight-batch');assert.equal(date,sourceDate);assert.equal(token,'SYNTHETIC_GATEWAY');assert.equal(opts.settle,true);const b=batch();editBatch(b);return b;}});
  const html=objects.get(receipt.artifact.privateObject),model=extractNightActionModel(html);return {receipt,model,html,objects,calls};
}
export {run as buildSyntheticPreviewFixture};
test('private four cards use Sharesight cash/holdings, persistent CALL and only remaining BUY quantity',async()=>{
  const r=await run(),m=r.model;
  assert.equal(m.cash.ib,1000);assert.equal(m.cash.noah,200);assert.equal(m.cash.reserve,100);assert.equal(m.cash.call.status,'owner-declared');
  assert.equal(m.cash.orderReserve,60);assert.equal(m.cash.planning,1090);assert.equal(m.cash.planningBasis.status,'reference');assert.equal(m.cash.executableBudget,null);
  assert.equal(m.holdings.status,'ready');assert.equal(m.orders.status,'ready');assert.equal(m.orders.buys[0].quantity,'6');assert.equal(m.orders.sells.length,1);
  assert.equal(m.sourceOutcomes[0].status,'not-called');assert.equal(m.reconciliation.status,'unknown');assert.deepEqual(r.calls,['gateway-token','sharesight-batch']);
  assert.equal(r.receipt.startedAt,start);assert.equal(validateNightActionHtml(r.html,'2026-10-15').orderCount,2);
  for(const title of ['本轮补仓','挂单提醒','现金优先补仓参考','股票四类配置','Sharesight IB-HK','持续沿用用户声明'])assert.ok(r.html.includes(title));
  assert.ok(!r.html.includes('EOD 现金对账尚未核实，补仓预算未计算'));assert.ok(!r.html.includes('setInterval(check'));
});
test('missing/unknown NOAH affects its cash and dependent budget only; it is never silently zero',async()=>{
  for(const editBatch of [b=>b[1]={sourceKey:'sharesight.noahPerformance',status:'request-failure'},b=>b[1].raw.data.report.cash_accounts=[]]){
    const {model:m}=await run({editBatch});assert.equal(m.cash.noah,null);assert.equal(m.cash.planning,null);assert.equal(m.cash.ib,1000);assert.equal(m.holdings.status,'ready');assert.equal(m.orders.status,'ready');
  }
});
test('missing CALL preserves sourced facts while blocking only dependent budget',async()=>{
  const r=await run({ledger:null});assert.equal(r.model.cash.reserve,null);assert.equal(r.model.cash.planning,null);assert.equal(r.model.orders.status,'ready');assert.equal(r.model.cash.ib,1000);assert.ok(r.html.includes('待 CALL 原额</b><span>未取得'));
});
test('partial order coverage retains rows but cannot claim complete reserve or budget',async()=>{
  const r=await run({raw:{orders:[order()]}});assert.equal(r.model.orders.status,'partial');assert.equal(r.model.orders.buys.length,1);assert.equal(r.model.cash.orderReserve,null);assert.equal(r.model.cash.planning,null);assert.equal(r.model.allocation.projectedTotal,null);assert.ok(r.html.includes('全部覆盖未核实'));
  const empty=await run({raw:{orders:[]}});assert.equal(empty.model.orders.status,'partial');assert.equal(empty.model.cash.orderReserve,null);assert.ok(empty.html.includes('本轮未见 · 覆盖未核实'));assert.ok(!empty.html.includes('class="empty">无'));
});
test('unknown instrument currency or nonUSD reserve never becomes a partial complete USD total',async()=>{
  for(const editBatch of [b=>delete b[0].raw.data.report.holdings[3].instrument.currency,b=>b[0].raw.data.report.holdings[3].instrument.currency.code='CAD']){
    const {model:m}=await run({editBatch});assert.equal(m.orders.buys.length,1);assert.equal(m.cash.orderReserve,null);assert.equal(m.cash.planning,null);assert.equal(m.cash.ib,1000);
  }
});
test('wrong date/portfolio is isolated, while an invalid probe binding stops before financial IO',async()=>{
  const r=await run({editBatch:b=>b[1].raw.data.report.end_date='2026-10-13'});assert.equal(r.model.cash.noah,null);assert.equal(r.model.holdings.status,'ready');
  for(const edit of [b=>b.object.generation='2',b=>b.source.raw.orders=[],b=>b.receipt.status='failed',b=>b.receipt.association.policyBlob='c'.repeat(40),b=>b.receiptSha256='0'.repeat(64)]){
    const b=bundle();edit(b);assert.throws(()=>validatePreviewOrdersBundle(b,{now:NOW,association:context().association}),/BINDING_INVALID/);
  }
  assert.throws(()=>validatePreviewOrdersBundle(bundle(),{now:NOW+5*60000,association:context().association}),/BINDING_INVALID/);
});
test('tampering partial coverage, captured time, reserve or CALL metadata fails the full renderer guard',async()=>{
  const {model}=await run();
  for(const edit of [m=>m.orders.coverage='unknown',m=>m.cash.orderReserve=100,m=>m.cash.call.declarationDate=null,m=>m.provenance.capture.startedAt='2026-10-15T04:50:00.000Z']){
    const m=structuredClone(model);edit(m);assert.throws(()=>renderNightActionReport(m));
  }
});
test('negative, contradictory or malformed coverage evidence cannot be overridden by one matching count',async()=>{
  const vectors=[{complete:false,total_count:1},{total_count:1,order_count:2},{total_count:2,order_count:1},
    {complete:true,total_count:1,order_count:2},{complete:null,total_count:1},{complete:true,total_count:'1'},
    {complete:true,total_count:-1},{complete:true,has_more:true},{complete:true,has_more:null},
    {complete:true,next_cursor:'next'},{complete:true,next_cursor:0},{complete:true,pagination:{}}];
  for(const evidence of vectors){
    const {model:m}=await run({raw:{orders:[order()],...evidence}});
    assert.equal(m.orders.status,'partial');assert.equal(m.orders.buys.length,1);assert.equal(m.cash.orderReserve,null);assert.equal(m.cash.planning,null);assert.equal(m.allocation.projectedTotal,null);assert.equal(m.cash.ib,1000);assert.equal(m.allocation.status,'ready');
  }
  for(const evidence of [{total_count:1,order_count:1},{complete:true,total_count:1,order_count:1,has_more:false,next_cursor:null,pagination:null}]){
    const {model:m}=await run({raw:{orders:[order()],...evidence}});assert.equal(m.orders.status,'ready');assert.equal(m.cash.orderReserve,60);
  }
  const {model:empty}=await run({raw:{orders:[],complete:false,total_count:0,order_count:0}});assert.equal(empty.orders.status,'partial');assert.equal(empty.cash.orderReserve,null);assert.equal(empty.cash.planning,null);
});
test('every same-code holding participates in currency certainty, including missing and invalid rows in either order',async()=>{
  for(const currency of [undefined,null,{code:''},{code:'CAD'}])for(const reverse of [false,true]){
    const editBatch=b=>{const rows=b[0].raw.data.report.holdings,copy=structuredClone(rows[3]);copy.id=100;copy.value=0;
      if(currency===undefined)delete copy.instrument.currency;else copy.instrument.currency=currency;
      if(reverse)rows.unshift(copy);else rows.push(copy);};
    const b=batch();editBatch(b);const map=sharesightOrderCurrencies({status:'date-verified',raw:b[0].raw});assert.equal(map.EXUS,null);
    const {model:m}=await run({editBatch});assert.equal(m.orders.buys[0].currency,null);assert.equal(m.cash.orderReserve,null);assert.equal(m.cash.planning,null);assert.equal(m.cash.ib,1000);assert.equal(m.cash.noah,200);
  }
  const b=batch();b[0].raw.data.report.holdings[3].instrument.currency_code='CAD';assert.equal(sharesightOrderCurrencies({status:'date-verified',raw:b[0].raw}).EXUS,null);
});
test('an unsupported order description is isolated before final model validation; cash and configuration cards survive',async()=>{
  for(const description of ['Buy 10 BRK B','Buy 10 BRK@B']){
    const raw={orders:[{...order(),primary_description:description}],complete:true},r=await run({raw}),m=r.model;
    assert.equal(m.orders.status,'unknown');assert.equal(m.orders.reason,'ORDERS_MALFORMED_OR_UNMATCHED');assert.equal(m.sourceOutcomes[3].status,'malformed');assert.equal(m.fieldState.orders.status,'malformed');
    assert.equal(m.orders.buys,null);assert.equal(m.cash.orderReserve,null);assert.equal(m.cash.planning,null);assert.equal(m.cash.totalCapacity,null);assert.equal(m.allocation.projectedTotal,null);
    assert.equal(m.cash.ib,1000);assert.equal(m.cash.noah,200);assert.equal(m.cash.reserve,100);assert.equal(m.allocation.status,'ready');assert.equal(m.holdings.status,'ready');
    for(const title of ['本轮补仓','挂单提醒','现金优先补仓参考','股票四类配置'])assert.ok(r.html.includes(title));assert.equal(validateNightActionHtml(r.html,'2026-10-15').orderCount,null);
  }
});

function assertSafeErrors(result){
  const {model,receipt}=result;assert.deepEqual(receipt.fieldErrors,model.fieldErrors);
  assert.deepEqual(Object.keys(model.fieldErrors),Object.keys(ACTION_ERROR_CODES));
  for(const [key,code] of Object.entries(model.fieldErrors))assert.ok(code===null||ACTION_ERROR_CODES[key].includes(code));
  assert.ok(!JSON.stringify(model).includes('SYNTHETIC_PRIVATE_ERROR'));
  for(const title of ['本轮补仓','挂单提醒','现金优先补仓参考','股票四类配置'])assert.ok(result.html.includes(title));
}
test('source collection and holdings structure failures are local, bounded and reported without raw errors',async()=>{
  for(const value of [{},42,null,'bad',[null],[42],[{}],[{instrument:null}]]){
    const r=await run({editBatch:b=>b[0].raw.data.report.holdings=value});assertSafeErrors(r);
    assert.equal(r.model.cash.ib,1000);assert.equal(r.model.cash.noah,200);assert.equal(r.model.cash.planning,null);assert.equal(r.model.allocation.status,'unavailable');
    assert.equal(r.model.fieldErrors.allocation,'ALLOCATION_SOURCE_INVALID');assert.equal(r.model.fieldErrors.orderCurrency,'CURRENCY_SOURCE_INVALID');
  }
  for(const index of [0,1])for(const value of [null,42,{},[]]){
    const r=await run({editBatch:b=>b[index].raw=value});assertSafeErrors(r);
    assert.equal(r.model.cash[index===0?'ib':'noah'],null);assert.equal(r.model.cash[index===0?'noah':'ib'],index===0?200:1000);assert.equal(r.model.orders.status,'ready');assert.equal(r.model.cash.planning,null);
  }
  const failed=await run({gatewayFailure:true});assertSafeErrors(failed);assert.equal(failed.model.cash.ib,null);assert.equal(failed.model.cash.noah,null);assert.equal(failed.model.orders.status,'ready');assert.equal(failed.model.cash.reserve,100);
  for(const sources of [{},42,null,[null,42,{}]])assert.doesNotThrow(()=>readCurrentActionFields({live:{status:'captured',sources},dataDate:'2026-10-15',startedAt:start,completedAt:new Date(NOW).toISOString()}));
  const oversized=await run({editBatch:b=>b[0].raw.data.report.holdings.forEach(h=>h.value=1e12)});assertSafeErrors(oversized);assert.equal(oversized.model.allocation.status,'unavailable');assert.equal(oversized.model.cash.ib,1000);assert.equal(oversized.model.fieldErrors.allocation,'ALLOCATION_SOURCE_INVALID');
});
test('cash source shape, value and aggregate-range failures preserve the other source and current configuration',async()=>{
  for(const index of [0,1])for(const value of [{},42,null,'bad',[],[null],[{value:-1}],[{value:'SYNTHETIC_PRIVATE_ERROR'}],[{value:1e12},{value:1e12}]]){
    const r=await run({editBatch:b=>b[index].raw.data.report.cash_accounts=value});assertSafeErrors(r);
    assert.equal(r.model.cash[index===0?'ib':'noah'],null);assert.equal(r.model.cash[index===0?'noah':'ib'],index===0?200:1000);assert.equal(r.model.cash.planning,null);assert.equal(r.model.allocation.status,'ready');
    assert.notEqual(r.model.fieldErrors[index===0?'ibCash':'noahCash'],null);
  }
  const zero=await run({raw:{orders:[],complete:true},editBatch:b=>b.forEach(s=>s.raw.data.report.cash_accounts=[{value:0}])});assertSafeErrors(zero);assert.equal(zero.model.cash.pool,0);assert.equal(zero.model.cash.orderReserve,0);assert.equal(zero.model.cash.planning,0);
});
test('order row/input failures cannot erase valid cash or classified holdings',async()=>{
  for(const rows of [[null],[42],[{}],[{...order(),limit_price:'SYNTHETIC_PRIVATE_ERROR'}],[{...order(),remaining_shares_qty:'-1'}]]){
    const r=await run({raw:{orders:rows,complete:true}});assertSafeErrors(r);assert.equal(r.model.orders.status,'unknown');assert.equal(r.model.fieldErrors.orders,'ORDERS_PAYLOAD_INVALID');
    assert.equal(r.model.cash.orderReserve,null);assert.equal(r.model.cash.planning,null);assert.equal(r.model.cash.ib,1000);assert.equal(r.model.allocation.status,'ready');assert.equal(r.model.holdings.status,'ready');
  }
});
test('reserve and projection overflow are isolated as derived failures while original order rows remain visible',async()=>{
  const huge=quantity=>({...order(),total_shares_qty:quantity,cum_shares_qty:'0',remaining_shares_qty:quantity,primary_description:'Buy '+quantity+' EXUS'});
  for(const rows of [[huge('1000000000000')],[{...huge('600000000000'),limit_price:'1'},{...huge('600000000000'),order_id:2,limit_price:'1'}]]){
    const r=await run({raw:{orders:rows,complete:true}});assertSafeErrors(r);const m=r.model;
    assert.equal(m.orders.status,'ready');assert.equal(m.orders.buys.length,rows.length);assert.equal(m.cash.orderReserve,null);assert.equal(m.cash.planning,null);assert.equal(m.allocation.projectedTotal,null);
    assert.equal(m.fieldErrors.orderReserve,'BUY_RESERVE_OUT_OF_RANGE');assert.equal(m.fieldErrors.allocationProjection,'PROJECTION_INVALID');assert.equal(m.cash.ib,1000);assert.equal(m.cash.noah,200);assert.equal(m.allocation.total,1000);assert.equal(m.holdings.status,'ready');
  }
  const projectionOnly=await run({raw:{orders:[{...huge('1000000000000'),limit_price:'1'}],complete:true}});assertSafeErrors(projectionOnly);
  assert.equal(projectionOnly.model.cash.orderReserve,1e12);assert.equal(projectionOnly.model.cash.planning,0);assert.equal(projectionOnly.model.allocation.projectedTotal,null);assert.equal(projectionOnly.model.fieldErrors.allocationProjection,'PROJECTION_INVALID');
});
test('cash-pool, cash-like and total-capacity ranges have separate local boundaries',async()=>{
  const pool=await run({editBatch:b=>b.forEach(s=>s.raw.data.report.cash_accounts=[{value:1e12}])});assertSafeErrors(pool);assert.equal(pool.model.cash.ib,1e12);assert.equal(pool.model.cash.noah,1e12);assert.equal(pool.model.cash.pool,null);assert.equal(pool.model.fieldErrors.cashPool,'CASH_POOL_OUT_OF_RANGE');assert.equal(pool.model.allocation.status,'ready');
  const cashLike=await run({editBatch:b=>{const h=b[0].raw.data.report.holdings;h[5].value=1e12;h.push({...structuredClone(h[5]),id:101,instrument:{code:'VGIT',currency:{code:'USD'}}});}});assertSafeErrors(cashLike);
  assert.equal(cashLike.model.cash.cashLike,null);assert.equal(cashLike.model.fieldErrors.cashLike,'CASH_LIKE_INVALID');assert.equal(cashLike.model.cash.planning,1090);assert.equal(cashLike.model.allocation.total,1000);
  const capacity=await run({editBatch:b=>{b[0].raw.data.report.holdings[5].value=1e12;b[0].raw.data.report.cash_accounts=[{value:1e12}];b[1].raw.data.report.cash_accounts=[{value:0}];}});assertSafeErrors(capacity);
  assert.equal(capacity.model.cash.totalCapacity,null);assert.equal(capacity.model.fieldErrors.capacity,'TOTAL_CAPACITY_OUT_OF_RANGE');assert.ok(capacity.model.cash.planning>0);assert.equal(capacity.model.cash.cashLike.total,1e12);
});
test('replenishment overflow and unsupported holding detail do not discard current allocation or cash',async()=>{
  const plan=await run({raw:{orders:[],complete:true},editBatch:b=>b[0].raw.data.report.holdings.forEach(h=>{if(h.group_name!=='防御资产')h.value*=1e9;})});assertSafeErrors(plan);
  assert.equal(plan.model.allocation.total,1e12);assert.equal(plan.model.allocation.projectedTotal,1e12);assert.equal(plan.model.cash.planning,1150);assert.equal(plan.model.replenishment.status,'unavailable');assert.equal(plan.model.fieldErrors.replenishment,'PLAN_DERIVATION_INVALID');assert.equal(plan.model.holdings.status,'ready');
  const detail=await run({editBatch:b=>b[0].raw.data.report.holdings[0].quantity='SYNTHETIC_PRIVATE_ERROR'});assertSafeErrors(detail);assert.equal(detail.model.holdings.status,'unavailable');assert.equal(detail.model.fieldErrors.holdings,'HOLDINGS_DETAIL_UNSUPPORTED');assert.equal(detail.model.allocation.status,'ready');assert.equal(detail.model.cash.planning,1090);
});
test('closed failure reasons cannot hide tampering of evidence, source windows or computed contributions',async()=>{
  const r=await run();assertSafeErrors(r);
  for(const edit of [m=>m.fieldErrors.orders='SYNTHETIC_PRIVATE_ERROR',m=>m.fieldErrors.orderReserve='BUY_RESERVE_OUT_OF_RANGE',m=>m.evidenceSha256='0'.repeat(64),m=>m.provenance.capture.startedAt='2026-10-15T04:50:00.000Z',m=>m.allocation.categories[0].marketValue=1e13,m=>m.replenishment.items[0].amount=1e13]){
    const m=structuredClone(r.model);edit(m);assert.throws(()=>renderNightActionReport(m));
  }
});
test('optional historical Flex failure is isolated from current cash, orders and configuration',async()=>{
  const objects=new Map(),io={savePrivate:async(name,value)=>{objects.set(name,value);return {sha256:digest(value),generation:'1'};}};
  const receipt=await runPrivateEodReport({sourceDate,io,now:()=>NOW,loadContext:async()=>context(),fieldMode:true,initialStartedAt:Date.parse(start),
    expectedAccount:'SYNTHETIC_ACCOUNT',expectedQueryId:'SYNTHETIC_QUERY',readArchive:async()=>{throw Error('SYNTHETIC_PRIVATE_ERROR');},verifyArchive:async()=>assert.fail('No archive exists'),
    snapshotReader:createEodSnapshotReader({sourceDate,readSharesightBatch:async()=>batch()}),captureOptionalLive:async()=>({status:'captured',sources:[bundle().source]})});
  const html=objects.get(receipt.artifact.privateObject),model=extractNightActionModel(html);assertSafeErrors({model,receipt,html});
  assert.equal(model.sourceOutcomes[0].status,'request-failure');assert.equal(model.cash.ib,1000);assert.equal(model.cash.planning,1090);assert.equal(model.allocation.status,'ready');
});
test('account or trusted-context failures remain fatal before source reads; local degradation cannot bypass them',async()=>{
  assert.throws(()=>validatePreviewOrdersBundle(bundle({orders:[],complete:true,account_id:'SYNTHETIC_WRONG'}),{now:NOW,association:context().association}),/IB_DIAGNOSTIC_ACCOUNT_MISMATCH/);
  let reads=0,saves=0;const c=context();c.association.policy.expiresAt='2026-10-14T00:00:00.000Z';c.association.policyBlob=associationPolicyBlob(c.association.policy);
  await assert.rejects(composePrivateActionPreview({bundle:bundle(),sourceDate,io:{loadGatewayToken:async()=>{reads++;},savePrivate:async()=>{saves++;}},now:()=>NOW,loadContext:async()=>c}));assert.equal(reads,0);assert.equal(saves,0);
});
