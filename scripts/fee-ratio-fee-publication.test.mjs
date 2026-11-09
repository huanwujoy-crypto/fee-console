import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {buildFeeCalculationReceipt,validateFeeCalculationReceipt} from './fee-receipt-core.mjs';
import {buildIbManagerReturnReceipt,buildIbManagerDrawdownReceipt,buildIbManagerReportBundle,createIbManagerReturnConsumer} from './ib-manager-return.mjs';
import {ibBaselineBusinessHash} from './ib-manager-source.mjs';
import {HEALTH_SCHEMA} from './fee-data-health.mjs';
import {buildReportMetadata} from './fee-report-metadata.mjs';
import {weeklyReportPlan,monthlyReportPlan} from './fee-report-period.mjs';
import {verifyFeeFinalPublication,isFeeFinalPublicationProof,feePublicationFailureCode,FEE_PUBLICATION_CODES,validateFeeHandoff} from './fee-ratio-fee-publication.mjs';

// Fixed public-safe synthetic history, key and ciphertext nonce. Nothing reads
// a file, secret service, real account, process environment, or the network.
// FEE_MAIN is where the fee pair was promoted; MAIN is this ratio run's main.
const MAIN='a'.repeat(40),FEE_MAIN='f'.repeat(40),TARGET='2026-09-02',NOW='2026-09-03T01:00:00.000Z',REPO_TOKEN='synthetic-actions-read-token-0001';
const API='https://api.github.com/repos/huanwujoy-crypto/fee-console/';
const PAGES='https://huanwujoy-crypto.github.io/fee-console/';
const KEY=Buffer.alloc(32,7),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const json=v=>Buffer.from(JSON.stringify(v));
const seal=data=>{
  const iv=Buffer.alloc(12,9),c=crypto.createCipheriv('aes-256-gcm',KEY,iv);
  return json({enc:true,v:3,data:Buffer.concat([iv,c.update(json(data)),c.final(),c.getAuthTag()]).toString('base64')});
};
function content(name,b){return {type:'file',name,path:name,encoding:'base64',size:b.length,
  sha:crypto.createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex'),content:b.toString('base64')};}
export async function syntheticFeePublicationFixture({targetDate=TARGET,reviewedMain=MAIN,feeMain=FEE_MAIN,nativeJenny=false,editPayload=()=>{},editHealth=()=>{},editResponse=()=>{},editPageData=b=>b,editPageHealth=b=>b,editRoot=r=>r,repoToken=REPO_TOKEN,clock=()=>new Date(NOW)}={}){
  const day=n=>new Date(Date.parse(targetDate+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
  const business={points:[{d:day(-2),tot:100},{d:day(-1),tot:150},{d:targetDate,tot:135}],
    openT:100,from:day(-2),to:targetDate,days:3,flowByDate:{[day(-1)]:50},rate:0,cr:0,cumBefore:0,hwmBefore:0};
  const frozen={schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',
    flowsComplete:true,correctionsConfirmed:true,sourceSha256:'b'.repeat(64),periodReturnsInput:business};
  const economicInput={v:4,settings:{start:business.from,mgmt:2,carry:20,fx:{USD:1}},
    accounts:[{id:'schwab',opening:60},{id:'webull',opening:40}],months:[],fees:[]};
  const payload={daily:business.points.map(p=>({d:p.d,bd:p.d,schwab:60,webull:40})),flowsAuto:[],flowsUnresolved:[],
    status:{asOf:targetDate,provisional:false,calibrated:true,unresolvedCount:0}};
  payload.feeCalculationReceipt=buildFeeCalculationReceipt({data:payload,economicInput});
  payload.ibManagerReturnReceipt=await buildIbManagerReturnReceipt(frozen);
  payload.ibManagerDrawdownReceipt=await buildIbManagerDrawdownReceipt(frozen);
  if(nativeJenny){
    // The existing native source validator/generator builds the actual v2
    // daily receipt and bound source state; no hand-written receipt flags.
    const source={schema:'fee-console.ib-manager-source.v1',scope:'ib-manager',currency:'USD',timezone:'America/New_York',flowTiming:'eod',
      baselineFrom:business.from,baselineAsOf:targetDate,baselineInputsHash:ibBaselineBusinessHash(business),portfolioIdentityHash:'c'.repeat(64),
      sourceAsOf:targetDate,sourceEvidenceHash:'d'.repeat(64),cashFlowByDate:structuredClone(business.flowByDate),noncashProofs:[],periodReturnsInput:structuredClone(business)};
    const bundle=await buildIbManagerReportBundle(source,ibBaselineBusinessHash(business));
    payload.ibManagerReturnReceipt=bundle.returnReceipt;payload.ibManagerDrawdownReceipt=bundle.drawdownReceipt;
    payload.ibManagerSourceState=bundle.sourceState;payload.ibManagerSourceStatus={state:'verified',targetDate};
  }
  await editPayload(payload);
  const data=seal(payload),health={schema:HEALTH_SCHEMA,checkedAt:targetDate+'T22:00:00.000Z',targetDate,
    sourceDates:{schwab:targetDate,webull:targetDate,benchmark:targetDate},outcome:'updated',dataSha256:sha(data),errorCode:null};
  editHealth(health);const healthBytes=json(health),calls=[];
  const dataContent=content('data.json',data),healthContent=content('fee-data-health.json',healthBytes);
  const fetchImpl=async(url,init)=>{
    calls.push({url,init});assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
    assert.equal(init.credentials,'omit');assert.equal(init.cache,'no-store');
    // The existing read-only token reaches only fixed repository API URLs.
    assert.equal(init.headers.Authorization,url.startsWith(API)?'Bearer '+repoToken:undefined);
    let b;
    if(url===API+'git/ref/heads/main')b=json({ref:'refs/heads/main',object:{type:'commit',sha:reviewedMain}});
    else if(url===API+'contents/data.json?ref='+feeMain)b=json(dataContent);
    else if(url===API+'contents/fee-data-health.json?ref='+feeMain)b=json(healthContent);
    else if(url===API+'contents?ref='+reviewedMain)b=json(editRoot([{name:'index.html',path:'index.html',type:'file',sha:'1'.repeat(40)},
      {name:'data.json',path:'data.json',type:'file',sha:dataContent.sha},{name:'fee-data-health.json',path:'fee-data-health.json',type:'file',sha:healthContent.sha}]));
    else if(url===PAGES+'data.json')b=editPageData(data);
    else if(url===PAGES+'fee-data-health.json')b=editPageHealth(healthBytes);
    else assert.fail('unexpected fixed-service route');
    const edited=editResponse(url,b,calls)||{};
    const r=new Response(edited.bytes||b,{status:edited.status||200,headers:{'content-type':'application/json',...edited.headers}});
    Object.defineProperty(r,'url',{value:edited.url||url});if(edited.redirected)Object.defineProperty(r,'redirected',{value:true});return r;
  };
  const handoff={mainSha:feeMain,accountingThrough:targetDate,dataSha256:sha(data),healthSha256:sha(healthBytes)};
  return {args:{handoff,runMain:reviewedMain,repositoryToken:repoToken,feeDataKey:KEY.toString('base64url'),ibBaselineSha256:ibBaselineBusinessHash(business),fetchImpl,clock},handoff,
    calls,payload,data,dataBytes:data,healthBytes,feeDataKey:KEY.toString('base64url'),ibBaselineSha256:ibBaselineBusinessHash(business)};
}
const fixture=syntheticFeePublicationFixture;
async function refused(options,code,extra={}){
  const f=await fixture(options);await assert.rejects(verifyFeeFinalPublication({...f.args,...extra}),{message:'FEE_PUBLICATION_'+code});return f;
}

test('the handed-over fee publication on fee main, live main and Pages returns an immutable branded proof',async()=>{
  const f=await fixture(),p=await verifyFeeFinalPublication(f.args);
  assert.deepEqual(p,{schema:'fee-console.ratio-fee-publication-proof.v2',status:'FEE_FINAL_PUBLICATION_VERIFIED',
    accountingThrough:TARGET,feeMainSha:FEE_MAIN,runMainSha:MAIN,dataSha256:sha(f.data),healthSha256:sha(f.healthBytes),verifiedAt:NOW,healthCheckedAt:'2026-09-02T22:00:00.000Z'});
  assert.ok(Object.isFrozen(p));assert.ok(isFeeFinalPublicationProof(p));assert.equal(isFeeFinalPublicationProof({...p}),false);
  assert.equal(f.calls.length,7);assert.equal(f.calls.filter(c=>c.url===API+'git/ref/heads/main').length,2);
  assert.ok(f.calls.every(c=>!/(?:actions|matching-refs|gists|storage|sharesight)/.test(c.url)));
  // Authorization only on the five fixed repository API URLs; never on Pages.
  assert.equal(f.calls.filter(c=>c.init.headers.Authorization).length,5);
  assert.ok(f.calls.filter(c=>c.url.startsWith(PAGES)).every(c=>c.init.headers.Authorization===undefined&&!JSON.stringify(c.init).includes(REPO_TOKEN)));
});
test('the recheck repeats every read and compares the original branded publication',async()=>{
  const f=await fixture(),p=await verifyFeeFinalPublication(f.args),q=await verifyFeeFinalPublication({...f.args,previousProof:p});
  assert.notEqual(p,q);assert.deepEqual(p,q);assert.equal(f.calls.length,14);
  await assert.rejects(verifyFeeFinalPublication({...f.args,previousProof:{...p}}),{message:'FEE_PUBLICATION_CONFIG'});
  await assert.rejects(verifyFeeFinalPublication({...f.args,runMain:'b'.repeat(40),previousProof:p}),{message:'FEE_PUBLICATION_CONFIG'});
  assert.equal(f.calls.length,14);
});
test('a handoff that does not name the exact published bytes is refused',async()=>{
  const f=await fixture();
  await assert.rejects(verifyFeeFinalPublication({...f.args,handoff:{...f.handoff,dataSha256:'d'.repeat(64)}}),{message:'FEE_PUBLICATION_DATA_HASH'});
  await assert.rejects(verifyFeeFinalPublication({...f.args,handoff:{...f.handoff,healthSha256:'d'.repeat(64)}}),{message:'FEE_PUBLICATION_HEALTH_HASH'});
  for(const bad of [{...f.handoff,extra:1},{...f.handoff,mainSha:'bad'},{...f.handoff,accountingThrough:'2026-02-30'},{mainSha:FEE_MAIN},null])assert.equal(validateFeeHandoff(bad),false);
  assert.equal(validateFeeHandoff(f.handoff),true);
});
test('a fee pair replaced between readback and recheck is refused as changed',async()=>{
  const first=await fixture(),proof=await verifyFeeFinalPublication(first.args);
  // The second fixture is a newer publication; its own handoff matches it, but
  // the recheck is bound to the first proof's bytes.
  const later=await fixture({editHealth:h=>{h.checkedAt='2026-09-02T22:01:00.000Z';}});
  await assert.rejects(verifyFeeFinalPublication({...later.args,previousProof:proof}),{message:'FEE_PUBLICATION_CHANGED'});
  await assert.rejects(verifyFeeFinalPublication({...later.args,handoff:first.handoff}),{message:'FEE_PUBLICATION_HEALTH_HASH'});
});
test('a newer or missing fee pair on the live main supersedes the handoff',async()=>{
  for(const editRoot of [r=>r.map(x=>x.name==='data.json'?{...x,sha:'9'.repeat(40)}:x),r=>r.map(x=>x.name==='fee-data-health.json'?{...x,sha:'9'.repeat(40)}:x),
    r=>r.filter(x=>x.name!=='data.json'),r=>[...r,r[1]],r=>r.map(x=>x.name==='data.json'?{...x,type:'symlink'}:x),()=>({message:'not a listing'})])
    await refused({editRoot},'LIVE');
});
test('the fee main may differ from the ratio run main when the live pair is unchanged',async()=>{
  const f=await fixture({feeMain:'e'.repeat(40)});const p=await verifyFeeFinalPublication(f.args);
  assert.deepEqual([p.feeMainSha,p.runMainSha],['e'.repeat(40),MAIN]);
  const same=await fixture({feeMain:MAIN});assert.equal((await verifyFeeFinalPublication(same.args)).feeMainSha,MAIN);
});
test('reviewed main is exact at both ends',async()=>{
  for(const phase of [1,2])await refused({editResponse:(url,b,calls)=>url.endsWith('/git/ref/heads/main')&&calls.filter(c=>c.url===url).length===phase
    ?{bytes:json({ref:'refs/heads/main',object:{type:'commit',sha:'c'.repeat(40)}})}:undefined},'MAIN');
});
test('a successful HTTP run or boolean cannot replace publication response contents',async()=>{
  await refused({editResponse:url=>url.endsWith('/git/ref/heads/main')?{bytes:json({success:true})}:undefined},'MAIN');
});
test('Pages ciphertext mismatch fails byte-exact comparison',async()=>{await refused({editPageData:b=>Buffer.concat([b,Buffer.from('\n')])},'PAGES_DATA');});
test('Pages health mismatch fails byte-exact comparison',async()=>{await refused({editPageHealth:b=>Buffer.concat([b,Buffer.from('\n')])},'PAGES_HEALTH');});
test('health must bind actual ciphertext, not only pass public receipt shape',async()=>{await refused({editHealth:h=>{h.dataSha256='d'.repeat(64);}},'HEALTH');});
test('a verified no-op health receipt is accepted but failed health cannot release a report',async()=>{
  const f=await fixture({editHealth:h=>{h.outcome='no-op';}});assert.ok(isFeeFinalPublicationProof(await verifyFeeFinalPublication(f.args)));
  await refused({editHealth:h=>{h.outcome='failed';h.errorCode='RUN_FAILED';}},'HEALTH');
});
test('no 36h age gate: an explicitly handed-over fee publication that is still live is accepted later',async()=>{
  const f=await fixture({clock:()=>new Date('2026-09-08T10:00:00.000Z')});const p=await verifyFeeFinalPublication(f.args);
  assert.equal(p.healthCheckedAt,'2026-09-02T22:00:00.000Z');assert.equal(p.verifiedAt,'2026-09-08T10:00:00.000Z');
  // A receipt dated in the future is still refused by the receipt's own rule.
  await refused({clock:()=>new Date('2026-09-02T21:00:00.000Z')},'HEALTH');
});
test('the handed accounting cutoff must match the fee report itself, independent of any ratio date',async()=>{
  const f=await fixture();
  await assert.rejects(verifyFeeFinalPublication({...f.args,handoff:{...f.handoff,accountingThrough:'2026-09-03'}}),{message:'FEE_PUBLICATION_CUTOFF'});
  await assert.rejects(verifyFeeFinalPublication({...f.args,handoff:{...f.handoff,accountingThrough:'2026-09-01'}}),{message:'FEE_PUBLICATION_CUTOFF'});
  const exposure=await fixture({editPayload:p=>{p.exposure={summary:{asOf:'2026-09-05'}};}});assert.ok(isFeeFinalPublicationProof(await verifyFeeFinalPublication(exposure.args)));
});
test('legacy reports without verified period metadata require exact target source and benchmark dates',async()=>{
  for(const key of ['schwab','webull','benchmark'])await refused({editHealth:h=>{h.sourceDates[key]='2026-09-01';}},key==='benchmark'?'CUTOFF':'HEALTH');
});
test('corrupt actual fee receipt cannot be replaced by successful public health',async()=>{await refused({editPayload:p=>{p.feeCalculationReceipt.periods[0].grossTwrPpm++;}},'FEE_RECEIPT');});
test('an old benchmark cutoff hidden inside a valid fee payload is rejected',async()=>{
  await refused({editPayload:p=>{p.daily.at(-1).bd='2026-09-01';}},'CUTOFF');
});
test('reviewed holiday and month-end plans keep genuine distinct accounting and price cutoffs',async()=>{
  for(const [plan,at] of [[weeklyReportPlan('2026-07-03'),'2026-07-05T00:00:00.000Z'],[monthlyReportPlan('2026-10'),'2026-11-01T06:00:00.000Z']]){
    assert.notEqual(plan.priceThrough,plan.accountingThrough);
    const options={targetDate:plan.accountingThrough,clock:()=>new Date(at),editHealth:h=>{h.checkedAt=at;h.sourceDates.benchmark=plan.priceThrough;},
      editPayload:p=>{p.daily.at(-1).bd=plan.priceThrough;p.feeReportPublication=buildReportMetadata({plan,data:p,generatedAt:at});}};
    const f=await fixture(options);assert.ok(isFeeFinalPublicationProof(await verifyFeeFinalPublication(f.args)));
    assert.equal(f.payload.feeCalculationReceipt.asOf,plan.accountingThrough);
    assert.equal(f.payload.ibManagerReturnReceipt.asOf,plan.accountingThrough);
    // A nearby older price, even agreeing across health and decrypted payload,
    // cannot replace the exact price date validated by the existing calendar.
    const wrong='2026-'+(plan.accountingThrough==='2026-07-03'?'07-01':'10-29');
    const bad=await fixture({...options,editHealth:h=>{options.editHealth(h);h.sourceDates.benchmark=wrong;},
      editPayload:p=>{options.editPayload(p);p.daily.at(-1).bd=wrong;}});
    await assert.rejects(verifyFeeFinalPublication(bad.args),{message:'FEE_PUBLICATION_CUTOFF'});
    const noMetadata=await fixture({...options,editPayload:p=>{options.editPayload(p);delete p.feeReportPublication;}});
    await assert.rejects(verifyFeeFinalPublication(noMetadata.args),{message:'FEE_PUBLICATION_CUTOFF'});
  }
});
test('a rehashed but noncalendar report plan cannot authorize an older benchmark',async()=>{
  const plan=monthlyReportPlan('2026-10'),at='2026-11-01T06:00:00.000Z';
  const f=await fixture({targetDate:plan.accountingThrough,clock:()=>new Date(at),editHealth:h=>{h.checkedAt=at;h.sourceDates.benchmark='2026-10-29';},
    editPayload:async p=>{
      p.daily.at(-1).bd=plan.priceThrough;const metadata=buildReportMetadata({plan,data:p,generatedAt:at});
      metadata.plan.priceThrough='2026-10-29';p.daily.at(-1).bd='2026-10-29';
      const {reportId,...body}=metadata;metadata.reportId=await createIbManagerReturnConsumer().digest(body);p.feeReportPublication=metadata;
    }});
  await assert.rejects(verifyFeeFinalPublication(f.args),{message:'FEE_PUBLICATION_REPORT_METADATA'});
});
test('missing Jenny return or drawdown fails without logging receipt data',async()=>{
  let logged='';const saved=process.stderr.write;
  try{process.stderr.write=chunk=>{logged+=String(chunk);return true;};
    for(const field of ['ibManagerReturnReceipt','ibManagerDrawdownReceipt'])await refused({editPayload:p=>{delete p[field];}},'JENNY_RECEIPT');
  }finally{process.stderr.write=saved;}
  assert.equal(logged,'');
});
test('tampered Jenny return and path plus pending source status fail real consumers',async()=>{
  for(const editPayload of [p=>{p.ibManagerReturnReceipt.periods[0].grossTwrPpm++;},p=>{p.ibManagerDrawdownReceipt.dailyFactors[1].factor=0;},
    p=>{p.ibManagerSourceStatus={state:'pending',targetDate:TARGET,reasonCode:'IB_SOURCE_COVERAGE_UNVERIFIED'};}])await refused({editPayload},'JENNY_RECEIPT');
});
test('native daily Jenny state requires the real baseline and source cutoff despite valid fee and exact public bytes',async()=>{
  const good=await fixture({nativeJenny:true});
  assert.equal(good.payload.ibManagerReturnReceipt.schema,'fee-console.ib-manager-return-receipt.v2');
  assert.ok(isFeeFinalPublicationProof(await verifyFeeFinalPublication(good.args)));
  assert.ok(validateFeeCalculationReceipt(good.payload.feeCalculationReceipt,good.payload).ok);
  await assert.rejects(verifyFeeFinalPublication({...good.args,ibBaselineSha256:'e'.repeat(64)}),{message:'FEE_PUBLICATION_JENNY_RECEIPT'});
  const oldSource=await fixture({nativeJenny:true,editPayload:async p=>{
    p.ibManagerSourceState.source.sourceAsOf='2026-09-01';
    const {stateId,...body}=p.ibManagerSourceState;
    // Even a recomputed state hash cannot make an old source cutoff valid.
    p.ibManagerSourceState.stateId=await createIbManagerReturnConsumer().digest(body);
  }});
  assert.ok(validateFeeCalculationReceipt(oldSource.payload.feeCalculationReceipt,oldSource.payload).ok);
  assert.equal(JSON.parse(oldSource.healthBytes).dataSha256,sha(oldSource.data));
  await assert.rejects(verifyFeeFinalPublication(oldSource.args),{message:'FEE_PUBLICATION_JENNY_RECEIPT'});
  assert.equal(oldSource.calls.filter(c=>c.url.startsWith(PAGES)).length,2);
});
test('incorrect supplied key fails authenticated decryption',async()=>{await refused({},'DECRYPT',{feeDataKey:Buffer.alloc(32,8).toString('base64url')});});
test('content metadata must bind full decoded Git blob bytes',async()=>{
  for(const mutate of [v=>{v.sha='d'.repeat(40);},v=>{v.size++;},v=>{v.path='other.json';},v=>{v.content+='!';}])
    await refused({editResponse:(url,b)=>{if(!url.includes('/contents/data.json?'))return;const v=JSON.parse(b);mutate(v);return {bytes:json(v)};}},'CONTENT');
});
test('fixed reads fail closed on redirect, HTTP failure, oversize, and malformed JSON',async()=>{
  for(const edit of [{url:'https://example.invalid/'},{redirected:true},{status:403},{headers:{'content-length':'999999999'}},{bytes:Buffer.from('{bad')}])
    await refused({editResponse:()=>edit},'READ');
});
test('transport exception text and credentials are reduced to a closed code',async()=>{
  const f=await fixture();await assert.rejects(verifyFeeFinalPublication({...f.args,fetchImpl:async()=>{throw Error('SYNTHETIC_PRIVATE_SENTINEL');}}),{message:'FEE_PUBLICATION_READ'});
  assert.equal(feePublicationFailureCode(Error('SYNTHETIC_PRIVATE_SENTINEL')),'FEE_PUBLICATION_READ');
  for(const code of FEE_PUBLICATION_CODES)assert.equal(feePublicationFailureCode(Error(code)),code);
});
test('no ambient transport, impossible dates, or malformed configuration enter external IO',async()=>{
  const f=await fixture();for(const changes of [{fetchImpl:undefined},{handoff:{...f.handoff,accountingThrough:'2026-02-30'}},{handoff:undefined},{runMain:'bad'},{feeDataKey:'bad'},{ibBaselineSha256:'bad'},
    {repositoryToken:undefined},{repositoryToken:'short'},{repositoryToken:'synthetic token with spaces 0000'},{clock:()=>new Date('bad')},{previousProof:true}])await assert.rejects(verifyFeeFinalPublication({...f.args,...changes}),{message:'FEE_PUBLICATION_CONFIG'});
  assert.equal(f.calls.length,0);
});

