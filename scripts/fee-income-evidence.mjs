// Verified income is internal to the managed portfolio, never investor funding.
// A deposited notification alone does not prove the broker's cash posting day.
import { incomeDatePolicy, notificationIncomeAudits } from './fee-income-date-policy.mjs';
import { isCalendarDate } from './fee-engine.mjs';

export const dividendCashKey = description => {
  const m = /\bkey=(webull\.dividend:([1-9]\d{0,14}):([A-Z0-9][A-Z0-9./^-]{0,31}):(\d{4}-\d{2}-\d{2}):([1-9]\d{0,14})):(net|fee)\s*$/.exec(String(description || ''));
  return m && isCalendarDate(m[4]) ? {key:m[1],accountReference:m[2],ticker:m[3],paidOn:m[4],payoutId:Number(m[5]),role:m[6]} : null;
};
const cents = n => typeof n === 'number' && Number.isFinite(n) ? Math.round(n*100) : null;

// The already audited legacy gross/tax/collection-fee import has an explicit
// account/event/cash-date key. A generic "not external" note is not this key.
// This parser selects an existing Sharesight payout; it grants no income role
// until the confirmed payout and the complete three-leg group agree below.
export function legacyDividendCashKey(description){
  const text=typeof description==='string'?description:'';
  if(text.length>600)return null;
  const key=/\bkey=(webullhk-10205226-([A-Z0-9][A-Z0-9./^-]{0,31})-(\d{8})-ce([1-9]\d{0,14})-cashcredit(\d{8}))-(gross|tax|fee)$/.exec(text);
  if(!key)return null;
  const iso=s=>s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8),paidOn=iso(key[3]),cashDate=iso(key[5]);
  if(!isCalendarDate(paidOn)||!isCalendarDate(cashDate))return null;
  const payouts=[...text.matchAll(/\bPayout([1-9]\d{0,14})[.;]/g)];
  if(payouts.length!==1||!Number.isSafeInteger(Number(payouts[0][1])))return null;
  const payoutId=Number(payouts[0][1]),role=key[6],head=text.slice(0,key.index),symbol=key[2];
  let m;
  if(role==='gross'){
    m=/^([A-Z0-9][A-Z0-9./^-]{0,31}) gross dividend; NOT external funding\. Paid(\d{4}-\d{2}-\d{2}); cash credited(\d{4}-\d{2}-\d{2})\. Payout([1-9]\d{0,14})\. $/.exec(head);
    if(!m||m[1]!==symbol||m[2]!==paidOn||m[3]!==cashDate||Number(m[4])!==payoutId)return null;
  }else if(role==='tax'){
    m=/^([A-Z0-9][A-Z0-9./^-]{0,31}) WHT (\d+(?:\.\d+)?)% of USD(\d+(?:\.\d+)?); tax cash leg, NOT commission\. Payout([1-9]\d{0,14}); cash date(\d{4}-\d{2}-\d{2})\. $/.exec(head);
    if(!m||m[1]!==symbol||Number(m[4])!==payoutId||m[5]!==cashDate)return null;
  }else{
    m=/^([A-Z0-9][A-Z0-9./^-]{0,31}) dividend collection fee(\d+(?:\.\d+)?)% of(\d+(?:\.\d+)?); NOT tax\. Official Webull [A-Za-z0-9._/-]{1,32}\. Payout([1-9]\d{0,14})\. $/.exec(head);
    if(!m||m[1]!==symbol||Number(m[4])!==payoutId)return null;
  }
  return {key:key[1],ticker:symbol,paidOn,cashDate,payoutId,role,...(role==='gross'?{}:{basis:Number(m[3])})};
}

const referenceIncomeFailure=()=>{throw new Error('invalid reference income source evidence');};
const positiveId=n=>Number.isSafeInteger(n)&&n>0;
const validReferencePayout=(p,portfolioId)=>p&&positiveId(p.id)&&p.portfolio_id===portfolioId
  &&positiveId(p.holding_id)&&typeof p.symbol==='string'&&isCalendarDate(p.paid_on)
  &&p.currency==='USD'&&p.confirmed===true&&p.state==='confirmed'&&p.non_taxable===false&&p.tax_credit===0
  &&[p.gross_amount,p.resident_withholding_tax,p.amount].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0)
  &&cents(p.gross_amount)-cents(p.resident_withholding_tax)===cents(p.amount);
