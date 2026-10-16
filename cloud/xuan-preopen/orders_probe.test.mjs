// SYNTHETIC OFFLINE ONLY. No SDK credentials, cloud jobs or broker calls.
import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {runCloudOrdersProbe,ordersProbeCli,validateOrdersProbeRequest,loadProbeAssociation,inspectOrdersAccountEvidence} from './orders_probe.mjs';
import {RESOURCE,TOKEN_ENDPOINT} from './ib_mcp.mjs';
import {associationPolicyBlob,associationPolicyText} from '../../scripts/xuan-ib-account-association.mjs';
const NOW=Date.parse('2026-10-15T13:15:00.000Z'),hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const request=()=>({requestId:'11111111-2222-4333-8444-555555555555',dataDate:'2026-10-15',expiresAt:'2026-10-15T13:25:00.000Z'});
const env=()=>({CLOUD_RUN_JOB:'xuan-preopen-orders-probe',CLOUD_RUN_EXECUTION:'xuan-preopen-orders-probe-synthetic',CLOUD_RUN_TASK_INDEX:'0',CLOUD_RUN_TASK_ATTEMPT:'0',CLOUD_RUN_TASK_COUNT:'1'});
function context(){const policy={schemaVersion:1,policyId:'ib-primary-7day-pilot-v1',accountAlias:'IB-HK',basis:'owner-attested-recurring-v1',status:'active',purpose:'xuan-ib-read-only-report',editions:['adhoc','am','pm'],publisher:'codex-verified-candidate-v1',validFrom:'2026-10-10T00:00:00.000Z',expiresAt:'2026-10-20T00:00:00.000Z'};
  return {association:{policy,policyCommit:'a'.repeat(40),policyBlob:associationPolicyBlob(policy),checkedAt:new Date(NOW).toISOString()},previousSourceSha:'b'.repeat(40)};}
function harness(){
  const objects=new Map(),calls=[],rotations=[],raw={orders:[]};let loads=0;
  const credential={client_id:'SYNTHETIC_ORIGINAL_CLIENT',access_token:'SYNTHETIC_ACCESS',refresh_token:'SYNTHETIC_REFRESH',token_type:'Bearer',scope:'mcp.read',resource:RESOURCE,expires_at:NOW+3600000};
  const io={ibStore:{load:async()=>{loads++;return credential;},save:async c=>{rotations.push(c);}},savePrivate:async(name,value)=>{if(objects.has(name))throw Error('CLOUD_HTTP_412');objects.set(name,value);return {sha256:hash(value),generation:'1'};}};
  const fetchImpl=async(url,o)=>{calls.push({url:String(url),o});if(String(url)===TOKEN_ENDPOINT)return Response.json({access_token:'SYNTHETIC_ROTATED',refresh_token:'SYNTHETIC_ROTATED_REFRESH',token_type:'Bearer',scope:'mcp.read',expires_in:3600});
    assert.equal(String(url),RESOURCE);const q=JSON.parse(o.body);
    if(q.method==='initialize')return Response.json({jsonrpc:'2.0',id:q.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}}}});
    if(q.method==='notifications/initialized')return new Response(null,{status:202});
    assert.equal(q.method,'tools/call');assert.deepEqual(q.params,{name:'get_account_orders',arguments:{}});
    return Response.json({jsonrpc:'2.0',id:q.id,result:{content:[{type:'text',text:JSON.stringify(raw)}]}});
  };
  return {options:{request:request(),env:env(),now:()=>NOW,io,loadContext:async()=>context(),fetchImpl,expectedAccount:'SYNTHETIC_ACCOUNT'},objects,calls,rotations,credential,raw,loads:()=>loads};
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
  const h=harness();h.options.capture=async(_s,o)=>{for(let i=0;i<2;i++)await o.fetchImpl(RESOURCE,{method:'POST',body:JSON.stringify({method:'tools/call',params:{name:'get_account_orders',arguments:{}}})});};
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

