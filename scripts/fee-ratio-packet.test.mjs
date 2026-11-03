import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {attachIbBootstrap,prepareIbBootstrapAttachment,prepareRatioAttachment} from './fee-ratio-packet.mjs';
import {buildIbManagerReturnReceipt,buildIbManagerDrawdownReceipt,buildIbOwnerBaseline,validateIbManagerReportState,validateIbOwnerBaselineState,createIbManagerReturnConsumer} from './ib-manager-return.mjs';
import {ibBaselineBusinessHash} from './ib-manager-source.mjs';
import {buildFeeCalculationReceipt} from './fee-receipt-core.mjs';

// Entirely synthetic history and identifiers; no transport or credential API.
async function fixture(){
  const baseline={schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:'a'.repeat(64),
    periodReturnsInput:{points:[{d:'2026-08-30',tot:100},{d:'2026-08-31',tot:110}],openT:100,from:'2026-08-30',to:'2026-08-31',days:2,flowByDate:{},rate:0,cr:0,cumBefore:0,hwmBefore:0}};
  const expected=ibBaselineBusinessHash(baseline.periodReturnsInput),owner=await buildIbOwnerBaseline({ibManagerReturnReceipt:await buildIbManagerReturnReceipt(baseline),ibManagerDrawdownReceipt:await buildIbManagerDrawdownReceipt(baseline)},baseline,expected);
  const c={schema:'fee-console.ib-manager-coverage.v2',authority:'reviewed-source-reconciliation',sourceProvider:'Sharesight',baselineInputsHash:expected,from:'2026-09-01',through:'2026-09-02',evidenceSha256:'e'.repeat(64),events:[],quotes:[]};
  const coverage={...c,coverageId:await createIbManagerReturnConsumer().digest(c)},points=[...baseline.periodReturnsInput.points,{d:'2026-09-01',tot:120},{d:'2026-09-02',tot:114}];
  const frozenInput={...structuredClone(baseline),sourceSha256:'b'.repeat(64),periodReturnsInput:{...structuredClone(baseline.periodReturnsInput),points,to:'2026-09-02',days:4}};
  const source={schema:'fee-console.ib-manager-source.v3',scope:'ib-manager',currency:'USD',timezone:'America/New_York',flowTiming:'eod',baselineFrom:'2026-08-30',baselineAsOf:'2026-08-31',baselineInputsHash:expected,portfolioIdentityHash:'c'.repeat(64),sourceAsOf:'2026-09-02',sourceEvidenceHash:'d'.repeat(64),cashFlowByDate:{},noncashProofs:[],periodReturnsInput:structuredClone(frozenInput.periodReturnsInput),ownerBaseline:owner,bootstrapCoverage:coverage,
    closingSnapshots:points.slice(-2).map(p=>({d:p.d,totalCents:Math.round(p.tot*100),cash:{'3':0},cashCurrency:{'3':'USD'},positions:{'2':'1000000000000000000'},marks:{'2':null}}))};
  const data={daily:points.map(p=>({d:p.d,schwab:60,webull:40})),flowsAuto:[],flowsUnresolved:[],status:{asOf:'2026-09-02',provisional:false,calibrated:true,unresolvedCount:0},opaque:{keep:'unchanged'}};
  const economic={v:4,settings:{start:'2026-08-30',mgmt:2,carry:20,fx:{USD:1}},accounts:[{id:'schwab',opening:60},{id:'webull',opening:40}],months:[],fees:[]};
  data.feeCalculationReceipt=buildFeeCalculationReceipt({data,economicInput:economic});data.ibManagerReturnReceipt=await buildIbManagerReturnReceipt(frozenInput);data.ibManagerDrawdownReceipt=await buildIbManagerDrawdownReceipt(frozenInput);
  return {data,baseline,coverage,expected,native:{schema:'fee-console.ib-native-bootstrap-input.v1',frozenInput,source}};
}
test('native bootstrap preserves the exact frozen daily/monthly path and fee data, then has an authenticated checkpoint',async()=>{
  const f=await fixture(),before=structuredClone(f.data),out=await attachIbBootstrap(f.data,f.baseline,f.coverage,f.native);
  assert.deepEqual(f.data,before);assert.equal(out.ibManagerReturnReceipt.schema,'fee-console.ib-manager-return-receipt.v2');
  assert.deepEqual(out.ibManagerReturnReceipt.periods,before.ibManagerReturnReceipt.periods);
  assert.equal(out.ibManagerReturnReceipt.grossTwrPpm,before.ibManagerReturnReceipt.grossTwrPpm);
  assert.deepEqual(out.ibManagerDrawdownReceipt.dailyFactors,before.ibManagerDrawdownReceipt.dailyFactors);
  assert.deepEqual(await validateIbManagerReportState(out,f.expected),f.native.source);assert.ok(await validateIbOwnerBaselineState(out,f.expected));
  const strip=o=>Object.fromEntries(Object.entries(o).filter(([k])=>!k.startsWith('ibManager')));assert.deepEqual(strip(out),strip(before));
  await assert.rejects(attachIbBootstrap(out,f.baseline,f.coverage,f.native));
});
for(const [name,mutate] of [
  ['complete frozen-input commitment',f=>f.native.frozenInput.sourceSha256='f'.repeat(64)],
  ['frozen NAV rather than just factors',f=>f.native.frozenInput.periodReturnsInput.points[3].tot++],
  ['original baseline precision',f=>f.baseline.periodReturnsInput.points[0].tot+=0.001],
  ['source prefix',f=>f.native.source.periodReturnsInput.points[0].tot++],
  ['source currency',f=>f.native.source.currency='CAD'],
  ['source identity',f=>f.native.source.portfolioIdentityHash='not-a-hash'],
  ['source closing balance',f=>f.native.source.closingSnapshots[1].totalCents++],
  ['source cutoff',f=>f.native.source.sourceAsOf='2026-09-03'],
  ['finite audit',f=>f.coverage.through='2026-09-03'],
  ['unsupported flow',f=>f.native.source.cashFlowByDate['2026-09-02']=1],
  ['fee cutoff',f=>f.data.feeCalculationReceipt.asOf='2026-09-01'],
  ['existing baseline',f=>f.data.ibManagerBaselineState={}],
  ['unexpected packet field',f=>f.native.approved=true]
])test('native bootstrap rejects changed '+name,async()=>{const f=await fixture();mutate(f);await assert.rejects(attachIbBootstrap(f.data,f.baseline,f.coverage,f.native));});

