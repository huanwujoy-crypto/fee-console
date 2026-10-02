import test from 'node:test';import assert from 'node:assert/strict';
import {collectDelivery,deliveryTransport} from './delivery.mjs';import {statusFixture} from './test_fixtures.mjs';
const JOB='projects/family-portfolio-gateway/locations/asia-east2/jobs/xuan-preopen-report';
function response(f,url){if(url.includes('receipt.json'))return JSON.stringify(f.receipt);if(url.includes('report.html'))return f.html;return null;}
test('completed status is validated against real slot/policy/hash and exposes no action',async()=>{
 const f=statusFixture(),r=await collectDelivery({now:f.now,request:async(url,options={})=>{assert.notEqual(options.method,'POST');return response(f,url);},loadContext:async()=>f.context});assert.equal(r.outcome,'data-not-ready');assert.equal(r.html,f.html);
});
test('one run, exact execution, completion LAST; never duplicate a pending start',async()=>{
 for(const pending of [false,true]){const f=statusFixture();let reads=0,runs=0;const r=await collectDelivery({now:f.now,loadContext:async()=>f.context,request:async(url,options={})=>{
 if(options.method==='POST'){runs++;return JSON.stringify({metadata:{name:JOB+'/executions/test-run'}});}
 if(url.includes('/executions/'))return JSON.stringify({completionTime:'done',succeededCount:1,taskCount:1});
 if(url.includes('receipt.json'))return ++reads===1?null:JSON.stringify(f.receipt);
 if(url.includes('start.json'))return pending?JSON.stringify({...f.receipt,execution:'xuan-preopen-report-test'}):null;return f.html;}});assert.equal(r.outcome,'data-not-ready');assert.equal(runs,pending?0:1);}
});
test('prior non-action allows at most three create-only timed attempts, never deletes a lock',async()=>{
 const earlier=statusFixture(),f=statusFixture(Date.parse('2026-10-05T06:11:00Z'));let runs=0,reads=0;
 const r=await collectDelivery({now:f.now,loadContext:async()=>f.context,request:async(url,options={})=>{
 assert.notEqual(options.method,'DELETE');if(options.method==='POST'){runs++;return JSON.stringify({metadata:{name:JOB+'/executions/test-run'}});}
 if(url.includes('/executions/'))return JSON.stringify({completionTime:'done',succeededCount:1,taskCount:1});
 if(url.includes('retry-1%2Freceipt.json'))return ++reads===1?null:JSON.stringify(f.receipt);
 if(url.includes('receipt.json'))return JSON.stringify(earlier.receipt);if(url.includes('start.json'))return null;return f.html;}});
 assert.equal(r.outcome,'data-not-ready');assert.equal(runs,1);
});
test('stale, old-root, wrong-slot/hash/policy and unknown account never become published status',async()=>{
 for(const modify of [f=>delete f.receipt.slotId,f=>f.receipt.sourceDate='2026-10-01',f=>f.receipt.artifact.sha256='f'.repeat(64),f=>f.context.previousSourceSha='e'.repeat(40),f=>f.receipt.reasonCodes=['UNKNOWN'],f=>f.receipt.status='ready']){
 const f=statusFixture();modify(f);await assert.rejects(collectDelivery({now:f.now,request:async url=>response(f,url),loadContext:async()=>f.context}));}
});
test('holiday/early/wrong season/late never access cloud; transport 403 never means missing',async()=>{
 for(const time of ['2026-12-25T06:00:00Z','2026-10-05T05:59:59Z','2026-10-26T06:10:00Z','2026-10-05T07:00:00Z']){const r=await collectDelivery({now:()=>Date.parse(time),request:async()=>{throw Error('must not call');}});assert.ok(['no-action','outside-window'].includes(r.outcome));}
 const old=global.fetch;global.fetch=async()=>new Response('denied',{status:403});try{await assert.rejects(deliveryTransport('fixture')('https://storage.googleapis.com/',{missing:true}),/HTTP_403/);}finally{global.fetch=old;}
});
test('failed execution stops without retries or old-public substitution',async()=>{const f=statusFixture();let runs=0;await assert.rejects(collectDelivery({now:f.now,request:async(url,options={})=>{if(options.method==='POST'){runs++;return JSON.stringify({metadata:{name:JOB+'/executions/test-run'}});}if(url.includes('/executions/'))return JSON.stringify({failedCount:1});return null;}}),/EXECUTION_FAILED/);assert.equal(runs,1);});
test('a completed failed older attempt permits the next finite attempt, a pending one never does',async()=>{
 const f=statusFixture(Date.parse('2026-10-05T06:11:00Z'));let runs=0,reads=0;
 const r=await collectDelivery({now:f.now,loadContext:async()=>f.context,request:async(url,options={})=>{
 if(options.method==='POST'){runs++;return JSON.stringify({metadata:{name:JOB+'/executions/new-run'}});}
 if(url.endsWith('/executions/xuan-preopen-report-old-run'))return JSON.stringify({failedCount:1,completionTime:'done'});
 if(url.includes('/executions/new-run'))return JSON.stringify({completionTime:'done',succeededCount:1,taskCount:1});
 if(url.includes('retry-1%2Freceipt.json'))return ++reads===1?null:JSON.stringify(f.receipt);
 if(url.includes('receipt.json'))return null;if(url.includes('retry-1%2Fstart.json'))return null;
 if(url.includes('start.json'))return JSON.stringify({...f.receipt,attempt:0,execution:'xuan-preopen-report-old-run'});return f.html;}});
 assert.equal(r.outcome,'data-not-ready');assert.equal(runs,1);
});
