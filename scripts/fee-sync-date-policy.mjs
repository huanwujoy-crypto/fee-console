// Future China sync-date accounting gate (owner policy, default OFF).
// Pure and in-memory: no fetch, credential, file, writer, scheduler or Sharesight
// write. It adds checks to the unified readiness gate and never replaces any
// original source validator, history digest, capture binding or publication
// protection. Without an explicit cutover date it is disabled.
//
// Management convention: each newly verified event takes the China (UTC+8)
// calendar date of the sync session that entered it as its Sharesight business
// date (accountingEffectiveDate). That is an accounting date, not the market
// date of the event and not a valuation instant. Broker original dates and
// references stay in the receipt for audit only.
import {sourceContractInputHash as hash} from './fee-source-contract.mjs';

export const SYNC_DATE_POLICY_SCHEMA='fee-console.sync-date-policy.v1';
export const SYNC_DATE_RECEIPT_SCHEMA='fee-console.verified-sync.v2';
export const SYNC_DATE_CODES=Object.freeze([
  'CONFIG','SCHEMA','SESSION_OPEN','SESSION_MISSING','SESSION_DATE','BEFORE_CUTOVER',
  'RECORD_DATE','AFTER_MIDNIGHT_OLD_DATE','BACKFILL_REFUSED','UNDECLARED_EVENT','RECORD_MISSING',
  'ID_CONFLICT','LINK_MISSING','LINK_DATE','LINK_DOUBLE_COUNT','BROKER_AUDIT_MISSING',
  'ACCEPTANCE_INCOMPLETE','RECONCILIATION_PAUSED','NON_USD_MOVEMENT_UNSUPPORTED',
  'ALREADY_PUBLISHED','WAITING_OFFICIAL_EVIDENCE','WAITING_WRITER_PRE_CLOSE',
]);
const CODES=new Set(SYNC_DATE_CODES),errors=new WeakMap(),gates=new WeakSet();
const PREFIX='FEE_SYNC_DATE_';
function fail(code){const e=new Error(PREFIX+(CODES.has(code)?code:'SCHEMA'));errors.set(e,CODES.has(code)?code:'SCHEMA');throw Object.freeze(e);}
export const syncDateFailureCode=e=>errors.get(e)||null;
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const isDay=d=>typeof d==='string'&&DAY.test(d)&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
const instant=v=>{const t=typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)?Date.parse(v):NaN;if(!Number.isFinite(t))fail('SCHEMA');return t;};
const chinaDate=v=>new Date(instant(v)+8*3600000).toISOString().slice(0,10);
const addDay=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const chinaDayEnd=d=>Date.parse(d+'T00:00:00+08:00')+86400000;
export function nyCloseInstant(d){
  if(!isDay(d))fail('SCHEMA');
  const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(new Date(d+'T12:00:00Z')));
  return Date.parse(d+'T16:00:00Z')+(12-hour)*3600000;
}
const exact=(v,keys,code='SCHEMA')=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join()!==[...keys].sort().join())fail(code);};
// Identity is never the bare Sharesight id: account role and kind are part of it.
export const syncRecordKey=r=>r.role+'|'+r.kind+'|'+r.id;
// Content fingerprint of the projected event the receipt accepted. A changed
// event under an already-accepted key is a conflict, never a silent update.
const eventSha=e=>hash(e);

function businessEvents(p){
  // Business date of each projected event, read only from verified Sharesight
  // fields: trade transaction_date, payout paid_on, linked cash takes its
  // parent's date (it must also carry that date), independent cash its own
  // timestamp date. The original source validator still re-checks alignment.
  const trades=new Map(p.trades.map(t=>[t.id,t])),payouts=new Map(p.payouts.map(x=>[x.id,x]));
  const out=[];
  for(const t of p.trades)out.push({kind:'trade',id:t.id,date:t.transactionDate,event:t});
  for(const x of p.payouts)out.push({kind:'payout',id:x.id,date:x.paidOn,event:x});
  for(const c of p.cashEvents){
    const own=c.dateTime.slice(0,10);
    if(c.tradeId!==null){const t=trades.get(c.tradeId);if(!t)fail('LINK_MISSING');if(own!==t.transactionDate)fail('LINK_DATE');out.push({kind:'cash',id:c.id,date:own,linkedTo:'trade|'+t.id,event:c});}
    else if(c.payoutId!==null){const x=payouts.get(c.payoutId);if(!x)fail('LINK_MISSING');if(own!==x.paidOn)fail('LINK_DATE');out.push({kind:'cash',id:c.id,date:own,linkedTo:'payout|'+x.id,event:c});}
    else out.push({kind:'cash',id:c.id,date:own,linkedTo:null,event:c});
  }
  return out;
}

// Official-capability adapter: an injected, read-only function that reports
// what the official source itself proves for an effective date before the New
// York close. Without one the answer is always WAITING. It is never inferred.
export const OFFICIAL_EVIDENCE_ITEMS=Object.freeze(['effectiveDateQueryAccepted','quantitiesForEffectiveDate','cashByCurrencyForEffectiveDate','valuationInstantStated']);

