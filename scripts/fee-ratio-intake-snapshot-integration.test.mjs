// Entirely synthetic. The real consumers run against a closed in-memory OS;
// no source files, xattrs, private directories, network or credentials are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {prepareCollectedRatioInput} from './fee-ratio-source-collector.mjs';
import {stageIndependentRatioSnapshot} from './fee-ratio-snapshot-packet.mjs';
import {createRankedExposureCore} from './xuan-ib-sharesight-exposure.mjs';
import {createFeeRatioCore} from './fee-ratio-management.mjs';
import {createRatioSnapshotCore} from './fee-ratio-snapshot.mjs';
import {createRatioSourceCore} from './fee-ratio-source-core.mjs';

import {makeFixture,hash,NOW,WORKSPACE,OUTPUT} from './fee-ratio-intake-snapshot-fixture.mjs';

// Same invented layout/values as syntheticOfficialSource in the existing
// official-source tests, kept local so importing it cannot run real-IO tests.
function syntheticOriginal(){
  const accounts=['IB-HK','NOAH-HK',...Array.from({length:8},(_,i)=>'Synthetic '+i)],positions=[],cashAccounts=[],rows=[];
  let cr=10,er=5;
  const position=(account,securityCode,market,sharesightCategory,valueUSD)=>{
    const p={sourceRow:cr++,account,name:'Synthetic '+securityCode,valueUSD,sharesightCategory,securityCode,market,quantity:2};positions.push(p);return p;
  };
  const exposure=(p,ownership,valueUSD,extra={})=>rows.push({sourceRow:er++,account:p.account,securityCode:p.securityCode,market:p.market,name:p.name,withinETF:null,ownership,valueUSD,sourcePercentage:null,...extra});
  for(let i=0;i<3;i++)for(let j=0;j<5;j++)exposure(position(accounts[i+2],'F'+i+j,'PRIVATE',['VC/PE','对冲基金','常青基金'][i],100-j),'Direct',110-j);
  for(const [i,code,market]of [[0,'VST','NYSE'],[1,'GOOG','NASDAQ'],[2,'GOOGL','NASDAQ'],[3,'OTHER','TEST'],[4,'USSC','TEST']])exposure(position('IB-HK',code,market,['美国底仓','美国科技','非美发达','新兴市场','美国底仓'][i],30+i),'Direct',40+i);
  exposure(position('IB-HK','GLD','NYSE','主题投资',9),'Direct',10);
  exposure(position('IB-HK','GOLD','NYSE','主题投资',8),'Direct',9);
  const etf=position('IB-HK','VSTL','NASDAQ','主题投资',20);
  exposure(etf,'Underlying',60,{securityCode:'VST',market:'NYSE',name:'Synthetic VST underlying',withinETF:'VSTL.NASDAQ'});exposure(etf,'Residual',-30);
  const other=position('IB-HK','INDEX','TEST','主题投资',10);
  exposure(other,'Underlying',8,{securityCode:'EXTRA',market:'TEST',name:'Synthetic extra underlying',withinETF:'INDEX.TEST'});exposure(other,'Residual',2);
  for(const account of accounts.slice(0,2)){
    const c={sourceRow:cr++,account,name:'Synthetic USD cash',valueUSD:5,sharesightCategory:'Cash Accounts'};cashAccounts.push(c);
    rows.push({sourceRow:er++,account,securityCode:null,market:null,name:c.name,withinETF:null,ownership:'Cash',valueUSD:6,sourcePercentage:null});
  }
  const capture=(asOf,at,count)=>({asOf,capturedAt:at,captureTimeBasis:'original-download-file-mtime',downloadCompletedAt:null,serverSuggestedOriginalFilename:null,dateEvidence:'Showing as at '+(asOf.endsWith('29')?'29':'30')+' Oct 2026',canonicalDataRows:count,allWorksheetXmlRows:count+5});
  const allocation={schemaVersion:'sharesight-private-full-v2',source:{provider:'Sharesight',view:'All Together',transport:'official-workbook-exports'},accounts,
    sources:['classification.xlsx','exposure.xlsx','capture-metadata.json'].map((file,i)=>({file,sha256:String(i+1).repeat(64),libraryFileId:'libfile_'+String(i+1).repeat(32),libraryVersion:0})),
    classification:{...capture('2026-10-29','2026-10-30T05:31:53.561Z',positions.length+cashAccounts.length),positions,cashAccounts},
    exposure:{...capture('2026-10-30','2026-10-30T05:28:49.118Z',rows.length),rows},
    coverage:{classificationCombinedComplete:true,exposureCombinedComplete:true,groupingSheetsAreDuplicates:true,closedPositionsIncluded:false,transactionHistoryIncluded:false,completeETFUniverseClaimed:false},limitations:['Synthetic complete Combined; grouping sheets duplicate it.']};
  const member=positions[0];
  return {schemaVersion:'sharesight-private-performance-v1',accounts:[...accounts],allocation,performanceCapturedAt:'2026-10-30T05:50:00.000Z',
    performance:{schema:'fee-console.ratio-performance-source.v2',provider:'Sharesight',currency:'USD',asOf:'2026-10-30',accounts:[...accounts],reports:['all','oneYear'].map((period,i)=>({
      period,startDate:i?'2025-10-30':'2020-01-02',endDate:'2026-10-30',includeClosed:true,calculationMethod:'sharesight-native',currency:'USD',cashPerformance:'unknown',
      source:{libraryFileId:'libfile_'+String(i+4).repeat(32),version:0,sha256:String(i+4).repeat(64),locator:'Synthetic native total cells'},
      rows:[{scope:{type:'classification',name:'PE/VC',parent:null},members:[{account:member.account,market:member.market,securityCode:member.securityCode}],sourceSheet:'Synthetic Combined',sourceRow:9,returnPct:i?-2.1:8.25,unit:i?'period':'p.a.',termEvidence:{type:'unknown'}}],unavailable:[],
    }))}};
}

