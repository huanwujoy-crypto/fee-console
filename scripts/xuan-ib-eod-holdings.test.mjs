import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEodHoldings,validateEodHoldings,buildBookConcentration,validateBookConcentration,bookIssuerConcentration} from './xuan-ib-eod-holdings.mjs';
import {buildWeeklyConcentration,buildIbBookIssuerConcentration,renderWeeklyConcentration} from './xuan-weekly-concentration.mjs';
import {parseSharesightStockAllocation} from './xuan-ib-sharesight-allocation.mjs';
const date='2026-10-08';
function source(){const h=(id,group_name,value,code,quantity)=>({id,group_name,value,instrument:{code},...(quantity===undefined?{}:{quantity})});return {raw:{data:{report:{portfolio_id:936247,currency:{code:'USD'},grouping:'custom_group_category',custom_group:{id:83569,name:'资产类别'},end_date:date,holdings:[h(1,'美国底仓',450,'CSPX',5),h(2,'美国底仓',50,'USSC'),h(3,'美国科技',250,'GOOG',1),h(4,'非美发达',180,'EXUS',2),h(5,'新兴市场',70,'EIMI',3),h(6,'防御资产',90,'TLT',4)]}}}};}
test('recorded stock rows reconcile category and total values; defense stays outside stock concentration',()=>{
  const s=source(),a=parseSharesightStockAllocation(s.raw),h=buildEodHoldings(s,a,date);
  assert.equal(h.total,1000);assert.equal(h.rows.length,5);assert.equal(h.rows.find(r=>r.symbol==='USSC').quantity,null);
  assert.equal(h.concentration.top1Pct,45);assert.equal(h.concentration.top5Pct,100);assert(!h.rows.some(r=>r.symbol==='TLT'));assert.equal(h.ibEodPositions,'not-provided');
});
test('ambiguous same-code instruments cannot merge quantities or inflate concentration',()=>{
  const s=source();s.raw.data.report.holdings.push({id:7,group_name:'美国底仓',value:50,instrument:{code:'CSPX'}});
  const a=parseSharesightStockAllocation(s.raw),h=buildEodHoldings(s,a,date);
  assert.equal(h.status,'unavailable');assert.equal(h.reason,'DETAIL_UNSUPPORTED');
  const r=source();r.raw.data.report.holdings[0].instrument={code:'CSPX',id:1,market_code:'NASDAQ'};
  r.raw.data.report.holdings.push({id:7,group_name:'美国底仓',value:400,quantity:100,instrument:{code:'CSPX',id:2,market_code:'LSE'}});
  assert.equal(buildEodHoldings(r,parseSharesightStockAllocation(r.raw),date).status,'unavailable');
});
test('unknown fields, totals, categories, dates, concentration and private text fail closed',()=>{
  const s=source(),a=parseSharesightStockAllocation(s.raw),h=buildEodHoldings(s,a,date);
  for(const edit of [m=>m.rows[0].marketValueUsd++,m=>m.rows[0].weightPct++,m=>m.rows[0].category='防御资产',m=>m.rows[0].accountId='PRIVATE_CANARY',m=>m.rows[0].quantity=-1,m=>m.sourceDate='2026-10-07',m=>m.concentration.top5Pct=0]){const m=structuredClone(h);edit(m);assert.throws(()=>validateEodHoldings(m,a,date));}
  s.raw.data.report.holdings[0].instrument.code='PRIVATE_CANARY';assert.equal(buildEodHoldings(s,a,date).status,'unavailable');
});