const referenceRowScope=(r,p,targetDate,cashCurrencies)=>positiveId(r.id)&&positiveId(r.cash_account_id)
  &&cashCurrencies[r.cash_account_id]==='USD'&&typeof r.date_time==='string'&&Number.isFinite(Date.parse(r.date_time))
  &&r.date_time.slice(0,10)===targetDate&&r.trade_id==null
  &&(r.holding_id==null||r.holding_id===p.holding_id)&&(r.payout_id==null||r.payout_id===p.id)
  &&typeof r.amount==='number'&&Number.isFinite(r.amount);

// Selectors are only claims. A native payout pointer can reject a conflicting
// credit but cannot grant a new income role. Repeated selectors on one actual
// row may agree; separate cash credits may not reuse one payout.
function referenceCreditClaims(cashRows,evidence=new Map()){
  const claims=new Map(),recordCounts=new Map();
  for(const row of cashRows)recordCounts.set(row.id,(recordCounts.get(row.id)||0)+1);
  for(const row of cashRows){
    const selected=new Set(),modern=dividendCashKey(row.description),legacy=legacyDividendCashKey(row.description),tag=evidence.get(row.id);
    if(row.cash_account_transaction_type?.name==='DEPOSIT'&&typeof row.amount==='number'&&Number.isFinite(row.amount)&&row.amount>0&&positiveId(row.payout_id))selected.add(row.payout_id);
    if(modern?.role==='net')selected.add(modern.payoutId);
    if(legacy?.role==='gross')selected.add(legacy.payoutId);
    if(tag&&row.cash_account_transaction_type?.name==='DEPOSIT'&&row.amount>0&&positiveId(tag.sourcePayoutId))selected.add(tag.sourcePayoutId);
    for(const payoutId of selected){const group=claims.get(payoutId)||[];group.push({row,selected});claims.set(payoutId,group);}
  }
  return (payoutId,creditId)=>{
    const group=claims.get(payoutId)||[];
    if(group.length!==1||group[0].row.id!==creditId||group[0].selected.size!==1
      ||!positiveId(creditId)||recordCounts.get(creditId)!==1)referenceIncomeFailure();
  };
}

