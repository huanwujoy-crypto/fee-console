// Synthetic-only tests for the shared lexical stability rule and every capture
// layer that now uses it. In-memory HTTP responses only; no account, credential,
// report, ledger, encrypted payload, file or network is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lexicalCanonicalJson,lexicalRecord,lexicalRecordsSha256,lexicalRecordEquivalent,lexicalBatchesEquivalent,lexicalBodiesCanonical,SOURCE_CAPTURE_UNSTABLE_CODES} from './fee-source-lexical.mjs';
import {IB_CAPTURE_UNSTABLE_DIAGNOSTIC_CODES,ibSourceCaptureUnstableDiagnostic,ibSourceCaptureRecheckDiagnostic,ibSourceFailureCode} from './ib-manager-source.mjs';
import {FEE_CLOUD_CAPTURE_UNSTABLE_CODES,feeCloudCaptureUnstableDiagnostic} from './fee-cloud-source.mjs';
import {projectCapturedSharesightAccount,capturedInputFailureCode} from './fee-sync-captured-inputs.mjs';
import {D,B,cloudFixture,ibFixture} from './fee-sync-test-fixtures.mjs';

const L=lexicalCanonicalJson;
// Reorders every member and pretty-prints, while keeping every number's exact
// lexeme (JSON.rawJSON); strings, arrays and members are otherwise untouched.
const reorderDeep=v=>Array.isArray(v)?v.map(reorderDeep):JSON.isRawJSON(v)?v
  :v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().reverse().map(k=>[k,reorderDeep(v[k])])):v;
const reserialize=text=>JSON.stringify(reorderDeep(JSON.parse(text,(k,v,c)=>typeof v==='number'?JSON.rawJSON(c.source):v)),null,2);
const sha=s=>createHash('sha256').update(s,'utf8').digest('hex');
const PRIVATE=/synthetic-secret|synthetic-client|synthetic-capture-token|Owner cash contribution|\d{3}\.\d|api\.sharesight/;