const fixture=t=>{const raw=syntheticOriginal();return makeFixture(t,{raw,originalBytes:Buffer.from(JSON.stringify(raw))});};

test('actual collected bytes and pins reach the independent snapshot consumer as an unsigned candidate',async t=>{
  const f=await fixture(t),before=new Map([...f.mem.nodes].filter(([,v])=>v.bytes).map(([p,v])=>[p,Buffer.from(v.bytes)]));
  assert.equal(f.prepared.status,'PREPARED_UNAUTHENTICATED');assert.equal(f.prepared.publicationReady,false);assert.equal(f.prepared.downloadVerified,false);
  const validation=await f.stage(),packet=f.readOutput('fee-console-ratio-snapshot.candidate.json'),envelope=f.readOutput('ratio.envelope.json');
  assert.equal(validation.status,'RATIO_INDEPENDENT_CANDIDATE_ONLY');
  for(const field of ['publicationReady','managerAuthentication','feeOrHealthWrite','financialRead','keychainRead'])assert.equal(validation[field],false);
  assert.deepEqual(f.readOutput('validation.json'),validation);assert.equal(packet.authentication,null);assert.deepEqual(packet.body.envelope,envelope);
  assert.equal(packet.body.source.sourceSha256,f.prepared.sourceSha256);assert.equal(packet.body.source.inputSha256,f.prepared.inputSha256);assert.equal(packet.body.source.libraryVersion,0);
  assert.equal(packet.body.scopeId,f.manager.recipient.scopeId);assert.equal(packet.body.source.scopeHash,f.exposureCore.ALL_TOGETHER_SCOPE_SHA256);
  assert.deepEqual(packet.body.source.sourceDates,f.prepared.sourceDates);assert.equal(packet.body.source.capturedAt,f.prepared.earliestCapturedAt);
  assert.equal(Date.parse(packet.body.source.expiresAt)-Date.parse(packet.body.source.capturedAt),36*3600000);
  const model=await f.ratio.open(envelope,f.manager);
  assert.equal(model.report.targetDate,'2026-10-30');assert.equal(model.report.feeAccountingThrough,null);
  assert.deepEqual(model.sourceDates,{classification:'2026-10-29',exposure:'2026-10-30',performance:'2026-10-30'});
  assert.deepEqual(model.performance,f.raw.performance);assert.equal(model.exposure.summary.asOf,f.raw.allocation.exposure.asOf);
  assert.equal(model.book.browserEvidence.integrity,'verified-original-library-association');assert.ok(f.identityReads()>1);
  const snapshot=createRatioSnapshotCore(f.ratio,f.exposureCore,createRatioSourceCore,b=>JSON.parse(Buffer.from(b)),crypto.webcrypto);
  await assert.rejects(snapshot.verify(packet,f.manager,{now:NOW}),/RATIO_SNAPSHOT_REFUSED/);
  assert.deepEqual(f.mem.writes.map(p=>path.basename(p)).sort(),['fee-console-ratio-snapshot.candidate.json','ratio.envelope.json','validation.json']);
  assert.equal(f.mem.get(OUTPUT).mode,0o700);for(const p of f.mem.writes)assert.equal(f.mem.get(p).mode,0o600);
  for(const [p,bytes]of before)assert.deepEqual(f.mem.get(p).bytes,bytes,'source and plan files stay unchanged');
  const saved=f.mem.writes.map(p=>Buffer.from(f.mem.get(p).bytes));
  await assert.rejects(f.stage(),/RATIO_SNAPSHOT_PACKET_REFUSED/);assert.equal(f.mem.writes.length,3);
  f.mem.writes.forEach((p,i)=>assert.deepEqual(f.mem.get(p).bytes,saved[i]));
});

