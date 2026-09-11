// Private, read-only source normalization. No API calls, inferred account
// binding, copied HTML coefficients, automatic classification or trading.
import { APPROVED_IB_ACCOUNT_ID, IB_ENDPOINTS, fingerprint, validateSourceEvidence } from './xuan-ib-run-manifest.mjs';
import { getManualConsentRunId, validateManualConsentProof } from './xuan-ib-manual-consent.mjs';
import { showRunJournal } from './xuan-ib-run-clock.mjs';
import { validateAssociationReceipt } from './xuan-ib-account-association.mjs';
import { isWeeklyMode, isWeeklyStage, validateWeeklyEvidence } from './xuan-ib-weekly-snapshot.mjs';
const fail=code=>{throw new Error(`Source adapter: ${code}`);};
const object=value=>value&&Object.getPrototypeOf(value)===Object.prototype;
const num=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e12;
const need=(value,keys)=>{
  if(!object(value)||value.isError===true||value.error||keys.some(key=>!Object.hasOwn(value,key)))fail('INVALID_SOURCE_SHAPE');
  return value;
};
const array=value=>{if(!Array.isArray(value)||value.length>10_000)fail('INVALID_SOURCE_ARRAY');return value;};
const checkAccountIds=raw=>{
  let visited=0;
  const walk=(value,depth=0)=>{
    if(++visited>50_000||depth>20)fail('ACCOUNT_SCAN_LIMIT');
    if(!value||typeof value!=='object')return;
    for(const [key,child] of Object.entries(value)){
      if(['account_id','accountId'].includes(key)&&child!==APPROVED_IB_ACCOUNT_ID)fail('ACCOUNT_SCOPE_MISMATCH');
      if(child&&typeof child==='object')walk(child,depth+1);
    }
  };
  walk(raw);
};
export function unwrapSource(kind,raw){
  switch(kind){
    case 'accountSummary':need(raw,['currency','net_liquidation','total_cash_value']);if(!/^[A-Z]{3}$/.test(raw.currency)||!num(raw.net_liquidation)||!num(raw.total_cash_value))fail('INVALID_SUMMARY');break;
    case 'balances':need(raw,['balances']);array(raw.balances);break;
    case 'positions':need(raw,['positions']);array(raw.positions);break;
    case 'orders':need(raw,['orders']);array(raw.orders);break;
    case 'trades':need(raw,['trades']);array(raw.trades);break;
    case 'sharesight':{
      need(raw,['result']);const result=need(raw.result,['mode','portfolio','data']);
      if(result.mode!=='read_only')fail('NOT_READ_ONLY');
      const portfolio=need(result.portfolio,['id','currency_code']);
      const report=need(need(result.data,['report']).report,['portfolio_id','value','end_date','currency','holdings','cash_accounts']);
      if(!Number.isSafeInteger(portfolio.id)||portfolio.id<=0||portfolio.id!==report.portfolio_id)fail('PORTFOLIO_MISMATCH');
      if(!/^[A-Z]{3}$/.test(portfolio.currency_code)||!num(report.value)||report.currency?.code!==portfolio.currency_code)fail('CURRENCY_OR_VALUE_MISMATCH');
      array(report.holdings);array(report.cash_accounts);break;
    }
    default:fail('UNKNOWN_SOURCE');
  }
  return raw;
}
// Return native values only. Do not silently assume USD, infer venues/aliases,
// invent a quote source or implement a new FX/asset-classification policy.
// `daily_pnl` is preserved when the payload carries it because it is part of
// the same authoritative positions read; it is passed through unchanged and is
// never itself a displayed change. Absent/unusable stays null, not zero.
// The identifier this source publishes for the instrument itself, preserved
// verbatim. It is the whole point of the reviewed venue-identity registry: a
// contract id is what the payload actually asserts about the instrument, while
// a venue label is something the payload often omits entirely (IB publishes no
// exchange for most US listings). Carrying it through means downstream identity
// resolution can look the instrument up directly instead of needing something
// upstream to have already decided which exchange string to attach.
const contractIdentity=position=>{
  if(!Object.hasOwn(position,'contract_id')||position.contract_id===null)return null;
  const value=position.contract_id;
  const usable=(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)
    ||(typeof value==='string'&&/^\d{1,18}$/.test(value));
  // A malformed identifier is refused rather than dropped: silently continuing
  // without it would resolve the row by venue guesswork and look identical to a
  // payload that never carried one.
  if(!usable)fail('INVALID_POSITION_CONTRACT_ID');
  return String(value);
};
export function normalizePositions(raw){
  return unwrapSource('positions',raw).positions.map(position=>{
    need(position,['contract_description','position','market_price','market_value','currency']);
    if(typeof position.contract_description!=='string'||!position.contract_description.trim()
      || !/^[A-Z]{3}$/.test(position.currency)||![position.position,position.market_price,position.market_value].every(num))fail('INVALID_POSITION');
    const carriesDailyPnl=Object.hasOwn(position,'daily_pnl')&&position.daily_pnl!==null;
    if(carriesDailyPnl&&!num(position.daily_pnl))fail('INVALID_POSITION_DAILY_PNL');
    return {description:position.contract_description,quantity:position.position,price:position.market_price,
      marketValueNative:position.market_value,currency:position.currency,contractId:contractIdentity(position),
      dailyPnlNative:carriesDailyPnl?position.daily_pnl:null,changePct:null,quoteStatus:'unavailable'};
  });
}
// Two measurement sources for the daily-change column. Both only NORMALIZE:
// they emit measurement rows for `scripts/xuan-ib-daily-change.mjs`, which
// owns every publish/suppress decision. Neither judges a row here, so a guard
// can never be bypassed by the order in which rows are masked.
//
// A venue's session phase is never inferred from an edition or a clock offset:
// the caller passes the venues whose session for that date is provably still
// running (`venuesOpen`) and those whose session is provably finished
// (`venuesComplete`), because the upstream book rolls its session per
// instrument and per venue, and a schedule pinned to a fixed UTC offset drifts
// against a venue's own daylight-saving rule. A venue listed in both, or in
// neither, has no usable evidence: it stays unproven and is dropped downstream.
const sessionPhase=(venue,open,complete)=>{
  const running=Array.isArray(open)&&open.includes(venue),finished=Array.isArray(complete)&&complete.includes(venue);
  return running===finished?null:running?'open':'complete';
};