test('all returned account assertions must match; absence keeps only owner-attested association',async()=>{
  const missing=harness(),r=await runCloudOrdersProbe(missing.options);
  assert.equal(r.status,'passed');assert.equal(r.responseAccountEvidence,'not-provided');assert.equal(r.nativeIdentityEvidence,'not-provided');assert.equal(r.associationBasis,'owner-attested');
  const matched=harness();matched.raw.account_id='SYNTHETIC_ACCOUNT';matched.raw.orders=[{metadata:{accountId:'SYNTHETIC_ACCOUNT'}}];
  const ok=await runCloudOrdersProbe(matched.options);assert.equal(ok.status,'passed');assert.equal(ok.responseAccountEvidence,'matched');
  for(const raw of [{orders:[],account_id:'SYNTHETIC_WRONG'}, {orders:[],accountId:null}, {orders:[],account_id:''}, {orders:[],account_id:' '},
    {orders:[{accountId:'SYNTHETIC_WRONG'}]}, {orders:[{metadata:{account_id:null}}]},
    {account_id:'SYNTHETIC_ACCOUNT',orders:[{accountId:'SYNTHETIC_WRONG'}]}, {orders:[{account_id:'SYNTHETIC_ACCOUNT'},{accountId:''}]},
    {orders:[],metadata:{ACCOUNT_ID:'SYNTHETIC_WRONG'}}]){
    const h=harness();Object.assign(h.raw,raw);const failed=await runCloudOrdersProbe(h.options);
    assert.equal(failed.status,'failed');assert.equal(failed.code,'IB_DIAGNOSTIC_ACCOUNT_MISMATCH');assert.equal(failed.upstreamAttempted,true);
    assert.ok(![...h.objects.keys()].some(k=>k.endsWith('/orders.json')));
    assert.ok(!JSON.stringify([...h.objects.values()]).includes('SYNTHETIC_WRONG'));assert.equal(failed.receiptSaved,true);
  }
});
test('account scan is bounded and never invokes accessors or accepts cycles',()=>{
  const inspect=v=>inspectOrdersAccountEvidence(v,{expectedAccount:'SYNTHETIC_ACCOUNT'});
  let nested={};for(let i=0;i<22;i++)nested={nested};
  assert.throws(()=>inspect(nested),/IB_DIAGNOSTIC_ACCOUNT_MISMATCH/);
  assert.throws(()=>inspect({orders:Array(50001).fill(null)}),/IB_DIAGNOSTIC_ACCOUNT_MISMATCH/);
  const cyclic={};cyclic.self=cyclic;assert.throws(()=>inspect(cyclic),/IB_DIAGNOSTIC_ACCOUNT_MISMATCH/);
  let accessed=false;const accessor={get account_id(){accessed=true;return 'SYNTHETIC_ACCOUNT';}};
  assert.throws(()=>inspect(accessor),/IB_DIAGNOSTIC_ACCOUNT_MISMATCH/);assert.equal(accessed,false);
});

