// ALL responses/credentials/amounts are SYNTHETIC. Real fetch is forbidden.
import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {runPrivateActionPreviewOnce,privatePreviewOnceCli} from './action_preview_once.mjs';
import {RESOURCE,TOKEN_ENDPOINT} from './ib_mcp.mjs';
import {associationPolicyText} from '../../scripts/xuan-ib-account-association.mjs';
import {extractNightActionModel} from '../../scripts/xuan-ib-night-action-view.mjs';
const NOW=Date.parse('2026-10-15T05:00:00.000Z'),DATE='2026-10-14';
globalThis.fetch=()=>assert.fail('No real financial or network request');
const digest=v=>crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const blob=v=>crypto.createHash('sha1').update('blob '+Buffer.byteLength(v)+'\0').update(v).digest('hex');
const request=()=>({requestId:'11111111-2222-4333-8444-555555555555',dataDate:'2026-10-15',expiresAt:new Date(NOW+55000).toISOString()});
const env=()=>({CLOUD_RUN_JOB:'xuan-preopen-orders-probe',CLOUD_RUN_EXECUTION:'xuan-preopen-orders-probe-synthetic',CLOUD_RUN_TASK_INDEX:'0',CLOUD_RUN_TASK_ATTEMPT:'0',CLOUD_RUN_TASK_COUNT:'1'});
const order=()=>({order_id:777,order_status:'NEW',order_type:'LIMIT',side:'BUY',limit_price:'10',total_shares_qty:'10',cum_shares_qty:'4',remaining_shares_qty:'6',primary_description:'Buy 10 EXUS',secondary_description:'SYNTHETIC_INSTRUMENT',order_time:'2026-10-14T14:00:00Z'});
function policy(){return {schemaVersion:1,policyId:'ib-primary-7day-pilot-v1',accountAlias:'IB-HK',basis:'owner-attested-recurring-v1',status:'active',purpose:'xuan-ib-read-only-report',editions:['adhoc','am','pm'],publisher:'codex-verified-candidate-v1',validFrom:'2026-10-10T00:00:00.000Z',expiresAt:'2026-10-20T00:00:00.000Z'};}
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
    if(name.endsWith('/'+failUpload))return Response.json({},{status:500});
    const text=o.body.toString(),value=name.endsWith('.html')?text:JSON.parse(text);objects.set(name,value);events.push('saved-'+name.split('/').at(-1));
    return Response.json({name:uploadBad?'SYNTHETIC_WRONG_OBJECT':name,size:String(o.body.length),generation:String(objects.size)});
  };
  return {options:{request:request(),env:env(),now:()=>NOW,fetchImpl},objects,calls,events,credential,rotations:()=>rotations};
}
const count=(h,fragment)=>h.calls.filter(c=>c.url.includes(fragment)).length;
function report(h){const receipt=[...h.objects.entries()].find(([k])=>k.endsWith('/preview-receipt.json'))?.[1];return receipt?{receipt,html:h.objects.get(receipt.artifact.privateObject),model:extractNightActionModel(h.objects.get(receipt.artifact.privateObject))}:null;}
function safeOutput(r){const text=JSON.stringify(r);for(const secret of ['SYNTHETIC_ACCESS','SYNTHETIC_REFRESH','SYNTHETIC_NEXT_ACCESS','SYNTHETIC_NEXT_REFRESH','SYNTHETIC_GOOGLE_TOKEN','SYNTHETIC_GATEWAY_TOKEN','SYNTHETIC_PRIVATE_ERROR','SYNTHETIC_INSTRUMENT','EXUS'])assert.ok(!text.includes(secret));}

