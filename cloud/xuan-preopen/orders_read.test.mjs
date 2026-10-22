import {isIbCredentialLockRequest,IB_CREDENTIAL_LOCK_KEY,privateCloudIo} from './cloud_io.mjs';
// Synthetic transport only: no real SDK, credentials, broker or cloud requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {runCloudOrdersRead,ordersReadCli} from './orders_read.mjs';
import {runCloudOrdersProbe} from './orders_probe.mjs';
import {RESOURCE,TOKEN_ENDPOINT} from './ib_mcp.mjs';
import {associationPolicyBlob} from '../../scripts/xuan-ib-account-association.mjs';

const NOW=Date.parse('2026-10-21T04:00:00.000Z');
const SECRET='projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp';
// Synthetic fixed-object CAS transport; never falls back to actual fetch.
function lockTransport(baseFetch){
  let record=null,generation=0;
  return async(url,options={})=>{
    if(!isIbCredentialLockRequest(url,options))return baseFetch(url,options);
    const u=new URL(url),meta=()=>({name:IB_CREDENTIAL_LOCK_KEY,generation:String(generation),size:String(Buffer.byteLength(JSON.stringify(record)))});
    if((options.method??'GET')==='GET'){
      if(record===null)return Response.json({}, {status:404});
      if(u.searchParams.get('alt')==='media')return u.searchParams.get('generation')===String(generation)?Response.json(record):Response.json({}, {status:412});
      return Response.json(meta());
    }
    if(u.searchParams.get('ifGenerationMatch')!==String(generation))return Response.json({}, {status:412});
    record=JSON.parse(options.body.toString());generation++;return Response.json(meta());
  };
}


function harness({expired=false,omitRefresh=false,saveStatus=200,refreshDelay=0}={}) {
  const calls=[],objects=new Map(),events=[];
  const credential={client_id:'SYNTHETIC_CLIENT',access_token:'SYNTHETIC_ACCESS_CANARY',refresh_token:'SYNTHETIC_REFRESH_CANARY',token_type:'Bearer',scope:'mcp.read',resource:RESOURCE,expires_at:NOW+(expired?0:3600000)};
  const request={requestId:'11111111-2222-4333-8444-555555555555',dataDate:'2026-10-21',expiresAt:'2026-10-21T04:10:00.000Z',credentialBinding:{clientId:credential.client_id,version:'15'}};
  const raw={orders:[]};
  const options={request,env:{CLOUD_RUN_JOB:'xuan-preopen-orders-probe',CLOUD_RUN_EXECUTION:'xuan-preopen-orders-probe-synthetic',CLOUD_RUN_TASK_INDEX:'0',CLOUD_RUN_TASK_ATTEMPT:'0',CLOUD_RUN_TASK_COUNT:'1'},now:()=>NOW,expectedAccount:'SYNTHETIC_ACCOUNT',loadContext:async()=>{
    const policy={schemaVersion:1,policyId:'ib-primary-7day-pilot-v1',accountAlias:'IB-HK',basis:'owner-attested-recurring-v1',status:'active',purpose:'xuan-ib-read-only-report',editions:['adhoc','am','pm'],publisher:'codex-verified-candidate-v1',validFrom:'2026-10-20T00:00:00.000Z',expiresAt:'2026-10-25T00:00:00.000Z'};
    return {association:{policy,policyCommit:'a'.repeat(40),policyBlob:associationPolicyBlob(policy),checkedAt:new Date(NOW).toISOString()}};
  }};
  options.fetchImpl=async(url,o)=>{
    const u=String(url);calls.push(u);o.signal?.throwIfAborted();
    if(u.startsWith('http://metadata.google.internal/'))return Response.json({access_token:'SYNTHETIC_GOOGLE_CANARY'});
    if(u===`https://secretmanager.googleapis.com/v1/${SECRET}/versions/15:access`){events.push('load-bound');return Response.json({name:SECRET+'/versions/15',payload:{data:Buffer.from(JSON.stringify(credential)).toString('base64')}});}
    if(u===TOKEN_ENDPOINT){
      events.push('refresh');assert.equal(o.body.get('grant_type'),'refresh_token');assert.equal(o.body.get('scope'),'mcp.read');
      if(refreshDelay)await new Promise(resolve=>setTimeout(resolve,refreshDelay));
      return Response.json({access_token:'SYNTHETIC_NEXT_ACCESS_CANARY',...(!omitRefresh?{refresh_token:'SYNTHETIC_NEXT_REFRESH_CANARY'}:{}),token_type:'Bearer',scope:'mcp.read',expires_in:3600});
    }
    if(u===`https://secretmanager.googleapis.com/v1/${SECRET}:addVersion`){
      events.push('save');const value=JSON.parse(Buffer.from(JSON.parse(o.body).payload.data,'base64').toString());
      assert.ok(value.client_id===credential.client_id);assert.ok(value.scope==='mcp.read');
      if(omitRefresh)assert.ok(value.refresh_token===credential.refresh_token);
      return Response.json(saveStatus===200?{name:SECRET+'/versions/16',state:'ENABLED'}:{error:'SYNTHETIC_PRIVATE_CANARY'},{status:saveStatus});
    }
    if(u.startsWith('https://storage.googleapis.com/upload/')){
      const p=new URL(u),name=p.searchParams.get('name');assert.equal(p.searchParams.get('ifGenerationMatch'),'0');
      if(objects.has(name))return Response.json({},{status:412});
      objects.set(name,JSON.parse(o.body));return Response.json({name,size:String(o.body.length),generation:'1'});
    }
    assert.equal(u,RESOURCE);const q=JSON.parse(o.body);
    if(q.method==='initialize')return Response.json({jsonrpc:'2.0',id:q.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}}}});
    if(q.method==='notifications/initialized')return new Response(null,{status:202});
    assert.equal(q.method,'tools/call');assert.deepEqual(q.params,{name:'get_account_orders',arguments:{}});events.push('orders');
    return Response.json({jsonrpc:'2.0',id:q.id,result:{content:[{type:'text',text:JSON.stringify(raw)}]}});
  };
  options.fetchImpl=lockTransport(options.fetchImpl);
  return {options,credential,raw,calls,objects,events};
}
function noCredentialLeak(h,result){
  const text=JSON.stringify({result,objects:[...h.objects]});
  for(const value of ['SYNTHETIC_ACCESS_CANARY','SYNTHETIC_REFRESH_CANARY','SYNTHETIC_NEXT_ACCESS_CANARY','SYNTHETIC_NEXT_REFRESH_CANARY','SYNTHETIC_GOOGLE_CANARY','SYNTHETIC_PRIVATE_CANARY'])assert.ok(!text.includes(value));
}

