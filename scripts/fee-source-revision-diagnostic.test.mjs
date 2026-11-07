import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {revisionDiagnosticArgs,validateRevisionDiagnosticEvent,revisionDiagnosticTransport,revisionDiagnosticFailureCode,
  inspectRevisionDiagnostic,createRevisionDiagnosticDirectory,REVISION_DIAGNOSTIC_SCOPE} from './fee-source-revision-diagnostic.mjs';

const MAIN='a'.repeat(40),TARGET='2026-11-06',ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const env=()=>({GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_REF:'refs/heads/main',
  GITHUB_SHA:MAIN,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_ACTOR_ID:'283054367',GITHUB_ACTOR:'huanwujoy-crypto',
  GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'123456789',FEE_REPORT_ACTIONS_TOKEN:'synthetic_read_token_123456789'});
const event=()=>({sender:{id:283054367,login:'huanwujoy-crypto',type:'User'},repository:{full_name:'huanwujoy-crypto/fee-console',owner:{id:283054367},default_branch:'main'},
  inputs:{ib_diagnostic_once:'true',ib_diagnostic_main:MAIN}});
const actualEnv=()=>({...env(),FEE_ECON_GIST_ID:'b'.repeat(32),FEE_DATA_KEY:'c'.repeat(43),FEE_CLOUD_SHARESIGHT_CLIENT_ID:'synthetic-client',
  FEE_CLOUD_SHARESIGHT_CLIENT_SECRET:'synthetic-secret',IB_MANAGER_READ_ENABLED:'true',IB_MANAGER_BASELINE_SHA256:'d'.repeat(64)});
const validate=(overrides={})=>validateRevisionDiagnosticEvent({env:env(),event:event(),expectedMain:MAIN,checkOnly:true,...overrides});
const message=(error)=>revisionDiagnosticFailureCode(error);
const verified=()=>({schema:'fee-console.source-revision-diagnostic-result.v1',status:'verified',targetDate:TARGET});

test('exact CLI arguments have no execution, output-path or module escape',()=>{
  assert.deepEqual(revisionDiagnosticArgs(['--check-plan','--expected-main='+MAIN]),{checkOnly:true,expectedMain:MAIN});
  assert.deepEqual(revisionDiagnosticArgs(['--expected-main='+MAIN]),{checkOnly:false,expectedMain:MAIN});
  for(const args of [[],['--main='+MAIN],['--expected-main='+MAIN,'--execute'],['--expected-main='+MAIN,'--check-plan','--check-plan'],
    ['--expected-main='+MAIN,'--expected-main='+MAIN],['--expected-main='+MAIN.toUpperCase()],['--expected-main='+MAIN,'--out-dir=/tmp/secret']])
    assert.throws(()=>revisionDiagnosticArgs(args),e=>message(e)==='FEE_REVISION_DIAGNOSTIC_ARGUMENT');
});
test('preflight and private stages use the same owner event and exact version',()=>{
  assert.equal(validate(),true);
  assert.equal(validate({env:actualEnv(),checkOnly:false}),true);
  const e=event();Object.assign(e.inputs,{source_plan_check_only:false,source_acceptance_once:'false',run_reviewed_once:false,
    ratio_main:'',ratio_plan:'',source_from:'',source_target:'',source_main:'',manual_sync_completed_for:'',confirmed_main:'',recovery_main:'',report_kind:'',report_target:'',report_markets:''});
  assert.equal(validate({event:e}),true);
});
for(const [field,value] of Object.entries({GITHUB_ACTIONS:'false',GITHUB_REPOSITORY:'other/repo',GITHUB_REF:'refs/heads/branch',GITHUB_SHA:'e'.repeat(40),
  GITHUB_EVENT_NAME:'schedule',GITHUB_ACTOR_ID:'123',GITHUB_ACTOR:'different',GITHUB_TRIGGERING_ACTOR:'other',GITHUB_RUN_ATTEMPT:'2',GITHUB_RUN_ID:'bad',FEE_REPORT_ACTIONS_TOKEN:'invalid'}))
  test('rejects changed execution identity '+field,()=>assert.throws(()=>validate({env:{...env(),[field]:value}})));
