import test from 'node:test';import assert from 'node:assert/strict';import {adaptTradeConfirmationCsv,TRADE_CONFIRMATION_HEADERS as headers} from './trade_confirmation.mjs';
const options={expectedAccount:'fixture-approved',targetTradeDate:'2026-10-01'};
function row(change={}){return{ClientAccountID:'fixture-approved',Conid:'fixture-conid',TradeID:'trade-1',ExecID:'exec-1',OrderID:'order-1',TradeDate:'10/01/2026',ReportDate:'10/02/2026',SettleDate:'10/02/2026','Date/Time':'10/01/2026;235959',OrderTime:'10/01/2026;230000',CurrencyPrimary:'USD',CommissionCurrency:'USD','Buy/Sell':'BUY',Quantity:'1',Price:'2',Amount:'2',Proceeds:'-2',Commission:'-0.1',Tax:'0',NetCash:'-2.1',AssetClass:'STK',Symbol:'FIXTURE',ListingExchange:'LSE',Exchange:'LSE',LevelOfDetail:'EXECUTION',OrigTradeID:'',OrigTradeDate:'',OrigTradePrice:'',TransactionType:'',Code:'',...change};}
const csv=rows=>headers.join(',')+'\r\n'+rows.map(r=>headers.map(k=>'"'+String(r[k]).replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';
test('actual verified header normalizes executions and fees by declared currencies without timezone/finality invention',()=>{
 const result=adaptTradeConfirmationCsv(csv([row({Symbol:'quoted, "fixture"'})]),options),r=result.executions[0];assert.equal(r.executionId,'exec-1');assert.equal(r.reportedTradeDate,'2026-10-01');assert.equal(r.reportDate,'2026-10-02');assert.equal(r.executedLocalTime,'23:59:59');assert.equal(r.executedAtUtc,null);assert.equal(result.completeness.targetSessionFullyCovered,false);assert.equal(result.completeness.generatedAt,null);assert.equal(result.completeness.coveredThroughDate,null);assert.equal(result.completeness.cancellationsVerified,false);assert.equal(result.accountScope.rowsMatchApprovedAccount,true);assert.equal(JSON.stringify(result).includes('fixture-approved'),false);
});
test('multiple fills share OrderID but remain distinct ExecIDs; exact duplicates dedupe, conflicting ExecID rejects',()=>{
 const a=row(),b=row({ExecID:'exec-2',TradeID:'trade-2',Quantity:'2'});const result=adaptTradeConfirmationCsv(csv([a,b,a]),options);assert.equal(result.executionCount,2);assert.equal(result.duplicateRows,1);assert.equal(result.executions[0].orderId,result.executions[1].orderId);assert.throws(()=>adaptTradeConfirmationCsv(csv([a,row({Quantity:'2'})]),options),/EXECUTION_CONFLICT/);
});
test('empty report cannot certify zero or coverage; source date remains declared date with ambiguous NY boundary',()=>{
 const empty=adaptTradeConfirmationCsv(csv([]),options);assert.equal(empty.executionCount,0);assert.equal(empty.completeness.zeroExecutionsCertified,false);assert.equal(empty.accountScope.uniqueAccount,false);
 const r=adaptTradeConfirmationCsv(csv([row({'Date/Time':'10/02/2026;001000',TradeDate:'10/01/2026'})]),options);assert.equal(r.reportedTargetDateExecutionCount,1);assert.equal(r.executions[0].executedLocalDate,'2026-10-02');assert.equal(r.executions[0].timezone,null);
});
test('unapproved/multiple accounts, invalid time/date, missing ExecID, malformed numeric/header fail with fixed safe codes',()=>{
 for(const change of [{ClientAccountID:'fixture-other'},{ExecID:''},{TradeDate:'02/30/2026'},{'Date/Time':'10/01/2026;250000'},{NetCash:'private diagnostic'}])assert.throws(()=>adaptTradeConfirmationCsv(csv([row(change)]),options),/^Error: TC_[A-Z_]+$/);
 assert.throws(()=>adaptTradeConfirmationCsv(csv([row(),row({ClientAccountID:'fixture-other'})]),options),/ACCOUNT_SCOPE_CONFLICT/);assert.throws(()=>adaptTradeConfirmationCsv('ExecID\nfixture\n',options),/HEADER_UNVERIFIED/);
});
test('correction reference is preserved, absence of cancelpairs never means no cancellations',()=>{
 const r=adaptTradeConfirmationCsv(csv([row({OrigTradeID:'trade-original',OrigTradeDate:'09/30/2026',OrigTradePrice:'2',TransactionType:'CORRECTION',Code:'fixture'})]),options);assert.equal(r.executions[0].correction.originalTradeDate,'2026-09-30');assert.equal(r.completeness.cancelPairsIncluded,false);assert.equal(r.completeness.cancellationsVerified,false);
});
test('economic decimal text stays exact and fee currency is never silently converted',()=>{
 const r=adaptTradeConfirmationCsv(csv([row({CurrencyPrimary:'EUR',CommissionCurrency:'USD',Price:'2.000000000000000001'})]),options).executions[0];assert.equal(r.currency,'EUR');assert.equal(r.commissionCurrency,'USD');assert.equal(r.economicText.Price,'2.000000000000000001');assert.equal(r.orderTimeText,'10/01/2026;230000');assert.equal(r.assetClass,'STK');assert.equal(r.levelOfDetail,'EXECUTION');
 const missing=adaptTradeConfirmationCsv(csv([row({CommissionCurrency:''})]),options);assert.equal(missing.executions[0].commissionCurrency,null);assert.ok(missing.warnings.includes('COMMISSION_CURRENCY_NOT_PROVIDED'));
});
test('RFC4180 multiline fields and BOM parse safely, malformed quoting is rejected with no row disclosure',()=>{
 const text='\uFEFF'+csv([row({Symbol:'fixture\nmultiline'})]);assert.equal(adaptTradeConfirmationCsv(text,options).executions[0].symbol,'fixture\nmultiline');assert.throws(()=>adaptTradeConfirmationCsv(headers.join(',')+'\n"unclosed',options),/^Error: TC_CSV_QUOTE$/);
});
