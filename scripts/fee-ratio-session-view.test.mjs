import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const fixtureBytes=fs.readFileSync(new URL('./fixtures/fee-ratio-session-view-ui.json',import.meta.url));
assert.equal(hash(fixtureBytes),'f4903f4e28f8f5a53ae7d2387db589652cc884d67f7a1594649af8caed9c1d02');
const fixture=JSON.parse(fixtureBytes);
const installed=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function staged(page,forward=true){
  assert.equal(hash(page),forward?fixture.priorSha256:fixture.nextSha256);
  for(const r of forward?fixture.regions:[...fixture.regions].reverse()){
    const [from,to]=forward?[r.prior,r.next]:[r.next,r.prior];assert.equal(page.split(from).length,2);page=page.replace(from,()=>to);
  }
  assert.equal(hash(page),forward?fixture.nextSha256:fixture.priorSha256);return page;
}
assert.ok([fixture.priorSha256,fixture.nextSha256].includes(hash(installed)),'only exact support/UI stages');
const html=hash(installed)===fixture.priorSha256?staged(installed):installed;
const fn=(name)=>{let a=html.indexOf('async function '+name+'(');if(a<0)a=html.indexOf('function '+name+'(');assert.ok(a>=0,name);return html.slice(a,html.indexOf('\n}\n',a)+2);};
const names=['clearRatioSessionView','currentRatioSessionView','rememberRatioSessionView','showRatioSessionView','readRatioSessionView','preloadRatioSessionView','renderIndependentRatio','clearRatioManagement'];
function harness(){
  const state={now:1793520000000,authorized:true,active:true,identity:'synthetic-current'},pending=[],stored=new Map(),timers=new Map();let timerId=0,reads=0,renders=0;
  const content={innerHTML:'',replaceChildren(){this.innerHTML='';}},notice={textContent:''},pane={classList:{contains:()=>state.active}},elements={ratioContent:content,ratioNotice:notice,'p-ratio':pane,ratioCipherFile:{value:''}};
  const c={Date:class extends Date{static now(){return state.now;}},Number,JSON,Math,Error,Promise,structuredClone,
    _ratioViewCache:null,_ratioViewRendered:null,_ratioViewFlight:null,_ratioViewGeneration:0,_ratioViewExpiry:null,_ratioPreloadGeneration:-1,
    _ratioTicket:0,_ratioReadInFlight:null,_ratioCipherCache:null,_ratioExpiry:null,_ratioController:null,_ratioLastEnvelope:null,_ratioPreview:null,
    _sourceEpoch:1,_managerCapability:{ownerId:123,verifiedAt:state.now-1},RATIO_SESSION_MS:600000,
    ratioAuthorized:()=>state.authorized,ratioIdentity:()=>state.identity,cfg:k=>stored.get(k)||'',
    store:{setItem:(k,v)=>stored.set(k,v)},document:{getElementById:id=>elements[id]},
    clearRatioRecipientPreview(){},clearRatioSnapshotReview(){},setTimeout(f,ms){timers.set(++timerId,{f,ms});return timerId;},clearTimeout:id=>timers.delete(id),
    ratioCore:{render:m=>{renders++;return '<article class="ratio-holding-row">Synthetic verified version '+m.version+'</article>';}},
    readCurrentRatioSnapshot(who,guard,reuse){assert.equal(reuse,true);guard();reads++;const prior=stored.get('synthetic-watermark')||'';return new Promise((resolve,reject)=>pending.push({resolve,reject,guard,prior}));}
  };
  vm.createContext(c);vm.runInContext(names.map(fn).join('\n')+'\nthis.ops={load:renderIndependentRatio,preload:preloadRatioSessionView,clear:clearRatioManagement,current:currentRatioSessionView};',c);
  const resolve=(i,version=1,{stale=false}={})=>pending[i].resolve({priorWatermarkText:pending[i].prior,key:'synthetic-watermark',manager:{privateKey:'PRIVATE_KEY_CANARY'},raw:'ENCRYPTED_CANARY',result:{model:{version},watermark:{version,sha:String(version)},stale,source:{sourceDates:{classification:'2026-10-31',exposure:'2026-10-31'},expiresAt:new Date(state.now+(stale?-1000:86400000)).toISOString()}}});
  return {c,state,pending,stored,timers,content,notice,resolve,stats:()=>({reads,renders}),leave(){state.active=false;c.ops.clear(false);},enter(){state.active=true;},async first(version=1){const p=c.ops.load();resolve(pending.length-1,version);await p;}};
}
test('exact support and UI stages round-trip; financial/writer/authentication factories unchanged',()=>{
  const prior=staged(html,false);assert.equal(staged(prior),html);assert.throws(()=>staged(prior+' '));
  for(const name of ['createRatioSnapshotCore','previewRatioSnapshot','confirmRatioSnapshot','ghApi','ghReadSnapshot','verifyManagerCapability','readRatioSnapshotFile']){
    const take=s=>{let a=s.indexOf('async function '+name+'(');if(a<0)a=s.indexOf('function '+name+'(');return s.slice(a,s.indexOf('\n}\n',a)+2);};assert.equal(take(prior),take(html),name);
  }
  for(const name of ['fee-receipt-consumer','fee-receipt-render','fund-investor-core','fund-remote-storage','fee-report-consumer'])assert.equal(prior.split('/* '+name+':start */')[1].split('/* '+name+':end */')[0],html.split('/* '+name+':start */')[1].split('/* '+name+':end */')[0]);
});
test('cold entry shows no data before a successful verified result',async()=>{
  const f=harness(),p=f.c.ops.load();assert.equal(f.content.innerHTML,'');assert.match(f.notice.textContent,/正在读取/);f.resolve(0);await p;assert.match(f.content.innerHTML,/version 1/);assert.match(f.notice.textContent,/已核验/);
});
test('repeat entry displays verified content synchronously before pending server check',async()=>{
  const f=harness();await f.first();f.leave();assert.equal(f.content.innerHTML,'');assert.ok(f.c._ratioViewCache);f.enter();const p=f.c.ops.load();
  assert.match(f.content.innerHTML,/version 1/);assert.match(f.notice.textContent,/已核验会话副本.*正在后台检查更新/);assert.equal(f.stats().reads,2);
  assert.equal(f.stats().renders,1,'reuse already verified rendered presentation, not full calculation');f.resolve(1,2);await p;assert.match(f.content.innerHTML,/version 2/);assert.doesNotMatch(f.notice.textContent,/后台/);
});
test('authorized preload does not render hidden private content; first click joins its one read',async()=>{
  const f=harness();f.state.active=false;f.c.ops.preload();f.c.ops.preload();assert.equal(f.stats().reads,1);assert.equal(f.content.innerHTML,'');f.enter();const p=f.c.ops.load();assert.equal(f.stats().reads,1);f.resolve(0);await p;assert.match(f.content.innerHTML,/version 1/);
});
test('completed preload makes first entry immediate and still checks fresh server version',async()=>{
  const f=harness();f.state.active=false;f.c.ops.preload();const prep=f.c._ratioViewFlight.promise;f.resolve(0);await prep;assert.equal(f.content.innerHTML,'');f.enter();const p=f.c.ops.load();assert.match(f.content.innerHTML,/version 1/);assert.equal(f.stats().reads,2);f.resolve(1);await p;
});
test('preload refuses unauthorized access and never retries a failed preload automatically',async()=>{
  const f=harness();f.state.authorized=false;f.c.ops.preload();assert.equal(f.stats().reads,0);f.state.authorized=true;f.c.ops.preload();const p=f.c._ratioViewFlight.promise;f.pending[0].reject(Error('FAILED'));await assert.rejects(p);f.c.ops.preload();assert.equal(f.stats().reads,1);
});
test('failure, refusal or missing file removes previously displayed cached content',async()=>{
  for(const code of ['NETWORK','RATIO_SNAPSHOT_REFUSED','RATIO_SNAPSHOT_ABSENT']){const f=harness();await f.first();f.leave();f.enter();const p=f.c.ops.load();assert.match(f.content.innerHTML,/version 1/);f.pending[1].reject(Error(code));await p;assert.equal(f.content.innerHTML,'');assert.equal(f.c._ratioViewCache,null);assert.match(f.notice.textContent,/核验失败/);}
});
test('cache never persists plaintext, private keys, ciphertext or identity tokens',async()=>{
  const f=harness();await f.first();assert.deepEqual([...f.stored.keys()],['synthetic-watermark']);assert.doesNotMatch(JSON.stringify([...f.stored]),/Synthetic verified|PRIVATE_KEY_CANARY|ENCRYPTED_CANARY/);assert.doesNotMatch(JSON.stringify(f.c._ratioViewCache),/PRIVATE_KEY_CANARY|ENCRYPTED_CANARY|synthetic-current/);
  assert.deepEqual(Object.keys(f.c._ratioViewCache).sort(),['capabilityAt','checkedAt','epoch','html','key','ownerId','source','stale','until','watermarkText']);
});
test('auth changes, source changes, time reversal and expiry cannot display a cached view',async()=>{
  for(const mode of ['denied','epoch','owner','capability','clockBack','expired','watermark']){const f=harness();await f.first();f.leave();
    if(mode==='denied')f.state.authorized=false;if(mode==='epoch')f.c._sourceEpoch++;if(mode==='owner')f.c._managerCapability.ownerId++;if(mode==='capability')f.c._managerCapability.verifiedAt++;if(mode==='clockBack')f.state.now--;if(mode==='expired')f.state.now+=600001;if(mode==='watermark')f.stored.set('synthetic-watermark',JSON.stringify({version:9}));
    assert.equal(f.c.ops.current(),null,mode);assert.equal(f.content.innerHTML,'',mode);
  }
});
test('full clear deletes cached plaintext and invalidates a late preload success',async()=>{
  const f=harness();await f.first();f.leave();f.c.ops.clear();assert.equal(f.c._ratioViewCache,null);assert.equal(f.c._ratioViewFlight,null);f.c.ops.preload();const p=f.c._ratioViewFlight.promise;f.c.ops.clear();f.resolve(1,2);await assert.rejects(p);assert.equal(f.c._ratioViewCache,null);assert.equal(f.content.innerHTML,'');
});
test('expiry timer clears the session even after leaving the pane',async()=>{
  const f=harness();await f.first();const timer=f.timers.get(f.c._ratioViewExpiry);assert.equal(timer.ms,599999);f.leave();f.state.now+=600001;timer.f();assert.equal(f.c._ratioViewCache,null);assert.equal(f.content.innerHTML,'');
});
test('historical source remains labelled historical while checking, never latest',async()=>{
  const f=harness(),p=f.c.ops.load();f.resolve(0,1,{stale:true});await p;f.leave();f.enter();const next=f.c.ops.load();assert.match(f.notice.textContent,/历史快照（待更新）.*后台/);assert.doesNotMatch(f.notice.textContent,/最新/);f.resolve(1,1,{stale:true});await next;
});
test('quick exit/reentry joins a read without late rendering into a hidden pane',async()=>{
  const f=harness(),old=f.c.ops.load();f.leave();f.resolve(0);await old;assert.equal(f.content.innerHTML,'');assert.ok(f.c._ratioViewCache);f.enter();const next=f.c.ops.load();assert.match(f.content.innerHTML,/version 1/);f.resolve(1,2);await next;assert.match(f.content.innerHTML,/version 2/);
});
test('older requests cannot erase a newer cache or lower an advanced watermark',async()=>{
  const f=harness(),old=f.c.ops.load();f.c.ops.clear();const next=f.c.ops.load();f.resolve(1,2);await next;f.resolve(0,1);await old;assert.match(f.content.innerHTML,/version 2/);assert.equal(JSON.parse(f.stored.get('synthetic-watermark')).version,2);
  f.leave();f.enter();const p=f.c.ops.load();f.stored.set('synthetic-watermark',JSON.stringify({version:9}));f.resolve(2,3);await p;assert.equal(JSON.parse(f.stored.get('synthetic-watermark')).version,9);assert.equal(f.content.innerHTML,'');
});
test('storage, page hiding and credential invalidation continue to clear session state',()=>{
  assert.match(fn('invalidateReceiptSource'),/clearRatioManagement\(\)/);
  assert.match(html,/window\.addEventListener\("pagehide",\(\)=>clearRatioManagement\(\)\)/);
  assert.match(html,/document\.addEventListener\("visibilitychange",\(\)=>\{if\(document.hidden\)clearRatioManagement\(\)/);
  assert.match(html,/window\.addEventListener\("storage",e=>\{if\(\[K.gid,K.key,K.tok\].includes\(e.key\)\)clearRatioManagement\(\)/);
});

test('unchanged authenticated background result preserves user-opened presentation details',async()=>{
 const f=harness();await f.first();f.leave();f.enter();const p=f.c.ops.load();f.content.innerHTML+='<details open>expanded synthetic detail</details>';f.resolve(1,1);await p;assert.match(f.content.innerHTML,/expanded synthetic detail/);assert.doesNotMatch(f.notice.textContent,/后台/);
 f.leave();f.enter();const next=f.c.ops.load();f.resolve(2,2);await next;assert.doesNotMatch(f.content.innerHTML,/expanded synthetic detail/);assert.match(f.content.innerHTML,/version 2/);
});
