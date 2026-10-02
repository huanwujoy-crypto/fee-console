// Pure audit validation shared with the receipt consumer. No broker-date inference.
export function createIncomeDatePolicy() {
  const fail=()=>{throw new Error('invalid owner-estimated income date audit');};
  const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
  const ref=s=>typeof s==='string'&&s.trim().length>0&&s.length<=1024;
  const positive=n=>Number.isSafeInteger(n)&&n>0;
  const normalize=(audit,postingDate)=>{
    if(!audit||!date(postingDate))fail();
    const {eventKey,proof}=audit,c=proof?.condition,s=proof?.scope;
    const m=/^webull\.dividend:([1-9]\d{0,14}):([A-Z0-9][A-Z0-9./^-]{0,31}):(\d{4}-\d{2}-\d{2}):([1-9]\d{0,14})$/.exec(eventKey||'');
    if(!m||!date(m[3])||proof.authority!=='owner-estimated-cash-posting'||proof.verified!==false||proof.cashDate!==postingDate||!ref(proof.sourceRef)
      ||!c||c.statementDate!==m[3]||!ref(c.statementRef)||!ref(c.reviewedBy)||![c.reviewed,c.complete,c.dividendAbsent,c.feeAbsent,c.netCashMovementAbsent].every(v=>v===true)
      ||new Date(Date.parse(c.statementDate+'T00:00:00Z')+86400000).toISOString().slice(0,10)!==postingDate
      ||!s||s.portfolioId!==1350094||s.payoutId!==Number(m[4])||!positive(s.cashAccountId)||!Array.isArray(s.cashRecordIds)||s.cashRecordIds.length!==2||!s.cashRecordIds.every(positive)||s.cashRecordIds[0]===s.cashRecordIds[1]
      ||proof.followup?.status!=='awaiting-official-record'||proof.followup.actualBrokerDate!==null)fail();
    return {eventKey,proof:{authority:proof.authority,verified:false,cashDate:postingDate,sourceRef:proof.sourceRef,scope:{portfolioId:s.portfolioId,payoutId:s.payoutId,cashAccountId:s.cashAccountId,cashRecordIds:[...s.cashRecordIds].sort((a,b)=>a-b)},condition:{statementDate:c.statementDate,statementRef:c.statementRef,reviewedBy:c.reviewedBy,reviewed:true,complete:true,dividendAbsent:true,feeAbsent:true,netCashMovementAbsent:true},followup:{status:'awaiting-official-record',actualBrokerDate:null}}};
  };
  const point=p=>{
    if(p.incomeDateAudits===undefined)return {};
    if(!Array.isArray(p.incomeDateAudits)||!p.incomeDateAudits.length)fail();
    const rows=p.incomeDateAudits.map(a=>normalize(a,p.d)).sort((a,b)=>a.eventKey<b.eventKey?-1:a.eventKey>b.eventKey?1:0);
    if(new Set(rows.map(a=>a.eventKey)).size!==rows.length)fail();
    return {incomeDateAudits:rows};
  };
  return {normalize,point};
}
export const incomeDatePolicy=createIncomeDatePolicy();
export function incomeDateEvidenceFromData(data,targetDate) {
  const out={};
  for(const p of data?.daily||[])if(p.d===targetDate)for(const a of incomeDatePolicy.point(p).incomeDateAudits||[])out[a.eventKey]=a.proof;
  return out;
}
