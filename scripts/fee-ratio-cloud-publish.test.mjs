// Synthetic input only; imports the existing official-source crypto fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {authenticated,syntheticOfficialSource} from './fee-ratio-official-source.test.mjs';
import {createOfficialRatioSourceCore} from './fee-ratio-official-source.mjs';
import {createRatioCloudPublisher,RATIO_CLOUD_FILE} from './fee-ratio-cloud-publish.mjs';
import {createApiRatioSourceCore} from './fee-ratio-api-source.mjs';
import {syntheticCapture} from './fee-ratio-api-source.test.mjs';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const json=v=>Buffer.from(JSON.stringify(v));
const canary='SECRET_CANARY_DO_NOT_LEAK https://private.invalid/?token=not-real';
// Synthetic coordinator handoff. Its fee cutoff is deliberately not the ratio
// source date: the two reports keep their own real dates.
const FEE={mainSha:'e'.repeat(40),accountingThrough:'2026-10-27',dataSha256:'1'.repeat(64),healthSha256:'2'.repeat(64)};
const feeProofOf=(handoff,at)=>Object.freeze({schema:'synthetic',status:'FEE_FINAL_PUBLICATION_VERIFIED',accountingThrough:handoff.accountingThrough,feeMainSha:handoff.mainSha,
  runMainSha:'a'.repeat(40),dataSha256:handoff.dataSha256,healthSha256:handoff.healthSha256,verifiedAt:at.toISOString(),healthCheckedAt:'2026-10-27T22:00:00.000Z'});

