import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEodHoldings,validateEodHoldings} from './xuan-ib-eod-holdings.mjs';
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
