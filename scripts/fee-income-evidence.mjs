// Verified income is internal to the managed portfolio, never investor funding.
// A deposited notification alone does not prove the broker's cash posting day.
import { incomeDatePolicy, notificationIncomeAudits } from './fee-income-date-policy.mjs';
import { isCalendarDate } from './fee-engine.mjs';

export const dividendCashKey = description => {
  const m = /\bkey=(webull\.dividend:([1-9]\d{0,14}):([A-Z0-9][A-Z0-9./^-]{0,31}):(\d{4}-\d{2}-\d{2}):([1-9]\d{0,14})):(net|fee)\s*$/.exec(String(description || ''));
  return m && isCalendarDate(m[4]) ? {key:m[1],accountReference:m[2],ticker:m[3],paidOn:m[4],payoutId:Number(m[5]),role:m[6]} : null;
};
const cents = n => typeof n === 'number' && Number.isFinite(n) ? Math.round(n*100) : null;

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
