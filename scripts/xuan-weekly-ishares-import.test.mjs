import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {importHoldings} from './xuan-weekly-ishares-import.mjs';
import {DEFAULT_POLICY} from './xuan-weekly-ai-exposure.mjs';
const root=new URL('../claude/xuan-weekly-etf-source-evidence/',import.meta.url);
const manifest=JSON.parse(fs.readFileSync(new URL('public-composition-manifest-v1.json',root)));
const bindings=JSON.parse(fs.readFileSync(new URL('identity-bindings-v1.json',root)));
const cases=[['CSPX',253743,'b109145088c7a17de94d6adcba37fdffd056464c13dbf3f0d9ad433c761ba4fb',510],['EIMI',264659,'c95f1ee685a5980635b19ff1ce3cafcadd21c8d03afb249a248ff35e468f14cf',3001]];
for(const [fund,productId,sha256,count] of cases)test(fund+' complete public composition audit and explicit unknown identities',()=>{
 const auditBytes=fs.readFileSync(new URL(fund+'-20260924-audit.json',root),'utf8'),audit=JSON.parse(auditBytes);
 const capture=manifest.find(c=>c.fund===fund);
 assert.equal(capture.originalCaptureSha256,sha256);
 assert.equal(createHash('sha256').update(auditBytes).digest('hex'),capture.publicCompositionAuditSha256);
 // Public test fixture contains only reviewed constituent columns, never issuer prices/share counts.
 // Its SHA is a fixture SHA, explicitly distinct from the original complete-capture SHA above.
 const dataPointsByNameMap=Object.fromEntries(['isin','ticker','issueName','holdingPercent','assetClass'].map(k=>[k,{value:audit.map(r=>r[k])}]));
 dataPointsByNameMap.asOfDate={value:20260924};
 const raw=JSON.stringify({productId,fundName:capture.fundName,componentsByNameMap:{holdings:{containersByNameMap:{all:{dataPointsByNameMap}}}}});
 const fixtureSha256=createHash('sha256').update(raw).digest('hex');
 const options={fund,productId,asOf:'2026-09-24',sha256:fixtureSha256,bindings};
 const r=importHoldings(raw,options);assert.equal(r.sourceRowCount,count);
 assert.deepEqual(r.holdings,DEFAULT_POLICY.etfSnapshots.find(s=>s.symbol===fund).holdings);
 assert.ok(r.holdings.some(h=>h.issuerKey?.startsWith('unreviewed-isin-')));
 assert.ok(r.holdings.some(h=>h.kind==='cash'));assert.ok(r.audit.some(h=>h.assetClass==='Futures'));
 assert.throws(()=>importHoldings(raw+' ',options),/sha_mismatch/);
 assert.throws(()=>importHoldings(raw,{...options,asOf:'2026-09-25'}),/date_mismatch/);
 assert.throws(()=>importHoldings(raw,{...options,fund:fund==='CSPX'?'EIMI':'CSPX'}),/fund_binding_invalid/);
 const changed=structuredClone(bindings);changed.find(b=>b.fund===fund).name='unrelated issuer';
 assert.throws(()=>importHoldings(raw,{...options,bindings:changed}),/name_conflict/);
 if(fund==='EIMI'){
  assert.equal(r.holdings.find(h=>h.kind==='nested-etf').issuerKey,'unreviewed-isin-DE000A0Q4R85');
  assert.equal(r.holdings.filter(h=>h.kind==='equity-identity-unverified').length,4);
  const nested=r.audit.find(h=>h.kind==='nested-etf');
  assert.throws(()=>importHoldings(raw,{...options,bindings:[...bindings,{fund,isin:nested.isin,name:nested.issueName,target:{issuerKey:'nvidia'}}]}),/nested_etf_binding/);
 }
});
test('new captures preserve both old source hashes and selected allocations; older EXUS/EQAC weights stay unchanged',()=>{
 for(const [fund,sha] of [['CSPX','9876f9530b21dd8b2dcfb6d7d84c8d2f7dfdcaa8b6126370131c94d8680326cf'],['EIMI','a48f7fedc343864d5fd38030d3d0df86c21ddac6d5e07a305b54beabd5ad42d4']]){
  const s=DEFAULT_POLICY.etfSnapshots.find(s=>s.symbol===fund);
  assert.equal(s.asOf,'2026-09-24');assert.equal(s.sourceCompositionComplete,true);
  assert.equal(s.sourceHistory[0].sha256,sha);assert.ok(s.sourceHistory[0].holdings.length>0);
 }
 for(const fund of ['EXUS','EQAC'])assert.equal(DEFAULT_POLICY.etfSnapshots.find(s=>s.symbol===fund).asOf,'2026-08-31');
 const registered=new Set(DEFAULT_POLICY.underlyingIssuers.map(i=>i.key));
 for(const s of DEFAULT_POLICY.etfSnapshots.filter(s=>['CSPX','EIMI'].includes(s.symbol)))
  for(const h of s.holdings.filter(h=>h.issuerKey?.startsWith('unreviewed-isin-')||h.kind==='equity-identity-unverified'))
   assert.equal(registered.has(h.issuerKey),false,'unreviewed identity cannot default to other');
});
