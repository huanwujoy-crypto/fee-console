import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {partitionFourBucketText,retireFourBucketDisplay,RETIREMENT_NOTE} from './xuan-ib-four-bucket-retirement.mjs';
test('mixed alerts retain independent price/source warning',()=>{
  assert.deepEqual(partitionFourBucketText('四桶暂用 08-24 快照，待完整核验；本次未查询逐票行情，日涨跌标未取得。'),
    {retired:'四桶暂用 08-24 快照，待完整核验；',kept:'本次未查询逐票行情，日涨跌标未取得。'});
});
test('cash guidance, decimal values and equity four-class policy are not bucket targets',()=>{
  const text='四类：美国底仓 51.43%。EXUS $550,579；EIMI $128,701；USSC $75,476。现金预留 $240,000。';
  assert.deepEqual(partitionFourBucketText(text),{kept:text,retired:''});
  const ai='AI 三账户附加（非四桶）：用于风险分母。';
  assert.equal(partitionFourBucketText(ai).kept,ai);
});
test('retirement is display-only, historical and idempotent at entry',()=>{
  assert.doesNotThrow(()=>retireFourBucketDisplay(null));
  assert.doesNotThrow(()=>retireFourBucketDisplay({createElement(){throw Error('unexpected mutation');},getElementById(){return {};}}));
  const source=fs.readFileSync(new URL('./xuan-ib-four-bucket-retirement.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/fetch\(|localStorage|sessionStorage|innerHTML\s*=/);
  assert.match(source,/\[data-decision-id\]/);
  assert.match(source,/xuan-ib-cash-plan-kpi/);
  assert.match(RETIREMENT_NOTE,/已取消/);
});
