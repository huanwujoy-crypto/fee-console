// Synthetic original evidence only. No transport or financial credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {syntheticOfficialSource} from './fee-ratio-official-source.test.mjs';
import {createOfficialRatioSourceCore} from './fee-ratio-official-source.mjs';
import {createRankedExposureCore} from './xuan-ib-sharesight-exposure.mjs';
import {createRatioSourceCore} from './fee-ratio-source-core.mjs';
import {collectRatioSourceInput,prepareCollectedRatioInput,ratioCollectionReadiness,ratioCollectionFailureCode,parseRatioWorkbook,ratioWorkbookFailureCode,parseRatioWorkbookSet,RATIO_XLSX_ROLES,assessRatioWorkbookSources,createRatioWorkbookSession,planRatioReportControls,assessRatioReportControls} from './fee-ratio-source-collector.mjs';
import {validateRatioCollection} from './fee-manager-refresh.mjs';

const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const now=()=>new Date('2026-10-30T06:00:00.000Z');
const scoped=raw=>({...createRankedExposureCore(),ALL_TOGETHER_SCOPE_SHA256:hash(JSON.stringify([...raw.accounts].sort()))});
function original(withPerformance=true){
  const allocation=syntheticOfficialSource();
  if(!withPerformance)return allocation;
  const member=allocation.classification.positions[0];
  return {schemaVersion:'sharesight-private-performance-v1',accounts:[...allocation.accounts],allocation,
    performanceCapturedAt:'2026-10-30T05:50:00.000Z',
    performance:{schema:'fee-console.ratio-performance-source.v2',provider:'Sharesight',currency:'USD',asOf:'2026-10-30',accounts:[...allocation.accounts],reports:['all','oneYear'].map((period,i)=>({
      period,startDate:i?'2025-10-30':'2020-01-02',endDate:'2026-10-30',includeClosed:true,calculationMethod:'sharesight-native',currency:'USD',cashPerformance:'unknown',
      source:{libraryFileId:'libfile_'+String(i+4).repeat(32),version:0,sha256:String(i+4).repeat(64),locator:'Synthetic native total cells'},
      rows:[{scope:{type:'classification',name:'PE/VC',parent:null},members:[{account:member.account,market:member.market,securityCode:member.securityCode}],sourceSheet:'Synthetic Combined',sourceRow:9,returnPct:i?-2.1:8.25,unit:i?'period':'p.a.',termEvidence:{type:'unknown'}}],unavailable:[],
    }))},
  };
}
function args(raw=original(),extra={}){
  const originalBytes=Buffer.from(JSON.stringify(raw));
  return {originalBytes,expectedSha256:hash(originalBytes),exposureCore:extra.exposureCore??scoped(raw),now:now(),...extra};
}
const rejects=(fn,code)=>assert.throws(fn,e=>ratioCollectionFailureCode(e)==='RATIO_COLLECTION_'+code);

