// SYNTHETIC OFFLINE ONLY. No SDK credentials, cloud jobs or broker calls.
import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {runCloudOrdersProbe,ordersProbeCli,validateOrdersProbeRequest,loadProbeAssociation} from './orders_probe.mjs';
import {RESOURCE,TOKEN_ENDPOINT} from './ib_mcp.mjs';
import {associationPolicyBlob,associationPolicyText} from '../../scripts/xuan-ib-account-association.mjs';
const NOW=Date.parse('2026-10-15T13:15:00.000Z'),hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const request=()=>({requestId:'11111111-2222-4333-8444-555555555555',dataDate:'2026-10-15',expiresAt:'2026-10-15T13:25:00.000Z'});
const env=()=>({CLOUD_RUN_JOB:'xuan-preopen-orders-probe',CLOUD_RUN_EXECUTION:'xuan-preopen-orders-probe-synthetic',CLOUD_RUN_TASK_INDEX:'0',CLOUD_RUN_TASK_ATTEMPT:'0',CLOUD_RUN_TASK_COUNT:'1'});
function context(){const policy={schemaVersion:1,policyId:'ib-primary-7day-pilot-v1',accountAlias:'IB-HK',basis:'owner-attested-recurring-v1',status:'active',purpose:'xuan-ib-read-only-report',editions:['adhoc','am','pm'],publisher:'codex-verified-candidate-v1',validFrom:'2026-10-10T00:00:00.000Z',expiresAt:'2026-10-20T00:00:00.000Z'};
  return {association:{policy,policyCommit:'a'.repeat(40),policyBlob:associationPolicyBlob(policy),checkedAt:new Date(NOW).toISOString()},previousSourceSha:'b'.repeat(40)};}
