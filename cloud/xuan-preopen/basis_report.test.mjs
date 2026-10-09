import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {APPROVED_IB_ACCOUNT_ID} from '../../scripts/xuan-ib-run-manifest.mjs';
// All tests use synthetic sources, pure proof verifier and injected context.
// No cloud_io, secret, OAuth, live source, marker, repository write or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareBasisReport} from './basis_report.mjs';
import {sourceHash} from '../../scripts/xuan-ib-night-action-evidence.mjs';
import {associationPolicyBlob} from '../../scripts/xuan-ib-account-association.mjs';
import {extractNightActionModel,renderNightActionReport} from '../../scripts/xuan-ib-night-action-view.mjs';
import {validateNightActionHtml} from '../../scripts/xuan-ib-night-action-guard.mjs';
const clock=Date.parse('2026-10-08T05:00:00.000Z'),iso=new Date(clock).toISOString();
function fixture({sourceDate='2026-10-07',captureClock=clock,expiresAt='2026-10-10T13:30:00.000Z',claimedAccountId=APPROVED_IB_ACCOUNT_ID}={}) {
  const iso=new Date(captureClock).toISOString();
  const policy={schemaVersion:1,policyId:'ib-primary-7day-pilot-v1',accountAlias:'IB-HK',basis:'owner-attested-recurring-v1',status:'active',purpose:'xuan-ib-read-only-report',editions:['adhoc','am','pm'],publisher:'codex-verified-candidate-v1',validFrom:'2026-09-11T13:30:00.000Z',expiresAt};
  const context={association:{policy,policyCommit:'a'.repeat(40),policyBlob:associationPolicyBlob(policy),checkedAt:iso},previousSourceSha:'b'.repeat(40)};
  const cashRow=(currency)=>({currency,levelOfDetail:currency==='BASE_SUMMARY'?'BaseCurrency':'Currency',level_of_detail:currency==='BASE_SUMMARY'?'BaseCurrency':'Currency',fromDate:'2026-09-08',toDate:sourceDate,endingCash:'0',endingSettledCash:'0'});
  const payload={schema_version:1,source:'IBKR Flex Web Service',query_id:'1630084',query_name:'IB_Cash_Reconciliation_ReadOnly',period:'Last30CalendarDays',base_currency:'USD',base_currency_provenance:'uniform_conversion_rate_target',from_date:'2026-09-08',to_date:sourceDate,report_sha256:'c'.repeat(64),report_content_sha256:'d'.repeat(64),raw_size:1000,transport_verified:true,query_id_provenance:'fixed_service_request_and_query_name',archive:{status:'VERIFIED',object_key:`reports/${'c'.repeat(64)}.xml`,public_access:false},generated_at:'2026-10-08;08:15:00',generation_timezone:null,cash_reports:[cashRow('BASE_SUMMARY'),cashRow('USD')],source_integrity:{tolerance:'0.01',unknown_event_types_pending:[],cash_categories_without_detail_mapping:[],cash_identities:[{currency:'BASE_SUMMARY',segment:'total',residual:'0'},{currency:'USD',segment:'total',residual:'0'}],event_aggregates:[{currency:'USD',cash_field:'dividends',residual:'0'}],base_closing_translations:[{cash_field:'endingCash',residual:'0'},{cash_field:'endingSettledCash',residual:'0'}]}};
  const capture={startedAt:iso,completedAt:iso};
  // Freeze an out-of-band synthetic oracle before callers can alter sources.
  // Comparing received self-declared fields is not producer authentication.
  const expected={scrubbedPayloadHash:sourceHash(payload),reportSha256:payload.report_sha256,reportContentSha256:payload.report_content_sha256,archiveObject:payload.archive.object_key,accountAlias:'IB-HK',expectedAccountId:claimedAccountId,policyBlob:context.association.policyBlob,captureHash:sourceHash(capture),sourceDate};
  const trusted=JSON.stringify(expected),signature=crypto.createHmac('sha256','SYNTHETIC-BASIS-TEST-ONLY').update(trusted).digest('hex');
  const envelope={report:payload,capture,proof:signature};
  const cash={sourceKey:'flex.cash',raw:envelope,startedAt:iso,completedAt:iso};
  const source=(sourceKey,report)=>({sourceKey,raw:{report},startedAt:iso,completedAt:iso});
  const sharesight=[source('sharesight.ibGroupedPerformance',{portfolio_id:936247,currency:{code:'USD'},grouping:'custom_group_category',custom_group:{id:83569,name:'资产类别'},end_date:sourceDate,holdings:['美国底仓','美国科技','非美发达','新兴市场'].map((group_name,i)=>({id:i+1,group_name,value:[450,200,230,120][i],instrument:{code:['CSPX','GOOG','EXUS','EIMI'][i]}}))}),source('sharesight.noahPerformance',{portfolio_id:936238,currency:{code:'USD'},end_date:sourceDate,cash_accounts:[{value:50}]})];
  const calls=[];
  const options={enabled:true,sourceDate,now:()=>captureClock,loadContext:async()=>structuredClone(context),produceCash:async()=>{calls.push('cash');return cash;},produceSharesight:async()=>{calls.push('ss');return sharesight;},verifyCashProof:(proof,expected)=>proof===signature&&JSON.stringify(expected)===trusted};
  const guard={snapshot:context.association,previousSourceSha:context.previousSourceSha,now:captureClock,allowBasis:true,requireBound:true};
  return {context,payload,envelope,cash,sharesight,calls,options,guard};
}
test('basis prepares with both sources and no MCP; zero statement cash remains valid',async()=>{
  const f=fixture(),result=await prepareBasisReport(f.options),m=extractNightActionModel(result.html);
  assert.equal(result.publication,'none');assert.equal(result.scheduler,'none');assert.equal(m.report.cash.amount,0);
  assert.deepEqual(f.calls,['cash','ss']);assert.equal(validateNightActionHtml(result.html,'2026-10-08',f.guard).status,'basis');
  for(const text of ['本轮挂单未取得','估值来源日','覆盖日','取得时间','Sharesight 现金估值'])assert.ok(result.html.includes(text));
  for(const forbidden of ['buyingPower','planning','orderReserve','totalCapacity','projectedMarketValue','可补仓现金','全部弹药','更新中','旧挂单'])assert.ok(!result.html.includes(forbidden));
  assert.ok(!JSON.stringify(m).includes('proof'));assert.ok(!JSON.stringify(m).includes('payloadHash'));assert.ok(!JSON.stringify(m).includes(APPROVED_IB_ACCOUNT_ID));
});
test('default off and missing producers perform no reads or persistence',async()=>{
  const f=fixture();delete f.options.enabled;await assert.rejects(prepareBasisReport(f.options),/DISABLED/);assert.deepEqual(f.calls,[]);
  f.options.enabled=true;delete f.options.verifyCashProof;await assert.rejects(prepareBasisReport(f.options),/PRODUCERS_REQUIRED/);assert.deepEqual(f.calls,[]);
});
test('unknown cash, malformed/future/stale dates, incompatible currency/basis and self asserted proof fail',async()=>{
  for(const mutate of [p=>delete p.cash_reports[0].endingCash,p=>p.cash_reports[0].endingCash=null,p=>p.cash_reports[0].endingCash=0,p=>p.cash_reports[0].endingCash='-1',p=>p.base_currency='HKD',p=>p.query_id='1650083',p=>p.to_date='2026-10-08',p=>p.to_date='2026-10-06',p=>p.accountID='U-PRIVATE',p=>p.archive.public_access=true,p=>p.source_integrity.unknown_event_types_pending=['Unknown'],p=>p.source_integrity.cash_identities[0].residual='0.02']){
    const f=fixture();mutate(f.payload);await assert.rejects(prepareBasisReport(f.options));
  }
  for(const completedAt of ['2026-10-08T05:01:00.000Z','2026-10-08T04:00:00.000Z']){const f=fixture();f.envelope.capture.completedAt=completedAt;await assert.rejects(prepareBasisReport(f.options));}
  const f=fixture();f.options.verifyCashProof=()=>false;await assert.rejects(prepareBasisReport(f.options),/PROOF_INVALID/);
});
test('cash raw hash and normalized amount alteration cannot reuse producer proof',async()=>{
  for(const key of ['report_content_sha256','cash']){const f=fixture();if(key==='cash')f.payload.cash_reports[0].endingCash='1';else f.payload[key]='e'.repeat(64);await assert.rejects(prepareBasisReport(f.options),/PROOF_INVALID/);}
});
test('wrong Sharesight scope/date and unavailable sources fail; upstream bodies are sanitized',async()=>{
  for(const mutate of [r=>r.portfolio_id=1,r=>r.end_date='2026-10-06',r=>r.currency.code='HKD',r=>r.holdings[0].group_name='unknown']){
    const f=fixture();mutate(f.sharesight[0].raw.report);await assert.rejects(prepareBasisReport(f.options));
  }
  const f=fixture();f.options.produceCash=async()=>{throw new Error('token=PRIVATE accountID=PRIVATE responsebody=PRIVATE');};
  await assert.rejects(prepareBasisReport(f.options),e=>e.message==='BASIS_SOURCE_FAILED');
});
test('formal guard stays fail closed for basis despite successful synthetic preparation',async()=>{
  const f=fixture(),r=await prepareBasisReport(f.options);await assert.rejects(async()=>validateNightActionHtml(r.html,'2026-10-08',{...f.guard,allowBasis:false}),/BASIS_MODE_DISABLED/);
});
test('queued expiry, revocation, policy change, previous-anchor change, timeout and future completion fail',async()=>{
  const f=fixture(),r=await prepareBasisReport(f.options);
  for(const mutate of [g=>{g.now=Date.parse('2026-10-10T13:30:00.000Z');g.snapshot.checkedAt=new Date(g.now).toISOString();},g=>{g.snapshot.policy.status='revoked';g.snapshot.policyBlob=associationPolicyBlob(g.snapshot.policy);},g=>{g.snapshot.policy.editions=['adhoc'];g.snapshot.policyBlob=associationPolicyBlob(g.snapshot.policy);},g=>g.previousSourceSha='d'.repeat(40),g=>{g.now+=1800001;g.snapshot.checkedAt=new Date(g.now).toISOString();},g=>g.now-=1]){
    const g=structuredClone(f.guard);mutate(g);assert.throws(()=>validateNightActionHtml(r.html,'2026-10-08',g));
  }
  const m=extractNightActionModel(r.html);m.evidence.captureStartedAt='2026-10-08T04:54:59.000Z';
  assert.throws(()=>validateNightActionHtml(renderNightActionReport(m),'2026-10-08',f.guard),/CAPTURE_STALE/);
});
test('HTML, source hashes, report values and capability additions cannot pass deterministic evidence',async()=>{
  const f=fixture(),r=await prepareBasisReport(f.options);assert.throws(()=>validateNightActionHtml(r.html.replace('本轮挂单未取得','无挂单'),'2026-10-08',f.guard),/NONDETERMINISTIC/);
  for(const mutate of [m=>m.evidence.sources[0].rawHash='e'.repeat(64),m=>m.report.cash.amount=99,m=>m.report.cash.planning=99,m=>m.report.accountID='PRIVATE',m=>m.report.orders={status:'ready',buys:[],sells:[]}]){
    const m=extractNightActionModel(r.html);mutate(m);assert.throws(()=>renderNightActionReport(m));
  }
});
test('association is rechecked after preparation and cannot change under the producer',async()=>{
  const f=fixture();let reads=0;f.options.loadContext=async()=>{const c=structuredClone(f.context);if(++reads===2){c.association.policy.status='revoked';c.association.policyBlob=associationPolicyBlob(c.association.policy);}return c;};
  await assert.rejects(prepareBasisReport(f.options),/revoked|changed/);
});

