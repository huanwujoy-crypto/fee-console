import assert from 'node:assert/strict';
import test from 'node:test';
import { dividendCashKey, resolveDividendCashEvidence } from './fee-income-evidence.mjs';
import { classifyFlow, reconcileFlows } from './daily-core.mjs';

const D='2026-10-01',KEY='webull.dividend:12345678:SYNTH:2026-09-30:900';
const fixture=()=>({account:'webull',portfolioId:1350094,targetDate:D,dateEvidence:{},
  payouts:{900:{id:900,portfolio_id:1350094,holding_id:901,symbol:'SYNTH',paid_on:'2026-09-30',currency:'USD',confirmed:true,state:'confirmed',non_taxable:false,tax_credit:0,gross_amount:100,resident_withholding_tax:30,amount:70}},
  cashRows:[{id:1,cash_account_id:902,date_time:D+'T04:00:00Z',amount:70,cash_account_transaction_type:{name:'DEPOSIT'},description:`SYNTH dividend: gross100.00 WHT30.00 net70.00; fee0.40 separately. INTERNAL_DIVIDEND_CASH, not external funding. Deposit notice; ledger date unverified. key=${KEY}:net`},
    {id:2,cash_account_id:902,date_time:D+'T04:00:00Z',amount:-0.4,cash_account_transaction_type:{name:'FEE'},description:`SYNTH dividend collection fee: gross100.00 x0.4%, min0.30, rounded0.40. NOT WHT. Official Webull schedule + exact net69.60 cash match; rule-authorized. key=${KEY}:fee`}]
});
const flows=(input)=>{const tags=resolveDividendCashEvidence(input);return input.cashRows.map(r=>({date:D,acct:'webull',amount:r.amount,type:r.cash_account_transaction_type.name,desc:r.description,...tags.get(r.id)}));};
test('a confirmed payout plus matched net dividend and separate fee identifies income without guessing funding',()=>{
  const input=fixture(),result=flows(input);assert.equal(result.length,2);
  assert.deepEqual(result.map(r=>r.incomeRole),['dividend','collection_fee']);
  for(const row of result){assert.equal(classifyFlow(row).kind,'unresolved');assert.match(classifyFlow(row).reason,/cash-posting date evidence/);}
  assert.equal(reconcileFlows([],[],result).auto.length,0);
});
test('payout paid date and deposited-notice commentary cannot substitute for verified cash date',()=>{
  const input=fixture();input.dateEvidence[KEY]={cashDate:D,verified:true,authority:'deposited-notification',sourceRef:'synthetic mail'};
  for(const row of flows(input))assert.equal(classifyFlow(row).kind,'unresolved');
  input.dateEvidence[KEY]={cashDate:'2026-09-30',verified:true,authority:'broker-cash-ledger',sourceRef:'synthetic ledger'};
  for(const row of flows(input))assert.equal(classifyFlow(row).kind,'unresolved');
});
test('independently verified or explicitly owner-approved cash posting resolves both legs with zero external flows',()=>{
  for(const authority of ['broker-cash-ledger','owner-approved-cash-posting']){
    const input=fixture();input.dateEvidence[KEY]={cashDate:D,verified:true,authority,sourceRef:'synthetic authority'};
    const result=flows(input);for(const row of result)assert.equal(classifyFlow(row).kind,'internal');
    const pending=reconcileFlows([],[],flows(fixture()));const final=reconcileFlows([],pending.unresolved,result);
    assert.equal(final.unresolved.length,0);assert.equal(final.auto.length,0);assert.equal(final.promoted,2);
  }
});
test('incorrect economics, cross-account links, duplicate legs, foreign currency and unconfirmed payout never gain income evidence',()=>{
  for(const change of [x=>delete x.payouts[900],x=>x.payouts[900].confirmed=false,x=>x.payouts[900].portfolio_id=936249,
    x=>x.payouts[900].currency='HKD',x=>x.payouts[900].amount=71,x=>x.payouts[900].resident_withholding_tax=29,
    x=>x.payouts[900].non_taxable=true,x=>x.payouts[900].tax_credit=1,
    x=>x.cashRows[1].amount=-0.5,x=>x.cashRows[1].cash_account_id=903,x=>x.cashRows[0].amount=-70,
    x=>x.cashRows[1].date_time='2026-09-30T04:00:00Z',x=>x.cashRows.push({...x.cashRows[1],id:3})]){
    const input=fixture();change(input);assert.equal(resolveDividendCashEvidence(input).size,0);
  }
});
test('bare deposits, arbitrary dividend strings and standalone fees stay unresolved',()=>{
  assert.equal(dividendCashKey('unverified generic dividend'),null);
  for(const row of [{date:D,acct:'webull',amount:70,type:'DEPOSIT',desc:'INTERNAL_DIVIDEND_CASH'},
    {date:D,acct:'webull',amount:-0.4,type:'FEE',desc:'dividend fee'}])assert.equal(classifyFlow(row).kind,'unresolved');
  const x=fixture();x.cashRows.pop();assert.equal(resolveDividendCashEvidence(x).size,0);
});
test('forged or incomplete classifier income fields cannot bypass the gate',()=>{
  for(const change of [x=>x.sourcePayoutId=0,x=>x.acct='schwab',x=>x.incomeRole='other',x=>x.cashPostingDate='2026-09-30',x=>x.incomeDateVerified=false]){
    const input=fixture();input.dateEvidence[KEY]={cashDate:D,verified:true,authority:'broker-cash-ledger',sourceRef:'synthetic'};
    const row=flows(input)[0];change(row);assert.equal(classifyFlow(row).kind,'unresolved');
  }
});
const estimate=()=>({authority:'owner-estimated-cash-posting',verified:false,cashDate:D,sourceRef:'synthetic owner conditional instruction',scope:{portfolioId:1350094,payoutId:900,cashAccountId:902,cashRecordIds:[1,2]},condition:{statementDate:'2026-09-30',statementRef:'synthetic complete statement',reviewedBy:'synthetic reviewer',reviewed:true,complete:true,dividendAbsent:true,feeAbsent:true,netCashMovementAbsent:true},followup:{status:'awaiting-official-record',actualBrokerDate:null}});
test('conditional owner estimate accepts only the exact matched pair and retains pending broker-date audit',()=>{
 const x=fixture();x.dateEvidence[KEY]=estimate();const result=flows(x);
 for(const row of result){assert.equal(row.incomeDateVerified,false);assert.equal(row.evidence,'internal_income_estimated');assert.equal(classifyFlow(row).kind,'internal');assert.equal(row.incomeDateAudit.proof.followup.actualBrokerDate,null);}
 const pending=reconcileFlows([],[],flows(fixture())),accepted=reconcileFlows([],pending.unresolved,result);
 assert.equal(accepted.unresolved.length,0);assert.equal(accepted.auto.length,0);assert.equal(accepted.promoted,2);
});
test('incomplete absence checks, wrong date, wrong scope and falsely verified estimates cannot waive date gate',()=>{
 for(const change of [p=>p.condition.dividendAbsent=false,p=>p.condition.feeAbsent=false,p=>p.condition.netCashMovementAbsent=false,p=>p.condition.complete=false,p=>p.condition.reviewed=false,p=>p.condition.statementRef='',p=>p.condition.statementDate='2026-09-29',p=>p.scope.payoutId=901,p=>p.scope.cashAccountId=903,p=>p.scope.cashRecordIds=[1,3],p=>p.verified=true,p=>p.followup.actualBrokerDate=D]){
 const x=fixture(),p=estimate();change(p);x.dateEvidence[KEY]=p;for(const row of flows(x))assert.equal(classifyFlow(row).kind,'unresolved');
 }
});
test('estimated date audit stays committed and provisional even with calibrated quotes; phone rejects tampering',async()=>{
 const {buildFeeCalculationReceipt,validateFeeCalculationReceipt}=await import('./fee-receipt-core.mjs');
 const {createIncomeDatePolicy,incomeDateEvidenceFromData}=await import('./fee-income-date-policy.mjs');
 const fs=await import('node:fs'),vm=await import('node:vm'),crypto=await import('node:crypto');
 const data={daily:[{d:D,schwab:10000,webull:10000,incomeDateAudits:[{eventKey:KEY,proof:estimate()}]}],flowsAuto:[],flowsUnresolved:[],status:{asOf:D,provisional:false,calibrated:true,unresolvedCount:0}};
 const economicInput={v:4,settings:{start:D,mgmt:2,carry:20,fx:{USD:1}},accounts:[{id:'schwab',opening:10000},{id:'webull',opening:10000}],months:[],fees:[]};
 const receipt=buildFeeCalculationReceipt({data,economicInput});assert.equal(receipt.engineVersion,'fee-v4.6.2');assert.deepEqual(receipt.status.provisionalCodes,['owner-estimated-cash-date']);assert.equal(validateFeeCalculationReceipt(receipt,data).ok,true);
 assert.deepEqual(incomeDateEvidenceFromData(data,D)[KEY],createIncomeDatePolicy().normalize(data.daily[0].incomeDateAudits[0],D).proof);
 const html=fs.readFileSync(process.env.FEE_LEDGER_TEST_INDEX||new URL('../index.html',import.meta.url),'utf8');
 const scope={crypto:crypto.webcrypto,TextEncoder,TextDecoder,structuredClone};scope.globalThis=scope;vm.createContext(scope);vm.runInContext(html.slice(html.indexOf('/* fee-receipt-consumer:start */'),html.indexOf('/* fee-receipt-consumer:end */')),scope);
 const activePolicy=vm.runInContext('createIncomeDatePolicy.toString()',scope);
 if(!activePolicy.includes('broker-statement-verified'))assert.equal(crypto.createHash('sha256').update(activePolicy).digest('hex'),'624b1082088cccbd697d09e354201755873efb87a728471d25f61991aeda8c67');else assert.equal(activePolicy,createIncomeDatePolicy.toString());
 assert.equal((await scope.feeReceiptUiModel({receipt,data,economicInput})).ok,true);
 for(const mutate of [x=>x.daily[0].incomeDateAudits[0].proof.sourceRef='changed authorization',x=>x.daily[0].incomeDateAudits[0].proof.condition.dividendAbsent=false,x=>delete x.daily[0].incomeDateAudits]){
 const altered=structuredClone(data);mutate(altered);assert.equal(validateFeeCalculationReceipt(receipt,altered).ok,false);assert.equal((await scope.feeReceiptUiModel({receipt,data:altered,economicInput})).ok,false);
 }
});