// ---------------------------------------------------------------- pure rule
test('only member order and whitespace between tokens are ignored',()=>{
  const a='{"b":[1,{"y":"2026-09-02","x":7}],"a":null}';
  assert.equal(L(a),L('{ "a" : null ,\n\t"b" : [ 1 , { "x" : 7 , "y" : "2026-09-02" } ] }'));
  assert.equal(L('{}'),L('{ }'));assert.equal(L('[]'),L('[\n]'));
});
test('every real lexical or semantic change stays different',()=>{
  const base='{"amount":7,"date":"2026-09-02","rows":[1,2]}';
  for(const [name,other] of [
    ['amount','{"amount":8,"date":"2026-09-02","rows":[1,2]}'],
    ['date','{"amount":7,"date":"2026-09-03","rows":[1,2]}'],
    ['unknown member added','{"amount":7,"date":"2026-09-02","rows":[1,2],"note":null}'],
    ['member removed','{"amount":7,"rows":[1,2]}'],
    ['array order','{"amount":7,"date":"2026-09-02","rows":[2,1]}'],
    ['number lexeme 7.0','{"amount":7.0,"date":"2026-09-02","rows":[1,2]}'],
    ['number lexeme 7e0','{"amount":7e0,"date":"2026-09-02","rows":[1,2]}'],
    ['number as string','{"amount":"7","date":"2026-09-02","rows":[1,2]}'],
    ['string escape','{"amount":7,"date":"2026-09-0\\u0032","rows":[1,2]}'],
    ['key escape','{"\\u0061mount":7,"date":"2026-09-02","rows":[1,2]}'],
    ['leading whitespace',' '+base],['trailing whitespace',base+'\n'],
    ['null vs false','{"amount":7,"date":null,"rows":[1,2]}'],
  ])assert.notEqual(L(other),L(base),name);
  assert.notEqual(L('"a"'),L('"b"'));assert.notEqual(L('["ab"]'),L('["a","b"]'));
});
test('documents the rule cannot reduce fall back to raw bytes and never match a different text',()=>{
  for(const bad of ['{"a":1,"a":1}','{"a":1,"a":2}','{','{"a":1}x','[1,]','01','"\u0001"','﻿{}','NaN','',null,7])
    assert.equal(L(bad),null,String(bad));
  assert.equal(L('['.repeat(70)+']'.repeat(70)),null,'depth bound');
  const dupA={method:'GET',path:'/api/x',query:{},body:'{"a":1,"a":2}'},dupB={...dupA,body:'{ "a":1,"a":2}'};
  assert.equal(lexicalRecord(dupA).rawBody,dupA.body);
  assert.equal(lexicalRecordEquivalent(dupA,dupB),false,'a duplicate-key document is compared byte for byte');
  assert.equal(lexicalRecordEquivalent(dupA,{...dupA}),true);
});
test('route and query identity are never relaxed and batches are order independent',()=>{
  const r={method:'GET',path:'/api/v2/a.json',query:{date:D},body:'{"a":1}'};
  assert.equal(lexicalRecordEquivalent(r,{...r,body:'{ "a" : 1 }'}),true);
  assert.equal(lexicalRecordEquivalent(r,{...r,path:'/api/v2/b.json'}),false);
  assert.equal(lexicalRecordEquivalent(r,{...r,query:{date:'2026-09-03'}}),false);
  assert.equal(lexicalRecordEquivalent(r,{...r,method:'POST'}),false);
  assert.equal(lexicalRecordEquivalent(r,undefined),false);
  const s={...r,path:'/api/v2/b.json',body:'[1,2]'};
  assert.equal(lexicalRecordsSha256([r,s]),lexicalRecordsSha256([{...s,body:'[ 1, 2 ]'},r]));
  assert.notEqual(lexicalRecordsSha256([r,s]),lexicalRecordsSha256([r]),'a dropped record is a change');
  assert.equal(lexicalBatchesEquivalent({sha256:'x',records:[r]},{sha256:'y',records:[{...r,body:'{"a" :1}'}]}),true);
  assert.equal(lexicalBatchesEquivalent({sha256:'x',records:[r]},{sha256:'y',records:[{...r,body:'{"a":1.0}'}]}),false);
  assert.equal(lexicalBodiesCanonical({p:'{"a":1}',c:{3:'[1]'}}),lexicalBodiesCanonical({p:'{ "a":1 }',c:{3:'[ 1 ]'}}));
  assert.notEqual(lexicalBodiesCanonical({p:'{"a":1}',c:{3:'[1]'}}),lexicalBodiesCanonical({p:'{"a":1}',c:{4:'[1]'}}));
});
test('one shared fixed code set; every reader exports the same one',()=>{
  assert.deepEqual([...SOURCE_CAPTURE_UNSTABLE_CODES],['UNCLASSIFIED','FINGERPRINT','RECORDS','TRANSPORT']);
  assert.equal(IB_CAPTURE_UNSTABLE_DIAGNOSTIC_CODES,SOURCE_CAPTURE_UNSTABLE_CODES);
  assert.equal(FEE_CLOUD_CAPTURE_UNSTABLE_CODES,SOURCE_CAPTURE_UNSTABLE_CODES);
  assert.equal(Object.isFrozen(SOURCE_CAPTURE_UNSTABLE_CODES),true);
  for(const forged of [new Error('IB_SOURCE_UNSTABLE'),new Error('FEE_CLOUD_SOURCE_UNSTABLE'),{code:'UNSTABLE'},null]){
    assert.equal(ibSourceCaptureUnstableDiagnostic(forged),'UNCLASSIFIED');assert.equal(feeCloudCaptureUnstableDiagnostic(forged),'UNCLASSIFIED');
  }
});

