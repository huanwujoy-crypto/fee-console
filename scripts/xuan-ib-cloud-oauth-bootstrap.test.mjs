// Pure synthetic adapters only. Never instantiate a real listener/browser/SDK.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {BOOTSTRAP,BOOTSTRAP_SPEC,createBootstrap,preflightLoopback,registrationProfile,validateLoopbackUri,
  bootstrapCli,createSdkWriter,createSdkProcessBridge,SDK_BRIDGE_CODE} from './xuan-ib-cloud-oauth-bootstrap.mjs';
const NOW=Date.parse('2026-10-16T02:00:00.000Z'),URI='http://127.0.0.1:45123/oauth/ib/callback';
const CANARY={access:'SYNTHETIC_PRIVATE_ACCESS_CANARY',refresh:'SYNTHETIC_PRIVATE_REFRESH_CANARY',code:'SYNTHETIC_PRIVATE_CODE_CANARY',
  management:'SYNTHETIC_PRIVATE_MANAGEMENT_CANARY',error:'SYNTHETIC_PRIVATE_ERROR_CANARY',google:'SYNTHETIC_PRIVATE_GOOGLE_CANARY'};
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
let fixture=0;
function fakeClock(){let time=NOW,next=0;const timers=new Map();return {now:()=>time,setTimeout:(fn,ms)=>{const id=++next;timers.set(id,{at:time+ms,fn});return id;},
  clearTimeout:id=>timers.delete(id),async advance(ms){time+=ms;for(const [id,t] of [...timers])if(t.at<=time){timers.delete(id);t.fn();}for(let i=0;i<15;i++)await Promise.resolve();}};}
function harness(opts={}){
  const id=++fixture,clock=fakeClock(),calls=[],writes=[],opened=[],binds=[],privateRandom=[];let n=0,closed=0,maintenanceCalls=0;
  const approval={spec:BOOTSTRAP_SPEC,codeSha256:'a'.repeat(64),redirectUri:URI,operatorAccount:'synthetic-operator@example.invalid',precedingVersion:'50',approved:true,acceptMacReplacement:true};
  Object.assign(approval,opts.approval);
  const listener={async bind(input){binds.push(input);if(opts.bindThrow)throw Error(CANARY.error);
    const resource={host:opts.host??'127.0.0.1',port:opts.port??45123,setHandler(){},async close(){closed++;if(opts.closeThrow)throw Error(CANARY.error);}};
    if(opts.deferredBind)await opts.deferredBind;return resource;}};
  const registration=()=>({...registrationProfile(URI),client_id:'SYNTHETIC_NEW_CLIENT',registration_access_token:CANARY.management});
  const token=()=>({access_token:CANARY.access,refresh_token:CANARY.refresh,token_type:'Bearer',scope:'mcp.read',expires_in:3600});
  const fetchImpl=async(url,request)=>{calls.push({url,request});assert.ok([BOOTSTRAP.register,BOOTSTRAP.token].includes(url),'ONLY_FIXED_OAUTH_ENDPOINTS');
    assert.equal(request.redirect,'error');assert.equal(request.credentials,'omit');
    if(url===BOOTSTRAP.register)return opts.registerResponse?opts.registerResponse(registration(),request):Response.json(registration());
    return opts.tokenResponse?opts.tokenResponse(token(),request):Response.json(token());};
  const store={async save(credential,options){writes.push({credential,options});return opts.save?opts.save(credential,options):{name:BOOTSTRAP.secret+'/versions/51',state:'ENABLED'};}};
  const maintenance={async check(){maintenanceCalls++;return opts.proof?opts.proof(maintenanceCalls):{entrypointsPaused:true,executionsDrained:true,manualOldVersionRunsBlocked:true,observedVersion:'50'};}};
  const session=createBootstrap({approval,fetchImpl,listener,store,maintenance,operatorAccountSha256:hash('synthetic-operator@example.invalid'),browser:{async open(uri){opened.push(uri);if(opts.browserThrow)throw Error(CANARY.error);}},clock,
    randomBytes:size=>{assert.equal(size,32);if(opts.randomThrow)throw Error(CANARY.error);const b=opts.randomSame?Buffer.alloc(32):crypto.createHash('sha256').update('synthetic-'+id+'-'+(++n)).digest();privateRandom.push(b.toString('base64url'));return b;}});
  const request=(rawUrl,cookie)=>({method:'GET',host:'127.0.0.1:45123',hostCount:1,rawUrl,cookie});
  const safe=(value)=>{const serialized=JSON.stringify(value);for(const secret of [...Object.values(CANARY),...privateRandom])assert.ok(!serialized.includes(secret),'ZERO_CREDENTIAL_LEAKAGE');
    assert.ok(!serialized.includes('?response_type=')&&!serialized.includes('code_verifier='),'NO_AUTHORIZATION_URL');};
  return {session,approval,clock,calls,writes,opened,binds,privateRandom,closed:()=>closed,registration,token,request,safe};
}
async function browserRound(h){const result=await h.session.start();h.safe(result);assert.equal(result.code,'BOOTSTRAP_AWAITING_OWNER');
  const first=await h.session.handleHttp(h.request(BOOTSTRAP.startPath));assert.equal(first.statusCode,303);
  const authorization=new URL(first.headers.Location),cookie=first.headers['Set-Cookie'].split(';')[0];
  const params=new URLSearchParams({code:CANARY.code,state:authorization.searchParams.get('state'),iss:BOOTSTRAP.issuer});
  return {authorization,cookie,params,callback:()=>h.request(BOOTSTRAP.callbackPath+'?'+params,cookie)};
}
const spin=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};