test('actual sender and repository ownership are required',()=>{
  for(const mutate of [e=>delete e.sender,e=>e.sender.id=1,e=>e.sender.login='other',e=>e.sender.type='Bot',e=>e.repository.owner.id=1,
    e=>e.repository.full_name='other/repo',e=>e.repository.default_branch='dev',e=>e.inputs.ib_diagnostic_main='e'.repeat(40),e=>e.inputs.ib_diagnostic_once='false']){
    const e=event();mutate(e);assert.throws(()=>validate({event:e}));
  }
});
test('every current production, recovery, source and ratio input is excluded',()=>{
  for(const key of ['ratio_main','ratio_plan','source_from','source_target','source_main','manual_sync_completed_for','confirmed_main','recovery_main','report_kind','report_target','report_markets',
    'source_plan_check_only','source_acceptance_once','run_reviewed_once','unexpected']){
    const e=event();e.inputs[key]='true';assert.throws(()=>validate({event:e}),e=>message(e)==='FEE_REVISION_DIAGNOSTIC_ARGUMENT');
  }
});
test('preflight refuses financial credentials and locators before authorization',()=>{
  for(const key of ['FEE_DATA_KEY','FEE_CLOUD_SHARESIGHT_CLIENT_ID','FEE_CLOUD_SHARESIGHT_CLIENT_SECRET','FEE_ECON_GIST_ID'])
    assert.throws(()=>validate({env:{...env(),[key]:'synthetic'}}));
  for(const key of ['FEE_DATA_KEY','FEE_CLOUD_SHARESIGHT_CLIENT_ID','FEE_CLOUD_SHARESIGHT_CLIENT_SECRET','FEE_ECON_GIST_ID','IB_MANAGER_BASELINE_SHA256']){
    const e=actualEnv();delete e[key];assert.throws(()=>validate({env:e,checkOnly:false}));
  }
});
test('no fallback credentials, process injection or private-file input',()=>{
  for(const key of ['NODE_OPTIONS','NODE_PATH','GH_TOKEN','GITHUB_TOKEN','FEE_CLOUD_GITHUB_TOKEN','FEE_RATIO_MANAGER_TOKEN','FEE_ECON_GITHUB_TOKEN',
    'FEE_ECON_FILE','FEE_ECON_V3_FILE','FEE_IB_DIAGNOSTIC_ACTIONS_TOKEN','LD_PRELOAD','DYLD_INSERT_LIBRARIES'])assert.throws(()=>validate({env:{...env(),[key]:'synthetic'}}));
  assert.throws(()=>validate({execArgv:['--import=./unexpected.mjs']}));
});

