#!/usr/bin/env node
// The capture step of a `publish-api` ratio run: read the Sharesight API once,
// build the private API original and its input, and pin both in the private
// ratio bucket for the publication step that follows in the same job.
//
// Separation: this step holds the two Sharesight values and a storage token.
// It must never see the snapshot manager token, the fee data key or the Gist
// id, and it refuses to start if any of them is present. The publication step
// holds those and never the Sharesight values. The two meet only through the
// two pinned objects and one small file of hashes and object generations.
//
// Every request is a fixed GET (plus the one token exchange and the two
// create-only uploads), never retried, never redirected, never paged. Nothing
// is printed but a fixed stage and a fixed code: no amount, name, identifier,
// URL, header, token or remote text. A success means only that these reads
// answered, the existing builders accepted them and the two objects were
// created. It is not a publication and grants none.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {boundedJson,boundedJsonTransportDiagnostic,BoundedJsonError} from './fee-http-json.mjs';
import {ratioRunAdmission,RATIO_BUCKET,RATIO_CAPTURE_FILE,RATIO_CAPTURE_SCHEMA,validateRatioCapture} from './fee-ratio-cloud-runtime.mjs';
import {createApiRatioSourceCore} from './fee-ratio-api-source.mjs';
import {createApiPerformanceCore} from './fee-ratio-api-performance.mjs';
import {createOfficialRatioSourceCore} from './fee-ratio-official-source.mjs';
import {createAggregateReturnsCore} from './fee-ratio-aggregate-returns.mjs';
import {createRatioSourceCore} from './fee-ratio-source-core.mjs';
import {ALL_TOGETHER_SCOPE_SHA256} from './xuan-ib-sharesight-exposure.mjs';

export {RATIO_CAPTURE_FILE,RATIO_CAPTURE_SCHEMA};
export const RATIO_CAPTURE_STAGES=Object.freeze(['ADMISSION','TOKEN','VIEWS','PORTFOLIOS','GROUPS','CLASSIFICATION','HOLDINGS','TRADES','CASH','PERFORMANCE','BUILD','VERIFY','UPLOAD','COMPLETE']);
export const RATIO_CAPTURE_BUDGET=Object.freeze({requests:72,cashAccounts:24,overallMs:270000,requestMs:30000,reportBytes:8*1024*1024,objectBytes:5*1024*1024});
export const RATIO_CAPTURE_VIEW='All Together';
export const RATIO_CAPTURE_GROUPS=Object.freeze({asset:'资产类别',income:'小程序收益分类',top:'小程序前五收益',stock:'小程序股票市场收益'});
const API='https://api.sharesight.com';
const PRIVATE=['FEE_CLOUD_SHARESIGHT_CLIENT_ID','FEE_CLOUD_SHARESIGHT_CLIENT_SECRET','RATIO_STORAGE_ACCESS_TOKEN'];
// The publication step's secrets, and anything that could redirect a read or a write.
const FORBIDDEN=['NODE_OPTIONS','NODE_PATH','GH_TOKEN','GITHUB_TOKEN','FEE_DATA_KEY','FEE_ECON_GIST_ID','FEE_ECON_GITHUB_TOKEN','FEE_ECON_FILE','FEE_ECON_V3_FILE','FEE_CLOUD_GITHUB_TOKEN','FEE_RATIO_MANAGER_TOKEN','FEE_REPORT_ACTIONS_TOKEN','IB_MANAGER_BASELINE_SHA256'];
const CLOUD_CREDENTIAL_PATHS=['GOOGLE_APPLICATION_CREDENTIALS','CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE','GOOGLE_GHA_CREDS_PATH'];
const api=createApiRatioSourceCore(),performanceCore=createApiPerformanceCore();
export const RATIO_CAPTURE_CODES=Object.freeze([
  ...['ENVIRONMENT','PLAN','TARGET_DATE','BUDGET','DEADLINE','TRANSPORT','AUTH_RESPONSE','SHAPE','INCOMPLETE','VIEW_IDENTITY','GROUP_IDENTITY','MEMBERS','SCOPE','CASH_ACCOUNTS','ASSOCIATION','OBJECT_SIZE','OBJECT_EXISTS','UPLOAD_UNAUTHORIZED','UPLOAD_FORBIDDEN','UPLOAD_BAD_REQUEST','UPLOAD_NOT_FOUND','UPLOAD_REFUSED','UPLOAD_RESPONSE','FAILED'].map(c=>'RATIO_CAPTURE_'+c),
  ...api.CODES.map(c=>'RATIO_API_SOURCE_'+c),...performanceCore.CODES.map(c=>'RATIO_API_PERFORMANCE_'+c),'RATIO_CLOUD_RUNTIME_REFUSED','RATIO_OFFICIAL_SOURCE_REFUSED']);