// ------------------------------------------- IB capture -> captured inputs
const secondRound=change=>(text,{attempt,path})=>attempt===2?change(text,path):null;
test('IB dividend plus owner transfer: re-serialized second round passes every layer and keeps the original proof',async()=>{
  const plain=ibFixture({nativePayout:true,ownerTransfer:true}),plainCapture=await plain.reader.readStableWithEvidence(plain.args);
  const plainOut=projectCapturedSharesightAccount({reader:plain.reader,captured:plainCapture,scope:plain.scope});
  const f=ibFixture({nativePayout:true,ownerTransfer:true,rewrite:(text,{attempt})=>attempt>=2?reserialize(text):null});
  const captured=await f.reader.readStableWithEvidence(f.args),[first,second]=captured.evidence.captures;
  assert.notEqual(first.sha256,second.sha256,'the two raw batches really differ');
  assert.ok(second.records.some(r=>r.body.includes('\n')));assert.ok(first.records.every(r=>!r.body.includes('\n')));
  assert.equal(captured.evidence.sourceSha256,first.sha256,'the first round stays the recorded proof');
  assert.deepEqual(captured.input.cashFlowByDate,{[D]:300},'only the owner transfer is an external flow');
  assert.equal(captured.input.periodReturnsInput.points.find(p=>p.d===D).tot,457);
  const out=projectCapturedSharesightAccount({reader:f.reader,captured,scope:f.scope});
  assert.equal(out.captureSourceSha256,first.sha256);
  for(const [key,body] of [['performance',out.raw.performance],['trades',out.raw.trades],['payout',out.raw.payouts[13]]]){
    const original=first.records.find(r=>r.body===body);assert.ok(original,key+' is a byte-exact first-round body');assert.equal(sha(body),original.sha256);
  }
  assert.equal(out.projection.sourceSha256,plainOut.projection.sourceSha256,'business projection identical to an unformatted run');
  assert.deepEqual(out.projection.cashEvents.map(e=>e.payoutId??null).sort(),[13,null].sort());
  assert.equal(await f.reader.checkCapturedReadCurrent(captured),true,'a third re-serialized read is still current');
  assert.equal(f.reader.consumeCapturedRead(captured,f.args),captured.input);
});
// An inconsistent amount/date change is refused even earlier by its original
// business validator; it never reaches, and never passes as, a formatting gate.
for(const [name,change,code] of [
  ['dividend amount',t=>t.replace('"amount":7,','"amount":8,'),'IB_SOURCE_AMOUNT'],
  ['transfer amount',t=>t.replace('"amount":300,','"amount":301,'),'IB_SOURCE_CASH_RECONCILIATION'],
  ['transfer date',t=>t.replace(D+'T05:00:00.000Z','2026-09-01T05:00:00.000Z'),'IB_SOURCE_CASH_RECONCILIATION'],
  ['payout paid date',(t,p)=>p.endsWith('/payouts/13.json')?t.replace('"paid_on":"'+D+'"','"paid_on":"2026-09-01"'):t,'IB_SOURCE_DATE_ALIGNMENT'],
])test('IB real second-round amount/date change keeps its original validator code: '+name,async()=>{
  const f=ibFixture({nativePayout:true,ownerTransfer:true,rewrite:secondRound(change)});
  await assert.rejects(f.reader.readStableWithEvidence(f.args),error=>{
    assert.equal(ibSourceFailureCode(error),code);assert.equal(ibSourceCaptureUnstableDiagnostic(error),'UNCLASSIFIED');
    assert.doesNotMatch(String(error.message)+JSON.stringify(error),PRIVATE);return true;
  });
});
// A self-consistent business change that every validator accepts is still a
// changed source: the business re-read fingerprint refuses it by its own site.
for(const [name,change,site] of [
  ['consistent transfer description',(t,p)=>p.endsWith('/cash_account_transactions.json')?t.replace('Owner cash contribution','Owner capital contribution'):t,'FINGERPRINT'],
  ['unknown member',(t,p)=>p.endsWith('/holdings')?t.replace('{"holdings":','{"extra":null,"holdings":'):t,'RECORDS'],
  ['number lexeme',(t,p)=>p.endsWith('/holdings')?t.replace('"quantity":1,','"quantity":1.0,'):t,'RECORDS'],
  ['duplicate member, same value',(t,p)=>p.endsWith('/holdings')?t.replace('{"holdings":','{"x":1,"x":1,"holdings":'):t,'RECORDS'],
  ['trailing newline',(t,p)=>p.endsWith('/holdings')?t+'\n':t,'RECORDS'],
])test('IB real second-round change is refused at its own fixed site: '+name,async()=>{
  const f=ibFixture({nativePayout:true,ownerTransfer:true,rewrite:secondRound(change)});
  await assert.rejects(f.reader.readStableWithEvidence(f.args),error=>{
    assert.equal(ibSourceFailureCode(error),'IB_SOURCE_UNSTABLE');assert.equal(ibSourceCaptureUnstableDiagnostic(error),site);
    assert.doesNotMatch(String(error.message)+JSON.stringify(error),PRIVATE);return true;
  });
});
test('IB recheck accepts formatting only and revokes on a real later change',async()=>{
  let mode=null;
  const f=ibFixture({nativePayout:true,ownerTransfer:true,rewrite:(t,{attempt,path})=>attempt<3||!mode?null
    :mode==='format'?reserialize(t):path.endsWith('/cash_account_transactions.json')?t.replace('"amount":300,','"amount":301,'):null});
  const captured=await f.reader.readStableWithEvidence(f.args);
  mode='format';assert.equal(await f.reader.checkCapturedReadCurrent(captured),true);
  mode='change';
  await assert.rejects(f.reader.checkCapturedReadCurrent(captured),e=>{assert.equal(ibSourceRecheckOk(e),'RECORD_CHANGED');return true;});
  assert.equal(f.reader.verifyCapturedRead(captured),false,'revoked');
  assert.throws(()=>projectCapturedSharesightAccount({reader:f.reader,captured,scope:f.scope}),e=>capturedInputFailureCode(e)==='FEE_SYNC_CAPTURE_ORIGIN');
});
const ibSourceRecheckOk=e=>ibSourceCaptureRecheckDiagnostic(e);

