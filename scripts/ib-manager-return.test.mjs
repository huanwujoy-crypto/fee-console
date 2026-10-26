import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {buildIbManagerReturnReceipt,createIbManagerReturnConsumer} from './ib-manager-return.mjs';
import {prepareIbManagerReturn} from './ib-manager-return-file.mjs';
import {buildFeeCalculationReceipt} from './fee-receipt-core.mjs';
// Entirely synthetic. No account identity, private input, key store or network.
const fixture=()=>({schema:'fee-console.ib-manager-return-input.v1',currency:'USD',timezone:'America/New_York',flowTiming:'eod',flowsComplete:true,correctionsConfirmed:true,sourceSha256:'a'.repeat(64),periodReturnsInput:{points:[{d:'2026-08-31',tot:100},{d:'2026-09-01',tot:150},{d:'2026-09-02',tot:135}],openT:100,from:'2026-08-31',to:'2026-09-02',days:3,flowByDate:{'2026-09-01':50},rate:0,cr:0,cumBefore:0,hwmBefore:0}});
const core=createIbManagerReturnConsumer();
const feeView=r=>({state:'verified',start:r.start,asOf:r.asOf,periods:r.periods.map(({grossTwrPpm,...p})=>p)});
test('cash and in-kind EOD flows are excluded; zero and negative months remain real values',async()=>{
  const r=await buildIbManagerReturnReceipt(fixture());
  assert.deepEqual(r.periods.map(p=>p.grossTwrPpm),[0,-100000]);assert.equal(r.grossTwrPpm,-100000);
  const v=await core.project(r,feeView(r));assert.equal(v.state,'verified');assert.equal(v.byMonth['2026-08'],0);assert.equal(v.byMonth['2026-09'],-.1);
  const x=fixture();x.periodReturnsInput.points[1].tot=50;x.periodReturnsInput.points[2].tot=45;x.periodReturnsInput.flowByDate['2026-09-01']=-50;
  assert.deepEqual((await buildIbManagerReturnReceipt(x)).periods,r.periods);
});
test('missing, unconfirmed, misdated or malformed history never becomes a return',async()=>{
  const changes=[x=>x.flowsComplete=false,x=>x.correctionsConfirmed=false,x=>x.currency='HKD',x=>x.periodReturnsInput.points.pop(),x=>x.periodReturnsInput.points[1].d='2026-09-02',x=>x.periodReturnsInput.points[1].tot=NaN,x=>x.periodReturnsInput.openT=0,x=>x.periodReturnsInput.days=4,x=>x.periodReturnsInput.flowByDate['2026-09-03']=1,x=>x.periodReturnsInput.flowByDate['bad']=0,x=>x.periodReturnsInput.rate=.02];
  for(const change of changes){const x=fixture();change(x);await assert.rejects(buildIbManagerReturnReceipt(x));}
  assert.equal((await core.project(null,{})).value,null);assert.equal((await core.project({},{})).state,'pending');
});
test('receipt tampering and mismatched dates/month boundaries suppress all IB values',async()=>{
  const r=await buildIbManagerReturnReceipt(fixture()),v=feeView(r);
  for(const mutate of [x=>x.periods[0].grossTwrPpm++,x=>x.scope='composite',x=>x.currency='HKD',x=>x.asOf='2026-09-03',x=>x.extra=1]){const bad=structuredClone(r);mutate(bad);assert.equal((await core.project(bad,v)).value,null);}
  for(const mutate of [x=>x.asOf='2026-09-03',x=>x.start='2026-08-01',x=>x.periods[0].from='2026-08-01',x=>x.state='pending']){const bad=structuredClone(v);mutate(bad);const out=await core.project(r,bad);assert.equal(out.state,'pending');assert.equal(out.value,null);assert.deepEqual(out.byMonth,{});assert.equal(out.asOf,r.asOf);}
  assert.deepEqual(feeView(r),v);
});
test('receipt contains only dates/returns/commitments, never raw positions, flow amounts or identifiers',async()=>{
  const r=await buildIbManagerReturnReceipt(fixture()),s=JSON.stringify(r);
  assert.doesNotMatch(s,/openT|flowByDate|quantity|accountId|portfolioId|\"tot\"|\"amount\"/);
  assert.equal((await core.validate(r)).ok,true);
});
test('the browser consumes the exact reviewed receipt factory',async()=>{
  const file=process.env.FEE_LEDGER_TEST_INDEX||new URL('../index.html',import.meta.url);
  if(process.env.GITHUB_ACTIONS==='true'&&process.env.FEE_LEDGER_TEST_INDEX)throw Error('local preview only');
  const html=fs.readFileSync(file,'utf8'),a='/* ib-manager-return-consumer:start */',b='/* ib-manager-return-consumer:end */';
  if(!html.includes(a)){assert.ok(!html.includes(b));return;}
  const block=html.slice(html.indexOf(a)+a.length,html.indexOf(b));assert.equal(block.trim(),createIbManagerReturnConsumer.toString());
  const box={crypto:crypto.webcrypto,TextEncoder,structuredClone};vm.createContext(box);vm.runInContext(block+';globalThis.ibTestCore=createIbManagerReturnConsumer();',box);
  const r=await buildIbManagerReturnReceipt(fixture());assert.deepEqual(JSON.parse(JSON.stringify(await box.ibTestCore.project(r,feeView(r)))),await core.project(r,feeView(r)));
});
test('comparison row and monthly column consume only verified IB outputs, including zero/negative values',async()=>{
  const file=process.env.FEE_LEDGER_TEST_INDEX||new URL('../index.html',import.meta.url),html=fs.readFileSync(file,'utf8');
  if(!html.includes('/* ib-manager-return:receipt-v1 */'))return;
  const box={};vm.createContext(box);
  vm.runInContext(`const esc=v=>String(v??'');const pct=v=>v==null?'—':(v>0?'+':'')+(v*100).toFixed(2)+'%';const sgn=v=>v>0?'pos':v<0?'neg':'';const ymLabel=v=>v;`,box);
  vm.runInContext(html.slice(html.indexOf('function ibManagerReturnNote('),html.indexOf('const DRAWDOWN_METHOD_NOTE=')),box);
  vm.runInContext(html.slice(html.indexOf('function renderReturnComparison('),html.indexOf('/* compact-comparison-tables:end */')),box);
  vm.runInContext(html.slice(html.indexOf('let _monthHistoryYm='),html.indexOf('function toggleMonthReturnHistory(')),box);
  const r=await buildIbManagerReturnReceipt(fixture()),view=await core.project(r,feeView(r)),st={twrG:.2,mwrD:.1,bench:[{k:'spy',twr:.3},{k:'qqq',twr:.4}],ibManager:view},before=structuredClone(st);
  const out=box.renderReturnComparison(st),ib=out.match(/<tr data-return-series="ib"[^]*?<\/tr>/)[0];
  assert.match(ib,/-10\.00%/);assert.ok(out.includes(ib+'<tr data-return-series="spy"'));assert.match(out,/后续尚未自动更新/);assert.deepEqual(st,before);
  const model={months:r.periods.map(p=>({...p,rG:.2,rB:{spy:.3,qqq:.4}})),selectedYm:'2026-09'};
  const table=box.monthlyReturnsTable(model,view);assert.match(table,/0\.00%/);assert.match(table,/-10\.00%/);assert.match(table,/\+20\.00%/);assert.match(table,/\+30\.00%/);
  for(const mode of ['missing','invalid','period-mismatch']){const pending={state:'pending',reason:mode,asOf:r.asOf,value:null,byMonth:{}};st.ibManager=pending;const text=box.renderReturnComparison(st).match(/<tr data-return-series="ib"[^]*?<\/tr>/)[0];assert.match(text,/待核对/);assert.doesNotMatch(text,/%/);for(const cell of box.monthlyReturnsTable(model,pending).matchAll(/<td data-return-series="ib"[^]*?<\/td>/g))assert.doesNotMatch(cell[0],/%/);}
  const flat=fixture();flat.periodReturnsInput.points[2].tot=150;const zero=await buildIbManagerReturnReceipt(flat);st.ibManager=await core.project(zero,feeView(zero));assert.match(box.renderReturnComparison(st).match(/<tr data-return-series="ib"[^]*?<\/tr>/)[0],/0\.00%/);
  assert.match(html,/ibManagerReturnCore\.project\(source\.state==="verified"&&sourceMatches\(source\)\?DAILY\.ibManagerReturnReceipt:null,feeView\)/);
});
test('offline encrypted candidate preserves every composite input, fee receipt and original ciphertext',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ib-return-synthetic-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const key=crypto.randomBytes(32),keyText=key.toString('base64url'),file=path.join(dir,'existing.enc.json'),inputFile=path.join(dir,'input.json'),outputFile=path.join(dir,'candidate.enc.json');
  const source=fixture(),economicInput={v:4,settings:{start:source.periodReturnsInput.from,mgmt:2,carry:20,fx:{USD:1}},accounts:[{id:'schwab',opening:60},{id:'webull',opening:40}],months:[],fees:[]};
  const data={daily:source.periodReturnsInput.points.map(p=>({d:p.d,schwab:60,webull:40})),flowsAuto:[],flowsUnresolved:[],status:{asOf:source.periodReturnsInput.to,provisional:false,calibrated:true,unresolvedCount:0}};data.feeCalculationReceipt=buildFeeCalculationReceipt({data,economicInput});
  const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv),original=JSON.stringify({enc:true,v:3,data:Buffer.concat([iv,c.update(JSON.stringify(data)),c.final(),c.getAuthTag()]).toString('base64')});
  fs.writeFileSync(file,original);fs.writeFileSync(inputFile,JSON.stringify(source),{mode:0o600});
  const args={file,inputFile,outputFile,keyText,environ:{}};
  assert.equal((await prepareIbManagerReturn(args)).status,'IB_RETURN_ATTACHMENT_DRY_RUN_OK');assert.equal(fs.existsSync(outputFile),false);
  await prepareIbManagerReturn({...args,execute:true});assert.equal(fs.readFileSync(file,'utf8'),original);assert.equal(fs.statSync(outputFile).mode&0o777,0o600);
  const b=Buffer.from(JSON.parse(fs.readFileSync(outputFile)).data,'base64'),d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(-16));const candidate=JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]));
  const {ibManagerReturnReceipt,...rest}=candidate;assert.deepEqual(rest,data);assert.equal((await core.validate(ibManagerReturnReceipt)).ok,true);
  await assert.rejects(prepareIbManagerReturn({...args,execute:true}));
  await assert.rejects(prepareIbManagerReturn({...args,environ:{GITHUB_ACTIONS:'true'}}));
  const mismatch=fixture();mismatch.periodReturnsInput.from='2026-08-30';fs.writeFileSync(inputFile,JSON.stringify(mismatch));await assert.rejects(prepareIbManagerReturn({...args,outputFile:path.join(dir,'refused.json'),execute:true}));assert.equal(fs.existsSync(path.join(dir,'refused.json')),false);
});