test('unconfigured acquisition returns explicit gaps without falling back to global fetch',async()=>{
  const previous=globalThis.fetch;let calls=0;
  globalThis.fetch=()=>{calls++;throw Error('Unexpected financial read');};
  try{
    const r=await collectRatioSourceInput();
    assert.equal(r.status,'BLOCKED');assert.equal(r.automaticCollectionReady,false);assert.equal(r.publicationReady,false);
    assert.ok(r.blockers.includes('OFFICIAL_EXPOSURE_TRANSPORT_UNVERIFIED'));assert.equal(calls,0);
    r.blockers.pop();assert.equal(ratioCollectionReadiness().blockers.length,4);
  }finally{globalThis.fetch=previous;}
});
test('complete official plus native performance evidence prepares the existing v3 input exactly',()=>{
  const a=args(),raw=JSON.parse(a.originalBytes),r=prepareCollectedRatioInput(a),input=JSON.parse(Buffer.from(r.inputBytes));
  const expected={...createOfficialRatioSourceCore().build(raw.allocation,{sourceSha256:a.expectedSha256,sourceBytes:a.originalBytes.length}).input,schema:'fee-console.ratio-sources.v3',performance:raw.performance};
  assert.deepEqual(input,expected);assert.equal(r.inputSha256,hash(r.inputBytes));assert.equal(r.sourceSha256,hash(r.originalBytes));
  assert.deepEqual(r.sourceDates,{classification:'2026-10-29',exposure:'2026-10-30',performance:'2026-10-30'});
  assert.equal(r.earliestCapturedAt,'2026-10-30T05:28:49.118Z');
  assert.equal(r.status,'PREPARED_UNAUTHENTICATED');assert.equal(r.publicationReady,false);assert.equal(r.downloadVerified,false);assert.equal(r.performanceIncluded,true);
  const core=createRatioSourceCore(accounts=>hash(JSON.stringify([...accounts].sort())));
  assert.doesNotThrow(()=>core.verifyBrowserSourceAssociations(raw,input,{scopeHash:a.exposureCore.ALL_TOGETHER_SCOPE_SHA256,now:a.now}));
});
test('allocation-only intake requires an explicit partial request and never fabricates returns',()=>{
  const a=args(original(false));rejects(()=>prepareCollectedRatioInput(a),'PERFORMANCE_REQUIRED');
  const r=prepareCollectedRatioInput({...a,requirePerformance:false}),input=JSON.parse(Buffer.from(r.inputBytes));
  assert.equal(r.performanceIncluded,false);assert.equal(input.schema,'fee-console.ratio-sources.v2');assert.equal(Object.hasOwn(input,'performance'),false);
  assert.equal(r.publicationReady,false);
});
test('published/prepared output, API JSON and incomplete summaries cannot substitute for complete originals',()=>{
  for(const raw of [{report:{total_gain_percent:8.25}}, {schema:'fee-console.ratio-sources.v3'}, {schemaVersion:'sharesight-private-full-v1'}, {schemaVersion:'sharesight-private-performance-v1',allocation:{}}]){
    rejects(()=>prepareCollectedRatioInput(args(raw,{requirePerformance:false,exposureCore:createRankedExposureCore()})),'OFFICIAL_ORIGINAL_REQUIRED');
  }
});
test('default intake enforces the registered All Together scope rather than trusting ten arbitrary accounts',()=>{
  rejects(()=>prepareCollectedRatioInput({...args(),exposureCore:createRankedExposureCore()}),'SOURCE_CONTRACT');
});
test('pin, JSON and preflight errors stop before source IO and failures expose only fixed codes',async()=>{
  const a=args();rejects(()=>prepareCollectedRatioInput({...a,expectedSha256:'0'.repeat(64)}),'HASH');
  for(const originalBytes of [Buffer.from('{"x":1,"x":2}'),Buffer.from([0xff]),Buffer.from('{} trailing')]){
    rejects(()=>prepareCollectedRatioInput({...a,originalBytes,expectedSha256:hash(originalBytes)}),'JSON');
  }
  let reads=0;
  for(const extra of [{expectedSha256:'invalid'},{requirePerformance:'false'},{clock:null},{clock:()=>new Date('invalid')}]){
    await assert.rejects(collectRatioSourceInput({readOriginal:async()=>{reads++;return a.originalBytes;},expectedSha256:a.expectedSha256,...extra}),e=>ratioCollectionFailureCode(e)==='RATIO_COLLECTION_INPUT');
  }
  assert.equal(reads,0);assert.equal(ratioCollectionFailureCode(Error('private response')),'RATIO_COLLECTION_REFUSED');
});
test('missing rows, wrong dates, false completeness and invalid performance refuse the full bundle',()=>{
  for(const edit of [
    r=>r.allocation.exposure.rows.pop(),r=>r.allocation.classification.positions.pop(),
    r=>r.allocation.coverage.exposureCombinedComplete=false,
    r=>r.allocation.exposure.asOf='2026-10-29',
    r=>r.performance.reports[0].includeClosed=false,r=>r.performance.accounts.pop(),
    r=>r.performanceCapturedAt='2026-10-27T00:00:00.000Z',
    r=>r.performanceCapturedAt='2026-10-31T00:00:00.000Z',
    r=>r.accounts.reverse(),r=>r.performance.asOf='2026-10-31',
  ]){const raw=original();edit(raw);rejects(()=>prepareCollectedRatioInput(args(raw)),'SOURCE_CONTRACT');}
});
test('source freshness and Hong Kong dates are checked without renewing the original capture',()=>{
  for(const at of ['2026-10-30T05:30:00.000Z','2026-11-01T00:00:00.000Z'])rejects(()=>prepareCollectedRatioInput(args(original(),{now:new Date(at)})),'SOURCE_CONTRACT');
  const r=prepareCollectedRatioInput(args());assert.equal(r.earliestCapturedAt,'2026-10-30T05:28:49.118Z');
});
test('reader is called once, never retried after a denial, and remote text is discarded',async()=>{
  let calls=0;
  await assert.rejects(collectRatioSourceInput({expectedSha256:'a'.repeat(64),clock:now,readOriginal:async()=>{calls++;throw Error('403 private-token private-path');}}),e=>{
    assert.equal(e.message,'RATIO_COLLECTION_READ');assert.doesNotMatch(String(e),/403|private/);return true;
  });assert.equal(calls,1);
});
test('completion clock catches expiry during reading and refuses clock reversal',async()=>{
  const a=args();let calls=0;
  const run=times=>collectRatioSourceInput({expectedSha256:a.expectedSha256,exposureCore:a.exposureCore,clock:()=>new Date(times.shift()),readOriginal:async()=>{calls++;return a.originalBytes;}});
  await assert.rejects(run(['2026-10-30T06:00:00.000Z','2026-11-01T00:00:00.000Z']),e=>ratioCollectionFailureCode(e)==='RATIO_COLLECTION_SOURCE_CONTRACT');
  await assert.rejects(run(['2026-10-30T06:00:00.000Z','2026-10-30T05:59:59.000Z']),e=>ratioCollectionFailureCode(e)==='RATIO_COLLECTION_CLOCK');
  const r=await run(['2026-10-30T06:00:00.000Z','2026-10-30T06:01:00.000Z']);assert.equal(r.publicationReady,false);assert.equal(calls,3);
});
test('return buffers do not alias caller evidence or mutate its original capture metadata',()=>{
  const a=args(),before=Buffer.from(a.originalBytes),r=prepareCollectedRatioInput(a);
  r.originalBytes.fill(0);r.inputBytes.fill(0);assert.deepEqual(a.originalBytes,before);
});
test('size, timestamp and schema extensions fail rather than silently dropping material',()=>{
  const a=args();
  for(const edit of [r=>r.extra=true,r=>r.allocation.coverage.extra=true,r=>r.performance.reports[0].source.extra=true]){const raw=original();edit(raw);rejects(()=>prepareCollectedRatioInput(args(raw)),'SOURCE_CONTRACT');}
  rejects(()=>prepareCollectedRatioInput({...a,originalBytes:Buffer.alloc(5*1024*1024+1)}),'INPUT');
});
test('invalid bounds, signals and throwing clocks stop before reading without leaking raw text',async()=>{
  let reads=0;
  for(const extra of [{timeoutMs:0},{timeoutMs:30_001},{timeoutMs:1.5},{signal:{}},{clock:()=>{throw Error('private clock');}}]){
    await assert.rejects(collectRatioSourceInput({readOriginal:()=>{reads++;},expectedSha256:'a'.repeat(64),clock:now,...extra}),e=>{
      assert.equal(ratioCollectionFailureCode(e),'RATIO_COLLECTION_INPUT');assert.doesNotMatch(String(e),/private/);return true;
    });
  }assert.equal(reads,0);
});
test('a cancelled request never starts a read or retries it',async()=>{
  const controller=new AbortController();controller.abort();let reads=0;
  await assert.rejects(collectRatioSourceInput({readOriginal:()=>{reads++;},expectedSha256:'a'.repeat(64),clock:now,signal:controller.signal}),e=>ratioCollectionFailureCode(e)==='RATIO_COLLECTION_ABORTED');
  assert.equal(reads,0);
});
test('deadline bounds an uncooperative reader and a late response cannot prepare an input',async()=>{
  const a=args();let signal,finish,reads=0;
  const result=collectRatioSourceInput({expectedSha256:a.expectedSha256,clock:now,timeoutMs:10,exposureCore:a.exposureCore,readOriginal:options=>{
    signal=options.signal;reads++;return new Promise(resolve=>{finish=resolve;});
  }});
  await assert.rejects(result,e=>ratioCollectionFailureCode(e)==='RATIO_COLLECTION_TIMEOUT');
  assert.equal(signal.aborted,true);assert.equal(reads,1);finish(a.originalBytes);
  await assert.rejects(result,e=>ratioCollectionFailureCode(e)==='RATIO_COLLECTION_TIMEOUT');
});
test('cancellation aborts a pending read once and removes its listener after success',async()=>{
  const a=args(),controller=new AbortController();let reads=0,readerSignal;
  await assert.rejects(collectRatioSourceInput({expectedSha256:a.expectedSha256,clock:now,signal:controller.signal,readOriginal:({signal})=>{
    reads++;readerSignal=signal;queueMicrotask(()=>controller.abort());return new Promise(()=>{});
  }}),e=>ratioCollectionFailureCode(e)==='RATIO_COLLECTION_ABORTED');
  assert.equal(reads,1);assert.equal(readerSignal.aborted,true);
  const completed=new AbortController();
  const r=await collectRatioSourceInput({expectedSha256:a.expectedSha256,clock:now,signal:completed.signal,exposureCore:a.exposureCore,readOriginal:({signal})=>{readerSignal=signal;return a.originalBytes;}});
  assert.equal(r.status,'PREPARED_UNAUTHENTICATED');completed.abort();assert.equal(readerSignal.aborted,false);
});
test('completion clock exceptions become fixed refusals after one read',async()=>{
  const a=args();let clocks=0,reads=0;
  await assert.rejects(collectRatioSourceInput({expectedSha256:a.expectedSha256,exposureCore:a.exposureCore,clock:()=>{if(clocks++)throw Error('private clock response');return now();},readOriginal:()=>{reads++;return a.originalBytes;}}),e=>{
    assert.equal(ratioCollectionFailureCode(e),'RATIO_COLLECTION_CLOCK');assert.doesNotMatch(String(e),/private/);return true;
  });assert.equal(reads,1);
});

