import test from 'node:test';
import assert from 'node:assert/strict';
import {reportNoteLines} from './xuan-ib-routine-reading.mjs';
test('routine notes stay concise and exclude irrelevant history',()=>{
  for(let pane=1;pane<=5;pane++){
    const lines=reportNoteLines(pane,'历史四桶 08-24 快照 旧任务未核验 已结案');
    assert.ok(lines.length<=4);assert.ok(lines.every(x=>x.length<100));
    assert.doesNotMatch(lines.join(''),/四桶|08-24|已结案/);
  }
});
test('risk approximation, missing AAOI and leverage uncertainty are not disguised as verified',()=>{
  const lines=reportNoteLines(2,'低高近似 不含 AAOI 名义敞口待核验');
  assert.match(lines.join(' '),/低／高情景仍为近似/);
  assert.match(lines.join(' '),/AAOI 尚未计入/);
  assert.match(lines.join(' '),/名义敞口未核验/);
  const applied=reportNoteLines(2,'低高近似',{aaoiApplied:true});
  assert.match(applied.join(' '),/原快照.*未重新取数/);
  assert.doesNotMatch(applied.join(' '),/尚未计入/);
});
test('cash planning and daily-quote availability keep their qualifications',()=>{
  const cash=reportNoteLines(3,'USSC 10%');
  assert.match(cash.join(' '),/不是券商即时购买力/);
  assert.match(cash.join(' '),/10% 是本次现金预算占比/);
  assert.match(cash.join(' '),/不假设卖出回款/);
  assert.match(reportNoteLines(1,'日涨跌未取得').join(' '),/不以零或未实现盈亏代替/);
});
