import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectIbSchema} from './schema_probe.mjs';
import {IbReadSession,RESOURCE} from './ib_mcp.mjs';
const now=()=>Date.parse('2026-10-05T06:00:00Z');
const credential=()=>({client_id:'test-client',access_token:'test-access',refresh_token:'test-refresh',
  token_type:'Bearer',scope:'mcp.read',resource:RESOURCE,expires_at:now()+3600000});
function harness(pages){
  const calls=[],saved=[];let page=0;
  const io={ibStore:{load:async()=>credential(),save:async()=>{throw Error('must not rotate');}},
    loadGatewayToken:async()=>{throw Error('must not read');},savePrivate:async(name,value)=>{saved.push({name,value});return{sha256:'a'.repeat(64),generation:'1'};}};
  const fetchImpl=async(url,options)=>{
    assert.equal(url,RESOURCE);const body=JSON.parse(options.body);calls.push(body);
    assert.ok(['initialize','notifications/initialized','tools/list'].includes(body.method));
    if(body.method==='notifications/initialized')return new Response(null,{status:202});
    const result=body.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}}}:pages[page++];
    return Response.json({jsonrpc:'2.0',id:body.id,result});
  };
  return{io,fetchImpl,now,calls,saved};
}
test('bounded schema pagination invokes no financial tools or credential mutation',async()=>{
  const h=harness([{tools:[{name:'get_account_positions',description:'All open positions',inputSchema:{properties:{page:{type:'integer'}}}}],nextCursor:'next'},
    {tools:[{name:'get_trades',inputSchema:{properties:{from_date:{type:'string'},to_date:{type:'string'}}}}]}]);
  const result=await inspectIbSchema(h);
  assert.deepEqual(h.calls.map(c=>c.method),['initialize','notifications/initialized','tools/list','tools/list']);
  assert.equal(h.calls.at(-1).params.cursor,'next');assert.equal(result.financialReads,0);
  assert.equal(result.relevantTools[0].declaresAllPositions,true);assert.equal(h.saved.length,2);
  assert.ok(!JSON.stringify(h.saved).includes('test-access'));assert.ok(!JSON.stringify(result).includes('test-refresh'));
});
test('schema session forbids every financial tool even if otherwise read-only',async()=>{
  let called=false;const s=new IbReadSession(credential(),{schemaOnly:true,fetchImpl:async()=>{called=true;}});s.initialized=true;
  await assert.rejects(s.read('get_account_summary'),/METHOD_FORBIDDEN/);assert.equal(called,false);
});
test('expired credential stops before HTTP without refresh or secret version write',async()=>{
  const h=harness([]);h.io.ibStore.load=async()=>({...credential(),expires_at:now()});
  await assert.rejects(inspectIbSchema(h),/EXPIRED_NO_REFRESH/);assert.equal(h.calls.length,0);assert.equal(h.saved.length,0);
});
test('repeated cursor, duplicate names and pagination budget never prove complete discovery',async()=>{
  for(const pages of [[{tools:[],nextCursor:'same'},{tools:[],nextCursor:'same'}],
    [{tools:[{name:'get_trades'},{name:'get_trades'}]}],Array.from({length:8},(_,i)=>({tools:[],nextCursor:String(i)}))]){
    const h=harness(pages);await assert.rejects(inspectIbSchema(h));assert.equal(h.saved.length,0);
  }
});
