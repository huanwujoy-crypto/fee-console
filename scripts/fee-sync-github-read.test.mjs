// Synthetic transport only: no credential/environment reads or live requests.
import test,{after,mock} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createSyncGithubRead,syncGithubReadFailureCode} from './fee-sync-github-read.mjs';
import {BoundedJsonError} from './fee-http-json.mjs';

const TOKEN='synthetic-token-not-a-credential',SECRET='synthetic-private-error-body';
const ROOT='/repos/huanwujoy-crypto/fee-console/',MAIN=ROOT+'git/ref/heads/main',SHA='a'.repeat(40);
mock.method(globalThis,'fetch',()=>{throw Error('REAL_NETWORK_FORBIDDEN');});
after(()=>mock.restoreAll());
const response=(url,body={object:{sha:SHA}},options={})=>{
  const r=new Response(typeof body==='string'?body:JSON.stringify(body),{headers:{'content-type':'application/json'},...options});
  Object.defineProperty(r,'url',{value:url});return r;
};
function fixture(options={}){
  const calls=[];
  const fetchImpl=options.fetchImpl||((url,init)=>{calls.push({url,init});return response(url);});
  return {calls,client:createSyncGithubRead({token:TOKEN,fetchImpl,...options})};
}
const read=(client,path=MAIN)=>client.readGithubJson({method:'GET',path});
async function refusal(promise,code){
  await assert.rejects(promise,error=>{
    assert.equal(syncGithubReadFailureCode(error),'FEE_SYNC_GITHUB_'+code);
    for(const text of [error.message,JSON.stringify(error),error.stack])for(const value of [TOKEN,SECRET,ROOT])assert.ok(!text.includes(value));
    assert.equal(Object.isFrozen(error),true);return true;
  });
}

test('all and only published-base route shapes use explicit fixed-origin GET authentication',async()=>{
  const paths=['git/ref/heads/main','git/ref/heads/market-data-cache','git/matching-refs/heads/codex/fee-daily-20261107-',
    ...['data.json','fee-data-health.json','benchmark-close.json'].map(name=>'contents/'+name+'?ref='+SHA),
    'commits/'+SHA,'actions/workflows/validate-fee-data.yml/runs?branch=codex%2Ffee-daily-20261107-a1b2c3&per_page=5'];
  const {client,calls}=fixture();
  for(const path of paths)assert.deepEqual(await read(client,ROOT+path),{object:{sha:SHA}});
  assert.equal(calls.length,paths.length);
  for(let i=0;i<calls.length;i++){
    const {url,init}=calls[i];assert.equal(url,'https://api.github.com'+ROOT+paths[i]);
    assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
    assert.equal(init.headers.Authorization,'Bearer '+TOKEN);assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.body,undefined);
  }
  client.close();
});

test('path, method, origin, secret, query and encoding escapes are rejected before transport',async()=>{
  const {client,calls}=fixture();
  const paths=[MAIN+'\n',MAIN+'\r\nAuthorization:'+TOKEN,MAIN+'#fragment',MAIN+'?token='+TOKEN,
    MAIN+'?ref=main','https://api.github.com'+MAIN,'//api.github.com'+MAIN,
    ROOT+'../another/data.json',ROOT+'git/ref/heads/%6dain',ROOT+'git/ref/heads/main%00',ROOT+'git/ref/heads/main/',
    ROOT.replace('fee-console','another-repo')+'git/ref/heads/main',ROOT+'contents/.env?ref='+SHA,
    ROOT+'contents/data.json?ref=main',ROOT+'contents/data.json?ref='+SHA+'&token='+TOKEN,
    ROOT+'commits/'+SHA.toUpperCase(),ROOT+'actions/workflows/fee-cloud-producer.yml/runs?per_page=5',
    ROOT+'actions/workflows/validate-fee-data.yml/runs?branch=codex%2ffee-daily-20261107-a1b2c3&per_page=5',
    ROOT+'actions/workflows/validate-fee-data.yml/runs?branch=codex%252Ffee-daily-20261107-a1b2c3&per_page=5',
    ROOT+'actions/workflows/validate-fee-data.yml/runs?branch=codex%2Ffee-daily-20261107-a1b2c3&per_page=100',
    '/gists/'+SHA,ROOT+'actions/secrets',ROOT+'git/ref/heads/main\\evil',ROOT+'git/ref/heads/main\u2028'];
  for(const path of paths)await refusal(read(client,path),'SCOPE');
  for(const request of [{method:'POST',path:MAIN},{method:'get',path:MAIN},{method:'GET',path:MAIN,body:{}},
    {method:'GET',path:MAIN,headers:{Authorization:SECRET}},{method:'GET',path:MAIN,signal:new AbortController().signal}]){
    await refusal(client.readGithubJson(request),'SCOPE');
  }
  assert.equal(calls.length,0);client.close();
});

test('configuration is explicit, bounded and refuses accessors/proxies without executing them',()=>{
  const fetchImpl=()=>assert.fail('transport must not run');
  const invalid=[undefined,{}, {fetchImpl}, {token:TOKEN}, {token:'',fetchImpl},{token:TOKEN+'\n',fetchImpl},
    {token:TOKEN+' '+SECRET,fetchImpl},{token:TOKEN,fetchImpl,timeoutMs:0},{token:TOKEN,fetchImpl,timeoutMs:20001},
    {token:TOKEN,fetchImpl,maxBytes:0},{token:TOKEN,fetchImpl,maxBytes:8*1024*1024+1},
    {token:TOKEN,fetchImpl,credentials:SECRET},{token:TOKEN,fetchImpl:new Proxy(fetchImpl,{})},
    new Proxy({token:TOKEN,fetchImpl},{get(){throw Error(SECRET);}})];
  let accessed=0;invalid.push(Object.defineProperty({fetchImpl},'token',{enumerable:true,get(){accessed++;throw Error(SECRET);}}));
  for(const options of invalid)assert.throws(()=>createSyncGithubRead(options),e=>syncGithubReadFailureCode(e)==='FEE_SYNC_GITHUB_CONFIG'&&!e.message.includes(SECRET));
  assert.equal(accessed,0);
});

