import test from 'node:test';
import assert from 'node:assert/strict';
import {publishPrepared} from './publish.mjs';
import {statusFixture} from './test_fixtures.mjs';
function fixture(){const f=statusFixture();f.calls=[];f.loadContext=async()=>structuredClone(f.context);f.request=async payload=>{f.calls.push(payload);if(payload.query.startsWith('query'))return{data:{viewer:{login:'huanwujoy-crypto'},repository:{id:'repo',ref:{target:{oid:'a'.repeat(40)}}}}};if(payload.query.includes('CreateRef'))return{data:{createRef:{ref:{name:payload.variables.input.name,target:{oid:'a'.repeat(40)}}}}};return{data:{createCommitOnBranch:{commit:{oid:'d'.repeat(40)},ref:{name:payload.variables.input.branch.branchName}}}};};return f;}
test('non-action status uses signed single-file protected candidate, never main/meta',async()=>{
 const f=fixture(),result=await publishPrepared(f);assert.equal(result.publication,'candidate-only');assert.equal(f.calls.length,3);
 const input=f.calls[2].variables.input;assert.equal(input.expectedHeadOid,'a'.repeat(40));assert.equal(input.message.headline,'handover 2026-10-05');assert.deepEqual(input.fileChanges.additions.map(x=>x.path),['xuan-ib/index.html']);assert.equal(Buffer.from(input.fileChanges.additions[0].contents,'base64').toString(),f.html);
});
test('tamper, relabel, ready without real adapter, stale, future and policy mismatch cannot write',async()=>{
 for(const modify of [f=>f.html+='x',f=>f.receipt.status='ready',f=>f.receipt.dataDate='2026-10-04',f=>f.receipt.startedAt='2026-10-05T05:00:00Z',f=>f.receipt.completedAt='2026-10-05T07:00:00Z',f=>f.receipt.reasonCodes=['PRIVATE_ACCOUNT'],f=>f.context.previousSourceSha='e'.repeat(40),f=>f.context.association.policy.expiresAt='2026-10-04T00:00:00.000Z']){
  const f=fixture();modify(f);await assert.rejects(publishPrepared(f));assert.equal(f.calls.length,0);
 }
});
test('non-owner, moved main and concurrent policy-base change fail before commit',async()=>{
 for(const login of ['other','huanwujoy-crypto']){const f=fixture();f.request=async()=>({data:{viewer:{login},repository:{id:'r',ref:{target:{oid:'e'.repeat(40)}}}}});await assert.rejects(publishPrepared(f),/OWNER|BASE_CHANGED/);}
 const f=fixture();let reads=0;f.loadContext=async()=>{const c=structuredClone(f.context);if(++reads===3)c.association.policyCommit='e'.repeat(40);return c;};await assert.rejects(publishPrepared(f),/BASE_CHANGED/);assert.equal(f.calls.length,2);
});
test('same slot/reason fingerprint produces no duplicate status candidate',async()=>{
 const f=fixture();f.context.previousHtml=f.html;const result=await publishPrepared(f);assert.equal(result.publication,'already-published-status');assert.equal(f.calls.length,0);
});