test('default CLI is offline and unknown flags cannot activate live adapters',async()=>{
  for(const args of [[],['--plan']]){const r=await bootstrapCli(args);assert.equal(r.liveApproved,false);assert.equal(r.status,'OFFLINE_PREPARATION_ONLY');assert.equal(r.redirectUri,null);}
  for(const args of [['--live'],['--execute'],['--plan','--secret=other'],['--log-http']])assert.equal((await bootstrapCli(args)).code,'BOOTSTRAP_REQUEST_INVALID');
  assert.throws(()=>createBootstrap({}),e=>e.message==='BOOTSTRAP_APPROVAL_REQUIRED');
});
test('preflight derives its URI from an actual fake bind and closes without OAuth',async()=>{
  let closed=0;const r=await preflightLoopback({listener:{async bind(args){assert.deepEqual(args,{host:'127.0.0.1',port:0});return {host:'127.0.0.1',port:49152,close:async()=>closed++};}}});
  assert.equal(r.redirectUri,'http://127.0.0.1:49152/oauth/ib/callback');assert.equal(closed,1);assert.equal(r.registrationStarted,false);
});
test('only exact loopback callback URIs and one public read-only registration profile are accepted',()=>{
  for(const uri of ['http://localhost:45123/oauth/ib/callback','http://0.0.0.0:45123/oauth/ib/callback','https://127.0.0.1:45123/oauth/ib/callback',
    URI+'?code=x',URI+'#x',URI+'/',URI.replace('45123','0'),URI.replace('/callback','/%63allback')])assert.throws(()=>validateLoopbackUri(uri));
  const profile=registrationProfile(URI);assert.equal(profile.token_endpoint_auth_method,'none');assert.equal(profile.scope,'mcp.read');
  assert.ok(!Object.hasOwn(profile,'resource'));assert.ok(!Object.hasOwn(profile,'client_secret'));
});
test('accepted profile binds state, S256 and browser cookie then writes only a whitelisted initial credential',async()=>{
  const h=harness(),b=await browserRound(h);
  assert.equal(h.binds[0].port,45123);assert.equal(h.opened[0],'http://127.0.0.1:45123/oauth/ib/start');
  assert.ok(b.authorization.searchParams.get('state')===h.privateRandom[0],'STATE_BOUND');
  assert.ok(b.authorization.searchParams.get('code_challenge')===crypto.createHash('sha256').update(h.privateRandom[1]).digest('base64url'),'PKCE_S256');
  assert.equal(b.authorization.searchParams.get('scope'),'mcp.read');assert.equal(b.authorization.searchParams.get('resource'),BOOTSTRAP.resource);
  const result=await h.session.handleHttp(b.callback());h.safe(result);h.safe(h.session.snapshot());
  assert.equal(result.safe.code,'BOOTSTRAP_SECRET_VERSION_CONFIRMED');assert.equal(result.safe.savedVersion.name,BOOTSTRAP.secret+'/versions/51');
  assert.equal(result.safe.registration.managementCredentialPersisted,false);assert.equal(result.safe.nativeAccountProof,false);
  assert.equal(h.calls.length,2);assert.equal(h.writes.length,1);assert.equal(h.closed(),1);
  assert.ok(Object.keys(h.writes[0].credential).sort().join('|')==='access_token|client_id|expires_at|refresh_token|resource|scope|token_type');
  const exchange=h.calls[1].request.body;assert.ok(exchange.get('code')===CANARY.code,'CODE_ONLY_IN_PRIVATE_WIRE');
  assert.ok(exchange.get('code_verifier')===h.privateRandom[1],'VERIFIER_ONLY_IN_PRIVATE_WIRE');assert.equal(exchange.get('redirect_uri'),URI);
  assert.equal(result.safe.scopeEvidence,'token-response');
});
for(const [label,mutate] of [
  ['wrong-state',p=>p.set('state','wrong')],['wrong-issuer',p=>p.set('iss','https://wrong.invalid')],['missing-issuer',p=>p.delete('iss')],
  ['duplicate-state',p=>p.append('state',p.get('state'))],['duplicate-code',p=>p.append('code',CANARY.code)],
  ['duplicate-issuer',p=>p.append('iss',BOOTSTRAP.issuer)],['code-and-error',p=>p.set('error','denied')],['empty-code',p=>p.set('code','')],
  ['unknown-parameter',p=>p.set('account-ids',CANARY.error)],
])test('callback rejects '+label+' without a code exchange or leakage',async()=>{
  const h=harness(),b=await browserRound(h);mutate(b.params);const result=await h.session.handleHttp(b.callback());h.safe(result);
  assert.equal(result.safe.code,'BOOTSTRAP_CALLBACK_INVALID');assert.equal(h.calls.length,1);assert.equal(h.writes.length,0);assert.equal(h.closed(),1);
});
for(const [label,change] of [
  ['wrong-host',r=>r.host='evil.invalid'],['duplicate-host',r=>r.hostCount=2],['wrong-path',r=>r.rawUrl=r.rawUrl.replace('/callback','/other')],
  ['wrong-method',r=>r.method='POST'],['missing-cookie',r=>r.cookie=''],['duplicate-cookie',r=>r.cookie+='; '+r.cookie],
  ['absolute-request-url',r=>r.rawUrl='http://127.0.0.1:45123'+r.rawUrl],
])test('HTTP callback rejects '+label,async()=>{
  const h=harness(),b=await browserRound(h),req=b.callback();change(req);const result=await h.session.handleHttp(req);h.safe(result);
  assert.equal(result.safe.code,'BOOTSTRAP_CALLBACK_INVALID');assert.equal(h.calls.length,1);assert.equal(h.writes.length,0);
});
test('owner error, session expiry, cancellation and different browser cookies cannot exchange',async()=>{
  const h=harness(),b=await browserRound(h);b.params.delete('code');b.params.set('error','access_denied');b.params.set('error_description',CANARY.error);
  const result=await h.session.handleHttp(b.callback());h.safe(result);assert.equal(result.safe.code,'BOOTSTRAP_OWNER_AUTHORIZATION_REJECTED');assert.equal(h.calls.length,1);
  const expired=harness();await browserRound(expired);await expired.clock.advance(600001);const end=await expired.session.finished;expired.safe(end);assert.equal(end.code,'BOOTSTRAP_SESSION_EXPIRED');assert.equal(expired.closed(),1);
  const cancelled=harness();await browserRound(cancelled);const c=await cancelled.session.cancel();cancelled.safe(c);assert.equal(c.code,'BOOTSTRAP_CANCELLED');
  const one=harness(),two=harness(),first=await browserRound(one),second=await browserRound(two),req=first.callback();req.cookie=second.cookie;
  const mismatch=await one.session.handleHttp(req);one.safe(mismatch);assert.equal(mismatch.safe.code,'BOOTSTRAP_CALLBACK_INVALID');assert.equal(one.calls.length,1);await two.session.cancel();
});
test('simultaneous callbacks, replay and second start never repeat registration/exchange/write',async()=>{
  const h=harness(),b=await browserRound(h),[first,second]=await Promise.all([h.session.handleHttp(b.callback()),h.session.handleHttp(b.callback())]);
  h.safe(first);h.safe(second);assert.equal(first.safe.code,'BOOTSTRAP_SECRET_VERSION_CONFIRMED');assert.equal(second.safe.code,'BOOTSTRAP_REPLAY_REJECTED');
  assert.equal((await h.session.start()).code,'BOOTSTRAP_REPLAY_REJECTED');assert.equal((await h.session.handleHttp(b.callback())).safe.code,'BOOTSTRAP_REPLAY_REJECTED');
  assert.equal(h.calls.length,2);assert.equal(h.writes.length,1);
});
for(const [label,change] of [
  ['expanded-scope',r=>r.scope='mcp.read mcp.write'],['secret-authentication',r=>r.token_endpoint_auth_method='client_secret_basic'],
  ['client-secret-returned',r=>r.client_secret=CANARY.access],['changed-redirect',r=>r.redirect_uris=[URI+'/changed']],
  ['extra-redirect',r=>r.redirect_uris.push('http://127.0.0.1:45124/oauth/ib/callback')],['extra-grant',r=>r.grant_types.push('client_credentials')],
  ['missing-grant-echo',r=>delete r.grant_types],['missing-auth-echo',r=>delete r.token_endpoint_auth_method],
  ['wrong-response-type',r=>r.response_types=['token']],['empty-client-id',r=>r.client_id=''],
])test('DCR accepted metadata must match '+label,async()=>{
  const h=harness({registerResponse:r=>{change(r);return Response.json(r);}}),r=await h.session.start();h.safe(r);
  assert.equal(r.code,'BOOTSTRAP_PROFILE_REVIEW_REQUIRED');assert.equal(h.calls.length,1);assert.equal(h.opened.length,0);assert.equal(h.writes.length,0);
  assert.equal(r.sideEffects.registration,'confirmed');
});
test('DCR duplicate keys, invalid UTF-8, oversized or redirected bodies have unknown outcomes and no retry',async()=>{
  for(const registerResponse of [r=>new Response(JSON.stringify(r).slice(0,-1)+',"client_\\u0069d":"other"}'),
    ()=>new Response(new Uint8Array([255])),()=>new Response('x'.repeat(65537)),()=>{const r=Response.json({});Object.defineProperty(r,'redirected',{value:true});return r;},
    ()=>{throw Error(CANARY.error);}]){
    const h=harness({registerResponse}),r=await h.session.start();h.safe(r);assert.equal(r.code,'BOOTSTRAP_DCR_OUTCOME_UNKNOWN');
    assert.equal(h.calls.length,1);await h.session.start();assert.equal(h.calls.length,1);
  }
});
test('DCR 4xx is rejected; 5xx and timeout remain unknown without retry',async()=>{
  for(const status of [400,401,403,500]){const h=harness({registerResponse:()=>Response.json({error:CANARY.error},{status})}),r=await h.session.start();h.safe(r);
    assert.equal(r.code,status<500?'BOOTSTRAP_DCR_REJECTED':'BOOTSTRAP_DCR_OUTCOME_UNKNOWN');assert.equal(h.calls.length,1);}
  const h=harness({registerResponse:()=>new Promise(()=>{})}),pending=h.session.start();await spin();await h.clock.advance(15001);const r=await pending;h.safe(r);
  assert.equal(r.code,'BOOTSTRAP_DCR_OUTCOME_UNKNOWN');assert.equal(h.closed(),1);assert.equal(h.calls.length,1);
});
for(const [label,change] of [
  ['missing-refresh',r=>delete r.refresh_token],['empty-access',r=>r.access_token=''],['expired',r=>r.expires_in=0],
  ['non-bearer',r=>r.token_type='mac'],['scope-expansion',r=>r.scope='mcp.read openid'],['wrong-client',r=>r.client_id='other'],
  ['wrong-resource',r=>r.resource='https://wrong.invalid'],['identity-token',r=>r.id_token=CANARY.error],
])test('token response rejects '+label+' without an old credential fallback',async()=>{
  const h=harness({tokenResponse:r=>{change(r);return Response.json(r);}}),b=await browserRound(h),result=await h.session.handleHttp(b.callback());h.safe(result);
  assert.equal(result.safe.code,'BOOTSTRAP_TOKEN_INVALID');assert.equal(h.writes.length,0);assert.equal(h.calls.length,2);
});
test('omitted token scope inherits only the explicit mcp.read request with evidence',async()=>{
  const h=harness({tokenResponse:r=>{delete r.scope;return Response.json(r);}}),b=await browserRound(h),r=await h.session.handleHttp(b.callback());h.safe(r);
  assert.equal(r.safe.scopeEvidence,'explicit-request-inherited');assert.equal(h.writes[0].credential.scope,'mcp.read');assert.equal(r.safe.nativeAccountProof,false);
});
test('exchange duplicate keys, 4xx, network error and timeout never exchange twice',async()=>{
  for(const tokenResponse of [r=>new Response(JSON.stringify(r).slice(0,-1)+',"access_\\u0074oken":"other"}'),
    ()=>Response.json({error:CANARY.error},{status:400}),()=>{throw Error(CANARY.error);}]){
    const h=harness({tokenResponse}),b=await browserRound(h),r=await h.session.handleHttp(b.callback());h.safe(r);assert.equal(h.writes.length,0);
    assert.equal(h.calls.length,2);await h.session.handleHttp(b.callback());assert.equal(h.calls.length,2);
  }
  const h=harness({tokenResponse:()=>new Promise(()=>{})}),b=await browserRound(h),pending=h.session.handleHttp(b.callback());await spin();await h.clock.advance(15001);
  const r=await pending;h.safe(r);assert.equal(r.safe.code,'BOOTSTRAP_EXCHANGE_OUTCOME_UNKNOWN');assert.equal(h.writes.length,0);
});
test('bound port drift, identity approval and maintenance drift stop rather than switch or write',async()=>{
  for(const opts of [{port:45124},{host:'0.0.0.0'},{bindThrow:true}]){const h=harness(opts),r=await h.session.start();h.safe(r);assert.equal(h.calls.length,0);assert.equal(h.binds.length,1);}
  assert.throws(()=>harness({approval:{acceptMacReplacement:false}}));
  const h=harness({proof:n=>({entrypointsPaused:true,executionsDrained:n===1,manualOldVersionRunsBlocked:true,observedVersion:'50'})}),b=await browserRound(h),r=await h.session.handleHttp(b.callback());h.safe(r);
  assert.equal(r.safe.code,'BOOTSTRAP_MAINTENANCE_UNCONFIRMED');assert.equal(h.writes.length,0);
});
test('Secret errors, unknown writes, wrong project/state/version and timeout never retry or roll back',async()=>{
  for(const save of [()=>{throw Error(CANARY.error);},()=>({name:'projects/other/secrets/xuan-preopen-ib-mcp/versions/51',state:'ENABLED'}),
    ()=>({name:BOOTSTRAP.secret+'/versions/51',state:'DISABLED'}),()=>({name:BOOTSTRAP.secret+'/versions/50',state:'ENABLED'}),()=>({name:BOOTSTRAP.secret+'/versions/latest',state:'ENABLED'})]){
    const h=harness({save}),b=await browserRound(h),r=await h.session.handleHttp(b.callback());h.safe(r);assert.equal(r.safe.sideEffects.secretWrite,'unknown');
    assert.equal(h.writes.length,1);await h.session.handleHttp(b.callback());assert.equal(h.writes.length,1);
  }
  const h=harness({save:()=>new Promise(()=>{})}),b=await browserRound(h),pending=h.session.handleHttp(b.callback());await spin();await h.clock.advance(20001);
  const r=await pending;h.safe(r);assert.equal(r.safe.code,'BOOTSTRAP_SECRET_WRITE_OUTCOME_UNKNOWN');assert.equal(h.writes.length,1);
});
test('SDK writer fake process sends credentials only via stdin, fixes args/env and returns name/state only',async()=>{
  const operatorAccount='synthetic-operator@example.invalid',operatorAccountSha256=hash(operatorAccount),c={client_id:'SYNTHETIC_NEW_CLIENT',access_token:CANARY.access,refresh_token:CANARY.refresh,
    token_type:'Bearer',scope:'mcp.read',resource:BOOTSTRAP.resource,expires_at:NOW+3600000};let calls=0;
  const writer=createSdkWriter({operatorAccount,operatorAccountSha256,runProcess:async req=>{calls++;assert.equal(req.executable,BOOTSTRAP.python);
    assert.ok(!JSON.stringify(req.args).includes(CANARY.access),'NO_ARG_CREDENTIALS');assert.ok(req.stdin.toString().includes(CANARY.refresh),'STDIN_ONLY');
    assert.equal(req.args[0],'-I');assert.equal(req.args[1],'-c');assert.equal(req.args[2],SDK_BRIDGE_CODE);assert.equal(req.operatorAccount,operatorAccount);assert.equal(req.discardStderr,true);
    assert.equal(req.env.CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT,'');assert.equal(req.env.CLOUDSDK_CORE_LOG_HTTP,'false');
    return {exitCode:0,stdout:JSON.stringify({name:BOOTSTRAP.secret+'/versions/51',state:'ENABLED',ignored:CANARY.error}),stderr:CANARY.google};}});
  const ack=await writer.save(c,{operatorAccount,precedingVersion:'50',signal:new AbortController().signal});
  assert.equal(Object.keys(ack).sort().join('|'),'name|state');assert.ok(!JSON.stringify(ack).includes('CANARY'));
  await assert.rejects(writer.save(c,{operatorAccount,precedingVersion:'50'}));assert.equal(calls,1);
  // The real bridge rejects the synthetic identity before importing/spawning SDK.
  await assert.rejects(createSdkProcessBridge()({operatorAccount}),e=>e.message==='BOOTSTRAP_APPROVAL_REQUIRED');
});
test('SDK fake subprocess nonzero/raw errors and malformed acknowledgements have no stderr leakage',async()=>{
  const account='synthetic-operator@example.invalid',credential={client_id:'synthetic',access_token:CANARY.access,refresh_token:CANARY.refresh,token_type:'Bearer',scope:'mcp.read',resource:BOOTSTRAP.resource,expires_at:NOW+3600000};
  for(const runProcess of [async()=>{throw Error(CANARY.error);},async()=>({exitCode:1,stdout:CANARY.error,stderr:CANARY.google}),
    async()=>({exitCode:0,stdout:'{"name":"'+CANARY.error+'","name":"duplicate"}',stderr:CANARY.google})]){
    const writer=createSdkWriter({operatorAccount:account,operatorAccountSha256:hash(account),runProcess});
    await assert.rejects(writer.save(credential,{operatorAccount:account,precedingVersion:'50'}),e=>!JSON.stringify({message:e.message,stack:e.stack}).includes('CANARY'));
  }
});
test('a callback admitted just before ten minutes completes its save in the independent finish window',async()=>{
  let complete;const h=harness({save:()=>new Promise(resolve=>{complete=resolve;})}),b=await browserRound(h);
  await h.clock.advance(599990);const pending=h.session.handleHttp(b.callback());await spin();
  assert.equal(h.writes.length,1);await h.clock.advance(11);h.safe(h.session.snapshot());
  assert.equal(h.writes[0].options.signal.aborted,false);assert.equal(h.closed(),0);
  complete({name:BOOTSTRAP.secret+'/versions/51',state:'ENABLED'});const done=await pending;h.safe(done);
  assert.equal(done.safe.code,'BOOTSTRAP_SECRET_VERSION_CONFIRMED');assert.equal(h.writes.length,1);assert.equal(h.closed(),1);
});
test('a timely admitted exchange continues after the callback admission deadline without a second exchange',async()=>{
  let complete;const h=harness({tokenResponse:r=>new Promise(resolve=>{complete=()=>resolve(Response.json(r));})}),b=await browserRound(h);
  await h.clock.advance(599990);const pending=h.session.handleHttp(b.callback());await spin();await h.clock.advance(11);
  assert.equal(h.calls[1].request.signal.aborted,false);assert.equal(h.writes.length,0);assert.equal(h.closed(),0);
  complete();const done=await pending;h.safe(done);assert.equal(done.safe.code,'BOOTSTRAP_SECRET_VERSION_CONFIRMED');
  assert.equal(h.calls.length,2);assert.equal(h.writes.length,1);
});
test('the independent finish window is bounded and late write acknowledgement cannot upgrade unknown to success',async()=>{
  let complete;const h=harness({save:()=>new Promise(resolve=>{complete=resolve;})}),b=await browserRound(h);
  await h.clock.advance(599990);const pending=h.session.handleHttp(b.callback());await spin();assert.equal(h.writes.length,1);
  await h.clock.advance(BOOTSTRAP.finalizeMs+1);const end=await h.session.finished;h.safe(end);
  assert.equal(end.code,'BOOTSTRAP_FINALIZATION_EXPIRED');assert.equal(end.sideEffects.secretWrite,'unknown');
  assert.equal(h.writes[0].options.signal.aborted,true);assert.equal(h.closed(),1);
  complete({name:BOOTSTRAP.secret+'/versions/51',state:'ENABLED'});const late=await pending;h.safe(late);
  assert.equal(late.safe.code,'BOOTSTRAP_FINALIZATION_EXPIRED');assert.equal(late.safe.savedVersion,null);assert.equal(h.writes.length,1);
});
test('maintenance proof has its own five-second bound and expiry cannot admit a write',async()=>{
  const h=harness({proof:n=>n===1?{entrypointsPaused:true,executionsDrained:true,manualOldVersionRunsBlocked:true,observedVersion:'50'}:new Promise(()=>{})}),b=await browserRound(h);
  const pending=h.session.handleHttp(b.callback());await spin();await h.clock.advance(BOOTSTRAP.maintenanceMs+1);
  const end=await pending;h.safe(end);assert.equal(end.safe.code,'BOOTSTRAP_MAINTENANCE_UNCONFIRMED');
  assert.equal(h.writes.length,0);assert.equal(h.calls.length,2);assert.equal(h.closed(),1);
});
test('randomness/browser failures and a pre-registration maintenance failure have only safe outputs',async()=>{
  for(const opts of [{randomThrow:true},{randomSame:true},{browserThrow:true},{proof:()=>({entrypointsPaused:true,executionsDrained:false,manualOldVersionRunsBlocked:true,observedVersion:'50'})},
    {proof:()=>{throw Error(CANARY.error);}}]){
    const h=harness(opts),r=await h.session.start();h.safe(r);assert.equal(r.status,'failed');assert.equal(h.writes.length,0);
    assert.ok(h.calls.length<=1);assert.equal(h.closed()<=1,true);
  }
  await assert.rejects(preflightLoopback({listener:{async bind(){return {host:'127.0.0.1',port:45123,close:async()=>{throw Error(CANARY.error);}};}}}),e=>e.message==='BOOTSTRAP_LISTENER_BINDING_INVALID');
});
test('SDK cancellation reasons cannot leak and cannot submit stdin',async()=>{
  const account='synthetic-operator@example.invalid',controller=new AbortController();controller.abort(new Error(CANARY.error));let calls=0;
  const writer=createSdkWriter({operatorAccount:account,operatorAccountSha256:hash(account),runProcess:async()=>{calls++;}});
  const credential={client_id:'synthetic',access_token:CANARY.access,refresh_token:CANARY.refresh,token_type:'Bearer',scope:'mcp.read',resource:BOOTSTRAP.resource,expires_at:NOW+3600000};
  await assert.rejects(writer.save(credential,{operatorAccount:account,precedingVersion:'50',signal:controller.signal}),e=>e.message==='BOOTSTRAP_CANCELLED');
  assert.equal(calls,0);
});
test('the default session pins the original operator before listener or DCR capabilities are admitted',()=>{
  const a={spec:BOOTSTRAP_SPEC,codeSha256:'a'.repeat(64),redirectUri:URI,operatorAccount:'synthetic-operator@example.invalid',precedingVersion:'50',approved:true,acceptMacReplacement:true};
  assert.throws(()=>createBootstrap({approval:a}),e=>e.message==='BOOTSTRAP_APPROVAL_REQUIRED');
});