// Recheck controlled old-resolver output against complete source records before
// reference mode may use its cash date. Date authority remains with that resolver
// and its policy; this source validator must follow it, never accept caller tags.
export function validateSharesightReferenceIncomeEvidence({account,portfolioId,targetDate,cashRows,payouts={},cashCurrencies={},evidence=new Map()}){
  if(!(evidence instanceof Map)||!Array.isArray(cashRows))referenceIncomeFailure();
  const result=new Map();if(!evidence.size)return result;
  if(account!=='webull'||portfolioId!==1350094||!isCalendarDate(targetDate))referenceIncomeFailure();
  const assertCredit=referenceCreditClaims(cashRows,evidence);
  const context=resolveDividendCashEvidence({account,portfolioId,targetDate,cashRows,payouts,dateEvidence:{}});
  for(const [recordId,tag]of evidence){
    const matches=cashRows.filter(r=>r.id===recordId),row=matches[0],p=payouts[tag?.sourcePayoutId];
    if(matches.length!==1||!positiveId(tag?.sourcePayoutId)||!validReferencePayout(p,portfolioId)||tag.sourcePayoutId!==p.id||Object.values(payouts).filter(x=>x?.id===p.id).length!==1
      ||!referenceRowScope(row,p,targetDate,cashCurrencies)||tag.sourceCashRecordId!==recordId
      ||(Object.hasOwn(tag,'sourceCashAccountId')&&tag.sourceCashAccountId!==row.cash_account_id)||tag.cashPostingDate!==targetDate
      ||(Object.hasOwn(tag,'sourcePortfolioId')&&tag.sourcePortfolioId!==portfolioId)||(Object.hasOwn(tag,'sourceHoldingId')&&tag.sourceHoldingId!==p.holding_id))referenceIncomeFailure();
    if(tag.evidence==='internal_income_owner_notification'){
      let audit;try{audit=incomeDatePolicy.normalize(tag.incomeDateAudit,targetDate);}catch{referenceIncomeFailure();}
      const s=audit.proof.scope,a=audit.proof.amounts;
      if(!incomeDatePolicy.isNotification(audit.proof)||tag.incomeRole!=='dividend_net'||tag.incomeDateVerified!==false
        ||row.cash_account_transaction_type?.name!=='DEPOSIT'||row.amount<=0||s.portfolioId!==portfolioId||s.payoutId!==p.id
        ||s.holdingId!==p.holding_id||s.ticker!==p.symbol||s.cashAccountId!==row.cash_account_id||s.cashRecordIds.length!==1||s.cashRecordIds[0]!==row.id
        ||p.paid_on!==targetDate||incomeDatePolicy.cashCents(p.gross_amount)!==a.grossCents
        ||incomeDatePolicy.cashCents(p.resident_withholding_tax)!==a.combinedDeductionCents
        ||incomeDatePolicy.cashCents(p.amount)!==a.netCashCents||incomeDatePolicy.cashCents(row.amount)!==a.netCashCents)referenceIncomeFailure();
      assertCredit(p.id,row.id);
    }else{
      const known=context.get(recordId),selector=dividendCashKey(row.description);
      if(!['internal_income','internal_income_pending_date','internal_income_estimated'].includes(tag.evidence)
        ||!known||known.sourcePayoutId!==p.id||known.incomeRole!==tag.incomeRole
        ||!selector||selector.payoutId!==p.id
        ||(tag.evidence==='internal_income'&&tag.incomeDateVerified!==true)
        ||(tag.evidence!=='internal_income'&&tag.incomeDateVerified!==false))referenceIncomeFailure();
      const pair=cashRows.filter(r=>dividendCashKey(r.description)?.key===selector.key);
      if(pair.length!==2||pair.some(r=>!referenceRowScope(r,p,targetDate,cashCurrencies)||cashRows.filter(x=>x.id===r.id).length!==1))referenceIncomeFailure();
      if(tag.evidence==='internal_income_estimated'){
        let audit;try{audit=incomeDatePolicy.normalize(tag.incomeDateAudit,targetDate);}catch{referenceIncomeFailure();}
        if(audit.eventKey!==selector.key||audit.proof.scope.payoutId!==p.id||audit.proof.scope.cashAccountId!==row.cash_account_id
          ||audit.proof.resolution||JSON.stringify(audit.proof.scope.cashRecordIds)!==JSON.stringify(pair.map(r=>r.id).sort((a,b)=>a-b)))referenceIncomeFailure();
      }
      const credits=pair.filter(r=>dividendCashKey(r.description).role==='net');
      if(credits.length!==1)referenceIncomeFailure();
      assertCredit(p.id,credits[0].id);
    }
    result.set(recordId,{...tag,sourcePortfolioId:portfolioId,sourceHoldingId:p.holding_id,sourceCashRecordId:row.id,sourceCashAccountId:row.cash_account_id});
  }
  return result;
}

// Reference mode recognizes only the controlled complete legacy three-leg
// representation here. Its actual Sharesight date does not verify broker date.
export function resolveSharesightReferenceIncomeEvidence({account,portfolioId,targetDate,cashRows,payouts={},cashCurrencies={}}){
  const result=new Map();if(account!=='webull'||portfolioId!==1350094)return result;
  const assertCredit=referenceCreditClaims(cashRows);
  const tag=(r,p)=>({evidence:'internal_income_pending_date',sourcePortfolioId:portfolioId,sourceHoldingId:p.holding_id,
    sourcePayoutId:p.id,sourceCashRecordId:r.id,sourceCashAccountId:r.cash_account_id,incomeRole:'dividend',
    cashPostingDate:targetDate,incomeDateVerified:false});
  const groups=new Map();
  for(const r of cashRows){const source=legacyDividendCashKey(r.description);if(source){const group=groups.get(source.key)||[];group.push({row:r,source});groups.set(source.key,group);}}
  for(const group of groups.values()){
    const credits=group.filter(x=>x.source.role==='gross');if(!credits.length)continue;
    for(const gross of credits)assertCredit(gross.source.payoutId,gross.row.id);
    // A selected controlled gross record cannot fall back to generic trade
    // classification when its group or binding is incomplete or contradictory.
    if(group.length!==3||new Set(group.map(x=>x.row.id)).size!==3||['gross','tax','fee'].some(role=>group.filter(x=>x.source.role===role).length!==1))referenceIncomeFailure();
    const gross=group.find(x=>x.source.role==='gross'),tax=group.find(x=>x.source.role==='tax'),fee=group.find(x=>x.source.role==='fee'),p=payouts[gross.source.payoutId];
    if(!validReferencePayout(p,portfolioId)||Object.values(payouts).filter(x=>x?.id===p.id).length!==1||p.symbol!==gross.source.ticker||p.paid_on!==gross.source.paidOn||gross.source.cashDate!==targetDate
      ||group.some(x=>x.source.payoutId!==p.id||x.source.cashDate!==targetDate||x.source.ticker!==p.symbol||x.source.paidOn!==p.paid_on||!referenceRowScope(x.row,p,targetDate,cashCurrencies)||x.row.cash_account_id!==gross.row.cash_account_id)
      ||gross.row.cash_account_transaction_type?.name!=='DEPOSIT'||gross.row.amount<=0||cents(gross.row.amount)!==cents(p.gross_amount)
      ||tax.row.cash_account_transaction_type?.name!=='FEE'||tax.row.amount>0||-cents(tax.row.amount)!==cents(p.resident_withholding_tax)
      ||fee.row.cash_account_transaction_type?.name!=='FEE'||fee.row.amount>0
      ||[tax.source.basis,fee.source.basis].some(n=>!Number.isFinite(n)||cents(n)!==cents(p.gross_amount)))referenceIncomeFailure();
    result.set(gross.row.id,tag(gross.row,p));
  }
  return result;
}