// An intraday reading is only usable when the payload's own mark, share count
// and market value agree: `price * quantity` must reproduce `marketValueNative`
// to within its published rounding. A contract carrying a multiplier (an
// option, a future) never reconciles, so no multiplier is ever assumed, and a
// mark the payload carried forward beside a fresh value is caught rather than
// turned into a percentage. The tolerance covers cent rounding only.
// The strong identity a measurement row carries to the daily-change builder,
// taken verbatim from the normalized position and never re-derived here. A row
// whose payload published no contract id says so with `null`; that is the only
// case in which downstream resolution falls back to the venue+code key.
const positionIdentity=position=>({identitySource:'ib',
  identityValue:typeof position.contractId==='string'&&position.contractId?position.contractId:null});

const markReconciled=position=>{
  if(!num(position.price)||!num(position.quantity)||!num(position.marketValueNative))return false;
  const implied=position.price*position.quantity;
  return num(implied)&&Math.abs(implied-position.marketValueNative)<=Math.max(0.01,Math.abs(position.marketValueNative)*1e-6);
};

// (A) Session profit and loss carried inside the same positions payload:
//   base = marketValueNative - dailyPnlNative
// is the identical share count valued at the close that P&L is measured from,
// and the ratio stays inside one currency, so no FX or venue policy is
// implied. Absent or unusable inputs produce a null measurement, never a zero.
// `observedAtHkt` is the minute the payload was read, passed through verbatim:
// a reading taken while the session runs is only meaningful with the instant
// it belongs to, and two readings inside one session must never be reconciled.
export function measurePositionSessionChange(position,{venue=null,code=null,sessionDate=null,venuesOpen=[],venuesComplete=[],observedAtHkt=null}={}){
  if(!object(position)||!Object.hasOwn(position,'dailyPnlNative')||!Object.hasOwn(position,'marketValueNative'))fail('INVALID_DAILY_CHANGE_INPUT');
  const row={method:'session-pnl-v1',code,venue,...positionIdentity(position),changePct:null,currencyChangePct:null,sessionDate,
    sessionPhase:sessionPhase(venue,venuesOpen,venuesComplete),observedAtHkt,markReconciled:markReconciled(position)};
  if(position.dailyPnlNative===null)return row;
  if(!num(position.dailyPnlNative)||!num(position.marketValueNative))fail('INVALID_DAILY_CHANGE_INPUT');
  const base=position.marketValueNative-position.dailyPnlNative;
  if(!num(base)||base<=0)return row;
  const changePct=position.dailyPnlNative/base*100;
  if(!Number.isFinite(changePct))return row;
  return {...row,changePct};
}