class CaptureError extends Error{constructor(code){super('RATIO_CAPTURE_'+code);}}
const fail=code=>{throw new CaptureError(code);};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const hkDate=ms=>new Date(ms+8*3600000).toISOString().slice(0,10);
const id=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0?String(v):typeof v==='string'&&/^[1-9]\d{0,14}$/.test(v)?v:null;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const TOKEN_RE=/^[A-Za-z0-9._~+/=-]{20,16384}$/;
function complete(payload){
  if(!object(payload))fail('SHAPE');
  if(payload.links?.next||payload.pagination?.next_page||payload.meta?.pagination?.next_page||payload.meta?.next_page
    ||payload.next_page||payload.has_more===true||payload.complete===false||payload.restricted===true||payload.limited===true||payload.truncated===true)fail('INCOMPLETE');
  return payload;
}
const listed=(payload,key)=>{complete(payload);if(!Array.isArray(payload[key])||payload[key].length>20000)fail('SHAPE');return payload[key];};
const oneYearBefore=end=>{const y=Number(end.slice(0,4))-1,m=Number(end.slice(5,7)),d=Number(end.slice(8,10));return String(y).padStart(4,'0')+'-'+String(m).padStart(2,'0')+'-'+String(Math.min(d,new Date(Date.UTC(y,m,0)).getUTCDate())).padStart(2,'0');};
const safeCode=error=>{const m=String(error?.message||'');return RATIO_CAPTURE_CODES.includes(m)?m:'RATIO_CAPTURE_FAILED';};
export async function runRatioApiCapture(options={}){
  const state={budgetExceeded:false,deadlineExceeded:false},deadline=new AbortController();
  const result={schema:RATIO_CAPTURE_SCHEMA,status:'REFUSED',stage:'ADMISSION',code:'RATIO_CAPTURE_FAILED',requests:0,planSha256:'0'.repeat(64),mainSha:'0'.repeat(40),runId:'0',bundleId:null,original:null,input:null};
  let timer;
  const expired=new Promise(resolve=>{timer=setTimeout(()=>{state.deadlineExceeded=true;deadline.abort();resolve();},RATIO_CAPTURE_BUDGET.overallMs);});
  const work=captureWork(options,result,state,deadline.signal);
  try{
    if(await Promise.race([work.then(()=>true),expired.then(()=>false)])){if(typeof options.onTransport==='function'&&state.transport)options.onTransport(state.transport);return result;}
    work.catch(()=>{});
    return {...result,status:'REFUSED',code:'RATIO_CAPTURE_DEADLINE',bundleId:null,original:null,input:null};
  }finally{clearTimeout(timer);}
}
// `expectedScopeSha256` exists for offline tests with invented account names; the entry point never sets it.
async function captureWork({env,event,now=new Date(),fetchImpl=globalThis.fetch,clock=()=>Date.now(),expectedScopeSha256=ALL_TOGETHER_SCOPE_SHA256}={},result,state,deadlineSignal){
  const started=clock();
  try{
    // ---- admission: the same owner dispatch, exact main and plan the publication step requires ----
    if(!object(env)||FORBIDDEN.some(k=>env[k]!==undefined)||CLOUD_CREDENTIAL_PATHS.some(k=>env[k]!==undefined&&env[k]!=='')
      ||PRIVATE.some(k=>typeof env[k]!=='string'||!env[k]||env[k].length>16384||/[\r\n\0]/.test(env[k]))||!/^\d{1,20}$/.test(env.GITHUB_RUN_ID||''))fail('ENVIRONMENT');
    const admitted=ratioRunAdmission(env,event,now),plan=admitted.plan;
    if(!admitted.due||plan.mode!=='publish-api')fail('PLAN');
    result.planSha256=sha(Buffer.from(admitted.planText));result.mainSha=env.GITHUB_SHA;result.runId=env.GITHUB_RUN_ID;
    const d=plan.asOf,clockNow=now.getTime(),age=(Date.parse(hkDate(clockNow)+'T00:00:00Z')-Date.parse(d+'T00:00:00Z'))/86400000;
    if(!date(d)||!Number.isFinite(clockNow)||!Number.isInteger(age)||age<0||age>4)fail('TARGET_DATE');

    const request=async(url,init,maxBytes=2*1024*1024,includeBytes=false,statuses=[200])=>{
      if(result.requests>=RATIO_CAPTURE_BUDGET.requests){state.budgetExceeded=true;fail('BUDGET');}
      if(state.deadlineExceeded||deadlineSignal.aborted||clock()-started>RATIO_CAPTURE_BUDGET.overallMs){state.deadlineExceeded=true;fail('DEADLINE');}
      result.requests++;
      return boundedJson(fetchImpl,url,{...init,signal:deadlineSignal},{timeoutMs:RATIO_CAPTURE_BUDGET.requestMs,maxBytes,includeBytes,statuses});
    };
    result.stage='TOKEN';
    const granted=await request(API+'/oauth2/token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'client_credentials',client_id:env.FEE_CLOUD_SHARESIGHT_CLIENT_ID,client_secret:env.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET}).toString()});
    if(!object(granted)||typeof granted.access_token!=='string'||!TOKEN_RE.test(granted.access_token)||String(granted.token_type||'').toLowerCase()!=='bearer')fail('AUTH_RESPONSE');
    let token=granted.access_token;
    const headers=()=>({Accept:'application/json',Authorization:'Bearer '+token,'User-Agent':'fee-console-ratio-capture/1.0'});
    const get=(route,maxBytes)=>request(API+route,{method:'GET',headers:headers()},maxBytes);
    const getExact=async route=>{const got=await request(API+route,{method:'GET',headers:headers()},RATIO_CAPTURE_BUDGET.reportBytes,true);if(!object(got)||!object(got.json)||!(got.bytes instanceof Uint8Array))fail('SHAPE');return {json:complete(got.json),sha256:sha(got.bytes)};};

    result.stage='VIEWS';
    const views=listed(await get('/api/v3/portfolios?consolidated=true'),'portfolios').filter(v=>object(v)&&v.consolidated===true&&v.name===RATIO_CAPTURE_VIEW);
    const viewId=views.length===1?id(views[0].id):null;if(!viewId||views[0].currency_code!=='USD')fail('VIEW_IDENTITY');
    result.stage='PORTFOLIOS';
    const names=new Map();
    for(const p of listed(await get('/api/v2/portfolios.json'),'portfolios')){const pid=object(p)?id(p.id):null;if(pid&&typeof p.name==='string'&&p.name)names.set(pid,p.name);}
    result.stage='GROUPS';
    const groups=listed(await get('/api/v2/groups.json'),'groups'),groupId={};
    for(const [key,name]of Object.entries(RATIO_CAPTURE_GROUPS)){const m=groups.filter(g=>object(g)&&g.name===name);groupId[key]=m.length===1?id(m[0].id):null;if(!groupId[key])fail('GROUP_IDENTITY');}
    const performanceRoute=(group,start,sales)=>`/api/v3/portfolios/${viewId}/performance?consolidated=true&custom_group_id=${groupId[group]}&end_date=${d}&grouping=custom_group&include_limited=true&include_sales=${sales}&report_combined=false&start_date=${start}`;

    result.stage='CLASSIFICATION';
    const classification=await getExact(performanceRoute('asset',d,false));
    if(!object(classification.json.report))fail('SHAPE');
    const report=complete(classification.json.report),capturedAt=new Date(clock()).toISOString();
    // Members are the portfolios the report's own rows carry; the reviewed ten-account scope must match exactly.
    const memberIds=new Set();
    for(const row of [...(Array.isArray(report.holdings)?report.holdings:[]),...(Array.isArray(report.cash_accounts)?report.cash_accounts:[])]){const pid=object(row?.portfolio)?id(row.portfolio.id):null;if(pid)memberIds.add(pid);}
    if(memberIds.size!==10||[...memberIds].some(m=>!names.has(m)))fail('MEMBERS');
    const accounts=[...memberIds].sort().map(m=>({id:m,name:names.get(m)}));
    const scope=list=>sha(JSON.stringify(list.map(s=>s.replaceAll('&amp;','&')).sort()));
    if(scope(accounts.map(a=>a.name))!==expectedScopeSha256)fail('SCOPE');
    const projection=api.project({schema:api.CAPTURE,provider:'Sharesight',view:{id:viewId,name:RATIO_CAPTURE_VIEW},group:{id:groupId.asset,name:RATIO_CAPTURE_GROUPS.asset},asOf:d,capturedAt,accounts,report});
    const allocationRaw=api.toRaw(projection,{reportSha256:classification.sha256});

    result.stage='HOLDINGS';
    const holdingRows=[],holdingHashes=[];
    for(const a of accounts){const got=await getExact(`/api/v3/portfolios/${a.id}/holdings?consolidated=false`);holdingHashes.push(got.sha256);for(const h of listed(got.json,'holdings'))holdingRows.push({portfolioId:a.id,holding:{id:h?.id,inception_date:h?.inception_date}});}
    const holdingsCapturedAt=new Date(clock()).toISOString();
    result.stage='TRADES';
    const tradeRows=[];
    for(const a of accounts)for(const t of listed(await get(`/api/v3/portfolios/${a.id}/trades.json?consolidated=false&end_date=${d}`,RATIO_CAPTURE_BUDGET.reportBytes),'trades'))tradeRows.push({portfolioId:a.id,trade:{holding_id:t?.holding_id,transaction_date:t?.transaction_date,description_code:t?.description_code,state:t?.state}});
    result.stage='CASH';
    const cashAccounts=[];
    for(const a of accounts)for(const c of listed(await get(`/api/v2/portfolios/${a.id}/cash_accounts.json`),'cash_accounts')){const cid=object(c)?id(c.id):null;if(!cid)fail('SHAPE');cashAccounts.push({portfolioId:a.id,cashAccountId:cid});}
    if(cashAccounts.length>RATIO_CAPTURE_BUDGET.cashAccounts||new Set(cashAccounts.map(c=>c.cashAccountId)).size!==cashAccounts.length)fail('CASH_ACCOUNTS');
    const cashTransactions=[],cashHashes=[];
    for(const c of cashAccounts){const got=await getExact(`/api/v2/cash_accounts/${c.cashAccountId}/cash_account_transactions.json?to=${d}`);cashHashes.push(got.sha256);for(const t of listed(got.json,'cash_account_transactions'))cashTransactions.push({cashAccountId:c.cashAccountId,dateTime:t?.date_time});}
    const cashCapturedAt=new Date(clock()).toISOString();
    // The all-time window must start no later than anything it covers.
    const starts=[...holdingRows.map(r=>r.holding.inception_date),...cashTransactions.map(t=>typeof t.dateTime==='string'?t.dateTime.slice(0,10):null)].filter(date).sort();
    if(!starts.length)fail('SHAPE');
    const allStartDate=starts[0]<d?starts[0]:d;

    result.stage='PERFORMANCE';
    const reports={},window={all:allStartDate,oneYear:oneYearBefore(d)};
    for(const group of performanceCore.GROUPS)for(const period of performanceCore.PERIODS){
      const got=await getExact(performanceRoute(group,window[period],true));
      if(!object(got.json.report))fail('SHAPE');
      reports[group+'.'+period]={report:complete(got.json.report),sha256:got.sha256};
    }
    token=null;

    // ---- build with the existing pure builders; nothing is computed here ----
    result.stage='BUILD';
    const official=createOfficialRatioSourceCore(),returns=createAggregateReturnsCore();
    // The ranking does not depend on the original's hash, so the targets can be taken before the original exists.
    const provisional=official.build(allocationRaw,{sourceSha256:'0'.repeat(64),sourceBytes:1}).input;
    const performance=performanceCore.build({schema:performanceCore.CAPTURE,asOf:d,allStartDate,accounts,reports,
      holdings:{sha256:sha(holdingHashes.join('|')),capturedAt:holdingsCapturedAt,rows:holdingRows},trades:{rows:tradeRows},
      cash:{sha256:sha(cashHashes.join('|')),capturedAt:cashCapturedAt,accounts:cashAccounts,transactions:cashTransactions}},{topTargets:returns.topTargets(provisional.exposure)});
    const raw={schemaVersion:'sharesight-private-performance-v1',accounts:[...allocationRaw.accounts],allocation:allocationRaw,performance,performanceCapturedAt:new Date(clock()).toISOString()};
    const originalBytes=Buffer.from(JSON.stringify(raw));
    const allocation=official.build(allocationRaw,{sourceSha256:sha(originalBytes),sourceBytes:originalBytes.length}).input;
    const inputBytes=Buffer.from(JSON.stringify({...allocation,schema:'fee-console.ratio-sources.v3',performance}));
    if(originalBytes.length>RATIO_CAPTURE_BUDGET.objectBytes||inputBytes.length>RATIO_CAPTURE_BUDGET.objectBytes)fail('OBJECT_SIZE');

    // ---- the same association check the publication step will repeat ----
    result.stage='VERIFY';
    try{createRatioSourceCore(scope).verifyBrowserSourceAssociations(JSON.parse(originalBytes),JSON.parse(inputBytes),{scopeHash:expectedScopeSha256,now:new Date(clock())});}catch{fail('ASSOCIATION');}

    // ---- pin both objects, create-only ----
    result.stage='UPLOAD';
    const bundleId=sha(Buffer.concat([originalBytes,inputBytes])),prefix='inputs/'+bundleId+'/';
    const upload=async(name,bytes)=>{
      // Create-only: a precondition failure means an object of this exact content already exists.
      const created=await request('https://storage.googleapis.com/upload/storage/v1/b/'+RATIO_BUCKET+'/o?uploadType=media&name='+encodeURIComponent(name)+'&ifGenerationMatch=0',
        {method:'POST',headers:{Authorization:'Bearer '+env.RATIO_STORAGE_ACCESS_TOKEN,'Content-Type':'application/json'},body:bytes},65536,false,[200,400,401,403,404,412]);
      // A refusal is named by the service's own numeric code only; its message is never read.
      if(object(created)&&Object.hasOwn(created,'error')){const n=created.error?.code;fail(n===412?'OBJECT_EXISTS':n===401?'UPLOAD_UNAUTHORIZED':n===403?'UPLOAD_FORBIDDEN':n===400?'UPLOAD_BAD_REQUEST':n===404?'UPLOAD_NOT_FOUND':'UPLOAD_REFUSED');}
      if(!object(created)||created.bucket!==RATIO_BUCKET||created.name!==name||typeof created.generation!=='string'||!/^[1-9][0-9]{0,29}$/.test(created.generation)||Number(created.size)!==bytes.length)fail('UPLOAD_RESPONSE');
      return {name,generation:created.generation,sha256:sha(bytes)};
    };
    const original=await upload(prefix+'original.json',originalBytes),input=await upload(prefix+'input.json',inputBytes);
    originalBytes.fill(0);inputBytes.fill(0);
    Object.assign(result,{status:'CAPTURED',stage:'COMPLETE',code:null,bundleId,original,input});
    return result;
  }catch(error){
    // Only fixed codes. No message, URL, status text, header or body reaches the result.
    result.status='REFUSED';result.bundleId=null;result.original=null;result.input=null;
    const bounded=error instanceof BoundedJsonError;
    result.code=state.budgetExceeded?'RATIO_CAPTURE_BUDGET':state.deadlineExceeded?'RATIO_CAPTURE_DEADLINE':bounded?'RATIO_CAPTURE_TRANSPORT':safeCode(error);
    // Value-free facts of this helper's own error class, for the log line only.
    if(bounded&&!state.budgetExceeded&&!state.deadlineExceeded){const d=boundedJsonTransportDiagnostic(error);state.transport={phase:d?.phase||'RESPONSE',category:d?.category||'REJECTED',kind:['HTTP','TYPE','SIZE','BODY','JSON','TIMEOUT','ABORTED','CONFIG'].includes(error.code)?error.code:'OTHER'};}
    return result;
  }
}

export function saveRatioCapture(file,value){
  const safe=validateRatioCapture(value);
  if(!RATIO_CAPTURE_STAGES.includes(safe.stage)||!(safe.code===null||RATIO_CAPTURE_CODES.includes(safe.code))||safe.requests>RATIO_CAPTURE_BUDGET.requests)throw Error('RATIO_CAPTURE_RESULT_REFUSED');
  const tmp=file+'.pending';fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(safe)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  (async()=>{
    try{
      if(process.argv.length!==3||process.argv[2]!=='--capture'||!process.env.RUNNER_TEMP||!path.isAbsolute(process.env.RUNNER_TEMP))throw Error();
      const eventBytes=fs.readFileSync(process.env.GITHUB_EVENT_PATH);if(eventBytes.length>1024*1024)throw Error();
      let transport=null;
      const result=await runRatioApiCapture({env:process.env,event:JSON.parse(eventBytes),onTransport:t=>{transport=t;}});
      saveRatioCapture(path.join(process.env.RUNNER_TEMP,RATIO_CAPTURE_FILE),result);
      // The log carries the stage and code only; hashes and generations stay in the runner's private file.
      console.log(JSON.stringify({schema:result.schema,status:result.status,stage:result.stage,code:result.code,requests:result.requests,transport}));
      process.exitCode=result.status==='CAPTURED'?0:1;
    }catch{console.error('RATIO_CAPTURE_ENTRY_REFUSED');process.exitCode=1;}
  })();
}
