// Private, read-only source normalization. No API calls, inferred account
// binding, copied HTML coefficients, automatic classification or trading.
import { APPROVED_IB_ACCOUNT_ID, IB_ENDPOINTS, fingerprint, validateSourceEvidence } from './xuan-ib-run-manifest.mjs';
import { getManualConsentRunId, validateManualConsentProof } from './xuan-ib-manual-consent.mjs';
import { showRunJournal } from './xuan-ib-run-clock.mjs';
const fail=code=>{throw new Error(`Source adapter: ${code}`);};
const object=value=>value&&Object.getPrototypeOf(value)===Object.prototype;
const num=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e12;
const need=(value,keys)=>{
  if(!object(value)||value.isError===true||value.error||keys.some(key=>!Object.hasOwn(value,key)))fail('INVALID_SOURCE_SHAPE');
  return value;
};
const array=value=>{if(!Array.isArray(value)||value.length>10_000)fail('INVALID_SOURCE_ARRAY');return value;};
const checkManualAccountIds=raw=>{
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
// manufacture daily changes or implement a new FX/asset-classification policy.
export function normalizePositions(raw){
  return unwrapSource('positions',raw).positions.map(position=>{
    need(position,['contract_description','position','market_price','market_value','currency']);
    if(typeof position.contract_description!=='string'||!position.contract_description.trim()
      || !/^[A-Z]{3}$/.test(position.currency)||![position.position,position.market_price,position.market_value].every(num))fail('INVALID_POSITION');
    return {description:position.contract_description,quantity:position.position,price:position.market_price,
      marketValueNative:position.market_value,currency:position.currency,changePct:null,quoteStatus:'unavailable'};
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
export function buildSourceEvidence(input,registry,{manualConsentProof=null,journalPath=null,now=Date.now()}={}){
  need(input,['ib','sharesight','edition','dataDate','previousSourceSha']);
  const summary=unwrapSource('accountSummary',input.ib?.accountSummary?.raw);
  const native=Object.hasOwn(summary,'account_id');
  // A present bad/null ID always wins over a manual claim. No raw mutation.
  if(native&&summary.account_id!==APPROVED_IB_ACCOUNT_ID)fail('ACCOUNT_SCOPE_UNPROVEN');
  if(native&&manualConsentProof!==null)fail('MANUAL_EVIDENCE_WITH_NATIVE_ID');
  if(!native&&!manualConsentProof)fail('ACCOUNT_SCOPE_UNPROVEN');
  let runId,ibStage;
  if(!native){
    if(!journalPath)fail('MANUAL_JOURNAL_REQUIRED');
    const journal=showRunJournal(journalPath);
    runId=getManualConsentRunId(journalPath);
    validateManualConsentProof(manualConsentProof,{journalRunId:runId,previousSourceSha:input.previousSourceSha,edition:input.edition,requireUnexpired:true,now});
    ibStage=journal.stages.find(stage=>stage.name==='ib-read');
    if(!ibStage||ibStage.status!=='ok')fail('MANUAL_IB_STAGE_INCOMPLETE');
  }
  const ib={accountId:native?summary.account_id:APPROVED_IB_ACCOUNT_ID,accountScopeConfirmed:true,
    ...(!native?{accountScopeBasis:'manual-consent-once-v1',manualConsent:manualConsentProof}:{})};
  for(const endpoint of IB_ENDPOINTS){
    const receipt=need(input.ib[endpoint],['raw']);const raw=unwrapSource(endpoint,receipt.raw);
    if(Object.hasOwn(raw,'account_id')&&raw.account_id!==APPROVED_IB_ACCOUNT_ID)fail('ACCOUNT_SCOPE_MISMATCH');
    if(!native)checkManualAccountIds(raw);
    ib[endpoint]=sourceRecordFromRaw(raw,receipt);
    if(!native){
      const start=Date.parse(receipt.startedAt),end=Date.parse(receipt.completedAt);
      if(start<Date.parse(ibStage.startedAt)||end>Date.parse(ibStage.endedAt)||end>now)fail('MANUAL_READ_OUTSIDE_JOURNAL');
      ib[endpoint].readStartedAt=receipt.startedAt;
    }
  }
  const sharesight=array(input.sharesight).map(receipt=>{
    const raw=unwrapSource('sharesight',receipt.raw),id=raw.result.portfolio.id;
    const registered=registry.portfolios.find(item=>item.portfolioId===id&&item.requiredEachReport);
    if(!registered)fail('UNEXPECTED_PORTFOLIO');
    return {portfolioId:id,role:registered.role,...sourceRecordFromRaw(raw,receipt)};
  });
  const sources={ib,sharesight};validateSourceEvidence(sources,registry,{edition:input.edition,previousSourceSha:input.previousSourceSha,runId});
  return {schemaVersion:1,edition:input.edition,dataDate:input.dataDate,previousSourceSha:input.previousSourceSha,sources};
}