// Exercise the actual privateCloudIo implementation (metadata, Secret Manager
// and create-only GCS transport), with synthetic network responses only.
function transportHarness({expired=false,refreshDelay=0,saveDelay=0,saveStatus=200,saveHang=false,mcpHang=false}={}){
  const calls=[],objects=new Map(),credential={client_id:'SYNTHETIC_ORIGINAL_CLIENT',access_token:'SYNTHETIC_ACCESS',refresh_token:'SYNTHETIC_REFRESH',token_type:'Bearer',scope:'mcp.read',resource:RESOURCE,expires_at:NOW+(expired?0:3600000)};
  const wait=(ms,signal,hang=false)=>new Promise((resolve,reject)=>{
    signal.throwIfAborted();let timer;const abort=()=>{clearTimeout(timer);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});
    if(!hang)timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
  });
  const fetchImpl=async(url,o)=>{
    const u=String(url);calls.push({url:u,signal:o.signal,time:performance.now()});o.signal.throwIfAborted();
    if(u.startsWith('http://metadata.google.internal/'))return Response.json({access_token:'SYNTHETIC_GOOGLE_TOKEN'});
    if(u.includes(':access'))return Response.json({payload:{data:Buffer.from(JSON.stringify(credential)).toString('base64')}});
    if(u===TOKEN_ENDPOINT){await wait(refreshDelay,o.signal);return Response.json({access_token:'SYNTHETIC_ROTATED',refresh_token:'SYNTHETIC_ROTATED_REFRESH',token_type:'Bearer',scope:'mcp.read',expires_in:3600});}
    if(u.includes(':addVersion')){
      const saved=JSON.parse(Buffer.from(JSON.parse(o.body).payload.data,'base64').toString());assert.equal(saved.client_id,credential.client_id);assert.equal(saved.scope,'mcp.read');
      await wait(saveDelay,o.signal,saveHang);return Response.json({name:'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/123',state:'ENABLED'},{status:saveStatus});
    }
    if(u.startsWith('https://storage.googleapis.com/upload/')){
      const parsed=new URL(u),name=parsed.searchParams.get('name');assert.equal(parsed.searchParams.get('ifGenerationMatch'),'0');
      if(objects.has(name))return Response.json({},{status:412});objects.set(name,JSON.parse(Buffer.from(o.body).toString()));
      return Response.json({name,size:String(o.body.length),generation:'1'});
    }
    assert.equal(u,RESOURCE);const q=JSON.parse(o.body);
    if(mcpHang)await wait(0,o.signal,true);
    if(q.method==='initialize')return Response.json({jsonrpc:'2.0',id:q.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}}}});
    if(q.method==='notifications/initialized')return new Response(null,{status:202});
    assert.deepEqual(q.params,{name:'get_account_orders',arguments:{}});
    return Response.json({jsonrpc:'2.0',id:q.id,result:{content:[{type:'text',text:JSON.stringify({orders:[]})}]}});
  };
  return {calls,objects,options:{request:request(),env:env(),now:()=>NOW,fetchImpl,loadContext:async()=>context(),expectedAccount:'SYNTHETIC_ACCOUNT',limits:{sourceMs:200,finalizeMs:1000}}};
}
test('actual private transport persists an admitted refresh response after source cutoff, then prevents every MCP call',async()=>{
  const h=transportHarness({expired:true,refreshDelay:260,saveDelay:40}),r=await runCloudOrdersProbe(h.options);
  assert.equal(r.status,'failed');assert.equal(r.code,'IB_DIAGNOSTIC_TIMEOUT');assert.equal(r.credentialPersistence,'saved');assert.equal(r.receiptSaved,true);
  assert.equal(h.calls.filter(c=>c.url===TOKEN_ENDPOINT).length,1);assert.equal(h.calls.filter(c=>c.url.includes(':addVersion')).length,1);assert.equal(h.calls.filter(c=>c.url===RESOURCE).length,0);
  assert.equal([...h.objects.values()].at(-1).credentialPersistence,'saved');assert.equal(h.objects.size,2);
});
test('actual private transport lets in-flight token persistence finish after source cutoff, without a second refresh',async()=>{
  const h=transportHarness({expired:true,saveDelay:260}),r=await runCloudOrdersProbe(h.options);
  assert.equal(r.status,'failed');assert.equal(r.credentialPersistence,'saved');assert.equal(r.receiptSaved,true);assert.equal(h.calls.filter(c=>c.url===RESOURCE).length,0);
  assert.equal(h.calls.filter(c=>c.url===TOKEN_ENDPOINT).length,1);assert.equal(h.calls.filter(c=>c.url.includes(':addVersion')).length,1);
});
test('actual private transport records a timed-out MCP failure using the separate finalization signal',async()=>{
  const h=transportHarness({mcpHang:true}),r=await runCloudOrdersProbe(h.options);
  assert.equal(r.status,'failed');assert.equal(r.category,'timeout');assert.equal(r.receiptSaved,true);assert.equal(r.upstreamAttempted,true);
  assert.equal(h.calls.filter(c=>c.url===RESOURCE).length,1);assert.equal(h.objects.size,2);
});
test('actual private transport preserves save uncertainty and never retries a failed or unconfirmed rotation',async()=>{
  const h=transportHarness({expired:true,saveStatus:500}),r=await runCloudOrdersProbe(h.options);
  assert.equal(r.code,'IB_TOKEN_ROTATION_OUTCOME_UNKNOWN');assert.equal(r.category,'save_outcome_unknown');assert.equal(r.phase,'credential_save');assert.equal(r.credentialPersistence,'outcome-unknown');assert.equal(r.receiptSaved,true);
  assert.equal(h.calls.filter(c=>c.url.includes(':addVersion')).length,1);assert.equal(h.calls.filter(c=>c.url===TOKEN_ENDPOINT).length,1);assert.equal(h.calls.filter(c=>c.url===RESOURCE).length,0);
});
test('actual private transport ends a hung rotation within the finalization deadline and does not claim a receipt',async()=>{
  const h=transportHarness({expired:true,saveHang:true});h.options.limits={sourceMs:200,finalizeMs:100};
  const started=performance.now(),r=await runCloudOrdersProbe(h.options);
  assert.equal(r.status,'failed');assert.equal(r.code,'IB_TOKEN_ROTATION_OUTCOME_UNKNOWN');assert.equal(r.credentialPersistence,'outcome-unknown');assert.equal(r.receiptSaved,false);
  assert.equal(h.calls.filter(c=>c.url.includes(':addVersion')).length,1);assert.equal(h.calls.filter(c=>c.url===RESOURCE).length,0);assert.ok(performance.now()-started<2000);assert.equal(h.objects.size,1);
});
test('even a caller with the finalization signal cannot admit a late MCP request',async()=>{
  const h=harness();h.options.limits={sourceMs:20,finalizeMs:200};
  h.options.capture=async(_store,o)=>{
    await new Promise(resolve=>o.signal.addEventListener('abort',resolve,{once:true}));
    assert.equal(o.refreshSignal.aborted,false);
    await o.fetchImpl(RESOURCE,{method:'POST',signal:o.refreshSignal,body:JSON.stringify({method:'initialize'})});
  };
  const r=await runCloudOrdersProbe(h.options);assert.equal(r.status,'failed');assert.equal(r.code,'IB_DIAGNOSTIC_TIMEOUT');assert.equal(r.upstreamAttempted,false);assert.equal(h.calls.length,0);assert.equal(r.receiptSaved,true);
});

