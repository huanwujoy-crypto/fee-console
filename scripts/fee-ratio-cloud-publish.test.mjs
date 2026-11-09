// Synthetic input only; imports the existing official-source crypto fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {authenticated} from './fee-ratio-official-source.test.mjs';
import {createOfficialRatioSourceCore} from './fee-ratio-official-source.mjs';
import {createRatioCloudPublisher,RATIO_CLOUD_FILE} from './fee-ratio-cloud-publish.mjs';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const json=v=>Buffer.from(JSON.stringify(v));
const canary='SECRET_CANARY_DO_NOT_LEAK https://private.invalid/?token=not-real';
// Synthetic coordinator handoff. Its fee cutoff is deliberately not the ratio
// source date: the two reports keep their own real dates.
const FEE={mainSha:'e'.repeat(40),accountingThrough:'2026-10-27',dataSha256:'1'.repeat(64),healthSha256:'2'.repeat(64)};
const feeProofOf=(handoff,at)=>Object.freeze({schema:'synthetic',status:'FEE_FINAL_PUBLICATION_VERIFIED',accountingThrough:handoff.accountingThrough,feeMainSha:handoff.mainSha,
  runMainSha:'a'.repeat(40),dataSha256:handoff.dataSha256,healthSha256:handoff.healthSha256,verifiedAt:at.toISOString(),healthCheckedAt:'2026-10-27T22:00:00.000Z'});

async function fixture(t,{sameSource=false}={}){
  const f=await authenticated(t),raw=structuredClone(f.raw);
  if(!sameSource){raw.classification.capturedAt='2026-10-30T05:45:00.000Z';raw.exposure.capturedAt='2026-10-30T05:44:00.000Z';}
  const original=json(raw),input=json(createOfficialRatioSourceCore().build(raw,{sourceSha256:hash(original),sourceBytes:original.length}).input);
  const bundleId=hash(Buffer.concat([original,input])),prefix='inputs/'+bundleId+'/';
  const plan={mode:'publish',previousBodySha256:await f.ratio.digest(f.signed.body),bundleId,original:{name:prefix+'original.json',generation:'101',sha256:hash(original)},input:{name:prefix+'input.json',generation:'102',sha256:hash(input)},library:{fileId:'libfile_'+'9'.repeat(32),version:0},fee:{...FEE}};
  const identity={gistId:'0'.repeat(32),ownerId:42},values=new Map([[plan.original.name,original],[plan.input.name,input]]),claims=new Set();
  const state={raw:json(f.signed),revision:'a'.repeat(40),reads:0,patches:[],saved:[],deleted:[],localCleanups:0,events:[],claimCalls:0};
  const io={
    async readDestination(file){assert.equal(file,RATIO_CLOUD_FILE);state.reads++;state.events.push('read');return {id:identity.gistId,ownerId:42,authenticatedUserId:42,public:false,revision:state.revision,recipientBytes:json(f.manager.recipient),snapshotBytes:Buffer.from(state.raw)};},
    async readInput(spec){state.events.push('input');return {generation:spec.generation,bytes:Buffer.from(values.get(spec.name))};},
    async verifyFeePublication({handoff,previousProof,...rest}){state.events.push(previousProof?'fee-recheck':'fee-readback');assert.deepEqual(rest,{});assert.deepEqual(handoff,FEE);
      assert.notEqual(handoff.accountingThrough,raw.classification.asOf);return previousProof?feeProofOf(handoff,f.now):(state.firstFee=feeProofOf(handoff,f.now));},
    async claimOnce(key,body,options){state.claimCalls++;state.events.push('claim');assert.deepEqual(options,{ifGenerationMatch:0});assert.deepEqual(Object.keys(body).sort(),['bodySha256','contentSha256']);if(claims.has(key))return 'EXISTS';claims.add(key);return 'CREATED';},
    async patchSnapshot(body){state.events.push('patch');assert.deepEqual(Object.keys(body),['files']);assert.deepEqual(Object.keys(body.files),[RATIO_CLOUD_FILE]);state.patches.push(structuredClone(body));state.raw=Buffer.from(body.files[RATIO_CLOUD_FILE].content);state.revision='b'.repeat(40);},
    async saveReceipt(result){state.events.push('save:'+result.stage);state.saved.push(structuredClone(result));},
    async cleanupLocal(){state.localCleanups++;state.events.push('cleanup');},
    async deleteInputs(specs){state.deleted.push(structuredClone(specs));}
  };
  const publisher=createRatioCloudPublisher({exposureCore:f.exposure});
  const run=(overrides={})=>publisher.run({plan,identity,manager:f.manager,io,clock:()=>f.now,...overrides});
  return {...f,plan,identity,values,state,io,run,original,input};
}

