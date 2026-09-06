import test from 'node:test';
import assert from 'node:assert/strict';
import {orderDisplayFields,groupOrderDisplayRows,ORDER_CARDS_CSS} from './xuan-ib-order-cards.mjs';
test('legacy rows preserve exact quantities, prices, distances, duration and sourced flags',()=>{
  const row=orderDisplayFields('EXUS 买 1000','42.00','-10.95%','92 天 · REPLACED · 待撤');
  assert.deepEqual(row,{identity:'EXUS',quantity:'1000',side:'buy',limit:'42.00',distance:'-10.95%',age:'92 天',status:'REPLACED · 待撤',distanceRank:10.95});
  assert.equal(orderDisplayFields('SLV 卖 160','82.00','+36.96%','141 天 · NEW').status,'NEW');
});
test('unknown duration and direction are not inferred; unavailable price is last',()=>{
  const row=orderDisplayFields('UNKNOWN','待核','未取得','年龄未核 · NEW');
  assert.equal(row.side,'unknown');assert.equal(row.age,'未核实');assert.equal(row.status,'已挂天数未核实 · NEW');
  assert.equal(row.distanceRank,Infinity);
});
test('buy and sell separated with stable absolute-distance order and no input mutation',()=>{
  const make=(id,side,distance)=>orderDisplayFields(`${id} ${side} 10`,'10.00',distance,'3 天 · NEW');
  const rows=[make('S','卖','+1%'),make('F','买','-12%'),make('U','买','未取得'),make('N','买','−2%'),make('T','买','+2%')];
  const before=JSON.stringify(rows),groups=groupOrderDisplayRows(rows);
  assert.deepEqual(groups.map(g=>g.side),['buy','sell']);
  assert.deepEqual(groups[0].rows.map(r=>r.identity),['N','T','F','U']);
  assert.equal(JSON.stringify(rows),before);
});
test('mobile cards have no horizontal table and wrap enlarged content without clipping',()=>{
  assert.match(ORDER_CARDS_CSS,/repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(ORDER_CARDS_CSS,/overflow-wrap:anywhere/);
  assert.doesNotMatch(ORDER_CARDS_CSS,/overflow(?:-x)?:hidden|[;{]min-width:\d+px/);
});