async function adversarialMcpReply(makeBody,{sse=false}={}){
  const h=harness(),base=h.options.fetchImpl;
  h.options.fetchImpl=async(url,o)=>{
    const q=String(url)===RESOURCE?JSON.parse(o.body):null;
    if(q?.method!=='tools/call')return base(url,o);
    h.calls.push({url:String(url),o});const body=makeBody(q.id);
    return new Response(sse?'event: message\ndata: '+body+'\n\n':body,{headers:{'content-type':sse?'text/event-stream':'application/json'}});
  };
  const result=await runCloudOrdersProbe(h.options);
  assert.equal(result.status,'failed');assert.equal(result.upstreamAttempted,true);assert.equal(result.receiptSaved,true);
  assert.ok(![...h.objects.keys()].some(k=>k.endsWith('/orders.json')));
  const saved=JSON.stringify([...h.objects.values()]);for(const forbidden of ['SYNTHETIC_WRONG','SYNTHETIC_ACCOUNT'])assert.ok(!saved.includes(forbidden));
  return result;
}
test('full JSON/SSE envelopes reject account conflicts before structuredContent selection discards metadata or parallel text',async()=>{
  const good={orders:[],account_id:'SYNTHETIC_ACCOUNT'};
  const results=[
    {structuredContent:good,_meta:{accountId:'SYNTHETIC_WRONG'}},
    {structuredContent:good,_meta:{nested:[{account_id:null}]}},
    {structuredContent:good,content:[{type:'text',text:JSON.stringify({orders:[],account_id:''})}]},
    {structuredContent:good,content:[{type:'text',text:JSON.stringify({orders:[],accountId:'SYNTHETIC_WRONG'})}]},
    {structuredContent:good,content:[{type:'text',text:JSON.stringify({orders:[],metadata:{account_id:null}})}]},
    {structuredContent:good,_meta:{content:[{type:'text',text:JSON.stringify({account_id:'SYNTHETIC_WRONG'})}]}},
  ];
  for(const sse of [false,true])for(const result of results){
    const failed=await adversarialMcpReply(id=>JSON.stringify({jsonrpc:'2.0',id,result}),{sse});assert.equal(failed.code,'IB_DIAGNOSTIC_ACCOUNT_MISMATCH');
  }
  for(const accountId of ['SYNTHETIC_WRONG',null,'']){
    const failed=await adversarialMcpReply(id=>JSON.stringify({jsonrpc:'2.0',id,_meta:{accountId},result:{structuredContent:good}}));assert.equal(failed.code,'IB_DIAGNOSTIC_ACCOUNT_MISMATCH');
  }
});
test('duplicate account keys, escaped equivalent keys, nested JSON and parallel text are rejected before overwrite in JSON and SSE',async()=>{
  const conflicting='"account_id":"SYNTHETIC_WRONG","account_id":"SYNTHETIC_ACCOUNT"';
  const escaped='"account_id":null,"account_\\u0069d":"SYNTHETIC_ACCOUNT"';
  const nested='"meta":{"accountId":"SYNTHETIC_WRONG","accountId":"SYNTHETIC_ACCOUNT"}';
  for(const sse of [false,true])for(const fields of [conflicting,escaped,nested]){
    const failed=await adversarialMcpReply(id=>' {"jsonrpc":"2.0","id":'+id+',"result":{"structuredContent":{"orders":[],'+fields+'}}}',{sse});assert.equal(failed.code,'IB_MCP_RESPONSE_INVALID');
    const text='{"orders":[],'+fields+'}';
    const parallel=await adversarialMcpReply(id=>JSON.stringify({jsonrpc:'2.0',id,result:{structuredContent:{orders:[],account_id:'SYNTHETIC_ACCOUNT'},content:[{type:'text',text}]}}),{sse});assert.equal(parallel.code,'IB_MCP_RESPONSE_INVALID');
  }
});
test('an unmatched SSE notification cannot hide contradictory account metadata',async()=>{
  const failed=await adversarialMcpReply(id=>JSON.stringify({jsonrpc:'2.0',method:'notifications/progress',_meta:{account_id:'SYNTHETIC_WRONG'}})+'\n\ndata: '+JSON.stringify({jsonrpc:'2.0',id,result:{structuredContent:{orders:[],account_id:'SYNTHETIC_ACCOUNT'}}}),{sse:true});
  assert.equal(failed.code,'IB_DIAGNOSTIC_ACCOUNT_MISMATCH');
});
test('matching outer identity is retained as a closed verdict when decoded orders omit account identifiers',async()=>{
  const h=harness(),base=h.options.fetchImpl;
  h.options.fetchImpl=async(url,o)=>{const q=String(url)===RESOURCE?JSON.parse(o.body):null;if(q?.method!=='tools/call')return base(url,o);
    h.calls.push({url:String(url),o});return Response.json({jsonrpc:'2.0',id:q.id,_meta:{account_id:'SYNTHETIC_ACCOUNT'},result:{structuredContent:{orders:[]},content:[{type:'text',text:'{"orders":[]}'}]}});};
  const r=await runCloudOrdersProbe(h.options);assert.equal(r.status,'passed');assert.equal(r.responseAccountEvidence,'matched');
  const source=[...h.objects.entries()].find(([k])=>k.endsWith('/orders.json'))[1];assert.equal(source.accountEvidence.responseAccountEvidence,'matched');assert.equal(source.raw.account_id,undefined);
  assert.ok(!JSON.stringify(r).includes('SYNTHETIC_ACCOUNT'));
});

