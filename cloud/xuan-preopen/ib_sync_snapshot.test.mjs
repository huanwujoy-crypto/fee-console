import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {runCloudIbSnapshot,ibSnapshotCli} from './ib_sync_snapshot.mjs';
import {assessCapture} from './ib_sync_snapshot_capture.mjs';
import {RESOURCE,TOKEN_ENDPOINT} from './ib_mcp.mjs';
import {associationPolicyBlob} from '../../scripts/xuan-ib-account-association.mjs';
const NOW=Date.parse('2026-10-22T04:00:00.000Z'),SECRET='projects/family-portfolio-gateway/secrets/xuan-preopen-ib-mcp';
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN');};
function harness(){
 const objects=new Map(),calls=[],events=[];
 const credential={client_id:'SYNTHETIC_CLIENT',access_token:'SYNTHETIC_ACCESS_CANARY',refresh_token:'SYNTHETIC_REFRESH_CANARY',token_type:'Bearer',scope:'mcp.read',resource:RESOURCE,expires_at:NOW+3600000};
 const request={requestId:'11111111-2222-4333-8444-555555555555',dataDate:'2026-10-22',expiresAt:'2026-10-22T04:10:00.000Z',credentialBinding:{clientId:credential.client_id,version:'15'}};
 const env={CLOUD_RUN_JOB:'ib-daily-snapshot',CLOUD_RUN_EXECUTION:'ib-daily-snapshot-synthetic',CLOUD_RUN_TASK_INDEX:'0',CLOUD_RUN_TASK_ATTEMPT:'0',CLOUD_RUN_TASK_COUNT:'1'};
 const policy={schemaVersion:1,policyId:'ib-primary-7day-pilot-v1',accountAlias:'IB-HK',basis:'owner-attested-recurring-v1',status:'active',purpose:'xuan-ib-read-only-report',editions:['adhoc','am','pm'],publisher:'codex-verified-candidate-v1',validFrom:'2026-10-20T00:00:00.000Z',expiresAt:'2026-10-27T00:00:00.000Z'};
 // Exact observed provider shape; all identifiers and financial values are synthetic.
 const raw={get_account_positions:{positions:[{contract_id:123,contract_description:'SYNTHETIC',currency:'USD',position:7,average_price:1,market_price:2,market_value:14,unrealized_pnl:7}]},
  get_account_balances:{balances:[
   {currency:'USD',cash_balance:10,settled_cash:3,exchange_rate:1,net_liquidation_value:24,realized_pnl:0,stock_market_value:14,unrealized_pnl:7},
   {currency:'HKD',cash_balance:-8,settled_cash:-9,exchange_rate:0.125,net_liquidation_value:-8,realized_pnl:0,stock_market_value:0,unrealized_pnl:0},
   {currency:'BASE',cash_balance:9,settled_cash:1.875,exchange_rate:1,net_liquidation_value:23,realized_pnl:0,stock_market_value:14,unrealized_pnl:7}]}};
 const io={ibStore:{loadBound:async()=>{events.push('load');return {versionName:SECRET+'/versions/15',credential};},save:async c=>{events.push('save');assert.equal(c.client_id,credential.client_id);return {name:SECRET+'/versions/16',state:'ENABLED'};}},savePrivate:async(name,value)=>{if(objects.has(name))throw Error('CLOUD_HTTP_412');objects.set(name,structuredClone(value));return {sha256:hash(value),generation:'123'};}};
 const fetchImpl=async(url,o)=>{calls.push(String(url));o.signal.throwIfAborted();
  if(url===TOKEN_ENDPOINT){events.push('refresh');return Response.json({access_token:'SYNTHETIC_NEW_ACCESS',refresh_token:'SYNTHETIC_NEW_REFRESH',token_type:'Bearer',scope:'mcp.read',expires_in:3600});}
  assert.equal(url,RESOURCE);const q=JSON.parse(o.body);events.push(q.method==='tools/call'?q.params.name:q.method);
  if(q.method==='initialize')return Response.json({jsonrpc:'2.0',id:q.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}}}});
  if(q.method==='notifications/initialized')return new Response(null,{status:202});
  assert.deepEqual(q.params.arguments,{});assert.ok(Object.hasOwn(raw,q.params.name));
  return Response.json({jsonrpc:'2.0',id:q.id,result:{structuredContent:raw[q.params.name]}});
 };
 return {options:{request,env,now:()=>NOW,fetchImpl,io,loadContext:async()=>({association:{policy,policyBlob:associationPolicyBlob(policy),policyCommit:'a'.repeat(40),checkedAt:new Date(NOW).toISOString()}}),expectedAccount:'SYNTHETIC_ACCOUNT'},credential,objects,calls,events,raw};
}
function noLeaks(h,r){const text=JSON.stringify(r);for(const x of ['SYNTHETIC_ACCOUNT','SYNTHETIC_ACCESS_CANARY','SYNTHETIC_REFRESH_CANARY','cash_balance','contract_id'])assert.ok(!text.includes(x));for(const v of h.objects.values())for(const x of ['SYNTHETIC_ACCESS_CANARY','SYNTHETIC_REFRESH_CANARY','SYNTHETIC_NEW_ACCESS','SYNTHETIC_NEW_REFRESH'])assert.ok(!JSON.stringify(v).includes(x));}
test('daily source entry refuses the action orders job before any side effect',async()=>{const h=harness();h.options.env.CLOUD_RUN_JOB='xuan-preopen-orders-probe';h.options.env.CLOUD_RUN_EXECUTION='xuan-preopen-orders-probe-synthetic';const r=await runCloudIbSnapshot(h.options);assert.equal(r.status,'failed');assert.equal(r.upstreamAttempted,false);assert.equal(h.calls.length,0);assert.equal(h.events.length,0);assert.equal(h.objects.size,0);});
test('independent entry initializes once then positions and balances once, with three private objects',async()=>{const h=harness(),r=await runCloudIbSnapshot(h.options);assert.equal(r.status,'passed');assert.equal(r.comparisonReady,true);assert.deepEqual(h.events,['load','initialize','notifications/initialized','get_account_positions','get_account_balances']);assert.equal(h.objects.size,3);assert.equal(r.positionsCalls,1);assert.equal(r.balancesCalls,1);noLeaks(h,r);});
test('official array-only response needs no invented coverage, basis or source-time fields',async()=>{const h=harness();const r=await runCloudIbSnapshot(h.options);assert.equal(r.status,'passed');assert.equal(r.comparisonReady,true);assert.equal(h.objects.size,3);const saved=[...h.objects.values()].find(x=>x.capture);assert.equal(saved.capture.sources.length,2);assert.equal(saved.assessment.positionsComplete,true);assert.equal(saved.assessment.cashBasisVerified,true);assert.equal(saved.assessment.providerAsOf,null);assert.equal(saved.assessment.contractSha256,'475bef6cf463c7b11cb94a48c9a5aca66f8aa972d8221f0000c480a84444f22d');noLeaks(h,r);});
test('pagination, absent currency cash or contradictory cash basis stop comparison',async()=>{for(const mutate of [h=>h.raw.get_account_positions.next_cursor='NEXT',h=>h.raw.get_account_balances.balances=[{currency:'BASE',cash_balance:'10'}],h=>delete h.raw.get_account_balances.balances[0].cash_balance,h=>h.raw.get_account_balances.cash_basis='settled_cash']){const h=harness();mutate(h);const r=await runCloudIbSnapshot(h.options);assert.equal(r.status,'incomplete');assert.equal(h.calls.length,4);}});
test('duplicate ID is blocked before credential load or any second broker request',async()=>{const h=harness();await runCloudIbSnapshot(h.options);const before=h.calls.length;const r=await runCloudIbSnapshot(h.options);assert.equal(r.status,'failed');assert.equal(h.calls.length,before);assert.equal(h.events.filter(x=>x==='load').length,1);});
test('one ordinary rotation is persisted in the same store before MCP requests',async()=>{const h=harness();h.credential.expires_at=NOW;const r=await runCloudIbSnapshot(h.options);assert.equal(r.status,'passed');assert.deepEqual(h.events.slice(0,4),['load','refresh','save','initialize']);assert.equal(h.calls.filter(x=>x===TOKEN_ENDPOINT).length,1);noLeaks(h,r);});
test('rotation save failure stops before the handshake and never falls back to the old token',async()=>{const h=harness();h.credential.expires_at=NOW;h.options.io.ibStore.save=async()=>{throw Error('CLOUD_HTTP_403');};const r=await runCloudIbSnapshot(h.options);assert.equal(r.status,'failed');assert.equal(h.calls.filter(x=>x===RESOURCE).length,0);assert.equal(h.objects.size,2);noLeaks(h,r);});
test('contradictory account evidence cannot save a source snapshot',async()=>{const h=harness();h.raw.get_account_balances.account_id='OTHER_ACCOUNT';const r=await runCloudIbSnapshot(h.options);assert.equal(r.status,'failed');assert.equal(h.objects.size,2);noLeaks(h,r);});
test('no orders/summary/catalog or duplicate tool can be dispatched by capture injection',async()=>{for(const name of ['get_account_orders','get_account_summary','tools/list']){const h=harness();h.options.capture=async(store,o)=>{await store.load();await o.fetchImpl(RESOURCE,{method:'POST',body:JSON.stringify({method:'tools/call',params:{name,arguments:{}}})});};const r=await runCloudIbSnapshot(h.options);assert.equal(r.status,'failed');assert.equal(h.calls.length,0);}});
test('wrong CLI, duplicate JSON or task retry cannot initiate IO',async()=>{const h=harness();for(const args of [['--orders-request',JSON.stringify(h.options.request)],['--ib-sync-snapshot-request','{"requestId":"x","requestId":"y"}']]){const r=await ibSnapshotCli(args,h.options);assert.equal(r.status,'failed');}h.options.env.CLOUD_RUN_TASK_ATTEMPT='1';assert.equal((await runCloudIbSnapshot(h.options)).status,'failed');assert.equal(h.calls.length,0);});