// (A2) The SAME positions payload, read after the session it reports has
// already closed. This is a separate method from (A), not the same reading
// under another edition's name: it requires the venue's session to be proven
// FINISHED rather than merely running, and its `observedAtHkt` belongs to the
// report's own Hong Kong date rather than to the session date, because an 08:00
// HKT run reads the previous New York session hours after its close. It exists
// only to fill a row the portfolio source's single-day window never returned —
// a position that is live in the broker's book before that source has synced
// it. It never overrides a window reading, and (A) is left exactly as it was.
export function measurePositionCompletedSessionChange(position,{venue=null,code=null,sessionDate=null,venuesComplete=[],observedAtHkt=null}={}){
  if(!object(position)||!Object.hasOwn(position,'dailyPnlNative')||!Object.hasOwn(position,'marketValueNative'))fail('INVALID_DAILY_CHANGE_INPUT');
  const row={method:'am-session-pnl-v1',code,venue,...positionIdentity(position),changePct:null,currencyChangePct:null,sessionDate,
    sessionPhase:sessionPhase(venue,[],venuesComplete),observedAtHkt,markReconciled:markReconciled(position)};
  if(position.dailyPnlNative===null)return row;
  if(!num(position.dailyPnlNative)||!num(position.marketValueNative))fail('INVALID_DAILY_CHANGE_INPUT');
  const base=position.marketValueNative-position.dailyPnlNative;
  if(!num(base)||base<=0)return row;
  const changePct=position.dailyPnlNative/base*100;
  if(!Number.isFinite(changePct))return row;
  return {...row,changePct};
}

