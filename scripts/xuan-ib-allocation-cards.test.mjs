import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {allocationMetrics,compactAllocationCategory,ALLOCATION_CARDS_CSS,improveAllocationCards} from './xuan-ib-allocation-cards.mjs';
test('copy only explicit category ratios without recalculating rounded financial values',()=>{
  assert.deepEqual(allocationMetrics('$550,579EXUS＋VCN 类别合计当前 12.01% → 补后约 21.94% / 目标 23%'),[['当前','12.01%'],['补后约','21.94%'],['参考目标','23%']]);
  assert.deepEqual(allocationMetrics('51.43% → 补后约 44.68%45% 为参考目标，非强制上限'),[['当前','51.43%'],['补后约','44.68%'],['参考目标','45%']]);
});
test('USSC cash-budget share is never presented as a portfolio target',()=>{
  assert.deepEqual(allocationMetrics('$75,476本次现金预算 10%占股票总额：0.39% → 补后约 1.96%'),[['当前','0.39%'],['补后约','1.96%'],['预算占比','10%']]);
  assert.deepEqual(allocationMetrics('缺少来源；待核实'),[]);
});
test('four-class phone rows remove ticker codes and keep current, value and target explicit',()=>{
  assert.deepEqual(compactAllocationCategory(['美国底仓（MXUS·CSPX·BRK.B·USSC）','1,976,119','51.53%','45%']),
    {name:'美国底仓',marketValue:'1,976,119',current:'51.53%',target:'45%'});
  assert.equal(compactAllocationCategory(['美国底仓','未取得','51.53%','45%']),null);
  assert.match(ALLOCATION_CARDS_CSS,/allocation-category-list/);
  assert.match(ALLOCATION_CARDS_CSS,/allocation-category-source\{display:none!important\}/);
});
test('presentation-only migration keeps warnings and source artifacts separate from current management',()=>{
  assert.doesNotThrow(()=>improveAllocationCards(null));
  const source=fs.readFileSync(new URL('./xuan-ib-allocation-cards.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/fetch\(|localStorage|sessionStorage|innerHTML\s*=/);
  assert.match(source,/券商可立即用于本次补仓/);
  assert.match(source,/待核实/);
  assert.match(ALLOCATION_CARDS_CSS,/#xuan-four-bucket-retired-history\{display:none!important\}/);
});
