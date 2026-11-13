// Synthetic end-to-end connection: fabricated ten workbooks / five captures /
// inception -> the ACTUAL offline assembler across the real process boundary
// -> the existing intake -> the existing evidence/snapshot consumers.
// The only substitutions are the ones the assembler's own unit tests use
// (inode->identity map, fabricated scope digest, fixture clock) and the
// closed in-memory filesystem of the composition harness. No real source,
// xattr, credential, network or publication is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assembleOfflineOriginal,connectOfflineRatioInput,ratioOfflineFailureCode,OFFLINE_PYTHON,OFFLINE_ARGS,OFFLINE_CLI} from './fee-ratio-offline-connector.mjs';
import {prepareCollectedRatioInput} from './fee-ratio-source-collector.mjs';
import {createRankedExposureCore} from './xuan-ib-sharesight-exposure.mjs';
import {makeFixture,hash,OUTPUT} from './fee-ratio-intake-snapshot-fixture.mjs';

const HELPER=fileURLToPath(new URL('../cloud/fee-ratio-offline/tests/connection_helper.py',import.meta.url));
const REFERENCE=fileURLToPath(new URL('../cloud/fee-ratio-offline/adapter/projection_reference/',import.meta.url));
const tempDirs=[];
test.after(()=>{for(const d of tempDirs)fs.rmSync(d,{recursive:true,force:true});});

// Fabricated batch on disk in a private temp dir (synthetic bytes only).
function batch(t,layout='combined'){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'synthetic-offline-connection-'));
  tempDirs.push(dir); // removed once, after every test has restored the real fs
  const r=spawnSync(OFFLINE_PYTHON,['-B',HELPER,'prepare',dir,layout],{encoding:'utf8',env:{}});
  assert.equal(r.status,0,'fixture helper');
  const out=JSON.parse(r.stdout);
  const calls=[];
  // The connector must ask for exactly the fixed interpreter and CLI. The test
  // then runs that same cli.main in-process under the fixture substitutions.
  const spawnImpl=(command,args,options)=>{
    calls.push({command,args:[...args],options});
    assert.equal(command,OFFLINE_PYTHON);assert.deepEqual(args,[...OFFLINE_ARGS]);
    assert.deepEqual(options.env,{});assert.equal(options.shell,false);
    return spawn(OFFLINE_PYTHON,['-B',HELPER,'run',dir],{env:{},stdio:['pipe','pipe','ignore'],shell:false});
  };
  return {dir,request:out.request,now:new Date(out.now),scope:out.scope,calls,spawnImpl};
}
const syntheticCore=accounts=>({...createRankedExposureCore(),ALL_TOGETHER_SCOPE_SHA256:hash(JSON.stringify([...accounts].sort()))});
async function connected(t,layout){
  const b=batch(t,layout);
  const assembled=await assembleOfflineOriginal({request:b.request,enabled:true,spawnImpl:b.spawnImpl});
  const raw=JSON.parse(Buffer.from(assembled.originalBytes));
  return {...b,assembled,raw,exposureCore:syntheticCore(raw.accounts)};
}
const snapshotFiles=dir=>{const out=new Map();const walk=d=>{for(const n of fs.readdirSync(d)){const p=path.join(d,n);fs.statSync(p).isDirectory()?walk(p):out.set(p,hash(fs.readFileSync(p)));}};walk(dir);return out;};

test('default disabled: no process, no intake, no IO',async()=>{
  let spawned=0,intake=0;
  const args={request:{anything:true},spawnImpl:()=>{spawned++;},intakeImpl:()=>{intake++;}};
  assert.deepEqual(await assembleOfflineOriginal(args),{schema:'fee-console.ratio-offline-assembly.v1',state:'DISABLED',publicationReady:false,productionEnabled:false});
  assert.equal((await connectOfflineRatioInput(args)).status,'DISABLED');
  assert.equal((await connectOfflineRatioInput({...args,enabled:false})).status,'DISABLED');
  assert.equal(spawned+intake,0);
  await assert.rejects(assembleOfflineOriginal({...args,enabled:'yes'}),e=>ratioOfflineFailureCode(e)==='RATIO_OFFLINE_INPUT');
  assert.equal(spawned,0);
  const real=spawnSync(OFFLINE_PYTHON,['-I','-B',OFFLINE_CLI],{encoding:'utf8',env:{},input:''});
  assert.deepEqual(JSON.parse(real.stdout),{schema:'fee-console.ratio-offline-assembly.v1',state:'DISABLED',publicationReady:false,productionEnabled:false});
});

