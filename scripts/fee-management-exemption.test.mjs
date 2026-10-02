import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { monthlyGiftEvidence, managementSourceInput } from './fee-cloud-source.mjs';
import { resolveManagementExemptions, validateManagementRegistry } from './fee-management-exemption.mjs';
import { buildFeeCalculationReceipt, validateFeeCalculationReceipt, semanticHash } from './fee-receipt-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const d = '2026-10-01';
const rule = () => ({ id:'synthetic-gift-rule',account:'webull',portfolioId:1350094,holdingId:900,
  ticker:'SYNTH',firstHeldOn:d,effectiveFrom:d,authorizationRef:'synthetic owner instruction',giftTradeIds:[1] });
const source = () => ({schemaVersion:1,date:d,historyComplete:true,
  holdings:[{account:'webull',portfolioId:1350094,holdingId:900,ticker:'SYNTH',sourceDate:d,quantity:2,valueUsd:400}],
  trades:[{id:1,portfolioId:1350094,holdingId:900,date:d,type:'BUY',quantity:2,confirmed:true,giftEvidence:true,zeroPrice:true}]});
const resolve = (input=source(), proposals=[rule()], registry) => resolveManagementExemptions({
  input,proposals,registry,date:d,accounts:{webull:10000,schwab:10000}});