test('normal CLI uses bound actual cloud_io and one orders read in a separate receipt namespace',async()=>{
  const h=harness(),r=await ordersReadCli(['--orders-request',JSON.stringify(h.options.request)],h.options);
  assert.equal(r.status,'passed');assert.deepEqual(h.events,['load-bound','orders']);assert.equal(h.objects.size,3);
  assert.ok([...h.objects.keys()].every(x=>x.startsWith('report-check/orders-read-')));
  const receipt=[...h.objects.values()].at(-1);assert.equal(receipt.mode,'cloud-orders-read');assert.equal(receipt.ordersCalls,1);assert.equal(receipt.refreshCalls,0);
  assert.equal(r.consumedCredentialVersion,SECRET+'/versions/15');assert.equal(r.nativeIdentityEvidence,'not-provided');noCredentialLeak(h,r);
});
test('normal path requires client/version before any private or IB IO, without latest fallback',async()=>{
  for(const binding of [undefined,{clientId:'SYNTHETIC_CLIENT',version:'latest'},{clientId:'SYNTHETIC_CLIENT',version:'../15'}]){
    const h=harness();if(binding===undefined)delete h.options.request.credentialBinding;else h.options.request.credentialBinding=binding;
    const r=await runCloudOrdersRead(h.options);assert.equal(r.status,'failed');assert.equal(h.calls.length,0);noCredentialLeak(h,r);
  }
});
test('normal read performs one refresh then confirmed save before orders, including nonrotating response',async()=>{
  for(const omitRefresh of [false,true]){
    const h=harness({expired:true,omitRefresh}),r=await runCloudOrdersRead(h.options);
    assert.equal(r.status,'passed');assert.deepEqual(h.events,['load-bound','refresh','save','orders']);
    assert.equal(r.savedCredentialVersion,SECRET+'/versions/16');assert.equal(r.credentialPersistence,'saved');noCredentialLeak(h,r);
  }
});
test('unconfirmed save cannot issue orders or retry refresh/write',async()=>{
  const h=harness({expired:true,saveStatus:500}),r=await runCloudOrdersRead(h.options);
  assert.equal(r.status,'failed');assert.deepEqual(h.events,['load-bound','refresh','save']);assert.equal(r.credentialPersistence,'outcome-unknown');noCredentialLeak(h,r);
});
test('wrong credential client or response version causes zero IB requests',async()=>{
  for(const mismatch of ['client','version']){
    const h=harness();if(mismatch==='client')h.credential.client_id='SYNTHETIC_WRONG';
    else {const f=h.options.fetchImpl;h.options.fetchImpl=async(u,o)=>String(u).endsWith('/versions/15:access')?Response.json({name:SECRET+'/versions/16',payload:{data:Buffer.from(JSON.stringify(h.credential)).toString('base64')}}):f(u,o);}
    const r=await runCloudOrdersRead(h.options);assert.equal(r.status,'failed');assert.ok(!h.calls.includes(RESOURCE)&&!h.calls.includes(TOKEN_ENDPOINT));noCredentialLeak(h,r);
  }
});
test('normal and legacy requests cannot consume or reuse each other markers',async()=>{
  const h=harness(),a=await runCloudOrdersRead(h.options),before=h.calls.filter(x=>x===RESOURCE||x===TOKEN_ENDPOINT).length,b=await runCloudOrdersRead(h.options);
  assert.equal(a.status,'passed');assert.equal(b.status,'failed');assert.equal(h.calls.filter(x=>x===RESOURCE||x===TOKEN_ENDPOINT).length,before);assert.equal(h.events.filter(x=>x==='orders').length,1);
  const legacy=await runCloudOrdersProbe(h.options);assert.equal(legacy.status,'passed');
  assert.ok([...h.objects.keys()].some(x=>x.startsWith('report-check/orders-probe-')));noCredentialLeak(h,b);
});
test('source cutoff permits admitted refresh save but prevents subsequent IB handshake or orders',async()=>{
  const h=harness({expired:true,refreshDelay:60});h.options.limits={sourceMs:20,finalizeMs:200};
  const r=await runCloudOrdersRead(h.options);assert.equal(r.status,'failed');assert.equal(r.credentialPersistence,'saved');
  assert.deepEqual(h.events,['load-bound','refresh','save']);assert.ok(!h.calls.includes(RESOURCE));noCredentialLeak(h,r);
});
test('contradictory account evidence rejects source artifact while retaining a safe failure receipt',async()=>{
  const h=harness();h.raw.account_id='SYNTHETIC_WRONG_ACCOUNT';const r=await runCloudOrdersRead(h.options);
  assert.equal(r.status,'failed');assert.ok(![...h.objects.keys()].some(x=>x.endsWith('/orders.json')));noCredentialLeak(h,r);
});
test('normal CLI rejects duplicate JSON, mixed flags and legacy nonce without IO',async()=>{
  const h=harness();
  for(const args of [['--request',JSON.stringify(h.options.request)],['--orders-request','{"requestId":"x","requestId":"y"}'],['--probe',JSON.stringify(h.options.request)],['--orders-request',JSON.stringify(h.options.request),'--execute'],['--orders-request',JSON.stringify({...h.options.request,nonce:'SYNTHETIC_OLD_NONCE'})]]){
    const r=await ordersReadCli(args,h.options);assert.equal(r.status,'failed');assert.equal(h.calls.length,0);noCredentialLeak(h,r);
  }
});

test('orders read and probe bounded stores retain the shared credential lease',async()=>{
 for(const run of [runCloudOrdersRead,runCloudOrdersProbe]){
  const h=harness();h.options.io=privateCloudIo({fetchImpl:h.options.fetchImpl,now:()=>NOW});let entered=0,active=false;const original=h.options.io.ibStore.loadBound;const realLease=h.options.io.ibStore.withCredentialLease;
  h.options.io.ibStore.requiresCredentialLease=true;
  h.options.io.ibStore.withCredentialLease=async callback=>realLease(async lease=>{entered++;active=true;try{return await callback(lease);}finally{active=false;}});
  h.options.io.ibStore.loadBound=async binding=>{assert.equal(active,true);return original(binding);};
  const r=await run(h.options);assert.equal(r.status,'passed');assert.equal(entered,1);assert.equal(active,false);
 }
});