test('the pinned reference consumers are byte-identical to the repository consumers',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(REFERENCE,'manifest.json'),'utf8'));
  assert.equal(Object.keys(manifest.files).length,4);
  for(const [name,sha]of Object.entries(manifest.files)){
    assert.equal(hash(fs.readFileSync(path.join(REFERENCE,name))),sha,name+' pin');
    assert.equal(hash(fs.readFileSync(fileURLToPath(new URL('./'+name,import.meta.url)))),sha,name+' equals the current repository consumer');
  }
});

for(const layout of ['combined','uncombined'])
test(`actual assembler output (${layout}) flows through intake into an unsigned snapshot candidate`,async t=>{
  const c=await connected(t,layout),before=snapshotFiles(c.dir);
  assert.equal(c.calls.length,1);
  assert.equal(c.assembled.state,'OFFLINE_COMPLETE_ORIGINAL_CANDIDATE');
  assert.equal(hash(c.assembled.originalBytes),c.assembled.originalSha256);
  for(const k of ['sourceOriginVerified','fullPerformanceReady','publicationReady','productionEnabled','currentCloudCompatibilityValidated'])assert.equal(c.assembled[k],false,k);
  assert.equal(c.assembled.originalLibraryIdentityPending,true);
  assert.equal(c.raw.schemaVersion,'sharesight-private-performance-v1');
  assert.equal(c.scope,c.exposureCore.ALL_TOGETHER_SCOPE_SHA256,'fabricated scope digest is the digest of the assembled accounts');
  // Both native periods, Top5 and inception come from the assembler itself.
  assert.deepEqual(c.raw.performance.reports.map(r=>r.period).sort(),['all','oneYear']);
  assert.equal(c.raw.performance.topHoldings.reports.length,2);
  assert.ok(c.raw.performance.inceptionEvidence);

  // Connector: the same bytes and digest reach the real intake, nothing else.
  const seen=[];
  const link=await connectOfflineRatioInput({request:c.request,enabled:true,now:c.now,exposureCore:c.exposureCore,spawnImpl:c.spawnImpl,
    intakeImpl:args=>{seen.push(args);return prepareCollectedRatioInput(args);}});
  assert.equal(link.status,'PREPARED_UNAUTHENTICATED');assert.equal(link.publicationReady,false);assert.equal(link.downloadVerified,false);
  assert.equal(link.originalLibraryIdentityPending,true);
  assert.equal(seen.length,1);assert.equal(seen[0].requirePerformance,true);
  assert.deepEqual(Buffer.from(seen[0].originalBytes),Buffer.from(c.assembled.originalBytes),'deterministic assembler bytes');
  assert.equal(seen[0].expectedSha256,c.assembled.originalSha256);
  assert.equal(link.prepared.sourceSha256,c.assembled.originalSha256);
  assert.deepEqual(Buffer.from(link.prepared.originalBytes),Buffer.from(c.assembled.originalBytes),'original is not rewritten');
  assert.deepEqual(snapshotFiles(c.dir),before,'source workbooks, captures and inception files are unchanged');

  // Existing evidence/snapshot consumers on those exact bytes.
  const f=await makeFixture(t,{raw:c.raw,originalBytes:Buffer.from(c.assembled.originalBytes),now:c.now});
  assert.equal(f.prepared.sourceSha256,c.assembled.originalSha256);
  const validation=await f.stage(),packet=f.readOutput('fee-console-ratio-snapshot.candidate.json'),envelope=f.readOutput('ratio.envelope.json');
  assert.equal(validation.status,'RATIO_INDEPENDENT_CANDIDATE_ONLY');
  for(const field of ['publicationReady','managerAuthentication','feeOrHealthWrite','financialRead','keychainRead'])assert.equal(validation[field],false);
  assert.equal(packet.authentication,null);
  assert.equal(packet.body.source.sourceSha256,c.assembled.originalSha256);
  assert.equal(packet.body.source.scopeHash,c.scope);
  assert.deepEqual(packet.body.source.sourceDates,f.prepared.sourceDates);
  assert.equal(Date.parse(packet.body.source.expiresAt)-Date.parse(packet.body.source.capturedAt),36*3600000);
  const model=await f.ratio.open(envelope,f.manager);
  assert.deepEqual(model.performance,c.raw.performance,'both assembled periods reach the model unchanged');
  // Exposure keeps its own real date; it is never rewritten to the request date.
  assert.equal(model.exposure.summary.asOf,c.raw.allocation.exposure.asOf);
  assert.equal(model.sourceDates.exposure,c.raw.allocation.exposure.asOf);
  assert.equal(model.sourceDates.classification,c.raw.allocation.classification.asOf);
  assert.deepEqual(f.mem.writes.map(p=>path.basename(p)).sort(),['fee-console-ratio-snapshot.candidate.json','ratio.envelope.json','validation.json']);
  assert.ok(f.mem.writes.every(p=>p.startsWith(OUTPUT)));
});