const fixture = () => {
  const result = resolve();
  return { data:{daily:[{d,schwab:10000,webull:10000,managementExemptions:result.rows}],
    managementExemptionRegistry:result.registry,flowsAuto:[],flowsUnresolved:[],
    status:{asOf:d,provisional:false,calibrated:true,unresolvedCount:0}},
    economicInput:{v:4,settings:{start:d,mgmt:2,carry:20,fx:{USD:1}},
      accounts:[{id:'schwab',opening:9000},{id:'webull',opening:9000}],months:[],fees:[]} };
};
test('approved gift lots reduce management basis while NAV, gross profit, TWR, carry and payments stay intact',()=>{
  const input=fixture(), fee=buildFeeCalculationReceipt(input), normal=structuredClone(input);
  delete normal.data.managementExemptionRegistry; delete normal.data.daily[0].managementExemptions;
  const before=buildFeeCalculationReceipt(normal);
  assert.equal(fee.engineVersion,'fee-v4.6.2'); assert.equal(before.engineVersion,'fee-v4.6.1');
  assert.equal(fee.periods[0].feeBaseSumCents,before.periods[0].feeBaseSumCents-40000);
  for(const key of ['closingCents','grossPnlCents','grossTwrPpm','carryCents'])assert.equal(fee.periods[0][key],before.periods[0][key]);
  assert.equal(fee.balance.paidCents,before.balance.paidCents);
  assert.ok(fee.totals.managementFeeCents<before.totals.managementFeeCents);
  assert.ok(validateFeeCalculationReceipt(fee,input.data).ok);
});
test('paid acquisitions, unapproved future gifts and other identities never inherit the exemption',()=>{
  const input=source();input.holdings[0].quantity=4;input.holdings[0].valueUsd=800;
  input.trades.push({...input.trades[0],id:2,giftEvidence:false,zeroPrice:false});
  input.holdings.push({...input.holdings[0],portfolioId:936249,account:'schwab',holdingId:901});
  assert.equal(resolve(input).rows[0].valueUsd,400);
  input.trades[1].giftEvidence=true;input.trades[1].zeroPrice=true;
  assert.equal(resolve(input).rows[0].valueUsd,400);
});
test('sales consume exempt quantity first, so mixed paid shares are never silently exempted',()=>{
  const input=source();input.holdings[0].quantity=3;input.holdings[0].valueUsd=600;
  input.trades.push({...input.trades[0],id:2,giftEvidence:false,zeroPrice:false},
    {...input.trades[0],id:3,type:'SELL',quantity:1,giftEvidence:false,zeroPrice:false});
  assert.equal(resolve(input).rows[0].valueUsd,200);
});
test('closed gift holding explicitly produces zero exemption',()=>{
  const input=source();input.holdings=[];
  input.trades.push({...input.trades[0],id:2,type:'SELL',giftEvidence:false,quantity:2});
  assert.equal(resolve(input).rows[0].valueUsd,0);
});
test('incomplete history, unconfirmed trade, unknown corporate action and quantity mismatch fail closed',()=>{
  for(const change of [s=>s.historyComplete=false,s=>s.trades[0].confirmed=false,
    s=>s.trades[0].type='SPLIT',s=>s.holdings[0].quantity=3,
    s=>s.trades[0].giftEvidence=false,s=>s.trades[0].zeroPrice=false,
    s=>s.holdings[0].sourceDate='2026-09-30',s=>s.holdings[0].ticker='OTHER']){
    const s=source();change(s);assert.throws(()=>resolve(s),/MANAGEMENT_EXEMPTION_INVALID/);
  }
});
test('scope, authorization and enrollment remain private, exact and immutable',()=>{
  for(const change of [r=>r.account='schwab',r=>r.portfolioId=936249,r=>r.authorizationRef='',
    r=>r.firstHeldOn='2026-10-02',r=>r.giftTradeIds=[1,1]]){
    const r=rule();change(r);assert.throws(()=>validateManagementRegistry({schemaVersion:1,entries:[r]}));
  }
  const result=resolve(), altered=rule();altered.holdingId=901;
  assert.throws(()=>resolve(source(),[altered],result.registry));
});
test('earlier daily values are retained, and earlier management fees receive no retroactive exemption',()=>{
  const input=fixture();input.economicInput.settings.start='2026-09-30';
  input.data.daily.unshift({d:'2026-09-30',schwab:10000,webull:10000});
  const receipt=buildFeeCalculationReceipt(input);
  assert.equal(receipt.periods[0].feeBaseSumCents,2000000);
  assert.equal(receipt.periods[1].feeBaseSumCents,1960000);
  const before=structuredClone(input.data.daily[0]);buildFeeCalculationReceipt(input);
  assert.deepEqual(input.data.daily[0],before);
});
test('missing exemption valuation, negative/oversized values and changed private scope invalidate receipts',()=>{
  const input=fixture(), receipt=buildFeeCalculationReceipt(input);
  for(const change of [x=>delete x.daily[0].managementExemptions,
    x=>x.daily[0].managementExemptions[0].valueUsd=-1,
    x=>x.daily[0].managementExemptions[0].valueUsd=10001,
    x=>x.managementExemptionRegistry.entries[0].holdingId=901]){
    const data=structuredClone(input.data);change(data);assert.equal(validateFeeCalculationReceipt(receipt,data).ok,false);
  }
});
const ui = () => {
  const html=fs.readFileSync(process.env.FEE_LEDGER_TEST_INDEX || path.join(root,'index.html'),'utf8');
  if(process.env.GITHUB_ACTIONS==='true' && process.env.FEE_LEDGER_TEST_INDEX) throw new Error('external UI preview is local-only');
  const sandbox={crypto:crypto.webcrypto,TextEncoder,TextDecoder,structuredClone};sandbox.globalThis=sandbox;
  vm.createContext(sandbox);
  vm.runInContext(html.slice(html.indexOf('/* fee-receipt-consumer:start */'),html.indexOf('/* fee-receipt-consumer:end */')),sandbox);
  return {consume:sandbox.feeReceiptUiModel,supportsExemption:html.includes('normalizeManagementRegistry')};
};
test('phone consumer agrees with the committed scoped basis and rejects an altered exemption or old engine',async()=>{
  const input=fixture(), receipt=buildFeeCalculationReceipt(input), {consume,supportsExemption}=ui();
  assert.equal((await consume({...input,receipt})).ok,supportsExemption, 'old consumer must reject new fee inputs; paired consumer must validate them');
  const altered=structuredClone(input);altered.data.daily[0].managementExemptions[0].valueUsd=401;
  assert.equal((await consume({...altered,receipt})).ok,false);
  const body={...receipt,engineVersion:'fee-v4.6.1'};delete body.receiptId;
  assert.equal((await consume({...input,receipt:{...body,receiptId:semanticHash('calculation-receipt',body)}})).ok,false);
});
test('encrypted writer enrollment is atomic, preserves AUM, and identical source reruns are byte no-op',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-gift-writer-'));fs.chmodSync(dir,0o700);
  const key=crypto.randomBytes(32),file=path.join(dir,'data.json'),managementFile=path.join(dir,'input.json'),econFile=path.join(dir,'econ.json');
  const encrypt=(v,version=3)=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv),ct=Buffer.concat([c.update(JSON.stringify(v)),c.final()]);return JSON.stringify({enc:true,v:version,data:Buffer.concat([iv,ct,c.getAuthTag()]).toString('base64')});};
  const decrypt=()=>{const b=Buffer.from(JSON.parse(fs.readFileSync(file)).data,'base64'),c=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([c.update(b.subarray(12,-16)),c.final()]));};
  const input=fixture();fs.writeFileSync(econFile,encrypt(input.economicInput,4),{mode:0o600});
  fs.writeFileSync(managementFile,JSON.stringify({...source(),proposals:[rule()]}),{mode:0o600});
  const args=[`--date=${d}`,`--file=${file}`,'--schwab=10000','--webull=10000',`--src-schwab=${d}`,`--src-webull=${d}`,'--cash=10000','--stock=10000','--other=0'];
  const run=()=>spawnSync(process.execPath,[path.join(root,'scripts/daily.mjs'),...args],{encoding:'utf8',env:{...process.env,FEE_DATA_KEY:key.toString('base64url'),FEE_ECON_FILE:econFile,FEE_STYLE_INPUT_FILE:'',FEE_MANAGEMENT_INPUT_FILE:managementFile}});
  try {
    const first=run();assert.equal(first.status,0,first.stderr);
    const payload=decrypt();assert.equal(payload.daily[0].webull,10000);assert.equal(payload.daily[0].stock,10000);
    assert.equal(payload.daily[0].managementExemptions[0].valueUsd,400);assert.equal(payload.feeCalculationReceipt.engineVersion,'fee-v4.6.2');
    assert.equal(fs.readFileSync(file,'utf8').includes('synthetic-gift-rule'),false);
    const bytes=fs.readFileSync(file),second=run();assert.equal(second.status,0,second.stderr);assert.match(second.stdout,/no-op/);assert.deepEqual(fs.readFileSync(file),bytes);
    const bad=source();bad.holdings[0].quantity=3;fs.writeFileSync(managementFile,JSON.stringify({...bad,proposals:[]}),{mode:0o600});
    assert.notEqual(run().status,0);assert.deepEqual(fs.readFileSync(file),bytes);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});