const syntheticXlsxBytes=Buffer.from('Fictional archive bytes for transport tests only');
const xlsxArgs=()=>({workbookBytes:syntheticXlsxBytes,expectedSha256:hash(syntheticXlsxBytes),profile:{kind:'classification'},now:now()});
function parserProcess({hang=false,output,code=0,stderr=null,processError=false}={}){
  const state={calls:0,kills:0,request:null,command:null,args:null,options:null};
  const spawnImpl=(command,args,options)=>{
    state.calls++;Object.assign(state,{command,args,options});
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
    child.kill=signal=>{assert.equal(signal,'SIGKILL');state.kills++;};
    child.stdin.end=bytes=>{
      state.request=JSON.parse(Buffer.from(bytes));
      if(hang)return;
      queueMicrotask(()=>{
        if(processError)return child.emit('error',Error('Fictional private process message'));
        if(stderr)child.stderr.emit('data',Buffer.from(stderr));
        const profile=JSON.parse(state.request.profileJson);
        const value={schema:'fee-console.ratio-xlsx-preview.v1',status:'PARSED_UNAUTHENTICATED',kind:profile.kind,
          publicationReady:false,sourceVerified:false,completenessVerified:false,
          metadata:{asOf:'2026-10-30',currency:'USD'},rows:[{sourceRow:11}],rowCount:1,additionalWorksheetCount:0,
          workbookSha256:state.request.workbookSha256,profileSha256:hash(Buffer.from(state.request.profileJson))};
        const text=typeof output==='function'?output(value):output??JSON.stringify(value);
        child.stdout.emit('data',Buffer.from(text));child.emit('close',code);
      });
    };
    return child;
  };
  return {state,spawnImpl};
}
test('XLSX parser child gets fixed command, isolated Python, minimal environment and pinned pipe input',async()=>{
  const p=parserProcess();const r=await parseRatioWorkbook({...xlsxArgs(),spawnImpl:p.spawnImpl});
  assert.equal(r.publicationReady,false);assert.equal(r.sourceVerified,false);assert.equal(r.completenessVerified,false);
  assert.equal(p.state.command,'/usr/bin/python3');assert.equal(p.state.args[0],'-I');assert.ok(p.state.args[1].endsWith('/fee-ratio-xlsx.py'));
  assert.deepEqual(Object.keys(p.state.options.env).sort(),['LANG','PATH','PYTHONIOENCODING']);
  assert.deepEqual(p.state.options.stdio,['pipe','pipe','pipe']);assert.equal(p.state.request.workbookSha256,hash(syntheticXlsxBytes));
  assert.equal(p.state.request.now,now().toISOString());assert.equal(p.state.calls,1);assert.equal(p.state.kills,0);
});
test('XLSX hash, profile, size and cancellation preflight errors do not launch a child',async()=>{
  const p=parserProcess(),cancelled=new AbortController();cancelled.abort();
  for(const [edit,code]of [[{expectedSha256:'0'.repeat(64)},'HASH'],[{timeoutMs:0},'INPUT'],[{signal:{}},'INPUT'],[{signal:cancelled.signal},'ABORTED'],[{workbookBytes:Buffer.alloc(5*1024*1024+1)},'INPUT'],[{profile:{kind:'classification',padding:'x'.repeat(65536)}},'PROFILE']]){
    await assert.rejects(parseRatioWorkbook({...xlsxArgs(),spawnImpl:p.spawnImpl,...edit}),e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_'+code);
  }assert.equal(p.state.calls,0);
});
test('XLSX decoder fixed refusals are retained while raw process failures and stderr are hidden',async()=>{
  for(const [options,code]of [[{output:'{"error":"RATIO_XLSX_CURRENCY"}',code:2},'CURRENCY'],[{processError:true},'PROCESS'],[{stderr:'Fictional private report data'},'OUTPUT'],[{output:'Fictional private report data',code:1},'OUTPUT']]){
    const p=parserProcess(options);
    await assert.rejects(parseRatioWorkbook({...xlsxArgs(),spawnImpl:p.spawnImpl}),e=>{assert.equal(ratioWorkbookFailureCode(e),'RATIO_XLSX_'+code);assert.doesNotMatch(String(e),/private|Fictional/);return true;});
    assert.equal(p.state.calls,1);
  }
});
test('XLSX malformed, oversized, hash-mismatched or authority-claiming outputs are refused',async()=>{
  const edits=[v=>({...v,sourceVerified:true}),v=>({...v,publicationReady:true}),v=>({...v,completenessVerified:true}),v=>({...v,workbookSha256:'0'.repeat(64)}),v=>({...v,profileSha256:'0'.repeat(64)}),v=>({...v,rowCount:2}),v=>({...v,kind:'exposure'}),v=>({...v,extra:'unexpected'})];
  for(const edit of edits){const p=parserProcess({output:v=>JSON.stringify(edit(v))});await assert.rejects(parseRatioWorkbook({...xlsxArgs(),spawnImpl:p.spawnImpl}),e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_OUTPUT');}
  for(const output of ['{"schema":1,"schema":2}','x'.repeat(5*1024*1024+1)]){const p=parserProcess({output});await assert.rejects(parseRatioWorkbook({...xlsxArgs(),spawnImpl:p.spawnImpl}),e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_OUTPUT');}
});
test('XLSX timeout and external cancellation kill the isolated child without retry',async()=>{
  const timeout=parserProcess({hang:true});
  await assert.rejects(parseRatioWorkbook({...xlsxArgs(),spawnImpl:timeout.spawnImpl,timeoutMs:10}),e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_TIMEOUT');
  assert.equal(timeout.state.calls,1);assert.equal(timeout.state.kills,1);
  const aborting=parserProcess({hang:true}),controller=new AbortController();
  const request=parseRatioWorkbook({...xlsxArgs(),spawnImpl:aborting.spawnImpl,signal:controller.signal});controller.abort();
  await assert.rejects(request,e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_ABORTED');
  assert.equal(aborting.state.calls,1);assert.equal(aborting.state.kills,1);
});
test('actual isolated XLSX child parses a wholly fictitious workbook and cannot grant official intake',async()=>{
  const fixturePath=fileURLToPath(new URL('./fee-ratio-xlsx.test.py',import.meta.url));
  const code='import importlib.util,json,base64\ns=importlib.util.spec_from_file_location("synthetic_xlsx",'+JSON.stringify(fixturePath)+')\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\np,c,r=m.fixture("classification",as_of="2026-10-30")\nprint(json.dumps({"profile":p,"data":base64.b64encode(m.workbook(p,c,r)).decode()},ensure_ascii=False))';
  const fixture=JSON.parse(execFileSync('/usr/bin/python3',['-B','-I','-c',code],{encoding:'utf8',timeout:5000,maxBuffer:1024*1024,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}}));
  const workbookBytes=Buffer.from(fixture.data,'base64');
  const r=await parseRatioWorkbook({workbookBytes,expectedSha256:hash(workbookBytes),profile:fixture.profile,now:now()});
  assert.equal(r.rows[0].valueUSD,100.25);assert.equal(r.rows[0].quantity,12.5);assert.equal(r.rows[0].sharesightCategory,'美国底仓');
  assert.equal(r.metadata.asOf,'2026-10-30');assert.equal(r.publicationReady,false);
  const bytes=Buffer.from(JSON.stringify(r));
  rejects(()=>prepareCollectedRatioInput({originalBytes:bytes,expectedSha256:hash(bytes),requirePerformance:false,now:now()}),'OFFICIAL_ORIGINAL_REQUIRED');
});
test('the standalone XLSX suite uses only generated archives and the Python standard library',()=>{
  const script=fileURLToPath(new URL('./fee-ratio-xlsx.test.py',import.meta.url));
  const r=execFileSync('/usr/bin/python3',['-B','-I',script],{timeout:10000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
  assert.equal(r.length,0);
});

test('actual Diversity child accepts an internal parent table relationship but cannot replace an authenticated classification original',async()=>{
  const fixturePath=fileURLToPath(new URL('./fee-ratio-xlsx.test.py',import.meta.url));
  const code='import importlib.util,json,base64\ns=importlib.util.spec_from_file_location("synthetic_diversity",'+JSON.stringify(fixturePath)+')\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\np,data=m.diversity_fixture(table_target="../tables/table1.xml")\nprint(json.dumps({"profile":p,"data":base64.b64encode(data).decode()},ensure_ascii=False))';
  const fixture=JSON.parse(execFileSync('/usr/bin/python3',['-B','-I','-c',code],{encoding:'utf8',timeout:5000,maxBuffer:1024*1024,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}}));
  const workbookBytes=Buffer.from(fixture.data,'base64'),at=new Date('2026-11-10T12:00:00.000Z');
  const r=await parseRatioWorkbook({workbookBytes,expectedSha256:hash(workbookBytes),profile:fixture.profile,now:at});
  assert.equal(r.kind,'diversity');assert.equal(r.rowCount,3);assert.equal(r.rows.reduce((n,row)=>n+row.valueRaw,0),60.75);
  assert.equal(r.metadata.asOf,'2026-11-10');assert.equal(r.metadata.currency,null);assert.equal(r.metadata.view,null);
  assert.equal(r.metadata.accountScopeVerified,false);assert.equal(r.metadata.ignoredSummaryFormulas.length,8);
  for(const row of r.rows)for(const key of ['account','quantity','valueUSD'])assert.equal(Object.hasOwn(row,key),false);
  for(const key of ['sourceVerified','completenessVerified','publicationReady'])assert.equal(r[key],false);
  assert.equal(validateRatioCollection(r,'2026-11-10'),null);
  const bytes=Buffer.from(JSON.stringify(r));rejects(()=>prepareCollectedRatioInput({originalBytes:bytes,expectedSha256:hash(bytes),requirePerformance:false,now:at}),'OFFICIAL_ORIGINAL_REQUIRED');
  const workbooks=workbookSet(),parser=setProcess();workbooks[0]={role:'classification',workbookBytes,expectedSha256:hash(workbookBytes),profile:fixture.profile};
  await assert.rejects(parseRatioWorkbookSet({workbooks,now:at,spawnImpl:parser.spawnImpl}),e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_PROFILE');
  assert.equal(parser.roles.length,0,'raw Diversity does not enter the complete classification/workbook-set path');
});

function workbookSet(){
  return RATIO_XLSX_ROLES.map(role=>{
    const workbookBytes=Buffer.from('Entirely fictitious transport-only workbook '+role);
    return {role,workbookBytes,expectedSha256:hash(workbookBytes),profile:{kind:['classification','exposure'].includes(role)?role:'performance',expectedView:'Fictional Consolidated View',expectedAccounts:['Fictional Account A']}};
  });
}
function setProcess({edit,onSpawn,hangRole,failRole}={}){
  const children=[],roles=[];
  const spawnImpl=(...args)=>{
    const role=RATIO_XLSX_ROLES[roles.length];roles.push(role);onSpawn?.(role);
    const p=parserProcess({hang:role===hangRole,code:role===failRole?2:0,output:value=>{
      if(role===failRole)return '{"error":"RATIO_XLSX_ZIP"}';
      value.metadata={asOf:role==='classification'?'2026-10-29':'2026-10-30',currency:'USD',view:'Fictional Consolidated View',
        ...(!['classification','exposure'].includes(role)?{period:role.endsWith('-all')?'all':'oneYear',startDate:role.endsWith('-all')?'2022-01-01':'2025-10-30',endDate:'2026-10-30',includeClosed:true,cashPerformance:'unknown'}:{})};
      edit?.(value,role);return JSON.stringify(value);
    }});children.push(p.state);return p.spawnImpl(...args);
  };
  return {spawnImpl,roles,children};
}
test('XLSX set checks all ten pins/roles before starting and returns no partial set',async()=>{
  const changes=[v=>v.pop(),v=>v[9].role=v[0].role,v=>v[9].role='invented-role',v=>v[9].expectedSha256='0'.repeat(64),v=>v[9].profile=null,v=>v[9].profile.kind='exposure'];
  for(const change of changes){const p=setProcess(),workbooks=workbookSet();change(workbooks);await assert.rejects(parseRatioWorkbookSet({workbooks,now:now(),spawnImpl:p.spawnImpl}));assert.equal(p.roles.length,0);}
});
test('XLSX set preflight refuses conflicting declared accounts and paired views without child IO',async()=>{
  for(const change of [v=>v[9].profile.expectedAccounts=['Fictional Other Account'],v=>v[1].profile.expectedView='Fictional Other View',v=>v[3].profile.expectedView='Fictional Other View']){
    const p=setProcess(),workbooks=workbookSet();change(workbooks);
    await assert.rejects(parseRatioWorkbookSet({workbooks,now:now(),spawnImpl:p.spawnImpl}),e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_SCOPE');assert.equal(p.roles.length,0);
  }
});
test('XLSX set orders roles, preserves independent dates, binds the manifest and cannot be collection/publication proof',async()=>{
  const p=setProcess(),r=await parseRatioWorkbookSet({workbooks:workbookSet().reverse(),now:now(),spawnImpl:p.spawnImpl});
  assert.deepEqual(r.workbooks.map(v=>v.role),[...RATIO_XLSX_ROLES]);assert.deepEqual(r.sourceDates,{classification:'2026-10-29',exposure:'2026-10-30',performance:'2026-10-30'});
  assert.equal(r.manifestSha256,hash(Buffer.from(JSON.stringify(r.manifest))));assert.equal(r.manifest.workbooks.length,10);
  assert.equal(r.publicationReady,false);assert.equal(r.sourceVerified,false);assert.equal(r.completenessVerified,false);assert.equal(r.state,undefined);
  assert.equal(validateRatioCollection(r,'2026-10-30'),null);
  const bytes=Buffer.from(JSON.stringify(r));rejects(()=>prepareCollectedRatioInput({originalBytes:bytes,expectedSha256:hash(bytes),requirePerformance:false,now:now()}),'OFFICIAL_ORIGINAL_REQUIRED');
});
test('XLSX set stops on cross-report date, period, closed-position and currency contradictions',async()=>{
  const cases=[
    [(v,role)=>{if(role==='classification')v.metadata.asOf='2026-10-31';},'DATE'],
    [(v,role)=>{if(role==='top5-all'){v.metadata.asOf='2026-10-29';v.metadata.endDate='2026-10-29';}},'DATE'],
    [(v,role)=>{if(role==='stock-all')v.metadata.period='oneYear';},'PERFORMANCE'],
    [(v,role)=>{if(role==='stock-all')v.metadata.includeClosed=false;},'PERFORMANCE'],
    [(v,role)=>{if(role==='stock-one-year')v.metadata.startDate='2025-10-29';},'PERFORMANCE'],
    [(v,role)=>{if(role==='exposure')v.metadata.currency='EUR';},'CURRENCY'],
    [(v,role)=>{if(role==='exposure')v.metadata.view='Fictional Other View';},'SCOPE'],
  ];
  for(const [edit,code]of cases){const p=setProcess({edit});await assert.rejects(parseRatioWorkbookSet({workbooks:workbookSet(),now:now(),spawnImpl:p.spawnImpl}),e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_'+code);}
});
test('XLSX set snapshots binary, layout and clock before any asynchronous child',async()=>{
  const workbooks=workbookSet(),clock=now(),expected=workbooks.map(v=>v.expectedSha256);
  const p=setProcess({onSpawn:role=>{if(role==='classification'){workbooks[1].workbookBytes.fill(0);workbooks[1].profile.expectedView='Mutated';clock.setUTCFullYear(2030);}}});
  const r=await parseRatioWorkbookSet({workbooks,now:clock,spawnImpl:p.spawnImpl});
  assert.deepEqual(r.workbooks.map(v=>v.preview.workbookSha256),expected);
  assert.ok(p.children.every(c=>c.request.now==='2026-10-30T06:00:00.000Z'));
});
test('XLSX set cancels/ends on the first parser failure, never retries and never returns partial success',async()=>{
  const p=setProcess({failRole:'assetclass-all'});
  await assert.rejects(parseRatioWorkbookSet({workbooks:workbookSet(),now:now(),spawnImpl:p.spawnImpl}),e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_ZIP');assert.equal(p.roles.length,3);
  const timeout=setProcess({hangRole:'classification'});
  await assert.rejects(parseRatioWorkbookSet({workbooks:workbookSet(),now:now(),timeoutMs:15,spawnImpl:timeout.spawnImpl}),e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_TIMEOUT');
  assert.equal(timeout.roles.length,1);assert.equal(timeout.children[0].kills,1);
  const cancelled=new AbortController(),aborting=setProcess({hangRole:'classification'});
  const promise=parseRatioWorkbookSet({workbooks:workbookSet(),now:now(),signal:cancelled.signal,spawnImpl:aborting.spawnImpl});cancelled.abort();
  await assert.rejects(promise,e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_ABORTED');assert.equal(aborting.roles.length,1);assert.equal(aborting.children[0].kills,1);
});
test('XLSX set bounds aggregate input and avoids spawning for a pre-cancelled set',async()=>{
  const p=setProcess(),workbooks=workbookSet(),large=Buffer.alloc(5*1024*1024,65),pin=hash(large);
  for(let i=0;i<4;i++){workbooks[i].workbookBytes=large;workbooks[i].expectedSha256=pin;}
  await assert.rejects(parseRatioWorkbookSet({workbooks,now:now(),spawnImpl:p.spawnImpl}),e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_INPUT');assert.equal(p.roles.length,0);
  const controller=new AbortController();controller.abort();
  await assert.rejects(parseRatioWorkbookSet({workbooks:workbookSet(),now:now(),signal:controller.signal,spawnImpl:p.spawnImpl}),e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_ABORTED');assert.equal(p.roles.length,0);
});
test('actual isolated child decodes the whole fictitious ten-workbook set without official-source claims',async()=>{
  const fixturePath=fileURLToPath(new URL('./fee-ratio-xlsx.test.py',import.meta.url));
  const code='import importlib.util,json,base64\ns=importlib.util.spec_from_file_location("synthetic_xlsx",'+JSON.stringify(fixturePath)+')\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nout=[]\nfor role in '+JSON.stringify([...RATIO_XLSX_ROLES])+':\n kind=role if role in ("classification","exposure") else "performance"\n period="all" if role.endswith("-all") else "oneYear"\n p,c,r=m.fixture(kind,as_of="2026-10-29" if kind=="classification" else "2026-10-30",period=period)\n if kind=="performance" and period=="oneYear": c["B5"]="2025-10-30"\n out.append({"role":role,"profile":p,"data":base64.b64encode(m.workbook(p,c,r)).decode()})\nprint(json.dumps(out,ensure_ascii=False))';
  const fixture=JSON.parse(execFileSync('/usr/bin/python3',['-B','-I','-c',code],{encoding:'utf8',timeout:5000,maxBuffer:1024*1024,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}}));
  const workbooks=fixture.map(v=>{const workbookBytes=Buffer.from(v.data,'base64');return {role:v.role,profile:v.profile,workbookBytes,expectedSha256:hash(workbookBytes)};});
  const r=await parseRatioWorkbookSet({workbooks,now:now()});
  assert.equal(r.workbooks.length,10);assert.equal(r.workbooks[1].preview.rows[2].valueUSD,-30);
  assert.equal(r.workbooks[2].preview.rows[0].returnPct,8.25);assert.equal(r.sourceDates.classification,'2026-10-29');assert.equal(r.publicationReady,false);
  const session=createRatioWorkbookSession({workbooks,sourceContract:sourceContract(workbooks),clock:now});
  const assessed=await session.run();assert.equal(assessed.state,'PREVIEW_READY');assert.equal(assessed.sourceAssessment.declaredReports.classification,'Diversity');
  assert.equal(assessed.sourceVerified,false);assert.equal(assessed.publicationReady,false);assert.equal(validateRatioCollection(assessed,'2026-10-30'),null);
});

function sourceContract(workbooks=workbookSet()){
  return {schema:'fee-console.ratio-xlsx-source-contract.v1',requestDataAsOf:'2026-10-30',sources:workbooks.map(w=>({
    role:w.role,workbookSha256:w.expectedSha256,profileSha256:hash(Buffer.from(JSON.stringify(w.profile))),provider:'Sharesight',
    report:w.role==='classification'?'Diversity':w.role==='exposure'?'Exposure':'Performance',transport:'browser-xlsx',view:w.profile.expectedView,
    dateMode:w.role==='classification'?'as-of':w.role==='exposure'?'current-only':'period',
    requestedDate:w.role==='exposure'?null:w.role==='classification'?'2026-10-29':'2026-10-30',
    capture:{basis:'download-completed',at:'2026-10-30T05:00:00.000Z'},
  }))};
}
async function sourcePreview(workbooks=workbookSet(),options={}){
  return parseRatioWorkbookSet({workbooks,now:now(),spawnImpl:setProcess(options).spawnImpl});
}
test('source contract preserves actual dates and Diversity origin without granting authenticity',async()=>{
  const preview=await sourcePreview(),contract=sourceContract(),r=assessRatioWorkbookSources(preview,contract,{now:now()});
  assert.equal(r.declaredReports.classification,'Diversity');assert.equal(r.declaredReports.exposure,'Exposure');
  assert.deepEqual(r.sourceDates,preview.sourceDates);assert.equal(r.publicationReady,false);assert.equal(r.sourceVerified,false);
  assert.ok(r.issues.some(i=>i.code==='SOURCE_ORIGIN_UNVERIFIED'));assert.equal(validateRatioCollection(r,'2026-10-30'),null);
  const other=structuredClone(contract);other.sources.reverse();
  assert.equal(assessRatioWorkbookSources(preview,other,{now:now()}).sourceContractSha256,r.sourceContractSha256);
});
test('source contract rejects foreign providers, source substitution, historical Exposure and mismatched pins before decoding',()=>{
  const edits=[c=>c.sources[0].provider='OtherBroker',c=>c.sources[1].report='Diversity',c=>c.sources[1].dateMode='as-of',
    c=>c.sources[1].requestedDate='2026-10-30',c=>c.sources[0].report='Investments',c=>c.sources[0].workbookSha256='0'.repeat(64),
    c=>c.sources[0].profileSha256='0'.repeat(64),c=>c.sources[0].view='Fictional other view',c=>c.sources[0].verified=true,
    c=>c.sources[0].capture={basis:'unknown',at:'2026-10-30T05:00:00.000Z'},c=>c.sources[9].role=c.sources[0].role,
    c=>c.sources[9].requestedDate='2026-10-29'];
  for(const edit of edits){const workbooks=workbookSet(),contract=sourceContract(workbooks),p=setProcess();edit(contract);
    assert.throws(()=>createRatioWorkbookSession({workbooks,sourceContract:contract,clock:now,spawnImpl:p.spawnImpl}),e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_SOURCE_CONTRACT');assert.equal(p.roles.length,0);
  }
});
test('unknown and mtime capture claims stay explicit and parsing does not invent a download time',async()=>{
  const preview=await sourcePreview(),contract=sourceContract();
  for(const s of contract.sources)s.capture={basis:'unknown',at:null};
  const unknown=assessRatioWorkbookSources(preview,contract,{now:now()});
  assert.equal(unknown.issues.filter(i=>i.code==='CAPTURE_TIME_UNKNOWN').length,10);
  assert.ok(Object.values(unknown.declaredCaptures).every(c=>c.at===null));
  for(const s of contract.sources)s.capture={basis:'original-file-mtime',at:'2026-10-30T05:00:00.000Z'};
  const mtime=assessRatioWorkbookSources(preview,contract,{now:now()});
  assert.equal(mtime.issues.filter(i=>i.code==='CAPTURE_MTIME_ONLY').length,10);assert.equal(mtime.sourceVerified,false);
});
test('source date mismatches refuse dated reports while current-only Exposure keeps its true later date',async()=>{
  const preview=await sourcePreview(),wrong=sourceContract();wrong.sources[0].requestedDate='2026-10-28';
  assert.throws(()=>assessRatioWorkbookSources(preview,wrong,{now:now()}),e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_SOURCE_DATE');
  const prior=await sourcePreview(workbookSet(),{edit:(v,role)=>{if(!['classification','exposure'].includes(role)){
    v.metadata.asOf='2026-10-29';v.metadata.endDate='2026-10-29';if(v.metadata.period==='oneYear')v.metadata.startDate='2025-10-29';
  }}});
  const contract=sourceContract();contract.requestDataAsOf='2026-10-29';for(const s of contract.sources)if(s.role!=='exposure')s.requestedDate='2026-10-29';
  const r=assessRatioWorkbookSources(prior,contract,{now:now()});assert.equal(r.sourceDates.exposure,'2026-10-30');
  assert.equal(r.requestDataAsOf,'2026-10-29');assert.ok(r.issues.some(i=>i.code==='EXPOSURE_CURRENT_ONLY_AFTER_REQUEST'));assert.equal(r.publicationReady,false);
});
test('original capture claims enforce the 36h boundary, future time and source date without refreshing them',async()=>{
  const preview=await sourcePreview(),contract=sourceContract(),clock=new Date('2026-11-01T05:00:00.000Z');
  for(const s of contract.sources)s.capture.at='2026-10-30T17:00:00.000Z';
  assert.equal(assessRatioWorkbookSources(preview,contract,{now:clock}).sourceVerified,false);
  for(const at of ['2026-10-30T16:59:59.999Z','2026-11-01T05:00:00.001Z']){
    const bad=structuredClone(contract);bad.sources[0].capture.at=at;
    assert.throws(()=>assessRatioWorkbookSources(preview,bad,{now:clock}),e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_CAPTURE');
  }
  const impossible=sourceContract();impossible.sources[1].capture.at='2026-10-29T15:59:59.000Z';
  assert.throws(()=>assessRatioWorkbookSources(preview,impossible,{now:now()}),e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_CAPTURE');
});
function firstPausedProcess({processError=false}={}){
  const initial=parserProcess(processError?{processError:true}:{hang:true}),later=setProcess();let first=true;
  return {initial:initial.state,later,spawnImpl(...args){if(first){first=false;return initial.spawnImpl(...args);}return later.spawnImpl(...args);}};
}
test('local recovery is explicit, restarts frozen bytes and preserves original contract/capture claims',async()=>{
  const workbooks=workbookSet(),contract=sourceContract(workbooks),p=firstPausedProcess();
  const session=createRatioWorkbookSession({workbooks,sourceContract:contract,clock:now,timeoutMs:15,spawnImpl:p.spawnImpl});
  const paused=await session.run();assert.equal(paused.state,'PAUSED');assert.equal(paused.resumable,true);assert.equal(paused.preview,undefined);assert.equal(p.later.roles.length,0);
  workbooks[1].workbookBytes.fill(0);workbooks[1].profile.expectedView='Fictional changed';
  contract.sources[0].report='Investments';contract.sources[0].capture.at='2026-10-30T06:00:00.000Z';
  const result=await session.resume({timeoutMs:1000});assert.equal(result.state,'PREVIEW_READY');assert.equal(result.attempt,2);
  assert.equal(result.sourceAssessment.declaredReports.classification,'Diversity');assert.equal(result.sourceAssessment.declaredCaptures.classification.at,'2026-10-30T05:00:00.000Z');
  assert.equal(result.sourceContractSha256,paused.sourceContractSha256);assert.equal(result.publicationReady,false);assert.equal(result.sourceVerified,false);
  assert.equal(validateRatioCollection(result,'2026-10-30'),null);assert.equal(p.later.roles.length,10);
  await assert.rejects(session.resume(),e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_RECOVERY_STATE');
});
test('unknown process failures and invalid source data block recovery rather than retry access',async()=>{
  const workbooks=workbookSet(),contract=sourceContract(workbooks),p=firstPausedProcess({processError:true});
  const session=createRatioWorkbookSession({workbooks,sourceContract:contract,clock:now,spawnImpl:p.spawnImpl});
  const result=await session.run();assert.equal(result.state,'BLOCKED');assert.equal(result.code,'RATIO_XLSX_PROCESS');assert.equal(result.resumable,false);
  await assert.rejects(session.resume(),e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_RECOVERY_STATE');assert.equal(p.later.roles.length,0);
  const zip=setProcess({failRole:'classification'}),invalid=createRatioWorkbookSession({workbooks,sourceContract:contract,clock:now,spawnImpl:zip.spawnImpl});
  assert.equal((await invalid.run()).state,'BLOCKED');await assert.rejects(invalid.resume());assert.equal(zip.roles.length,1);
});
test('resume rechecks original capture freshness before spawning and never renews the source',async()=>{
  let current=now();const p=firstPausedProcess(),workbooks=workbookSet();
  const session=createRatioWorkbookSession({workbooks,sourceContract:sourceContract(workbooks),clock:()=>current,timeoutMs:15,spawnImpl:p.spawnImpl});
  assert.equal((await session.run()).state,'PAUSED');current=new Date('2026-11-01T06:00:00.000Z');
  const expired=await session.resume({timeoutMs:1000});assert.equal(expired.state,'BLOCKED');assert.equal(expired.code,'RATIO_XLSX_CAPTURE');assert.equal(p.later.roles.length,0);
});
test('session serializes local runs, exposes no partial rows, and cannot restore from status JSON',async()=>{
  const workbooks=workbookSet(),p=setProcess({hangRole:'classification'}),controller=new AbortController();
  const session=createRatioWorkbookSession({workbooks,sourceContract:sourceContract(workbooks),clock:now,spawnImpl:p.spawnImpl});
  const running=session.run({signal:controller.signal});await assert.rejects(session.run(),e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_RECOVERY_STATE');
  assert.equal(session.status().state,'RUNNING');assert.equal(session.status().preview,undefined);controller.abort();
  const saved=await running;assert.equal(saved.state,'PAUSED');saved.state='PREVIEW_READY';assert.equal(session.status().state,'PAUSED');
  assert.throws(()=>createRatioWorkbookSession({checkpoint:saved}),e=>ratioWorkbookFailureCode(e)==='RATIO_XLSX_INPUT');
  assert.equal(session.close().state,'CLOSED');await assert.rejects(session.resume());assert.equal(p.roles.length,1);
});
test('session completion rechecks its clock/capture and close cannot become preview-ready',async()=>{
  for(const later of ['2026-11-01T06:00:00.000Z','2026-10-30T05:59:59.999Z']){
    const workbooks=workbookSet(),p=setProcess();let reads=0;
    const session=createRatioWorkbookSession({workbooks,sourceContract:sourceContract(workbooks),clock:()=>reads++?new Date(later):now(),spawnImpl:p.spawnImpl});
    const result=await session.run();assert.equal(result.state,'BLOCKED');assert.equal(result.preview,undefined);assert.equal(p.roles.length,10);
  }
  const workbooks=workbookSet(),p=setProcess({hangRole:'classification'}),session=createRatioWorkbookSession({workbooks,sourceContract:sourceContract(workbooks),clock:now,spawnImpl:p.spawnImpl});
  const run=session.run();session.close();assert.equal((await run).state,'CLOSED');assert.equal(session.status().state,'CLOSED');assert.equal(p.children[0].kills,1);
});

const controlIntent=(extra={})=>({role:'classification',report:'Diversity',view:'All Together',
  asOf:'2026-11-10',startDate:null,period:null,exposure:null,...extra});
const controlObservation=(intent,extra={})=>{
  const p=planRatioReportControls(intent);
  return {report:intent.report,view:intent.view,dateInputs:structuredClone(p.dateInputs),includeClosedLabel:p.includeClosedLabel,
    includeClosed:p.includeClosed,exposure:structuredClone(p.exposure),exportVisible:true,...extra};
};
test('observed Diversity date controls use strict day/month/year without changing source dates',()=>{
  const intent=controlIntent(),p=planRatioReportControls(intent),r=assessRatioReportControls(intent,controlObservation(intent));
  assert.deepEqual(p.dateInputs,[{placeholder:'Enter your date',value:'10/11/2026'}]);
  assert.equal(r.normalizedDates['Enter your date'],'2026-11-10');assert.equal(r.downloadVerified,false);assert.equal(r.publicationReady,false);
  for(const value of ['11/10/2026','2026-11-10','10/11/26','1/11/2026','10/11/2026 ','31/11/2026','29/02/2025']){
    const observed=controlObservation(intent);observed.dateInputs[0].value=value;
    assert.throws(()=>assessRatioReportControls(intent,observed),e=>['RATIO_COLLECTION_CONTROLS_DATE','RATIO_COLLECTION_CONTROLS_MISMATCH'].includes(ratioCollectionFailureCode(e)));
  }
});
test('native Performance controls bind both named dates and the actual closed-position checkbox label/value',()=>{
  const intent=controlIntent({role:'strategy-one-year',report:'Performance',asOf:'2024-02-29',startDate:'2023-02-28',period:'oneYear'});
  const p=planRatioReportControls(intent),observed=controlObservation(intent);
  assert.deepEqual(p.dateInputs,[{placeholder:'Enter your start date',value:'28/02/2023'},{placeholder:'Enter your end date',value:'29/02/2024'}]);
  observed.dateInputs.reverse();assert.equal(assessRatioReportControls(intent,observed).normalizedDates['Enter your end date'],'2024-02-29');
  for(const extra of [{includeClosed:false},{includeClosed:'true'},{includeClosedLabel:'Another checkbox'}])
    rejects(()=>assessRatioReportControls(intent,controlObservation(intent,extra)),'CONTROLS_MISMATCH');
  rejects(()=>planRatioReportControls({...intent,startDate:'2023-03-01'}),'CONTROLS_DATE');
});
test('all-time control plans require an explicit start and never infer inception from a date or view label',()=>{
  const intent=controlIntent({role:'assetclass-all',report:'Performance',startDate:'2020-01-02',period:'all'});
  assert.equal(planRatioReportControls(intent).dateInputs[0].value,'02/01/2020');
  rejects(()=>planRatioReportControls({...intent,startDate:null}),'CONTROLS_DATE');
  rejects(()=>planRatioReportControls({...intent,startDate:'2026-11-11'}),'CONTROLS_DATE');
  rejects(()=>planRatioReportControls({...intent,period:'oneYear'}),'CONTROLS_INPUT');
});
test('Exposure plans have no date field and accept only the observed grouping/top options',()=>{
  const intent=controlIntent({role:'exposure',report:'Exposure',asOf:null,exposure:{grouping:'No grouping',top:500}});
  assert.deepEqual(planRatioReportControls(intent).dateInputs,[]);
  for(const top of [50,100,250,500])assert.equal(planRatioReportControls({...intent,exposure:{grouping:'Country',top}}).exposure.top,top);
  for(const extra of [{asOf:'2026-11-10'},{startDate:'2025-11-10'},{period:'oneYear'},
    {exposure:{grouping:'Custom asset class',top:500}},{exposure:{grouping:'No grouping',top:1000}}])
    rejects(()=>planRatioReportControls({...intent,...extra}),'CONTROLS_INPUT');
  rejects(()=>assessRatioReportControls(intent,controlObservation(intent,{dateInputs:[{placeholder:'Enter your date',value:'10/11/2026'}]})),'CONTROLS_MISMATCH');
});
test('ALL and All Together remain distinct unverified labels and never establish ten-account scope',()=>{
  const intent=controlIntent({view:'ALL'}),observed=controlObservation(intent),r=assessRatioReportControls(intent,observed);
  assert.equal(r.observedViewLabel,'ALL');assert.equal(r.scopeVerified,false);assert.ok(r.issues.includes('VIEW_SCOPE_UNVERIFIED'));
  rejects(()=>assessRatioReportControls({...intent,view:'All Together'},observed),'CONTROLS_MISMATCH');
  rejects(()=>assessRatioReportControls(intent,{...observed,view:'ALL '}),'CONTROLS_MISMATCH');
});
test('control identity, duplicate fields, unsupported classification mappings and self-issued verification refuse',()=>{
  const intent=controlIntent();
  for(const report of ['Investments','Performance','Exposure'])rejects(()=>planRatioReportControls({...intent,report}),'CONTROLS_INPUT');
  for(const edit of [o=>o.report='Performance',o=>o.dateInputs[0].placeholder='Enter your end date',
    o=>o.dateInputs.push({...o.dateInputs[0]}),o=>o.dateInputs=[],o=>o.sourceVerified=true,
    o=>o.exposure={grouping:'No grouping',top:500},o=>o.exportVisible='true']){
    const observed=controlObservation(intent);edit(observed);rejects(()=>assessRatioReportControls(intent,observed),'CONTROLS_MISMATCH');
  }
});
test('visible Export and matched controls never become a download, official original or manager receipt',()=>{
  const intent=controlIntent(),previous=globalThis.fetch;let network=0;
  globalThis.fetch=()=>{network++;throw Error('must stay offline');};
  try{
    for(const exportVisible of [true,false]){
      const r=assessRatioReportControls(intent,controlObservation(intent,{exportVisible}));
      assert.equal(r.exportControlVisible,exportVisible);assert.equal(r.status,'CONTROLS_MATCH_UNVERIFIED');
      for(const key of ['sourceVerified','scopeVerified','downloadVerified','publicationReady'])assert.equal(r[key],false);
      assert.ok(r.issues.includes('DOWNLOAD_NOT_OBSERVED'));assert.equal(r.issues.includes('EXPORT_CONTROL_NOT_OBSERVED'),!exportVisible);
      assert.equal(validateRatioCollection(r,'2026-11-10'),null);
      const bytes=Buffer.from(JSON.stringify(r));rejects(()=>prepareCollectedRatioInput({originalBytes:bytes,expectedSha256:hash(bytes),requirePerformance:false,now:now()}),'OFFICIAL_ORIGINAL_REQUIRED');
    }
    assert.equal(network,0);assert.equal(ratioCollectionReadiness().automaticCollectionReady,false);
  }finally{globalThis.fetch=previous;}
});
test('control plans snapshot mutable declarations and bind their exact intent without gaining authority',()=>{
  const intent=controlIntent({role:'exposure',report:'Exposure',asOf:null,exposure:{grouping:'No grouping',top:500}}),p=planRatioReportControls(intent);
  intent.exposure.top=50;assert.equal(p.request.exposure.top,500);assert.equal(p.exposure.top,500);
  assert.notEqual(p.intentSha256,planRatioReportControls(intent).intentSha256);
  p.request.exposure.top=250;assert.equal(p.exposure.top,500);assert.equal(intent.exposure.top,50);
  assert.equal(p.publicationReady,false);assert.equal(p.sourceVerified,false);
});