test('converter refusal never reaches the intake',async t=>{
  const mutate=[
    ['altered workbook bytes',b=>{const p=b.request.bindings.strategy.all.path;fs.appendFileSync(p,'x');}],
    ['wrong workbook pin',b=>{b.request.bindings.strategy.all.sha256='0'.repeat(64);}],
    ['wrong Library version',b=>{b.request.bindings.top5.oneYear.libraryVersion+=1;}],
    ['wrong Library identity',b=>{b.request.bindings.stock.all.libraryFileId='libfile_'+'f'.repeat(32);}],
    ['missing workbook member',b=>{delete b.request.bindings.assetclass.oneYear;}],
    ['altered capture record',b=>{const p=b.request.bindings.top5.capture.path;fs.appendFileSync(p,' ');}],
    ['historical request schema',b=>{b.request.schema='ratio-ten-workbook-bindings.v1';}],
    ['caller scope override',b=>{b.request.scopeSha256='f'.repeat(64);}],
    ['caller executable override',b=>{b.request.node='/bin/true';}],
    ['symlinked workbook',b=>{const p=b.request.bindings.strategy.oneYear.path,real=p+'.real';fs.renameSync(p,real);fs.symlinkSync(real,p);}],
    ['hard-linked workbook',b=>{const p=b.request.bindings.stock.oneYear.path;fs.linkSync(p,p+'.link');}],
  ];
  for(const [name,edit]of mutate){
    const b=batch(t);edit(b);let intake=0;
    await assert.rejects(connectOfflineRatioInput({request:b.request,enabled:true,now:b.now,spawnImpl:b.spawnImpl,intakeImpl:()=>{intake++;}}),
      e=>{assert.equal(ratioOfflineFailureCode(e),'RATIO_OFFLINE_CONVERTER_REFUSED',name);assert.match(e.converterCode,/^OFFLINE_[A-Z0-9_]+$/);return true;},name);
    assert.equal(intake,0,name+': intake not called');
    assert.equal(b.calls.length,1,name);
  }
});

test('stale captures are refused by the assembler itself (36 h freshness kept)',async t=>{
  const b=batch(t);
  // Run the real CLI under the same substitutions but two days later.
  const lateSpawn=(command,args,options)=>{b.calls.push(1);
    return spawn(OFFLINE_PYTHON,['-B','-c',[
      'import sys,json,datetime as dt',`sys.argv=["h","run",${JSON.stringify(b.dir)}]`,
      `sys.path.insert(0,${JSON.stringify(path.dirname(HELPER))})`,'import connection_helper as h',
      'h.NOW=h.NOW+dt.timedelta(hours=48)','code,out=h.run(sys.argv[2])','sys.stdout.write(json.dumps(out)+"\\n");sys.exit(code)'].join('\n')],
      {env:{},stdio:['pipe','pipe','ignore'],shell:false});};
  let intake=0;
  await assert.rejects(connectOfflineRatioInput({request:b.request,enabled:true,now:b.now,spawnImpl:lateSpawn,intakeImpl:()=>{intake++;}}),
    e=>ratioOfflineFailureCode(e)==='RATIO_OFFLINE_CONVERTER_REFUSED');
  assert.equal(intake,0);
});

test('a forged or inconsistent assembler receipt is refused before the intake',async()=>{
  const bytes=Buffer.from('{"schemaVersion":"sharesight-private-performance-v1"}');
  const good={schema:'fee-console.ratio-offline-assembly.v1',state:'OFFLINE_COMPLETE_ORIGINAL_CANDIDATE',originalBase64:bytes.toString('base64'),originalBytes:bytes.length,
    originalSha256:hash(bytes),originalLibraryIdentityPending:true,uploads:0,publications:0,sourceOriginVerified:false,fullPerformanceReady:false,publicationReady:false,productionEnabled:false,currentCloudCompatibilityValidated:false};
  const fake=(out,code=0)=>()=>spawn(process.execPath,['-e',`process.stdout.write(${JSON.stringify(typeof out==='string'?out:JSON.stringify(out))});process.exit(${code})`],{stdio:['pipe','pipe','ignore']});
  const run=(out,code)=>{let intake=0;return connectOfflineRatioInput({request:{a:1},enabled:true,spawnImpl:fake(out,code),intakeImpl:()=>{intake++;return {};}}).then(()=>({intake}),e=>({intake,code:ratioOfflineFailureCode(e)}));};
  const cases=[
    [{...good,publicationReady:true},'RATIO_OFFLINE_RECEIPT'],[{...good,sourceOriginVerified:true},'RATIO_OFFLINE_RECEIPT'],
    [{...good,originalLibraryIdentityPending:false},'RATIO_OFFLINE_RECEIPT'],[{...good,publications:1},'RATIO_OFFLINE_RECEIPT'],
    [{...good,originalSha256:'0'.repeat(64)},'RATIO_OFFLINE_RECEIPT'],[{...good,originalBytes:bytes.length+1},'RATIO_OFFLINE_RECEIPT'],
    [{...good,originalBase64:bytes.toString('base64')+'!'},'RATIO_OFFLINE_RECEIPT'],
    [{...good,schema:'other'},'RATIO_OFFLINE_OUTPUT'],['not json','RATIO_OFFLINE_OUTPUT'],['{"schema":1,"schema":2}','RATIO_OFFLINE_OUTPUT'],
    [{schema:good.schema,state:'REFUSED',code:'OFFLINE_X'},'RATIO_OFFLINE_CONVERTER_REFUSED'],
  ];
  for(const [out,code]of cases){const r=await run(out,0);assert.equal(r.code,code,JSON.stringify(out).slice(0,60));assert.equal(r.intake,0);}
  assert.equal((await run(good,1)).code,'RATIO_OFFLINE_CONVERTER_REFUSED','non-zero exit is a refusal even with a success body');
});