async function fixture(t,{sameSource=false,prior=[],edit=null,now=null}={}){
  const f=await authenticated(t,...prior),raw=structuredClone(f.raw);if(now)f.now=now;
  if(edit)edit(raw);else if(!sameSource){raw.classification.capturedAt='2026-10-30T05:45:00.000Z';raw.exposure.capturedAt='2026-10-30T05:44:00.000Z';}
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
test('without a handoff the ratio publishes on its own and no fee report is read',async t=>{
  const f=await fixture(t);let checks=0;f.io.verifyFeePublication=async()=>{checks++;throw Error('FEE_PUBLICATION_MAIN');};
  const r=await f.run({plan:{...f.plan,fee:null}});
  assert.equal(r.status,'PUBLISHED_CONFIRMED');assert.equal(r.stage,'COMPLETE');assert.equal(r.claim,'OWNED');assert.equal(r.patchAttempts,1);
  assert.equal(checks,0,'the fee verifier is never called');assert.equal(f.state.patches.length,1);
  // It does not even need a verifier, and the other guards are unchanged: one claim per input pair, no second write.
  const g=await fixture(t);delete g.io.verifyFeePublication;
  const first=await g.run({plan:{...g.plan,fee:null}});assert.equal(first.status,'PUBLISHED_CONFIRMED');
  const again=await g.run({plan:{...g.plan,fee:null}});assert.notEqual(again.status,'PUBLISHED_CONFIRMED');assert.equal(g.state.patches.length,1);
  // Nothing of the fee report is in the published snapshot, with or without a handoff.
  const a=await fixture(t);assert.equal((await a.run()).status,'PUBLISHED_CONFIRMED');
  for(const state of [f.state,a.state]){
    const text=JSON.stringify(state.patches[0]);
    for(const value of Object.values(FEE))assert.equal(text.includes(String(value)),false);
  }
  // A handoff that is present is still verified in full.
  const h=await fixture(t);h.io.verifyFeePublication=async()=>{throw Error('FEE_PUBLICATION_PAGES_DATA');};
  const held=await h.run();assert.equal(held.status,'WAITING_FEE_READBACK_NO_WRITE');assert.equal(h.state.patches.length,0);
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

test('a fee handoff is optional for publish; a malformed or absent key is refused before any read',async t=>{
  const {validateRatioCloudPlan}=await import('./fee-ratio-cloud-publish.mjs');
  const f=await fixture(t);validateRatioCloudPlan(f.plan);
  // `fee: null` is a valid plan (independent publication); the key itself is never optional.
  validateRatioCloudPlan({...f.plan,fee:null});
  for(const fee of [undefined,false,0,'',{},[],{...FEE,extra:1},{...FEE,mainSha:'bad'},{...FEE,accountingThrough:'2026-13-01'},{...FEE,dataSha256:'x'}]){
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

// The binding compares the pinned original's frozen capture instant (the
// earliest original download-file mtime the official projection verified) with
// the handed fee health's checkedAt, a lower bound of that fee production. It
// is a misuse guard: it neither proves an export is new nor that the handed
// fee is the current round's.
test('an original captured before the handed fee production is refused before any claim, even on the same Hong Kong date',async t=>{
  const at=checked=>async({handoff,previousProof})=>Object.freeze({...feeProofOf(handoff,new Date('2026-10-30T06:00:00.000Z')),healthCheckedAt:checked});
  const earliest='2026-10-30T05:44:00.000Z';
  for(const [checked,status] of [['2026-10-30T05:44:00.001Z','REFUSED'],['2026-10-30T06:00:00.000Z','REFUSED'],[earliest,'PUBLISHED_CONFIRMED'],['2026-10-27T22:00:00.000Z','PUBLISHED_CONFIRMED']]){
    const f=await fixture(t);f.io.verifyFeePublication=at(checked);
    const result=await f.run();
    assert.equal(result.status,status,checked);
    if(status==='REFUSED'){assert.equal(result.stage,'SOURCE_ROUND');assert.equal(result.claim,'NOT_ATTEMPTED');assert.equal(f.state.claimCalls,0);assert.equal(f.state.patches.length,0);}
  }
  // A re-upload of the same pinned original under a new storage generation is
  // still the same frozen capture: generation/upload time never refreshes it.
  const f=await fixture(t);f.io.verifyFeePublication=at('2026-10-30T06:00:00.000Z');
  for(const spec of [f.plan.original,f.plan.input])spec.generation=String(Number(spec.generation)+1000);
  const reuploaded=await f.run();assert.equal(reuploaded.status,'REFUSED');assert.equal(reuploaded.stage,'SOURCE_ROUND');assert.equal(f.state.patches.length,0);
  // A proof without a valid fee health time cannot pass the binding.
  const g=await fixture(t);g.io.verifyFeePublication=at('not-a-time');assert.equal((await g.run()).stage,'SOURCE_ROUND');
});

/* ---------- Signed Hong Kong date policy across the complete snapshot chain ---------- */

const MONTH=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const dated=(raw,{classification,exposure,capturedAt})=>{
  for(const [role,asOf] of [['classification',classification],['exposure',exposure]]){
    raw[role].asOf=asOf;raw[role].capturedAt=capturedAt;raw[role].dateEvidence='Showing as at '+Number(asOf.slice(8))+' '+MONTH[Number(asOf.slice(5,7))-1]+' '+asOf.slice(0,4);
  }
  return raw;
};
const priorFor=(day,at)=>[dated(syntheticOfficialSource(),{classification:day,exposure:day,capturedAt:at}),{},{now:new Date(Date.parse(at)+60000),targetDate:day}];

test('a Hong Kong-dated official source publishes through source, verifyOriginal, candidate, authenticate, verify and run before UTC midnight',async t=>{
  for(const [label,day,captured,clock,previousDay,previousAt] of [
    ['HKT 07:45 is UTC previous day','2026-11-10','2026-11-09T23:30:00.000Z','2026-11-09T23:45:00.000Z','2026-11-08','2026-11-08T02:00:00.000Z'],
    ['month boundary','2026-12-01','2026-11-30T23:30:00.000Z','2026-11-30T23:45:00.000Z','2026-11-29','2026-11-29T02:00:00.000Z'],
    ['year boundary','2027-01-01','2026-12-31T23:30:00.000Z','2026-12-31T23:45:00.000Z','2026-12-30','2026-12-30T02:00:00.000Z'],
  ]){
    const f=await fixture(t,{prior:priorFor(previousDay,previousAt),now:new Date(clock),edit:raw=>dated(raw,{classification:day,exposure:day,capturedAt:captured})});
    const result=await f.run();
    assert.equal(result.status,'PUBLISHED_CONFIRMED',label);assert.equal(f.state.patches.length,1,label);
    const published=JSON.parse(f.state.raw);
    assert.equal(published.body.source.datePolicy,'hkt-calendar-v1',label);assert.equal(published.body.source.asOf,day,label);
    assert.equal(published.authentication.confirmedAt,clock,label);
    // The same signed packet stays readable later: signing-time freshness is
    // judged at its own confirmation; reading after expiry only marks it stale.
    for(const [at,stale] of [[clock,false],[new Date(Date.parse(clock)+12*3600000).toISOString(),false],[new Date(Date.parse(captured)+36*3600000+1).toISOString(),true],[new Date(Date.parse(captured)+30*86400000).toISOString(),true]]){
      const read=await f.snapshot.verify(published,f.manager,{now:new Date(at)});assert.equal(read.stale,stale,label+' '+at);assert.equal(read.source.datePolicy,'hkt-calendar-v1');
    }
  }
});

test('future, stale, over-36h and changed sources are refused before signing under the Hong Kong policy',async t=>{
  const prior=priorFor('2026-11-08','2026-11-08T02:00:00.000Z');
  // A date beyond its capture's Hong Kong date is refused by the official
  // projection itself, before any input pair or plan can exist.
  await assert.rejects(fixture(t,{prior,now:new Date('2026-11-09T23:45:00.000Z'),edit:raw=>dated(raw,{classification:'2026-11-11',exposure:'2026-11-11',capturedAt:'2026-11-09T23:30:00.000Z'})}),/RATIO_OFFICIAL_SOURCE_REFUSED/);
  for(const [label,edit,clock,stage] of [
    ['five Hong Kong days old',raw=>dated(raw,{classification:'2026-11-05',exposure:'2026-11-05',capturedAt:'2026-11-09T23:30:00.000Z'}),'2026-11-09T23:45:00.000Z','SOURCE'],
    ['capture older than 36 hours',raw=>dated(raw,{classification:'2026-11-10',exposure:'2026-11-10',capturedAt:'2026-11-09T23:30:00.000Z'}),'2026-11-11T11:30:00.001Z','SOURCE'],
  ]){
    const f=await fixture(t,{prior,now:new Date(clock),edit});const result=await f.run();
    assert.equal(result.status,'REFUSED',label);assert.equal(result.stage,stage,label);assert.equal(f.state.patches.length,0,label);assert.equal(f.state.claimCalls,0,label);
  }
  const f=await fixture(t,{prior,now:new Date('2026-11-09T23:45:00.000Z'),edit:raw=>dated(raw,{classification:'2026-11-10',exposure:'2026-11-10',capturedAt:'2026-11-09T23:30:00.000Z'})});
  const changed=JSON.parse(f.values.get(f.plan.original.name));changed.exposure.rows[0].valueUSD+=1;f.values.set(f.plan.original.name,json(changed));
  const result=await f.run();assert.equal(result.status,'REFUSED');assert.equal(result.stage,'INPUT');assert.equal(f.state.patches.length,0);
});

test('the date policy is signed: unknown, downgraded, stripped or missing policies are refused; old UTC packets keep their semantics',async t=>{
  // Classification is four UTC days (five Hong Kong days) older than this
  // confirmation instant, inside the 36-hour capture window.
  const raw=dated(syntheticOfficialSource(),{classification:'2026-10-30',exposure:'2026-10-30',capturedAt:'2026-10-30T05:30:00.000Z'});raw.classification.asOf='2026-10-26';raw.classification.dateEvidence='Showing as at 26 Oct 2026';
  const f=await authenticated(t,raw,{},{now:new Date('2026-10-30T06:00:00.000Z'),targetDate:'2026-10-30'});
  const signed=f.signed;assert.equal(signed.body.source.datePolicy,'hkt-calendar-v1');
  await f.snapshot.verify(signed,f.manager,{now:new Date('2026-10-30T06:00:00.000Z')});
  const ratio=f.ratio,sign=async(body,confirmedAt)=>{
    const auth={schema:'fee-console.ratio-snapshot-manager-auth.v1',confirmedAt,profileSha256:'a'.repeat(64),bodySha256:await ratio.digest(body)};
    const mac=ratio.encode(new Uint8Array(await crypto.webcrypto.subtle.sign('HMAC',f.manager.authenticationKey,new TextEncoder().encode(ratio.canonical(auth)))));
    return {body,authentication:{...auth,mac}};
  };
  const legacyBody=structuredClone(signed.body);delete legacyBody.source.datePolicy;
  // An old signed packet (no policy) keeps UTC-day semantics, including its
  // four-day boundary at 23:00Z, which the Hong Kong policy would count as five.
  const boundary='2026-10-30T23:00:00.000Z';
  assert.equal((await f.snapshot.verify(await sign(legacyBody,boundary),f.manager,{now:new Date(boundary)})).stale,false);
  await assert.rejects(f.snapshot.verify(await sign(structuredClone(signed.body),boundary),f.manager,{now:new Date(boundary)}),/RATIO_SNAPSHOT_REFUSED/);
  // Old UTC semantics are not rewritten: a UTC-future source stays invalid.
  const early=structuredClone(legacyBody);
  await assert.rejects(f.snapshot.verify(await sign(early,'2026-10-25T23:59:59.000Z'),f.manager,{now:new Date(boundary)}),/RATIO_SNAPSHOT_REFUSED/);
  // Unknown or downgraded policy values are refused even with a valid MAC.
  for(const value of ['legacy-utc','hkt-calendar-v2','',null,1]){
    const body=structuredClone(signed.body);body.source.datePolicy=value;
    await assert.rejects(f.snapshot.verify(await sign(body,'2026-10-30T06:00:00.000Z'),f.manager,{now:new Date('2026-10-30T06:00:00.000Z')}),/RATIO_SNAPSHOT_REFUSED/,String(value));
  }
  // Stripping or changing the signed policy without re-signing breaks the MAC.
  for(const edit of [s=>{delete s.datePolicy;},s=>{s.datePolicy='legacy-utc';}]){
    const tampered=structuredClone(signed);edit(tampered.body.source);
    await assert.rejects(f.snapshot.verify(tampered,f.manager,{now:new Date('2026-10-30T06:00:00.000Z')}),/RATIO_SNAPSHOT_REFUSED/);
  }
  // New signing always carries the policy: a candidate without it is refused.
  const unsigned=structuredClone(await f.snapshot.candidate({model:f.model,recipient:f.manager.recipient,proof:await f.snapshot.verifyOriginal(f.args),now:new Date('2026-10-30T06:00:00.000Z')}));
  delete unsigned.body.source.datePolicy;
  await assert.rejects(f.snapshot.authenticate(unsigned,await f.snapshot.verifyOriginal(f.args),f.manager,{profileSha256:'a'.repeat(64),now:new Date('2026-10-30T06:00:00.000Z')}),/RATIO_SNAPSHOT_REFUSED/);
  // A legacy-signed previous snapshot may still precede a new policy snapshot.
  const legacyPrevious=await sign(legacyBody,'2026-10-30T06:00:00.000Z');
  assert.equal((await f.snapshot.verify(legacyPrevious,f.manager,{now:new Date('2026-10-30T06:01:00.000Z')})).source.datePolicy,undefined);
});

// ---- Sharesight API original through the same publisher ----
function apiInputs(f){
  const capture=syntheticCapture();capture.view.name='All Together';capture.asOf=capture.report.start_date=capture.report.end_date='2026-10-30';capture.capturedAt='2026-10-30T05:50:00.000Z';
  const api=createApiRatioSourceCore(),raw=api.toRaw(api.project(capture),{reportSha256:'7'.repeat(64)});
  const original=json(raw),input=json(createOfficialRatioSourceCore().build(raw,{sourceSha256:hash(original),sourceBytes:original.length}).input);
  const bundleId=hash(Buffer.concat([original,input])),prefix='inputs/'+bundleId+'/';
  const plan={...f.plan,bundleId,original:{name:prefix+'original.json',generation:'201',sha256:hash(original)},input:{name:prefix+'input.json',generation:'202',sha256:hash(input)},library:null};
  f.values.set(plan.original.name,original);f.values.set(plan.input.name,input);
  return {raw,plan};
}
test('an API original publishes through the same claim, fee gate, single PATCH and readback as its own signed kind',async t=>{
  const f=await fixture(t),{plan}=apiInputs(f),result=await f.run({plan});
  assert.equal(result.status,'PUBLISHED_CONFIRMED');assert.equal(result.patchAttempts,1);assert.equal(f.state.patches.length,1);
  assert.ok(f.state.events.indexOf('fee-readback')<f.state.events.indexOf('claim'));assert.ok(f.state.events.indexOf('fee-recheck')<f.state.events.indexOf('save:WRITE_INTENT'));
  const packet=JSON.parse(f.state.raw),verified=await f.snapshot.verify(packet,f.manager,{now:f.now});
  assert.equal(packet.body.source.kind,'complete-official-api-association');assert.equal(Object.hasOwn(packet.body.source,'libraryVersion'),false);
  assert.equal(verified.watermark.version,2);assert.equal(packet.body.previousSnapshotId,f.plan.previousBodySha256);
  const evidence=verified.model.book.browserEvidence;
  assert.deepEqual([evidence.transport,evidence.integrity,Object.hasOwn(evidence,'sourceVersion'),Object.hasOwn(verified.model,'companyExposure')],['official-api','verified-original-api-association',false,false]);
  assert.match(f.ratio.render(verified.model),/来源：Sharesight 官方 API/);assert.doesNotMatch(f.ratio.render(verified.model),/工作簿|mtime|Library/);
  assert.deepEqual(f.state.deleted,[[plan.original,plan.input]]);
});
test('a scheduled run follows the verified current snapshot; an operator placeholder alone never does',async t=>{
  const ZERO='0'.repeat(64);
  const f=await fixture(t),{plan}=apiInputs(f),scheduled={...plan,previousBodySha256:ZERO,fee:null};
  // The synthetic current snapshot is dated 2026-10-30, so a later target is due.
  const r=await f.run({plan:scheduled,followCurrent:{asOf:'2026-10-31'}});
  assert.equal(r.status,'PUBLISHED_CONFIRMED');assert.equal(r.patchAttempts,1);assert.equal(f.state.patches.length,1);
  // The published snapshot chains to the real current one, not to the placeholder, and no fee stage ran.
  const packet=JSON.parse(f.state.raw);assert.equal(packet.body.previousSnapshotId,f.plan.previousBodySha256);assert.notEqual(packet.body.previousSnapshotId,ZERO);
  assert.equal(f.state.events.some(e=>e.startsWith('fee-')),false);
  // The current snapshot is already at (or beyond) the target date: nothing is read from storage, claimed or written.
  const published=(await f.snapshot.verify(packet,f.manager,{now:f.now})).watermark.sourceDate;assert.equal(published,'2026-10-30');
  for(const asOf of ['2026-10-30','2026-10-29']){
    const before=f.state.events.length,again=await f.run({plan:scheduled,followCurrent:{asOf}});
    assert.equal(again.status,'VERIFIED_CURRENT_NO_WRITE');assert.equal(f.state.patches.length,1);
    assert.deepEqual(f.state.events.slice(before).filter(e=>['input','claim','patch'].includes(e)),[]);
  }
  // Without the scheduled flag the same placeholder plan is an ordinary plan whose previous body does not match.
  const g=await fixture(t),api=apiInputs(g),plain=await g.run({plan:{...api.plan,previousBodySha256:ZERO,fee:null}});
  assert.deepEqual([plain.status,plain.stage,plain.patchAttempts],['REFUSED','CURRENT',0]);assert.equal(g.state.claimCalls,0);
  // The flag is only for an API plan without a handoff, with a real date; anything else is refused before any read.
  for(const [p,follow] of [[{...api.plan,previousBodySha256:ZERO},{asOf:'2026-10-30'}],[{...g.plan,previousBodySha256:ZERO,fee:null},{asOf:'2026-10-30'}],
    [{...api.plan,previousBodySha256:ZERO,fee:null},{asOf:'2026-10-30',extra:1}],[{...api.plan,previousBodySha256:ZERO,fee:null},{asOf:'tomorrow'}],[{...api.plan,previousBodySha256:ZERO,fee:null},{}],
    [{mode:'verify-current',previousBodySha256:ZERO,bundleId:null,original:null,input:null,library:null,fee:null},{asOf:'2026-10-30'}]]){
    const reads=g.state.reads,x=await g.run({plan:p,followCurrent:follow});assert.equal(x.status,'REFUSED');assert.equal(x.stage,'PLAN');assert.equal(g.state.reads,reads);
  }
  // The snapshot changing between the first read and the write is still refused: the lock uses the hash that was followed.
  const h=await fixture(t),hp=apiInputs(h),read=h.io.readDestination;let n=0;
  h.io.readDestination=async file=>{const v=await read(file);if(++n===2)v.revision='c'.repeat(40);return v;};
  const moved=await h.run({plan:{...hp.plan,previousBodySha256:ZERO,fee:null},followCurrent:{asOf:'2026-10-31'}});
  assert.deepEqual([moved.status,moved.stage,moved.patchAttempts],['REFUSED','PREWRITE',0]);assert.equal(h.state.patches.length,0);
});
test('the plan and the pinned original must agree on the source kind; a mismatch stops before the fee gate, claim or write',async t=>{
  // An API original under a Library-bound plan.
  const a=await fixture(t),api=apiInputs(a),bound=await a.run({plan:{...api.plan,library:a.plan.library}});
  assert.deepEqual([bound.status,bound.stage,bound.claim,bound.patchAttempts],['REFUSED','SOURCE','NOT_ATTEMPTED',0]);
  // A workbook original under a plan that declares no Library file.
  const b=await fixture(t),unbound=await b.run({plan:{...b.plan,library:null}});
  assert.deepEqual([unbound.status,unbound.stage,unbound.claim,unbound.patchAttempts],['REFUSED','SOURCE','NOT_ATTEMPTED',0]);
  for(const f of [a,b]){assert.equal(f.state.patches.length,0);assert.equal(f.state.events.includes('fee-readback'),false);assert.equal(f.state.claimCalls,0);}
});
