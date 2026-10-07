import test from 'node:test';import assert from 'node:assert/strict';
import {destinationTradeLink,sealTradeLinks,openTradeLinks} from './fee-runtime-evidence.mjs';
import {resolveFeeSessionTarget} from './fee-session-target.mjs';
import {validateHealth} from './fee-data-health.mjs';
const c={targetDate:'2026-10-06',dataSha256:'a'.repeat(64)},key=Buffer.alloc(32,1);
test('destination association is encrypted, source-bound and never whole-day completion',()=>{
 const links=[destinationTradeLink({targetDate:c.targetDate,cashRecord:{id:1,amount:12},trade:{id:2,brokerage:1}})],e=sealTradeLinks(links,c,key);
 assert.deepEqual(openTradeLinks(e,c,key),links);assert.equal(links[0].wholeDayComplete,false);assert.equal(links[0].actualFeeStatus,'DESTINATION_MATCHED_ONLY');
 for(const context of [{...c,targetDate:'2026-10-05'},{...c,dataSha256:'b'.repeat(64)}])assert.throws(()=>openTradeLinks(e,context,key));
 assert.throws(()=>openTradeLinks(e,c,Buffer.alloc(32,2)));assert.throws(()=>sealTradeLinks([...links,...links],c,key));
 const h={schema:'fee-console.daily-health.v1',checkedAt:'2026-10-07T03:00:00Z',targetDate:c.targetDate,sourceDates:{schwab:c.targetDate,webull:c.targetDate,benchmark:c.targetDate},outcome:'updated',dataSha256:c.dataSha256,errorCode:null};
 const now=new Date(h.checkedAt);assert.deepEqual(validateHealth(h,{now}),[]);assert.deepEqual(validateHealth({...h,tradeLinkBinding:e},{now}),[]);assert.ok(validateHealth({...h,tradeLinkBinding:{...e,extra:'secret'}},{now}).length);assert.ok(validateHealth({...h,unknown:true},{now}).length);
});
test('early target reuses reviewed NYSE calendar independent of benchmark and IB',async()=>{
 assert.equal((await resolveFeeSessionTarget(new Date('2026-10-07T03:00:00Z'))).targetDate,'2026-10-06');
 assert.equal((await resolveFeeSessionTarget(new Date('2026-09-08T03:00:00Z'))).targetDate,'2026-09-04');
 await assert.rejects(resolveFeeSessionTarget(new Date('2026-10-06T20:00:00Z')),/NOT_CLOSED/);
 await assert.rejects(resolveFeeSessionTarget(new Date('2029-01-03T03:00:00Z')),/CALENDAR/);
});

import {feePublicAcceptance} from './fee-public-acceptance.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
test('post-promotion acceptance never reports stale Pages as complete and uses fixed anonymous GET',async()=>{
 const bytes=Buffer.from('encrypted synthetic'),health={targetDate:c.targetDate,dataSha256:crypto.createHash('sha256').update(bytes).digest('hex'),outcome:'updated',sourceDates:{schwab:c.targetDate,webull:c.targetDate,benchmark:c.targetDate}},calls=[];
 const fetchImpl=async(url,opt)=>{calls.push({url,opt});return new Response(url.endsWith('data.json')&&!url.endsWith('health.json')?bytes:JSON.stringify(health));};
 assert.equal((await feePublicAcceptance({mainHealth:health,mainBytes:bytes,fetchImpl,attempts:1})).state,'PUBLIC_BYTES_VERIFIED');
 assert.ok(calls.every(x=>x.url.startsWith('https://huanwujoy-crypto.github.io/fee-console/')&&!x.opt.headers&&x.opt.redirect==='error'));
 const pending=await feePublicAcceptance({mainHealth:health,mainBytes:bytes,fetchImpl:async()=>new Response('wrong'),attempts:1});assert.equal(pending.state,'PUBLIC_BYTES_PENDING');
});
test('current producer and both protected workflows execute preflight without new authority',()=>{
 for(const file of ['fee-cloud-producer','validate-fee-data','promote-fee-data']){const text=fs.readFileSync(new URL('../.github/workflows/'+file+'.yml',import.meta.url),'utf8');assert.match(text,/node scripts\/fee-offline-preflight.mjs/);assert.doesNotMatch(text,/FEE_BROKER_COMPLETENESS_ENABLED:.*true/);}
 const producer=fs.readFileSync(new URL('../scripts/fee-cloud-producer.mjs',import.meta.url),'utf8');assert.match(producer,/sealTradeLinks\(input.tradeLinkReceipts/);assert.match(producer,/latestCommonBenchmarkDate\(cache\)/);
});

test('candidate preflight follows existing provenance gates; protected public check retains failure status',()=>{
 const v=fs.readFileSync(new URL('../.github/workflows/validate-fee-data.yml',import.meta.url),'utf8');assert.ok(v.indexOf('Run credential-free fee chain preflight')>v.indexOf('Verify amount-free run receipt and outcome'));
 const p=fs.readFileSync(new URL('../.github/workflows/promote-fee-data.yml',import.meta.url),'utf8');assert.match(p,/set -euo pipefail\n          node scripts\/fee-public-acceptance/);
});
