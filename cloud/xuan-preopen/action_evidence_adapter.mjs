// Pure minimum evidence gate. Uses semantic source proofs, not fabricated API
// fields, shared snapshot IDs or tool-request clocks as upstream finality.
// No network/credentials/writes/amount output. A passed gate still requires
// private calculation and the existing policy/signature/publication checks.
export function evaluateActionEvidence({association,live,trade,cash,consistency},now=Date.now()){
 const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v,fresh=s=>s&&sha(s.rawSha256)&&Number.isFinite(Date.parse(s.startedAt))&&Number.isFinite(Date.parse(s.completedAt))&&Date.parse(s.completedAt)>=Date.parse(s.startedAt)&&Date.parse(s.completedAt)<=now&&now-Date.parse(s.startedAt)<=1800000&&Date.parse(s.completedAt)-Date.parse(s.startedAt)<=300000;
 const reasons=[],levels={association:'unverified',positions:'unverified',orders:'unverified',trades:'unverified',cash:'unverified',crossSource:'unverified'};
 if(association?.basis==='owner-attested-recurring-v1'&&association.status==='active'&&Date.parse(association.expiresAt)>now)levels.association='owner-attested';else reasons.push('ASSOCIATION_INVALID');
 if(fresh(live?.positions)&&live.positions.contract==='all-open-positions'&&live.positions.complete===true&&live.positions.identifiersUnique===true)levels.positions='current-read-complete';else reasons.push('POSITIONS_INCOMPLETE');
 if(fresh(live?.orders)&&live.orders.contract==='all-live-orders'&&live.orders.complete===true&&live.orders.identifiersUnique===true)levels.orders='current-read-complete';else reasons.push('LIVE_ORDERS_INCOMPLETE');
 if(levels.orders==='current-read-complete'&&(live.orders.currencyVerified!==true||live.orders.remainingQtyVerified!==true))reasons.push('ORDER_RESERVE_UNVERIFIED');
 // Coverage may be declared by a real Activity interval. A verified nonempty
 // Trade Confirmation only certifies known executions, never full cancellations.
 const target=trade?.targetDate;
 const known=sha(trade?.rawSha256)&&date(target)&&trade.accountMatched===true&&trade.executionIdsUnique===true&&trade.conflict===false&&trade.savedSharesightMatched===true;
 if(known){levels.trades='known-executions-matched';if(trade.coverageBasis==='declared-activity-interval'&&date(trade.fromDate)&&date(trade.toDate)&&trade.fromDate<=target&&trade.toDate>=target&&trade.correctionsVerified===true)levels.trades='target-session-covered';}
 if(levels.trades!=='target-session-covered')reasons.push('TARGET_SESSION_COVERAGE_UNVERIFIED');
 if(sha(cash?.rawSha256)&&cash.accountMatched===true&&cash.reportedDate===target&&['trade-date','settled'].includes(cash.basis)&&cash.perCurrencyMatched===true&&cash.fxBasisVerified===true&&cash.conflict===false)levels.cash='target-cash-reconciled';else reasons.push('TARGET_CASH_UNVERIFIED');
 if(levels.cash==='target-cash-reconciled'&&fresh(live?.balances)&&live.balances.contract==='all-currency-balances'&&live.balances.complete===true&&live.balances.cashBasisVerified===true)levels.cash='target-and-current-cash-verified';else reasons.push('CURRENT_CASH_BASIS_UNVERIFIED');
 if(consistency?.holdingsTradesCash==='consistent'&&consistency.ordersCash==='consistent'&&consistency.sharesightConfiguration==='consistent')levels.crossSource='consistent';else reasons.push('CROSS_SOURCE_NOT_RECONCILED');
 return{status:reasons.length?'partial':'eligible-for-private-planning',levels,reasonCodes:reasons,upstreamAsOf:'not-provided-unless-source-declares',atomicSnapshot:false,ledgerFinality:'not-certified',actionAmountsIncluded:false,publication:'none'};
}
