// End-to-end synthetic transport: production producer, GCS adapter, verifier,
// planner, CAS and pinned readback. No SDK credential loader or live network.
import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
import {runPrivateActionPreviewOnce} from './action_preview_once.mjs';
import {RESOURCE,TOKEN_ENDPOINT} from './ib_mcp.mjs';
import {associationPolicyText} from '../../scripts/xuan-ib-account-association.mjs';
import {extractNightActionModel} from '../../scripts/xuan-ib-night-action-view.mjs';
import {registeredOwnerRecovery} from './owner_source_recovery.mjs';
import {createOwnerLatestStore} from './owner_latest_store.mjs';
import {createOwnerContextLoader,deliverOwnerLatest} from './owner_latest_delivery.mjs';
import {prepareOwnerStaticDisplay} from './owner_latest_admission.mjs';
import {LATEST_TARGET,LATEST_HEADERS} from './owner_latest.mjs';
import {validateCompletedEodSession} from './eod_report.mjs';
import {planPreopen} from './calendar.mjs';
import {readFileSync} from 'node:fs';
import {renderOwnerPhoneCanary} from './owner_preview_access.mjs';
const encode=x=>new TextEncoder().encode(x),decode=x=>new TextDecoder().decode(x);
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
globalThis.fetch=()=>assert.fail('No live network permitted');
function makeHarness(NOW){const DATE=planPreopen(NOW).sourceDate;
const digest=v=>crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const blob=v=>crypto.createHash('sha1').update('blob '+Buffer.byteLength(v)+'\0').update(v).digest('hex');
const request=()=>({requestId:registeredOwnerRecovery().requestId,dataDate:new Date(NOW+28800000).toISOString().slice(0,10),expiresAt:new Date(NOW+55000).toISOString()});
const env=()=>({CLOUD_RUN_JOB:'xuan-preopen-orders-probe',CLOUD_RUN_EXECUTION:'xuan-preopen-orders-probe-synthetic',CLOUD_RUN_TASK_INDEX:'0',CLOUD_RUN_TASK_ATTEMPT:'0',CLOUD_RUN_TASK_COUNT:'1'});
const order=()=>({order_id:777,order_status:'NEW',order_type:'LIMIT',side:'BUY',limit_price:'10',total_shares_qty:'10',cum_shares_qty:'4',remaining_shares_qty:'6',primary_description:'Buy 10 EXUS',secondary_description:'SYNTHETIC_INSTRUMENT',order_time:'2026-10-14T14:00:00Z'});
function policy(){return {schemaVersion:1,policyId:'ib-primary-7day-pilot-v1',accountAlias:'IB-HK',basis:'owner-attested-recurring-v1',status:'active',purpose:'xuan-ib-read-only-report',editions:['adhoc','am','pm'],publisher:'codex-verified-candidate-v1',validFrom:'2026-10-10T00:00:00.000Z',expiresAt:'2026-12-01T00:00:00.000Z'};}
function sharesight(portfolio){const h=(id,group_name,value,code)=>({id,group_name,value,quantity:10,instrument:{code,currency:{code:'USD'}}});
  const report={portfolio_id:portfolio==='IB-HK'?936247:936238,currency:{code:'USD'},start_date:DATE,end_date:DATE,include_sales:false,
    grouping:portfolio==='IB-HK'?'custom_group_category':'investment_type',cash_accounts:[{value:portfolio==='IB-HK'?1000:200}]};
  if(portfolio==='IB-HK')Object.assign(report,{custom_group:{id:83569,name:'资产类别'},holdings:[h(1,'美国底仓',450,'CSPX'),h(2,'美国底仓',50,'USSC'),h(3,'美国科技',250,'GOOG'),h(4,'非美发达',180,'EXUS'),h(5,'新兴市场',70,'EIMI'),h(6,'防御资产',90,'TLT')]});
  return {mode:'read_only',source:'Sharesight User API',data:{report}};
}
function harness({expired=false,tokenStatus=200,tokenDelay=0,saveDelay=0,saveStatus=200,saveHang=false,ssFail=null,ssHang=false,ordersRaw={orders:[order()],complete:true},mcpStatus=200,mcpEnvelope=null,uploadBad=false,associationChanges=false,failUpload=null,clockHook=null}={}){
  const objects=new Map(),calls=[],events=[];let rotations=0,policyReads=0;
  const credential={client_id:'SYNTHETIC_ORIGINAL_CLIENT',access_token:'SYNTHETIC_ACCESS',refresh_token:'SYNTHETIC_REFRESH',token_type:'Bearer',scope:'mcp.read',resource:RESOURCE,expires_at:NOW+(expired?0:3600000)};
  const wait=(ms,signal,hang=false)=>new Promise((resolve,reject)=>{signal.throwIfAborted();let timer;const abort=()=>{clearTimeout(timer);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});if(!hang)timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);});
  const fetchImpl=async(url,o={})=>{
    const u=String(url);o.signal.throwIfAborted();calls.push({url:u,method:o.method??'GET'});
    clockHook?.(u);
    if(u.startsWith('https://api.github.com/'))return Response.json(u.includes('/git/ref/')?{object:{sha:'a'.repeat(40)}}:{sha:'a'.repeat(40)});
    if(u.startsWith('https://raw.githubusercontent.com/')){
      if(u.endsWith('xuan-ib-account-association-v1.json')){policyReads++;const p=policy();if(associationChanges&&policyReads>2)p.expiresAt='2026-10-19T00:00:00.000Z';return new Response(associationPolicyText(p));}
      if(u.endsWith('xuan-ib-etf-pending-calls-v1.json'))return Response.json({schemaVersion:1,purpose:'xuan-etf-owner-declared-pending-calls',entries:[{date:'2026-09-17',usd:100}]});
      if(u.endsWith('latest.meta.json'))return Response.json({sourceSha:'b'.repeat(40),htmlBlob:blob('SYNTHETIC_PRIOR_HTML')});
      if(u.endsWith('latest.html'))return new Response('SYNTHETIC_PRIOR_HTML');assert.fail('Unknown public context');
    }
    if(u.startsWith('http://metadata.google.internal/'))return Response.json({access_token:'SYNTHETIC_GOOGLE_TOKEN'});
    if(u.includes('/secrets/xuan-preopen-ib-mcp/versions/latest:access'))return Response.json({payload:{data:Buffer.from(JSON.stringify(credential)).toString('base64')}});
    if(u.includes('/secrets/family-portfolio-gateway-key/versions/latest:access')){events.push('gateway-credential');return Response.json({payload:{data:Buffer.from('SYNTHETIC_GATEWAY_TOKEN').toString('base64')}});}
    if(u===TOKEN_ENDPOINT){events.push('refresh');assert.equal(o.body.get('client_id'),credential.client_id);assert.equal(o.body.get('scope'),'mcp.read');assert.equal(o.body.get('grant_type'),'refresh_token');await wait(tokenDelay,o.signal);
      return Response.json(tokenStatus===200?{access_token:'SYNTHETIC_NEXT_ACCESS',refresh_token:'SYNTHETIC_NEXT_REFRESH',token_type:'Bearer',scope:'mcp.read',expires_in:3600}:{error:'invalid_grant',description:'SYNTHETIC_PRIVATE_ERROR'},{status:tokenStatus});}
    if(u.includes('/secrets/xuan-preopen-ib-mcp:addVersion')){rotations++;events.push('rotation-start');const value=JSON.parse(Buffer.from(JSON.parse(o.body).payload.data,'base64').toString());assert.equal(value.client_id,credential.client_id);assert.equal(value.scope,'mcp.read');
      await wait(saveDelay,o.signal,saveHang);events.push('rotation-saved');return Response.json({name:'projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp/versions/123',state:'ENABLED'},{status:saveStatus});}
    if(u===RESOURCE){const q=JSON.parse(o.body);events.push(q.method);if(mcpStatus!==200)return Response.json({error:'SYNTHETIC_PRIVATE_ERROR'},{status:mcpStatus});
      if(q.method==='initialize')return Response.json({jsonrpc:'2.0',id:q.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}}}});
      if(q.method==='notifications/initialized')return new Response(null,{status:202});
      assert.deepEqual(q.params,{name:'get_account_orders',arguments:{}});
      if(mcpEnvelope)return new Response(mcpEnvelope(q.id),{headers:{'content-type':'application/json'}});
      return Response.json({jsonrpc:'2.0',id:q.id,result:{structuredContent:ordersRaw}});
    }
    if(u.startsWith('https://family-portfolio-gateway-')){const p=new URL(u).searchParams,portfolio=p.get('portfolio');events.push('sharesight-'+portfolio);assert.equal(o.headers.Authorization,'Bearer SYNTHETIC_GATEWAY_TOKEN');
      if(ssHang)await wait(0,o.signal,true);return Response.json(portfolio===ssFail?{error:'SYNTHETIC_PRIVATE_ERROR'}:sharesight(portfolio),{status:portfolio===ssFail?500:200});}
    assert.ok(u.startsWith('https://storage.googleapis.com/upload/'),'No object GET, Flex, public write or unknown endpoint');assert.equal(o.method,'POST');const p=new URL(u),name=p.searchParams.get('name');assert.equal(p.searchParams.get('ifGenerationMatch'),'0');
    if(objects.has(name))return Response.json({},{status:412});
    if(name===failUpload||name.endsWith('/'+failUpload))return Response.json({},{status:500});
    const text=o.body.toString(),value=name.endsWith('.html')?text:JSON.parse(text);objects.set(name,value);events.push('saved-'+name.split('/').at(-1));
    return Response.json({name:uploadBad?'SYNTHETIC_WRONG_OBJECT':name,size:String(o.body.length),generation:String(objects.size)});
  };
  return {options:{request:request(),env:env(),now:()=>NOW,fetchImpl},objects,calls,events,credential,rotations:()=>rotations};
}
const count=(h,fragment)=>h.calls.filter(c=>c.url.includes(fragment)).length;
function report(h){const receipt=[...h.objects.entries()].find(([k])=>k.endsWith('/preview-receipt.json'))?.[1];return receipt?{receipt,html:h.objects.get(receipt.artifact.privateObject),model:extractNightActionModel(h.objects.get(receipt.artifact.privateObject))}:null;}
function safeOutput(r){const text=JSON.stringify(r);for(const secret of ['SYNTHETIC_ACCESS','SYNTHETIC_REFRESH','SYNTHETIC_NEXT_ACCESS','SYNTHETIC_NEXT_REFRESH','SYNTHETIC_GOOGLE_TOKEN','SYNTHETIC_GATEWAY_TOKEN','SYNTHETIC_PRIVATE_ERROR','SYNTHETIC_INSTRUMENT','EXUS'])assert.ok(!text.includes(secret));}