// ----------------------------------------- fee capture -> captured inputs
test('fee reader: re-serialized second round passes reader and projection for both accounts',async()=>{
  const f=cloudFixture({rewrite:(t,{attempt})=>attempt>=2?reserialize(t):null});
  const captured=await f.reader.readStableWithEvidence(D,B),[first,second]=captured.evidence.captures;
  assert.notEqual(first.sha256,second.sha256);assert.equal(captured.evidence.sourceSha256,first.sha256);
  for(const role of ['schwab','webull']){
    const out=projectCapturedSharesightAccount({reader:f.reader,captured,scope:f.scope(role)});
    assert.equal(out.captureSourceSha256,first.sha256);assert.equal(out.projection.holdings[0].quantity,'10000000000000001e-16','number lexeme kept');
    const performance=first.records.find(r=>r.path==='/api/v3/portfolios/'+out.scope.portfolioId+'/performance');
    assert.equal(out.raw.performance,performance.body,'byte-exact first-round body');
  }
  assert.equal(await f.reader.checkCapturedReadCurrent(captured),true);
  assert.equal(f.reader.consumeCapturedRead(captured,D,B),captured.input);
});
for(const [name,change,site] of [
  ['cash balance',(t,p)=>p.endsWith('/cash_accounts.json')?t.replace('"balance":50,','"balance":51,'):t,'FINGERPRINT'],
  ['number lexeme',(t,p)=>p.endsWith('/holdings')?t.replace('"quantity":1.0000000000000001','"quantity":1.00000000000000010'):t,'RECORDS'],
  ['unknown member',(t,p)=>p.endsWith('/trades.json')?t.replace('{"trades":','{"next":null,"trades":'):t,'RECORDS'],
])test('fee reader real second-round change is refused at its own fixed site: '+name,async()=>{
  const f=cloudFixture({rewrite:secondRound(change)});
  await assert.rejects(f.reader.readStableWithEvidence(D,B),error=>{
    assert.equal(error.message,'FEE_CLOUD_SOURCE_UNSTABLE','ordinary allowlisted message unchanged');
    assert.equal(feeCloudCaptureUnstableDiagnostic(error),site);assert.doesNotMatch(error.message,PRIVATE);return true;
  });
});
test('fee reader recheck accepts formatting only and fails closed on a real change',async()=>{
  let mode=null;
  const f=cloudFixture({rewrite:(t,{attempt,path})=>attempt<3||!mode?null:mode==='format'?reserialize(t):path.endsWith('/cash_accounts.json')?t.replace('"balance":50,','"balance":49,'):null});
  const captured=await f.reader.readStableWithEvidence(D,B);
  mode='format';assert.equal(await f.reader.checkCapturedReadCurrent(captured),true);
  mode='change';await assert.rejects(f.reader.checkCapturedReadCurrent(captured),/^Error: FEE_CLOUD_SOURCE_UNSTABLE$/);
  assert.equal(f.reader.verifyCapturedRead(captured),false);
});