// (B) A single-session performance window from the portfolio source. One call
// returns every holding's own dated move, with the price move and any currency
// move already separated by that source, so nothing is derived or cross-sourced.
// The row set is emitted verbatim; suppression happens downstream.
export function normalizeDailyChangeWindow(raw,{date=null,venuesComplete=[]}={}){
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))fail('INVALID_DAILY_CHANGE_WINDOW');
  if(!Array.isArray(venuesComplete))fail('INVALID_DAILY_CHANGE_WINDOW');
  const report=unwrapSource('sharesight',raw).result.data.report;
  // !! The window is INCLUSIVE of start_date: 2026-09-08..2026-09-09 returned
  // a TWO-session move (+5.99% on one row) where 09-09 alone was +6.55%. A
  // daily column therefore requires start_date === end_date === the reported
  // date, or it silently prints a multi-session move under a one-day label.
  if(report.start_date!==date||report.end_date!==date)fail('DAILY_CHANGE_WINDOW_NOT_SINGLE_DAY');
  // Full-history reports annualise their percentages; a daily column must not.
  if(report.percentages_annualised!==false)fail('DAILY_CHANGE_WINDOW_ANNUALISED');
  // Rows are normalized, never rejected here: one malformed row must not be
  // able to destroy a column that is otherwise fully evidenced. The builder
  // marks such a row unavailable and counts it.
  return array(report.holdings).map(holding=>{
    const instrument=object(holding)?holding.instrument:null;
    const venue=object(instrument)&&typeof instrument.market_code==='string'?instrument.market_code:null;
    const code=object(instrument)&&typeof instrument.code==='string'?instrument.code:null;
    const usable=object(holding)&&num(holding.capital_gain_percent);
    const instrumentId=object(instrument)&&Number.isSafeInteger(instrument.id)&&instrument.id>0?instrument.id:null;
    return {method:'window-v1',code,venue,
      instrumentId,
      // The same strong identity the IB side carries, under one shared pair of
      // field names so the builder never has to know which book a row came from
      // in order to look its instrument up. The value is the source's own
      // `instrument.id`, stringified and otherwise untouched.
      identitySource:'sharesight',identityValue:instrumentId===null?null:String(instrumentId),
      changePct:usable?holding.capital_gain_percent:null,
      currencyChangePct:usable&&num(holding.currency_gain_percent)?holding.currency_gain_percent:null,
      // A completed-session window has no observation instant to publish: it is
      // labelled with the session it measures, not with the moment it was read.
      sessionDate:date,sessionPhase:sessionPhase(venue,[],venuesComplete),observedAtHkt:null};
  });
}
export function sourceRecordFromRaw(raw,receipt){
  need(receipt,['status','startedAt','completedAt','retries','rawFingerprint']);
  const instant=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
  if(receipt.status!=='ok'||!instant(receipt.startedAt)||!instant(receipt.completedAt)
    ||Date.parse(receipt.completedAt)<Date.parse(receipt.startedAt)||!Number.isInteger(receipt.retries)||receipt.retries<0||receipt.retries>5)fail('INVALID_READ_RECEIPT');
  if(receipt.rawFingerprint!==fingerprint(raw))fail('RAW_CHANGED_SINCE_CAPTURE');
  // Whole raw response, not hand-transcribed totals/report subsection. The
  // caller must capture the hash at receipt time. This is not a signature or
  // independent attestation that a caller really executed a connector call.
  return {status:'ok',asOf:receipt.completedAt,retries:receipt.retries,fingerprint:fingerprint(raw)};
}
function failedPositionAttempt(raw,receipt){
  // An actual upstream error is an attempted read, never usable positions.
  // Missing/malformed successful payloads cannot silently select a fallback.
  if(!object(raw)||(raw.isError!==true&&!raw.error))fail('POSITION_FAILURE_EVIDENCE_REQUIRED');
  need(receipt,['status','startedAt','completedAt','retries','rawFingerprint','errorCode']);
  if(!['failed','unavailable'].includes(receipt.status)||typeof receipt.errorCode!=='string'
    ||!/^([A-Z][A-Z0-9_]{0,63})$/.test(receipt.errorCode))fail('INVALID_POSITION_FAILURE');
  // Reuse the exact raw-hash and interval checks without converting the
  // failed response into a successful source record.
  sourceRecordFromRaw(raw,{...receipt,status:'ok'});
  return {status:receipt.status,asOf:null,retries:receipt.retries,fingerprint:null,
    errorCode:receipt.errorCode,readStartedAt:receipt.startedAt,attemptCompletedAt:receipt.completedAt};
}
export function buildSourceEvidence(input,registry,{
  manualConsentProof=null,associationReceipt=null,associationSnapshot=null,journalPath=null,now=Date.now()
}={}){
  need(input,['ib','sharesight','edition','dataDate','previousSourceSha']);
  const weekly=isWeeklyMode(input);
  if(weekly){
    if(array(input.sharesight).length)fail('WEEKLY_CANNOT_INCLUDE_LIVE_SHARESIGHT');
    validateWeeklyEvidence(input.sharesightWeekly,registry,now);
  }
  const summary=unwrapSource('accountSummary',input.ib?.accountSummary?.raw);
  const native=Object.hasOwn(summary,'account_id');
  const association=associationReceipt!==null||associationSnapshot!==null;
  const positionsFailed=association&&['failed','unavailable'].includes(input.ib?.positions?.status);
  if(weekly&&positionsFailed)fail('WEEKLY_CANNOT_REPLACE_LIVE_POSITIONS');
  // A present bad/null ID always wins over a manual claim. No raw mutation.
  if(native&&summary.account_id!==APPROVED_IB_ACCOUNT_ID)fail('ACCOUNT_SCOPE_UNPROVEN');
  if(association&&manualConsentProof!==null)fail('MIXED_ACCOUNT_SCOPE_EVIDENCE');
  if(native&&manualConsentProof!==null)fail('MANUAL_EVIDENCE_WITH_NATIVE_ID');
  if(native&&association)fail('ASSOCIATION_EVIDENCE_WITH_NATIVE_ID');
  if(!native&&!manualConsentProof&&!association)fail('ACCOUNT_SCOPE_UNPROVEN');
  let runId,ibStage,sharesightStage;
  if(!native){
    if(!journalPath)fail(association?'ASSOCIATION_JOURNAL_REQUIRED':'MANUAL_JOURNAL_REQUIRED');
    const journal=showRunJournal(journalPath);
    runId=getManualConsentRunId(journalPath);
    ibStage=journal.stages.find(stage=>stage.name==='ib-read');
    if(association){
      if(!associationReceipt||!associationSnapshot)fail('ASSOCIATION_RECEIPT_AND_TRUSTED_POLICY_REQUIRED');
      validateAssociationReceipt(associationReceipt,associationSnapshot,{
        runId,previousSourceSha:input.previousSourceSha,edition:input.edition,now
      });
      const bootstrap=journal.stages.find(stage=>stage.name==='bootstrap');
      sharesightStage=journal.stages.find(stage=>stage.name==='sharesight-read');
      if(!bootstrap||bootstrap.status!=='ok')fail('ASSOCIATION_BOOTSTRAP_INCOMPLETE');
      const ibStatusAllowed=positionsFailed?ibStage?.status==='degraded'&&ibStage.errorCode==='IB_POSITIONS_FALLBACK':ibStage?.status==='ok';
      if(!ibStatusAllowed||!sharesightStage||(weekly?!isWeeklyStage(sharesightStage):sharesightStage.status!=='ok'))fail('ASSOCIATION_READ_STAGE_INCOMPLETE');
      const checked=Date.parse(associationReceipt.policyCheckedAt);
      if(checked<Date.parse(journal.timing.startedAt)||checked<Date.parse(bootstrap.endedAt)
        ||checked>=Date.parse(ibStage.startedAt)||(!weekly&&checked>=Date.parse(sharesightStage.startedAt)))fail('ASSOCIATION_NOT_BEFORE_FINANCIAL_READS');
    }else{
      validateManualConsentProof(manualConsentProof,{journalRunId:runId,previousSourceSha:input.previousSourceSha,edition:input.edition,requireUnexpired:true,now});
      if(!ibStage||ibStage.status!=='ok')fail('MANUAL_IB_STAGE_INCOMPLETE');
    }
  }
  // accountId is the existing internal expected scope, not a new raw API field.
  // The explicit basis distinguishes owner attestation from native identity.
  const ib={accountId:native?summary.account_id:APPROVED_IB_ACCOUNT_ID,accountScopeConfirmed:true,
    ...(!native?(association?{accountScopeBasis:'owner-attested-recurring-v1',accountAssociation:associationReceipt}
      :{accountScopeBasis:'manual-consent-once-v1',manualConsent:manualConsentProof}):{})};
  for(const endpoint of IB_ENDPOINTS){
    const receipt=need(input.ib[endpoint],['raw']);
    const failure=positionsFailed&&endpoint==='positions';
    const raw=failure?receipt.raw:unwrapSource(endpoint,receipt.raw);
    if(Object.hasOwn(raw,'account_id')&&raw.account_id!==APPROVED_IB_ACCOUNT_ID)fail('ACCOUNT_SCOPE_MISMATCH');
    // A nested ID may reveal a contradiction, never establish a native scope.
    // Null and empty visible identifiers also fail instead of being ignored.
    checkAccountIds(raw);
    ib[endpoint]=failure?failedPositionAttempt(raw,receipt):sourceRecordFromRaw(raw,receipt);
    if(!native){
      const start=Date.parse(receipt.startedAt),end=Date.parse(receipt.completedAt);
      if(start<Date.parse(ibStage.startedAt)||end>Date.parse(ibStage.endedAt)||end>now)fail(association?'ASSOCIATION_READ_OUTSIDE_JOURNAL':'MANUAL_READ_OUTSIDE_JOURNAL');
      ib[endpoint].readStartedAt=receipt.startedAt;
    }
  }
  const sharesight=array(input.sharesight).map(receipt=>{
    const raw=unwrapSource('sharesight',receipt.raw),id=raw.result.portfolio.id;
    const registered=registry.portfolios.find(item=>item.portfolioId===id&&item.requiredEachReport);
    if(!registered)fail('UNEXPECTED_PORTFOLIO');
    const source={portfolioId:id,role:registered.role,...sourceRecordFromRaw(raw,receipt)};
    if(association){
      if(Date.parse(receipt.startedAt)<Date.parse(sharesightStage.startedAt)
        ||Date.parse(receipt.completedAt)>Date.parse(sharesightStage.endedAt)
        ||Date.parse(receipt.completedAt)>now)fail('ASSOCIATION_SHARESIGHT_READ_OUTSIDE_JOURNAL');
      source.readStartedAt=receipt.startedAt;
      if(Object.hasOwn(receipt,'completedUsTradingDayLag')){
        if(id!==936247||!Number.isInteger(receipt.completedUsTradingDayLag)||receipt.completedUsTradingDayLag<0||receipt.completedUsTradingDayLag>30)fail('INVALID_POSITION_FALLBACK_LAG');
        source.completedUsTradingDayLag=receipt.completedUsTradingDayLag;
      }
    }
    return source;
  });
  const sources={ib,sharesight,...(weekly?{sharesightWeekly:input.sharesightWeekly}:{})};validateSourceEvidence(sources,registry,{
    edition:input.edition,previousSourceSha:input.previousSourceSha,runId,
    now,
    ...(association?{associationSnapshot,now}:{})
  });
  if(positionsFailed){
    const fallback=sharesight.find(source=>source.portfolioId===936247);
    if(!fallback||fallback.status!=='ok'||!Number.isInteger(fallback.completedUsTradingDayLag)
      ||fallback.completedUsTradingDayLag>1)fail('POSITION_FALLBACK_NOT_FRESH');
  }
  return {schemaVersion:1,edition:input.edition,dataDate:input.dataDate,previousSourceSha:input.previousSourceSha,sources};
}
