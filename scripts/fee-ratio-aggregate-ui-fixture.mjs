// Test-only exact transition. It never authorizes a release or a data write.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const bytes=fs.readFileSync(new URL('./fixtures/fee-ratio-aggregate-returns-ui.json',import.meta.url));
assert.equal(hash(bytes),'80df2734964ee4d295d3bccf1a13ddd0c3ff6f3d2b5625d94f9c5504951ab8a6');
export const aggregateUiFixture=JSON.parse(bytes);
export function aggregateUiStage(page,forward=true){
 const f=aggregateUiFixture;
 const support=forward&&hash(page)===f.supportSha256;
 assert.equal(hash(page),support?f.supportSha256:forward?f.priorSha256:f.nextSha256,'unknown aggregate UI input');
 for(const r of forward?(support?f.regions.slice(f.supportRegionCount):f.regions):[...f.regions].reverse()){
  const [from,to]=forward?[r.prior,r.next]:[r.next,r.prior];
  assert.equal(page.split(from).length,2);page=page.replace(from,()=>to);
 }
 assert.equal(hash(page),forward?f.nextSha256:f.priorSha256,'unknown aggregate UI output');
 return page;
}
export function priorAggregateUi(page){
 const f=aggregateUiFixture;
 if(hash(page)===f.nextSha256)return aggregateUiStage(page,false);
 if(hash(page)===f.supportSha256){
  for(const r of f.regions.slice(0,f.supportRegionCount).reverse()){
   assert.equal(page.split(r.next).length,2);page=page.replace(r.next,()=>r.prior);
  }
  assert.equal(hash(page),f.priorSha256,'unknown aggregate support input');
 }
 return page;
}
