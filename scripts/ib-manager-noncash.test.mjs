import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseSourceJson} from './fee-cloud-source.mjs';
import {periodReturns} from './fee-engine.mjs';
import {ibBaselineBusinessHash} from './ib-manager-source.mjs';
import {ibNoncashMark,buildIbNativeNoncashProof,validateIbNativeNoncashProof,buildIbNoncashCorrectionCandidate} from './ib-manager-noncash.mjs';

const identity='a'.repeat(64),instrument={id:9,code:'SYNTH',market_code:'NYSE',currency_code:'USD'};
const mark=(d,q,value)=>ibNoncashMark(d,parseSourceJson(JSON.stringify({report:{holdings:[{id:2,quantity:q,value,instrument}]}})).report.holdings[0]);
function fixture(){
  const trade=parseSourceJson(JSON.stringify({trades:[{id:3,portfolio_id:1,holding_id:2,state:'confirmed',description_code:'SELL',value:0,price:0,brokerage:0,quantity:2,transaction_date:'2026-09-03',instrument}]})).trades[0];
  return {portfolioId:1,portfolioIdentityHash:identity,trade,before:mark('2026-09-02',4,44),after:mark('2026-09-03',2,24),cashLegs:[],sameDayTrades:[trade],catalogInstrument:instrument};
}
test('native noncash proof derives USD EOD flow from exact source quantity and dated price',()=>{
  const p=buildIbNativeNoncashProof(fixture());assert.equal(p.externalFlowCents,-2400);assert.equal(p.unitPriceCents,1200);assert.equal(p.recordedDate,p.effectiveDate);
  assert.deepEqual(validateIbNativeNoncashProof(p,{portfolioIdentityHash:identity,from:'2026-09-01',to:'2026-09-03'}),p);
  assert.doesNotMatch(JSON.stringify(p),/SYNTH|comments|clientSecret/);
});
test('complete outflow needs a same-day independent instrument mark, never a zero or prior close',()=>{
  const args=fixture();args.authority='source-native-transfer';args.trade.description_code='TRANSFER_OUT';args.trade.quantity=4;
  // Parse source numbers through the exact-decimal adapter after mutation.
  args.trade=parseSourceJson(JSON.stringify({trades:[args.trade]})).trades[0];args.after=mark('2026-09-03',0,0);
  assert.throws(()=>buildIbNativeNoncashProof(args));
  args.closingMark={...mark('2026-09-03',1,12),holdingId:6};
  const p=buildIbNativeNoncashProof(args);assert.equal(p.externalFlowCents,-4800);
  const result=periodReturns({points:[{d:'2026-09-03',tot:50}],openT:94,from:'2026-09-03',to:'2026-09-03',days:1,flowByDate:{'2026-09-03':p.externalFlowCents/100},rate:0,cr:0,cumBefore:0,hwmBefore:0});
  assert.deepEqual(result.issues,[]);assert.ok(Math.abs(result.rG-4/94)<1e-12);
  assert.deepEqual(validateIbNativeNoncashProof(p,{portfolioIdentityHash:identity,from:'2026-09-01',baselineAsOf:'2026-09-02',to:'2026-09-03'}),p);
  for(const mutate of [x=>x.closingMark.d='2026-09-02',x=>x.closingMark.holdingId=2,x=>x.closingMark.instrumentIdentityHash='b'.repeat(64),x=>x.closingMark.quantityAtoms='0',x=>x.trade.value=1]){
    const bad=structuredClone(args);mutate(bad);assert.throws(()=>buildIbNativeNoncashProof(bad));
  }
  assert.throws(()=>validateIbNativeNoncashProof(p,{portfolioIdentityHash:identity,from:'2026-09-01',baselineAsOf:'2026-09-03',to:'2026-09-03'}));
});
test('unknown cash, mixed trades, wrong identity, unproved quantity and ambiguous prices fail closed',()=>{
  for(const change of [x=>x.trade.price=1,x=>x.trade.value=1,x=>x.trade.brokerage=1,x=>x.trade.state='unconfirmed',x=>x.portfolioId=5,x=>x.trade.holding_id=8,x=>x.trade.id=0,x=>x.trade.transaction_date='2026-09-02',x=>x.after=mark('2026-09-03',0,0),x=>x.after=mark('2026-09-03',2,24.01),x=>x.before=mark('2026-09-02',5,55),x=>x.catalogInstrument={...instrument,id:10},x=>x.cashLegs=[{tradeId:3,movement:1}],x=>x.sameDayTrades.push({...x.trade,id:4})]){
    const args=fixture();change(args);assert.throws(()=>buildIbNativeNoncashProof(args),/IB_NONCASH_EVIDENCE_INVALID/);
  }
});
test('proof integrity, baseline range and account binding reject independently',()=>{
  const p=buildIbNativeNoncashProof(fixture());
  for(const change of [x=>x.externalFlowCents=-2300,x=>x.quantityAtoms='0',x=>x.after.valueCents++,x=>x.authority='ownerConfirmed=true',x=>x.effectiveDate='2026-09-01',x=>x.portfolioIdentityHash='b'.repeat(64),x=>x.extra=1]){
    const bad=structuredClone(p);change(bad);assert.throws(()=>validateIbNativeNoncashProof(bad,{portfolioIdentityHash:identity,from:'2026-09-01',to:'2026-09-03'}));
  }
  assert.throws(()=>validateIbNativeNoncashProof(p,{portfolioIdentityHash:identity,from:'2026-09-01',to:'2026-09-02'}));
});
test('offline business-date correction removes only the evidenced window and records one flow',()=>{
  const p=buildIbNativeNoncashProof(fixture()),rawInput={points:[{d:'2026-09-01',tot:60},{d:'2026-09-02',tot:64},{d:'2026-09-03',tot:44}],openT:60,from:'2026-09-01',to:'2026-09-03',days:3,flowByDate:{},rate:0,cr:0,cumBefore:0,hwmBefore:0},original=structuredClone(rawInput),marks=[mark('2026-09-01',4,40),mark('2026-09-02',4,44)];
  const out=buildIbNoncashCorrectionCandidate({rawInput,nativeProof:p,marks,effectiveDate:'2026-09-01'}),i=out.periodReturnsInput;
  assert.deepEqual(i.points.map(p=>p.tot),[40,42,44]);assert.deepEqual(i.flowByDate,{'2026-09-01':-20});assert.deepEqual(rawInput,original);
  assert.equal(out.correctionCandidate.authority,'unattached-private-audit-candidate');
  const result=periodReturns(i);assert.deepEqual(result.issues,[]);assert.ok(Math.abs(result.rG-.1)<1e-12);
  assert.equal(ibBaselineBusinessHash(i),ibBaselineBusinessHash({...original,points:[{d:'2026-09-01',tot:40},{d:'2026-09-02',tot:42},{d:'2026-09-03',tot:44}],flowByDate:{'2026-09-01':-20}}));
  assert.notEqual(ibBaselineBusinessHash(i),ibBaselineBusinessHash(original));
});
test('correction never substitutes yesterday price, silently fills missing days or double-counts recorded flow',()=>{
  const rawInput={points:[{d:'2026-09-01',tot:60},{d:'2026-09-02',tot:64},{d:'2026-09-03',tot:44}],openT:60,from:'2026-09-01',to:'2026-09-03',days:3,flowByDate:{},rate:0,cr:0,cumBefore:0,hwmBefore:0},p=buildIbNativeNoncashProof(fixture());
  for(const mutate of [x=>x.marks.pop(),x=>x.marks.push(x.marks[0]),x=>x.effectiveDate='2026-09-03',x=>x.rawInput.points.pop(),x=>x.rawInput.points[0].tot=1,x=>x.rawInput.flowByDate['2026-09-03']=-24,x=>x.marks[0].quantityAtoms='0']){
    const args={rawInput:structuredClone(rawInput),nativeProof:p,marks:[mark('2026-09-01',4,40),mark('2026-09-02',4,44)],effectiveDate:'2026-09-01'};mutate(args);assert.throws(()=>buildIbNoncashCorrectionCandidate(args));
  }
});
test('business-date candidate has no normal-runtime carrier or authority shortcut',()=>{
  for(const name of ['daily.mjs','fee-cloud-producer.mjs','ib-manager-source.mjs','ib-manager-report.mjs'])assert.doesNotMatch(fs.readFileSync(new URL('./'+name,import.meta.url),'utf8'),/buildIbNoncashCorrectionCandidate|JSON_SECRET|IB_BOOTSTRAP_INPUT_JSON/);
});

