import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SharesightCloudReader,CLOUD_ACCOUNTS,selectBenchmark} from './fee-cloud-source.mjs';
import {SharesightIbManagerReader,ibBaselineBusinessHash} from './ib-manager-source.mjs';

// All responses are synthetic; no real transport, account data or credentials.
const D='2026-09-23',TOKEN='capture-test-access-token-not-real';
const CLIENT='capture-test-client-not-real',SECRET='capture-test-secret-not-real';
const benchmark=()=>selectBenchmark({v:1,benchmarks:{
  spy:{symbol:'SPY',currency:'USD',exchange:'NYSEArca',series:[{d:'2026-09-22',p:700},{d:D,p:701}]},
  qqq:{symbol:'QQQ',currency:'USD',exchange:'NasdaqGS',series:[{d:'2026-09-22',p:600},{d:D,p:602}]}
}},D);
const sha=body=>createHash('sha256').update(body).digest('hex');
function response(url,body){const r=new Response(body,{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;}
export function cloudCaptureFixture({mutate=()=>{},beforeResponse=async()=>{}}={}){
  let attempt=0;const calls=[];
  const fetchImpl=async(url,init)=>{
    const u=new URL(url),p=u.pathname,q=u.searchParams;calls.push({path:p,query:Object.fromEntries(q),method:init.method});
    let data;
    if(p==='/oauth2/token'){attempt++;assert.equal(init.method,'POST');data={access_token:TOKEN,token_type:'bearer'};}
    else{
      assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,'Bearer '+TOKEN);
      if(p==='/api/v2/portfolios.json')data={portfolios:Object.values(CLOUD_ACCOUNTS).map(x=>({id:x.portfolioId,name:x.name,currency_code:'USD'}))};
      else{
        const account=p.includes('/936249/')||p.includes('/142251/')?'schwab':'webull';
        const expected=CLOUD_ACCOUNTS[account],portfolio={id:expected.portfolioId,name:expected.name};
        const cashId=account==='schwab'?142251:90250,holdingId=account==='schwab'?2:4;
        const instrument={id:1000+holdingId,code:account==='schwab'?'BRK/B':'GOOG',market_code:'NYSE',currency_code:'USD'};
        if(p.endsWith('/performance'))data={report:{portfolio_id:portfolio.id,start_date:D,end_date:D,include_sales:false,portfolio_tz_name:'America/New_York',currency:{code:'USD'},value:1000,
          holdings:[{id:holdingId,quantity:1,value:600,valid_position:true,instrument,instrument_currency:{code:'USD'},portfolio}],
          cash_accounts:[{id:cashId,value:400,currency:{code:'USD'},portfolio}]}};
        else if(p.endsWith('/holdings'))data={holdings:[{id:holdingId,valid_position:true,inception_date:'2026-09-22',instrument,instrument_currency:{code:'USD'},portfolio}]};
        else if(p.endsWith('/cash_accounts.json'))data={cash_accounts:[{id:cashId,portfolio_id:portfolio.id,currency:'USD',portfolio_currency:'USD',date:D,balance:400,balance_in_portfolio_currency:400}]};
        else if(p.endsWith('/cash_account_transactions.json'))data={cash_account_transactions:[]};
        else if(p.endsWith('/trades.json'))data={trades:[]};
        else assert.fail('unexpected synthetic source route');
      }
    }
    const ctx={p,q,attempt,data};await beforeResponse(ctx);const body=mutate(JSON.stringify(data),ctx)??JSON.stringify(data);
    return response(url,body);
  };
  return {calls,reader:new SharesightCloudReader({clientId:CLIENT,clientSecret:SECRET,fetchImpl,sourceMode:'sharesight-reference'})};
}
const baseline={from:'2026-08-31',asOf:'2026-09-02'};
const ibBusiness=()=>({points:[{d:'2026-08-31',tot:100},{d:'2026-09-01',tot:150},{d:'2026-09-02',tot:135}],openT:100,from:baseline.from,to:baseline.asOf,days:3,flowByDate:{'2026-09-01':50},rate:0,cr:0,cumBefore:0,hwmBefore:0});
export function ibCaptureFixture({mutate=()=>{}}={}){
  let attempt=0;const calls=[];
  const fetchImpl=async(url,init)=>{
    const u=new URL(url),p=u.pathname,q=u.searchParams;calls.push({path:p,query:Object.fromEntries(q),method:init.method});let data;
    if(p==='/oauth2/token'){attempt++;data={access_token:TOKEN,token_type:'bearer'};}
    else{
      assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,'Bearer '+TOKEN);
      if(p==='/api/v2/portfolios.json')data={portfolios:[{id:1,name:'IB-HK',currency_code:'USD'}]};
      else if(p==='/api/v3/portfolios/1/holdings')data={holdings:[{id:2,valid_position:true,portfolio:{id:1,name:'IB-HK'}}]};
      else if(p==='/api/v3/portfolios/1/performance'){
        const d=q.get('end_date'),value=d<'2026-09-02'?100:85,cash=d<'2026-09-01'?0:50;
        data={report:{portfolio_id:1,start_date:d,end_date:d,currency:{code:'USD'},portfolio_tz_name:'America/New_York',include_sales:false,value:value+cash,
          holdings:[{id:2,value,quantity:1,valid_position:true,portfolio:{id:1,name:'IB-HK'},instrument_currency:{code:'USD'},instrument:{id:8,code:'SYNTH',market_code:'NYSE',currency_code:'USD'}}],
          cash_accounts:[{id:3,value:cash,currency:{code:'USD'},portfolio:{id:1,name:'IB-HK'}}]}};
      }else if(p==='/api/v2/portfolios/1/cash_accounts.json')data={cash_accounts:[{id:3,portfolio_id:1,portfolio_currency:'USD',currency:'USD',date:q.get('date'),balance:50,balance_in_portfolio_currency:50}]};
      else if(p==='/api/v3/portfolios/1/trades.json')data={trades:[]};
      else if(p==='/api/v2/cash_accounts/3/cash_account_transactions.json')data={cash_account_transactions:[{id:4,cash_account_id:3,date_time:'2026-09-01T12:00:00Z',amount:50,balance:50,cash_account_transaction_type:{name:'DEPOSIT'},description:'Owner cash contribution'}]};
      else assert.fail('unexpected synthetic IB route');
    }
    return response(url,mutate(JSON.stringify(data),{p,q,attempt,data})??JSON.stringify(data));
  };
  return {calls,args:{targetDate:baseline.asOf,expectedBaselineHash:ibBaselineBusinessHash(ibBusiness()),baseline:{...baseline}},reader:new SharesightIbManagerReader({clientId:CLIENT,clientSecret:SECRET,fetchImpl})};
}
function verifyEvidence(reader,result){
  assert.equal(reader.verifyCapturedRead(result),true);assert.equal(reader.verifyCapturedRead(structuredClone(result)),false);
  assert.equal(reader.verifyCapturedRead(null),false);assert.equal(reader.verifyCapturedRead(new Proxy(result,{})),false);
  const text=JSON.stringify(result.evidence);
  for(const secret of [TOKEN,CLIENT,SECRET,'Authorization','grant_type','access_token'])assert.equal(text.includes(secret),false);
  assert.equal(result.evidence.schema,'fee-console.sharesight-capture.v1');assert.equal(result.evidence.provider,'Sharesight');
  assert.deepEqual(result.evidence.captures.map(x=>x.attempt),[1,2]);
  assert.equal(result.evidence.captures[0].sha256,result.evidence.captures[1].sha256);
  assert.equal(result.evidence.sourceSha256,result.evidence.captures[0].sha256);
  for(const batch of result.evidence.captures){assert.ok(batch.records.length);for(const r of batch.records){
    assert.equal(r.method,'GET');assert.ok(r.path.startsWith('/api/'));assert.equal(r.path.includes('oauth'),false);
    assert.equal(r.sha256,sha(r.body));assert.ok(Object.isFrozen(r.query));assert.ok(Object.isFrozen(r));assert.doesNotThrow(()=>JSON.parse(r.body));
  }}
  assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.input));assert.ok(Object.isFrozen(result.evidence.captures));
  assert.throws(()=>{result.evidence.captures[0].records[0].body='{}';},TypeError);
}
test('cloud capture reuses original validation, binds exact GET/raw bytes and is immutable',async()=>{
  const fixture=cloudCaptureFixture({mutate:(body,{p})=>p.endsWith('/performance')?body.replace('"quantity":1','"quantity":1.0000000000000001'):body});
  const original=await cloudCaptureFixture({mutate:(body,{p})=>p.endsWith('/performance')?body.replace('"quantity":1','"quantity":1.0000000000000001'):body}).reader.readStable(D,benchmark());
  const result=await fixture.reader.readStableWithEvidence(D,benchmark());verifyEvidence(fixture.reader,result);assert.deepEqual(result.input,original);
  const rows=result.evidence.captures[0].records;
  assert.ok(rows.some(r=>r.body.includes('"quantity":1.0000000000000001')));
  assert.deepEqual(rows.find(r=>r.path.endsWith('/cash_account_transactions.json')).query,{from:D,to:D});
  assert.equal(fixture.calls.filter(c=>c.method==='POST').length,2);
  assert.equal(cloudCaptureFixture().reader.verifyCapturedRead(result),false);
});
test('IB capture preserves historical queries and all original source validators',async()=>{
  const f=ibCaptureFixture(),old=ibCaptureFixture(),result=await f.reader.readStableWithEvidence(f.args);
  verifyEvidence(f.reader,result);assert.deepEqual(result.input,await old.reader.readStable(old.args));
  const records=result.evidence.captures[0].records;
  assert.ok(records.some(r=>r.path.endsWith('/performance')&&r.query.start_date==='2026-08-30'));
  assert.deepEqual(records.find(r=>r.path.endsWith('/cash_account_transactions.json')).query,{from:'2026-08-31',to:'2026-09-02'});
  assert.equal(ibCaptureFixture().reader.verifyCapturedRead(result),false);
});
test('same-instance consumption binds all original business arguments and consumes once without IO',async()=>{
  const f=cloudCaptureFixture(),b=benchmark(),r=await f.reader.readStableWithEvidence(D,b),calls=f.calls.length;
  assert.throws(()=>f.reader.consumeCapturedRead(r,D,{...b,spy:b.spy+1}),/^Error: FEE_CLOUD_CONFIG$/);
  const oldMode=f.reader.sourceMode;f.reader.sourceMode='legacy-reconstruction';assert.throws(()=>f.reader.consumeCapturedRead(r,D,b),/^Error: FEE_CLOUD_CONFIG$/);f.reader.sourceMode=oldMode;
  assert.equal(f.reader.consumeCapturedRead(r,D,b),r.input);assert.throws(()=>f.reader.consumeCapturedRead(r,D,b),/^Error: FEE_CLOUD_CONFIG$/);assert.equal(f.calls.length,calls);
  assert.equal(f.reader.verifyCapturedRead(r),true);
  const i=ibCaptureFixture(),ir=await i.reader.readStableWithEvidence(i.args),count=i.calls.length;
  for(const extra of [{targetDate:'2026-09-03'},{expectedBaselineHash:'f'.repeat(64)},{checkpoint:{}},{ownerBaseline:{}},{bootstrapCoverage:{}}])assert.throws(()=>i.reader.consumeCapturedRead(ir,{...i.args,...extra}),/^Error: IB_SOURCE_STATE$/);
  assert.equal(i.reader.consumeCapturedRead(ir,{...i.args,checkpoint:null,ownerBaseline:null,bootstrapCoverage:null}),ir.input);
  assert.throws(()=>i.reader.consumeCapturedRead(ir,i.args),/^Error: IB_SOURCE_STATE$/);assert.equal(i.calls.length,count);
});
test('capture rejects unsafe arguments without executing caller accessors or transport',async()=>{
  let calls=0;const f=cloudCaptureFixture(),b=benchmark();Object.defineProperty(b,'private',{enumerable:true,get(){calls++;return SECRET;}});
  await assert.rejects(f.reader.readStableWithEvidence(D,b),/^Error: FEE_CLOUD_CONFIG$/);assert.equal(calls,0);assert.equal(f.calls.length,0);
  const i=ibCaptureFixture();await assert.rejects(i.reader.readStableWithEvidence(new Proxy(i.args,{get(){calls++;return SECRET;}})),/^Error: IB_SOURCE_STATE$/);assert.equal(calls,0);assert.equal(i.calls.length,0);
});
test('raw changes discarded by normalization still reject capture; old stable semantics remain unchanged',async()=>{
  const mutate=(body,{p,attempt})=>p.endsWith('/performance')&&attempt===2?body+' ':body;
  await cloudCaptureFixture({mutate}).reader.readStable(D,benchmark());
  await assert.rejects(cloudCaptureFixture({mutate}).reader.readStableWithEvidence(D,benchmark()),/UNSTABLE/);
  const old=ibCaptureFixture({mutate});await old.reader.readStable(old.args);
  const current=ibCaptureFixture({mutate});await assert.rejects(current.reader.readStableWithEvidence(current.args),/UNSTABLE/);
});
test('incomplete, invalid, credential-bearing or failed second reads never deliver evidence',async t=>{
  for(const kind of ['incomplete','bad-identity','token','escaped-token','secret','invalid-utf8','second-failure'])await t.test(kind,async()=>{
    const mutate=(body,{p,attempt})=>{
      if(p==='/oauth2/token'||!p.endsWith('/performance'))return body;
      if(kind==='incomplete')return body.replace('{','{"has_more":true,');
      if(kind==='bad-identity')return body.replace(/"portfolio_id":\d+/, '"portfolio_id":999');
      if(kind==='token')return body.replace('{','{"canary":'+JSON.stringify(TOKEN)+',');
      if(kind==='escaped-token')return body.replace('{','{"canary":"'+TOKEN.replaceAll('a','\\u0061')+'",');
      if(kind==='secret')return body.replace('{','{"canary":'+JSON.stringify(SECRET)+',');
      if(kind==='invalid-utf8')return Buffer.from([0xc3,0x28]);
      if(kind==='second-failure'&&attempt===2)throw Error('PRIVATE_SOURCE');
      return body;
    };
    for(const f of [cloudCaptureFixture({mutate}),ibCaptureFixture({mutate})]){
      let delivered=false;await assert.rejects((f.args?f.reader.readStableWithEvidence(f.args):f.reader.readStableWithEvidence(D,benchmark())).then(x=>{delivered=true;return x;}),e=>{assert.equal(e.message.includes(TOKEN)||e.message.includes(SECRET)||e.message.includes('PRIVATE_SOURCE'),false);return true;});assert.equal(delivered,false);
    }
  });
});
test('overlapping read on capture instance is rejected without issuing another source request',async()=>{
  let resume,entered;const pending=new Promise(r=>{entered=r;}),blocked=new Promise(r=>{resume=r;});
  const f=cloudCaptureFixture({beforeResponse:async({p,attempt})=>{if(p==='/api/v2/portfolios.json'&&attempt===1){entered();await blocked;}}});
  const work=f.reader.readStableWithEvidence(D,benchmark());await pending;const before=f.calls.length;
  await assert.rejects(f.reader.readStable(D,benchmark()),/^Error: FEE_CLOUD_CONFIG$/);await assert.rejects(f.reader.readStableWithEvidence(D,benchmark()),/^Error: FEE_CLOUD_CONFIG$/);assert.equal(f.calls.length,before);
  resume();verifyEvidence(f.reader,await work);
});
test('capture cannot start over an in-flight legacy read, whose return stays compatible',async()=>{
  let resume,entered;const pending=new Promise(r=>{entered=r;}),blocked=new Promise(r=>{resume=r;});
  const f=cloudCaptureFixture({beforeResponse:async({p,attempt})=>{if(p==='/api/v2/portfolios.json'&&attempt===1){entered();await blocked;}}});
  const work=f.reader.readStable(D,benchmark());await pending;const before=f.calls.length;
  await assert.rejects(f.reader.readStableWithEvidence(D,benchmark()),/^Error: FEE_CLOUD_CONFIG$/);assert.equal(f.calls.length,before);
  resume();assert.deepEqual(await work,await cloudCaptureFixture().reader.readStable(D,benchmark()));
});
test('short configured credentials do not collide with JSON keys but reflected string values still refuse',async()=>{
  for(const factory of [cloudCaptureFixture,ibCaptureFixture]){
    for(const reflect of [false,true]){
      const f=factory({mutate:(body,{p})=>reflect&&p.endsWith('/performance')?body.replace('{','{"synthetic_note":"small",'):body});
      f.reader.clientId='id';f.reader.clientSecret='small';
      const work=f.args?f.reader.readStableWithEvidence(f.args):f.reader.readStableWithEvidence(D,benchmark());
      if(reflect)await assert.rejects(work);else verifyEvidence(f.reader,await work);
    }
  }
});

