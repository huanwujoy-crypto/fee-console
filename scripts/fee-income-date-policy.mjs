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
    let resolution;
    if(Object.hasOwn(proof,'resolution')) {
      const r=proof.resolution,keys=['authority','verified','cashDate','statementDate','issuedDate','sourceRef','sourceSha256','pageNumbers','grossCents','withholdingCents','collectionFeeCents','netCashCents','reviewedBy','reviewedAt'];
      if(!r||Object.keys(r).length!==keys.length||!keys.every(k=>Object.hasOwn(r,k))||r.authority!=='broker-statement-verified'||r.verified!==true||r.cashDate!==postingDate||r.statementDate!==postingDate||!date(r.issuedDate)||r.issuedDate<r.statementDate||!ref(r.sourceRef)||typeof r.sourceSha256!=='string'||!/^[a-f0-9]{64}$/.test(r.sourceSha256)||!Array.isArray(r.pageNumbers)||!r.pageNumbers.length||!r.pageNumbers.every(positive)||new Set(r.pageNumbers).size!==r.pageNumbers.length||![r.grossCents,r.withholdingCents,r.collectionFeeCents,r.netCashCents].every(n=>Number.isSafeInteger(n)&&n>=0)||r.grossCents<=0||r.grossCents-r.withholdingCents-r.collectionFeeCents!==r.netCashCents||!ref(r.reviewedBy)||typeof r.reviewedAt!=='string'||!Number.isFinite(Date.parse(r.reviewedAt))||new Date(r.reviewedAt).toISOString()!==r.reviewedAt)fail();
      resolution={...r,pageNumbers:[...r.pageNumbers].sort((a,b)=>a-b)};
    }
    return {eventKey,proof:{authority:proof.authority,verified:false,cashDate:postingDate,sourceRef:proof.sourceRef,scope:{portfolioId:s.portfolioId,payoutId:s.payoutId,cashAccountId:s.cashAccountId,cashRecordIds:[...s.cashRecordIds].sort((a,b)=>a-b)},condition:{statementDate:c.statementDate,statementRef:c.statementRef,reviewedBy:c.reviewedBy,reviewed:true,complete:true,dividendAbsent:true,feeAbsent:true,netCashMovementAbsent:true},followup:{status:'awaiting-official-record',actualBrokerDate:null},...(resolution?{resolution}:{})}};
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

export function mergeIncomeDateAudit(previous,incoming,postingDate) {
  const next=incomeDatePolicy.normalize(incoming,postingDate);
  if(!previous)return next;
  const prior=incomeDatePolicy.normalize(previous,postingDate);
  if(JSON.stringify(prior)===JSON.stringify(next))return prior;
  const original=structuredClone(next);delete original.proof.resolution;
  if(prior.proof.resolution||!next.proof.resolution||JSON.stringify(prior)!==JSON.stringify(original))throw new Error('income date audit conflict');
  return next;
}
