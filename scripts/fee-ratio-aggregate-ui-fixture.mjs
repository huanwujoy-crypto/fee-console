// Test-only exact transition. It never authorizes a release or a data write.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const bytes=fs.readFileSync(new URL('./fixtures/fee-ratio-aggregate-returns-ui.json',import.meta.url));
assert.equal(hash(bytes),'dd3fd4cdedcdf3261725a3792c91730519426352a112dc3be85fa0d90d7bc787');
export const aggregateUiFixture=JSON.parse(bytes);
// Owner decision 2026-11-17: the live page is no longer pinned byte for byte. The stage tests that rewind a page
// through these fixtures describe the pages up to 4.9.63; when the live page is a later one they run on this frozen
// copy of 4.9.63 instead, exactly as before. Tests about the live page read the live page itself.
const frozen=()=>{const page=fs.readFileSync(new URL('./fixtures/index-4.9.63.html',import.meta.url),'utf8');assert.equal(hash(page),aggregateUiFixture.nextSha256);return page;};
export const isStagedPage=page=>[aggregateUiFixture.priorSha256,aggregateUiFixture.supportSha256,aggregateUiFixture.nextSha256].includes(hash(page));
export function aggregateUiStage(page,forward=true){
 const f=aggregateUiFixture;
 // Owner decision 2026-11-17: a page is no longer pinned byte for byte. This fixture records the stages up to
 // 4.9.63; any later page is taken as it stands, and the tests that use it check behaviour on the real page.
 if(forward&&hash(page)!==f.priorSha256&&hash(page)!==f.supportSha256)return page;
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
 if(!isStagedPage(page))page=frozen();
 if(hash(page)===f.nextSha256)return aggregateUiStage(page,false);
 if(hash(page)===f.supportSha256){
  for(const r of f.regions.slice(0,f.supportRegionCount).reverse()){
   assert.equal(page.split(r.next).length,2);page=page.replace(r.next,()=>r.prior);
  }
  assert.equal(hash(page),f.priorSha256,'unknown aggregate support input');
 }
 return page;
}
