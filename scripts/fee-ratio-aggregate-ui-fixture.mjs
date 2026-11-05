// Test-only exact transition. It never authorizes a release or a data write.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const bytes=fs.readFileSync(new URL('./fixtures/fee-ratio-aggregate-returns-ui.json',import.meta.url));
assert.equal(hash(bytes),'9154f18810f25be272a7b6951a4446587a302fce06d62817e75540e3118b66ae');
export const aggregateUiFixture=JSON.parse(bytes);
export function aggregateUiStage(page,forward=true){
 const f=aggregateUiFixture;
 assert.equal(hash(page),forward?f.priorSha256:f.nextSha256,'unknown aggregate UI input');
 for(const r of forward?f.regions:[...f.regions].reverse()){
  const [from,to]=forward?[r.prior,r.next]:[r.next,r.prior];
  assert.equal(page.split(from).length,2);page=page.replace(from,()=>to);
 }
 assert.equal(hash(page),forward?f.nextSha256:f.priorSha256,'unknown aggregate UI output');
 return page;
}
export function priorAggregateUi(page){return hash(page)===aggregateUiFixture.nextSha256?aggregateUiStage(page,false):page;}
