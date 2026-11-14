import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {IB_PAST_POINT_PLAN,IB_PAST_POINT_SCHEMA,ibPastPointDiagnosticActive,validateIbPastPointBase,ibPastPointSummary,runIbPastPointDiagnostic} from './ib-past-point-diagnostic.mjs';
import {IB_PAST_POINT_SITES,IB_PAST_POINT_FIELDS} from './ib-manager-source.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const from=Date.parse(IB_PAST_POINT_PLAN.from),expires=Date.parse(IB_PAST_POINT_PLAN.expires);
const KEYS=['schema','status','phase','reasonCode','anchorDate','targetDate','pastPointSite','pastPointFields','transportReason','sourceGets','oauthGrants','reportGenerated','publicationReady'];

test('the plan is one fixed day against one pinned published baseline inside a short window',()=>{
  assert.ok(Object.isFrozen(IB_PAST_POINT_PLAN));
  assert.equal(IB_PAST_POINT_PLAN.target,'2026-11-13');assert.equal(IB_PAST_POINT_PLAN.anchor,'2026-11-12');
  assert.match(IB_PAST_POINT_PLAN.dataSha256,/^[a-f0-9]{64}$/);assert.match(IB_PAST_POINT_PLAN.dataBlob,/^[a-f0-9]{40}$/);assert.match(IB_PAST_POINT_PLAN.healthBlob,/^[a-f0-9]{40}$/);
  assert.ok(expires>from&&expires-from<=4*86400000);
  assert.equal(ibPastPointDiagnosticActive(from-1),false);assert.equal(ibPastPointDiagnosticActive(from),true);
  assert.equal(ibPastPointDiagnosticActive(expires),true);assert.equal(ibPastPointDiagnosticActive(expires+1),false);
  for(const bad of [undefined,null,NaN,'2026-11-14',from+0.5])assert.equal(ibPastPointDiagnosticActive(bad),false);
});
test('only the pinned baseline bytes are accepted',()=>{
  assert.throws(()=>validateIbPastPointBase({data:Buffer.from('{}'),health:Buffer.from('{}')}),/IB_PAST_POINT_DIAGNOSTIC_BASE_BYTES/);
  assert.throws(()=>validateIbPastPointBase({data:'{}',health:Buffer.from('{}')}),/BASE_BYTES/);
  assert.throws(()=>validateIbPastPointBase({}),/BASE_BYTES/);
});
test('the printed summary is rebuilt from closed vocabularies and carries no free text or number',()=>{
  const good=ibPastPointSummary({status:'incomplete',phase:'SOURCE_PREPARE',reasonCode:'IB_SOURCE_PAST_POINT_CHANGED',pastPointSite:'ANCHOR_SNAPSHOT',
    pastPointFields:['markValue','marks','cash'],transportReason:'NONE',sourceGets:9,oauthGrants:1});
  assert.deepEqual(Object.keys(good),KEYS);assert.equal(good.schema,IB_PAST_POINT_SCHEMA);
  assert.deepEqual(good.pastPointFields,['cash','marks','markValue']);assert.equal(good.reportGenerated,false);assert.equal(good.publicationReady,false);
  const hostile=ibPastPointSummary({status:'PRIVATE_CANARY',phase:'PRIVATE_CANARY',reasonCode:'IB_SOURCE_x amount=123456.78',pastPointSite:'PRIVATE_CANARY',
    pastPointFields:['PRIVATE_CANARY','markValue',123456],transportReason:'PRIVATE_CANARY',sourceGets:123456,oauthGrants:-1,extra:'PRIVATE_CANARY',amount:123456.78});
  assert.deepEqual(hostile,{schema:IB_PAST_POINT_SCHEMA,status:'incomplete',phase:'PREFLIGHT',reasonCode:'UNKNOWN',anchorDate:'2026-11-12',targetDate:'2026-11-13',
    pastPointSite:'NONE',pastPointFields:[],transportReason:'NONE',sourceGets:0,oauthGrants:0,reportGenerated:false,publicationReady:false});
  assert.equal(JSON.stringify(hostile).includes('PRIVATE_CANARY'),false);
  for(const site of IB_PAST_POINT_SITES)assert.equal(ibPastPointSummary({pastPointSite:site,pastPointFields:[...IB_PAST_POINT_FIELDS]}).pastPointFields.length,IB_PAST_POINT_FIELDS.length);
  assert.deepEqual(Object.keys(ibPastPointSummary()),KEYS);
});
test('the run refuses before any credential or request outside the window, checkout or pinned baseline',async()=>{
  const lines=[];let fetched=0;
  const base={env:{RUNNER_TEMP:os.tmpdir(),FEE_DATA_KEY:'synthetic',FEE_CLOUD_SHARESIGHT_CLIENT_ID:'synthetic',FEE_CLOUD_SHARESIGHT_CLIENT_SECRET:'synthetic'},
    checkCheckout(){},readRegular:()=>Buffer.from('{}'),fetchImpl:async()=>{fetched++;throw Error('PRIVATE_CANARY');},log:l=>lines.push(l),now:()=>from+60000};
  for(const [change,reason] of [[{now:()=>expires+1},'IB_PAST_POINT_DIAGNOSTIC_EXPIRED'],[{now:()=>from-1},'IB_PAST_POINT_DIAGNOSTIC_EXPIRED'],
    [{checkCheckout(){throw Error('PRIVATE_CANARY head');}},'IB_PAST_POINT_DIAGNOSTIC_FAILED'],[{},'IB_PAST_POINT_DIAGNOSTIC_BASE_BYTES'],
    [{checkOnly:true},'IB_PAST_POINT_DIAGNOSTIC_BASE_BYTES'],[{env:null},'IB_PAST_POINT_DIAGNOSTIC_ENVIRONMENT'],[{readRegular:null},'IB_PAST_POINT_DIAGNOSTIC_ENVIRONMENT']]){
    const done=await runIbPastPointDiagnostic({...base,...change});
    assert.equal(done.exitCode,1);assert.equal(done.summary.status,'incomplete');assert.equal(done.summary.phase,'PREFLIGHT');assert.equal(done.summary.reasonCode,reason);
    assert.equal(done.summary.sourceGets,0);assert.equal(done.summary.oauthGrants,0);
  }
  assert.equal(fetched,0);assert.equal(lines.length,7);assert.equal(lines.join('').includes('PRIVATE_CANARY'),false);
  assert.equal(fs.existsSync(path.join(fs.realpathSync(os.tmpdir()),'fee-ib-diagnostic')),false);
});
test('source has no writer, production call, economic source, retry or added workflow surface',()=>{
  const source=fs.readFileSync(path.join(ROOT,'scripts/ib-past-point-diagnostic.mjs'),'utf8');
  for(const forbidden of ['writeFileSync(','produceReportPeriod(',"import('./daily.mjs')",'fetchEconomicSnapshot','FEE_ECON','uploadArtifact','dispatchWorkflow','claimOnce','createSigned','process.env','console.error','.apply(payload'])
    assert.equal(source.includes(forbidden),false,forbidden);
  const entry=fs.readFileSync(path.join(ROOT,'scripts/fee-source-revision-diagnostic.mjs'),'utf8');
  // The dated branch is reached only after the entry's own event, actor and environment validation.
  const validated=entry.indexOf('validateRevisionDiagnosticEvent({env:{...env},event,...options,execArgv:process.execArgv});'),branch=entry.indexOf('if(ibPastPointDiagnosticActive(Date.now())){');
  assert.ok(validated>0&&branch>validated&&branch<entry.indexOf('const transport=revisionDiagnosticTransport()'));
  const workflow=fs.readFileSync(path.join(ROOT,'.github/workflows/fee-cloud-producer.yml'),'utf8');
  assert.equal(workflow.includes('past-point'),false);assert.equal(workflow.includes('past_point'),false);
});