function boundTransportHarness(options={}){
  const h=transportHarness(options),base=h.options.fetchImpl;
  h.options.request.credentialBinding={clientId:'SYNTHETIC_ORIGINAL_CLIENT',version:'50'};
  h.options.fetchImpl=async(url,o)=>{
    const response=await base(url,o);
    if(String(url).includes(':access'))return Response.json({...await response.json(),name:'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/50'});
    return response;
  };
  return h;
}
test('bound actual cloud IO pins the consumed version and never uses latest',async()=>{
  const h=boundTransportHarness(),r=await runCloudOrdersProbe(h.options);
  assert.equal(r.status,'passed');assert.equal(r.credentialClientMatched,true);assert.equal(r.credentialVersionMatched,true);
  assert.equal(r.consumedCredentialVersion,'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/50');
  assert.equal(r.savedCredentialVersion,null);assert.ok(h.calls.some(c=>c.url.endsWith('/versions/50:access')));
  assert.ok(!h.calls.some(c=>c.url.includes('latest')));assert.equal([...h.objects.values()].at(-1).ordersCalls,1);
});
test('binding pairs, duplicate request keys, wrong version/name/client and missing capability admit zero IB calls',async()=>{
  for(const binding of [null,{}, {clientId:'x'},{version:'50'},{clientId:'x',version:'latest'},{clientId:'x',version:'50',account:'no'}]){
    const h=boundTransportHarness();h.options.request.credentialBinding=binding;const r=await runCloudOrdersProbe(h.options);
    assert.equal(r.status,'failed');assert.equal(h.calls.length,0);
  }
  assert.equal((await ordersProbeCli(['--request','{"credentialBinding":{"clientId":"x","clientId":"y","version":"50"}}'])).code,'IB_DIAGNOSTIC_REQUEST_INVALID');
  for(const mutate of [h=>h.options.request.credentialBinding.clientId='SYNTHETIC_WRONG_CLIENT',h=>h.options.request.credentialBinding.version='51',
    h=>h.options.io={...harness().options.io,ibStore:{load:async()=>{throw Error('SYNTHETIC_TOKEN_CANARY');}}}]){
    const h=boundTransportHarness();mutate(h);const r=await runCloudOrdersProbe(h.options);
    assert.equal(r.status,'failed');assert.equal(r.upstreamAttempted,false);assert.equal(r.credentialClientMatched,false);
    assert.equal(h.calls.filter(c=>[RESOURCE,TOKEN_ENDPOINT].includes(c.url)).length,0);assert.ok(!h.calls.some(c=>c.url.includes('latest')));
    assert.ok(!JSON.stringify(r).includes('CANARY'));
  }
});
test('bound refresh records the ack version, rejects wrong ack and keeps late persistence without late IB',async()=>{
  const valid=boundTransportHarness({expired:true}),ok=await runCloudOrdersProbe(valid.options);
  assert.equal(ok.status,'passed');assert.equal(ok.savedCredentialVersion,'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/123');
  for(const ack of [{name:'projects/other/secrets/xuan-preopen-ib-mcp/versions/123',state:'ENABLED'},
    {name:'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/50',state:'ENABLED'},
    {name:'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/123',state:'DISABLED'}]){
    const h=boundTransportHarness({expired:true}),base=h.options.fetchImpl;
    h.options.fetchImpl=async(url,o)=>{if(String(url).includes(':addVersion')){h.calls.push({url:String(url)});return Response.json(ack);}return base(url,o);};
    const r=await runCloudOrdersProbe(h.options);assert.equal(r.status,'failed');assert.equal(r.savedCredentialVersion,null);assert.equal(r.credentialPersistence,'outcome-unknown');
    assert.equal(h.calls.filter(c=>c.url===RESOURCE).length,0);assert.equal(h.calls.filter(c=>c.url.includes(':addVersion')).length,1);
  }
  const late=boundTransportHarness({expired:true,refreshDelay:50});late.options.limits={sourceMs:20,finalizeMs:200};
  const r=await runCloudOrdersProbe(late.options);assert.equal(r.status,'failed');assert.equal(r.credentialPersistence,'saved');
  assert.equal(r.savedCredentialVersion,'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/123');
  assert.equal(late.calls.filter(c=>c.url===RESOURCE).length,0);assert.equal(r.receiptSaved,true);
});
test('bound refresh rejects duplicate token JSON or changed client/resource before save or orders',async()=>{
  for(const body of [
    '{"access_token":"SYNTHETIC_TOKEN_CANARY","access_\\u0074oken":"other","refresh_token":"x","token_type":"Bearer","expires_in":3600}',
    JSON.stringify({access_token:'SYNTHETIC_TOKEN_CANARY',refresh_token:'x',token_type:'Bearer',expires_in:3600,client_id:'SYNTHETIC_WRONG_CLIENT'}),
    JSON.stringify({access_token:'SYNTHETIC_TOKEN_CANARY',refresh_token:'x',token_type:'Bearer',expires_in:3600,resource:'https://wrong.invalid'}),
    ...[null,'','   ',7,{}].map(refresh_token=>JSON.stringify({access_token:'SYNTHETIC_TOKEN_CANARY',refresh_token,token_type:'Bearer',expires_in:3600,scope:'mcp.read'})),
  ]){
    const h=boundTransportHarness({expired:true}),base=h.options.fetchImpl;
    h.options.fetchImpl=async(url,o)=>{if(String(url)===TOKEN_ENDPOINT){h.calls.push({url:String(url)});return new Response(body);}return base(url,o);};
    const r=await runCloudOrdersProbe(h.options);assert.equal(r.status,'failed');assert.equal(h.calls.filter(c=>c.url===RESOURCE).length,0);
    assert.equal(h.calls.filter(c=>c.url.includes(':addVersion')).length,0);assert.ok(!JSON.stringify([...h.objects.values()]).includes('CANARY'));
  }
});
test('synthetic exact-version chain advances only from the confirmed rotation ack',async()=>{
  let time=NOW,nextVersion=50,refreshes=0,orders=0;const versions=new Map([['50',{client_id:'SYNTHETIC_CHAIN_CLIENT',access_token:'SYNTHETIC_CHAIN_ACCESS',refresh_token:'SYNTHETIC_CHAIN_REFRESH',token_type:'Bearer',scope:'mcp.read',resource:RESOURCE,expires_at:NOW+3600000}]]),objects=new Map(),urls=[];
  const fetchImpl=async(url,o)=>{const u=String(url);urls.push(u);o.signal.throwIfAborted();
    if(u.includes('metadata.google'))return Response.json({access_token:'SYNTHETIC_GOOGLE_CANARY'});
    if(u.includes(':access')){const v=u.match(/\/versions\/(\d+):access$/)?.[1];assert.ok(versions.has(v),'EXPLICIT_VERSION_ONLY');return Response.json({name:'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/'+v,payload:{data:Buffer.from(JSON.stringify(versions.get(v))).toString('base64')}});}
    if(u===TOKEN_ENDPOINT){refreshes++;return Response.json({access_token:'SYNTHETIC_NEW_ACCESS',refresh_token:'SYNTHETIC_NEW_REFRESH',token_type:'Bearer',scope:'mcp.read',expires_in:3600});}
    if(u.includes(':addVersion')){const v=String(++nextVersion);versions.set(v,JSON.parse(Buffer.from(JSON.parse(o.body).payload.data,'base64').toString()));return Response.json({name:'projects/860729177589/secrets/xuan-preopen-ib-mcp/versions/'+v,state:'ENABLED'});}
    if(u.startsWith('https://storage.googleapis.com/upload/')){const name=new URL(u).searchParams.get('name');if(objects.has(name))return Response.json({},{status:412});objects.set(name,JSON.parse(Buffer.from(o.body).toString()));return Response.json({name,size:String(o.body.length),generation:'1'});}
    assert.equal(u,RESOURCE);const q=JSON.parse(o.body);if(q.method==='initialize')return Response.json({jsonrpc:'2.0',id:q.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}}}});
    if(q.method==='notifications/initialized')return new Response(null,{status:202});orders++;assert.deepEqual(q.params,{name:'get_account_orders',arguments:{}});return Response.json({jsonrpc:'2.0',id:q.id,result:{structuredContent:{orders:[]}}});};
  const run=async(v,id)=>runCloudOrdersProbe({request:{...request(),requestId:`11111111-2222-4333-8444-55555555555${id}`,expiresAt:new Date(time+600000).toISOString(),credentialBinding:{clientId:'SYNTHETIC_CHAIN_CLIENT',version:v}},env:env(),now:()=>time,fetchImpl,expectedAccount:'SYNTHETIC_ACCOUNT',loadContext:async()=>{const c=context();c.association.checkedAt=new Date(time).toISOString();return c;}});
  const first=await run('50',1);assert.equal(first.status,'passed');assert.equal(first.savedCredentialVersion,null);assert.equal(refreshes,0);
  time+=3480001;const second=await run('50',2);assert.equal(second.status,'passed');assert.equal(second.savedCredentialVersion,'projects/860729177589/secrets/xuan-preopen-ib-mcp/versions/51');assert.equal(refreshes,1);
  const third=await run(second.savedCredentialVersion.split('/').at(-1),3);assert.equal(third.status,'passed');assert.equal(third.consumedCredentialVersion,'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/51');
  assert.equal(refreshes,1);assert.equal(orders,3);assert.ok(!urls.some(u=>u.includes('/versions/latest')));
});
test('binding cannot be bypassed by an injected capture calling IB before loading its bound version',async()=>{
  const h=boundTransportHarness();h.options.capture=async(_store,o)=>o.fetchImpl(RESOURCE,{method:'POST',body:JSON.stringify({method:'initialize'})});
  const r=await runCloudOrdersProbe(h.options);assert.equal(r.status,'failed');assert.equal(r.upstreamAttempted,false);
  assert.equal(h.calls.filter(c=>[RESOURCE,TOKEN_ENDPOINT].includes(c.url)).length,0);
});
test('orders arguments must be the exact empty object and refresh cannot inject scopes/accounts or a different token',async()=>{
  for(const params of [{name:'get_account_orders',arguments:[]},{name:'get_account_orders',arguments:{},account:'other'}]){
    const h=harness();h.options.capture=async(_store,o)=>o.fetchImpl(RESOURCE,{method:'POST',body:JSON.stringify({method:'tools/call',params})});
    const r=await runCloudOrdersProbe(h.options);assert.equal(r.status,'failed');assert.equal(h.calls.length,0);
  }
  for(const extra of ['account-ids','scope','refresh_token']){
    const h=harness();h.options.capture=async(store,o)=>{await store.load();const body=new URLSearchParams({grant_type:'refresh_token',client_id:h.credential.client_id,refresh_token:h.credential.refresh_token,scope:'mcp.read',resource:RESOURCE});body.append(extra,'SYNTHETIC_PRIVATE_CANARY');return o.fetchImpl(TOKEN_ENDPOINT,{method:'POST',body});};
    const r=await runCloudOrdersProbe(h.options);assert.equal(r.status,'failed');assert.equal(h.calls.length,0);assert.ok(!JSON.stringify(r).includes('CANARY'));
  }
});