// ------------------------------------------- captured inputs, independently
test('captured inputs re-derive equivalence from evidence and refuse a version or binding mismatch',async()=>{
  const f=ibFixture({nativePayout:true,ownerTransfer:true,rewrite:(t,{attempt})=>attempt===2?reserialize(t):null});
  const captured=await f.reader.readStableWithEvidence(f.args);
  // Unregistered copies (schema change, swapped round, rebound source hash) never reach projection.
  for(const value of [
    {...captured,evidence:{...captured.evidence,schema:'fee-console.sharesight-capture.v2'}},
    {...captured,evidence:{...captured.evidence,sourceSha256:captured.evidence.captures[1].sha256}},
    {...captured,evidence:{...captured.evidence,captures:[...captured.evidence.captures].reverse()}},
  ])assert.throws(()=>projectCapturedSharesightAccount({reader:f.reader,captured:value,scope:f.scope}),e=>capturedInputFailureCode(e)==='FEE_SYNC_CAPTURE_ORIGIN');
  assert.equal(projectCapturedSharesightAccount({reader:f.reader,captured,scope:f.scope}).captureSourceSha256,captured.evidence.captures[0].sha256);
});

// ------------------------------------------------ v2 route-bound id-set contract
import {IB_UNORDERED_ID_ARRAYS as C,classifyRecordsDifference,SOURCE_RECORDS_SITES} from './fee-source-lexical.mjs';
import {ibSourceCaptureRecordsSite} from './ib-manager-source.mjs';
const perfQ=d=>({consolidated:'false',end_date:d,grouping:'investment_type',include_limited:'false',include_sales:'false',report_combined:'false',start_date:d});
const LC=(body,path,query)=>L(body,C(path,query));
const revKey=(text,key)=>{const v=JSON.parse(text,(k,x,c)=>typeof x==='number'?JSON.rawJSON(c.source):x);const at=key.reduce((o,k)=>o?.[k],v);if(Array.isArray(at))at.reverse();return JSON.stringify(v);};

