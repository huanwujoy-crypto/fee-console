// Pure evidence grading for the future verified adapter. No API, credentials,
// values, account identifiers, publication or raw-field fabrication. This module
// does not establish a fact: adapters must supply pinned, independently verified
// contracts and evidence bound to actual raw-response hashes.
const HASH=/^[a-f0-9]{64}$/;
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)
  &&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const validHash=value=>HASH.test(value||'');
export function gradeActionEvidence(evidence,{targetDate,now=Date.now(),approvedReadContracts=[]}={}){
  const blockers=[],warnings=[],verified=[];
  if(!validDate(targetDate)||!Number.isFinite(now))throw new Error('QUALITY_CONTEXT_INVALID');
  const identity=evidence?.identity;
  const bound=identity?.verified===true&&validHash(identity.bindingHash)
    &&['machine-verified-current','owner-attested-current-credential'].includes(identity.basis)
    &&identity.flexScopeMatches===true;
  if(!bound)blockers.push('CURRENT_SOURCE_ACCOUNT_NOT_BOUND');
  const completeReads={};
  for(const key of ['positions','orders','trades','cash']){
    const source=evidence?.live?.[key],readAt=Date.parse(source?.readAt);
    const approved=approvedReadContracts.includes(source?.contractHash);
    const complete=bound&&source?.accountBindingHash===identity.bindingHash&&validHash(source.rawHash)
      &&validHash(source.contractHash)&&approved&&source.allPagesRead===true
      &&source.truncated===false&&source.conflict!==true
      &&Number.isFinite(readAt)&&readAt<=now&&now-readAt<=30*60_000;
    completeReads[key]=complete;
    if(!complete)blockers.push(`${key.toUpperCase()}_READ_NOT_VERIFIED`);
    else{
      if(source.upstreamAsOf==null)warnings.push(`${key.toUpperCase()}_UPSTREAM_UPDATE_TIME_UNAVAILABLE`);
      else{
        const asOf=Date.parse(source.upstreamAsOf);
        if(!Number.isFinite(asOf)||asOf>readAt||now-asOf>30*60_000){completeReads[key]=false;blockers.push(`${key.toUpperCase()}_UPSTREAM_STALE_OR_CONFLICTING`);}
      }
      if(completeReads[key])verified.push(`${key.toUpperCase()}_READ_COMPLETE`);
    }
  }
  const coverage={};
  for(const key of ['trades','cash']){
    const report=evidence?.coveredSession?.[key];
    coverage[key]=bound&&report?.accountBindingHash===identity.bindingHash&&validHash(report.rawHash)
      &&report.source==='activity-flex'&&validDate(report.fromDate)&&validDate(report.toDate)
      &&report.fromDate<=targetDate&&report.toDate>=targetDate&&report.sectionComplete===true
      &&report.conflict!==true;
    if(!coverage[key])blockers.push(`${key.toUpperCase()}_TARGET_SESSION_NOT_COVERED`);
    else verified.push(`${key.toUpperCase()}_TARGET_SESSION_COVERED`);
  }
  // Execution evidence from Trade Confirmation is useful earlier, but does not
  // replace a covered session, certify no trades, or certify ledger finality.
  if(evidence?.tradeConfirmation?.verified===true)verified.push('EARLY_EXECUTIONS_OBSERVED');
  const checks=['positionsAgainstTrades','cashAgainstCoveredLedger','allocationAgainstPositions','noahCash'];
  for(const key of checks)if(evidence?.consistency?.[key]!=='matched')blockers.push(`${key.toUpperCase()}_NOT_MATCHED`);
  const readTimes=Object.values(evidence?.live||{}).map(s=>Date.parse(s?.readAt)).filter(Number.isFinite);
  if(readTimes.length&&Math.max(...readTimes)-Math.min(...readTimes)>300000)blockers.push('LIVE_READ_SPAN_EXCEEDED');
  if(evidence?.cashBasis!=='trade-date-by-currency-verified')blockers.push('CASH_OR_FX_BASIS_NOT_VERIFIED');
  if(completeReads.orders!==true)warnings.push('OPEN_BUY_RESERVE_UNKNOWN_NEVER_ASSUME_ZERO');
  const ready=blockers.length===0;
  const limited=bound&&(coverage.trades||coverage.cash||completeReads.positions);
  return{status:ready?'planning-evidence-ready':limited?'limited-non-action':'data-not-ready',
    scope:'planning-evidence',targetDate,actionAllowed:ready,ledgerFinality:'not-certified',
    verified,blockers,warnings,
    message:ready?'本轮规划证据通过；账务最终性未声明':limited?'部分来源已核实；关键数据未齐，暂不提供补仓金额或行动建议':'数据未齐，未生成行动建议'};
}
