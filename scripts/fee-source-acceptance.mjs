#!/usr/bin/env node
// Fixed Sharesight field acceptance. Never runs the writer, decrypts fee data,
// reads Keychain, publishes, syncs brokers, or changes the economic book.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
import {SharesightCloudReader,expectedTargetDate} from './fee-cloud-source.mjs';
import {reportDate,reportAddDays,reportWindowDates} from './fee-report-period.mjs';
import {boundedJson} from './fee-http-json.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),fail=code=>{throw Error('FEE_SOURCE_ACCEPTANCE_'+code);};
const publicFailures=new WeakMap();
const stages=new Set(['arguments','environment','attempt','git-head','git-tracked','git-untracked','dates','public-main','capture']);
const knownReasons=new Set(['ARGUMENT','ENVIRONMENT','RERUN','CODE_CHANGED','DATE']);
let cliStage='arguments';
// Diagnostics are finite data, never raw exceptions, environment values or a
// source/health attestation. A capture failure must not claim zero source calls.
export function sourceAcceptanceFailure(error,stage){
 const phase=typeof stage==='string'&&stages.has(stage)?stage:'unknown';let message='';
 try{const d=error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'message'):null;if(d&&Object.hasOwn(d,'value')&&typeof d.value==='string')message=d.value;}catch{}
 const code=message.startsWith('FEE_SOURCE_ACCEPTANCE_')?message.slice('FEE_SOURCE_ACCEPTANCE_'.length):'';
 let reasonCode=knownReasons.has(code)?'FEE_SOURCE_ACCEPTANCE_'+code:'FEE_SOURCE_ACCEPTANCE_REFUSED';
 const metadata=error&&typeof error==='object'?publicFailures.get(error):null;
 if(metadata){const bounded=/^BOUNDED_JSON_(HTTP|NETWORK|TIMEOUT|ABORTED|SIZE|BODY|JSON|TYPE|CONFIG)$/.exec(message);if(bounded)reasonCode='FEE_SOURCE_ACCEPTANCE_PUBLIC_'+(metadata.rateLimited?'RATE_LIMIT':bounded[1]);}
 else if(phase.startsWith('git-')&&!knownReasons.has(code))reasonCode='FEE_SOURCE_ACCEPTANCE_GIT_CHECK_FAILED';
 else if(phase==='dates'&&!knownReasons.has(code))reasonCode='FEE_SOURCE_ACCEPTANCE_DATE_CHECK_FAILED';
 const beforeSource=phase!=='capture'&&phase!=='unknown';
 return {schema:'fee-console.source-acceptance-failure.v1',stage:phase,reasonCode,...(metadata?{httpStatus:metadata.httpStatus,rateLimited:metadata.rateLimited}:{}),sourceCaptureEntered:phase==='capture',sourceGets:beforeSource?0:null,oauthGrants:beforeSource?0:null,financialCalculationVerified:false,publicationReady:false};
}
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const canonical=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(canonical):Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>hash(JSON.stringify(canonical(v)));
const complete=p=>{if(!p||p.links?.next||p.next_page||p.pagination?.next_page||p.has_more||p.truncated||p.complete===false)fail('INCOMPLETE');return p;};
const list=(p,key)=>{complete(p);if(!Array.isArray(p[key])||p[key].length>10000||p[key].some(r=>!Number.isSafeInteger(r.id)||r.id<=0)||new Set(p[key].map(r=>r.id)).size!==p[key].length)fail('INCOMPLETE');return p[key];};
function privateDirectory(dir){if(typeof dir!=='string'||!path.isAbsolute(dir)||fs.realpathSync(dir)!==dir)fail('OUTPUT');const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)fail('OUTPUT');for(let p=dir;;p=path.dirname(p)){if(fs.existsSync(path.join(p,'.git')))fail('OUTPUT');if(p===path.dirname(p))break;}}
function dates(from,to,now){reportDate(from);reportDate(to);const age=Math.floor((Date.parse(now.toISOString().slice(0,10))-Date.parse(to))/86400000);if(to>expectedTargetDate(now)||age<0||age>4)fail('DATE');return reportWindowDates(reportAddDays(from,-1),to,{limit:4});}
export function acceptanceTransport({fetchImpl}){
 let gets=0,grants=0,closed=false;const started=Date.now(),controller=new AbortController();
 const fetch=async(url,init={})=>{
  const u=new URL(url),grant=u.href==='https://api.sharesight.com/oauth2/token';
  if(closed||u.origin!=='https://api.sharesight.com'||u.hash||u.username||u.password||!grant&&!/^\/api\/v[23]\/(portfolios(?:\.json|\/)|cash_accounts\/|payouts\/)/.test(u.pathname)||init.method!==(grant?'POST':'GET')||Date.now()-started>14*60000)fail('ROUTE');
  if(grant?++grants>10:++gets>300)fail('CALL_BUDGET');
  return fetchImpl(url,{...init,signal:init.signal?AbortSignal.any([init.signal,controller.signal]):controller.signal});
 };
 return {fetch,closed:()=>closed,stop(){closed=true;controller.abort();},counts:()=>({sourceGets:gets,oauthGrants:grants})};
}
function inspectIb(surface,from,to){
 if(surface.portfolio?.name!=='IB-HK'||surface.portfolio.currency!=='USD'||!Number.isSafeInteger(surface.portfolio.id))fail('IB_SCOPE');
 const pid=surface.portfolio.id;list(surface.catalog,'holdings');const trades=list(surface.trades,'trades');
 if(trades.some(t=>t.portfolio_id!==pid||t.state!=='confirmed'||t.transaction_date<from||t.transaction_date>to))fail('IB_SCOPE');
 const expected=reportWindowDates(reportAddDays(from,-2),to,{limit:10});
 if(!Array.isArray(surface.days)||surface.days.length!==expected.length)fail('IB_DATES');
 for(let i=0;i<expected.length;i++){
  const day=surface.days[i],r=complete(complete(day.performance).report);if(day.date!==expected[i]||r.portfolio_id!==pid||r.start_date!==day.date||r.end_date!==day.date||r.currency?.code!=='USD'||r.portfolio_tz_name!=='America/New_York'||r.include_sales!==false)fail('IB_DATES');
  const holdings=list(r,'holdings'),cash=list(r,'cash_accounts'),listed=list(day.cashAccounts,'cash_accounts');
  if([...holdings,...cash].some(h=>h.portfolio?.id!==pid||h.portfolio?.name!=='IB-HK')||listed.some(c=>c.portfolio_id!==pid||c.date!==day.date)||cash.length!==listed.length||JSON.stringify(Object.keys(day.cashTransactions).sort())!==JSON.stringify(listed.map(c=>String(c.id)).sort()))fail('IB_SCOPE');
  for(const [cashId,p]of Object.entries(day.cashTransactions))if(list(p,'cash_account_transactions').some(t=>t.cash_account_id!==Number(cashId)||String(t.date_time).slice(0,10)!==day.date))fail('IB_SCOPE');
 }
 const nativeCashCurrencies=[...new Set(surface.days.flatMap(d=>d.cashAccounts.cash_accounts.map(c=>c.currency)))].sort();if(nativeCashCurrencies.some(c=>typeof c!=='string'||!/^[A-Z]{3}$/.test(c)))fail('IB_CURRENCY');
 return {nativeCashCurrencies,transferOutRows:trades.filter(t=>t.description_code==='TRANSFER_OUT').length,transferOutNonzeroPrice:trades.filter(t=>t.description_code==='TRANSFER_OUT'&&t.price!==0).length,zeroValueSellRows:trades.filter(t=>t.description_code==='SELL'&&t.value===0).length};
}
export async function captureSourceAcceptance({fromDate,targetDate,outputDir,clientId,clientSecret,now=new Date(),fetchImpl=globalThis.fetch}={}){
 const range=dates(fromDate,targetDate,now);privateDirectory(outputDir);const dir=path.join(outputDir,'source-field-acceptance');if(fs.existsSync(dir))fail('OUTPUT_EXISTS');fs.mkdirSync(dir,{mode:0o700});let n=0,capturedBytes=0;const files=[];
 const transport=acceptanceTransport({fetchImpl}),saveRaw=async bytes=>{if(transport.closed())fail('CAPTURE_CLOSED');if(typeof clientSecret==='string'&&clientSecret&&bytes.includes(Buffer.from(clientSecret)))fail('CREDENTIAL_RESPONSE');if(capturedBytes+bytes.length>32*1024*1024)fail('EVIDENCE_BUDGET');capturedBytes+=bytes.length;const name='source-'+String(++n).padStart(3,'0')+'.json';fs.writeFileSync(path.join(dir,name),bytes,{flag:'wx',mode:0o600});files.push({name,sha256:hash(bytes)});};
 const reader=()=>new SharesightCloudReader({clientId,clientSecret,fetchImpl:transport.fetch,reconcileInKind:true,onSourceResponse:saveRaw});
 const summaries=[];let reasonCode=null;
 try{
  const passes=[];
  for(let pass=0;pass<2;pass++){
   const managed=[];for(const d of range)managed.push(await reader().readOnce(d));
   const ib=await reader().readIbEvidenceWindow(fromDate,targetDate);summaries.push(inspectIb(ib,fromDate,targetDate));passes.push(digest({managed,ib}));
  }
  if(passes[0]!==passes[1])fail('UNSTABLE');
 }catch(e){reasonCode=/^(?:FEE_CLOUD|FEE_NONCASH|FEE_SOURCE_ACCEPTANCE)_[A-Z_]{1,80}$/.test(e?.message||'')?e.message:'FEE_SOURCE_ACCEPTANCE_FAILED';}finally{transport.stop();}
 const result={schema:'fee-console.source-field-acceptance.v1',status:reasonCode?'incomplete':'fields-captured',fromDate,targetDate,checkedAt:now.toISOString(),reasonCode,...transport.counts(),evidenceFiles:files.length,evidenceBytes:capturedBytes,evidenceManifestSha256:digest(files),ibShape:summaries.at(-1)||null,financialCalculationVerified:false,publicationReady:false,keychainRead:false,sourceWrite:false};
 fs.writeFileSync(path.join(dir,'private-evidence-manifest.json'),JSON.stringify({files})+'\n',{flag:'wx',mode:0o600});fs.writeFileSync(path.join(dir,'field-acceptance.json'),JSON.stringify(result)+'\n',{flag:'wx',mode:0o600});return result;
}
export async function verifySourceAcceptanceMain(expected,{fetchImpl=globalThis.fetch}={}){
 if(!/^[a-f0-9]{40}$/.test(expected||''))fail('CODE_CHANGED');const base='https://api.github.com/repos/huanwujoy-crypto/fee-console',get=async url=>{
  let httpStatus=null,rateLimited=false;
  try{return await boundedJson(async(u,init)=>{const r=await fetchImpl(u,init);if(Number.isInteger(r?.status)&&r.status>=100&&r.status<=599){httpStatus=r.status;rateLimited=r.status===429||r.status===403&&r.headers?.get?.('x-ratelimit-remaining')==='0';}return r;},url,{method:'GET',headers:{Accept:'application/vnd.github+json'}},{timeoutMs:10000,maxBytes:1024*1024});}
  catch(error){if(error&&typeof error==='object')publicFailures.set(error,{httpStatus,rateLimited});throw error;}
 };
 const ref=await get(base+'/git/ref/heads/main');if(ref.object?.sha!==expected)fail('CODE_CHANGED');
 const c=await get(base+'/commits/'+expected);if(c.sha!==expected||c.author?.id!==283054367||c.commit?.verification?.verified!==true)fail('CODE_CHANGED');
 if((await get(base+'/git/ref/heads/main')).object?.sha!==expected)fail('CODE_CHANGED');
}
async function main(){
 cliStage='arguments';
 const args={};let checkOnly=false;for(const a of process.argv.slice(2)){if(a==='--check-plan'&&!checkOnly){checkOnly=true;continue;}const m=/^--(from-date|target-date|out-dir|expected-main)=([^\r\n]+)$/.exec(a);if(!m||Object.hasOwn(args,m[1]))fail('ARGUMENT');args[m[1]]=m[2];}
 cliStage='environment';
 if(Object.keys(args).length!==4||!/^[a-f0-9]{40}$/.test(args['expected-main']||'')||['FEE_DATA_KEY','FEE_ECON_GIST_ID','FEE_CLOUD_GITHUB_TOKEN','GH_TOKEN','GITHUB_TOKEN','NODE_OPTIONS','NODE_PATH'].some(k=>Object.hasOwn(process.env,k))||process.execArgv.length||Object.keys(process.env).some(k=>/^(DYLD_|LD_)/.test(k)))fail('ENVIRONMENT');
 cliStage='attempt';
 if(process.env.GITHUB_RUN_ATTEMPT!==undefined&&process.env.GITHUB_RUN_ATTEMPT!=='1')fail('RERUN');
 cliStage='git-head';
 if(execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim()!==args['expected-main'])fail('CODE_CHANGED');
 cliStage='git-tracked';
 if(execFileSync('git',['diff','--name-only','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim())fail('CODE_CHANGED');
 cliStage='git-untracked';
 const untracked=execFileSync('git',['ls-files','--others','--exclude-standard'],{cwd:ROOT,encoding:'utf8'}).trim().split('\n').filter(Boolean);if(untracked.some(f=>/\.(?:mjs|js|py|json)$/.test(f)&&!/^gha-creds-[a-f0-9]+\.json$/.test(f)))fail('CODE_CHANGED');
 cliStage='dates';dates(args['from-date'],args['target-date'],new Date());
 cliStage='public-main';await verifySourceAcceptanceMain(args['expected-main']);if(checkOnly){console.log('SOURCE_ACCEPTANCE_PLAN_READY');return;}
 cliStage='capture';
 const r=await captureSourceAcceptance({fromDate:args['from-date'],targetDate:args['target-date'],outputDir:args['out-dir'],clientId:process.env.FEE_CLOUD_SHARESIGHT_CLIENT_ID,clientSecret:process.env.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET});console.log(JSON.stringify(r));if(r.status!=='fields-captured')process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify(sourceAcceptanceFailure(error,cliStage)));process.exitCode=1;});