test('the id-set contract applies only to exact IB routes, exact query shapes and listed root paths',()=>{
  assert.deepEqual(C('/api/v2/portfolios.json',{}),[['portfolios']]);
  assert.deepEqual(C('/api/v3/portfolios/1/performance',perfQ(D)),[['report','holdings'],['report','cash_accounts']]);
  for(const [path,query] of [['/api/v2/portfolios.json',{page:'2'}],['/api/v3/portfolios/1/holdings',{consolidated:'true'}],
    ['/api/v3/portfolios/1/performance',{...perfQ(D),include_sales:'true'}],['/api/v3/portfolios/1/performance',{...perfQ(D),start_date:'2026-09-01'}],
    ['/api/v3/portfolios/1/trades.json',{consolidated:'false',end_date:D}],['/api/v2/cash_accounts/3/cash_account_transactions.json',{to:D}],
    ['/api/v2/payouts/13.json',{}],['/api/v3/portfolios/1/extra/holdings',{consolidated:'false'}],['/api/v9/unknown.json',{}]])
    assert.deepEqual(C(path,query),[],path+' '+JSON.stringify(query));
  // A listed path reorders; the same body on a non-contract route stays ordered.
  const a='{"holdings":[{"id":1,"v":1},{"id":2,"v":2}]}',b='{"holdings":[{"id":2,"v":2},{"id":1,"v":1}]}';
  assert.equal(LC(a,'/api/v3/portfolios/1/holdings',{consolidated:'false'}),LC(b,'/api/v3/portfolios/1/holdings',{consolidated:'false'}));
  assert.notEqual(LC(a,'/api/v3/portfolios/1/holdings',{consolidated:'true'}),LC(b,'/api/v3/portfolios/1/holdings',{consolidated:'true'}));
  assert.notEqual(L(a),L(b),'the v1 default (fee readers) stays ordered');
});
test('inside a contract array every row field, lexeme, count and nested order stays strict',()=>{
  const path='/api/v2/cash_accounts/3/cash_account_transactions.json',q={from:D,to:D},k='cash_account_transactions';
  const base={[k]:[{id:12,amount:7,date_time:D+'T00:00:00.000Z',tags:[1,2]},{id:14,amount:300,date_time:D+'T05:00:00.000Z',tags:[]}]};
  const t=JSON.stringify(base),same=JSON.stringify({[k]:[...base[k]].reverse()});
  assert.equal(LC(t,path,q),LC(same,path,q));
  const variant=f=>{const v=structuredClone(base);f(v[k]);return JSON.stringify(v);};
  for(const [name,body] of [
    ['same id, changed amount',variant(r=>{r[1].amount=301;})],['changed date',variant(r=>{r[0].date_time=D+'T01:00:00.000Z';})],
    ['row removed',variant(r=>{r.pop();})],['row added',variant(r=>{r.push({id:15,amount:1,date_time:D+'T06:00:00.000Z',tags:[]});})],
    ['nested array reordered',variant(r=>{r[0].tags.reverse();})],['unknown member added',variant(r=>{r[0].note=null;})],
    ['id changed',variant(r=>{r[0].id=13;})],
    ['number lexeme',t.replace('"amount":7,','"amount":7.0,')],
  ])assert.notEqual(LC(body,path,q),LC(t,path,q),name);
  // Without a unique positive integer id per row the array is never reordered.
  for(const rows of [[{id:1,a:1},{id:1,a:2}],[{id:1},{a:2}],[{id:'1'},{id:2}],[{id:0},{id:2}],[1,2],[{id:1},[2]]]){
    const x=JSON.stringify({[k]:rows}),y=JSON.stringify({[k]:[...rows].reverse()});
    assert.notEqual(LC(x,path,q),LC(y,path,q),JSON.stringify(rows));
  }
  // A reordered contract array never equals the same rows under an ordered encoding.
  assert.notEqual(LC(t,path,q),L(t));
});
test('a batch that reads one route twice is compared only by its original bytes',()=>{
  const r={method:'GET',path:'/api/v2/portfolios.json',query:{},body:'{"portfolios":[{"id":1},{"id":2}]}'};
  const swap={...r,body:'{"portfolios":[{"id":2},{"id":1}]}'};
  assert.equal(lexicalRecordsSha256([r],C),lexicalRecordsSha256([swap],C));
  assert.notEqual(lexicalRecordsSha256([r,swap],C),lexicalRecordsSha256([swap,{...r,body:'{"portfolios":[{"id":1},{"id":3}]}'}],C));
  assert.match(lexicalRecordsSha256([r,swap],C),/^raw:/);
  assert.equal(classifyRecordsDifference([r,swap],[r,swap],C),'PORT_DUP');
});
test('the RECORDS location is a fixed route/kind literal, never a value',()=>{
  const rec=(path,query,body)=>({method:'GET',path,query,body});
  const h=(b)=>rec('/api/v3/portfolios/1/holdings',{consolidated:'false'},b);
  assert.equal(classifyRecordsDifference([h('{"holdings":[]}')],[h('{"holdings":[] }')],C),null,'between-token whitespace is no difference');
  assert.equal(classifyRecordsDifference([h('{"holdings":[]}')],[h('{"holdings":[]}\n')],C),'HOLD_LEX');
  assert.equal(classifyRecordsDifference([h('{"holdings":[{"id":1,"q":1}]}')],[h('{"holdings":[{"id":1,"q":1.0}]}')],C),'HOLD_LEX');
  assert.equal(classifyRecordsDifference([h('{"holdings":[{"id":1,"q":1}]}')],[h('{"holdings":[{"id":1,"q":2}]}')],C),'HOLD_VAL');
  assert.equal(classifyRecordsDifference([h('{"holdings":[]}')],[h('{"holdings":[],"holdings":[]}')],C),'HOLD_RAW');
  assert.equal(classifyRecordsDifference([h('{}')],[h('{}'),rec('/api/v2/payouts/13.json',{},'{}')],C),'PAYOUT_SET');
  assert.ok(SOURCE_RECORDS_SITES.every(s=>/^[A-Z]+_[A-Z]+$/.test(s)));
});

