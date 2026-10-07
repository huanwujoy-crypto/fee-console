import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {incomeDatePolicy,createIncomeDatePolicy,incomeDateEvidenceFromData,notificationIncomeAudits,mergeIncomeDateAudit} from './fee-income-date-policy.mjs';
import {CLOUD_ACCOUNTS,normalizeRead,SharesightCloudReader} from './fee-cloud-source.mjs';
import {loadIncomeDateEvidence} from './fee-cloud-producer.mjs';
import {buildFeeCalculationReceipt,validateFeeCalculationReceipt,semanticHash} from './fee-receipt-core.mjs';
import {createFundInvestorCore} from './fund-investor-core.mjs';
import { dividendCashKey, resolveDividendCashEvidence } from './fee-income-evidence.mjs';
import { classifyFlow, reconcileFlows, flowId, nyDate } from './daily-core.mjs';

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
 if(!activePolicy.includes('broker-statement-verified'))assert.equal(crypto.createHash('sha256').update(activePolicy).digest('hex'),'624b1082088cccbd697d09e354201755873efb87a728471d25f61991aeda8c67');
 else if(!activePolicy.includes('owner-notification-cash-posting')) {
   // Backend-first release: allow only the exact current-main consumer. It must
   // continue validating the existing authority, while new audits remain closed.
   const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
   const consumer=html.split('/* fee-receipt-consumer:start */')[1].split('/* fee-receipt-consumer:end */')[0];
   assert.equal(hash(html),'1c11cd9a4988b82b903eb2366ba2cf97805278a263be6b7138e042cbfff424ce');
   assert.equal(hash(consumer),'c9d0733a4968aa29d483a3b8dcb741fa912be23a2619ac69aa3acde928fe759e');
   assert.equal(hash(activePolicy),'2b7854d5e8ee3d20c835cd2b2d4c2810d9f1702df71e58b53eeda2768fd00d3e');
 } else assert.equal(activePolicy,createIncomeDatePolicy.toString());
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