return harness({ordersRaw:{orders:[order()]}});
}

function memoryStorage(objects,{conflict=false,corruptReadback=false,canaryChanged=false}={}){
  const records=new Map(),calls=[];let next=1000;
  const add=(name,bytes,generation=String(++next),metadata={})=>records.set(name,{bytes:Buffer.from(bytes),metadata:{bucket:LATEST_TARGET.bucket,name,generation,size:String(Buffer.byteLength(bytes)),...metadata}});
  for(const [name,value] of objects)add(name,typeof value==='string'?value:JSON.stringify(value),String([...objects.keys()].indexOf(name)+1));
  const canary=JSON.parse(readFileSync(new URL('../../security/xuan-owner-registered-canary.json',import.meta.url)));
  add(canary.target.object,renderOwnerPhoneCanary(canary.pin),canaryChanged?'999':canary.pin.generation,{...LATEST_HEADERS});
  const response=(body,headers={},status=200)=>new Response(body,{status,headers});
  const request=async(url,o={})=>{
    const u=new URL(url),method=o.method??'GET';calls.push({url,method});
    assert.equal(u.origin,'https://storage.googleapis.com');
    if(method==='POST'){
      assert.equal(u.pathname,`/upload/storage/v1/b/${LATEST_TARGET.bucket}/o`);
      if(conflict||u.searchParams.get('ifGenerationMatch')!==records.get(LATEST_TARGET.object)?.metadata.generation)return response(null,{},412);
      const raw=Buffer.from(o.body),boundary=o.headers['Content-Type']??o.headers['content-type'],b=boundary.split('boundary=')[1];
      const first=Buffer.from('--'+b+'\r\nContent-Type: application/json; charset=utf-8\r\n\r\n'),middle=Buffer.from('\r\n--'+b+'\r\nContent-Type: '+LATEST_HEADERS.contentType+'\r\n\r\n');
      const at=raw.indexOf(middle),resource=JSON.parse(raw.subarray(first.length,at)),tail=Buffer.byteLength('\r\n--'+b+'--\r\n');
      add(resource.name,raw.subarray(at+middle.length,-tail),String(++next),{...LATEST_HEADERS,metadata:resource.metadata});
      return Response.json(records.get(resource.name).metadata);
    }
    assert.ok(['GET','HEAD'].includes(method));
    const name=decodeURIComponent(u.pathname.split('/o/')[1]),r=records.get(name);
    if(!r)return response(null,{},404);
    if(u.searchParams.has('generation')&&u.searchParams.get('generation')!==r.metadata.generation)return response(null,{},404);
    const headers={'x-goog-generation':r.metadata.generation,'content-length':String(r.bytes.length),'content-type':r.metadata.contentType??'application/octet-stream',
      ...(r.metadata.contentDisposition?{'content-disposition':'attachment','cache-control':'no-cache, no-store, max-age=0, must-revalidate'}:{})};
    if(method==='HEAD')return response(null,headers);
    if(u.searchParams.get('alt')==='media'){
      const bytes=Buffer.from(r.bytes);if(corruptReadback&&name===LATEST_TARGET.object&&Number(r.metadata.generation)>1000)bytes[0]^=1;
      return response(bytes,headers);
    }
    return Response.json(r.metadata);
  };
  return {request,calls,records,add};
}