test('a bound non-rotating refresh preserves only that exact version token and saves before its sole orders call',async()=>{
  const h=boundTransportHarness({expired:true}),base=h.options.fetchImpl;let refreshes=0,saves=0;const sequence=[];
  h.options.fetchImpl=async(url,o)=>{
    if(String(url)===TOKEN_ENDPOINT){refreshes++;sequence.push('refresh');h.calls.push({url:String(url)});
      assert.ok(o.body.get('refresh_token')==='SYNTHETIC_REFRESH','BOUND_REFRESH_ONLY');
      return Response.json({access_token:'SYNTHETIC_NONROTATING_ACCESS',token_type:'Bearer',expires_in:3600,scope:'mcp.read'});}
    if(String(url).includes(':addVersion')){saves++;sequence.push('save');
      const saved=JSON.parse(Buffer.from(JSON.parse(o.body).payload.data,'base64').toString());
      assert.ok(saved.refresh_token==='SYNTHETIC_REFRESH','PRESERVE_BOUND_VERSION_REFRESH');
      assert.ok(saved.access_token==='SYNTHETIC_NONROTATING_ACCESS','SAVE_NEW_ACCESS');}
    if(String(url)===RESOURCE&&JSON.parse(o.body).method==='tools/call')sequence.push('orders');
    return base(url,o);
  };
  const result=await runCloudOrdersProbe(h.options);assert.equal(result.status,'passed');
  assert.equal(result.consumedCredentialVersion,'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/50');
  assert.equal(result.savedCredentialVersion,'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/123');
  assert.deepEqual(sequence,['refresh','save','orders']);assert.equal(refreshes,1);assert.equal(saves,1);
  assert.ok(!h.calls.some(call=>call.url.includes('/versions/latest')));assert.ok(!JSON.stringify(result).includes('SYNTHETIC_'));
});