test('a credential value echoed under an innocuous field cannot be persisted',async()=>{const h=harness();h.raw.get_account_balances.note=h.credential.access_token;const r=await runCloudIbSnapshot(h.options);assert.equal(r.status,'failed');assert.equal(h.objects.size,2);noLeaks(h,r);});
test('JSON escaping cannot conceal a credential echoed in a response',async()=>{const h=harness();h.credential.access_token='SYNTHETIC_"QUOTED\\TOKEN';h.raw.get_account_balances.note=h.credential.access_token;const r=await runCloudIbSnapshot(h.options);assert.equal(r.status,'failed');assert.equal(h.objects.size,2);for(const object of h.objects.values())assert.ok(!JSON.stringify(object).includes(JSON.stringify(h.credential.access_token).slice(1,-1)));});

test('coverage assertions must agree and explicit next page markers stop comparison',async()=>{
 for(const mutate of [p=>p.total_count=2,p=>{p.complete=false;p.total_count=1;},p=>p.total_count='1',
   ...['next','next_page','nextPage'].map(key=>p=>p[key]='PENDING')]){
  const h=harness();mutate(h.raw.get_account_positions);const r=await runCloudIbSnapshot(h.options);
  assert.equal(r.status,'incomplete');assert.equal(h.calls.length,4);
 }
});
test('different source times are retained and malformed provided dates cannot disappear',()=>{
 const h=harness(),capture={source:'IB_MCP',sources:[{sourceKey:'ib.positions',raw:h.raw.get_account_positions},{sourceKey:'ib.balances',raw:h.raw.get_account_balances}]};
 h.raw.get_account_positions.as_of='2026-10-22T03:59:59Z';h.raw.get_account_balances.as_of='2026-10-22T04:00:00Z';
 const a=assessCapture(capture);assert.equal(a.comparisonReady,true);assert.equal(a.providerAsOf,null);
 assert.deepEqual(a.providerAsOfBySource,{positions:'2026-10-22T03:59:59.000Z',balances:'2026-10-22T04:00:00.000Z'});
 for(const value of ['not-a-date','2026-02-30T04:00:00Z','2026-10-22']){
  h.raw.get_account_balances.as_of=value;const b=assessCapture(capture);assert.equal(b.providerTimesValid,false);assert.equal(b.comparisonReady,false);
 }
});