test('owner monthly instruction covers only strict recurring promotional awards in the same enrolled holding',()=>{
  const input=source();input.holdings[0].quantity=4;input.holdings[0].valueUsd=800;
  input.trades.push({...input.trades[0],id:2,monthlyGiftEvidence:true});
  assert.equal(resolve(input).rows[0].valueUsd,800);
  input.trades[1].zeroPrice=false;assert.equal(resolve(input).rows[0].valueUsd,400);
  const trade={comments:'Webull HK monthly promotional gifted SYNTH shares, not a cash purchase: 2 share acquired for USD 0, brokerage USD 0, no cash movement. Award date 2026-10-01 per account holder confirmation of first-day-of-month gifts.',description_code:'BUY',state:'confirmed',price:0,value:0,brokerage:0,instrument:{code:'SYNTH'},transaction_date:d,quantity:2};
  assert.equal(monthlyGiftEvidence(trade),true);
  for(const change of [t=>t.price=1,t=>t.value=1,t=>t.brokerage=1,t=>t.instrument.code='OTHER',t=>t.quantity=3,t=>t.state='unconfirmed',t=>t.transaction_date='2026-10-02',t=>t.comments='unverified gift']){
    const t=structuredClone(trade);change(t);assert.equal(monthlyGiftEvidence(t),false);
  }
});


test('full-history next-page evidence is refused rather than declared complete',()=>{
  for(const meta of [{links:{next:'https://example.test/next'}},{pagination:{next_page:2}},{meta:{pagination:{next_page:2}}}])
    assert.throws(()=>managementSourceInput({webull:{managementTrades:{trades:[],...meta}}},d),/MANAGEMENT_HISTORY_INCOMPLETE/);
});