test('intake keeps its own checks on assembler output: fixed production scope, pin and freshness',async t=>{
  const c=await connected(t,'combined');
  const args={originalBytes:c.assembled.originalBytes,expectedSha256:c.assembled.originalSha256,now:c.now,exposureCore:c.exposureCore};
  assert.equal(prepareCollectedRatioInput(args).status,'PREPARED_UNAUTHENTICATED');
  // The repository's fixed scope never accepts the fabricated accounts.
  assert.throws(()=>prepareCollectedRatioInput({...args,exposureCore:createRankedExposureCore()}),/RATIO_COLLECTION_SOURCE_CONTRACT/);
  await assert.rejects(connectOfflineRatioInput({request:c.request,enabled:true,now:c.now,spawnImpl:c.spawnImpl}),/RATIO_COLLECTION_SOURCE_CONTRACT/);
  assert.throws(()=>prepareCollectedRatioInput({...args,expectedSha256:'0'.repeat(64)}),/RATIO_COLLECTION_HASH/);
  const changed=Buffer.from(c.assembled.originalBytes);changed[changed.length-2]^=1;
  assert.throws(()=>prepareCollectedRatioInput({...args,originalBytes:changed}),/RATIO_COLLECTION_HASH/);
  assert.throws(()=>prepareCollectedRatioInput({...args,now:new Date(c.now.getTime()+40*3600000)}),/RATIO_COLLECTION_SOURCE_CONTRACT/);
});

test('snapshot stage refuses changed bytes, identity, version and scope for assembler output',async t=>{
  const c=await connected(t,'combined');
  const edits=[
    ['source bytes changed after pinning',f=>{const n=f.mem.get(f.evidence.source.path);n.bytes=Buffer.concat([n.bytes,Buffer.from(' ')]);}],
    ['Library version mismatch',f=>{f.evidence.library.version=1;f.saveEvidence();}],
    ['Library identity mismatch',f=>{f.evidence.library.libraryFileId='libfile_'+'c'.repeat(32);f.saveEvidence();}],
    ['account scope mismatch',f=>{f.exposureCore.ALL_TOGETHER_SCOPE_SHA256='f'.repeat(64);}],
    ['production scope rejects fabricated accounts',f=>{Object.assign(f.exposureCore,createRankedExposureCore());}],
  ];
  for(const [name,edit]of edits){
    await t.test(name,async st=>{
      const f=await makeFixture(st,{raw:c.raw,originalBytes:Buffer.from(c.assembled.originalBytes),now:c.now});
      edit(f);
      await assert.rejects(f.stage(),/RATIO_/,name);
      assert.equal(f.mem.writes.filter(p=>f.mem.nodes.has(p)).length,0,name+': no candidate left behind');
    });
  }
});

test('the assembler\'s own unmodified fixture is accepted by the intake but refused by the snapshot book model',async t=>{
  // Recorded contract difference, fail-closed: that fixture gives the IB-HK
  // label a hedge-fund position, which the existing book model does not allow.
  const c=await connected(t,'combined+assembler-fixture');
  assert.equal(prepareCollectedRatioInput({originalBytes:c.assembled.originalBytes,expectedSha256:c.assembled.originalSha256,now:c.now,exposureCore:c.exposureCore}).status,'PREPARED_UNAUTHENTICATED');
  const f=await makeFixture(t,{raw:c.raw,originalBytes:Buffer.from(c.assembled.originalBytes),now:c.now});
  await assert.rejects(f.stage(),/RATIO_BROWSER_EVIDENCE_REFUSED/);
  assert.equal(f.mem.writes.filter(p=>f.mem.nodes.has(p)).length,0,'no candidate is left behind');
});