test('request getters, proxies, symbols and malformed objects never reach fetch',async()=>{
  const {client,calls}=fixture();let accessed=0;
  const getter=Object.defineProperty({method:'GET'},'path',{enumerable:true,get(){accessed++;throw Error(SECRET);}});
  for(const request of [getter,new Proxy({method:'GET',path:MAIN},{get(){throw Error(SECRET);}}),
    {method:'GET',path:MAIN,[Symbol('secret')]:SECRET},null,[],Object.create({method:'GET',path:MAIN})]){
    await refusal(client.readGithubJson(request),'SCOPE');
  }
  assert.equal(accessed,0);assert.equal(calls.length,0);client.close();
});

test('redirects, off-origin responses and non-200 statuses do not return bodies or retry',async()=>{
  for(const scenario of ['redirect','origin','status']){
    let calls=0;
    const {client}=fixture({fetchImpl:async url=>{calls++;const r=response(scenario==='origin'?'https://example.invalid/':url,SECRET,{status:scenario==='status'?403:200});
      if(scenario==='redirect')Object.defineProperty(r,'redirected',{value:true});return r;}});
    await refusal(read(client),'HTTP');assert.equal(calls,1);client.close();
  }
});

test('response type, declared and streamed size, UTF-8 and JSON are bounded',async()=>{
  const scenarios=[['TYPE',url=>response(url,SECRET,{headers:{'content-type':'text/html'}})],
    ['SIZE',url=>response(url,{}, {headers:{'content-type':'application/json','content-length':'1000'}})],
    ['SIZE',url=>response(url,{large:'x'.repeat(300)})],['JSON',url=>response(url,SECRET)],
    ['JSON',url=>{const r=new Response(new Uint8Array([0xff]),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;}],
    ['RESPONSE',url=>response(url,'null')]];
  for(const [code,make] of scenarios){const {client}=fixture({maxBytes:128,fetchImpl:async url=>make(url)});await refusal(read(client),code);client.close();}
});

test('source exceptions and hostile error properties produce fixed sanitized codes',async()=>{
  const modified=new BoundedJsonError(SECRET);
  const getter=new BoundedJsonError('HTTP');Object.defineProperty(getter,'code',{get(){throw Error(SECRET);}});
  for(const error of [Error(SECRET+' '+TOKEN),modified,getter,new Proxy(new Error(),{get(){throw Error(SECRET);},getPrototypeOf(){throw Error(SECRET);}})]){
    const {client}=fixture({fetchImpl:async()=>{throw error;}});
    await assert.rejects(read(client),caught=>{
      assert.ok(['FEE_SYNC_GITHUB_NETWORK','FEE_SYNC_GITHUB_REQUEST'].includes(syncGithubReadFailureCode(caught)));
      assert.ok(!caught.message.includes(SECRET)&&!caught.stack.includes(TOKEN));return true;
    });client.close();
  }
  assert.equal(syncGithubReadFailureCode({message:SECRET}),'FEE_SYNC_GITHUB_REFUSED');
});

test('deadline aborts a never-resolving injected fetch without retry',async()=>{
  let calls=0,signal;
  const {client}=fixture({timeoutMs:10,fetchImpl:(_url,init)=>{calls++;signal=init.signal;return new Promise(()=>{});}});
  await refusal(read(client),'TIMEOUT');assert.equal(calls,1);assert.equal(signal.aborted,true);client.close();
});

test('deadline also bounds a stalled response body',async()=>{
  let signal;
  const {client}=fixture({timeoutMs:10,fetchImpl:async(url,init)=>{signal=init.signal;return {url,status:200,redirected:false,
    headers:new Headers({'content-type':'application/json'}),body:{getReader(){return {read:()=>new Promise(()=>{}),cancel(){},releaseLock(){}};}}};}});
  await refusal(read(client),'TIMEOUT');assert.equal(signal.aborted,true);client.close();
});

test('close aborts all concurrent requests immediately and rejects future reads',async()=>{
  const signals=[];
  const {client}=fixture({timeoutMs:50,fetchImpl:(_url,init)=>{signals.push(init.signal);return new Promise(()=>{});}});
  const first=read(client),second=read(client,ROOT+'git/ref/heads/market-data-cache');
  assert.equal(signals.length,2);client.close();client.close();
  await Promise.all([refusal(first,'CLOSED'),refusal(second,'CLOSED')]);
  assert.ok(signals.every(signal=>signal.aborted));await refusal(read(client),'CLOSED');assert.equal(signals.length,2);
});

test('a late result after close cannot escape as a success',async()=>{
  let resolve,url;
  const {client}=fixture({fetchImpl:u=>{url=u;return new Promise(r=>{resolve=r;});}});
  const pending=read(client);client.close();resolve(response(url));await refusal(pending,'CLOSED');
});

test('production module has no executable, credential discovery or mutation entry point',()=>{
  const source=readFileSync(new URL('./fee-sync-github-read.mjs',import.meta.url),'utf8');
  for(const pattern of [/process\.env/,/process\.argv/,/node:fs/,/node:child_process/,/globalThis\.fetch/,/method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/,/console\./])assert.doesNotMatch(source,pattern);
});