test('queue policy expiry is checked independently while capture is still fresh',async()=>{
  const expiry=clock+60000,f=fixture({expiresAt:new Date(expiry).toISOString()}),r=await prepareBasisReport(f.options);
  const snapshot=structuredClone(f.context.association);snapshot.checkedAt=new Date(expiry).toISOString();
  assert.throws(()=>validateNightActionHtml(r.html,'2026-10-08',{...f.guard,snapshot,now:expiry}),/expired/);
});
test('generation marker stays timezone unknown and receipt/source interval cannot be substituted',async()=>{
  const f=fixture(),r=await prepareBasisReport(f.options);assert.match(r.html,/来源未提供时区/);
  assert.equal(extractNightActionModel(r.html).report.cash.generationTimezone,null);
  f.cash.completedAt='2026-10-08T04:59:59.000Z';await assert.rejects(prepareBasisReport(f.options),/CAPTURE_BINDING/);
});

test('review regression: evidence source date must be real, match visible data and match previous NYSE target',async()=>{
  const f=fixture(),out=await prepareBasisReport(f.options);
  for(const sourceDate of ['2026-00-00','2026-02-30','2026-10-06']){
    const m=extractNightActionModel(out.html);m.evidence.sourceDate=sourceDate;
    assert.throws(()=>renderNightActionReport(m),/SHAPE|SOURCE_DATE/);
  }
  const old=extractNightActionModel(out.html);old.evidence.sourceDate='2026-10-06';old.report.sourceDate='2026-10-06';old.report.cash.coverageDate='2026-10-06';old.report.noahCash.valuationDate='2026-10-06';old.evidence.reportHash=sourceHash(old.report);
  assert.throws(()=>renderNightActionReport(old),/SOURCE_DATE_NOT_CALENDAR_TARGET/);
  // Keep the calendar target valid, but alter only the visible statement date.
  const m=extractNightActionModel(out.html);m.report.sourceDate='2026-10-06';m.report.cash.coverageDate='2026-10-06';m.report.noahCash.valuationDate='2026-10-06';m.evidence.reportHash=sourceHash(m.report);
  assert.throws(()=>renderNightActionReport(m),/VISIBLE_SOURCE_DATE_BINDING/);
});
test('review regression: all visible acquisition timestamps must equal their own source completion',async()=>{
  const f=fixture(),out=await prepareBasisReport(f.options);
  for(const change of [m=>m.report.cash.acquiredAt='2026-01-01T00:00:00.000Z',m=>m.report.sharesightAcquiredAt='2026-01-01T00:00:00.000Z',m=>m.report.noahCash.acquiredAt='2026-01-01T00:00:00.000Z']){
    const m=extractNightActionModel(out.html);change(m);m.evidence.reportHash=sourceHash(m.report);
    assert.throws(()=>renderNightActionReport(m),/VISIBLE_ACQUISITION_BINDING/);
  }
});
test('review regression: capture start and completion HKT day must match the report day',async()=>{
  const f=fixture(),out=await prepareBasisReport(f.options);
  for(const change of [m=>{m.dataDate='2026-10-07';m.report.dataDate='2026-10-07';},m=>m.evidence.captureStartedAt='2026-10-07T15:59:59.000Z',m=>m.evidence.captureCompletedAt='2026-10-08T16:00:00.000Z']){
    const m=extractNightActionModel(out.html);change(m);m.evidence.reportHash=sourceHash(m.report);
    assert.throws(()=>renderNightActionReport(m),/CAPTURE_REPORT_DAY_BINDING/);
  }
});
test('review regression: all-matching old source date is rejected before either producer or context lookup',async()=>{
  const f=fixture({sourceDate:'2026-10-06'});let contexts=0;
  f.options.loadContext=async()=>{contexts++;return f.context;};
  await assert.rejects(prepareBasisReport(f.options),/SOURCE_DATE_NOT_TARGET/);
  assert.deepEqual(f.calls,[]);assert.equal(contexts,0);
});
test('closed report days and unsupported calendar coverage reject before reading anything',async()=>{
  for(const day of ['2026-10-03','2026-04-03','2026-12-25','2027-01-04']){
    const f=fixture();f.options.now=()=>Date.parse(`${day}T05:00:00.000Z`);let contexts=0;
    f.options.loadContext=async()=>{contexts++;return f.context;};
    await assert.rejects(prepareBasisReport(f.options),/DAY_NOT_ELIGIBLE|CALENDAR/);
    assert.deepEqual(f.calls,[]);assert.equal(contexts,0);
  }
});
test('fresh receipt preserves statement coverage and acquisition time without turning zero cash into missing',async()=>{
  const old=fixture(),fresh=fixture({captureClock:clock+60000});
  const a=extractNightActionModel((await prepareBasisReport(old.options)).html).report;
  const b=extractNightActionModel((await prepareBasisReport(fresh.options)).html).report;
  assert.equal(a.cash.amount,0);assert.equal(b.cash.amount,0);assert.equal(a.cash.coverageDate,b.cash.coverageDate);
  assert.equal(a.cash.generatedAt,b.cash.generatedAt);assert.equal(b.cash.acquiredAt,new Date(clock+60000).toISOString());
  assert.equal(b.sharesightAcquiredAt,b.cash.acquiredAt);assert.equal(b.noahCash.acquiredAt,b.cash.acquiredAt);
});
test('independent immutable oracle rejects mutated XML, content, capture, policy, payload, self proof and wrong private account',async()=>{
  for(const mutate of [f=>f.payload.cash_reports[0].endingCash='1',f=>{f.payload.report_sha256='e'.repeat(64);f.payload.archive.object_key=`reports/${f.payload.report_sha256}.xml`;},f=>f.payload.report_content_sha256='e'.repeat(64),f=>{f.envelope.capture.startedAt='2026-10-08T04:59:59.000Z';f.cash.startedAt=f.envelope.capture.startedAt;},f=>{f.context.association.policy.expiresAt='2026-10-09T13:30:00.000Z';f.context.association.policyBlob=associationPolicyBlob(f.context.association.policy);},f=>f.envelope.proof={verified:true,report:f.payload}]){
    const f=fixture();mutate(f);await assert.rejects(prepareBasisReport(f.options),/PROOF_INVALID/);
  }
  const wrong=fixture({claimedAccountId:'SYNTHETIC-WRONG-ACCOUNT'});await assert.rejects(prepareBasisReport(wrong.options),/PROOF_INVALID/);
});
test('final evidence verifier loads with only trusted scripts dependencies and no cloud directory',async()=>{
  const f=fixture(),out=await prepareBasisReport(f.options),m=extractNightActionModel(out.html);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'basis-trusted-scripts-'));
  try {
    for(const file of ['xuan-ib-night-action-evidence.mjs','xuan-ib-account-association.mjs','xuan-ib-preopen-calendar.mjs'])fs.copyFileSync(new URL(`../../scripts/${file}`,import.meta.url),path.join(dir,file));
    const {verifyBoundPublication}=await import(pathToFileURL(path.join(dir,'xuan-ib-night-action-evidence.mjs')));
    assert.equal(verifyBoundPublication(m,f.guard).status,'basis');
    const old=structuredClone(m);old.evidence.sourceDate='2026-10-06';
    assert.throws(()=>verifyBoundPublication(old,f.guard),/SOURCE_DATE_NOT_CALENDAR_TARGET/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('distinct source completions remain distinct in the page and cannot be swapped',async()=>{
  const f=fixture();let reads=0;f.options.now=()=>++reads<=4?clock:clock+3000;
  f.sharesight[0].completedAt=new Date(clock+1000).toISOString();f.sharesight[1].completedAt=new Date(clock+2000).toISOString();
  const out=await prepareBasisReport(f.options),m=extractNightActionModel(out.html);
  assert.equal(m.report.cash.acquiredAt,iso);assert.equal(m.report.sharesightAcquiredAt,f.sharesight[0].completedAt);assert.equal(m.report.noahCash.acquiredAt,f.sharesight[1].completedAt);
  [m.report.sharesightAcquiredAt,m.report.noahCash.acquiredAt]=[m.report.noahCash.acquiredAt,m.report.sharesightAcquiredAt];m.evidence.reportHash=sourceHash(m.report);
  assert.throws(()=>renderNightActionReport(m),/VISIBLE_ACQUISITION_BINDING/);
});