test('actual R3/R5/native private IO paths compose one private HTML in-process, with no extra IB or object reads',async()=>{
  const h=harness(),r=await runPrivateActionPreviewOnce(h.options);assert.equal(r.status,'generated');assert.equal(r.sharesightGets,2);safeOutput(r);
  assert.equal(count(h,RESOURCE),3);assert.equal(count(h,TOKEN_ENDPOINT),0);assert.equal(count(h,'/v1/performance'),2);assert.equal(h.objects.size,10);
  assert.ok(h.events.indexOf('gateway-credential')>h.events.indexOf('saved-receipt.json'));
  const {model,receipt,html}=report(h);assert.equal(model.cash.ib,1000);assert.equal(model.cash.noah,200);assert.equal(model.cash.orderReserve,60);assert.equal(model.cash.planning,1090);assert.equal(model.cash.call.status,'owner-declared');
  assert.equal(r.previewReceiptSha256,digest(receipt));assert.equal(r.reportSha256,digest(html));assert.equal(r.interactiveDelivery,'not-published');assert.equal(r.financialCompleteness,'not-asserted');
});
test('duplicate operation is stopped by the original immutable marker before credentials or a second source attempt',async()=>{
  const h=harness();await runPrivateActionPreviewOnce(h.options);const before=h.calls.length,ib=count(h,RESOURCE),ss=count(h,'/v1/performance'),r=await runPrivateActionPreviewOnce(h.options);
  assert.equal(r.status,'failed');assert.equal(r.code,'IB_DIAGNOSTIC_ATTEMPT_CONSUMED');assert.equal(r.upstreamAttempted,false);assert.equal(count(h,RESOURCE),ib);assert.equal(count(h,'/v1/performance'),ss);assert.ok(h.calls.length>before);
});
test('strict CLI/runtime/55-second reservation expiry rejects invalid and late starts before all IO',async()=>{
  for(const mutate of [o=>o.env.CLOUD_RUN_TASK_ATTEMPT='1',o=>o.env={},o=>o.request.expiresAt=new Date(NOW+55001).toISOString(),o=>o.now=()=>NOW+56000,o=>o.request.nonce='OLD_CONTEXT']){
    const h=harness();mutate(h.options);const r=await runPrivateActionPreviewOnce(h.options);assert.equal(r.status,'failed');assert.equal(h.calls.length,0);safeOutput(r);
  }
  assert.equal((await privatePreviewOnceCli(['--request',JSON.stringify(request()),'--run'])).code,'PRIVATE_PREVIEW_REQUEST_INVALID');
});
test('one original-client rotation persists through actual Secret Manager transport before source initialization',async()=>{
  const h=harness({expired:true}),r=await runPrivateActionPreviewOnce(h.options);assert.equal(r.status,'generated');assert.equal(r.ib.credentialPersistence,'saved');assert.equal(h.rotations(),1);assert.equal(count(h,TOKEN_ENDPOINT),1);assert.ok(h.events.indexOf('rotation-saved')<h.events.indexOf('initialize'));safeOutput(r);
});
test('confirmed IB auth/read failures preserve Sharesight cash/configuration and unknown orders, never fake a full recovery',async()=>{
  for(const options of [{expired:true,tokenStatus:400},{mcpStatus:401},{mcpStatus:503}]){
    const h=harness(options),r=await runPrivateActionPreviewOnce(h.options);assert.equal(r.status,'generated');assert.equal(r.ib.status,'failed');assert.equal(count(h,'/v1/performance'),2);safeOutput(r);
    const {model}=report(h);assert.equal(model.orders.status,'unknown');assert.equal(model.cash.orderReserve,null);assert.equal(model.cash.planning,null);assert.equal(model.cash.ib,1000);assert.equal(model.allocation.status,'ready');assert.equal(model.fieldErrors.orders,'ORDERS_SOURCE_UNAVAILABLE');
  }
});
test('Sharesight sibling failure and malformed order rows degrade only their own contributions',async()=>{
  const h=harness({ssFail:'NOAH-HK'}),r=await runPrivateActionPreviewOnce(h.options);assert.equal(r.status,'generated');assert.equal(r.sharesightGets,2);let m=report(h).model;assert.equal(m.cash.noah,null);assert.equal(m.cash.ib,1000);assert.equal(m.allocation.status,'ready');assert.equal(m.orders.status,'ready');safeOutput(r);
  const bad=harness({ordersRaw:{orders:[{}],complete:true}}),partial=await runPrivateActionPreviewOnce(bad.options);assert.equal(partial.status,'generated');m=report(bad).model;assert.equal(m.orders.status,'unknown');assert.equal(m.cash.ib,1000);assert.equal(m.allocation.status,'ready');
});
test('refresh response and confirmed persistence after source cutoff retain R3 finalization and start no late MCP call',async()=>{
  const h=harness({expired:true,tokenDelay:100,saveDelay:30});h.options.limits={sourceMs:60,finalizeMs:1000};
  const r=await runPrivateActionPreviewOnce(h.options);assert.equal(r.status,'generated');assert.equal(r.ib.status,'failed');assert.equal(r.ib.credentialPersistence,'saved');assert.equal(h.rotations(),1);assert.equal(count(h,RESOURCE),0);assert.equal(count(h,'/v1/performance'),2);safeOutput(r);
});
test('unknown token exchange or persistence stops before all further financial sources without retry',async()=>{
  for(const options of [{expired:true,saveStatus:500},{expired:true,tokenStatus:500}]){
    const h=harness(options),r=await runPrivateActionPreviewOnce(h.options);assert.equal(r.status,'failed');assert.equal(count(h,'/v1/performance'),0);assert.equal(count(h,RESOURCE),0);assert.equal(count(h,TOKEN_ENDPOINT),1);assert.ok(h.rotations()<=1);assert.equal(report(h),null);safeOutput(r);
  }
});
test('hung credential save obeys the native R3 finalization deadline, not the longer preview task',async()=>{
  const h=harness({expired:true,saveHang:true});h.options.limits={sourceMs:80,finalizeMs:80};const started=performance.now(),r=await runPrivateActionPreviewOnce(h.options);
  assert.equal(r.status,'failed');assert.equal(r.code,'IB_TOKEN_ROTATION_OUTCOME_UNKNOWN');assert.equal(count(h,'/v1/performance'),0);assert.equal(h.rotations(),1);assert.ok(performance.now()-started<2000);safeOutput(r);
});
test('whole-wrapper account mismatch and duplicate-key loss remain fatal through the observer',async()=>{
  for(const mcpEnvelope of [id=>JSON.stringify({jsonrpc:'2.0',id,_meta:{account_id:'SYNTHETIC_WRONG'},result:{structuredContent:{orders:[],complete:true}}}),id=>' {"jsonrpc":"2.0","id":'+id+',"result":{"structuredContent":{"orders":[],"account_id":"SYNTHETIC_WRONG","account_\\u0069d":null}}}']){
    const h=harness({mcpEnvelope}),r=await runPrivateActionPreviewOnce(h.options);assert.equal(r.status,'failed');assert.equal(count(h,'/v1/performance'),0);assert.equal(report(h),null);safeOutput(r);
  }
});
test('composition timeout never reuses IB or retries Sharesight and cannot claim a completed private pointer',async()=>{
  const h=harness({ssHang:true});h.options.limits={compositionMs:50};const r=await runPrivateActionPreviewOnce(h.options);assert.equal(r.status,'failed');assert.equal(r.code,'PRIVATE_PREVIEW_TIMEOUT');assert.equal(count(h,RESOURCE),3);assert.equal(count(h,'/v1/performance'),2);assert.equal(report(h),null);safeOutput(r);
});
test('changed association or unconfirmed upload metadata prevents composition or discoverable success',async()=>{
  for(const options of [{associationChanges:true},{uploadBad:true}]){const h=harness(options),r=await runPrivateActionPreviewOnce(h.options);assert.equal(r.status,'failed');assert.equal(count(h,'/v1/performance'),0);assert.equal(report(h),null);safeOutput(r);}
});
test('a receipt-copy upload failure does not retry sources or claim successful discovery',async()=>{
  const h=harness({failUpload:'preview-receipt.json'}),r=await runPrivateActionPreviewOnce(h.options);assert.equal(r.status,'failed');assert.equal(count(h,RESOURCE),3);assert.equal(count(h,'/v1/performance'),2);assert.equal(report(h),null);safeOutput(r);
});
test('crossing request expiry during a refresh cannot cancel necessary persistence or admit a new MCP call',async()=>{
  let clock=NOW;const h=harness({expired:true,clockHook:u=>{if(u===TOKEN_ENDPOINT)clock=NOW+56000;}});h.options.now=()=>clock;
  const r=await runPrivateActionPreviewOnce(h.options);assert.equal(h.rotations(),1);assert.equal(count(h,RESOURCE),0);assert.equal(r.ib.credentialPersistence,'saved');assert.equal(r.ib.status,'failed');safeOutput(r);
  // Source transport is closed. A truthful partial composition may proceed,
  // but it never turns this attempt into a recovered IB/orders source.
  assert.equal(r.status,'generated');assert.equal(report(h).model.orders.status,'unknown');
});
