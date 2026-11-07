// Pure synthetic HTTP, credentials and metadata. Never reads account files,
// credentials, process environment, or the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRevisionGithubRead,isRevisionGithubRead,revisionGithubFailureCode} from './fee-sync-revision-github.mjs';

const ROOT='https://api.github.com/repos/huanwujoy-crypto/fee-console/';
const TOKEN='synthetic_revision_token_not_a_credential';
const SHA='a'.repeat(40),LOG='2026-09-02T01:02:03.000Z candidate '+SHA+'\n';
const BLOB='https://productionresultssa7.blob.core.windows.net/actions-results/synthetic/job.log?sig=synthetic_signature';
const config=fetchImpl=>({token:TOKEN,fetchImpl,clock:()=>1000,timeoutMs:200});
const code=(expected)=>e=>{
  assert.equal(revisionGithubFailureCode(e),'IB_REVISION_GITHUB_'+expected);
  assert.equal(e.message,'IB_REVISION_GITHUB_'+expected);
  assert.equal(Object.hasOwn(e,'cause'),false);
  assert.equal(JSON.stringify(e).includes(TOKEN),false);
  assert.equal(String(e.stack).includes(TOKEN),false);
  return true;
};
const rejected=(operation,expected)=>assert.rejects(async()=>operation(),code(expected));
function response(body,{url=ROOT+'git/ref/heads/main',status=200,headers={},redirected=false}={}){
  const r=new Response(body,{status,headers});
  Object.defineProperties(r,{url:{value:url},redirected:{value:redirected}});
  return r;
}
const json=(value,url,headers={})=>response(JSON.stringify(value),{url,headers:{'content-type':'application/json',...headers}});
const log=(body=LOG,url=ROOT+'actions/jobs/7/logs',overrides={})=>response(body,{url,...overrides});
const redirect=(location=BLOB,url=ROOT+'actions/jobs/7/logs',status=302)=>response(null,{url,status,headers:{location}});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('the factory requires explicit dependencies and authentic instances cannot be cloned',()=>{
  const c=config(async()=>assert.fail('no request expected')),a=createRevisionGithubRead(c);
  assert.equal(Object.isFrozen(a),true);assert.equal(isRevisionGithubRead(a),true);
  assert.equal(isRevisionGithubRead({...a}),false);assert.equal(isRevisionGithubRead(new Proxy(a,{})),false);
  assert.equal(isRevisionGithubRead(null),false);assert.equal(isRevisionGithubRead(undefined),false);
  assert.equal(JSON.stringify(a).includes(TOKEN),false);
  assert.equal(revisionGithubFailureCode(new Error('IB_REVISION_GITHUB_CONFIG')),'IB_REVISION_GITHUB_REFUSED');
  a.close();a.close();
});

for(const [name,build,expected] of [
  ['missing options',()=>undefined,'INPUT'],
  ['null options',()=>null,'INPUT'],
  ['array options',()=>[],'INPUT'],
  ['custom prototype',()=>Object.assign(Object.create({}),config(()=>{})),'INPUT'],
  ['extra URL',()=>({...config(()=>{}),url:'https://example.invalid/'}),'INPUT'],
  ['missing clock',()=>({token:TOKEN,fetchImpl:()=>{}}),'INPUT'],
  ['short token',()=>({...config(()=>{}),token:'short'}),'CONFIG'],
  ['long token',()=>({...config(()=>{}),token:'x'.repeat(8193)}),'CONFIG'],
  ['token newline',()=>({...config(()=>{}),token:TOKEN+'\n'}),'CONFIG'],
  ['token URL',()=>({...config(()=>{}),token:'https://example.invalid/token'}),'CONFIG'],
  ['non-string token',()=>({...config(()=>{}),token:{toString(){assert.fail('coercion forbidden');}}}),'CONFIG'],
  ['non-function fetch',()=>({...config(()=>{}),fetchImpl:{}}),'CONFIG'],
  ['non-function clock',()=>({...config(()=>{}),clock:1}),'CONFIG'],
  ['zero timeout',()=>({...config(()=>{}),timeoutMs:0}),'CONFIG'],
  ['fractional timeout',()=>({...config(()=>{}),timeoutMs:1.5}),'CONFIG'],
  ['excess timeout',()=>({...config(()=>{}),timeoutMs:20001}),'CONFIG'],
])test('rejects '+name+' before HTTP',()=>assert.throws(()=>createRevisionGithubRead(build()),code(expected)));

