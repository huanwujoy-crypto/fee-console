// Offline evidence summary only. No account identifiers, financial rows, calls,
// refresh, publication or manufactured upstream timestamps.
const SHA=/^[a-f0-9]{64}$/;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const instant=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
export function finiteEvidenceSummary({targetTradeDate,association,live,trade,cash},now=Date.now()){
  if(!DATE.test(targetTradeDate)||!association||association.basis!=='owner-attested-recurring-v1'||association.status!=='active'||!instant(association.expiresAt)||Date.parse(association.expiresAt)<=now)throw Error('EVIDENCE_CONTEXT_INVALID');
  const notes=[],summary={targetTradeDate,association:'业主关联声明有效，非机器身份认证',livePositions:'未核实',liveOrders:'未核实',targetTrades:'未核实',targetCash:'未核实',upstreamAsOf:'未提供',atomicSnapshot:false,ledgerFinality:'未证明',actionAmountsAllowed:false,publication:'none'};
  for(const [key,label] of [['positions','livePositions'],['orders','liveOrders']]){
    const s=live?.[key];
    if(!s)continue;
    if(!SHA.test(s.rawSha256)||!instant(s.startedAt)||!instant(s.completedAt)||Date.parse(s.completedAt)<Date.parse(s.startedAt)||Date.parse(s.completedAt)>now||now-Date.parse(s.completedAt)>30*60_000||s.complete!==true||s.contract!==(key==='positions'?'all-open-positions':'all-live-orders')){notes.push(key+'本轮读取证据不足');continue;}
    // Request clocks prove capture freshness only; upstream time remains unknown.
    summary[label]='本轮读取完成';summary[key+'ReadCompletedAt']=s.completedAt;
  }
  if(trade&&SHA.test(trade.rawSha256)&&trade.tradeDate===targetTradeDate&&trade.accountMatched===true&&Number.isInteger(trade.executionCount)&&trade.executionCount>0&&trade.executionIdsChecked===true&&trade.conflict===false&&trade.sharesightMatched===true){summary.targetTrades='目标日已核实执行与Sharesight一致';summary.executionCount=trade.executionCount;summary.corrections=trade.correctionsVerified===true?'已核实':'未证明完整';}
  if(cash&&SHA.test(cash.rawSha256)&&cash.reportedDate===targetTradeDate&&cash.accountMatched===true&&['trade-date','settled'].includes(cash.basis)&&cash.perCurrencyMatched===true&&cash.conflict===false){summary.targetCash='目标日现金逐币种对账一致';summary.cashBasis=cash.basis;}
  summary.status=Object.values(summary).includes('未核实')?'partial':'limited-read-only';
  summary.notes=notes;return summary;
}