export function createSyncDatePolicyGate({policy=null,readOfficialEvidence=null}={}){
  if(policy!==null){
    exact(policy,['schema','effectiveFromChinaDate'],'CONFIG');
    if(policy.schema!==SYNC_DATE_POLICY_SCHEMA||!(policy.effectiveFromChinaDate===null||isDay(policy.effectiveFromChinaDate)))fail('CONFIG');
  }
  if(readOfficialEvidence!==null&&typeof readOfficialEvidence!=='function')fail('CONFIG');
  const cutover=policy?.effectiveFromChinaDate??null;
  const gate=Object.freeze({
    enabled:cutover!==null,
    appliesTo:d=>cutover!==null&&isDay(d)&&d>=cutover,
    // Returns null when the gate does not apply (disabled, or a target before
    // the cutover); the ordinary v1 path is then unchanged. Otherwise returns
    // the admission or throws one fixed code.
    async check({targetDate,receiptSession,projections,publishedHistory,capturedAt,now}){
      if(cutover===null||targetDate<cutover)return null;
      if(!isDay(targetDate)||!Array.isArray(projections)||projections.length!==3)fail('SCHEMA');
      // Already published: exit before any further work. A sync re-read can
      // re-run validation; it can never turn into a second publication.
      if(!Array.isArray(publishedHistory)||publishedHistory.some(r=>r.through>=targetDate))fail('ALREADY_PUBLISHED');
      const through=publishedHistory.map(r=>r.through).sort()[0];
      exact(receiptSession,['sessions','acceptance']);
      const {sessions,acceptance}=receiptSession;
      if(!Array.isArray(sessions)||!sessions.length)fail('SESSION_MISSING');
      // One closed declaration per China date after the last published date.
      // A day without a sync is declared explicitly; nothing is assumed.
      const want=[];for(let d=addDay(through,1);d<=targetDate;d=addDay(d,1))want.push(d);
      const byDate=new Map();
      for(const s of sessions){
        exact(s,['accountingEffectiveDate','state','sessionStartedAt','closedAt','records']);
        if(!isDay(s.accountingEffectiveDate)||byDate.has(s.accountingEffectiveDate))fail('SESSION_DATE');
        if(s.accountingEffectiveDate<cutover)fail('BEFORE_CUTOVER');
        if(!['synced','no-sync'].includes(s.state)||!Array.isArray(s.records))fail('SCHEMA');
        if(s.state==='synced'){
          if(s.closedAt===null)fail('SESSION_OPEN');
          if(chinaDate(s.sessionStartedAt)!==s.accountingEffectiveDate||instant(s.closedAt)<instant(s.sessionStartedAt))fail('SESSION_DATE');
        }else if(s.records.length||s.sessionStartedAt!==null||s.closedAt!==null)fail('SCHEMA');
        byDate.set(s.accountingEffectiveDate,s);
      }
      if(want.join()!==[...byDate.keys()].sort().join())fail('SESSION_MISSING');
      // Every projected event dated after the published history must be a
      // declared record of its own date's session, exactly once, unchanged.
      const declared=new Map();
      for(const s of byDate.values())for(const r of s.records){
        exact(r,['role','kind','id','enteredAt','businessDate','eventSha256','broker']);
        if(!['ib-manager','schwab','webull'].includes(r.role)||!['trade','payout','cash'].includes(r.kind)||!Number.isSafeInteger(r.id)||r.id<1||!isDay(r.businessDate))fail('SCHEMA');
        if(!r.broker||typeof r.broker!=='object'||!isDay(r.broker.originalDate)||typeof r.broker.reference!=='string'||!r.broker.reference)fail('BROKER_AUDIT_MISSING');
        const entered=chinaDate(r.enteredAt);
        if(instant(r.enteredAt)<instant(s.sessionStartedAt)||instant(r.enteredAt)>instant(s.closedAt))fail('SCHEMA');
        // Same-day continuation keeps the date; after China midnight a new date.
        if(entered!==s.accountingEffectiveDate)fail(r.businessDate===s.accountingEffectiveDate?'AFTER_MIDNIGHT_OLD_DATE':'RECORD_DATE');
        if(r.businessDate!==s.accountingEffectiveDate)fail('RECORD_DATE');
        const key=syncRecordKey(r);if(declared.has(key))fail('ID_CONFLICT');declared.set(key,r);
      }
      const seen=new Set(),linked=new Map();
      projections.forEach((p,i)=>{
        const role=p.identity.role;
        for(const e of businessEvents(p)){
          const key=role+'|'+e.kind+'|'+e.id,r=declared.get(key);
          if(e.date<=through){if(r)fail('BACKFILL_REFUSED');continue;} // old records keep their dates and history digest
          if(!r)fail('UNDECLARED_EVENT');
          if(r.businessDate!==e.date)fail('RECORD_DATE');
          if(r.eventSha256!==eventSha(e.event))fail('ID_CONFLICT');
          seen.add(key);
          if(e.linkedTo){const k=role+'|'+e.linkedTo;linked.set(k,(linked.get(k)||0)+1);}
          // Existing limitation, kept: a non-USD native cash movement has no
          // proved FX/flow contract and stops rather than being converted.
          if(e.kind==='cash'&&e.event.currency!=='USD'&&e.event.amount!==0)fail('NON_USD_MOVEMENT_UNSUPPORTED');
        }
      });
      for(const key of declared.keys())if(!seen.has(key))fail(declared.get(key).businessDate<=through?'BACKFILL_REFUSED':'RECORD_MISSING');
      // A payout has exactly one cash credit. A trade has its cash legs, each
      // counted once as settlement, never as an external flow.
      projections.forEach(p=>{const role=p.identity.role;
        for(const x of p.payouts)if(x.paidOn>through&&linked.get(role+'|payout|'+x.id)!==1)fail(linked.get(role+'|payout|'+x.id)>1?'LINK_DOUBLE_COUNT':'LINK_MISSING');
        for(const t of p.trades)if(t.transactionDate>through&&!linked.get(role+'|trade|'+t.id))fail('LINK_MISSING');
      });
      // Even with no event: every holding quantity and every native currency
      // must match the read-back. A remaining difference pauses; nothing is
      // parked as pending cash or balanced by an invented entry.
      if(!Array.isArray(acceptance)||acceptance.length!==3)fail('ACCEPTANCE_INCOMPLETE');
      projections.forEach(p=>{
        const a=acceptance.find(x=>x&&x.role===p.identity.role);if(!a)fail('ACCEPTANCE_INCOMPLETE');
        exact(a,['role','holdingsSha256','cashByCurrency','differences'],'ACCEPTANCE_INCOMPLETE');
        if(a.holdingsSha256!==hash(p.holdings.map(h=>({id:h.id,instrument:h.instrument,quantity:h.quantity}))))fail('RECONCILIATION_PAUSED');
        const currencies=[...new Set(p.cash.map(c=>c.currency))].sort();
        if(!a.cashByCurrency||typeof a.cashByCurrency!=='object'||Object.keys(a.cashByCurrency).sort().join()!==currencies.join())fail('ACCEPTANCE_INCOMPLETE');
        for(const cur of currencies){
          const native=p.cash.filter(c=>c.currency===cur).map(c=>({id:c.id,nativeBalance:c.nativeBalance}));
          if(a.cashByCurrency[cur]!==hash(native))fail('RECONCILIATION_PAUSED');
        }
        if(!Array.isArray(a.differences)||a.differences.length)fail('RECONCILIATION_PAUSED');
      });
      // Valuation is a separate fact from the accounting date. After China date
      // D has ended and New York has closed D, the dated Sharesight report is the
      // existing valuation basis (its own price instant is not stated by the
      // source, so none is claimed). Before that, only injected official proof
      // could support a valuation, and the writer still refuses that path.
      const nowMs=typeof now==='number'?now:fail('SCHEMA');
      const latest=[...byDate.values()].filter(s=>s.state==='synced').map(s=>s.accountingEffectiveDate).sort().at(-1)??null;
      const base={accountingEffectiveDate:targetDate,lastSyncedEffectiveDate:latest,sourceCapturedAt:typeof capturedAt==='string'?capturedAt:null,
        reportPeriod:{day:targetDate,month:targetDate.slice(0,7)}};
      if(nowMs>=chinaDayEnd(targetDate)&&nowMs>=nyCloseInstant(targetDate))
        return Object.freeze({...base,valuation:Object.freeze({basis:'sharesight-dated-report',valuationDate:targetDate,valuationAsOf:null,priceInstantStated:false})});
      let evidence=null;
      if(readOfficialEvidence){try{evidence=await readOfficialEvidence(Object.freeze({accountingEffectiveDate:targetDate}));}catch{evidence=null;}}
      const missing=OFFICIAL_EVIDENCE_ITEMS.filter(k=>k==='valuationInstantStated'?!(evidence&&typeof evidence[k]==='string'&&Number.isFinite(Date.parse(evidence[k]))&&Date.parse(evidence[k])<=nowMs):evidence?.[k]!==true);
      const waiting=new Error(PREFIX+(missing.length?'WAITING_OFFICIAL_EVIDENCE':'WAITING_WRITER_PRE_CLOSE'));
      errors.set(waiting,missing.length?'WAITING_OFFICIAL_EVIDENCE':'WAITING_WRITER_PRE_CLOSE');
      Object.defineProperty(waiting,'missingEvidence',{value:Object.freeze(missing)});throw Object.freeze(waiting);
    },
  });
  gates.add(gate);return gate;
}
export const isSyncDatePolicyGate=g=>gates.has(g);