for(const mode of ['cancel','ttl'])test('late fake bind after '+mode+' closes exactly once without registration',async()=>{
  let release;const deferredBind=new Promise(resolve=>{release=resolve;}),h=harness({deferredBind});
  const pending=h.session.start();await spin();assert.equal(h.binds.length,1);assert.equal(h.closed(),0);
  let terminal;
  if(mode==='cancel')terminal=h.session.cancel();else{await h.clock.advance(600001);terminal=h.session.finished;}
  h.safe(h.session.snapshot());assert.equal(h.session.snapshot().listenerClosed,false);assert.equal(h.calls.length,0);
  release();const [end,start]=await Promise.all([terminal,pending]);h.safe(end);h.safe(start);
  assert.equal(end.listenerClosed,true);assert.equal(h.closed(),1);assert.equal(h.calls.length,0);assert.equal(h.opened.length,0);
  await h.session.cancel();assert.equal(h.closed(),1);assert.equal(h.writes.length,0);
});
test('failed listener cleanup is reported as unconfirmed and never claims closed',async()=>{
  const h=harness({closeThrow:true});await browserRound(h);const result=await h.session.cancel();h.safe(result);
  assert.equal(result.listenerClosed,false);assert.equal(h.closed(),1);await h.session.cancel();assert.equal(h.closed(),1);
});
test('cancellation before start admits no future bind or registration',async()=>{
  const h=harness();const result=await h.session.cancel();h.safe(result);assert.equal(result.listenerClosed,true);
  h.safe(await h.session.start());assert.equal(h.binds.length,0);assert.equal(h.calls.length,0);
});