function issuerSource(){
  const row=(id,code,instrumentId,type,value)=>({id,value,instrument:{id:instrumentId,code,market_code:'TEST',currency_code:'USD',friendly_instrument_description_code:type}});
  return {status:'date-verified',raw:{data:{report:{portfolio_id:936247,currency:{code:'USD'},end_date:date,value:1000,cash_accounts:[{value:500}],holdings:[
    row(1,'GOOG',101,'ordinary_shares',50),row(2,'GOOGL',102,'ordinary_shares',50),row(3,'CSPX',1310832,'exchange_traded_fund',300),row(4,'VST',103,'ordinary_shares',50),row(29282953,'VSTL',104,'exchange_traded_fund',50),
  ]}}}};
}
test('action uses the weekly issuer math, aliases, ETF union and verified leverage with its actual single-account denominator',()=>{
  const c=buildBookConcentration(issuerSource(),date);assert.equal(c.status,'ready');
  const result=bookIssuerConcentration(c),alphabet=result.rows.find(r=>r.issuer==='ALPHABET'),vst=result.rows.find(r=>r.issuer==='VST');
  assert.equal(alphabet.directCents,'10000');assert(BigInt(alphabet.etfCents)>0n);
  assert.equal(vst.leveragedCents,'10000');assert.equal(vst.leveragedInvestmentCents,'5000');
  assert(!result.rows.some(r=>['CSPX','VSTL'].includes(r.issuer)));assert.equal(result.denominatorCents,'100000');
  const rows=c.rows.map(r=>({portfolioId:'936247',custodian:'IB-HK',holdingId:String(r.holdingId),instrumentId:r.instrumentId,symbol:r.symbol,assetType:r.assetType,identityVerified:true,valueDate:date,marketValueMicro:String(r.marketValueUsd*1e6)}));
  const one={riskDenominator:{components:[{key:'ib-hk',valueMicro:'1000000000'}]},riskConstituents:rows};
  assert.throws(()=>buildWeeklyConcentration(one,{cutoff:date}),/accounts_invalid/);
  const three={...one,riskDenominator:{components:[{key:'ib-hk',valueMicro:'600000000'},{key:'schwab-hk',valueMicro:'200000000'},{key:'webull',valueMicro:'200000000'}]}};
  assert.deepEqual(buildWeeklyConcentration(three,{cutoff:date}),result);
  assert.deepEqual(buildIbBookIssuerConcentration(one,{cutoff:date}),result);
  assert.throws(()=>buildIbBookIssuerConcentration(three,{cutoff:date}),/accounts_invalid/);
  assert.match(renderWeeklyConcentration(result,{scope:'ib-hk'}),/IB-HK 全部持仓与现金/);
  assert.match(renderWeeklyConcentration(result),/三账户含现金/);
});
test('prior metadata matches exact identity only; missing types and expired ETF weights never become zero exposures',()=>{
  const s=issuerSource(),prior=structuredClone(s.raw),rows=s.raw.data.report.holdings;
  rows.forEach(r=>delete r.instrument.friendly_instrument_description_code);
  s.raw.classification={raw:prior,provenance:{sourceDate:date}};
  let c=buildBookConcentration(s,date);assert.equal(c.rows.filter(r=>r.assetType==='STK').length,3);
  s.raw.classification.raw.data.report.holdings[0].instrument.market_code='OTHER';
  c=buildBookConcentration(s,date);assert.equal(c.rows.find(r=>r.symbol==='GOOG').instrumentId,null);assert.equal(c.total,1000);
  const stale=buildIbBookIssuerConcentration({riskDenominator:{components:[{key:'ib-hk',valueMicro:'1000000000'}]},riskConstituents:[{portfolioId:'936247',custodian:'IB-HK',holdingId:'3',instrumentId:'1310832',symbol:'CSPX',assetType:'ETF',identityVerified:true,valueDate:'2027-01-01',marketValueMicro:'300000000'}]},{cutoff:'2027-01-01'});
  assert.equal(stale.missingFunds.length,1);assert.match(renderWeeklyConcentration(stale),/不能视为零/);
  for(const edit of [x=>x.rows[0].assetType='STK',x=>x.rows[0].marketValueUsd++,x=>x.issuerResultFingerprint='0'.repeat(64)]){
    const bad=structuredClone(c);edit(bad);assert.throws(()=>validateBookConcentration(bad,date));
  }
});