test('configuration proxies and accessors never execute',()=>{
  let traps=0;const trap=()=>{traps++;throw Error('unexpected trap');};
  for(const value of [new Proxy(config(()=>{}),{get:trap,getPrototypeOf:trap,ownKeys:trap}),
    Object.defineProperty(config(()=>{}),'token',{get:trap,enumerable:true}),
    Object.defineProperty(config(()=>{}),'timeoutMs',{value:50,enumerable:false}),
    {...config(()=>{}),[Symbol('extra')]:true}])assert.throws(()=>createRevisionGithubRead(value),code('INPUT'));
  for(const key of ['fetchImpl','clock'])assert.throws(()=>createRevisionGithubRead({...config(()=>{}),[key]:new Proxy(()=>{}, {apply:trap})}),code('CONFIG'));
  assert.equal(traps,0);
});

test('factory pins dependencies despite later option mutation',async()=>{
  const calls=[];const c=config(async(url,init)=>{calls.push({url,init});return json({ok:true},url);});
  const a=createRevisionGithubRead(c);Object.defineProperty(c,'token',{get(){assert.fail('mutable configuration getter');}});
  c.fetchImpl=()=>assert.fail('mutable configuration transport');c.clock=()=>assert.fail('mutable configuration clock');
  assert.deepEqual(await a.readJson('git/ref/heads/main'),{ok:true});
  assert.equal(calls.length,1);assert.equal(calls[0].init.headers.Authorization,'Bearer '+TOKEN);a.close();
});

test('only fixed JSON routes use explicit GET and the original GitHub token',async()=>{
  const calls=[],a=createRevisionGithubRead(config(async(url,init)=>{calls.push({url,init});return json({ok:true},url);}));
  const routes=['git/ref/heads/main','commits/'+SHA,'git/commits/'+SHA,'git/trees/'+SHA,
    'contents/data.json?ref='+SHA,'contents/fee-data-health.json?ref='+SHA,'actions/runs/8','actions/runs/8/jobs?per_page=100'];
  for(const route of routes)assert.deepEqual(await a.readJson(route),{ok:true});
  assert.deepEqual(calls.map(c=>c.url),routes.map(p=>ROOT+p));
  for(const {init} of calls){assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
    assert.equal(init.headers.Authorization,'Bearer '+TOKEN);assert.equal(init.headers.Accept,'application/vnd.github+json');
    assert.equal(init.headers['X-GitHub-Api-Version'],'2022-11-28');assert.equal(Object.hasOwn(init,'body'),false);assert.ok(init.signal instanceof AbortSignal);}
  a.close();
});

test('no arbitrary URL, path, query or coercion reaches transport',async()=>{
  let calls=0,traps=0;const a=createRevisionGithubRead(config(async()=>{calls++;assert.fail('refused scope reached transport');}));
  for(const route of [ROOT+'git/ref/heads/main','/git/ref/heads/main','../git/ref/heads/main','git/ref/heads/main?x=1',
    'git/ref/heads/main#x','git/ref/heads/other','git/trees/'+SHA+'?recursive=1','contents/other.json?ref='+SHA,
    'contents/data.json?ref=main','contents/data.json?ref='+SHA+'&extra=1','actions/runs/0','actions/runs/01',
    'actions/runs/8/jobs?per_page=100&page=2','actions/jobs/7/logs','actions/runs/8\n',null,undefined,
    {toString(){traps++;return 'git/ref/heads/main';}},new Proxy({}, {get(){traps++;throw Error();}})])await rejected(()=>a.readJson(route),'SCOPE');
  for(const id of ['7',0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,{valueOf(){traps++;return 7;}}])await rejected(()=>a.readJobLog(id),'SCOPE');
  assert.equal(calls,0);assert.equal(traps,0);a.close();
});

for(const [name,make] of [
  ['wrong URL',url=>json({ok:true},url+'/other')],
  ['already followed redirect',url=>response('{}',{url,redirected:true,headers:{'content-type':'application/json'}})],
  ['non-success status',url=>response('{}',{url,status:403,headers:{'content-type':'application/json'}})],
  ['non-JSON MIME',url=>response('{}',{url,headers:{'content-type':'text/html'}})],
  ['declared oversized JSON',url=>json({ok:true},url,{'content-length':String(8*1024*1024+1)})],
  ['actual oversized JSON',url=>json({text:'x'.repeat(8*1024*1024)},url)],
  ['malformed JSON',url=>response('{',{url,headers:{'content-type':'application/json'}})],
  ['invalid UTF-8 JSON',url=>response(Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0x22,0xff,0x22,0x7d]),{url,headers:{'content-type':'application/json'}})],
])test('JSON refuses '+name,async()=>{const a=createRevisionGithubRead(config(async url=>make(url)));await rejected(()=>a.readJson('git/ref/heads/main'),'REQUEST');a.close();});