/** All proof is derived from the controlled reader's actual records. Unknown
 * dates remain unresolved. A caller must independently verify date authority;
 * neither a comment nor the payout's paid_on date supplies it automatically.
 */
export function resolveDividendCashEvidence({account, portfolioId, targetDate, cashRows, payouts={}, dateEvidence={}, holdings=[]}) {
  const result = new Map();
  if (account !== 'webull' || portfolioId !== 1350094) return result;
  for(const audit of notificationIncomeAudits(dateEvidence,targetDate)) {
    const {scope:s,amounts:a}=audit.proof,payout=payouts[s.payoutId];
    const matches=cashRows.filter(row=>row.id===s.cashRecordIds[0]),net=matches[0];
    const linked=cashRows.filter(row=>row.payout_id===s.payoutId||dividendCashKey(row.description)?.payoutId===s.payoutId);
    const sourceMatches=Object.values(payouts).filter(row=>row?.id===s.payoutId);
    if(s.portfolioId!==portfolioId||matches.length!==1||sourceMatches.length!==1||!payout
      ||payout.id!==s.payoutId||payout.portfolio_id!==portfolioId||payout.holding_id!==s.holdingId||payout.symbol!==s.ticker
      ||payout.paid_on!==targetDate||payout.currency!=='USD'||payout.confirmed!==true||payout.state!=='confirmed'
      ||payout.non_taxable!==false||payout.tax_credit!==0
      ||holdings.filter(h=>h.holdingId===s.holdingId&&h.ticker===s.ticker).length!==1
      ||net.cash_account_id!==s.cashAccountId||net.cash_account_transaction_type?.name!=='DEPOSIT'
      ||String(net.date_time).slice(0,10)!==targetDate||net.trade_id!=null
      ||(net.holding_id!=null&&net.holding_id!==s.holdingId)||(net.payout_id!=null&&net.payout_id!==s.payoutId)
      ||linked.some(row=>row!==net)
      ||incomeDatePolicy.cashCents(payout.gross_amount)!==a.grossCents
      ||incomeDatePolicy.cashCents(payout.resident_withholding_tax)!==a.combinedDeductionCents
      ||incomeDatePolicy.cashCents(payout.amount)!==a.netCashCents||incomeDatePolicy.cashCents(net.amount)!==a.netCashCents)
      throw new Error('invalid notification income source evidence');
    result.set(net.id,{evidence:'internal_income_owner_notification',incomeDateAudit:audit,
      sourcePortfolioId:portfolioId,sourceHoldingId:s.holdingId,sourcePayoutId:payout.id,
      sourceCashRecordId:net.id,sourceCashAccountId:net.cash_account_id,incomeRole:'dividend_net',
      cashPostingDate:targetDate,incomeDateVerified:false});
  }
  const groups = new Map();
  for (const row of cashRows) {
    const source = dividendCashKey(row.description);
    if (!source) continue;
    const group=groups.get(source.key)||[];group.push({row,source});groups.set(source.key,group);
  }
  for (const [key,group] of groups) {
    if(group.some(item=>result.has(item.row.id)))continue;
    if (group.length!==2 || group.filter(x=>x.source.role==='net').length!==1
        || group.filter(x=>x.source.role==='fee').length!==1) continue;
    const net=group.find(x=>x.source.role==='net'),fee=group.find(x=>x.source.role==='fee');
    const payout=payouts[net.source.payoutId];
    if (!payout || payout.id!==net.source.payoutId || payout.portfolio_id!==portfolioId
        || !Number.isSafeInteger(payout.holding_id) || payout.holding_id<=0
        || payout.symbol!==net.source.ticker || payout.paid_on!==net.source.paidOn
        || payout.currency!=='USD' || payout.confirmed!==true || payout.state!=='confirmed'
        || payout.non_taxable!==false || payout.tax_credit!==0
        || net.row.cash_account_id!==fee.row.cash_account_id
        || !Number.isSafeInteger(net.row.id) || !Number.isSafeInteger(fee.row.id)
        || net.row.id===fee.row.id || net.row.amount<=0 || fee.row.amount>=0
        || net.row.cash_account_transaction_type?.name!=='DEPOSIT'
        || fee.row.cash_account_transaction_type?.name!=='FEE'
        || String(net.row.date_time).slice(0,10)!==targetDate
        || String(fee.row.date_time).slice(0,10)!==targetDate) continue;
    const text = /^([A-Z0-9][A-Z0-9./^-]{0,31}) dividend: gross(\d+\.\d{2}) WHT(\d+\.\d{2}) net(\d+\.\d{2}); fee(\d+\.\d{2}) separately\. INTERNAL_DIVIDEND_CASH, not external funding\./.exec(net.row.description);
    const feeText = /^([A-Z0-9][A-Z0-9./^-]{0,31}) dividend collection fee: gross(\d+\.\d{2}) x(\d+(?:\.\d+)?)%, min(\d+\.\d{2}), rounded(\d+\.\d{2})\. NOT WHT\. Official Webull schedule \+ exact net(\d+\.\d{2}) cash match; rule-authorized\./.exec(fee.row.description);
    // Compare actual confirmed payout amounts and both separate cash legs.
    // The collection fee is never conflated with withholding tax or funding.
    if (!text || !feeText || text[1]!==payout.symbol || feeText[1]!==payout.symbol
        || cents(payout.gross_amount)!==cents(Number(text[2]))
        || cents(payout.resident_withholding_tax)!==cents(Number(text[3]))
        || cents(payout.amount)!==cents(Number(text[4])) || cents(payout.amount)!==cents(net.row.amount)
        || cents(payout.gross_amount)-cents(payout.resident_withholding_tax)!==cents(payout.amount)
        || cents(Number(text[5]))!==-cents(fee.row.amount)
        || cents(Number(feeText[2]))!==cents(payout.gross_amount)
        || cents(Number(feeText[5]))!==-cents(fee.row.amount)
        || cents(Number(feeText[6]))!==cents(net.row.amount+fee.row.amount)) continue;
    const expectedFee=Math.max(Number(feeText[4]),Math.round(payout.gross_amount*Number(feeText[3]))/100);
    if (cents(expectedFee)!==-cents(fee.row.amount)) continue;
    const proof=dateEvidence[key];
    let dateReady=proof?.verified===true && proof.cashDate===targetDate
      && ['broker-cash-ledger','owner-approved-cash-posting'].includes(proof.authority)
      && typeof proof.sourceRef==='string' && proof.sourceRef.trim().length>0;
    let audit;
    if(proof?.authority==='owner-estimated-cash-posting') {
      try {
        audit=incomeDatePolicy.normalize({eventKey:key,proof},targetDate);
        if(audit.proof.scope.payoutId!==payout.id || audit.proof.scope.cashAccountId!==net.row.cash_account_id
          || JSON.stringify(audit.proof.scope.cashRecordIds)!==JSON.stringify([net.row.id,fee.row.id].sort((a,b)=>a-b)))audit=undefined;
      } catch { audit=undefined; }
    }
    if(audit?.proof.resolution) {
      const resolution=audit.proof.resolution;
      if(resolution.grossCents!==cents(payout.gross_amount)||resolution.withholdingCents!==cents(payout.resident_withholding_tax)||resolution.collectionFeeCents!==-cents(fee.row.amount)||resolution.netCashCents!==cents(net.row.amount+fee.row.amount))audit=undefined;
      else dateReady=true;
    }
    for (const item of group) result.set(item.row.id, {
      evidence:dateReady?'internal_income':audit?'internal_income_estimated':'internal_income_pending_date',
      ...(audit?{incomeDateAudit:audit}:{}),
      sourcePayoutId:payout.id, sourceCashRecordId:item.row.id, sourceCashAccountId:item.row.cash_account_id, incomeRole:item.source.role==='net'?'dividend':'collection_fee',
      cashPostingDate:targetDate, incomeDateVerified:dateReady,
    });
  }
  return result;
}
