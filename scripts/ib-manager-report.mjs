// Normal writer hand-off. No CLI, key discovery, encryption or publication.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SharesightIbManagerReader,ibSourceFailureCode,IB_BASELINE_WINDOW,validateIbBootstrapCoverage,validateIbManagerReportInput} from './ib-manager-source.mjs';
import {buildIbManagerReportBundle,validateIbManagerReportState,validateIbOwnerBaselineState,createIbManagerReturnConsumer,createIbManagerDrawdownConsumer} from './ib-manager-return.mjs';
import {validateFeeCalculationReceipt} from './fee-receipt-core.mjs';
import {isCalendarDate,inclusiveDays} from './fee-engine.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const refused=()=>{throw Error('IB_REPORT_INPUT_REFUSED');};
const outside=p=>{const r=path.relative(ROOT,p);return r==='..'||r.startsWith('..'+path.sep);};
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
const fields=['ibManagerReturnReceipt','ibManagerDrawdownReceipt','ibManagerSourceState','ibManagerSourceStatus','ibManagerBaselineState','ibManagerCoverageState'];
export function sameIbManagerData(a,b){const c=createIbManagerReturnConsumer().canonical;return fields.every(k=>c(a[k]??null)===c(b[k]??null));}

// Production publication includes Jenny's independent module. Missing activation
// must fail before source IO, never silently retain a previous report's cutoff.
export function assertIbManagerConfiguration(environ=process.env){
  if(environ.IB_MANAGER_READ_ENABLED!=='true')throw Error('FEE_CLOUD_IB_CONFIG');
  if(!/^[a-f0-9]{64}$/.test(environ.IB_MANAGER_BASELINE_SHA256||''))throw Error('FEE_CLOUD_IB_BASELINE_LOCK');
}
export async function assertIbManagerPublication(payload,targetDate,environ=process.env){
  assertIbManagerConfiguration(environ);
  const status=payload?.ibManagerSourceStatus,fee=payload?.feeCalculationReceipt;
  if(fee?.asOf!==targetDate)
    throw Error('FEE_CLOUD_IB_INCOMPLETE');
  try{
    if(!validateFeeCalculationReceipt(fee,payload).ok)throw Error();
    const core=createIbManagerReturnConsumer();
    if(payload.ibManagerReturnReceipt?.schema===core.dailySchema){
      const source=await validateIbManagerReportState(payload,environ.IB_MANAGER_BASELINE_SHA256);
      if(!source||source.sourceAsOf!==targetDate)throw Error();
    }
    const view={state:'verified',...fee};
    const ret=await core.project(payload.ibManagerReturnReceipt,view,status);
    const dd=await createIbManagerDrawdownConsumer().project(payload.ibManagerDrawdownReceipt,payload.ibManagerReturnReceipt,view,status);
    if(ret.state!=='verified'||dd.state!=='verified'||ret.asOf!==targetDate||dd.asOf!==targetDate)throw Error();
  }catch{throw Error('FEE_CLOUD_IB_INCOMPLETE');}
}