test('empty positions is a valid all-cash book; malformed or duplicate rows fail',()=>{
 const capture=h=>({source:'IB_MCP',sources:[{sourceKey:'ib.positions',raw:h.raw.get_account_positions},{sourceKey:'ib.balances',raw:h.raw.get_account_balances}]});
 const h=harness();h.raw.get_account_positions.positions=[];assert.equal(assessCapture(capture(h)).comparisonReady,true);
 for(const mutate of [h=>delete h.raw.get_account_positions.positions,
  h=>h.raw.get_account_positions.positions.push({...h.raw.get_account_positions.positions[0]}),
  h=>h.raw.get_account_positions.positions[0].position=true,
  h=>h.raw.get_account_balances.balances.push({...h.raw.get_account_balances.balances[0]}),
  h=>h.raw.get_account_balances.balances[0].cash_balance=NaN,
  h=>h.raw.get_account_balances.error={code:'PARTIAL'},
  h=>h.raw.get_account_positions.isError=true]){
  const x=harness();mutate(x);assert.equal(assessCapture(capture(x)).comparisonReady,false);
 }
});
test('BASE is not a currency; negative and zero native cash are preserved',()=>{
 const h=harness();h.raw.get_account_balances.balances[0].cash_balance=0;
 const c={source:'IB_MCP',sources:[{sourceKey:'ib.positions',raw:h.raw.get_account_positions},{sourceKey:'ib.balances',raw:h.raw.get_account_balances}]};
 const r=assessCapture(c);assert.equal(r.comparisonReady,true);assert.equal(r.baseAggregateExcluded,true);assert.equal(r.cashField,'cash_balance');
 assert.equal(h.raw.get_account_balances.balances[1].cash_balance,-8);
 h.raw.get_account_positions.positions[0].asset_class='STK';assert.equal(assessCapture(c).comparisonReady,true);
});

test('daily bounded store preserves shared lease capability through credential loading',async()=>{
 const h=harness();let active=false,entered=0;const original=h.options.io.ibStore.loadBound;
 h.options.io.ibStore.requiresCredentialLease=true;
 h.options.io.ibStore.withCredentialLease=async callback=>{entered++;active=true;try{return await callback({beforeRefresh:()=>assert.fail('No refresh due')});}finally{active=false;}};
 h.options.io.ibStore.loadBound=async binding=>{assert.equal(active,true);return original(binding);};
 assert.equal((await runCloudIbSnapshot(h.options)).status,'passed');assert.equal(entered,1);assert.equal(active,false);
});
test('busy shared credential lock stops daily source before Secret or broker read',async()=>{
 const h=harness();h.options.io.ibStore.requiresCredentialLease=true;
 h.options.io.ibStore.withCredentialLease=async()=>{throw Error('IB_CREDENTIAL_LEASE_BUSY');};
 const r=await runCloudIbSnapshot(h.options);assert.equal(r.status,'failed');assert.equal(h.events.length,0);assert.equal(h.calls.length,0);assert.equal(h.objects.size,2);
});
