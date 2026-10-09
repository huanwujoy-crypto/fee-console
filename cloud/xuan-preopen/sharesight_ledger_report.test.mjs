import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {runSharesightLedgerReport,runLedgerReadback,loadProductionProfile} from './sharesight_ledger_report.mjs';
import {runDaily} from './daily.mjs';import {collectDelivery} from './delivery.mjs';import {collectLimitedDelivery} from './limited_delivery.mjs';import {publishPrepared} from './publish.mjs';
import {LEDGER_PROFILE,PROFILE_PATH,profileBlob,validateLedgerPublication,validateLedgerReceipt} from '../../scripts/xuan-ib-night-action-ledger-view.mjs';
import {extractNightActionModel,renderNightActionReport} from '../../scripts/xuan-ib-night-action-view.mjs';
import {validateNightActionHtml} from '../../scripts/xuan-ib-night-action-guard.mjs';
import {associationPolicyBlob} from '../../scripts/xuan-ib-account-association.mjs';
import {fixture,prepared,clock,stamp,date,sourceDate} from './sharesight_ledger_fixtures.mjs';
const guard=(f)=>({snapshot:f.context.association,previousSourceSha:f.context.previousSourceSha,now:clock,profile:f.profile});
test('one fixed GET produces only partial Sharesight valuation/classification; no IB, cash, details or actions',async()=>{
 const {f,html,receipt,model}=await prepared();assert.equal(f.calls.length,1);
 const {url,options}=f.calls[0],u=new URL(url);assert.equal(u.pathname,'/v1/performance');assert.deepEqual(Object.fromEntries(u.searchParams),{portfolio:'IB-HK',start_date:sourceDate,end_date:sourceDate,grouping:'83569',include_sales:'false'});
 assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(receipt.status,'partial');assert.equal(receipt.sourceReadStatus,'complete');assert.equal(receipt.syncCompletion,'unverified');assert.equal(receipt.sourceCount,1);
 assert.deepEqual(validateNightActionHtml(html,date,guard(f)),{dataDate:date,status:'partial',orderCount:null,ordersVerified:false});assert.equal(model.cashReconciliation,'pending');
 for(const key of ['sync','cash','trades','orders','buyingPower','holdingsDetails','returns','action'])assert.equal(model.capabilities[key],false);
 for(const field of ['cash','orders','positions','replenishment','projection'])assert.equal(Object.hasOwn(model,field),false);
 for(const value of ['SYNTHETIC-READ-TOKEN','CSPX','GOOG','EXUS','EIMI','0.01','-0.01'])assert.ok(!html.includes(value));
 assert.ok(html.includes('本轮同步完成未核'));assert.ok(html.includes('现金对账仍待核对'));assert.ok(html.includes('未取得不表示为零'));
});
test('trusted profile selection is explicit before source identity; no catch-to-IB or catch-to-normal',async()=>{
 for(const profile of ['normal','unknown',null]){const f=fixture();f.options.loadProfile=async()=>({...f.profile,profile});await assert.rejects(runSharesightLedgerReport(f.options));assert.equal(f.calls.length,0);assert.equal(f.saved.length,0);}
 const f=fixture();f.options.fetchImpl=async()=>{throw Error('PRIVATE-AMOUNT-TOKEN-CANARY');};await assert.rejects(runSharesightLedgerReport(f.options),/^Error: SHARESIGHT_LEDGER_READ_FAILED$/);assert.equal(f.saved.length,0);
});
test('same worker daily chooses ledger profile without reading IB store and keeps immutable daily start ordering',async()=>{
 const f=fixture();await runDaily({io:f.io,now:f.now,loadProfile:f.loadProfile,execution:'xuan-preopen-report-test',generate:()=>{throw Error('FULL_MUST_NOT_RUN');},generateLedger:args=>runSharesightLedgerReport({...args,fetchImpl:f.fetchImpl})});
 assert.equal(f.saved[0].name,`delivery/${date}/start.json`);assert.deepEqual(f.saved.slice(-2).map(s=>s.name),[`delivery/${date}/report.html`,`delivery/${date}/receipt.json`]);assert.equal(f.saved.at(-1).value.status,'partial');assert.equal(f.calls.length,1);
 const blocked=fixture();blocked.io.savePrivate=async()=>{throw Error('CLOUD_HTTP_412');};await assert.rejects(runDaily({io:blocked.io,now:blocked.now,loadProfile:blocked.loadProfile,execution:'xuan-preopen-report-test',generateLedger:args=>runSharesightLedgerReport({...args,fetchImpl:blocked.fetchImpl})}),/412/);assert.equal(blocked.calls.length,0);
});
test('controlled today readback creates separate delivery artifacts, never touches failed daily start/receipt',async()=>{
 const f=fixture(),result=await runLedgerReadback({io:f.io,now:f.now,loadProfile:f.loadProfile,execution:'xuan-preopen-report-test',generate:args=>runSharesightLedgerReport({...args,fetchImpl:f.fetchImpl})});
 assert.match(result.prefix,new RegExp(`^delivery/${date}/ledger-view-[a-f0-9]{64}/$`));assert.equal(f.calls.length,1);assert.equal(result.syncCompletion,'unverified');
 assert.ok(f.saved.every(s=>s.name!==`delivery/${date}/start.json`&&s.name!==`delivery/${date}/receipt.json`&&s.name!==`delivery/${date}/report.html`));
 assert.deepEqual(f.saved.slice(-2).map(s=>s.name),[result.prefix+'report.html',result.prefix+'receipt.json']);
});
test('fixed source scope/date/classification and calendar invalidity fail closed without artifact creation',async()=>{
 for(const change of [r=>r.mode='write',r=>r.source='other',r=>r.report.portfolio_id=1,r=>r.report.currency.code='EUR',r=>r.report.custom_group.id=1,r=>r.report.end_date='2026-10-07',r=>r.report.holdings[0].group_name='unknown']){
  const f=fixture();change(f.raw);await assert.rejects(runSharesightLedgerReport(f.options));assert.equal(f.saved.length,0);
 }
 for(const [day,target] of [['2026-10-03',sourceDate],[date,'2026-10-07']]){const f=fixture();f.options.now=()=>Date.parse(day+'T05:00:00Z');f.options.sourceDate=target;await assert.rejects(runSharesightLedgerReport(f.options));assert.equal(f.calls.length,0);}
});
test('expired/revoked account association, changed policy/profile/main/anchor and queued stale capture never create success',async()=>{
 for(const mutate of [p=>p.profile='normal',p=>p.profileBlob='c'.repeat(40),p=>p.context.association.policy.status='revoked',p=>p.context.previousSourceSha='d'.repeat(40),p=>p.context.association.policyCommit='e'.repeat(40)]){
  const f=fixture();let reads=0;f.options.loadProfile=async()=>{const p=structuredClone(f.profile);if(++reads===2)mutate(p);return p;};await assert.rejects(runSharesightLedgerReport(f.options));assert.equal(f.saved.length,0);
 }
 const {f,model}=await prepared();assert.throws(()=>validateLedgerPublication(model,{...guard(f),now:clock+1800001}));
 const expired=fixture();expired.context.association.policy.expiresAt='2026-10-08T05:00:00.000Z';await assert.rejects(runSharesightLedgerReport(expired.options));assert.equal(expired.calls.length,0);
});
test('report source receipt cannot be relabeled into normal/limited/intraday or sync-complete and public abilities cannot expand',async()=>{
 const {f,html,receipt,model}=await prepared();
 for(const mode of ['private_report_check','private_limited_readback','private_intraday_update','private_basis_snapshot_check']){let calls=0;await assert.rejects(publishPrepared({html,receipt:{...receipt,mode},now:f.now,request:async()=>{calls++;},loadContext:async()=>f.context}));assert.equal(calls,0);}
 for(const mutate of [m=>m.capabilities.cash=true,m=>m.capabilities.action=true,m=>m.syncCompletion='complete',m=>m.cashReconciliation='matched',m=>m.orders=[],m=>m.cash={amount:0},m=>m.allocation.categories[0].projectedMarketValue=450,m=>m.status='ready']){const m=structuredClone(model);mutate(m);assert.throws(()=>renderNightActionReport(m));}
 assert.throws(()=>validateLedgerReceipt({...receipt,syncCompletion:'complete'},model));
});
test('daily delivery and fixed private prefix GET collector authenticate partial type instead of treating it as complete',async()=>{
 const {f,html,receipt,model}=await prepared();const delivery={...receipt,artifact:{...receipt.artifact,privateObject:`delivery/${date}/report.html`}};
 const requests=[];const r=await collectDelivery({now:f.now,loadProfile:f.loadProfile,loadContext:async()=>f.context,request:async(url)=>{requests.push(url);return url.includes('receipt.json')?JSON.stringify(delivery):html;}});
 assert.equal(r.outcome,'reused');assert.equal(r.receipt.status,'partial');assert.equal(requests.length,2);
 const prefix=`delivery/${date}/ledger-view-${model.evidenceSha256}/`,calls=[];
 const selected=await collectLimitedDelivery({prefix,token:'synthetic-google',now:f.now,loadProfile:f.loadProfile,fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(url.includes('receipt.json')?JSON.stringify({...receipt,artifact:{...receipt.artifact,privateObject:prefix+'report.html'}}):html);}});
 assert.equal(selected.outcome,'sharesight-ledger-view');assert.equal(calls.length,2);assert.ok(calls.every(c=>!c.options.method||c.options.method==='GET'));
 for(const bad of [prefix.replace(date,'2026-10-08'),prefix+'../',prefix.replace('ledger-view','limited-readback')]){let count=0;await assert.rejects(collectLimitedDelivery({prefix:bad,token:'synthetic-google',now:f.now,loadProfile:f.loadProfile,fetchImpl:async()=>{count++;return new Response('bad');}}));if(!bad.includes('limited-readback'))assert.equal(count,0);}
});
test('publisher rechecks current approved profile/account/anchor before branch and signed candidate mutations',async()=>{
 const {f,html,receipt}=await prepared(),calls=[];
 const request=async payload=>{calls.push(payload);if(payload.query.startsWith('query'))return {data:{viewer:{login:'huanwujoy-crypto'},repository:{id:'repo',ref:{target:{oid:'a'.repeat(40)}}}}};if(payload.query.includes('CreateRef'))return {data:{createRef:{ref:{name:payload.variables.input.name,target:{oid:'a'.repeat(40)}}}}};return {data:{createCommitOnBranch:{commit:{oid:'f'.repeat(40)},ref:{name:payload.variables.input.branch.branchName}}}};};
 const result=await publishPrepared({html,receipt,now:f.now,loadProfile:f.loadProfile,loadContext:async()=>f.context,request});assert.equal(result.publication,'candidate-only');assert.equal(calls.length,3);assert.deepEqual(calls[2].variables.input.fileChanges.additions.map(v=>v.path),['xuan-ib/index.html']);
 for(const change of [r=>r.profileBlob='e'.repeat(40),r=>r.sources[0].rawFingerprint='f'.repeat(64),r=>r.sources[0].sha256='bad',r=>r.sourceReadStatus='sync-complete']){const bad=structuredClone(receipt);change(bad);let writes=0;await assert.rejects(publishPrepared({html,receipt:bad,now:f.now,loadProfile:f.loadProfile,loadContext:async()=>f.context,request:async()=>{writes++;}}));assert.equal(writes,0);}
});
test('production profile comes only from fixed current-main commit and strictly validated small JSON',async()=>{
 const f=fixture(),urls=[];const p=await loadProductionProfile({now:f.now,loadContext:async()=>f.context,fetchImpl:async(url,options)=>{urls.push({url,options});return new Response(f.text);}});
 assert.equal(p.profile,LEDGER_PROFILE);assert.equal(urls[0].url,`https://raw.githubusercontent.com/huanwujoy-crypto/fee-console/${'a'.repeat(40)}/${PROFILE_PATH}`);assert.equal(urls[0].options.method,'GET');
 for(const text of ['{}',JSON.stringify({...f.config,approved:true}),JSON.stringify({...f.config,profile:'unknown'}),'x'.repeat(16385)])await assert.rejects(loadProductionProfile({now:f.now,loadContext:async()=>f.context,fetchImpl:async()=>new Response(text)}));
});