for(const [name,change]of [
  ['original byte changed after intake',f=>f.mem.put(f.evidence.source.path,Buffer.concat([Buffer.from(f.prepared.originalBytes),Buffer.from(' ')]))],
  ['input byte changed after intake',f=>f.mem.put(f.evidence.input.path,Buffer.concat([Buffer.from(f.prepared.inputBytes),Buffer.from(' ')]))],
  ['self-repinned altered input',f=>{const input=JSON.parse(Buffer.from(f.prepared.inputBytes));input.exposure.summary.asOf='2026-10-29';f.evidence.input=f.mem.put(f.evidence.input.path,input);f.saveEvidence();}],
  ['self-repinned altered original',f=>{const raw=structuredClone(f.raw);raw.allocation.classification.positions[0].valueUSD++;f.evidence.source=f.mem.put(f.evidence.source.path,raw);f.saveEvidence();}],
  ['Library ID mismatch',f=>{f.identity.libraryFileId='libfile_'+'c'.repeat(32);}],
  ['Library version mismatch',f=>{f.identity.version=1;}],
  ['manager scope mismatch',f=>{f.evidence.managerScopeId='f'.repeat(64);f.saveEvidence();}],
  ['account scope mismatch',f=>{f.exposureCore.ALL_TOGETHER_SCOPE_SHA256='f'.repeat(64);}],
  ['production scope rejects invented accounts',f=>{Object.assign(f.exposureCore,createRankedExposureCore());}],
  ['expired capture',f=>{f.at=new Date('2026-11-01T00:00:00.000Z');}],
  ['future capture relative to consumer',f=>{f.at=new Date('2026-10-30T05:20:00.000Z');}],
  ['missing existing identity reader',f=>{f.evidenceRuntime={uid:process.getuid(),readIdentity(){throw Error('SYNTHETIC_IDENTITY_UNAVAILABLE');}};}],
  ['workspace with git ancestor',f=>{f.mem.mkdir('/synthetic-ratio-integration/.git');}],
  ['workspace is not private',f=>{f.mem.get(WORKSPACE).mode=0o755;}],
  ['source symlink',f=>{f.mem.get(f.evidence.source.path).kind='symlink';}],
  ['source foreign owner',f=>{f.mem.get(f.evidence.source.path).uid++;}],
  ['source hardlink',f=>{f.mem.get(f.evidence.source.path).nlink=2;}],
  ['source nonprivate mode',f=>{f.mem.get(f.evidence.source.path).mode=0o644;}],
])test('composed consumers refuse '+name+' before candidate writes',async t=>{
  const f=await fixture(t);change(f);
  await assert.rejects(f.stage({...(f.at?{now:f.at}:{}),...(f.evidenceRuntime?{evidenceRuntime:f.evidenceRuntime}:{})}),/REFUSED|SYNTHETIC_IDENTITY_UNAVAILABLE/);
  assert.equal(f.mem.nodes.has(OUTPUT),false);assert.equal(f.mem.writes.length,0);
});

for(const role of ['source','input','identity'])test('composed consumers recheck '+role+' and remove only new candidate files after a write-time change',async t=>{
  const f=await fixture(t);
  f.mem.onWrite=()=>{f.mem.onWrite=null;if(role==='identity')f.identity.version++;else{const p=f.evidence[role].path;f.mem.put(p,Buffer.concat([f.mem.get(p).bytes,Buffer.from(' ')]));}};
  await assert.rejects(f.stage(),/RATIO_SNAPSHOT_PACKET_REFUSED/);
  assert.equal(f.mem.writes.length,1);assert.equal(f.mem.nodes.has(OUTPUT),false);
  assert.ok(f.mem.nodes.has(f.evidence.source.path));assert.ok(f.mem.nodes.has(f.evidence.input.path));assert.ok(f.mem.nodes.has(f.plan.evidence.path));assert.ok(f.mem.nodes.has(f.plan.recipient.path));
});

test('intake rejects altered pins, fixed scope and changed capture evidence before staging',()=>{
  const raw=syntheticOriginal(),originalBytes=Buffer.from(JSON.stringify(raw));
  const exposureCore={...createRankedExposureCore(),ALL_TOGETHER_SCOPE_SHA256:hash(JSON.stringify([...raw.accounts].sort()))};
  const args={originalBytes,expectedSha256:hash(originalBytes),now:NOW,exposureCore};
  assert.throws(()=>prepareCollectedRatioInput({...args,expectedSha256:'0'.repeat(64)}),/RATIO_COLLECTION_HASH/);
  assert.throws(()=>prepareCollectedRatioInput({...args,exposureCore:createRankedExposureCore()}),/RATIO_COLLECTION_SOURCE_CONTRACT/);
  for(const edit of [
    r=>{r.accounts[0]='Synthetic outside frozen scope';},
    r=>{r.performanceCapturedAt='2026-10-27T00:00:00.000Z';},
    r=>{r.allocation.exposure.capturedAt='2026-10-31T00:00:00.000Z';},
  ]){const changed=structuredClone(raw);edit(changed);const bytes=Buffer.from(JSON.stringify(changed));assert.throws(()=>prepareCollectedRatioInput({...args,originalBytes:bytes,expectedSha256:hash(bytes)}),/RATIO_COLLECTION_SOURCE_CONTRACT/);}
});