// Entirely synthetic bank-wire memo. Its source timestamp, monetary tokens and
// paired reference stay source bytes; capture is not a synchronization receipt.
const IB_WIRE_MEMO='IBKR U1000001 bank wire USD 50, received and available 2026-09-01 per Transfer Status & History and IBKR notice; source bank not verified. key=ib.manual|U1000001|wire|2026-09-01|USD|50.00';
function ibWireCaptureFixture({change=()=>{},rawChange=body=>body}={}){
  const originalBodies=[];
  const f=ibCaptureFixture({mutate:(body,context)=>{
    if(!context.p.endsWith('/cash_account_transactions.json'))return body;
    const parsed=JSON.parse(body),row=parsed.cash_account_transactions[0];
    Object.assign(row,{description:IB_WIRE_MEMO,trade_id:null,holding_id:null,payout_id:null,foreign_identifier:null});
    change(row,{...context,parsed});
    const raw=rawChange(JSON.stringify(parsed,null,1),context);originalBodies.push(raw);return raw;
  }});
  return {...f,originalBodies};
}
test('bank-wire capture shares the original reader, preserves exact source bytes and does not assert synchronization',async()=>{
  const ordinary=ibWireCaptureFixture(),captured=ibWireCaptureFixture();
  const expected=await ordinary.reader.readStable(ordinary.args),result=await captured.reader.readStableWithEvidence(captured.args);
  verifyEvidence(captured.reader,result);assert.deepEqual(result.input,expected);
  assert.deepEqual(result.input.cashFlowByDate,{'2026-09-01':50});assert.deepEqual(result.input.periodReturnsInput,ibBusiness());
  assert.equal(captured.originalBodies.length,2);
  for(const [index,batch]of result.evidence.captures.entries()){
    const record=batch.records.find(r=>r.path==='/api/v2/cash_accounts/3/cash_account_transactions.json');
    assert.equal(record.body,captured.originalBodies[index]);assert.equal(record.sha256,sha(captured.originalBodies[index]));
    assert.deepEqual(record.query,{from:'2026-08-31',to:'2026-09-02'});
    const row=JSON.parse(record.body).cash_account_transactions[0];
    assert.equal(row.date_time,'2026-09-01T12:00:00Z');assert.equal(row.description,IB_WIRE_MEMO);
    assert.equal(row.amount,50);assert.equal(row.balance,50);assert.equal(row.cash_account_transaction_type.name,'DEPOSIT');
  }
  assert.deepEqual(Object.keys(result).sort(),['evidence','input']);assert.equal(result.input.scope,'ib-manager');
  for(const key of ['synchronizationReceipt','synchronized','publicationReady','reportGenerated','approved'])assert.equal(Object.hasOwn(result,key),false);
});
test('bank-wire capture is consumed by the same reader once without further account requests',async()=>{
  const f=ibWireCaptureFixture(),captured=await f.reader.readStableWithEvidence(f.args),calls=f.calls.length;
  assert.throws(()=>f.reader.consumeCapturedRead(structuredClone(captured),f.args),/^Error: IB_SOURCE_STATE$/);
  assert.throws(()=>ibWireCaptureFixture().reader.consumeCapturedRead(captured,f.args),/^Error: IB_SOURCE_STATE$/);
  assert.throws(()=>f.reader.consumeCapturedRead(captured,{...f.args,targetDate:'2026-09-03'}),/^Error: IB_SOURCE_STATE$/);
  assert.equal(f.reader.consumeCapturedRead(captured,f.args),captured.input);
  assert.throws(()=>f.reader.consumeCapturedRead(captured,f.args),/^Error: IB_SOURCE_STATE$/);assert.equal(f.calls.length,calls);
});
test('bank-wire memo amount/date conflicts fail both reader paths before any capture can be delivered',async t=>{
  for(const [name,change]of [
    ['memo amount differs from source amount',r=>r.description=r.description.replace('USD 50,','USD 51,')],
    ['reference amount differs from source amount',r=>r.description=r.description.replace('|USD|50.00','|USD|51.00')],
    ['memo date differs from reference date',r=>r.description=r.description.replace('available 2026-09-01','available 2026-09-02')],
    ['memo and reference differ from the unchanged NY cash date',r=>r.description=r.description.replaceAll('2026-09-01','2026-09-02')],
    ['same wire reference reused on another cash row',(_r,{parsed})=>parsed.cash_account_transactions.push({...parsed.cash_account_transactions[0],id:5})],
  ])await t.test(name,async()=>{
    for(const capture of [false,true]){
      const f=ibWireCaptureFixture({change});let delivered=false;
      const operation=capture?f.reader.readStableWithEvidence(f.args):f.reader.readStable(f.args);
      await assert.rejects(operation.then(value=>{delivered=true;return value;}),/IB_SOURCE_(UNRESOLVED_FLOW|IDENTITY)/);assert.equal(delivered,false);
      assert.equal(f.calls.filter(c=>c.method==='POST').length,1,'refused first input must not start a second read');
    }
  });
});
test('a changed otherwise valid bank-wire memo between reads remains unstable, never silently accepted',async()=>{
  for(const capture of [false,true]){
    const f=ibWireCaptureFixture({change:(r,{attempt})=>{if(attempt===2)r.description=r.description.replaceAll('U1000001','U1000002');}});
    await assert.rejects(capture?f.reader.readStableWithEvidence(f.args):f.reader.readStable(f.args),/IB_SOURCE_UNSTABLE/);
    assert.equal(f.calls.filter(c=>c.method==='POST').length,2);
  }
});
test('bank-wire capture binds raw formatting changes even when normalized business input is unchanged',async()=>{
  const rawChange=(body,{attempt})=>attempt===2?body+' ':body;
  const ordinary=ibWireCaptureFixture({rawChange});assert.deepEqual((await ordinary.reader.readStable(ordinary.args)).periodReturnsInput,ibBusiness());
  const captured=ibWireCaptureFixture({rawChange});await assert.rejects(captured.reader.readStableWithEvidence(captured.args),/IB_SOURCE_UNSTABLE/);
});