test('cloud candidate reuses source verification and crypto; exactly one fixed-file PATCH and authenticated exact readback',async t=>{
  const f=await fixture(t),result=await f.run();
  assert.equal(result.status,'PUBLISHED_CONFIRMED');assert.equal(result.patchAttempts,1);assert.equal(result.cleanup,'LOCAL_AND_PINNED_INPUTS');
  assert.equal(f.state.patches.length,1);assert.equal(f.state.saved.at(-1).status,result.status);
  assert.ok(f.state.events.indexOf('save:WRITE_INTENT')<f.state.events.indexOf('patch'));
  assert.ok(f.state.events.indexOf('fee-readback')<f.state.events.indexOf('claim'));
  assert.ok(f.state.events.indexOf('fee-recheck')<f.state.events.indexOf('save:WRITE_INTENT'));
  const packet=JSON.parse(f.state.raw),verified=await f.snapshot.verify(packet,f.manager,{now:f.now});
  assert.equal(verified.watermark.version,2);assert.equal(packet.body.previousSnapshotId,f.plan.previousBodySha256);
  assert.deepEqual(verified.model.classificationSummary.totalValueUSD,f.model.classificationSummary.totalValueUSD);
  assert.equal(verified.model.feeCalculationReceipt,undefined);
  assert.deepEqual(f.state.deleted,[[f.plan.original,f.plan.input]]);
  assert.equal(f.state.localCleanups,1);
});
test('no-write compatibility only authenticates existing snapshot; no source fetch, claim or PATCH',async t=>{
  const f=await fixture(t),plan={mode:'verify-current',previousBodySha256:f.plan.previousBodySha256,bundleId:null,original:null,input:null,library:null,fee:null};
  const r=await f.run({plan});assert.equal(r.status,'VERIFIED_CURRENT_NO_WRITE');assert.equal(r.patchAttempts,0);
  assert.equal(f.state.reads,1);assert.equal(f.state.claimCalls,0);assert.ok(!f.state.events.includes('input'));assert.equal(f.state.localCleanups,1);
});
test('the already published source is not reissued as another version',async t=>{
  const f=await fixture(t,{sameSource:true}),r=await f.run();
  assert.equal(r.status,'UNCHANGED_SOURCE_NO_WRITE');assert.equal(f.state.claimCalls,0);assert.equal(f.state.patches.length,0);
});
test('unpublished fee, mismatched Pages or incomplete Jenny cannot consume ratio claim or replace valid old snapshot',async t=>{
  for(const code of ['FEE_PUBLICATION_PAGES_DATA','FEE_PUBLICATION_JENNY_RECEIPT','FEE_PUBLICATION_CUTOFF']){
    const f=await fixture(t),before=Buffer.from(f.state.raw);let checks=0;
    f.io.verifyFeePublication=async()=>{checks++;throw Error(code);};
    const r=await f.run();assert.equal(r.status,'WAITING_FEE_READBACK_NO_WRITE');assert.equal(r.stage,'FEE_READBACK:'+code);
    assert.equal(checks,1);assert.equal(r.claim,'NOT_ATTEMPTED');assert.equal(r.patchAttempts,0);assert.equal(f.state.claimCalls,0);
    assert.deepEqual(f.state.raw,before);assert.equal(f.state.deleted.length,0);
  }
});
test('fee publication changes after claim prevent PATCH and never release the consumed claim',async t=>{
  const f=await fixture(t),check=f.io.verifyFeePublication;let n=0;
  f.io.verifyFeePublication=async input=>{if(++n===2)throw Error('FEE_PUBLICATION_MAIN');return check(input);};
  const r=await f.run();assert.equal(r.status,'REFUSED');assert.equal(r.stage,'FEE_RECHECK:FEE_PUBLICATION_MAIN');assert.equal(r.claim,'OWNED');assert.equal(r.patchAttempts,0);
  f.io.verifyFeePublication=check;const retry=await f.run();assert.equal(retry.claim,'EXISTS');assert.equal(f.state.patches.length,0);
});
test('missing fee verifier fails closed while verify-current remains purely read-only',async t=>{
  const f=await fixture(t);delete f.io.verifyFeePublication;
  assert.equal((await f.run()).status,'WAITING_FEE_READBACK_NO_WRITE');assert.equal(f.state.claimCalls,0);
  const plan={mode:'verify-current',previousBodySha256:f.plan.previousBodySha256,bundleId:null,original:null,input:null,library:null,fee:null};
  assert.equal((await f.run({plan})).status,'VERIFIED_CURRENT_NO_WRITE');assert.equal(f.state.patches.length,0);
});
test('source expiry during fee readback or durable intent save prevents PATCH',async t=>{
  for(const phase of ['fee','intent']){
    const f=await fixture(t);let now=f.now;
    const facts=f.source.verifyBrowserSourceAssociations(JSON.parse(f.original),JSON.parse(f.input),{scopeHash:f.scope,now:f.now});
    const expired=new Date(Date.parse(facts.observedAt)+36*3600000+1);
    assert.ok(expired-f.now<36*3600000,'fee proof remains fresh; only ratio source expires');
    const check=f.io.verifyFeePublication,save=f.io.saveReceipt;
    f.io.verifyFeePublication=async input=>{const proof=await check(input);if(phase==='fee'&&input.previousProof)now=expired;return proof;};
    f.io.saveReceipt=async result=>{await save(result);if(phase==='intent'&&result.stage==='WRITE_INTENT')now=expired;};
    const result=await f.run({clock:()=>now});assert.equal(result.status,'REFUSED');assert.equal(result.claim,'OWNED');assert.equal(result.patchAttempts,0);assert.equal(f.state.patches.length,0);
    assert.equal(result.stage,phase==='fee'?'FEE_RECHECK':'WRITE_INTENT');
  }
});
test('fee health age alone neither blocks nor releases: the handed identity decides, ratio source expiry still applies',async t=>{
  const f=await fixture(t);let now=f.now;const check=f.io.verifyFeePublication,save=f.io.saveReceipt;
  f.io.verifyFeePublication=async input=>Object.freeze({...await check(input),healthCheckedAt:new Date(f.now.getTime()-40*3600000).toISOString()});
  f.io.saveReceipt=async result=>{await save(result);if(result.stage==='WRITE_INTENT')now=new Date(f.now.getTime()+3600000);};
  const result=await f.run({clock:()=>now});assert.equal(result.status,'PUBLISHED_CONFIRMED');assert.equal(result.patchAttempts,1);
});
test('generation, hash, original association and actual expiry failures stop before any write',async t=>{
  for(const kind of ['generation','hash','association','expiry']){
    const f=await fixture(t),read=f.io.readInput;
    if(kind==='generation')f.io.readInput=async s=>({...await read(s),generation:'999'});
    if(kind==='hash')f.values.get(f.plan.original.name)[0]^=1;
    if(kind==='association'){
      const input=JSON.parse(f.input);input.classification.totalValueUSD++;
      const b=json(input);f.values.set(f.plan.input.name,b);f.plan.input.sha256=hash(b);
    }
    const r=await f.run(kind==='expiry'?{clock:()=>new Date('2026-11-02T00:00:00.000Z')}:{});
    assert.equal(r.status,'REFUSED',kind);assert.equal(r.patchAttempts,0,kind);assert.equal(f.state.claimCalls,0,kind);
  }
});
test('wrong authenticated user, owner, visibility, recipient or prior body is rejected',async t=>{
  for(const kind of ['user','owner','public','recipient','prior']){
    const f=await fixture(t),read=f.io.readDestination;
    f.io.readDestination=async name=>{const v=await read(name);if(kind==='user')v.authenticatedUserId=43;if(kind==='owner')v.ownerId=43;if(kind==='public')v.public=true;if(kind==='recipient'){const r=JSON.parse(v.recipientBytes);r.recipientId='f'.repeat(64);v.recipientBytes=json(r);}return v;};
    if(kind==='prior')f.plan.previousBodySha256='f'.repeat(64);
    const r=await f.run();assert.equal(r.status,'REFUSED',kind);assert.equal(r.stage,'CURRENT');assert.equal(f.state.patches.length,0);
  }
});
test('wrong object path and unknown plan fields refuse before service calls',async t=>{
  for(const kind of ['path','extra','mode']){
    const f=await fixture(t);if(kind==='path')f.plan.input.name='https://another.invalid/input';if(kind==='extra')f.plan.credentials=canary;if(kind==='mode')f.plan.mode='retry';
    const r=await f.run();assert.equal(r.status,'REFUSED');assert.equal(r.stage,'PLAN');assert.equal(f.state.reads,0);
    assert.ok(!JSON.stringify(r).includes(canary));
  }
});
test('current revision change consumes claim but cannot publish or reset claim',async t=>{
  const f=await fixture(t),read=f.io.readDestination;
  f.io.readDestination=async name=>{const v=await read(name);if(f.state.reads===2)v.revision='c'.repeat(40);return v;};
  const first=await f.run();assert.equal(first.stage,'PREWRITE');assert.equal(first.claim,'OWNED');assert.equal(first.patchAttempts,0);
  f.io.readDestination=read;const again=await f.run();assert.equal(again.claim,'EXISTS');assert.equal(again.patchAttempts,0);assert.equal(f.state.deleted.length,1);
});
test('claim conflict or unknown claim outcome never PATCHes or deletes another run inputs',async t=>{
  for(const kind of ['EXISTS','throw']){
    const f=await fixture(t);f.io.claimOnce=async()=>{if(kind==='throw')throw Error(canary);return kind;};
    const r=await f.run();assert.equal(r.stage,'CLAIM');assert.equal(r.claim,kind==='throw'?'UNKNOWN':'EXISTS');assert.equal(r.patchAttempts,0);assert.equal(f.state.deleted.length,0);assert.ok(!JSON.stringify(r).includes(canary));
  }
});
test('re-upload generation or Library version changes cannot reset an already consumed input claim',async t=>{
  const f=await fixture(t),read=f.io.readDestination;
  f.io.readDestination=async name=>{const v=await read(name);if(f.state.reads===2)v.revision='c'.repeat(40);return v;};
  assert.equal((await f.run()).claim,'OWNED');
  f.io.readDestination=read;f.plan.library.version++;f.plan.original.generation='201';f.plan.input.generation='202';
  const r=await f.run();assert.equal(r.claim,'EXISTS');assert.equal(r.patchAttempts,0);assert.equal(f.state.deleted.length,1);
});
test('an input timeout reports only its fixed stage and does not retry or claim',async t=>{
  const f=await fixture(t);let calls=0;f.io.readInput=async()=>{calls++;throw Error(canary);};
  const r=await f.run();assert.equal(r.stage,'INPUT');assert.equal(r.status,'REFUSED');assert.equal(calls,1);assert.equal(f.state.claimCalls,0);assert.equal(r.patchAttempts,0);assert.ok(!JSON.stringify(r).includes(canary));
});
test('a PATCH timeout after successful write is resolved by one readback, never resend',async t=>{
  const f=await fixture(t),patch=f.io.patchSnapshot;f.io.patchSnapshot=async body=>{await patch(body);throw Error(canary);};
  const r=await f.run();assert.equal(r.status,'PUBLISHED_CONFIRMED');assert.equal(r.patchAttempts,1);assert.equal(f.state.patches.length,1);assert.equal(f.state.reads,3);
});
test('unknown or mismatched write result is saved as unconfirmed with no retry',async t=>{
  for(const kind of ['before-send','bad-readback','readback-error']){
    const f=await fixture(t),patch=f.io.patchSnapshot,read=f.io.readDestination;
    if(kind==='before-send')f.io.patchSnapshot=async()=>{throw Error(canary);};
    if(kind==='bad-readback')f.io.patchSnapshot=async body=>{await patch(body);f.state.raw=Buffer.from('{}');};
    if(kind==='readback-error')f.io.readDestination=async name=>{if(f.state.reads===2)throw Error(canary);return read(name);};
    const r=await f.run();assert.equal(r.status,'WRITE_UNCONFIRMED',kind);assert.equal(r.patchAttempts,1);assert.equal(f.state.saved.at(-1).status,r.status);assert.ok(!JSON.stringify(r).includes('SECRET_CANARY'));
  }
});
test('safe intent save failure prevents PATCH; final receipt failures do not leak raw errors',async t=>{
  const f=await fixture(t),save=f.io.saveReceipt;let first=true;f.io.saveReceipt=async r=>{if(first){first=false;throw Error(canary);}return save(r);};
  const r=await f.run();assert.equal(r.status,'REFUSED');assert.equal(r.stage,'WRITE_INTENT');assert.equal(r.patchAttempts,0);assert.equal(f.state.localCleanups,1);
  const g=await fixture(t);g.io.saveReceipt=async()=>{throw Error(canary);};
  await assert.rejects(g.run(),{message:'RATIO_CLOUD_SAFE_RECEIPT_UNSAVED'});assert.equal(g.state.patches.length,0);assert.equal(g.state.localCleanups,1);
});
test('a final receipt failure after a confirmed write preserves prior intent and cannot trigger another PATCH',async t=>{
  const f=await fixture(t),save=f.io.saveReceipt;
  f.io.saveReceipt=async r=>{if(r.stage==='COMPLETE')throw Error(canary);return save(r);};
  await assert.rejects(f.run(),{message:'RATIO_CLOUD_SAFE_RECEIPT_UNSAVED'});
  assert.equal(f.state.patches.length,1);assert.equal(f.state.saved.length,1);assert.equal(f.state.saved[0].stage,'WRITE_INTENT');
  f.io.saveReceipt=save;const next=await f.run();assert.equal(next.status,'REFUSED');assert.equal(next.stage,'CURRENT');assert.equal(f.state.patches.length,1);
});
test('cleanup failure is explicit and does not turn confirmed publication into a retry',async t=>{
  const f=await fixture(t);f.io.deleteInputs=async()=>{throw Error(canary);};const r=await f.run();
  assert.equal(r.status,'PUBLISHED_CONFIRMED');assert.equal(r.cleanup,'INCOMPLETE');assert.equal(r.patchAttempts,1);assert.ok(!JSON.stringify(r).includes(canary));
});
test('two concurrent invocations share one atomic input claim and produce at most one PATCH',async t=>{
  const f=await fixture(t),results=await Promise.all([f.run(),f.run()]);
  assert.equal(f.state.patches.length,1);assert.equal(results.filter(r=>r.status==='PUBLISHED_CONFIRMED').length,1);assert.equal(results.filter(r=>r.claim==='EXISTS').length,1);assert.equal(f.state.deleted.length,1);
});

