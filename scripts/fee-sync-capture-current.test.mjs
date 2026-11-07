import test from 'node:test';
import assert from 'node:assert/strict';
import {D,B,cloudFixture,ibFixture} from './fee-sync-test-fixtures.mjs';

// Synthetic in-memory HTTP only. No environment, account, credential or network
// discovery. A controlled response switch models edits after acceptance.
function controlled(kind,options={}){
  const f=kind==='cloud'?cloudFixture(options):ibFixture(options),r=f.reader;
  const control={change:null,before:null,requests:[]};
  const original=kind==='cloud'?r.http.fetchImpl:r.fetch;
  const wrapped=async(url,init)=>{
    const path=new URL(url).pathname;
    control.requests.push({url,method:init.method});
    if(control.before)await control.before(path,init);
    const response=await original(url,init);
    if(path==='/oauth2/token'||!control.change)return response;
    const bytes=Buffer.from(await response.arrayBuffer());
    const changed=control.change(bytes,path,init);
    const out=new Response(changed??bytes,{headers:{'content-type':'application/json'}});
    Object.defineProperty(out,'url',{value:url});return out;
  };
  if(kind==='cloud')r.http.fetchImpl=wrapped;else r.fetch=wrapped;
  return {...f,control,kind,
    acquire:()=>kind==='cloud'?r.readStableWithEvidence(D,B):r.readStableWithEvidence(f.args),
    consume:cap=>kind==='cloud'?r.consumeCapturedRead(cap,D,B):r.consumeCapturedRead(cap,f.args),
    ordinary:()=>kind==='cloud'?r.readStable(D,B):r.readStable(f.args)};
}