test('explicit priced native TRANSFER_OUT is a dated noncash valuation, with full disposal bound to provider price and value',()=>{const f=fixture();f.authority='source-native-transfer';f.trade={...f.trade,description_code:'TRANSFER_OUT',quantity:4,price:12,value:48};f.trade=parseSourceJson(JSON.stringify({trades:[f.trade]})).trades[0];f.sameDayTrades=[f.trade];f.after=mark('2026-09-03',0,0);const p=buildIbNativeNoncashProof(f);assert.equal(p.externalFlowCents,-4800);assert.equal(p.nativeTransferValuation.descriptionCode,'TRANSFER_OUT');assert.deepEqual(validateIbNativeNoncashProof(p,{portfolioIdentityHash:identity,from:'2026-09-01',to:'2026-09-03',baselineAsOf:'2026-09-02'}),p);for(const change of [x=>x.trade.value=47,x=>x.trade.price=11,x=>x.trade.description_code='SELL',x=>x.trade.brokerage=1,x=>x.cashLegs=[{tradeId:3,movement:4800}],x=>x.trade.transaction_date='2026-09-02']){const bad={...f,trade:{...f.trade},cashLegs:[...f.cashLegs]};change(bad);bad.trade=parseSourceJson(JSON.stringify({trades:[bad.trade]})).trades[0];bad.sameDayTrades=[bad.trade];assert.throws(()=>buildIbNativeNoncashProof(bad));}const tampered=structuredClone(p);tampered.nativeTransferValuation.valueCents--;assert.throws(()=>validateIbNativeNoncashProof(tampered,{portfolioIdentityHash:identity,from:'2026-09-01',to:'2026-09-03',baselineAsOf:'2026-09-02'}));});
test('priced partial transfer still matches the independent surviving position mark and does not alter legacy corrections',()=>{const f=fixture();f.authority='source-native-transfer';f.trade=parseSourceJson(JSON.stringify({trades:[{...f.trade,description_code:'TRANSFER_OUT',price:12,value:24}]})).trades[0];f.sameDayTrades=[f.trade];const p=buildIbNativeNoncashProof(f);assert.equal(p.externalFlowCents,-2400);f.trade.price=11;f.trade.value=22;assert.throws(()=>buildIbNativeNoncashProof(f));const old=fixture();old.trade.price=12;old.trade.value=24;assert.throws(()=>buildIbNativeNoncashProof(old));});