// Keep owner notification-date coverage in this registered sensitive test module.
{
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const INDEX=process.env.FEE_LEDGER_TEST_INDEX||path.join(ROOT,'index.html');
if(process.env.GITHUB_ACTIONS==='true'&&process.env.FEE_LEDGER_TEST_INDEX)throw new Error('external UI preview is local-only');
assert.ok(path.isAbsolute(INDEX),'synthetic UI preview must be absolute');
const D='2026-09-23',shift=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
// All event IDs, amounts, references and source objects below are synthetic.
const auditFixture=(date=D,ticker='SYNTH')=>{
  const scope={portfolioId:CLOUD_ACCOUNTS.webull.portfolioId,holdingId:910,payoutId:920,cashAccountId:930,cashRecordIds:[940],ticker};
  return {eventKey:`sharesight.dividend:${scope.portfolioId}:910:920:930:940`,proof:{
    authority:'owner-notification-cash-posting',verified:false,cashDate:date,sourceRef:'synthetic owner decision',scope,
    booking:{basis:'notification-date',originalPaidOn:shift(date,-1),notificationDate:date,deductionConvention:'combined-withholding-and-collection-fee'},
    amounts:{grossCents:10000,withholdingCents:3000,collectionFeeCents:50,combinedDeductionCents:3050,netCashCents:6950},
    followup:{status:'awaiting-official-record',actualBrokerDate:null}}};
};
const fixture=(date=D,ticker='SYNTH')=>{
  const audit=auditFixture(date,ticker),s=audit.proof.scope;
  return {account:'webull',portfolioId:s.portfolioId,targetDate:date,holdings:[{holdingId:s.holdingId,ticker}],
    dateEvidence:{[audit.eventKey]:audit.proof},payouts:{[s.payoutId]:{id:s.payoutId,portfolio_id:s.portfolioId,holding_id:s.holdingId,
      symbol:ticker,paid_on:date,currency:'USD',confirmed:true,state:'confirmed',non_taxable:false,tax_credit:0,
      gross_amount:100,resident_withholding_tax:30.50,amount:69.50}},
    cashRows:[{id:s.cashRecordIds[0],cash_account_id:s.cashAccountId,date_time:date+'T00:00:00Z',amount:69.50,balance:469.50,
      cash_account_transaction_type:{name:'DEPOSIT'},trade_id:null,holding_id:null,payout_id:null,description:'synthetic net income; no legacy key'}]};
};
const flow=input=>{
  const row=input.cashRows[0];return {date:input.targetDate,acct:'webull',amount:row.amount,type:row.cash_account_transaction_type.name,
    desc:row.description,tradeId:row.trade_id,holdingId:row.holding_id,...resolveDividendCashEvidence(input).get(row.id)};
};
function rawFixture(date=D) {
  const input=fixture(date,'SGOV'),make=(account,cashId,holdingId,value,cash,transactions)=>{
    const expected=CLOUD_ACCOUNTS[account],p={id:expected.portfolioId,name:expected.name};
    return {performance:{report:{portfolio_id:p.id,end_date:date,currency:{code:'USD'},value,
      cash_accounts:[{id:cashId,value:cash,currency:{code:'USD'},portfolio:p}],
      holdings:[{id:holdingId,value:600,valid_position:true,instrument:{code:'SGOV'},instrument_currency:{code:'USD'},portfolio:p}]}},
      holdings:{holdings:[{id:holdingId,valid_position:true,portfolio:p}]},
      cashAccounts:{cash_accounts:[{id:cashId,portfolio_id:p.id,currency:'USD',portfolio_currency:'USD',balance:cash}]},
      cashTransactions:{[cashId]:{cash_account_transactions:transactions}},trades:{trades:[]},managementTrades:{trades:[]}};
  };
  return {schwab:make('schwab',950,960,1000,400,[]),webull:{...make('webull',930,910,1069.50,469.50,input.cashRows),
    incomePayouts:input.payouts,incomeDateEvidence:input.dateEvidence}};
}
const benchmark={spy:100,qqq:100,spyd:0,qqqd:0};
function mockFetch(raw,calls=[]) {
  return async(url,init)=>{
    calls.push({url,method:init.method});const u=new URL(url);let payload;
    if(u.pathname==='/oauth2/token')payload={access_token:'SYNTHETIC_TOKEN_'.repeat(3),token_type:'bearer'};
    else if(u.pathname==='/api/v2/portfolios.json')payload={portfolios:Object.values(CLOUD_ACCOUNTS).map(p=>({id:p.portfolioId,name:p.name,currency_code:'USD'}))};
    else if(u.pathname==='/api/v2/payouts/920.json')payload=raw.webull.incomePayouts[920];
    else {
      const account=Object.keys(raw).find(k=>u.pathname.includes(`/portfolios/${CLOUD_ACCOUNTS[k].portfolioId}/`)
        ||u.pathname.includes(`/cash_accounts/${k==='webull'?930:950}/`));
      assert.ok(account,'unexpected synthetic route');const r=raw[account];
      if(u.pathname.endsWith('/performance'))payload=r.performance;
      else if(u.pathname.endsWith('/holdings'))payload=r.holdings;
      else if(u.pathname.endsWith('/cash_accounts.json'))payload=r.cashAccounts;
      else if(u.pathname.endsWith('/cash_account_transactions.json'))payload=Object.values(r.cashTransactions)[0];
      else if(u.pathname.endsWith('/trades.json'))payload=u.searchParams.has('start_date')?r.trades:r.managementTrades;
      else assert.fail('unexpected synthetic route');
    }
    return {status:200,url,headers:{get:()=> 'application/json'},text:async()=>JSON.stringify(payload)};
  };
}

test('single net income uses the owner convention with zero external funding and stable source identity',()=>{
  const input=fixture(),row=flow(input);assert.equal(row.evidence,'internal_income_owner_notification');
  assert.equal(row.incomeDateVerified,false);assert.equal(classifyFlow(row).kind,'internal');
  const again={...row,desc:'rewritten synthetic explanation',id:'untrusted-caller-id'};
  assert.equal(flowId(row),flowId(again));
  const accepted=reconcileFlows([],[],[row,again]);assert.equal(accepted.auto.length,0);assert.equal(accepted.unresolved.length,0);
  const pending=[{id:flowId(row),date:row.date,acct:row.acct,amount:row.amount,desc:row.desc,effective:false}];
  assert.equal(reconcileFlows([],pending,[again]).unresolved.length,0);
  const sourced={...pending[0],sourcePortfolioId:row.sourcePortfolioId,sourceHoldingId:row.sourceHoldingId,
    sourcePayoutId:row.sourcePayoutId,sourceCashAccountId:row.sourceCashAccountId,sourceCashRecordId:row.sourceCashRecordId};
  assert.equal(reconcileFlows([],[sourced],[again]).unresolved.length,0);
  for(const changed of [{...sourced,date:shift(D,-1)},{...sourced,acct:'schwab'},{...sourced,amount:70},
    {...sourced,sourceCashRecordId:941},{...sourced,sourcePayoutId:921}]) {
    const result=reconcileFlows([],[changed],[again]);assert.equal(result.errors.length,1);assert.equal(result.unresolved.length,1);
  }
  assert.equal(reconcileFlows([],[sourced,sourced],[row]).errors.length,1);
  assert.equal(reconcileFlows([{...pending[0],effective:true}],[],[row]).errors.length,1);
  const unknown=[{...pending[0],id:'legacy-ambiguous'}];assert.equal(reconcileFlows([],unknown,[row]).unresolved.length,1);
  assert.equal(reconcileFlows([],[{...sourced,id:'different-legacy-hash'}],[row]).unresolved.length,1);
});

test('notification audit rejects false broker verification, old conditions and inconsistent or unsafe projections',async t=>{
  const changes=[a=>a.proof.verified=true,a=>a.proof.followup.actualBrokerDate=D,a=>a.proof.resolution={},
    a=>a.proof.condition={dividendAbsent:true},a=>a.proof.sourceRef='',a=>a.proof.scope.cashRecordIds.push(941),
    a=>a.proof.scope.holdingId=0,a=>a.proof.scope.payoutId=Number.MAX_SAFE_INTEGER+1,a=>a.proof.booking.notificationDate=shift(D,-1),
    a=>a.proof.booking.originalPaidOn='2026-13-01',a=>a.proof.booking.originalPaidOn=shift(D,1),
    a=>a.proof.amounts.combinedDeductionCents++,a=>a.proof.amounts.collectionFeeCents=-1,a=>a.proof.amounts.netCashCents+=0.1,
    a=>a.eventKey+=':changed',a=>a.proof.scope.portfolioId=1,a=>a.proof.booking.deductionConvention='pure-tax'];
  for(let i=0;i<changes.length;i++)await t.test(`invalid projection ${i+1}`,()=>{
    const a=auditFixture();changes[i](a);assert.throws(()=>incomeDatePolicy.normalize(a,D));
  });
  const a=auditFixture(),later=auditFixture(shift(D,1));
  assert.throws(()=>incomeDatePolicy.timeline([{d:D,incomeDateAudits:[a]},{d:shift(D,1),incomeDateAudits:[later]}]));
  assert.throws(()=>mergeIncomeDateAudit(a,{...a,proof:{...a.proof,sourceRef:'changed decision'}},D),/conflict/);
  assert.deepEqual(mergeIncomeDateAudit(a,a,D),incomeDatePolicy.normalize(a,D));
});

test('source matching rejects duplicate, missing, cross-account, linked-fee and cent-level mismatches',async t=>{
  const changes=[x=>x.cashRows=[],x=>x.cashRows.push({...x.cashRows[0]}),x=>x.payouts.alias=x.payouts[920],
    x=>x.cashRows.push({...x.cashRows[0],id:941,payout_id:920,amount:-0.50,cash_account_transaction_type:{name:'FEE'}}),
    x=>x.cashRows[0].amount=69.51,x=>x.cashRows[0].amount=69.501,x=>x.cashRows[0].amount='69.50',
    x=>x.cashRows[0].cash_account_id=931,x=>x.cashRows[0].date_time=shift(D,-1)+'T00:00:00Z',
    x=>x.cashRows[0].payout_id=921,x=>x.cashRows[0].trade_id=1,x=>x.cashRows[0].holding_id=911,
    x=>x.cashRows[0].cash_account_transaction_type.name='FEE',x=>x.holdings[0].ticker='OTHER',x=>x.holdings.push({...x.holdings[0]}),
    x=>x.payouts[920].confirmed=false,x=>x.payouts[920].state='pending',x=>x.payouts[920].non_taxable=true,
    x=>x.payouts[920].tax_credit=1,x=>x.payouts[920].currency='HKD',x=>x.payouts[920].holding_id=911,
    x=>x.payouts[920].portfolio_id=1,x=>x.payouts[920].paid_on=shift(D,-1),x=>x.payouts[920].resident_withholding_tax=30,
    x=>x.payouts[920].gross_amount=100.001,x=>delete x.payouts[920]];
  for(let i=0;i<changes.length;i++)await t.test(`invalid native evidence ${i+1}`,()=>{
    const x=fixture();changes[i](x);assert.throws(()=>resolveDividendCashEvidence(x),/notification income source/);
  });
  const missing=fixture();missing.dateEvidence={};assert.equal(classifyFlow(flow(missing)).kind,'unresolved');
  const extra=fixture();extra.cashRows.push({...extra.cashRows[0],id:941,amount:-0.50,
    description:'unmatched synthetic fee',cash_account_transaction_type:{name:'FEE'}});
  const tags=resolveDividendCashEvidence(extra);assert.equal(tags.size,1);
  assert.equal(classifyFlow({date:D,acct:'webull',amount:-0.50,type:'FEE',desc:extra.cashRows[1].description}).kind,'unresolved');
});

test('one new income cannot reuse a legacy two-leg payout or either cash identity',()=>{
  const a=auditFixture(),legacy={eventKey:`webull.dividend:700:SYNTH:${shift(D,-1)}:920`,proof:{
    authority:'owner-estimated-cash-posting',verified:false,cashDate:D,sourceRef:'synthetic legacy decision',
    scope:{portfolioId:CLOUD_ACCOUNTS.webull.portfolioId,payoutId:920,cashAccountId:930,cashRecordIds:[940,941]},
    condition:{statementDate:shift(D,-1),statementRef:'synthetic statement',reviewedBy:'synthetic reviewer',reviewed:true,complete:true,
      dividendAbsent:true,feeAbsent:true,netCashMovementAbsent:true},followup:{status:'awaiting-official-record',actualBrokerDate:null}}};
  incomeDatePolicy.normalize(legacy,D);
  for(const audits of [[legacy,a],[a,legacy]])assert.throws(()=>incomeDatePolicy.timeline([{d:D,incomeDateAudits:audits}]));
  const cashOnly=structuredClone(legacy);cashOnly.proof.scope.payoutId=921;cashOnly.eventKey=cashOnly.eventKey.replace(/:920$/,':921');
  assert.throws(()=>incomeDatePolicy.timeline([{d:D,incomeDateAudits:[cashOnly,a]}]));
  const later=structuredClone(a);later.proof.scope.payoutId=921;later.eventKey=later.eventKey.replace(':920:',':921:');
  assert.throws(()=>incomeDatePolicy.point({d:D,incomeDateAudits:[a,later]}));
});

test('target-day cash rows cannot hide a later current balance; the existing freshness guard remains',()=>{
  const raw=rawFixture();raw.webull.cashAccounts.cash_accounts[0].balance+=69.50;
  assert.throws(()=>normalizeRead(raw,D,benchmark),{message:'FEE_CLOUD_CASH_BALANCE_STALE'});
  delete raw.webull.incomeDateEvidence;delete raw.webull.incomePayouts;
  assert.throws(()=>normalizeRead(raw,D,benchmark),{message:'FEE_CLOUD_CASH_BALANCE_STALE'});
});

test('selected net cash account must uniquely belong to the portfolio and its target report',()=>{
  const selected=()=>{
    const raw=rawFixture(),old=Object.keys(raw.webull.incomeDateEvidence)[0],proof=raw.webull.incomeDateEvidence[old];
    delete raw.webull.incomeDateEvidence[old];proof.scope.cashAccountId=931;
    raw.webull.incomeDateEvidence[old.replace(':930:',':931:')]=proof;
    raw.webull.cashTransactions[931]=raw.webull.cashTransactions[930];delete raw.webull.cashTransactions[930];
    raw.webull.cashTransactions[931].cash_account_transactions[0].cash_account_id=931;
    raw.webull.cashAccounts.cash_accounts.push({...raw.webull.cashAccounts.cash_accounts[0],id:931});
    return raw;
  };
  const missing=selected();assert.throws(()=>normalizeRead(missing,D,benchmark),{message:'FEE_CLOUD_INCOME_EVIDENCE'});
  const foreign=selected();foreign.webull.cashAccounts.cash_accounts[1].portfolio_id=999;
  assert.throws(()=>normalizeRead(foreign,D,benchmark),{message:'FEE_CLOUD_INCOME_EVIDENCE'});
  const duplicate=rawFixture();duplicate.webull.cashAccounts.cash_accounts.push({...duplicate.webull.cashAccounts.cash_accounts[0]});
  assert.throws(()=>normalizeRead(duplicate,D,benchmark),{message:'FEE_CLOUD_INCOME_EVIDENCE'});
  const reportDuplicate=rawFixture();reportDuplicate.webull.performance.report.cash_accounts.push({...reportDuplicate.webull.performance.report.cash_accounts[0]});
  assert.throws(()=>normalizeRead(reportDuplicate,D,benchmark),{message:'FEE_CLOUD_INCOME_EVIDENCE'});
});

test('classifier cannot accept a mismatched cash identity, amount or verification flag',async t=>{
  for(const [key,value]of Object.entries({sourcePortfolioId:1,sourceHoldingId:911,sourcePayoutId:921,sourceCashRecordId:941,
    sourceCashAccountId:931,incomeDateVerified:true,amount:69.501,tradeId:1,incomeRole:'collection_fee',acct:'schwab'}))
    await t.test(key,()=>{assert.equal(classifyFlow({...flow(fixture()),[key]:value}).kind,'unresolved');});
});

test('notification authority cannot be relabelled as estimated, verified, trade or external evidence',()=>{
  for(const evidence of ['internal_income_estimated','internal_income','internal_trade','external_transfer','external_asset_transfer',null]) {
    const forged={...flow(fixture()),evidence,incomeRole:'dividend',amount:999,incomeDateVerified:evidence==='internal_income'};
    delete forged.sourcePortfolioId;delete forged.sourceHoldingId;
    assert.equal(classifyFlow(forged).kind,'unresolved');assert.equal(reconcileFlows([],[],[forged]).auto.length,0);
  }
});

test('combined deduction accepts the reviewed split without imposing a withholding or collection fee rate',()=>{
  const x=fixture(),a=x.dateEvidence[Object.keys(x.dateEvidence)[0]].amounts;
  Object.assign(a,{withholdingCents:1200,collectionFeeCents:1750,combinedDeductionCents:2950,netCashCents:7050});
  Object.assign(x.payouts[920],{resident_withholding_tax:29.50,amount:70.50});x.cashRows[0].amount=70.50;
  const accepted=flow(x);assert.equal(classifyFlow(accepted).kind,'internal');
  assert.equal(accepted.incomeDateAudit.proof.amounts.collectionFeeCents,1750);
  assert.equal(accepted.incomeDateAudit.proof.amounts.withholdingCents,1200);
});

test('GET-only reader discovers the exact scoped payout without a legacy cash key and commits the audit',async()=>{
  const raw=rawFixture(),calls=[],reader=new SharesightCloudReader({clientId:'synthetic',clientSecret:'synthetic',
    incomeDateEvidence:raw.webull.incomeDateEvidence,fetchImpl:mockFetch(raw,calls)});
  const input=await reader.readStable(D,benchmark),row=input.flows.find(f=>f.acct==='webull');
  assert.equal(row.evidence,'internal_income_owner_notification');assert.equal(row.incomeDateVerified,false);
  assert.equal(calls.filter(c=>c.url.endsWith('/payouts/920.json')).length,2);
  assert.ok(calls.every(c=>c.method===(c.url.endsWith('/oauth2/token')?'POST':'GET')));
  const altered=structuredClone(raw);altered.webull.incomeDateEvidence[Object.keys(altered.webull.incomeDateEvidence)[0]].sourceRef='another synthetic decision';
  assert.notEqual(normalizeRead(altered,D,benchmark).sourceFingerprint,input.sourceFingerprint);
  const bad=structuredClone(raw);bad.webull.cashTransactions[930].cash_account_transactions[0].amount=69.51;
  assert.throws(()=>normalizeRead(bad,D,benchmark),{message:'FEE_CLOUD_INCOME_EVIDENCE'});
  let reads=0;const unstable=mockFetch(raw);
  const changing=new SharesightCloudReader({clientId:'synthetic',clientSecret:'synthetic',incomeDateEvidence:raw.webull.incomeDateEvidence,
    fetchImpl:async(url,init)=>{if(url.endsWith('/oauth2/token'))reads++;
      if(reads===2)raw.webull.cashTransactions[930].cash_account_transactions[0].description='changed synthetic source';return unstable(url,init);}});
  await assert.rejects(changing.readStable(D,benchmark),{message:'FEE_CLOUD_SOURCE_UNSTABLE'});
});

test('private bootstrap validates scope, ownership, immutability and conflicts without granting consent',()=>{
  const priorActions=process.env.GITHUB_ACTIONS;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'income-evidence-test-'));fs.chmodSync(dir,0o700);
  const file=path.join(dir,'evidence.json'),a=auditFixture(),payload={daily:[]};
  const write=(audits=[a],date=D)=>fs.writeFileSync(file,JSON.stringify({schema:'fee-console.income-date-evidence.v1',targetDate:date,audits}),{mode:0o600});
  try {
    // Exercise the local transport with synthetic bytes, regardless of the test runner.
    delete process.env.GITHUB_ACTIONS;
    write();const loaded=loadIncomeDateEvidence(payload,D,file);loaded.checkCurrent();assert.deepEqual(loaded.evidence,{[a.eventKey]:a.proof});
    fs.chmodSync(file,0o644);assert.throws(()=>loadIncomeDateEvidence(payload,D,file),{message:'FEE_CLOUD_INCOME_INPUT'});fs.chmodSync(file,0o600);
    const link=path.join(dir,'link.json');fs.symlinkSync(file,link);assert.throws(()=>loadIncomeDateEvidence(payload,D,link),{message:'FEE_CLOUD_INCOME_INPUT'});
    assert.throws(()=>loadIncomeDateEvidence(payload,D,'relative.json'),{message:'FEE_CLOUD_INCOME_INPUT'});
    write([a],shift(D,-1));assert.throws(()=>loadIncomeDateEvidence(payload,D,file),{message:'FEE_CLOUD_INCOME_INPUT'});
    write([a,a]);assert.throws(()=>loadIncomeDateEvidence(payload,D,file),{message:'FEE_CLOUD_INCOME_INPUT'});
    write();const changed=structuredClone(a);changed.proof.sourceRef='changed synthetic decision';write([changed]);
    assert.throws(()=>loaded.checkCurrent(),{message:'FEE_CLOUD_INCOME_INPUT_CHANGED'});
    assert.throws(()=>loadIncomeDateEvidence({daily:[{d:D,incomeDateAudits:[a]}]},D,file),{message:'FEE_CLOUD_INCOME_INPUT_CONFLICT'});
    write();assert.deepEqual(loadIncomeDateEvidence({daily:[{d:D,incomeDateAudits:[a]}]},D,file).evidence,loaded.evidence);
    const later=auditFixture(shift(D,1));write([later],shift(D,1));
    assert.throws(()=>loadIncomeDateEvidence({daily:[{d:D,incomeDateAudits:[a]}]},shift(D,1),file),{message:'FEE_CLOUD_INCOME_INPUT_CONFLICT'});
    write();const prior=process.env.GITHUB_ACTIONS;process.env.GITHUB_ACTIONS='true';
    try {
      assert.throws(()=>loadIncomeDateEvidence(payload,D,file),{message:'FEE_CLOUD_INCOME_INPUT'});
      assert.throws(()=>loaded.checkCurrent(),{message:'FEE_CLOUD_INCOME_INPUT'});
      assert.deepEqual(loadIncomeDateEvidence({daily:[{d:D,incomeDateAudits:[a]}]},D).evidence,loaded.evidence);
    }
    finally {if(prior===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=prior;}
    assert.throws(()=>notificationIncomeAudits({[a.eventKey]:{...a.proof,verified:true}},D));
  } finally {
    if(priorActions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=priorActions;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

const receiptFixture=()=>{
  const prior=shift(D,-1),a=auditFixture(),data={daily:[{d:prior,schwab:1000,webull:1000},{d:D,schwab:1000,webull:1069.50,incomeDateAudits:[a]}],
    flowsAuto:[],flowsUnresolved:[],status:{asOf:D,provisional:false,calibrated:true,unresolvedCount:0}};
  const economicInput={v:4,settings:{start:prior,mgmt:2,carry:20,fx:{USD:1}},accounts:[{id:'schwab',opening:1000},{id:'webull',opening:1000}],months:[],fees:[]};
  return {data,economicInput,receipt:buildFeeCalculationReceipt({data,economicInput})};
};
test('notification provenance before fee start still selects the new validation protocol without changing the fee window',async()=>{
  const date=shift(D,1),input=receiptFixture();input.data.daily=input.data.daily.slice(1);
  input.data.daily.push({d:date,schwab:1000,webull:1069.50});input.data.status.asOf=date;
  input.economicInput.settings.start=date;input.economicInput.accounts[1].opening=1069.50;
  input.receipt=buildFeeCalculationReceipt(input);
  assert.equal(input.receipt.engineVersion,'fee-v4.6.3');assert.equal(input.receipt.start,date);
  assert.equal(input.receipt.totals.grossPnlCents,0);assert.deepEqual(input.receipt.status.provisionalCodes,[]);
  assert.equal(validateFeeCalculationReceipt(input.receipt,input.data).ok,true);
  const html=fs.readFileSync(INDEX,'utf8'),scope={crypto:crypto.webcrypto,TextEncoder,TextDecoder,structuredClone};scope.globalThis=scope;vm.createContext(scope);
  vm.runInContext(html.split('/* fee-receipt-consumer:start */')[1].split('/* fee-receipt-consumer:end */')[0],scope);
  const current=vm.runInContext('createIncomeDatePolicy.toString()',scope).includes('owner-notification-cash-posting');
  assert.equal((await scope.feeReceiptUiModel(input)).ok,current);
});
test('receipt and actual mobile consumer agree; net NAV appears once with no principal or share issuance',async()=>{
  const input=receiptFixture(),html=fs.readFileSync(INDEX,'utf8');
  const scope={crypto:crypto.webcrypto,TextEncoder,TextDecoder,structuredClone};scope.globalThis=scope;vm.createContext(scope);
  const consumer=html.split('/* fee-receipt-consumer:start */')[1].split('/* fee-receipt-consumer:end */')[0];
  vm.runInContext(consumer,scope);
  const activePolicy=vm.runInContext('createIncomeDatePolicy.toString()',scope),current=activePolicy.includes('owner-notification-cash-posting');
  if(current)assert.equal(activePolicy,createIncomeDatePolicy.toString());
  else {
    const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
    assert.equal(hash(html),'1c11cd9a4988b82b903eb2366ba2cf97805278a263be6b7138e042cbfff424ce');
    assert.equal(hash(consumer),'c9d0733a4968aa29d483a3b8dcb741fa912be23a2619ac69aa3acde928fe759e');
    assert.equal(hash(activePolicy),'2b7854d5e8ee3d20c835cd2b2d4c2810d9f1702df71e58b53eeda2768fd00d3e');
  }
  const {receipt,data}=input;assert.equal(receipt.engineVersion,'fee-v4.6.3');assert.equal(receipt.effectiveFlowCount,0);
  assert.equal(receipt.effectiveFlowNetCents,0);assert.equal(receipt.totals.grossPnlCents,6950);
  assert.equal(receipt.balance.paidCents,0);assert.deepEqual(receipt.status.provisionalCodes,['owner-notification-cash-date']);
  assert.equal(validateFeeCalculationReceipt(receipt,data).ok,true);const ui=await scope.feeReceiptUiModel(input);
  assert.deepEqual(incomeDateEvidenceFromData(data,D),{[data.daily[1].incomeDateAudits[0].eventKey]:data.daily[1].incomeDateAudits[0].proof});
  if(!current) {
    assert.deepEqual(JSON.parse(JSON.stringify(ui)),{ok:false,reason:'calculation receipt pending'});
    for(const version of ['fee-v4.6.2','fee-v4.6.1']) {
      const body={...receipt,engineVersion:version};delete body.receiptId;
      const downgraded={...body,receiptId:semanticHash('calculation-receipt',body)};
      assert.equal(validateFeeCalculationReceipt(downgraded,data).ok,false);
      assert.equal((await scope.feeReceiptUiModel({...input,receipt:downgraded})).ok,false);
    }
    return; // No private bootstrap until the separately reviewed UI is deployed.
  }
  assert.equal(ui.ok,true);
  const profile={schema:'fee-console.fund-profile.v1',manager:'SYNTHETIC',fundName:'SYNTHETIC',inceptionDate:shift(D,-1),inceptionNoticeDate:D,
    currency:'USD',initialShares:1000,investors:[{id:'A',name:'ALPHA',shares:600},{id:'B',name:'BETA',shares:400}]};
  const fund=createFundInvestorCore().calculate({profile,data,feeView:{...JSON.parse(JSON.stringify(ui)),state:'verified'}});
  assert.equal(fund.status,'ready');assert.deepEqual(fund.current.investors.map(i=>i.shares),[600,400]);
  assert.equal(fund.current.grossPnlCents,6950);assert.equal(fund.current.subscription,null);
  for(const change of [d=>d.daily[1].incomeDateAudits[0].proof.sourceRef='changed decision',d=>d.daily[1].incomeDateAudits[0].proof.verified=true,
    d=>d.daily[1].incomeDateAudits[0].proof.amounts.collectionFeeCents++,d=>delete d.daily[1].incomeDateAudits]) {
    const changed=structuredClone(data);change(changed);assert.equal(validateFeeCalculationReceipt(receipt,changed).ok,false);
    assert.equal((await scope.feeReceiptUiModel({...input,data:changed})).ok,false);
  }
  for(const version of ['fee-v4.6.2','fee-v4.6.1']) {
    const body={...receipt,engineVersion:version};delete body.receiptId;
    const downgraded={...body,receiptId:semanticHash('calculation-receipt',body)};
    assert.equal(validateFeeCalculationReceipt(downgraded,data).ok,false);
    assert.equal((await scope.feeReceiptUiModel({...input,receipt:downgraded})).ok,false);
  }
  assert.match(html,/按用户选择的到账通知日记账；券商实际入账日待核/);
  assert.match(html,/扣减栏含预扣税及代收费/);
  assert.deepEqual(incomeDateEvidenceFromData(data,D),{[data.daily[1].incomeDateAudits[0].eventKey]:data.daily[1].incomeDateAudits[0].proof});
});

test('actual producer, writer and reporter bootstrap then reload the encrypted audit with byte-identical no-op',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'income-producer-test-'));fs.chmodSync(dir,0o700);
  const repo=path.join(dir,'repo'),date=shift(nyDate(new Date()),-1),prior=shift(date,-1),key=crypto.randomBytes(32);
  const payload={updatedAt:prior,daily:[{d:prior,schwab:1000,webull:1000,cash:800,stock:0,other:1200,spy:100,qqq:100,bd:prior,bstate:'session'}],
    flowsAuto:[],flowsUnresolved:[],status:{asOf:prior,provisional:false,calibrated:true,splitDelta:0,unresolvedCount:0,notes:[]}};
  const seal=(data,v=3)=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);return JSON.stringify({enc:true,v,data:Buffer.concat([iv,c.update(JSON.stringify(data)),c.final(),c.getAuthTag()]).toString('base64')});};
  try {
    fs.mkdirSync(repo,{mode:0o700});fs.cpSync(path.join(ROOT,'scripts'),path.join(repo,'scripts'),{recursive:true});
    fs.mkdirSync(path.join(repo,'claude'));fs.copyFileSync(path.join(ROOT,'claude/fee-style-mapping.json'),path.join(repo,'claude/fee-style-mapping.json'));
    fs.writeFileSync(path.join(repo,'data.json'),seal(payload),{mode:0o600});
    const evidence=path.join(dir,'evidence.json'),cache=path.join(dir,'benchmark.json'),econ=path.join(dir,'economic.json');
    fs.writeFileSync(evidence,JSON.stringify({schema:'fee-console.income-date-evidence.v1',targetDate:date,audits:[auditFixture(date,'SGOV')]}),{mode:0o600});
    fs.writeFileSync(cache,JSON.stringify({v:1,benchmarks:{spy:{series:[{d:date,p:100}]},qqq:{series:[{d:date,p:100}]}}}),{mode:0o600});
    fs.writeFileSync(econ,seal({v:4,settings:{start:prior,mgmt:2,carry:20,fx:{USD:1}},accounts:[{id:'schwab',opening:1000},{id:'webull',opening:1000}],months:[],fees:[]},4),{mode:0o600});
    const out1=path.join(dir,'first'),out2=path.join(dir,'second');fs.mkdirSync(out1,{mode:0o700});fs.mkdirSync(out2,{mode:0o700});
    const runner=path.join(dir,'runner.mjs');
    fs.writeFileSync(runner,`import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';\n`+
      `const root=${JSON.stringify(repo)},raw=${JSON.stringify(rawFixture(date))},date=${JSON.stringify(date)};globalThis.fetch=()=>{throw new Error('NETWORK_FORBIDDEN_IN_SYNTHETIC_TEST');};\n`+
      `const CLOUD_ACCOUNTS=${JSON.stringify(CLOUD_ACCOUNTS)},mockFetch=${mockFetch.toString()};const assert={ok(v){if(!v)throw Error('route');},fail(){throw Error('route');}};\n`+
      `const {produce}=await import(pathToFileURL(path.join(root,'scripts/fee-cloud-producer.mjs')));const options={fetchImpl:mockFetch(raw),fetchEconomic:async()=>({envelopeVersion:4,sourcePath:${JSON.stringify(econ)},checkCurrent(){},cleanup(){}})};\n`+
      `const first=await produce({...options,cli:{'benchmark-file':${JSON.stringify(cache)},'out-dir':${JSON.stringify(out1)},'income-date-evidence-file':${JSON.stringify(evidence)}}});\n`+
      `const bytes=fs.readFileSync(first.dataFile);fs.copyFileSync(first.dataFile,path.join(root,'data.json'));\n`+
      `const {normalizeRead}=await import(pathToFileURL(path.join(root,'scripts/fee-cloud-source.mjs')));const input=normalizeRead(raw,date,{spy:100,qqq:100,spyd:0,qqqd:0});\n`+
      `const style=path.join(${JSON.stringify(dir)},'negative-style.json'),management=path.join(${JSON.stringify(dir)},'negative-management.json');fs.writeFileSync(style,JSON.stringify(input.styleInput),{mode:0o600});fs.writeFileSync(management,JSON.stringify(input.managementInput),{mode:0o600});\n`+
      `let rejected=0;for(const change of [f=>f.sourceHoldingId=911,f=>delete f.incomeDateVerified,f=>f.incomeDateVerified='false',f=>{f.evidence='internal_income_estimated';f.incomeRole='dividend';},f=>{f.evidence='internal_income';f.incomeRole='dividend';f.incomeDateVerified=true;},f=>f.evidence='internal_trade']){const flows=structuredClone(input.flows);change(flows.find(f=>f.acct==='webull'));\n`+
      `const cli=['--date='+date,'--file='+path.join(root,'data.json'),'--schwab=1000','--webull=1069.50','--src-schwab='+date,'--src-webull='+date,'--cash=869.50','--stock=0','--other=1200','--spy=100','--qqq=100','--src-bench='+date,'--bench-state=session','--acct-cash-webull=469.50','--prev-acct-cash-webull=400','--flows='+JSON.stringify(flows)];\n`+
      `const bad=spawnSync(process.execPath,[path.join(root,'scripts/daily.mjs'),...cli],{encoding:'utf8',env:{...process.env,FEE_ECON_FILE:${JSON.stringify(econ)},FEE_STYLE_INPUT_FILE:style,FEE_MANAGEMENT_INPUT_FILE:management}});if(bad.status===0||!bad.stderr.includes('notification income evidence is inconsistent')||!bytes.equals(fs.readFileSync(path.join(root,'data.json'))))throw Error('writer did not reject without writing');rejected++;}\n`+
      `const second=await produce({...options,cli:{'benchmark-file':${JSON.stringify(cache)},'out-dir':${JSON.stringify(out2)}}});\n`+
      `const b=Buffer.from(JSON.parse(bytes).data,'base64'),d=crypto.createDecipheriv('aes-256-gcm',Buffer.from(process.env.FEE_DATA_KEY,'base64url'),b.subarray(0,12));d.setAuthTag(b.subarray(-16));const p=JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]));\n`+
      `console.log(JSON.stringify({first:first.outcome,second:second.outcome,rejected,same:bytes.equals(fs.readFileSync(second.dataFile)),prior:p.daily[0],audits:p.daily[1].incomeDateAudits.length,auto:p.flowsAuto.length,unresolved:p.flowsUnresolved.length,pnl:p.feeCalculationReceipt.totals.grossPnlCents,verified:p.daily[1].incomeDateAudits[0].proof.verified}));\n`,{mode:0o600});
    const result=spawnSync(process.execPath,[runner],{encoding:'utf8',timeout:120000,env:{PATH:path.dirname(process.execPath)+':/usr/bin:/bin',
      FEE_DATA_KEY:key.toString('base64url'),FEE_CLOUD_SHARESIGHT_CLIENT_ID:'synthetic',FEE_CLOUD_SHARESIGHT_CLIENT_SECRET:'synthetic'}});
    assert.equal(result.status,0,result.stderr);const r=JSON.parse(result.stdout);
    assert.equal(r.first,'updated');assert.equal(r.second,'no-op');assert.equal(r.same,true);assert.deepEqual(r.prior,payload.daily[0]);
    assert.equal(r.audits,1);assert.equal(r.auto,0);assert.equal(r.unresolved,0);assert.equal(r.pnl,6950);assert.equal(r.verified,false);
    assert.equal(r.rejected,6);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

}