function harness(){
  const objects=new Map(),calls=[],rotations=[];let loads=0;
  const credential={client_id:'SYNTHETIC_ORIGINAL_CLIENT',access_token:'SYNTHETIC_ACCESS',refresh_token:'SYNTHETIC_REFRESH',token_type:'Bearer',scope:'mcp.read',resource:RESOURCE,expires_at:NOW+3600000};
  const io={ibStore:{load:async()=>{loads++;return credential;},save:async c=>{rotations.push(c);}},savePrivate:async(name,value)=>{if(objects.has(name))throw Error('CLOUD_HTTP_412');objects.set(name,value);return {sha256:hash(value),generation:'1'};}};
  const fetchImpl=async(url,o)=>{calls.push({url:String(url),o});if(String(url)===TOKEN_ENDPOINT)return Response.json({access_token:'SYNTHETIC_ROTATED',refresh_token:'SYNTHETIC_ROTATED_REFRESH',token_type:'Bearer',scope:'mcp.read',expires_in:3600});
    assert.equal(String(url),RESOURCE);const q=JSON.parse(o.body);
    if(q.method==='initialize')return Response.json({jsonrpc:'2.0',id:q.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}}}});
    if(q.method==='notifications/initialized')return new Response(null,{status:202});
    assert.equal(q.method,'tools/call');assert.deepEqual(q.params,{name:'get_account_orders',arguments:{}});
    return Response.json({jsonrpc:'2.0',id:q.id,result:{content:[{type:'text',text:JSON.stringify({orders:[],account_id:undefined})}]}});
  };
  return {options:{request:request(),env:env(),now:()=>NOW,io,loadContext:async()=>context(),fetchImpl},objects,calls,rotations,credential,loads:()=>loads};
}
test('one real SDK orders path creates one immutable safe receipt, never summary/positions/catalog',async()=>{
  const h=harness(),r=await runCloudOrdersProbe(h.options);assert.equal(r.status,'passed');assert.equal(r.upstreamAttempted,true);assert.equal(h.loads(),1);
  assert.equal(h.calls.length,3);assert.equal(h.objects.size,3);assert.equal(h.rotations.length,0);
  assert.ok([...h.objects.keys()].every(p=>p.startsWith('report-check/orders-probe-')&&!p.includes('delivery/')));
  const text=JSON.stringify(r);for(const secret of Object.values(h.credential).filter(x=>typeof x==='string'))assert.ok(!text.includes(secret));
  assert.ok(!text.includes('orders.json'));assert.equal([...h.objects.values()].at(-1).ordersCalls,1);
});
test('duplicate request is consumed before any second credential or upstream access',async()=>{
  const h=harness();await runCloudOrdersProbe(h.options);const before=h.calls.length,r=await runCloudOrdersProbe(h.options);
  assert.equal(r.status,'failed');assert.equal(r.upstreamAttempted,false);assert.equal(h.calls.length,before);assert.equal(h.loads(),1);
});
test('wrong runtime, retries, parallel tasks, old/new date, long expiry and mixed CLI cannot reach IO',async()=>{
  for(const change of [o=>o.env={},o=>o.env.CLOUD_RUN_TASK_ATTEMPT='1',o=>o.env.CLOUD_RUN_TASK_COUNT='2',o=>o.request.dataDate='2026-10-13',o=>o.request.expiresAt='2026-10-15T13:31:00.000Z',o=>o.request.expiresAt='2026-10-15T13:14:00.000Z',o=>o.request.nonce='OLD_NONCE']){
    const h=harness();change(h.options);const r=await runCloudOrdersProbe(h.options);assert.equal(r.status,'failed');assert.equal(h.loads(),0);assert.equal(h.calls.length,0);assert.equal(h.objects.size,0);
  }
  assert.equal((await ordersProbeCli(['--request',JSON.stringify(request()),'--execute'])).code,'IB_DIAGNOSTIC_REQUEST_INVALID');
});
test('refresh preserves original client and mcp.read, at most once with existing-store persistence',async()=>{
  const h=harness();h.credential.expires_at=NOW;const r=await runCloudOrdersProbe(h.options);
  assert.equal(r.status,'passed');assert.equal(h.calls.filter(c=>c.url===TOKEN_ENDPOINT).length,1);assert.equal(h.rotations.length,1);
  assert.equal(h.rotations[0].client_id,h.credential.client_id);assert.equal(h.rotations[0].scope,'mcp.read');
});
test('invalid_grant is reported only after an actual mocked token request and never leaks its body',async()=>{
  const h=harness();h.credential.expires_at=NOW;h.options.fetchImpl=async(url)=>{h.calls.push({url:String(url)});assert.equal(String(url),TOKEN_ENDPOINT);return Response.json({error:'invalid_grant',description:'SYNTHETIC_PRIVATE_ERROR'},{status:400});};
  const r=await runCloudOrdersProbe(h.options);assert.equal(r.code,'IB_REFRESH_HTTP_FAILED');assert.equal(r.phase,'oauth_refresh');assert.equal(r.category,'invalid_grant');assert.equal(r.upstreamAttempted,true);assert.equal(h.calls.length,1);assert.equal(h.rotations.length,0);
  assert.ok(!JSON.stringify([...h.objects.values()]).includes('SYNTHETIC_PRIVATE_ERROR'));assert.equal([...h.objects.values()].at(-1).ordersCalls,0);
});
test('expired association, write scope or credential-load failure is not mislabelled an IB upstream rejection',async()=>{
  for(const change of [o=>o.loadContext=async()=>{const c=context();c.association.policy.expiresAt='2026-10-14T00:00:00.000Z';c.association.policyBlob=associationPolicyBlob(c.association.policy);return c;},o=>o.io.ibStore.load=async()=>{throw Error('SYNTHETIC_SECRET');}]){
    const h=harness();change(h.options);const r=await runCloudOrdersProbe(h.options);assert.equal(r.status,'failed');assert.equal(r.upstreamAttempted,false);assert.equal(h.calls.length,0);assert.ok(!JSON.stringify(r).includes('SYNTHETIC_SECRET'));
  }
  const h=harness();h.credential.scope='mcp.write';const r=await runCloudOrdersProbe(h.options);assert.equal(r.status,'failed');assert.equal(r.upstreamAttempted,false);assert.equal(h.calls.length,0);
});
test('forbidden methods, replacement client, fake successful capture and a second orders call cannot pass',async()=>{
  for(const capture of [async(_s,o)=>{await o.fetchImpl(RESOURCE,{body:JSON.stringify({method:'tools/list'})});},async(_s,o)=>{await o.fetchImpl(RESOURCE,{body:JSON.stringify({method:'tools/call',params:{name:'get_account_summary'}})});},async()=>({status:'captured',sources:[{sourceKey:'ib.orders',raw:{orders:[]}}]}),async(s,o)=>{await s.load();await o.fetchImpl(TOKEN_ENDPOINT,{method:'POST',body:new URLSearchParams({grant_type:'authorization_code',client_id:'OTHER',scope:'mcp.read',resource:RESOURCE})});}]){
    const h=harness();h.options.capture=capture;const r=await runCloudOrdersProbe(h.options);assert.equal(r.status,'failed');assert.equal(r.upstreamAttempted,false);assert.equal(h.calls.length,0);
  }
  const h=harness();h.options.capture=async(_s,o)=>{for(let i=0;i<2;i++)await o.fetchImpl(RESOURCE,{body:JSON.stringify({method:'tools/call',params:{name:'get_account_orders',arguments:{}}})});};
  const r=await runCloudOrdersProbe(h.options);assert.equal(r.status,'failed');assert.equal(h.calls.length,1);
});
test('upstream abort prevents a late tool read and failure leaves a consumed marker',async()=>{
  const h=harness();h.options.request.expiresAt=new Date(NOW+20).toISOString();h.options.fetchImpl=async(_url,o)=>{h.calls.push({});return new Promise((_resolve,reject)=>o.signal.addEventListener('abort',()=>reject(new DOMException('SYNTHETIC_TIMEOUT','AbortError')),{once:true}));};
  const r=await runCloudOrdersProbe(h.options);assert.equal(r.status,'failed');assert.equal(r.upstreamAttempted,true);assert.equal(r.category,'timeout');assert.equal(h.calls.length,1);assert.equal([...h.objects.values()].at(-1).ordersCalls,0);
});
test('no non-cloud request can create capabilities; importing the module never executes a source',()=>{
  assert.throws(()=>validateOrdersProbeRequest(request(),{now:NOW,env:{}}),/RUNTIME_REQUIRED/);
});
test('probe preflight reads only the exact protected account policy, with no CALL/public-report dependency',async()=>{
  const urls=[],c=context();const result=await loadProbeAssociation({now:()=>NOW,fetchImpl:async url=>{urls.push(String(url));return urls.length===1?Response.json({object:{sha:'a'.repeat(40)}}):new Response(associationPolicyText(c.association.policy));}});
  assert.equal(urls.length,2);assert.ok(urls[0].endsWith('/git/ref/heads/main'));assert.ok(urls[1].endsWith('/claude/xuan-ib-account-association-v1.json'));
  assert.equal(result.association.policyBlob,c.association.policyBlob);assert.ok(!urls.some(u=>/latest|pending-calls|sharesight|ibkr/.test(u)));
});