test('real IB reader: reordered id-set rows pass capture, projection and currentness, bytes kept',async()=>{
  const f=ibFixture({nativePayout:true,ownerTransfer:true,rewrite:(t,{attempt,path})=>attempt>=2&&path.endsWith('/cash_account_transactions.json')?revKey(t,['cash_account_transactions']):null});
  const captured=await f.reader.readStableWithEvidence(f.args),[first,second]=captured.evidence.captures;
  assert.notEqual(first.sha256,second.sha256,'the second round really returned another row order');
  assert.equal(captured.evidence.sourceSha256,first.sha256);
  const out=projectCapturedSharesightAccount({reader:f.reader,captured,scope:f.scope});
  const original=first.records.find(r=>r.path.endsWith('/cash_account_transactions.json'));
  assert.equal(out.raw.cashTransactions[3],original.body,'the first-round bytes are the projected input');
  assert.deepEqual(captured.input.cashFlowByDate,{[D]:300});
  assert.equal(await f.reader.checkCapturedReadCurrent(captured),true,'a reordered third read is current');
});
for(const [name,change,site] of [
  ['a reordered nested array is content',(t,p)=>p.endsWith('/performance')?t.replace('"holdings":[','"zz":[2,1],"holdings":['):null,'PERF_VAL'],
  ['unknown member',(t,p)=>p.endsWith('/holdings')?t.replace('{"holdings":','{"generated_at":"x","holdings":'):null,'HOLD_VAL'],
  ['number lexeme',(t,p)=>p.endsWith('/holdings')?t.replace('"quantity":1,','"quantity":1.0,'):null,'HOLD_LEX'],
  ['reorder plus a changed row',(t,p)=>p.endsWith('/cash_account_transactions.json')?revKey(t,['cash_account_transactions']).replace('"description":"Owner cash contribution"','"description":"Owner cash contribution."'):null,null],
])test('real IB reader keeps refusing: '+name,async()=>{
  const f=ibFixture({nativePayout:true,ownerTransfer:true,rewrite:(t,{attempt,path})=>attempt===2?change(t,path):null});
  await assert.rejects(f.reader.readStableWithEvidence(f.args),e=>{
    assert.equal(ibSourceFailureCode(e),'IB_SOURCE_UNSTABLE');
    if(site){assert.equal(ibSourceCaptureUnstableDiagnostic(e),'RECORDS');assert.equal(ibSourceCaptureRecordsSite(e),site);}
    else assert.equal(ibSourceCaptureUnstableDiagnostic(e),'FINGERPRINT');
    assert.doesNotMatch(String(e.message)+JSON.stringify(e),PRIVATE);return true;
  });
});
test('the two-account fee reader keeps the ordered rule: a row reorder is still RECORDS',async()=>{
  const f=cloudFixture({rewrite:(t,{attempt,path})=>attempt===2&&path==='/api/v2/portfolios.json'?revKey(t,['portfolios']):null});
  await assert.rejects(f.reader.readStableWithEvidence(D,B),e=>{assert.equal(feeCloudCaptureUnstableDiagnostic(e),'RECORDS');return true;});
});