// Finite reconciliation scope in the existing authenticated private payload.
// It must come from a separately reviewed operator/source-audit handoff. A hash
// or JSON assertion is not permission, and stable GETs cannot release an
// externally known unfinished migration. No ingress or activation is added here.
export async function validateIbManagerCoverage(state,targetDate,expectedHash,requiredFrom=state?.from,nativeCheckpoint=null,baselineAsOf=nativeCheckpoint?.baselineAsOf||IB_BASELINE_WINDOW.asOf){
  if(state?.schema==='fee-console.ib-manager-coverage.v2'){
    try{
      const audit=validateIbBootstrapCoverage(state,expectedHash,{baselineAsOf});
      if(nativeCheckpoint){const source=validateIbManagerReportInput(nativeCheckpoint,expectedHash);if(source.schema!=='fee-console.ib-manager-source.v3'||createIbManagerReturnConsumer().canonical(source.bootstrapCoverage)!==createIbManagerReturnConsumer().canonical(audit)||source.sourceAsOf<audit.through)throw Error();}
      else if(targetDate!==audit.through||requiredFrom!==audit.from)throw Error();
      if(!isCalendarDate(targetDate)||targetDate<audit.through)throw Error();return audit;
    }catch{throw Error('IB_SOURCE_COVERAGE_UNVERIFIED');}
  }
  if(!exact(state,['schema','authority','baselineInputsHash','from','through','evidenceSha256','coverageId'])||state.schema!=='fee-console.ib-manager-coverage.v1'||state.authority!=='reviewed-source-reconciliation'||state.baselineInputsHash!==expectedHash||![state.from,state.through,targetDate,requiredFrom,baselineAsOf].every(isCalendarDate)||state.from<=baselineAsOf||state.from>requiredFrom||requiredFrom>targetDate||state.through<state.from||inclusiveDays(state.from,state.through)>8||targetDate<state.from||targetDate>state.through||!['evidenceSha256','coverageId'].every(k=>/^[a-f0-9]{64}$/.test(state[k]||'')))throw Error('IB_SOURCE_COVERAGE_UNVERIFIED');
  const {coverageId,...body}=state;
  if(await createIbManagerReturnConsumer().digest(body)!==coverageId)throw Error('IB_SOURCE_COVERAGE_UNVERIFIED');
  return structuredClone(state);
}

