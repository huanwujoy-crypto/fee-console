// Pure audit validation shared with the receipt consumer. No broker-date inference.
export function createIncomeDatePolicy() {
  const fail=()=>{throw new Error('invalid owner-estimated income date audit');};
  const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
  const ref=s=>typeof s==='string'&&s.trim().length>0&&s.length<=1024;
  const positive=n=>Number.isSafeInteger(n)&&n>0;
  const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
  const notificationAuthority='owner-notification-cash-posting';
  const isNotification=proof=>proof?.authority===notificationAuthority;
  const cashCents=n=>{
    if(typeof n!=='number'||!Number.isFinite(n))return null;
    const c=Math.round(n*100);return Number.isSafeInteger(c)&&Math.abs(n*100-c)<1e-6?c:null;
  };
  const notification=(audit,postingDate)=>{
    const {eventKey,proof}=audit||{},s=proof?.scope,b=proof?.booking,a=proof?.amounts;
    if(!exact(audit,['eventKey','proof'])||!exact(proof,['authority','verified','cashDate','sourceRef','scope','booking','amounts','followup'])
      ||!date(postingDate)||!isNotification(proof)||proof.verified!==false||proof.cashDate!==postingDate||!ref(proof.sourceRef)
      ||!exact(s,['portfolioId','holdingId','ticker','payoutId','cashAccountId','cashRecordIds'])||s.portfolioId!==1350094
      ||![s.holdingId,s.payoutId,s.cashAccountId].every(positive)||typeof s.ticker!=='string'||!/^[A-Z0-9][A-Z0-9./^-]{0,31}$/.test(s.ticker)
      ||!Array.isArray(s.cashRecordIds)||s.cashRecordIds.length!==1||!positive(s.cashRecordIds[0])
      ||eventKey!==`sharesight.dividend:${s.portfolioId}:${s.holdingId}:${s.payoutId}:${s.cashAccountId}:${s.cashRecordIds[0]}`
      ||!exact(b,['basis','originalPaidOn','notificationDate','deductionConvention'])||b.basis!=='notification-date'
      ||!date(b.originalPaidOn)||b.originalPaidOn>postingDate||b.notificationDate!==postingDate
      ||b.deductionConvention!=='combined-withholding-and-collection-fee'
      ||!exact(a,['grossCents','withholdingCents','collectionFeeCents','combinedDeductionCents','netCashCents'])
      ||!Object.values(a).every(n=>Number.isSafeInteger(n)&&n>=0)||a.grossCents<=0||a.netCashCents<=0
      ||!Number.isSafeInteger(a.withholdingCents+a.collectionFeeCents)||a.withholdingCents+a.collectionFeeCents!==a.combinedDeductionCents
      ||a.grossCents-a.combinedDeductionCents!==a.netCashCents
      ||!exact(proof.followup,['status','actualBrokerDate'])||proof.followup.status!=='awaiting-official-record'||proof.followup.actualBrokerDate!==null)fail();
    return {eventKey,proof:{authority:notificationAuthority,verified:false,cashDate:postingDate,sourceRef:proof.sourceRef,
      scope:{portfolioId:s.portfolioId,holdingId:s.holdingId,ticker:s.ticker,payoutId:s.payoutId,cashAccountId:s.cashAccountId,cashRecordIds:[s.cashRecordIds[0]]},
      booking:{basis:b.basis,originalPaidOn:b.originalPaidOn,notificationDate:b.notificationDate,deductionConvention:b.deductionConvention},
      amounts:{grossCents:a.grossCents,withholdingCents:a.withholdingCents,collectionFeeCents:a.collectionFeeCents,combinedDeductionCents:a.combinedDeductionCents,netCashCents:a.netCashCents},
      followup:{status:'awaiting-official-record',actualBrokerDate:null}}};
  };
  const normalize=(audit,postingDate)=>{
    if(!audit||!date(postingDate))fail();
    if(isNotification(audit.proof)||String(audit.eventKey||'').startsWith('sharesight.dividend:'))return notification(audit,postingDate);
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
    const selected=rows.filter(a=>isNotification(a.proof));
    if(new Set(selected.map(a=>`${a.proof.scope.portfolioId}:${a.proof.scope.payoutId}`)).size!==selected.length
      ||new Set(selected.map(a=>`${a.proof.scope.cashAccountId}:${a.proof.scope.cashRecordIds[0]}`)).size!==selected.length)fail();
    return {incomeDateAudits:rows};
  };
  const timeline=points=>{
    const payouts=new Map(),cash=new Map();
    for(const p of points)for(const audit of p.incomeDateAudits||[]) {
      const proof=normalize(audit,p.d).proof,s=proof.scope,selected=isNotification(proof),pk=`${s.portfolioId}:${s.payoutId}`;
      if(payouts.has(pk)&&(selected||payouts.get(pk)))fail();payouts.set(pk,selected);
      for(const id of s.cashRecordIds) {
        const ck=`${s.cashAccountId}:${id}`;
        if(cash.has(ck)&&(selected||cash.get(ck)))fail();cash.set(ck,selected);
      }
    }
  };
  const codes=points=>{
    const out=[];
    if(points.some(p=>p.incomeDateAudits?.some(a=>!isNotification(a.proof)&&!a.proof.resolution)))out.push('owner-estimated-cash-date');
    if(points.some(p=>p.incomeDateAudits?.some(a=>isNotification(a.proof))))out.push('owner-notification-cash-date');
    return out;
  };
  return {normalize,point,isNotification,timeline,codes,cashCents};
}
export const incomeDatePolicy=createIncomeDatePolicy();
export function incomeDateEvidenceFromData(data,targetDate) {
  incomeDatePolicy.timeline(data?.daily||[]);
  const out={};
  for(const p of data?.daily||[])if(p.d===targetDate)for(const a of incomeDatePolicy.point(p).incomeDateAudits||[])out[a.eventKey]=a.proof;
  return out;
}

export function notificationIncomeAudits(evidence,targetDate) {
  if(!evidence||typeof evidence!=='object'||Array.isArray(evidence))throw new Error('invalid income date evidence');
  const audits=Object.entries(evidence).filter(([key,proof])=>incomeDatePolicy.isNotification(proof)||key.startsWith('sharesight.dividend:'))
    .map(([eventKey,proof])=>incomeDatePolicy.normalize({eventKey,proof},targetDate));
  if(!audits.length)return [];
  return incomeDatePolicy.point({d:targetDate,incomeDateAudits:audits}).incomeDateAudits;
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