test('publisher refuses nondeterministic or altered financial projection before any GitHub mutation',async()=>{
 const {f,html,receipt,model}=await prepared();
 const altered=structuredClone(model);altered.allocation.total*=2;for(const r of altered.allocation.categories)r.marketValue*=2;
 for(const badHtml of [html+'<p>UNAPPROVED-CONTENT</p>',renderNightActionReport(altered)]){
  let writes=0;const r={...receipt,artifact:{...receipt.artifact,sha256:hashForTest(badHtml)}};
  await assert.rejects(publishPrepared({html:badHtml,receipt:r,now:f.now,loadProfile:f.loadProfile,loadContext:async()=>f.context,request:async()=>{writes++;}}));assert.equal(writes,0);
 }
});
function hashForTest(value){return crypto.createHash('sha256').update(value).digest('hex');}
test('publisher rejects same-day higher evidence before branch creation and policy revocation before commit',async()=>{
 const {f,html,receipt}=await prepared();
 const context={...f.context,previousHtml:'<span class="date">2026-10-09 · 睡前版</span>'};let writes=0;
 await assert.rejects(publishPrepared({html,receipt,now:f.now,loadProfile:f.loadProfile,loadContext:async()=>context,request:async()=>{writes++;}}),/HIGHER_EVIDENCE_REPORT_EXISTS/);assert.equal(writes,0);
 for(const kind of ['association','profile']){
  const calls=[];let contextReads=0,profileReads=0;
  const request=async payload=>{calls.push(payload);if(payload.query.startsWith('query'))return {data:{viewer:{login:'huanwujoy-crypto'},repository:{id:'repo',ref:{target:{oid:'a'.repeat(40)}}}}};if(payload.query.includes('CreateRef'))return {data:{createRef:{ref:{name:payload.variables.input.name,target:{oid:'a'.repeat(40)}}}}};throw Error('CREATE_COMMIT_MUST_NOT_RUN');};
  const loadContext=async()=>{const c=structuredClone(f.context);if(++contextReads===2&&kind==='association')c.association.policy.status='revoked';return c;};
  const loadProfile=async()=>{const p=structuredClone(f.profile);if(++profileReads===2&&kind==='profile')p.profile='normal';return p;};
  await assert.rejects(publishPrepared({html,receipt,now:f.now,loadContext,loadProfile,request}));
  assert.equal(calls.length,2);assert.ok(calls[1].query.includes('CreateRef'));assert.ok(!calls.some(p=>p.query.includes('CreateCommitOnBranch')));
 }
});