test('real bootstrap-only CLI carries native evidence privately, refuses overwrite and cannot enter ratio or ordinary modes',async t=>{
  const f=await fixture(),dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ib-native-bootstrap-')));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const key=crypto.randomBytes(32),iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv),cipher=JSON.stringify({enc:true,v:3,data:Buffer.concat([iv,c.update(JSON.stringify(f.data)),c.final(),c.getAuthTag()]).toString('base64')});
  const write=(name,value)=>{const p=path.join(dir,name);fs.writeFileSync(p,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});return p;};
  const file=write('base.json',cipher),baselineFile=write('baseline.json',f.baseline),coverageFile=write('coverage.json',f.coverage),nativeFile=write('native.json',f.native),output=path.join(dir,'candidate');fs.mkdirSync(output,{mode:0o700});
  const args=['--file='+file,'--ib-baseline-input='+baselineFile,'--ib-coverage-input='+coverageFile,'--ib-native-input='+nativeFile,'--ib-bootstrap-output='+path.join(output,'data.json')];
  const run=extra=>spawnSync(process.execPath,[new URL('./daily.mjs',import.meta.url).pathname,...extra,...args],{encoding:'utf8',env:{PATH:process.env.PATH,FEE_DATA_KEY:key.toString('base64url')}});
  assert.equal(run(['--ib-bootstrap-only']).status,0);assert.deepEqual(fs.readdirSync(output),[]);
  const written=run(['--ib-bootstrap-only','--execute']);assert.equal(written.status,0,written.stderr);assert.match(written.stdout,/IB_BOOTSTRAP_ENCRYPTED_CANDIDATE_PREPARED/);
  const bytes=fs.readFileSync(path.join(output,'data.json'));assert.equal(fs.statSync(path.join(output,'data.json')).mode&0o777,0o600);
  assert.equal(run(['--ib-bootstrap-only','--execute']).status,1);assert.deepEqual(fs.readFileSync(path.join(output,'data.json')),bytes);assert.equal(fs.readFileSync(file,'utf8'),cipher);
  assert.equal(run([]).status,1);assert.equal(run(['--ratio-only']).status,1);assert.equal(run(['--ib-return-only']).status,1);
  await assert.rejects(prepareRatioAttachment({file,nativeFile,keyText:key.toString('base64url')}));
  await assert.rejects(prepareIbBootstrapAttachment({file,baselineFile,coverageFile,nativeFile,keyText:key.toString('base64url'),environ:{GITHUB_ACTIONS:'true'}}));
});