export async function prepareIbManagerReport({payload,targetDate,outputDir,environ=process.env,reader}={}){
  if(environ.IB_MANAGER_READ_ENABLED!=='true')return null;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(targetDate||''))refused();
  const dir=fs.realpathSync(outputDir),stat=fs.statSync(dir);
  if(!outside(dir)||!stat.isDirectory()||(stat.mode&0o077)!==0)refused();
  const expectedBaselineHash=environ.IB_MANAGER_BASELINE_SHA256;
  let request,coverage=null;
  try{
    if(!/^[a-f0-9]{64}$/.test(expectedBaselineHash||''))throw Error('IB_SOURCE_BASELINE_LOCK');
    let checkpoint=await validateIbManagerReportState(payload,expectedBaselineHash);
    const ownerBaseline=await validateIbOwnerBaselineState(payload,expectedBaselineHash);
    if(checkpoint?.ownerBaseline&&ownerBaseline&&createIbManagerReturnConsumer().canonical(checkpoint.ownerBaseline)!==createIbManagerReturnConsumer().canonical(ownerBaseline))throw Error('IB_SOURCE_STATE_INVALID');
    // Derive dates only from the hash-locked, receipt-verified original history.
    // A reviewed later frozen attachment must not be read as the old default.
    const baseline=checkpoint?{from:checkpoint.baselineFrom,asOf:checkpoint.baselineAsOf}:
      ownerBaseline?{from:ownerBaseline.input.periodReturnsInput.from,asOf:ownerBaseline.input.periodReturnsInput.to}:IB_BASELINE_WINDOW;
    // Future reads require authenticated history, not only a later date. Real
    // activation still requires the known unfinished migration to be reconciled;
    // Sharesight cannot attest a broker event that has never been entered.
    if(targetDate>IB_BASELINE_WINDOW.asOf){
      if(!checkpoint&&!ownerBaseline)throw Error('IB_SOURCE_COVERAGE_UNVERIFIED');
      const priorDate=checkpoint?.sourceAsOf||ownerBaseline.input.periodReturnsInput.to;
      const requiredFrom=priorDate===targetDate?targetDate:new Date(Date.parse(priorDate+'T00:00:00Z')+86400000).toISOString().slice(0,10);
      const bootstrapBoundary=!checkpoint&&ownerBaseline&&payload.ibManagerCoverageState?.schema==='fee-console.ib-manager-coverage.v2'?payload.ibManagerCoverageState.through:null;
      // First establish the finite audited boundary in memory, then extend it
      // with the ordinary native reader. Never claim the old audit covers the
      // later target or publish an intermediate period as the final report.
      const coverageTarget=bootstrapBoundary&&targetDate>bootstrapBoundary?bootstrapBoundary:targetDate;
      coverage=await validateIbManagerCoverage(payload.ibManagerCoverageState,coverageTarget,expectedBaselineHash,requiredFrom,checkpoint?.schema==='fee-console.ib-manager-source.v3'?checkpoint:null,baseline.asOf);
      if(coverage.schema==='fee-console.ib-manager-coverage.v2'&&checkpoint&&checkpoint.schema!=='fee-console.ib-manager-source.v3')throw Error('IB_SOURCE_STATE_INVALID');
    }
    const activeReader=reader||new SharesightIbManagerReader({clientId:environ.FEE_CLOUD_SHARESIGHT_CLIENT_ID,clientSecret:environ.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET});
    if(!checkpoint&&coverage?.schema==='fee-console.ib-manager-coverage.v2'&&targetDate>coverage.through){
      const boundary=await activeReader.readStable({targetDate:coverage.through,expectedBaselineHash,baseline,ownerBaseline,bootstrapCoverage:coverage});
      await buildIbManagerReportBundle(boundary,expectedBaselineHash);
      if(boundary.sourceAsOf!==coverage.through)throw Error('IB_SOURCE_STATE_INVALID');
      await validateIbManagerCoverage(coverage,targetDate,expectedBaselineHash,coverage.through,boundary);checkpoint=boundary;
    }
    const source=await activeReader.readStable({targetDate,expectedBaselineHash,baseline,checkpoint,...(!checkpoint&&ownerBaseline?{ownerBaseline}:{}),...(!checkpoint&&coverage?.schema==='fee-console.ib-manager-coverage.v2'?{bootstrapCoverage:coverage}:{})});
    await buildIbManagerReportBundle(source,expectedBaselineHash);
    if(source.sourceAsOf!==targetDate)throw Error('IB_SOURCE_STATE_INVALID');
    request={state:'verified',source,...(coverage?{coverage}:{})};
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
    const future=request.targetDate>IB_BASELINE_WINDOW.asOf;
    if(!exact(request,['schema','targetDate','state','source',...(future?['coverage']:[])]))refused();
    try{bundle=await buildIbManagerReportBundle(request.source,environ.IB_MANAGER_BASELINE_SHA256);}catch{refused();}
    if(future)try{await validateIbManagerCoverage(request.coverage,request.targetDate,environ.IB_MANAGER_BASELINE_SHA256,request.coverage?.from,request.source.schema==='fee-console.ib-manager-source.v3'?request.source:null);}catch{refused();}
    if(bundle.returnReceipt.asOf!==request.targetDate)refused();
  }else if(request.state!=='pending'||!exact(request,['schema','targetDate','state','reasonCode'])||!/^IB_SOURCE_[A-Z_]{1,48}$/.test(request.reasonCode||''))refused();
  return {checkCurrent,apply(data,targetDate){
    checkCurrent();if(request.targetDate!==targetDate)refused();
    if(bundle&&targetDate>IB_BASELINE_WINDOW.asOf){
      const core=createIbManagerReturnConsumer();
      if(core.canonical(request.coverage)!==core.canonical(data.ibManagerCoverageState))refused();
      const stored=data.ibManagerBaselineState||data.ibManagerSourceState?.source?.ownerBaseline;
      if(request.source.ownerBaseline&&core.canonical(stored)!==core.canonical(request.source.ownerBaseline))refused();
    }
    const fee=data.feeCalculationReceipt;
    // Independent failure never changes the original fee calculation or ledger.
    const matched=bundle&&validateFeeCalculationReceipt(fee,data).ok&&bundle.returnReceipt.start===fee.start&&bundle.returnReceipt.asOf===fee.asOf;
    const out={...data,ibManagerSourceStatus:{state:matched?'verified':'pending',targetDate,...(!matched?{reasonCode:bundle?'IB_SOURCE_PERIOD_MISMATCH':request.reasonCode}:{})}};
    if(matched)Object.assign(out,{ibManagerReturnReceipt:bundle.returnReceipt,ibManagerDrawdownReceipt:bundle.drawdownReceipt,ibManagerSourceState:bundle.sourceState});
    return out;
  }};
}
