// Real intake, Job and coordinator; fictitious HTTP, storage and credentials only.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {runRefreshAcceptance, acceptanceOrigin, parseAcceptanceArgs, ACCEPTANCE_ORIGIN} from './fee-manager-refresh-acceptance.mjs';
import {handleIntake, runRefreshJob, API, REQUEST_FILE} from './fee-manager-refresh-server.mjs';
import {createMemoryLedger, OWNER_ID, SCHEMA} from './fee-manager-refresh.mjs';
import {buildHealth, validateHealth} from './fee-data-health.mjs';

const HOST='https://fee-refresh-intake-acceptance-synthetic-hk.a.run.app';
const ID='10000000-0000-4000-8000-000000000001', GHOST='10000000-0000-4000-8000-000000000002';
const REV='b'.repeat(40), GIST='a'.repeat(32), TOKEN='synthetic-read-only-not-a-real-token';
const enc=v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v));
const final=()=>({requestId:ID,contents:['fee'],fee:{state:'failed',code:'PUBLISHER_REFUSED',dataDate:'2026-11-10'},ratio:null});
function fixture({edit, drop, hang, missingCredential=false, skipJob=false, requestEdit, onCall}={}) {
  const now=()=>new Date('2026-11-11T02:05:00.000Z');
  const request={schema:SCHEMA.request,requestId:ID,contents:['fee'],feeDataDate:'2026-11-10',createdAt:'2026-11-11T02:03:00.000Z',...requestEdit};
  const calls=[],writes=[],upstream=[];let jobStarts=0,producerDispatches=0,tokenReads=0,pendingJob=false,mode='acceptance';
  const bucket=name=>{const b=createMemoryLedger();return {...b,
    create:async(key,value)=>{writes.push({name,key});return b.create(key,value);},
    names:async prefix=>(await b.list(prefix)).map(v=>v.key)};};
  const queue=bucket('queue'),status=bucket('status'),ledger=bucket('ledger');
  const data=enc('entirely fictitious previous encrypted data'), sha='c'.repeat(40);
  const health=buildHealth({checkedAt:now().toISOString(),targetDate:'2026-11-09',
    sourceDates:{schwab:'2026-11-09',webull:'2026-11-09',benchmark:'2026-11-09'},outcome:'updated',
    dataSha256:crypto.createHash('sha256').update(data).digest('hex')});
  const http=async(method,url)=>{
    upstream.push({method,url});if(method!=='GET'){producerDispatches++;throw Error('PRODUCER_FORBIDDEN');}
    if(url==='https://api.github.com/gists/'+GIST)return {status:200,bytes:enc({id:GIST,public:false,owner:{id:OWNER_ID},
      history:[{version:REV,committed_at:'2026-11-11T02:04:00Z',user:{id:OWNER_ID}}],
      files:{[REQUEST_FILE]:{content:JSON.stringify(request),truncated:false}}})};
    if(url===API+'/git/ref/heads/main')return {status:200,bytes:enc({object:{sha}})};
    if(url===API+'/contents/data.json?ref='+sha)return {status:200,bytes:data};
    if(url===API+'/contents/fee-data-health.json?ref='+sha)return {status:200,bytes:enc(health)};
    if(url.startsWith(API+'/actions/runs?'))return {status:200,bytes:enc({total_count:0,workflow_runs:[]})};
    if(url.startsWith(API+'/git/matching-refs/heads/'))return {status:200,bytes:enc([])};
    throw Error('UNEXPECTED_SYNTHETIC_GET');
  };
  const job=()=>runRefreshJob({queue,status,ledger,http,gistId:GIST,now,wait:async()=>{},validateHealth,mode:'acceptance',
    readToken:()=>{tokenReads++;if(missingCredential)throw Error('NO_READING_CREDENTIAL');return TOKEN;}});
  const fetchImpl=async(url,init)=>{
    const path=new URL(url).pathname,headers=new Headers(init.headers);
    assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.referrerPolicy,'no-referrer');
    assert.equal(headers.has('authorization'),false);assert.equal(headers.has('cookie'),false);
    const req={method:init.method,path,headers:{origin:headers.get('origin')},body:init.body};calls.push(req);onCall?.(req,t);
    if(req.method==='GET'&&path==='/v1/requests/'+ID&&pendingJob&&!skipJob){pendingJob=false;await job();}
    const raw=await handleIntake(req,{queue,status,http,gistId:GIST,now,mode,runJob:async()=>{jobStarts++;pendingJob=true;}});
    if(drop?.(req))throw Error('synthetic raw error must never be printed '+ID+' '+REV+' '+TOKEN);
    if(hang?.(req))return new Promise(()=>{});
    const out=edit?.(req,raw)??raw;
    return new Response([204,205,304].includes(out.status)?null:out.body,{status:out.status,headers:out.headers});
  };
  const t={calls,writes,upstream,queue,status,ledger,job,fetchImpl,setMode:v=>{mode=v;},
    get counts(){return {jobStarts,producerDispatches,tokenReads};},
    run:extra=>runRefreshAcceptance({intake:HOST,fetchImpl,uuid:()=>GHOST,totalTimeoutMs:2000,requestTimeoutMs:100,pollIntervalMs:1,maxPolls:3,...extra})};
  return t;
}
const owner={execute:true,requestId:ID,gistVersion:REV};
const ownerPosts=t=>t.calls.filter(c=>c.method==='POST'&&c.path==='/v1/requests'&&JSON.parse(c.body).requestId===ID);
const ownerGets=t=>t.calls.filter(c=>c.method==='GET'&&c.path==='/v1/requests/'+ID);
const hidden=result=>{const text=JSON.stringify(result);for(const value of [ID,GHOST,REV,TOKEN,'raw error'])assert.ok(!text.includes(value));
  assert.equal(result.launchReady,false);assert.equal(result.deploymentIsolationVerified,false);assert.equal(result.validOwnerCloseRaceVerified,false);};

