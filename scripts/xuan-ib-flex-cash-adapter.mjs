import {APPROVED_IB_ACCOUNT_ID} from './xuan-ib-run-manifest.mjs';
// Pure projection of the Sep-08 existing cash producer's scrubbed dictionary.
// This is NOT a network client or proof of the currently deployed contract.
import {sourceHash} from './xuan-ib-night-action-evidence.mjs';
const fail=code=>{throw new Error(`Flex cash adapter: ${code}`);};
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)).toISOString()===v;
const decimal=v=>typeof v==='string'&&/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v)&&Number.isFinite(Number(v))&&Math.abs(Number(v))<=1e12;
const scan=value=>{let count=0;const walk=(v,depth=0)=>{if(++count>50000||depth>20)fail('SCAN_LIMIT');if(!v||typeof v!=='object')return;for(const [key,child]of Object.entries(v)){if(['accountid','accountnumber','accountalias','acctalias','acctid','sourceaccountid'].includes(key.toLowerCase().replaceAll('_',''))||key.startsWith('_'))fail('UNSCRUBBED_PRIVATE_FIELD');if(child&&typeof child==='object')walk(child,depth+1);}};walk(value);};
export function adaptFlexCashReport(envelope,{sourceDate,now,association,verifyProof}={}) {
  if(!envelope||Object.keys(envelope).sort().join('|')!=='capture|proof|report'||typeof verifyProof!=='function')fail('INDEPENDENT_PROOF_REQUIRED');
  const r=envelope.report,c=envelope.capture;
  scan(r);
  if(r?.schema_version!==1||r.source!=='IBKR Flex Web Service'||String(r.query_id)!=='1630084'||r.query_name!=='IB_Cash_Reconciliation_ReadOnly'
    ||r.period!=='Last30CalendarDays'||r.base_currency!=='USD'||r.base_currency_provenance!=='uniform_conversion_rate_target'
    ||!date(r.from_date)||!date(r.to_date)||r.from_date>r.to_date||r.to_date!==sourceDate||!hash(r.report_sha256)||!hash(r.report_content_sha256)
    ||!Number.isSafeInteger(r.raw_size)||r.raw_size<=0||r.transport_verified!==true||r.query_id_provenance!=='fixed_service_request_and_query_name'
    ||r.archive?.status!=='VERIFIED'||r.archive.public_access!==false||r.archive.object_key!==`reports/${r.report_sha256}.xml`
    ||typeof r.generated_at!=='string'||!/^\d{4}-\d{2}-\d{2};\d{2}:\d{2}:\d{2}$/.test(r.generated_at)||r.generation_timezone!==null||!date(r.generated_at.slice(0,10))||Number(r.generated_at.slice(11,13))>23||Number(r.generated_at.slice(14,16))>59||Number(r.generated_at.slice(17,19))>59)fail('REPORT_SCOPE');
  if(!c||Object.keys(c).sort().join('|')!=='completedAt|startedAt'||!time(c.startedAt)||!time(c.completedAt)||Date.parse(c.completedAt)<Date.parse(c.startedAt)
    ||Date.parse(c.completedAt)>now||now-Date.parse(c.startedAt)>1800000||Date.parse(c.completedAt)-Date.parse(c.startedAt)>300000)fail('CAPTURE_FRESHNESS');
  if(!Array.isArray(r.cash_reports)||r.cash_reports.length<2||r.cash_reports.length>100)fail('CASH_ROWS');
  const seen=new Set();let base;
  for(const row of r.cash_reports){
    if(seen.has(row?.currency)||!(row.currency==='BASE_SUMMARY'||/^[A-Z]{3}$/.test(row.currency))||row.fromDate!==r.from_date||row.toDate!==r.to_date
      ||row.levelOfDetail!==(row.currency==='BASE_SUMMARY'?'BaseCurrency':'Currency')||row.level_of_detail!==row.levelOfDetail
      ||!decimal(row.endingCash)||!decimal(row.endingSettledCash))fail('CASH_ROW_SCOPE');
    seen.add(row.currency);if(row.currency==='BASE_SUMMARY')base=row;
  }
  if(!base||Number(base.endingCash)<0||Number(base.endingSettledCash)<0)fail('BASE_CASH_REQUIRED');
  const integrity=r.source_integrity;
  if(!integrity||integrity.tolerance!=='0.01'||!Array.isArray(integrity.unknown_event_types_pending)||integrity.unknown_event_types_pending.length
    ||!Array.isArray(integrity.cash_categories_without_detail_mapping)||integrity.cash_categories_without_detail_mapping.length)fail('INTEGRITY_PENDING');
  for(const field of ['cash_identities','event_aggregates','base_closing_translations']){
    if(!Array.isArray(integrity[field])||!integrity[field].length||integrity[field].some(row=>!decimal(row.residual)||Math.abs(Number(row.residual))>0.01))fail('INTEGRITY_RESIDUAL');
  }
  if(['endingCash','endingSettledCash'].some(field=>integrity.base_closing_translations.filter(row=>row.cash_field===field).length!==1)
    ||r.cash_reports.some(row=>integrity.cash_identities.filter(identity=>identity.currency===row.currency&&identity.segment==='total').length!==1))fail('INTEGRITY_COVERAGE');
  // Public scrub removed account identity from the canonical content. Do NOT
  // recompute report_content_sha256 from this dictionary. The trusted injected
  // verifier must authenticate archive XML hash, private-account binding,
  // original content hash, this exact scrubbed payload and capture receipt.
  const expected={scrubbedPayloadHash:sourceHash(r),reportSha256:r.report_sha256,reportContentSha256:r.report_content_sha256,
    archiveObject:r.archive.object_key,accountAlias:'IB-HK',expectedAccountId:APPROVED_IB_ACCOUNT_ID,policyBlob:association?.policyBlob,captureHash:sourceHash(c),sourceDate};
  if(verifyProof(envelope.proof,expected)!==true)fail('PROOF_INVALID');
  return {amount:Number(base.endingCash),settledAmount:Number(base.endingSettledCash),currency:'USD',basis:'ending-cash-base-currency',
    coverageFrom:r.from_date,coverageDate:r.to_date,acquiredAt:c.completedAt,generatedAt:r.generated_at,generationTimezone:null};
}