for(const [name,value] of [['nested token',{nested:[{value:TOKEN}]}],['reflected object key',{[TOKEN]:true}],['null',null],['primitive',1]])
  test('JSON rejects '+name+' without exposing response',async()=>{const a=createRevisionGithubRead(config(async url=>json(value,url)));await rejected(()=>a.readJson('git/ref/heads/main'),'RESPONSE');a.close();});

test('direct job log preserves exact bytes and only sends token to fixed GitHub GET',async()=>{
  const calls=[],a=createRevisionGithubRead(config(async(url,init)=>{calls.push({url,init});return log(LOG,url);}));
  const bytes=await a.readJobLog(7);assert.ok(Buffer.isBuffer(bytes));assert.deepEqual(bytes,Buffer.from(LOG));
  assert.equal(calls.length,1);assert.equal(calls[0].url,ROOT+'actions/jobs/7/logs');
  assert.equal(calls[0].init.method,'GET');assert.equal(calls[0].init.redirect,'manual');assert.equal(calls[0].init.credentials,'omit');
  assert.equal(calls[0].init.headers.Authorization,'Bearer '+TOKEN);a.close();
});

test('one official log redirect never forwards GitHub authorization or other credentials',async()=>{
  const calls=[],a=createRevisionGithubRead(config(async(url,init)=>{calls.push({url,init});return calls.length===1?redirect(BLOB,url):log(LOG,url);}));
  assert.deepEqual(await a.readJobLog(7),Buffer.from(LOG));assert.equal(calls.length,2);assert.equal(calls[1].url,BLOB);
  assert.equal(calls[1].init.method,'GET');assert.equal(calls[1].init.redirect,'error');assert.equal(calls[1].init.credentials,'omit');
  assert.deepEqual(calls[1].init.headers,{Accept:'text/plain'});assert.equal(JSON.stringify(calls[1]).includes(TOKEN),false);a.close();
});

for(const location of ['https://example.invalid/actions-results/log','https://productionresultssa7.blob.core.windows.net.example.invalid/actions-results/log',
  'https://productionresultssa7.blob.core.windows.net/other/log','http://productionresultssa7.blob.core.windows.net/actions-results/log',
  'https://user:pass@productionresultssa7.blob.core.windows.net/actions-results/log','https://productionresultssa7.blob.core.windows.net:444/actions-results/log',
  'https://productionresultssa7.blob.core.windows.net/actions-results/log#fragment','https://productionresultssa.blob.core.windows.net/actions-results/log'])
  test('unapproved redirect host, path or authority is refused: '+location,async()=>{
    let calls=0;const a=createRevisionGithubRead(config(async url=>{calls++;return redirect(location,url);}));
    await rejected(()=>a.readJobLog(7),'LOG_HOST');assert.equal(calls,1);a.close();
  });

for(const [name,reflected] of [['literal',TOKEN],['percent-encoded',Array.from(TOKEN,c=>'%'+c.charCodeAt(0).toString(16)).join('')]])
test(name+' token inside an official Location URL is never sent to the blob host',async()=>{
  const calls=[],location=BLOB+'&reflection='+reflected;
  const a=createRevisionGithubRead(config(async(url,init)=>{calls.push({url,init});return calls.length===1?redirect(location,url):log(LOG,url);}));
  await assert.rejects(()=>a.readJobLog(7));assert.equal(calls.length,1,'reject reflected token before the second request');a.close();
});

for(const [name,make] of [
  ['empty',url=>log('',url)],['oversized',url=>log(Buffer.alloc(2*1024*1024+1,65),url)],
  ['invalid UTF-8',url=>log(Buffer.from([0xff]),url)],['reflected token',url=>log('value='+TOKEN,url)],
  ['reflected split token',url=>{const stream=new ReadableStream({start(c){c.enqueue(Buffer.from(TOKEN.slice(0,15)));c.enqueue(Buffer.from(TOKEN.slice(15)));c.close();}});return log(stream,url);}],
  ['wrong final URL',url=>log(LOG,url+'/other')],['auto-followed redirect',url=>log(LOG,url,{redirected:true})],
  ['another redirect',url=>redirect(BLOB,url)],
])test('redirect log body rejects '+name,async()=>{
  let calls=0;const a=createRevisionGithubRead(config(async url=>++calls===1?redirect(BLOB,url):make(url)));
  await rejected(()=>a.readJobLog(7),'LOG');assert.equal(calls,2);a.close();
});

