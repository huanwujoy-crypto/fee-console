import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrderTrends, groupOrders, orderTrendKey } from './xuan-ib-order-view.mjs';
const order=(symbol,side,limitPrice,marketPrice=100)=>({symbol,side,limitPrice,marketPrice,quantity:10,currency:'USD',marketAsOfHkt:marketPrice===null?null:'2026-09-05 10:00 HKT',ageDays:60,status:'NEW',cancelReview:false});
test('buy/sell groups sort by absolute unrounded distance with stable ties and nulls last',()=>{
  const rows=[order('SELL_NEAR','sell',101),order('BUY_FAR','buy',80),order('BUY_NEAR','buy',99),order('BUY_TIE','buy',99),order('UNKNOWN','buy',90,null),order('SELL_FAR','sell',120)];
  const original=JSON.stringify(rows),groups=groupOrders(rows);
  assert.deepEqual(groups.map(g=>g.side),['buy','sell']);
  assert.deepEqual(groups[0].orders.map(o=>o.symbol),['BUY_NEAR','BUY_TIE','BUY_FAR','UNKNOWN']);
  assert.deepEqual(groups[1].orders.map(o=>o.symbol),['SELL_NEAR','SELL_FAR']);
  assert.equal(groups[0].orders.at(-1).distancePct,null);assert.equal(JSON.stringify(rows),original);
});
test('cancel flag is explicit, never inferred from price distance or age',()=>{
  const row=order('SYNTHETIC','buy',50);row.ageDays=100;
  assert.equal(groupOrders([row])[0].orders[0].cancelReview,false);
  row.cancelReview=true;assert.equal(groupOrders([row])[0].orders[0].cancelReview,true);
});
test('unknown side, zero quote, missing quote date, bad types and extra instructions fail',()=>{
  for(const patch of [{side:'short'},{marketPrice:0},{marketAsOfHkt:null},{quantity:'10'},{instruction:'buy now'},{ageDays:-1}])assert.throws(()=>groupOrders([{...order('SYNTHETIC','buy',99),...patch}]));
});
test('nonzero-age trend uses the first observed quote and never adds a source read',()=>{
  const first=order('TREND','buy',90,100),key=orderTrendKey(first);
  const initial=buildOrderTrends([first],{dataDate:'2026-09-05'}).get(key);
  assert.equal(initial.kind,'building');assert.equal(initial.label,'趋势建立中');
  const previous=`<table><tr${initial.attributes}></tr></table>`;
  const next={...first,marketPrice:105,marketAsOfHkt:'2026-09-08 10:00 HKT',ageDays:63};
  assert.deepEqual(buildOrderTrends([next],{previousHtml:previous,dataDate:'2026-09-08'}).get(key),{
    kind:'up',label:'约 ↑ 5.0% · 观察3天',attributes:initial.attributes.replace('data-order-age-days="60"','data-order-age-days="63"'),
  });
});
test('zero-age orders hide trend; missing price and malformed history never block',()=>{
  const fresh=order('FRESH','sell',110);fresh.ageDays=0;
  assert.equal(buildOrderTrends([fresh],{previousHtml:'bad',dataDate:'2026-09-05'}).get(orderTrendKey(fresh)).kind,'none');
  const missing=order('MISSING','buy',90,null);
  assert.deepEqual(buildOrderTrends([missing],{previousHtml:'<tr data-order-trend-v1="1">',dataDate:'2026-09-05'}).get(orderTrendKey(missing)),{kind:'unavailable',label:'趋势未取得',attributes:''});
});
export {order};
