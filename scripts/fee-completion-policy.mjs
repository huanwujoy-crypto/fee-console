// Offline policy. The caller must be an authenticated fixed receipt adapter.
// A local JSON value never supplies that authentication or source completeness.
import crypto from 'node:crypto';
import {evaluateCashCoverage} from './fee-completion-cash-policy.mjs';
const accounts={schwab:936249,webull:1350094};
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const date=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&new Date(x+'T00:00:00Z').toISOString().slice(0,10)===x;
const time=x=>typeof x==='string'&&Number.isFinite(Date.parse(x));
const reject=code=>{throw Error('FEE_COMPLETION_'+code);};
const count=x=>Number.isSafeInteger(x)&&x>=0;
export function validateSchwabCashAttestation(a,{targetDate,now,maxAgeMs}){
 if(!a||!date(targetDate)||a.targetDate!==targetDate||a.account!=='schwab'||a.portfolioId!==accounts.schwab||a.currency!=='USD')reject('SCHWAB_CASH_SCOPE');
 if(!['user-confirmed-official-account','official-statement'].includes(a.sourceKind)||!['human-confirmed','official-record'].includes(a.confirmationKind)||!hash(a.evidenceSha256)||typeof a.confirmedBy!=='string'||!a.confirmedBy.trim())reject('SCHWAB_CASH_PROVENANCE');
 if(a.sourceKind==='user-confirmed-official-account'&&a.confirmationKind!=='human-confirmed')reject('SCHWAB_CASH_PROVENANCE');
 if(!time(a.sourceCapturedAt)||!time(a.confirmedAt)||!time(a.destinationCapturedAt)||!Number.isFinite(maxAgeMs)||maxAgeMs<=0)reject('SCHWAB_CASH_TIME');
 const n=+new Date(now),s=Date.parse(a.sourceCapturedAt),c=Date.parse(a.confirmedAt),d=Date.parse(a.destinationCapturedAt);
 if(!Number.isFinite(n)||s>n||c>n||d>n||c<s||n-s>maxAgeMs||Math.abs(s-d)>300000)reject('SCHWAB_CASH_STALE');
 if(a.matchStatus!=='MATCHED'||a.actualBalanceCompared!==true||a.valuationOnly===true)reject('SCHWAB_CASH_MATCH');
 return {targetDate,sourceKind:a.sourceKind,confirmationKind:a.confirmationKind,evidenceSha256:a.evidenceSha256};
}
export function validateCompletion(r,{targetDate,now,receiptMaxAgeMs,cashMaxAgeMs,authenticatedProvider,cashPolicy='require-independent'}={}){
 const issuer=r?.broker==='schwab'?'schwab-gmail-sync-runtime@family-portfolio-gateway.iam.gserviceaccount.com':'webull-gmail-sync-runtime@family-portfolio-gateway.iam.gserviceaccount.com';
 if(!authenticatedProvider||authenticatedProvider!==issuer||authenticatedProvider!==r?.issuer)reject('UNTRUSTED_PROVIDER');
 if(!r||r.schema!=='fee.broker-covered-completion.v2'||!Object.hasOwn(accounts,r.broker)||r.portfolioId!==accounts[r.broker]||!date(r.targetDate)||r.targetDate!==targetDate||r.targetTimezone!=='America/New_York')reject('SCOPE');
 if(!time(r.issuedAt)||!time(r.validUntil)||!Number.isFinite(receiptMaxAgeMs)||receiptMaxAgeMs<=0)reject('TIME');
 const n=+new Date(now),issued=Date.parse(r.issuedAt),until=Date.parse(r.validUntil);
 if(!Number.isFinite(n)||issued>n||until<=n||until<=issued||n-issued>receiptMaxAgeMs||until-issued>receiptMaxAgeMs)reject('STALE');
 if(Object.hasOwn(r,'knownDifferenceCount')&&r.knownDifferenceCount!==0)reject('KNOWN_DIFFERENCE');
 if(r.coveredScopeStatus!=='COMPLETE'||!['ESTIMATED','DRAFT','FINAL'].includes(r.valuationFinality))reject('INCOMPLETE');
 const s=r.sourceScan;
 if(!s||s.targetDate!==targetDate||s.paginationExhausted!==true||!count(s.pageCount)||s.pageCount<1||!hash(s.queryHash)||!time(s.windowStart)||!time(s.windowEnd)||Date.parse(s.windowEnd)<=Date.parse(s.windowStart)||!time(s.finishedAt)||Date.parse(s.finishedAt)>n||Date.parse(s.windowEnd)>Date.parse(s.finishedAt)||!hash(s.candidateSetHash)||typeof s.sourceRangeKind!=='string'||!s.sourceRangeKind.trim()||!['candidateCount','verifiedCount','duplicateCount','ignoredCount','unresolvedCount','financialAttentionCount'].every(k=>count(s[k])))reject('SCAN');
 if(s.unresolvedCount||s.financialAttentionCount||s.candidateCount!==s.verifiedCount+s.duplicateCount+s.ignoredCount||s.ignoredReasonsComplete!==true)reject('PENDING');
 if(!r.pending||!['reviewRequired','unknown','partial','submitted','unpostedCash','unknownFee','metadataPending'].every(k=>r.pending[k]===0))reject('PENDING');
 if(!Array.isArray(r.tradeProofs)||r.tradeProofs.length!==s.verifiedCount+s.duplicateCount)reject('TRADE_PARTITION');
 const ids=new Set(),cashIds=new Set();
 for(const p of r.tradeProofs){
  if(!['native','existing-program-uid'].includes(p.linkKind)&&!hash(p.linkApprovalHash))reject('LINK_APPROVAL');
  if(!hash(p.sourceRefHash)||!hash(p.economicsHash)||!Number.isSafeInteger(p.tradeId)||p.tradeId<=0||ids.has(p.tradeId)||!Number.isSafeInteger(p.cashId)||p.cashId<=0||cashIds.has(p.cashId)||p.matchingCashLegCount!==1||p.actualFeeStatus!=='PROVEN'||!hash(p.actualFeeEvidenceHash)||p.readbackStatus!=='VERIFIED'||!['native','existing-program-uid','approved-legacy','approved-manual'].includes(p.linkKind))reject('TRADE_PROOF');
  if(p.linkKind==='existing-program-uid'&&(r.broker!=='webull'||p.linkMatcher!=='WebullCloudSyncService._linked_cash'||!hash(p.linkEvidenceHash)))reject('UID_LINK');
  ids.add(p.tradeId);cashIds.add(p.cashId);
 }
 const cashCoverage=evaluateCashCoverage(r,{cashPolicy,targetDate,now,cashMaxAgeMs});
 if(cashCoverage.independentCashVerified){
 const c=r.cashProof;
 if(!c||c.matchStatus!=='MATCHED'||!hash(c.evidenceHash)||c.targetDate!==targetDate||!Array.isArray(c.currencyScope)||!time(c.sourceCapturedAt)||!time(c.destinationCapturedAt)||!Number.isFinite(cashMaxAgeMs)||cashMaxAgeMs<=0)reject('CASH');
 if(JSON.stringify([...c.currencyScope].sort())!==JSON.stringify(r.broker==='webull'?['HKD','USD']:['USD']))reject('CASH_SCOPE');
 if(Date.parse(c.sourceCapturedAt)>n||Date.parse(c.destinationCapturedAt)>n||n-Date.parse(c.sourceCapturedAt)>cashMaxAgeMs||Math.abs(Date.parse(c.sourceCapturedAt)-Date.parse(c.destinationCapturedAt))>300000)reject('CASH_STALE');
 if(r.broker==='schwab')validateSchwabCashAttestation(c.manualAttestation,{targetDate,now,maxAgeMs:cashMaxAgeMs});
 }
 if(!r.nontradeCoverage||!['FULL','LIMITED','UNKNOWN'].includes(r.nontradeCoverage.kind)||r.nontradeCoverage.unresolvedKnownItems!==0||!Array.isArray(r.nontradeCoverage.knownReceivables)||r.nontradeCoverage.knownReceivables.some(x=>!hash(x.evidenceHash)||x.treatedAsReceivedCash!==false))reject('NONTRADE');
 if(r.valuationFinality==='FINAL'&&(r.nontradeCoverage.kind!=='FULL'||r.nontradeCoverage.knownReceivables.length))reject('FALSE_FINAL');
 if(!hash(r.journalHash)||!hash(r.destinationFingerprint)||typeof r.journalGeneration!=='string'||!/^\d+$/.test(r.journalGeneration))reject('BINDING');
 return {broker:r.broker,targetDate,coveredScopeStatus:'COMPLETE',valuationFinality:r.valuationFinality,...cashCoverage};
}
export function assertSameBinding(before,after){
 if(!Array.isArray(before)||before.length!==2||!Array.isArray(after)||after.length!==2)reject('BINDING');
 for(const broker of ['schwab','webull']){
  const b=before.filter(x=>x.broker===broker),a=after.filter(x=>x.broker===broker);
  if(b.length!==1||a.length!==1||!['receiptHash','receiptGeneration','pointerGeneration','destinationFingerprint'].every(k=>b[0][k]===a[0][k]))reject('BINDING_CHANGED');
 }
}
export const sha256=x=>crypto.createHash('sha256').update(x).digest('hex');