// This subprocess is a standard Python synthetic harness, not the SDK bridge's
// production entry. __name__ prevents live imports/credential/HTTP execution.
const PYTHON_TRANSPORT_FIXTURE=String.raw`
import sys, json, hashlib
try:
    fixture = json.loads(sys.stdin.read())
    module = {"__name__": "synthetic_test"}
    exec(compile(fixture["code"], "synthetic_bridge", "exec"), module)
    assert "requests" not in sys.modules and "googlecloudsdk" not in sys.modules
    submit, Failure, URL = module["submit"], module["BridgeFailure"], module["URL"]
    secret, resource = module["SECRET"], "https://api.ibkr.com/v1/api/mcp-public"
    account = "synthetic-operator@example.invalid"
    op_hash = hashlib.sha256(account.encode()).hexdigest()
    canary = "SYNTHETIC_PRIVATE_TRANSPORT_CANARY"
    credential = {"client_id": "SYNTHETIC_NEW_CLIENT", "access_token": canary, "refresh_token": canary,
                  "token_type": "Bearer", "scope": "mcp.read", "resource": resource, "expires_at": 1792119600000}
    modes = ["success", "accepted-disconnect", "500", "401", "redirect", "body-timeout", "oversized", "utf8",
             "duplicate-key", "bad-name", "disabled", "wrong-url", "identity-error", "wrong-identity", "auth-error", "bad-credential"]
    for mode in modes:
        calls, state = [], {"identity": 0, "session_closed": 0, "response_closed": 0}
        class Creds:
            def before_request(self, request, method, url, headers):
                assert method == "POST" and url == URL and request == "synthetic-request"
                if mode == "auth-error":
                    raise RuntimeError(canary)
                headers["authorization"] = "Bearer " + canary
        def identity():
            state["identity"] += 1
            if mode == "identity-error":
                raise RuntimeError(canary)
            return ("wrong@example.invalid" if mode == "wrong-identity" else account, Creds())
        class Response:
            status_code = int(mode) if mode in ("500", "401") else 307 if mode == "redirect" else 200
            url = URL if mode != "wrong-url" else "https://other.invalid/" + canary
            def iter_content(self, chunk_size):
                assert chunk_size == 4096
                if mode == "body-timeout":
                    raise TimeoutError(canary)
                if mode == "oversized":
                    yield (canary * 1000).encode()
                elif mode == "utf8":
                    yield b"\xff"
                elif mode == "duplicate-key":
                    yield ('{"name":"' + canary + '","n\\u0061me":"duplicate"}').encode()
                else:
                    name = "projects/other/secrets/x/versions/51" if mode == "bad-name" else secret + "/versions/51"
                    yield json.dumps({"name": name, "state": "DISABLED" if mode == "disabled" else "ENABLED", "ignored": canary}).encode()
            def close(self):
                state["response_closed"] += 1
        class Session:
            trust_env = True
            def mount(self, prefix, adapter):
                assert prefix == "https://" and adapter == {"max_retries": 0}
            def post(self, url, **kwargs):
                calls.append(url)
                assert url == URL and not self.trust_env
                assert kwargs["allow_redirects"] is False and kwargs["stream"] is True and kwargs["timeout"] == (5, 12)
                assert kwargs["headers"]["authorization"] == "Bearer " + canary
                assert set(kwargs["json"]) == {"payload"}
                if mode == "accepted-disconnect":
                    # The server may already have committed. A second POST is forbidden.
                    raise ConnectionError(canary)
                return Response()
            def close(self):
                state["session_closed"] += 1
        try:
            item = dict(credential)
            if mode == "bad-credential":
                item["scope"] = "mcp.read write"
            ack = submit(item, identity, Session, lambda **kw: kw, lambda **kw: "synthetic-request", operator_hash=op_hash)
            assert mode == "success"
            assert ack == {"name": secret + "/versions/51", "state": "ENABLED"}
            assert canary not in json.dumps(ack)
        except Failure as error:
            assert mode != "success" and str(error) == "BOOTSTRAP_SECRET_WRITE_OUTCOME_UNKNOWN" and canary not in str(error)
        assert len(calls) == (0 if mode in ("identity-error", "wrong-identity", "auth-error", "bad-credential") else 1)
        assert state["session_closed"] == (0 if mode in ("identity-error", "wrong-identity", "bad-credential") else 1)
    print(json.dumps({"syntheticTransportScenarios": len(modes), "secretPostRetries": 0, "liveImports": 0}))
except BaseException:
    print("SYNTHETIC_BRIDGE_TEST_FAILED")
    sys.exit(1)
`;
test('SDK-credential bridge core uses one HTTPS submission even on accepted-but-disconnected, 5xx and 401 outcomes',async()=>{
  const {spawn}=await import('node:child_process');
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(BOOTSTRAP.python,['-I','-c',PYTHON_TRANSPORT_FIXTURE],{shell:false,stdio:['pipe','pipe','pipe']}),chunks=[],errors=[];
    child.stdout.on('data',b=>chunks.push(b));child.stderr.on('data',b=>errors.push(b));child.on('error',()=>reject(Error('SYNTHETIC_PYTHON_UNAVAILABLE')));
    child.on('close',code=>resolve({code,stdout:Buffer.concat(chunks).toString(),stderr:Buffer.concat(errors).toString()}));
    child.stdin.end(JSON.stringify({code:SDK_BRIDGE_CODE}));
  });
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'),'ZERO_BRIDGE_CANARY_OUTPUT');
  assert.equal(result.code,0,'SYNTHETIC_TRANSPORT_HARNESS_PASSED');assert.equal(result.stderr,'');
  assert.deepEqual(JSON.parse(result.stdout),{syntheticTransportScenarios:16,secretPostRetries:0,liveImports:0});
});
