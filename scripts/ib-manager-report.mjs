// Normal writer hand-off. No CLI, key discovery, encryption or publication.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SharesightIbManagerReader,ibSourceFailureCode,IB_BASELINE_WINDOW} from './ib-manager-source.mjs';
import {buildIbManagerReportBundle,validateIbManagerReportState,createIbManagerReturnConsumer} from './ib-manager-return.mjs';
import {validateFeeCalculationReceipt} from './fee-receipt-core.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const refused=()=>{throw Error('IB_REPORT_INPUT_REFUSED');};
const outside=p=>{const r=path.relative(ROOT,p);return r==='..'||r.startsWith('..'+path.sep);};
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
const fields=['ibManagerReturnReceipt','ibManagerDrawdownReceipt','ibManagerSourceState','ibManagerSourceStatus'];
export function sameIbManagerData(a,b){const c=createIbManagerReturnConsumer().canonical;return fields.every(k=>c(a[k]??null)===c(b[k]??null));}

export async function prepareIbManagerReport({payload,targetDate,outputDir,environ=process.env,reader}={}){
  if(environ.IB_MANAGER_READ_ENABLED!=='true')return null;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(targetDate||''))refused();
  const dir=fs.realpathSync(outputDir),stat=fs.statSync(dir);
  if(!outside(dir)||!stat.isDirectory()||(stat.mode&0o077)!==0)refused();
  const expectedBaselineHash=environ.IB_MANAGER_BASELINE_SHA256;
  let request;
  try{
    // Later source coverage is not attested while a reported noncash migration
    // is unfinished. A stable but stale Sharesight portfolio is not completeness
    // evidence. This hold is independent of the two-account fee report.
    if(targetDate>IB_BASELINE_WINDOW.asOf)throw Error('IB_SOURCE_COVERAGE_UNVERIFIED');
    if(!/^[a-f0-9]{64}$/.test(expectedBaselineHash||''))throw Error('IB_SOURCE_BASELINE_LOCK');
    const checkpoint=await validateIbManagerReportState(payload,expectedBaselineHash);
    const source=await (reader||new SharesightIbManagerReader({clientId:environ.FEE_CLOUD_SHARESIGHT_CLIENT_ID,clientSecret:environ.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET})).readStable({targetDate,expectedBaselineHash,checkpoint});
    await buildIbManagerReportBundle(source,expectedBaselineHash);
    request={state:'verified',source};
  }catch(error){
    const fixed=['IB_SOURCE_BASELINE_LOCK','IB_SOURCE_STATE_INVALID','IB_SOURCE_COVERAGE_UNVERIFIED'];
    request={state:'pending',reasonCode:fixed.includes(error?.message)?error.message:ibSourceFailureCode(error)};
  }
  const file=path.join(dir,'ib-manager-input.json');
  fs.writeFileSync(file,JSON.stringify({schema:'fee-console.ib-manager-report-request.v1',targetDate,...request}),{mode:0o600,flag:'wx'});
  return {file,state:request.state,...(request.reasonCode?{reasonCode:request.reasonCode}:{})};
}

export async function loadIbManagerReport(file,{environ=process.env}={}){
  if(environ.IB_MANAGER_READ_ENABLED!=='true'||!path.isAbsolute(file)||fs.lstatSync(file).isSymbolicLink())refused();
  const real=fs.realpathSync(file),st=fs.statSync(real);
  if(!outside(real)||!st.isFile()||(st.mode&0o077)!==0||st.size<1||st.size>5*1024*1024)refused();
  const bytes=fs.readFileSync(real),request=JSON.parse(bytes);
  const checkCurrent=()=>{if(fs.lstatSync(file).isSymbolicLink()||fs.realpathSync(file)!==real||!fs.readFileSync(real).equals(bytes)||(fs.statSync(real).mode&0o077)!==0)refused();};
  checkCurrent();
  if(request.schema!=='fee-console.ib-manager-report-request.v1'||!/^\d{4}-\d{2}-\d{2}$/.test(request.targetDate||''))refused();
  let bundle=null;
  if(request.state==='verified'){
    if(!exact(request,['schema','targetDate','state','source']))refused();
    try{bundle=await buildIbManagerReportBundle(request.source,environ.IB_MANAGER_BASELINE_SHA256);}catch{refused();}
    if(bundle.returnReceipt.asOf!==request.targetDate)refused();
  }else if(request.state!=='pending'||!exact(request,['schema','targetDate','state','reasonCode'])||!/^IB_SOURCE_[A-Z_]{1,48}$/.test(request.reasonCode||''))refused();
  return {checkCurrent,apply(data,targetDate){
    checkCurrent();if(request.targetDate!==targetDate)refused();
    const fee=data.feeCalculationReceipt;
    // Independent failure never changes the original fee calculation or ledger.
    const matched=bundle&&validateFeeCalculationReceipt(fee,data).ok&&bundle.returnReceipt.start===fee.start&&bundle.returnReceipt.asOf===fee.asOf;
    const out={...data,ibManagerSourceStatus:{state:matched?'verified':'pending',targetDate,...(!matched?{reasonCode:bundle?'IB_SOURCE_PERIOD_MISMATCH':request.reasonCode}:{})}};
    if(matched)Object.assign(out,{ibManagerReturnReceipt:bundle.returnReceipt,ibManagerDrawdownReceipt:bundle.drawdownReceipt,ibManagerSourceState:bundle.sourceState});
    return out;
  }};
}