test('host and CLI guards accept only exact acceptance roots and strict unique options',async()=>{
  for(const host of [HOST,HOST+'/', 'https://fee-refresh-intake-acceptance-123456789.asia-east2.run.app'])assert.ok(acceptanceOrigin(host));
  for(const intake of [undefined,'http://'+new URL(HOST).host,HOST+'/x',HOST+'?',HOST+'#',HOST+'?a=1',HOST+'#a',HOST+'\n',
    HOST.replace('https://','https://user:pass@'),HOST.replace('.run.app','.run.app.invalid'),
    HOST.replace('-acceptance',''),HOST.replace('.a.run.app',':443.a.run.app'),
    'https://fee-refresh-intake-acceptance.evil.run.app','https://example.com',HOST.replace('.app','.app:443'),
    HOST.replace('-synthetic-hk','-copy-synthetic-hk')]){
    let calls=0;const r=await runRefreshAcceptance({intake,fetchImpl:async()=>{calls++;}});assert.equal(r.passed,false);assert.equal(calls,0);
  }
  assert.deepEqual(parseAcceptanceArgs(['--intake='+HOST,'--execute','--request-id='+ID,'--gist-version='+REV,'--wait-seconds=3']),
    {intake:HOST,execute:true,requestId:ID,gistVersion:REV,totalTimeoutMs:3000});
  for(const args of [['--execute','--execute'],['--token=abc'],['--intake='+HOST,'--intake='+HOST],['--wait-seconds=1.5'],['--execute=true']])assert.throws(()=>parseAcceptanceArgs(args));
});
test('default preflight uses only GET/OPTIONS: zero storage, Gist, UUID generation or Job IO',async()=>{
  const t=fixture(),r=await t.run({uuid:()=>{throw Error('NO_UUID');}});
  assert.equal(r.passed,true);assert.equal(r.stage,'preflight');assert.equal(r.preflightPassed,true);
  assert.equal(r.intakeOnlyPassed,false);assert.equal(r.ownerRequestPassed,false);
  assert.ok(t.calls.every(c=>['GET','OPTIONS'].includes(c.method)));assert.equal(t.writes.length,0);assert.equal(t.upstream.length,0);
  assert.deepEqual(t.counts,{jobStarts:0,producerDispatches:0,tokenReads:0});hidden(r);
});
test('owner parameters require execute and both valid proof identifiers before any network',async()=>{
  for(const extra of [{requestId:ID,gistVersion:REV},{execute:true,requestId:ID},{execute:true,gistVersion:REV},
    {...owner,requestId:'bad'},{...owner,gistVersion:'bad'},{execute:'true'},{totalTimeoutMs:300001},{requestTimeoutMs:15001}]){
    const t=fixture(),r=await t.run(extra);assert.equal(r.passed,false);assert.equal(t.calls.length,0);
  }
});
test('mode failures, missing endpoint and malformed/self-expanded mode objects stop before writes',async()=>{
  for(const [status,value] of [[404,{code:'REQUEST_INVALID'}],[503,{code:'INTAKE_NOT_ACTIVE'}],[200,{schema:'fee-console.manager-refresh-mode.v1',mode:'launch'}],
    [200,{schema:'fee-console.manager-refresh-mode.v1',mode:'disabled'}],[200,{mode:'acceptance'}],
    [200,{schema:'fee-console.manager-refresh-mode.v1',mode:'acceptance',jobVerified:true}], [200,null]]){
    const t=fixture({edit:(req,out)=>req.path==='/v1/mode'?{...out,status,body:JSON.stringify(value)}:out});
    assert.equal((await t.run(owner)).passed,false);assert.equal(t.writes.length,0);assert.equal(ownerPosts(t).length,0);
  }
});
test('CORS/no-store/preflight policy mismatches stop before any writing probe',async()=>{
  for(const change of [h=>delete h['Access-Control-Allow-Origin'],h=>h['Access-Control-Allow-Origin']='*',h=>h['Cache-Control']='public',
    h=>h['Content-Type']='text/plain',h=>h['Access-Control-Allow-Headers']='authorization',h=>h['Access-Control-Allow-Methods']='GET']){
    const t=fixture({edit:(req,out)=>{if(req.headers.origin===ACCEPTANCE_ORIGIN){const headers={...out.headers};change(headers);return {...out,headers};}return out;}});
    assert.equal((await t.run(owner)).passed,false);assert.equal(t.writes.length,0);assert.equal(ownerPosts(t).length,0);
  }
  const t=fixture({edit:(req,out)=>req.headers.origin!==ACCEPTANCE_ORIGIN?{...out,status:200}:out});
  assert.equal((await t.run(owner)).passed,false);assert.equal(t.writes.length,0);
});
test('transport bounds reject malformed/duplicate JSON, excessive bodies and redirects before writes',async()=>{
  for(const bad of [out=>({...out,body:'{'}),out=>({...out,body:'{"schema":"fee-console.manager-refresh-mode.v1","mode":"launch","mode":"acceptance"}'}),
    out=>({...out,body:' '.repeat(8193)}),out=>({...out,headers:{...out.headers,'Content-Length':'8193'}}),
    out=>({...out,status:302,headers:{...out.headers,Location:HOST}})]){
    const t=fixture({edit:(req,out)=>req.path==='/v1/mode'?bad(out):out});
    assert.equal((await t.run(owner)).passed,false);assert.equal(t.writes.length,0);
  }
  for(const variant of ['redirected','different-url','utf8','stream-too-big','stream-stalls']){
    let calls=0;
    const r=await runRefreshAcceptance({intake:HOST,execute:true,requestTimeoutMs:10,totalTimeoutMs:40,fetchImpl:async()=>{
      calls++;const response=new Response(variant==='utf8'?Uint8Array.of(255):variant==='stream-too-big'?new Uint8Array(8193)
        :variant==='stream-stalls'?new ReadableStream({start(){}}):JSON.stringify({schema:'fee-console.manager-refresh-mode.v1',mode:'acceptance'}),
        {headers:{'content-type':'application/json','cache-control':'no-store','access-control-allow-origin':ACCEPTANCE_ORIGIN}});
      if(variant==='redirected')Object.defineProperty(response,'redirected',{value:true});
      if(variant==='different-url')Object.defineProperty(response,'url',{value:'https://example.com'});
      return response;
    }});assert.equal(r.passed,false);assert.equal(calls,1);
  }
});
test('fetch ignoring AbortSignal still ends at the single-request deadline with no further IO',async()=>{
  let calls=0;const r=await runRefreshAcceptance({intake:HOST,execute:true,requestTimeoutMs:10,totalTimeoutMs:40,
    fetchImpl:()=>{calls++;return new Promise(()=>{});}});assert.equal(r.passed,false);assert.equal(calls,1);
});
test('intake-only probes leave closed records, read no Gist, start no Job and never claim full acceptance',async()=>{
  const t=fixture(),r=await t.run({execute:true});assert.equal(r.passed,true);assert.equal(r.stage,'intake-only');
  assert.equal(r.intakeOnlyPassed,true);assert.equal(r.ownerRequestPassed,false);
  assert.equal((await t.queue.get('queue/'+GHOST)).schema,'fee-console.manager-refresh-closed.v1');
  assert.equal(t.upstream.length,0);assert.equal(t.counts.jobStarts,0);hidden(r);
});
test('ambiguous invalid POST or close stops immediately without retry, status recovery or replacement UUID',async()=>{
  for(const path of ['/v1/requests','/v1/requests/'+GHOST+'/close']){
    const t=fixture({drop:req=>req.method==='POST'&&req.path===path}),r=await t.run({execute:true});
    assert.equal(r.passed,false);assert.equal(t.calls.at(-1).path,path);assert.equal(t.calls.at(-1).method,'POST');
    assert.equal(t.calls.filter(c=>c.method==='POST'&&c.path===path).length,1);hidden(r);
  }
});
test('mode is rechecked before every write; a changed intake mode prevents the next probe',async()=>{
  const t=fixture({onCall:req=>{if(req.method==='GET'&&req.path==='/v1/requests/'+GHOST)t.setMode('launch');}});
  const r=await t.run(owner);assert.equal(r.passed,false);assert.equal(ownerPosts(t).length,0);
  assert.equal(t.calls.filter(c=>c.path.endsWith('/close')).length,0);
});
test('real intake -> Job -> coordinator reaches same fee-only failed:PUBLISHER_REFUSED, zero producer dispatch',async()=>{
  const t=fixture(),r=await t.run(owner);
  assert.deepEqual((await t.status.get('status/'+ID+'/final'))?.fee,final().fee);
  assert.equal(r.passed,true,JSON.stringify(r));assert.equal(r.ownerRequestPassed,true);
  assert.equal(r.stage,'owner-request');assert.equal(t.counts.jobStarts,1);assert.equal(t.counts.producerDispatches,0);
  assert.ok(t.counts.tokenReads>0);assert.deepEqual(JSON.parse(JSON.stringify(await t.status.get('status/'+ID+'/final'))),final());
  assert.equal(ownerPosts(t).length,2);assert.deepEqual(ownerPosts(t).map(c=>JSON.parse(c.body)),[{requestId:ID,gistVersion:REV},{requestId:ID,gistVersion:REV}]);hidden(r);
});
test('missing reading credentials or stale/foreign/ratio owner proof cannot pass complete acceptance',async()=>{
  for(const config of [{missingCredential:true},{requestEdit:{createdAt:'2026-11-10T00:00:00Z'}},
    {requestEdit:{requestId:GHOST}},{requestEdit:{contents:['fee','ratio'],ratioDataAsOf:'2026-11-10'}}]){
    const t=fixture(config),r=await t.run(owner);assert.equal(r.ownerRequestPassed,false);assert.equal(r.passed,false);
    assert.equal(t.counts.producerDispatches,0);hidden(r);
  }
});
test('only exact owner acknowledgement status/identity/state permits the duplicate probe',async()=>{
  for(const [status,value] of [[200,{requestId:ID,state:'queued'}],[503,{requestId:ID,state:'queued'}],
    [202,{requestId:GHOST,state:'queued'}],[202,{requestId:ID,state:'unknown'}],[202,{requestId:ID,state:'duplicate'}],
    [400,{requestId:ID,state:'rejected',code:'REQUEST_INVALID'}]]){
    const t=fixture({edit:(req,out)=>req.method==='POST'&&req.path==='/v1/requests'&&JSON.parse(req.body).requestId===ID
      ?{...out,status,body:JSON.stringify(value)}:out});
    const r=await t.run(owner);assert.equal(r.passed,false);assert.equal(ownerPosts(t).length,1);assert.equal(ownerGets(t).length,0);
  }
});
test('unknown owner POST, duplicate or queued-close reply stops without any recovery writes or polling',async()=>{
  for(const at of ['first','duplicate','close']){
    let posts=0;const t=fixture({drop:req=>{
      if(req.method==='POST'&&req.path==='/v1/requests'&&JSON.parse(req.body).requestId===ID){posts++;return posts===(at==='first'?1:at==='duplicate'?2:0);}
      return at==='close'&&req.path==='/v1/requests/'+ID+'/close';
    }}),r=await t.run(owner);assert.equal(r.passed,false);assert.equal(ownerPosts(t).length,at==='first'?1:2);
    assert.equal(ownerGets(t).length,0);assert.equal(t.calls.at(-1).method,'POST');hidden(r);
  }
});
test('contradictory close and duplicate HTTP replies cannot trigger another write or owner poll',async()=>{
  for(const [status,state] of [[503,'closed'],[200,'unknown'],[202,'closed']]){
    const t=fixture({edit:(req,out)=>req.method==='POST'&&req.path==='/v1/requests/'+GHOST+'/close'
      ?{...out,status,body:JSON.stringify({requestId:GHOST,state})}:out});
    assert.equal((await t.run(owner)).passed,false);assert.equal(t.calls.at(-1).path,'/v1/requests/'+GHOST+'/close');
    assert.equal(t.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/close')).length,1);assert.equal(ownerPosts(t).length,0);
  }
  for(const [status,state] of [[200,'duplicate'],[503,'duplicate'],[202,'unknown']]){
    let posts=0;const t=fixture({edit:(req,out)=>{
      if(req.method==='POST'&&req.path==='/v1/requests'&&JSON.parse(req.body).requestId===ID&&++posts===2)
        return {...out,status,body:JSON.stringify({requestId:ID,state})};return out;
    }});assert.equal((await t.run(owner)).passed,false);assert.equal(ownerPosts(t).length,2);assert.equal(ownerGets(t).length,0);
    assert.equal(t.calls.at(-1).path,'/v1/requests');
  }
  for(const [status,state] of [[503,'queued'],[200,'unknown'],[200,'closed']]){
    const t=fixture({edit:(req,out)=>req.method==='POST'&&req.path==='/v1/requests/'+ID+'/close'
      ?{...out,status,body:JSON.stringify({requestId:ID,state})}:out});
    assert.equal((await t.run(owner)).passed,false);assert.equal(ownerGets(t).length,0);
    assert.equal(t.calls.at(-1).path,'/v1/requests/'+ID+'/close');
  }
});
test('a mode change after intake-only success stops before the first valid owner submission',async()=>{
  let gets=0;const t=fixture({onCall:req=>{if(req.method==='GET'&&req.path==='/v1/requests/'+GHOST&&++gets===2)t.setMode('launch');}});
  const r=await t.run(owner);assert.equal(r.intakeOnlyPassed,true);assert.equal(r.ownerRequestPassed,false);
  assert.equal(r.passed,false);assert.equal(ownerPosts(t).length,0);
});
test('wrong final identity, HTTP, fee code, state or ratio content never counts as owner success',async()=>{
  const cases=[v=>v.requestId=GHOST,v=>v.contents=['fee','ratio'],v=>v.ratio={state:'blocked',code:'FEE_NOT_VERIFIED'},
    v=>v.fee.state='published',v=>v.fee.state='unknown',v=>v.fee.code='VERIFY_UNAVAILABLE',v=>v.fee.code='RUN_ENDED_UNPUBLISHED',
    v=>v.fee.code='REQUEST_STALE',v=>delete v.fee.code,v=>v.code='IDENTITY_UNVERIFIED',v=>v.fee.dataDate='2026-02-30'];
  for(const change of cases){const t=fixture({edit:(req,out)=>{
    if(req.method==='GET'&&req.path==='/v1/requests/'+ID){const v=final();change(v);return {...out,body:JSON.stringify(v)};}return out;
  }});assert.equal((await t.run(owner)).passed,false);assert.equal(ownerGets(t).length,1);}
  const t=fixture({edit:(req,out)=>req.path==='/v1/requests/'+ID&&req.method==='GET'?{...out,status:503}:out});
  assert.equal((await t.run(owner)).passed,false);
});
test('polling is GET-only and bounded by count and the overall deadline',async()=>{
  const t=fixture({skipJob:true}),r=await t.run({...owner,maxPolls:3});assert.equal(r.passed,false);assert.equal(ownerGets(t).length,3);
  assert.equal(ownerPosts(t).length,2);hidden(r);
  const slow=fixture({skipJob:true}),end=await slow.run({...owner,maxPolls:300,totalTimeoutMs:100,pollIntervalMs:30});
  assert.equal(end.passed,false);assert.ok(ownerGets(slow).length<10);assert.equal(ownerPosts(slow).length,2);
});
test('CLI malformed options print only a redacted fixed result without starting networking',()=>{
  const p=spawnSync(process.execPath,[new URL('./fee-manager-refresh-acceptance.mjs',import.meta.url).pathname,'--token='+TOKEN],{encoding:'utf8'});
  assert.equal(p.status,1);assert.equal(p.stderr,'');const r=JSON.parse(p.stdout);assert.equal(r.passed,false);hidden(r);
});