function harness(overrides={}){
  const trace=[],cap={async checkCurrent(){trace.push('cap-check');},close(){trace.push('cap-close');}},privateInput={synthetic:true};
  const runtime={async diagnose(){trace.push('diagnose');return verified();},close(){trace.push('runtime-close');}};
  const options={checkOnly:false,assertCurrent(){trace.push('clock');},checkCheckout(){trace.push('checkout');},async authorize(){trace.push('authorize');return cap;},
    async readPrivate(){trace.push('private');return privateInput;},async createRuntime(receivedCap,input){assert.equal(receivedCap,cap);assert.equal(input,privateInput);trace.push('runtime');return runtime;},
    async cleanup(){trace.push('cleanup');},...overrides};
  return {trace,cap,runtime,options};
}
test('preflight verifies authorization and checkout then cleans, never reads private input',async()=>{
  const h=harness({checkOnly:true});const r=await inspectRevisionDiagnostic(h.options);
  assert.equal(r.status,'plan-verified');assert.equal(r.publicationReady,false);assert.equal(r.reportGenerated,false);
  assert.deepEqual(h.trace.filter(x=>x!=='clock'),['checkout','authorize','cap-check','checkout','cap-close','cleanup']);
});
test('successful diagnostic exposes only fixed result and closes every capability',async()=>{
  const h=harness();const r=await inspectRevisionDiagnostic(h.options);
  assert.deepEqual(r,{...verified(),reasonCode:'NONE',reportGenerated:false,publicationReady:false});
  assert.deepEqual(h.trace.filter(x=>x!=='clock'),['checkout','authorize','cap-check','checkout','private','checkout','runtime','diagnose','checkout','runtime-close','cap-close','cleanup']);
});
test('authorization or release failure occurs before any private read',async()=>{
  const h=harness({async authorize(){throw new Error('FEE_REPORT_RECOVERY_RELEASE');}});const r=await inspectRevisionDiagnostic(h.options);
  assert.equal(r.status,'incomplete');assert.equal(r.reasonCode,'FEE_REPORT_RECOVERY_RELEASE');assert.ok(!h.trace.includes('private'));assert.ok(h.trace.includes('cleanup'));
});
test('changed admission is refused before private reads',async()=>{
  const h=harness();h.cap.checkCurrent=async()=>{throw new Error('FEE_REPORT_RECOVERY_CONSUMED');};
  const r=await inspectRevisionDiagnostic(h.options);assert.equal(r.reasonCode,'FEE_REPORT_RECOVERY_CONSUMED');assert.ok(!h.trace.includes('private'));assert.ok(h.trace.includes('cap-close'));
});
test('private failure always cleans partial acquisition and never creates runtime',async()=>{
  const h=harness({async readPrivate(){throw new Error('private-account-value-do-not-log');}});const r=await inspectRevisionDiagnostic(h.options);
  assert.equal(r.reasonCode,'FEE_REVISION_DIAGNOSTIC_FAILED');assert.ok(!h.trace.includes('runtime'));assert.ok(h.trace.includes('cleanup'));assert.doesNotMatch(JSON.stringify(r),/private-account/);
});
test('production-shaped runtime cannot be used for diagnosis',async()=>{
  const h=harness();h.runtime.prepare=async()=>{assert.fail('must not call writer handoff');};
  const r=await inspectRevisionDiagnostic(h.options);assert.equal(r.reasonCode,'FEE_REVISION_DIAGNOSTIC_RESULT');assert.ok(!h.trace.includes('diagnose'));
});
test('unexpected returned payload is rejected without serialization',async()=>{
  const h=harness();h.runtime.diagnose=async()=>({...verified(),payload:'private-value'});
  const r=await inspectRevisionDiagnostic(h.options);assert.equal(r.reasonCode,'FEE_REVISION_DIAGNOSTIC_RESULT');assert.doesNotMatch(JSON.stringify(r),/private-value/);
});
test('business failure remains failure, with no automatic retry',async()=>{
  const h=harness();let attempts=0;h.runtime.diagnose=async()=>{attempts++;throw Error('FEE_REPORT_SOURCE_REVISION_ARTIFACT_SOURCE_CASH_RECONCILIATION');};
  const r=await inspectRevisionDiagnostic(h.options);assert.equal(r.status,'incomplete');assert.equal(attempts,1);assert.ok(h.trace.includes('runtime-close'));assert.ok(h.trace.includes('cleanup'));
});
test('cleanup errors always override apparent success or source failure',async()=>{
  for(const stage of ['runtime','admission','storage']){
    const h=harness();if(stage==='runtime')h.runtime.close=()=>{throw Error('private');};if(stage==='admission')h.cap.close=()=>{throw Error('private');};if(stage==='storage')h.options.cleanup=async()=>{throw Error('private');};
    const r=await inspectRevisionDiagnostic(h.options);assert.equal(r.reasonCode,'FEE_REVISION_DIAGNOSTIC_CLEANUP');assert.equal(r.status,'incomplete');
  }
});
test('arbitrary errors, traps, URLs and text cannot become a public diagnostic',()=>{
  const poison=new Error('https://private.example/token?account=secret');
  for(const e of [poison,{message:'SOURCE_SECRET_VALUE'},new Proxy({}, {get(){assert.fail('proxy accessed');}}),Object.defineProperty({},'message',{get(){assert.fail('getter accessed');}})])
    assert.equal(revisionDiagnosticFailureCode(e),'FEE_REVISION_DIAGNOSTIC_FAILED');
});

