import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {createFeeGiftRegistryStatusCore} from './fee-gift-registry-status.mjs';
import {validateManagementRegistry} from './fee-management-exemption.mjs';
const core=createFeeGiftRegistryStatusCore();
const query=()=>({schema:'fee-console.gift-registry-query.v1',account:'webull',portfolioId:1350094,holdingId:11,ticker:'SYNTH',tradeId:22,date:'2026-10-28'});
const registry=()=>({schemaVersion:1,entries:[{id:'synthetic-gift',account:'webull',portfolioId:1350094,holdingId:11,ticker:'SYNTH',firstHeldOn:'2026-10-01',effectiveFrom:'2026-10-01',authorizationRef:'synthetic prior authority',giftTradeIds:[22]}]});
const status=(q=query(),r=registry(),ready=true)=>core.status({query:q,registry:r,ready}).state;
test('gift display distinguishes an exact existing match, known nonmatch and missing/unverified state',()=>{
 assert.equal(status(),'matched');
 for(const change of [q=>q.tradeId=23,q=>q.holdingId=12,q=>q.ticker='OTHER']){const q=query();change(q);assert.equal(status(q),'unmatched');}
 const future=registry();future.entries[0].effectiveFrom='2026-10-29';assert.equal(status(query(),future),'unmatched');
 for(const ready of [false,undefined,'true'])assert.equal(core.status({query:query(),registry:registry(),ready}).state,'unknown');
 assert.equal(status(undefined,undefined,false),'unknown');assert.equal(core.status({ready:true,query:query()}).state,'unknown');
 assert.equal(core.status({ready:true,registry:registry()}).state,'unknown');
 for(const change of [r=>r.entries=[],r=>r.schemaVersion=2,r=>r.entries[0].giftTradeIds=[],r=>r.entries.push({...r.entries[0]}),r=>r.entries[0].authorizationRef='']){
  const r=registry();change(r);assert.throws(()=>validateManagementRegistry(r));assert.equal(status(query(),r),'unknown');
 }
 assert.deepEqual(Object.keys(core.status({query:query(),registry:registry(),ready:true})),['state']);
});
test('query parsing is bounded, exact and contains selectors only, not a new approval or monthly-gift claim',()=>{
 assert.deepEqual(core.parse(JSON.stringify(query())),query());
 for(const input of ['PRIVATE_CANARY invalid JSON','{}',JSON.stringify({...query(),approved:true}),JSON.stringify({...query(),monthlyGiftEvidence:true}),JSON.stringify({...query(),date:'2026-10-29'}),JSON.stringify({...query(),portfolioId:1}),JSON.stringify({...query(),holdingId:'11'}),JSON.stringify(query()).replace('"tradeId":22','"tradeId":22,"tradeId":22'),' '.repeat(2049)])
  assert.throws(()=>core.parse(input),{message:'GIFT_QUERY_INVALID'});
});
const live=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('./fixtures/fee-gift-registry-status-index.html',import.meta.url),'utf8');
const section=(s,a,b)=>s.slice(s.indexOf(a),s.indexOf(b)+b.length);
const factory=section(html,'/* fee-gift-registry-status:start */','/* fee-gift-registry-status:end */');
const controller=section(html,'/* fee-gift-registry-controller:start */','/* fee-gift-registry-controller:end */');
test('new UI is exact embedded code; support-stage old UI is explicitly absent and cannot be the recovery UI',()=>{
 assert.ok(factory.includes(createFeeGiftRegistryStatusCore.toString()));
 const expected=crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob '+Buffer.byteLength(html)+'\0'),Buffer.from(html)])).digest('hex');
 const source=fs.readFileSync(new URL('./fee-report-producer.mjs',import.meta.url),'utf8');assert.ok(source.includes("const RECOVERY_UI_BLOB='"+expected+"'"));
 const liveSha=crypto.createHash('sha256').update(live).digest('hex');
 if(live===html){assert.ok(live.includes('id="giftRegistryCheck"'));assert.ok(live.includes('renderGiftRegistryStatus(documentsAuthorized'))}
 else if(['de3ac592f57c314bf94092d99fa43f9e7c0f273b50a1261b66df1c2d8211dc0d','abc5541ad27f63f9ff21de91e5645160a46e1d9ea4aa67759961cfa96cdabc34','46d397806a708522a51ecd5666f95bd39462394aad79a93afef7ff02db90fb61'].includes(liveSha)){
  // Exact display-only asset-allocation candidate; existing gift code is unchanged.
  assert.equal(section(live,'/* fee-gift-registry-status:start */','/* fee-gift-registry-status:end */'),factory);
  assert.equal(section(live,'/* fee-gift-registry-controller:start */','/* fee-gift-registry-controller:end */'),controller);
  assert.ok(live.includes('id="giftRegistryCheck"'));
  // A new page does not silently renew the already-consumed old recovery lock.
  assert.notEqual(crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob '+Buffer.byteLength(live)+'\0'),Buffer.from(live)])).digest('hex'),expected);
 }
 else{
  assert.equal(crypto.createHash('sha256').update(live).digest('hex'),'d5570720d45cf45136e3f23a15111ac01fb33f21277c46f5819aff1754eee9dc');
  assert.equal(live.includes('id="giftRegistryCheck"'),false,'old UI has no status; it is not declared compatible');
  assert.notEqual(crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob '+Buffer.byteLength(live)+'\0'),Buffer.from(live)])).digest('hex'),expected);
 }
 assert.doesNotMatch(controller,/fetch\(|setCfg\(|store\.|localStorage|sessionStorage|cfg\(|K\.(key|tok)|\.submit\(/);
});
function page(){
 const nodes=Object.fromEntries(['giftRegistryCheck','giftRegistryState','giftRegistryNote','giftRegistryPick','giftRegistryQueryFile'].map(id=>[id,{hidden:true,textContent:'',disabled:true,value:'',click(){this.clicked=true;}}]));
 const context={document:{getElementById:id=>nodes[id]},manager:true,authorized:true,_sourceEpoch:1,_receiptSource:{state:'verified'},DAILY:{managementExemptionRegistry:registry()},
  isMgr(){return context.manager;},managerDocumentsAuthorized(){return context.authorized;},sourceMatches(){return true;}};
 vm.createContext(context);vm.runInContext(factory+"\nlet _giftRegistryQuery=null,_giftRegistryReady=false,_giftRegistryEpoch=-1,_giftRegistryTicket=0,_giftRegistryReportDate=null,_giftRegistryInput=null,_giftRegistryRulesText=null;\n"+controller,context);
 return {context,nodes,render:(a=true,v=true,date="2026-10-23")=>vm.runInContext(`renderGiftRegistryStatus(${a},${v},${JSON.stringify(date)})`,context),
  async load(text=JSON.stringify(query()),size=text.length){const input={files:[{size,text:async()=>text}],value:'selected'};await context.readGiftRegistryQuery({target:input});return input;}};
}
test('normal manager UI reveals only a short state and clears selectors on role/source changes',async()=>{
 const p=page();p.render();assert.equal(p.nodes.giftRegistryState.textContent,'本报告赠股登记：未知');
 const input=await p.load();assert.equal(input.value,'');assert.equal(p.nodes.giftRegistryState.textContent,'本报告赠股登记：匹配');assert.equal(p.nodes.giftRegistryNote.textContent,'报告截至 2026-10-23 · 核对目标 2026-10-28 · 非交易验收');
 p.context.DAILY.managementExemptionRegistry.entries[0].giftTradeIds=[23];p.render();assert.equal(p.nodes.giftRegistryState.textContent,'本报告赠股登记：未知');await p.load();assert.equal(p.nodes.giftRegistryState.textContent,'本报告赠股登记：未匹配');
 p.context.DAILY.managementExemptionRegistry=undefined;p.render();assert.equal(p.nodes.giftRegistryState.textContent,'本报告赠股登记：未知');
 p.context.manager=false;p.context.authorized=false;p.render(true,true);assert.equal(p.nodes.giftRegistryCheck.hidden,true);assert.equal(p.nodes.giftRegistryState.textContent,'本报告赠股登记：未知');
 p.context.manager=true;p.context.authorized=true;p.context.DAILY.managementExemptionRegistry=registry();p.render();assert.equal(p.nodes.giftRegistryState.textContent,'本报告赠股登记：未知');
 await p.load();vm.runInContext('clearGiftRegistryCheck();++_sourceEpoch;',p.context);assert.equal(p.nodes.giftRegistryState.textContent,'本报告赠股登记：未知');
});
test('unverified, malformed, oversized and stale async query reads never display false matches or write state',async()=>{
 const p=page();p.render(false,true);let read=false;await p.context.readGiftRegistryQuery({target:{files:[{size:2,text:async()=>{read=true;return '{}';}}],value:''}});assert.equal(read,false);
 p.render();await p.load('PRIVATE_CANARY malformed');assert.equal(p.nodes.giftRegistryState.textContent,'本报告赠股登记：未知');
 await p.load(JSON.stringify(query()),2049);assert.equal(p.nodes.giftRegistryState.textContent,'本报告赠股登记：未知');
 let finish;const input={files:[{size:100,text:()=>new Promise(r=>{finish=r;})}],value:'selected'};
 const pending=p.context.readGiftRegistryQuery({target:input});p.context.authorized=false;p.context.manager=false;finish(JSON.stringify(query()));await pending;
 assert.equal(p.nodes.giftRegistryState.textContent,'本报告赠股登记：未知');assert.equal(input.value,'');
 assert.deepEqual(p.context.DAILY.managementExemptionRegistry,registry());
});

test('new query immediately clears the old match, and report/source input changes invalidate it without a new source read',async()=>{
 const p=page();p.render();await p.load();assert.equal(p.nodes.giftRegistryState.textContent,'本报告赠股登记：匹配');
 let finish;const input={files:[{size:100,text:()=>new Promise(r=>{finish=r;})}],value:'selected'};
 const pending=p.context.readGiftRegistryQuery({target:input});
 assert.equal(p.nodes.giftRegistryState.textContent,'本报告赠股登记：未知');
 assert.equal(p.nodes.giftRegistryNote.textContent,'报告截至 2026-10-23 · 核对目标 未选择 · 非交易验收');
 finish(JSON.stringify({...query(),tradeId:23}));await pending;
 assert.equal(p.nodes.giftRegistryState.textContent,'本报告赠股登记：未匹配');assert.equal(input.value,'');
 await p.load();p.context.DAILY={managementExemptionRegistry:registry()};p.render();assert.equal(p.nodes.giftRegistryState.textContent,'本报告赠股登记：未知');
 await p.load();p.render(true,true,'2026-10-24');assert.equal(p.nodes.giftRegistryState.textContent,'本报告赠股登记：未知');
 assert.equal(p.nodes.giftRegistryNote.textContent,'报告截至 2026-10-24 · 核对目标 未选择 · 非交易验收');
 await p.load();++p.context._sourceEpoch;p.render();assert.equal(p.nodes.giftRegistryState.textContent,'本报告赠股登记：未知');
 p.render(true,true,null);assert.equal(p.nodes.giftRegistryState.textContent,'本报告赠股登记：未知');assert.equal(p.nodes.giftRegistryPick.disabled,true);
 assert.equal(p.nodes.giftRegistryNote.textContent,'报告截至 未核验 · 核对目标 未选择 · 非交易验收');
});