for(const kind of ['cloud','ib']){
  test(`${kind}: current check reads exact captured GET set and preserves input and one-shot consumption`,async()=>{
    const f=controlled(kind),cap=await f.acquire(),before=f.control.requests.length;
    const frozen=JSON.stringify(cap),expected=cap.evidence.captures[0].records;
    assert.equal(await f.reader.checkCapturedReadCurrent(cap),true);
    const calls=f.control.requests.slice(before),gets=calls.filter(x=>x.method==='GET');
    assert.equal(calls.filter(x=>x.method==='POST').length,1);
    assert.deepEqual(gets.map(x=>{const u=new URL(x.url);return {path:u.pathname,query:Object.fromEntries(u.searchParams)};}),expected.map(x=>({path:x.path,query:x.query})));
    assert.equal(JSON.stringify(cap),frozen);
    assert.equal(f.consume(cap),cap.input);
    assert.equal(await f.reader.checkCapturedReadCurrent(cap),true);
    assert.throws(()=>f.consume(cap));
    assert.equal(f.reader.verifyCapturedRead(cap),true);
  });

  test(`${kind}: forged, cloned, cross-instance and proxy capabilities issue no requests`,async()=>{
    const f=controlled(kind),cap=await f.acquire(),other=controlled(kind),count=f.control.requests.length;
    let traps=0;
    const badRoute=structuredClone(cap);badRoute.evidence.captures[0].records[0].path='https://outside.invalid/private';
    const badQuery=structuredClone(cap);badQuery.evidence.captures[0].records[0].query={redirect:'https://outside.invalid'};
    const getter={};Object.defineProperty(getter,'evidence',{get(){traps++;return cap.evidence;}});
    for(const fake of [null,{},structuredClone(cap),badRoute,badQuery,getter,new Proxy(cap,{get(){traps++;throw Error('PRIVATE');}})]){
      await assert.rejects(f.reader.checkCapturedReadCurrent(fake));
    }
    await assert.rejects(other.reader.checkCapturedReadCurrent(cap));
    assert.equal(traps,0);assert.equal(f.control.requests.length,count);assert.equal(other.control.requests.length,0);
    assert.equal(f.reader.verifyCapturedRead(cap),true);
  });

  for(const change of ['whitespace','amount','identity','omitted','invalid-json','invalid-utf8','token','escaped-token','secret','network']){
    test(`${kind}: ${change} after acceptance revokes capability without updating original evidence`,async()=>{
      const f=controlled(kind),cap=await f.acquire(),old=JSON.stringify(cap);
      f.control.change=(bytes,path)=>{
        if(!path.endsWith('/performance'))return bytes;
        const text=bytes.toString();
        if(change==='whitespace')return text+' ';
        if(change==='amount')return text.replace('"value":150','"value":151');
        if(change==='identity')return text.replace('"portfolio_id":','"portfolio_id":9');
        if(change==='omitted')return '{}';
        if(change==='invalid-json')return '{';
        if(change==='invalid-utf8')return Buffer.from([0xc3,0x28]);
        if(change==='token')return text.replace('{','{"reflection":"synthetic-capture-token-123456",');
        if(change==='escaped-token')return text.replace('{','{"reflection":"synthetic-c\\u0061pture-token-123456",');
        if(change==='secret')return text.replace('{','{"reflection":"synthetic-secret",');
        throw Error('PRIVATE_UNEXPECTED_TRANSPORT_MESSAGE');
      };
      await assert.rejects(f.reader.checkCapturedReadCurrent(cap),e=>{
        assert.equal(e.message.includes('PRIVATE'),false);assert.equal(e.message.includes('synthetic-'),false);return true;
      });
      assert.equal(JSON.stringify(cap),old);assert.equal(f.reader.verifyCapturedRead(cap),false);assert.throws(()=>f.consume(cap));
      const count=f.control.requests.length;f.control.change=null;
      await assert.rejects(f.reader.checkCapturedReadCurrent(cap));assert.equal(f.control.requests.length,count);
    });
  }

  test(`${kind}: changed transport and accessor trap revoke before any network`,async()=>{
    for(const type of ['replace-fetch','getter-fetch','credential-getter']){
      const f=controlled(kind),cap=await f.acquire(),count=f.control.requests.length;let calls=0;
      const target=kind==='cloud'?f.reader.http:f.reader,key=kind==='cloud'?'fetchImpl':'fetch';
      if(type==='replace-fetch')target[key]=async()=>{calls++;throw Error('PRIVATE');};
      if(type==='getter-fetch')Object.defineProperty(target,key,{get(){calls++;throw Error('PRIVATE');}});
      if(type==='credential-getter')Object.defineProperty(f.reader,'clientSecret',{get(){calls++;throw Error('PRIVATE');}});
      await assert.rejects(f.reader.checkCapturedReadCurrent(cap));
      assert.equal(calls,0);assert.equal(f.control.requests.length,count);assert.equal(f.reader.verifyCapturedRead(cap),false);
    }
  });

  test(`${kind}: current check serializes with captures, reads and consumption`,async()=>{
    const f=controlled(kind),cap=await f.acquire();let entered,release;
    const waiting=new Promise(resolve=>{entered=resolve;}),pause=new Promise(resolve=>{release=resolve;});
    f.control.before=async path=>{if(path==='/api/v2/portfolios.json'){entered();await pause;}};
    const checking=f.reader.checkCapturedReadCurrent(cap);await waiting;const count=f.control.requests.length;
    await assert.rejects(f.reader.checkCapturedReadCurrent(cap));await assert.rejects(f.acquire());await assert.rejects(f.ordinary());
    assert.throws(()=>f.consume(cap));assert.equal(f.control.requests.length,count);
    release();assert.equal(await checking,true);assert.equal(f.consume(cap),cap.input);
  });

  test(`${kind}: properties replaced with getters while awaiting HTTP are never invoked`,async()=>{
    for(const type of ['credential','transport',...(kind==='cloud'?['observer','peer']:[])]){
      const f=controlled(kind),cap=await f.acquire();let traps=0,replaced=false;
      f.control.before=async path=>{
        if(path==='/oauth2/token'||replaced)return;replaced=true;
        const target=type==='credential'?f.reader:kind==='cloud'?f.reader.http:f.reader;
        const key=type==='credential'?'clientSecret':type==='observer'?'onSourceResponse':type==='peer'?'peerPortfolioId':kind==='cloud'?'fetchImpl':'fetch';
        Object.defineProperty(target,key,{get(){traps++;throw Error('PRIVATE_GETTER');}});
      };
      await assert.rejects(f.reader.checkCapturedReadCurrent(cap));
      assert.equal(replaced,true);assert.equal(traps,0);assert.equal(f.reader.verifyCapturedRead(cap),false);
    }
  });

  test(`${kind}: failed recheck after consumption cannot recreate a run opportunity`,async()=>{
    const f=controlled(kind),cap=await f.acquire();f.consume(cap);
    f.control.change=bytes=>Buffer.concat([bytes,Buffer.from(' ')]);
    await assert.rejects(f.reader.checkCapturedReadCurrent(cap));
    assert.equal(f.reader.verifyCapturedRead(cap),false);assert.throws(()=>f.consume(cap));
  });
}

test('cloud: raw recheck does not invoke the source observation callback again',async()=>{
  const f=controlled('cloud',{extraListing:true}),cap=await f.acquire();
  const before=f.control.requests.length;assert.equal(await f.reader.checkCapturedReadCurrent(cap),true);
  const after=f.control.requests.slice(before);
  assert.equal(after.filter(x=>x.method==='GET').length,cap.evidence.captures[0].records.length);
});

test('cloud: changed business configuration or peer accessor revokes capture without invoking accessor',async()=>{
  for(const type of ['config','peer-getter','method-getter']){
    const f=controlled('cloud'),cap=await f.acquire(),before=f.control.requests.length;let traps=0;
    if(type==='config')f.reader.sourceMode='legacy-reconstruction';
    if(type==='peer-getter')Object.defineProperty(f.reader.http,'peerPortfolioId',{get(){traps++;return null;}});
    if(type==='method-getter')Object.defineProperty(f.reader,'token',{get(){traps++;throw Error('PRIVATE');}});
    await assert.rejects(f.reader.checkCapturedReadCurrent(cap));
    assert.equal(traps,0);assert.equal(f.control.requests.length,before);assert.equal(f.reader.verifyCapturedRead(cap),false);
  }
});