const resolution=()=>({authority:'broker-statement-verified',verified:true,cashDate:D,statementDate:D,issuedDate:'2026-10-02',sourceRef:'synthetic statement pages 2-4',sourceSha256:'a'.repeat(64),pageNumbers:[2,3,4],grossCents:10000,withholdingCents:3000,collectionFeeCents:40,netCashCents:6960,reviewedBy:'synthetic reviewer',reviewedAt:'2026-10-02T09:00:00.000Z'});
test('statement resolution preserves the estimate and resolves only the exact net dividend and fee pair',()=>{
 const x=fixture(),original=estimate();x.dateEvidence[KEY]={...original,resolution:resolution()};
 const result=flows(x);for(const row of result){assert.equal(row.evidence,'internal_income');assert.equal(row.incomeDateVerified,true);assert.equal(classifyFlow(row).kind,'internal');const prior=structuredClone(row.incomeDateAudit.proof);delete prior.resolution;assert.deepEqual(prior,original);}
 assert.equal(reconcileFlows([],[],result).auto.length,0);
 for(const change of [r=>r.sourceSha256='',r=>r.cashDate='2026-09-30',r=>r.grossCents++,r=>r.netCashCents++,r=>r.pageNumbers=[2,2],r=>r.verified=false,r=>r.unreviewedExtra=true]){
 const altered=fixture(),r=resolution();change(r);altered.dateEvidence[KEY]={...estimate(),resolution:r};for(const row of flows(altered))assert.equal(classifyFlow(row).kind,'unresolved');
 }
});
test('resolved estimate remains receipt-committed while its provisional cash-date warning clears',async()=>{
 const {buildFeeCalculationReceipt,validateFeeCalculationReceipt}=await import('./fee-receipt-core.mjs');
 const data={daily:[{d:D,schwab:10000,webull:10000,incomeDateAudits:[{eventKey:KEY,proof:{...estimate(),resolution:resolution()}}]}],flowsAuto:[],flowsUnresolved:[],status:{asOf:D,provisional:false,calibrated:true,unresolvedCount:0}};
 const economicInput={v:4,settings:{start:D,mgmt:2,carry:20,fx:{USD:1}},accounts:[{id:'schwab',opening:10000},{id:'webull',opening:10000}],months:[],fees:[]};
 const receipt=buildFeeCalculationReceipt({data,economicInput});assert.deepEqual(receipt.status.provisionalCodes,[]);assert.equal(validateFeeCalculationReceipt(receipt,data).ok,true);
 for(const mutate of [d=>delete d.daily[0].incomeDateAudits[0].proof.resolution,d=>d.daily[0].incomeDateAudits[0].proof.resolution.sourceSha256='b'.repeat(64),d=>d.daily[0].incomeDateAudits[0].proof.sourceRef='rewritten owner instruction']){const altered=structuredClone(data);mutate(altered);assert.equal(validateFeeCalculationReceipt(receipt,altered).ok,false);}
 const fs=await import('node:fs'),vm=await import('node:vm'),crypto=await import('node:crypto');const html=fs.readFileSync(process.env.FEE_LEDGER_TEST_INDEX||new URL('../index.html',import.meta.url),'utf8');
 if(html.includes("r.authority!=='broker-statement-verified'")){const scope={crypto:crypto.webcrypto,TextEncoder,TextDecoder,structuredClone};scope.globalThis=scope;vm.createContext(scope);vm.runInContext(html.split('/* fee-receipt-consumer:start */')[1].split('/* fee-receipt-consumer:end */')[0],scope);assert.equal((await scope.feeReceiptUiModel({receipt,data,economicInput})).ok,true);}
});

test('writer audit merge permits one append and exact repeats; blocks deletion and changed original evidence',async()=>{
 const {mergeIncomeDateAudit}=await import('./fee-income-date-policy.mjs');const previous={eventKey:KEY,proof:estimate()},next={eventKey:KEY,proof:{...estimate(),resolution:resolution()}};
 const merged=mergeIncomeDateAudit(previous,next,D);assert.deepEqual(merged,next);assert.deepEqual(mergeIncomeDateAudit(merged,next,D),merged);
 for(const incoming of [previous,{...next,proof:{...next.proof,sourceRef:'rewritten estimate'}},{...next,proof:{...next.proof,resolution:{...resolution(),sourceSha256:'b'.repeat(64)}}}])assert.throws(()=>mergeIncomeDateAudit(merged,incoming,D),/conflict/);
 assert.throws(()=>mergeIncomeDateAudit(previous,{...next,proof:{...next.proof,sourceRef:'rewritten estimate'}},D),/conflict/);
});