test('non-byte log chunks fail closed instead of bypassing size accounting',async()=>{
  let reads=0;const a=createRevisionGithubRead(config(async url=>({status:200,redirected:false,url,
    body:{getReader(){return {async read(){return reads++?{done:true}:{done:false,value:'synthetic string chunk'};},cancel(){},releaseLock(){}};}}})));
  await assert.rejects(()=>a.readJobLog(7));a.close();
});

test('array-like log chunks cannot supply a false byte length',async()=>{
  let reads=0;const a=createRevisionGithubRead(config(async url=>({status:200,redirected:false,url,
    body:{getReader(){return {async read(){return reads++?{done:true}:{done:false,value:{0:65,length:1,byteLength:-1}};},cancel(){},releaseLock(){}};}}})));
  await assert.rejects(()=>a.readJobLog(7));a.close();
});

test('exactly two MiB of genuine log bytes fits the inclusive limit',async()=>{
  const bytes=Buffer.alloc(2*1024*1024,65),a=createRevisionGithubRead(config(async url=>log(bytes,url)));
  assert.deepEqual(await a.readJobLog(7),bytes);a.close();
});

test('HTTP failure errors never disclose token, URL or transport exception',async()=>{
  const a=createRevisionGithubRead(config(async()=>{throw Error('private '+TOKEN+' '+BLOB);}));
  await rejected(()=>a.readJson('git/ref/heads/main'),'REQUEST');await rejected(()=>a.readJobLog(7),'REQUEST');a.close();
});

test('timeouts bound a transport which ignores abort and never retry',async()=>{
  const calls=[],c=config(async(url,init)=>{calls.push({url,init});return new Promise(()=>{});});c.timeoutMs=15;
  const a=createRevisionGithubRead(c),began=Date.now();await rejected(()=>a.readJobLog(7),'REQUEST');
  assert.ok(Date.now()-began<1000);assert.equal(calls.length,1);assert.equal(calls[0].init.signal.aborted,true);a.close();
});

test('a late first response after timeout cannot initiate a second redirected request',async()=>{
  const gate=deferred(),calls=[],c=config(async(url,init)=>{calls.push({url,init});return calls.length===1?gate.promise:log(LOG,url);});c.timeoutMs=15;
  const a=createRevisionGithubRead(c);await rejected(()=>a.readJobLog(7),'REQUEST');
  gate.resolve(redirect());await tick();await tick();
  assert.equal(calls.length,1,'the expired operation must not start another GET');a.close();
});

test('close aborts concurrent JSON and log reads, refuses later reads, and does not retry',async()=>{
  const calls=[],a=createRevisionGithubRead(config(async(url,init)=>{calls.push({url,init});return new Promise(()=>{});}));
  const j=a.readJson('git/ref/heads/main'),l=a.readJobLog(7);assert.equal(calls.length,2);
  const checks=[rejected(()=>j,'CLOSED'),rejected(()=>l,'CLOSED')];a.close();await Promise.all(checks);
  assert.ok(calls.every(c=>c.init.signal.aborted));
  await rejected(()=>a.readJson('git/ref/heads/main'),'CLOSED');await rejected(()=>a.readJobLog(7),'CLOSED');
  assert.equal(calls.length,2);a.close();
});

test('late response after close cannot begin redirect or return data',async()=>{
  const gate=deferred(),calls=[],a=createRevisionGithubRead(config(async(url,init)=>{calls.push({url,init});return gate.promise;}));
  const pending=a.readJobLog(7),check=rejected(()=>pending,'CLOSED');a.close();await check;
  gate.resolve(redirect());await tick();assert.equal(calls.length,1);
});

test('close during a suspended log stream aborts and returns no bytes',async()=>{
  const waiting=deferred(),entered=deferred();let signal;
  const a=createRevisionGithubRead(config(async(url,init)=>{signal=init.signal;return {status:200,redirected:false,url,
    body:{getReader(){return {read(){entered.resolve();return waiting.promise;},cancel(){},releaseLock(){}};}}};}));
  const pending=a.readJobLog(7);await entered.promise;const check=rejected(()=>pending,'CLOSED');a.close();await check;
  assert.equal(signal.aborted,true);waiting.resolve({done:true});await tick();
});