test('transport accepts bounded read routes and only the existing OAuth POST',async()=>{
  const calls=[],t=revisionDiagnosticTransport({fetchImpl:async(url,init)=>{calls.push({url,method:init.method,signal:init.signal});return {ok:true};}});
  try{
    for(const url of ['https://api.github.com/repos/huanwujoy-crypto/fee-console/git/ref/heads/main',
      'https://api.github.com/repos/huanwujoy-crypto/fee-console/actions/runs/123456789',
      'https://api.github.com/repos/huanwujoy-crypto/fee-console/actions/runs/123456789/jobs?per_page=100',
      'https://api.github.com/gists/'+'a'.repeat(32),
      'https://productionresultssa1.blob.core.windows.net/actions-results/synthetic?signature=synthetic',
      'https://api.sharesight.com/api/v3/portfolios/123/performance?start_date=2026-11-04&end_date=2026-11-04'])await t.fetch(url,{method:'GET'});
    await t.fetch('https://api.sharesight.com/oauth2/token',{method:'POST',body:'synthetic'});assert.equal(calls.length,7);assert.ok(calls.every(c=>c.signal instanceof AbortSignal));
  }finally{t.close();}
});
for(const [name,url,init] of [
  ['full history','https://api.github.com/repos/huanwujoy-crypto/fee-console/actions/runs?per_page=100',{}],
  ['workflow history','https://api.github.com/repos/huanwujoy-crypto/fee-console/actions/workflows/fee-cloud-producer.yml/runs',{}],
  ['dispatch','https://api.github.com/repos/huanwujoy-crypto/fee-console/actions/workflows/fee-cloud-producer.yml/dispatches',{method:'POST'}],
  ['Gist patch','https://api.github.com/gists/'+'a'.repeat(32),{method:'PATCH'}],
  ['Sharesight write','https://api.sharesight.com/api/v2/holdings',{method:'POST'}],
  ['GET body','https://api.sharesight.com/api/v2/portfolios.json',{body:'unexpected'}],
  ['foreign host','https://example.test/private',{}],
  ['credentials URL','https://user:secret@api.sharesight.com/api/v2/portfolios.json',{}],
  ['outside date','https://api.sharesight.com/api/v3/portfolios/123/performance?end_date=2026-11-03',{}],
  ['future date','https://api.sharesight.com/api/v3/portfolios/123/trades.json?start_date=2026-11-05&end_date=2026-11-07',{}],
])test('transport rejects '+name+' before fetch',async()=>{let calls=0;const t=revisionDiagnosticTransport({fetchImpl:async()=>{calls++;}});try{await assert.rejects(t.fetch(url,init),e=>message(e)==='FEE_REVISION_DIAGNOSTIC_ROUTE');assert.equal(calls,0);}finally{t.close();}});
test('deadline and closed transport block follow-up calls',async()=>{
  let now=10,calls=0;const t=revisionDiagnosticTransport({clock:()=>now,durationMs:100,fetchImpl:async()=>{calls++;return {};}});
  now=110;await assert.rejects(t.fetch('https://api.sharesight.com/api/v2/portfolios.json'),e=>message(e)==='FEE_REVISION_DIAGNOSTIC_EXPIRED');assert.equal(calls,0);t.close();
  await assert.rejects(t.fetch('https://api.sharesight.com/api/v2/portfolios.json'));
});
test('backwards clock refuses further source reads',async()=>{
  let now=100;const t=revisionDiagnosticTransport({clock:()=>now,fetchImpl:async()=>({})});now=99;
  try{await assert.rejects(t.fetch('https://api.sharesight.com/api/v2/portfolios.json'),e=>message(e)==='FEE_REVISION_DIAGNOSTIC_EXPIRED');}finally{t.close();}
});
test('hanging fetch is aborted without retry and resolves fixed timeout',async()=>{
  let calls=0,signal;const t=revisionDiagnosticTransport({durationMs:10,fetchImpl:async(_url,init)=>{calls++;signal=init.signal;return new Promise(()=>{});}});
  // Keep this synthetic test alive; the production watchdog itself is unrefed.
  const keep=setTimeout(()=>{},100);
  try{await assert.rejects(t.fetch('https://api.sharesight.com/api/v2/portfolios.json'),e=>message(e)==='FEE_REVISION_DIAGNOSTIC_EXPIRED');assert.equal(calls,1);assert.equal(signal.aborted,true);}finally{clearTimeout(keep);t.close();}
});
test('private directory is exclusive, owner-only and never removes unexpected files',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'revision-diagnostic-synthetic-'));
  try{
    const d=createRevisionDiagnosticDirectory(root);assert.equal(fs.statSync(d.directory).mode&0o777,0o700);
    assert.throws(()=>createRevisionDiagnosticDirectory(root));fs.writeFileSync(path.join(d.directory,'unexpected'),'synthetic');assert.throws(()=>d.cleanup());
    fs.unlinkSync(path.join(d.directory,'unexpected'));d.cleanup();assert.equal(fs.existsSync(d.directory),false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('symlink collision and repository-contained storage fail closed',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'revision-diagnostic-synthetic-'));
  try{fs.symlinkSync(root,path.join(root,'fee-ib-diagnostic'));assert.throws(()=>createRevisionDiagnosticDirectory(root));assert.throws(()=>createRevisionDiagnosticDirectory(ROOT));}
  finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('CLI invalid argument emits only fixed JSON without reading checkout or accounts',()=>{
  const r=spawnSync(process.execPath,[path.join(ROOT,'scripts/fee-source-revision-diagnostic.mjs'),'--invalid=synthetic-private'],{env:{PATH:process.env.PATH},encoding:'utf8',timeout:10000});
  assert.equal(r.status,1);assert.equal(r.stdout,'');const output=JSON.parse(r.stderr);assert.equal(output.reasonCode,'FEE_REVISION_DIAGNOSTIC_ARGUMENT');assert.doesNotMatch(r.stderr,/synthetic-private|Error:| at /);
});
test('source code has no production invocation, private artifact export or automatic retry',()=>{
  const source=fs.readFileSync(path.join(ROOT,'scripts/fee-source-revision-diagnostic.mjs'),'utf8');
  for(const forbidden of ['produceReportPeriod(',"import('./daily.mjs')",'writeFileSync(','createSigned','claimOnce','dispatchWorkflow','uploadArtifact','readPeriodSourceAttempts('])assert.equal(source.includes(forbidden),false,forbidden);
  assert.match(source,/attempts:1/);assert.match(source,/diagnosticOnly:true/);assert.equal(REVISION_DIAGNOSTIC_SCOPE.targetDate,TARGET);
});