test('the plan binds the fee handoff for publish only; malformed or missing handoffs are refused before any read',async t=>{
  const {validateRatioCloudPlan}=await import('./fee-ratio-cloud-publish.mjs');
  const f=await fixture(t);validateRatioCloudPlan(f.plan);
  for(const fee of [undefined,null,{...FEE,extra:1},{...FEE,mainSha:'bad'},{...FEE,accountingThrough:'2026-13-01'},{...FEE,dataSha256:'x'}]){
    const plan={...f.plan,fee};if(fee===undefined)delete plan.fee;assert.throws(()=>validateRatioCloudPlan(plan),/RATIO_CLOUD_REFUSED/);
  }
  const current={mode:'verify-current',previousBodySha256:f.plan.previousBodySha256,bundleId:null,original:null,input:null,library:null,fee:null};
  validateRatioCloudPlan(current);assert.throws(()=>validateRatioCloudPlan({...current,fee:{...FEE}}),/RATIO_CLOUD_REFUSED/);
  const r=await f.run({plan:{...f.plan,fee:{...FEE,mainSha:'bad'}}});assert.equal(r.status,'REFUSED');assert.equal(f.state.reads,0);assert.equal(f.state.claimCalls,0);
});
test('a fee proof for another handoff, main or cutoff cannot release the claim or write',async t=>{
  for(const edit of [p=>({...p,feeMainSha:'d'.repeat(40)}),p=>({...p,accountingThrough:'2026-10-28'}),p=>({...p,dataSha256:'3'.repeat(64)}),p=>({...p,healthSha256:'3'.repeat(64)}),
    p=>({...p,verifiedAt:'2026-12-01T00:00:00.000Z'}),()=>null]){
    const f=await fixture(t),check=f.io.verifyFeePublication;
    f.io.verifyFeePublication=async input=>edit(await check(input));
    const r=await f.run();assert.equal(r.status,'WAITING_FEE_READBACK_NO_WRITE');assert.equal(r.stage,'FEE_READBACK');assert.equal(r.claim,'NOT_ATTEMPTED');assert.equal(f.state.claimCalls,0);assert.equal(f.state.patches.length,0);
  }
});
test('the recheck passes the exact first proof object, not a copy',async t=>{
  const f=await fixture(t),check=f.io.verifyFeePublication;let second;
  f.io.verifyFeePublication=async input=>{if(input.previousProof)second=input.previousProof;return check(input);};
  assert.equal((await f.run()).status,'PUBLISHED_CONFIRMED');assert.equal(second,f.state.firstFee);
});