async function nativeBoundary(memory,{now,dataDate,priorPin},action){
  const clockNow=()=>typeof now==='function'?now():now;
  const child=spawn(process.platform==='darwin'?'/Users/huanwu/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3.12':'python3',
    ['-I','-B',new URL('./owner_time_contract.fixture.py',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();let stderr='';child.stderr.on('data',x=>stderr+=x);child.on('error',()=>{});
  const send=v=>child.stdin.write(JSON.stringify(v)+'\n');send({now:clockNow(),dataDate,priorPin});
  let queue=Promise.resolve();
  const run=async(url,o={})=>{
    const requestNow=clockNow();send({fixtureNow:requestNow,op:'dailyRequest',url,method:o.method??'GET',headers:{...o.headers,...(o.method==='POST'?{'Accept-Encoding':'identity'}:{})},body:o.body===undefined?null:Buffer.from(o.body).toString('base64'),
      ...(o.method==='POST'?{admissionExpiresAt:requestNow+5000}:{})});
    for(;;){const line=await lines.next();assert.equal(line.done,false,stderr);const v=JSON.parse(line.value);
      if(v.kind==='fetch'){const response=await memory.request(v.url,{method:v.method,headers:v.headers,...(v.body!==null?{body:Buffer.from(v.body,'base64')}:{})});
        send({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')});continue;}
      if(v.kind==='error')throw Object.assign(Error(v.code),{safeCode:v.code});
      assert.equal(v.kind,'result');return new Response(Buffer.from(v.result.body,'base64'),{status:v.result.status,headers:v.result.headers});
    }
  };
  const request=(...args)=>{const p=queue.then(()=>run(...args));queue=p.catch(()=>{});return p;};
  try{return await action(request);}finally{send({close:true});child.stdin.end();child.kill();}
}

async function pipeline(iso,{conflict=false,corruptReadback=false,elapsed=0,rollback=false,preparationMs=0,preparationFailure=false,transientContext=false,canaryChanged=false}={}){
  const start=Date.parse(iso),prior=makeHarness(start-120000),reg=registeredOwnerRecovery();
  prior.options.request.requestId='11111111-2222-4333-8444-555555555555';
  const old=await runPrivateActionPreviewOnce({...prior.options,dailyDelivery:true});assert.equal(old.status,'generated');
  const fresh=makeHarness(start),generated=await runPrivateActionPreviewOnce(fresh.options);assert.equal(generated.status,'generated');
  assert.equal(fresh.objects.size,10);assert.equal(fresh.calls.filter(c=>c.url.includes('/v1/performance')).length,2);
  assert.equal(fresh.events.filter(e=>e==='tools/call').length,1);
  const memory=memoryStorage(prior.objects,{conflict,corruptReadback,canaryChanged});
  // Each source generation is from its own real synthetic upload response.
  for(const [name,value] of fresh.objects)memory.add(name,typeof value==='string'?value:JSON.stringify(value),String([...fresh.objects.keys()].indexOf(name)+1));
  const original=memory.records.get(reg.priorReceiptObject),priorPin={priorReceiptSha256:hash(original.bytes),priorReceiptGeneration:original.metadata.generation};
  const fs=await import('node:fs'),{syncBuiltinESMExports}=await import('node:module'),saved=fs.default.readFileSync;
  fs.default.readFileSync=function(file,...args){if(String(file).endsWith('/security/xuan-owner-source-recovery.json'))return JSON.stringify({...reg,...priorPin,receiptObject:undefined});return saved.call(this,file,...args);};syncBuiltinESMExports();
  try{
    const oldReceipt=JSON.parse(original.bytes),artifact=memory.records.get(oldReceipt.artifact.privateObject);
    const {ownerBundleMetadata}=await import('./owner_latest_delivery.mjs');
    const oldBundle={html:new Uint8Array(artifact.bytes),receipt:new Uint8Array(original.bytes),artifactObject:oldReceipt.artifact.privateObject,artifactGeneration:artifact.metadata.generation,artifactSha256:hash(artifact.bytes),receiptObject:reg.priorReceiptObject,receiptGeneration:original.metadata.generation,receiptSha256:hash(original.bytes)};
    const metadata=ownerBundleMetadata(oldBundle,oldReceipt),display=prepareOwnerStaticDisplay(oldBundle.html);
    const custom={bundleMetadata:JSON.stringify(metadata),displaySha256:hash(display),...Object.fromEntries(['artifactObject','artifactGeneration','artifactSha256','receiptObject','receiptGeneration','receiptSha256'].map(k=>[k,metadata[k]]))};
    memory.add(LATEST_TARGET.object,display,'900',{...LATEST_HEADERS,metadata:custom});
    const contextFetch=async(url,options)=>String(url).includes('/compare/')?Response.json({status:'identical',merge_base_commit:{sha:'a'.repeat(40)}}):fresh.options.fetchImpl(url,options);
    let clock=start+elapsed,reads=0,preparations=0,contextAttempts=0;
    const {withOwnerPublicationReads,ownerSourceFetch}=await import('./owner_source_bytes.mjs');
    const savedFetch=globalThis.fetch;globalThis.fetch=async(url,options)=>{if(transientContext&&String(url).endsWith('/claude/xuan-ib-account-association-v1.json')&&++contextAttempts===1)throw Object.assign(new TypeError('SYNTHETIC_PRIVATE'),{cause:{code:'ETIMEDOUT'}});return contextFetch(url,options);};
    let result;try{
    result=await withOwnerPublicationReads(()=>nativeBoundary(memory,{now:()=>clock,dataDate:reg.dataDate,priorPin},async request=>deliverOwnerLatest({registeredRecovery:true,request,now:()=>clock,
      prepareCommit:async({signal})=>{assert.equal(signal.aborted,false);preparations++;clock+=preparationMs;if(preparationFailure)throw Error('SYNTHETIC_BOUNDARY_REJECTED');},
      loadContext:async opts=>{const result=await createOwnerContextLoader({fetchImpl:ownerSourceFetch,now:()=>clock})(opts);if(rollback&&++reads===2)clock--;return result;}})));
    }finally{globalThis.fetch=savedFetch;}
    const posts=memory.calls.filter(c=>c.method==='POST');
    if(!elapsed&&!rollback&&!conflict&&!corruptReadback&&!canaryChanged&&!preparationFailure&&preparationMs<60000&&clock-start<=1800000&&new Date(clock+28800000).toISOString().slice(0,10)===reg.dataDate){
      assert.equal(preparations,1);if(transientContext)assert.equal(contextAttempts,2);assert.equal(result.status,'published-verified',JSON.stringify(result));assert.equal(posts.length,1);
      const pointer=memory.records.get(LATEST_TARGET.object);assert.equal(hash(pointer.bytes),result.sha256);
      assert.equal(JSON.parse(pointer.metadata.metadata.bundleMetadata).captureStartedAt,new Date(start).toISOString());
      assert.equal((decode(pointer.bytes).match(/<section class="card(?: concentration)?"/g)||[]).length,5);
      assert.deepEqual(memory.records.get(reg.priorReceiptObject).bytes,original.bytes);
      const after=memory.calls.slice(memory.calls.indexOf(posts[0])+1);assert.ok(after.some(c=>new URL(c.url).searchParams.get('alt')==='media'));
      // A later reader authenticates the same recovery bundle as historical latest.
      await nativeBoundary(memory,{now:clock,dataDate:reg.dataDate,priorPin},async request=>{const latest=await createOwnerLatestStore({request}).readLatest();assert.equal(latest.bundle.metadata.receiptObject,reg.receiptObject);});
    }else if(canaryChanged){assert.equal(result.status,'unknown');assert.equal(posts.length,0);}
    else if(conflict){assert.equal(result.status,'conflict');assert.equal(posts.length,1);}
    else if(corruptReadback){assert.equal(result.status,'unknown');assert.equal(posts.length,1);}
    else {assert.equal(result.status,'blocked');assert.equal(posts.length,0);}
    return result;
  }finally{fs.default.readFileSync=saved;syncBuiltinESMExports();}
}

test('HK 04:02, 07:19, 07:59 and 08:00 retain Oct21 report / Oct20 NY source through native CAS and readback',async()=>{
  for(const time of ['2026-10-20T20:02:00.000Z','2026-10-20T23:19:52.742Z','2026-10-20T23:59:59.999Z','2026-10-21T00:00:00.000Z'])await pipeline(time);
});
test('HK 00:00–04:00 cannot fetch an uncompleted NY session; winter closes at HK05:00',async()=>{
  for(const time of ['2026-10-20T16:00:00.000Z','2026-10-20T19:59:59.999Z','2026-11-09T20:59:59.999Z']){
    const h=makeHarness(Date.parse(time)),result=await runPrivateActionPreviewOnce(h.options);assert.equal(result.code,'PRIVATE_PREVIEW_CALENDAR_INVALID');assert.equal(h.calls.length,0);
  }
  assert.doesNotThrow(()=>validateCompletedEodSession('2026-11-09',Date.parse('2026-11-09T21:00:00.000Z')));
  assert.throws(()=>validateCompletedEodSession('2026-10-21',Date.parse('2026-10-20T23:20:00.000Z')));
  assert.throws(()=>validateCompletedEodSession('2026-10-18',Date.parse('2026-10-18T23:20:00.000Z')));
});
test('30m expiry and backwards clock stop before CAS; conflict and corrupt readback never become success',async()=>{
  await pipeline('2026-10-20T23:19:52.742Z',{elapsed:1800001});
  await pipeline('2026-10-20T23:19:52.742Z',{rollback:true});
  await pipeline('2026-10-20T23:19:52.742Z',{conflict:true});
  await pipeline('2026-10-20T23:19:52.742Z',{corruptReadback:true});
});

test('real producer and native CAS contracts survive slow preparation and one transient public GET',async()=>{
  await pipeline('2026-10-21T00:00:00.000Z',{preparationMs:45000,transientContext:true});
});
test('whole chain never writes after preparation denial, deadline, expiry or HK day rollover',async()=>{
  await pipeline('2026-10-21T00:00:00.000Z',{preparationFailure:true});
  await pipeline('2026-10-21T00:00:00.000Z',{preparationMs:60000});
  await pipeline('2026-10-21T00:00:00.000Z',{elapsed:1770000,preparationMs:31000});
  await pipeline('2026-10-21T15:59:04.000Z',{preparationMs:56000});
});

test('actual native canary generation drift stops the provider POST without a second CAS',async()=>{
  await pipeline('2026-10-21T00:00:00.000Z',{canaryChanged:true});
});
