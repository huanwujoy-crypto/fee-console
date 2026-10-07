import test from 'node:test';import assert from 'node:assert/strict';
import {destinationTradeLink,sealTradeLinks,openTradeLinks,canonicalTradeId} from './fee-runtime-evidence.mjs';
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
test('production stages retain actual contracts instead of repeatedly running synthetic regression',()=>{
 for(const file of ['fee-cloud-producer','validate-fee-data','promote-fee-data']){const text=fs.readFileSync(new URL('../.github/workflows/'+file+'.yml',import.meta.url),'utf8');assert.doesNotMatch(text,/node scripts\/fee-offline-preflight.mjs/);assert.doesNotMatch(text,/FEE_BROKER_COMPLETENESS_ENABLED:.*true/);}
 const producer=fs.readFileSync(new URL('../scripts/fee-cloud-producer.mjs',import.meta.url),'utf8');assert.match(producer,/sealTradeLinks\(input.tradeLinkReceipts/);assert.match(producer,/latestCommonBenchmarkDate\(cache\)/);
});

test('existing provenance gates remain; protected public check retains failure status',()=>{
 const v=fs.readFileSync(new URL('../.github/workflows/validate-fee-data.yml',import.meta.url),'utf8');assert.match(v,/Verify GitHub identity and signature/);assert.match(v,/Verify amount-free run receipt and outcome/);assert.doesNotMatch(v,/synthetic|offline-preflight/);
 const p=fs.readFileSync(new URL('../.github/workflows/promote-fee-data.yml',import.meta.url),'utf8');assert.match(p,/set -euo pipefail\n          node scripts\/fee-public-acceptance/);
});

import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
test('actual selected SHA fixes Pages inputs after a different rejected trailing branch overwrites loop scratch',()=>{
 const workflow=fs.readFileSync(new URL('../.github/workflows/promote-fee-data.yml',import.meta.url),'utf8');
 const start=workflow.indexOf('          candidate_sha=$(git rev-parse "${candidates[0]}")');
 const end=workflow.indexOf('      - name: Fast-forward main',start);assert.ok(start>=0&&end>start);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-selected-sha-'));
 const git=(...args)=>{const r=spawnSync('git',args,{cwd:dir,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 try{
  git('init','-q');git('config','user.name','Synthetic Test');git('config','user.email','synthetic@example.invalid');
  const checkedAt=new Date().toISOString(),targetDate=new Date(Date.now()-86400000).toISOString().slice(0,10);
  const make=(label,outcome)=>{const bytes=Buffer.from(JSON.stringify({synthetic:label}));const health={schema:'fee-console.daily-health.v1',checkedAt,targetDate,sourceDates:{schwab:targetDate,webull:targetDate,benchmark:targetDate},outcome,dataSha256:crypto.createHash('sha256').update(bytes).digest('hex'),errorCode:null};fs.writeFileSync(path.join(dir,'data.json'),bytes);fs.writeFileSync(path.join(dir,'fee-data-health.json'),JSON.stringify(health));git('add','.');git('commit','-qm',label);return {sha:git('rev-parse','HEAD'),bytes,health};};
  const base=make('base','updated');
  const selected=make('selected-valid','updated');git('branch','accepted',selected.sha);
  git('checkout','-q',base.sha);const rejected=make('last-rejected','failed');git('branch','trailing-rejected',rejected.sha);
  assert.notEqual(selected.sha,rejected.sha);assert.notEqual(selected.health.dataSha256,rejected.health.dataSha256);
  // Reproduce two enumerated branches writing shared scratch; only the first is accepted.
  for(const branch of ['accepted','trailing-rejected'])for(const [source,dest] of [['data.json','candidate-data.json'],['fee-data-health.json','candidate-health.json']])fs.writeFileSync(path.join(dir,dest),git('show',branch+':'+source));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'candidate-health.json'))).dataSha256,rejected.health.dataSha256);
  const validator=new URL('./fee-data-health.mjs',import.meta.url).pathname;
  const shell='set -euo pipefail\ncandidates=(accepted)\nbase_sha='+base.sha+'\nnode(){ "$TEST_NODE" "$TEST_VALIDATOR" "${@:2}"; }\n'+workflow.slice(start,end);
  const r=spawnSync('bash',['-c',shell],{cwd:dir,encoding:'utf8',env:{...process.env,RUNNER_TEMP:dir,GITHUB_OUTPUT:path.join(dir,'output'),TEST_NODE:process.execPath,TEST_VALIDATOR:validator}});
  assert.equal(r.status,0,r.stderr);assert.match(fs.readFileSync(path.join(dir,'output'),'utf8'),new RegExp('sha='+selected.sha+'\\n'));
  assert.deepEqual(fs.readFileSync(path.join(dir,'selected-candidate-data.json')),selected.bytes);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'selected-candidate-health.json'))),selected.health);
  assert.match(workflow,/fee-public-acceptance.mjs "\$RUNNER_TEMP\/selected-candidate-health.json" "\$RUNNER_TEMP\/selected-candidate-data.json"/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('every padded encrypted association envelope has identical shape and length for zero, one or 500 links',()=>{
 const make=n=>Array.from({length:n},(_,i)=>destinationTradeLink({targetDate:c.targetDate,cashRecord:{id:i+1},trade:{id:String(i+1)}}));
 const envelopes=[0,1,500].map(n=>sealTradeLinks(make(n),c,key));assert.equal(new Set(envelopes.map(e=>e.ciphertext.length)).size,1);assert.ok(envelopes.every(e=>Object.keys(e).sort().join()==='ciphertext,schema'));
 envelopes.forEach((e,i)=>assert.deepEqual(openTradeLinks(e,c,key),make([0,1,500][i])));
 const producer=fs.readFileSync(new URL('./fee-cloud-producer.mjs',import.meta.url),'utf8');assert.doesNotMatch(producer,/if\(input.tradeLinkReceipts\?\.length\)/);assert.match(producer,/sealTradeLinks\(input.tradeLinkReceipts\|\|\[\]/);
 assert.equal(canonicalTradeId('9007199254740993'),'9007199254740993');assert.equal(canonicalTradeId(Number('9007199254740993')),null);
 assert.equal(canonicalTradeId('001'),null);assert.equal(canonicalTradeId('1e3'),null);
});

test('synthetic regression runner omits credential environment and never fabricates zero activity measurements',()=>{const text=fs.readFileSync(new URL('./fee-offline-preflight.mjs',import.meta.url),'utf8');assert.match(text,/cwd:root,env,/);assert.doesNotMatch(text,/financialNetworkReads|productionWrites|GH_TOKEN|FEE_DATA_KEY|HOME/);const ci=fs.readFileSync(new URL('../.github/workflows/scripts-check.yml',import.meta.url),'utf8');assert.match(ci,/scripts\/fee-cloud-source.test.mjs/);});