test('a promotion that replaces the handed fee pair between readback and recheck stops before PATCH',async t=>{
 for(const code of ['FEE_PUBLICATION_LIVE','FEE_PUBLICATION_CHANGED','FEE_PUBLICATION_MAIN','FEE_PUBLICATION_READ']){
  const f=await fixture(t),check=f.io.verifyFeePublication;
  f.io.verifyFeePublication=async input=>{if(input.previousProof)throw Error(code);return check(input);};
  const r=await f.run();assert.equal(r.status,'REFUSED');assert.equal(r.stage,'FEE_RECHECK:'+code);assert.equal(r.claim,'OWNED');assert.equal(r.patchAttempts,0);assert.equal(f.state.patches.length,0);
  assert.ok(!f.state.events.includes('save:WRITE_INTENT'));
  // A repeated dispatch of the same batch cannot reuse the consumed claim.
  f.io.verifyFeePublication=check;const again=await f.run();assert.equal(again.claim,'EXISTS');assert.equal(f.state.patches.length,0);
 }
});
test('an old handoff for a superseded fee report never reaches the claim',async t=>{
 const f=await fixture(t);f.io.verifyFeePublication=async()=>{throw Error('FEE_PUBLICATION_LIVE');};
 const r=await f.run();assert.equal(r.status,'WAITING_FEE_READBACK_NO_WRITE');assert.equal(r.stage,'FEE_READBACK:FEE_PUBLICATION_LIVE');assert.equal(f.state.claimCalls,0);
});
