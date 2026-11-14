#!/usr/bin/env node
// Read-only ratio source probe: one owner-dispatched, exact-main run that asks
// the Sharesight API for the All Together classification report of one date
// and reports ONLY a fixed stage, a fixed code and value-free shape facts.
//
// Requests, in order, never retried, never following a redirect or a page:
//   1 POST oauth2/token (existing client-credentials pair)
//   2 GET  /api/v3/portfolios?consolidated=true
//   3 GET  /api/v2/portfolios.json
//   4 GET  /api/v2/groups.json
//   5 GET  /api/v3/portfolios/{view}/performance (custom-group classification)
//   6-13 GET the same route for four custom groups x two windows (shape only)
//   14    GET /api/v3/portfolios/{view}/holdings?consolidated=true (shape only)
//   15-24 GET /api/v3/portfolios/{member}/holdings?consolidated=false, one per member
//   25    GET /api/v3/portfolios/{member}/trades.json for one member (shape only)
//
// It writes no file, candidate, snapshot, issue or artifact, reads no ledger,
// fee key, manager token or storage, and publishes nothing. The printed
// result contains no amount, quantity, name, identifier, URL, header, token
// or remote error text: only enumerated strings, booleans and counts of
// anomalies, plus the API's own field names and enumerated codes for the
// performance, holdings and trades routes. A
// success means only that these requests answered and the
// pure projection accepted the report shape at that time. It is not source
// authentication, a reconciliation, or approval to wire or publish anything.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {types} from 'node:util';
import {boundedJson,boundedJsonTransportDiagnostic,BoundedJsonError} from './fee-http-json.mjs';
import {createApiRatioSourceCore} from './fee-ratio-api-source.mjs';
import {ALL_TOGETHER_SCOPE_SHA256} from './xuan-ib-sharesight-exposure.mjs';

export const RATIO_PROBE_SCHEMA='fee-console.ratio-source-probe.v1';
export const RATIO_PROBE_INPUTS=Object.freeze(['source_probe_once','source_probe_main','source_probe_target']);
// The probe is one step of the existing read-only source-probe job of the
// producer workflow, so the event carries every producer input. Each of the
// others must be off or blank.
const OFF=['ib_diagnostic_once','ib_envelope_once','source_plan_check_only','source_acceptance_once','run_reviewed_once'];
const BLANK=['ib_diagnostic_main','ib_envelope_main','ratio_main','ratio_plan','source_from','source_target','source_main','manual_sync_completed_for','confirmed_main','recovery_main','report_kind','report_target','report_markets'];
const off=v=>v===undefined||v===false||v==='false',blank=v=>v===undefined||v==='';
export const RATIO_PROBE_STAGES=Object.freeze(['ADMISSION','TOKEN','VIEWS','PORTFOLIOS','GROUPS','REPORT','PROJECTION','PERFORMANCE','INCEPTION','COMPLETE']);
export const RATIO_PROBE_BUDGET=Object.freeze({requests:25,overallMs:300000,requestMs:30000,reportBytes:8*1024*1024});
export const RATIO_PROBE_VIEW='All Together',RATIO_PROBE_GROUP='资产类别';
// The four existing custom groups the performance section is read through,
// found by exact name in the account's own group list (never by a stored id),
// each for two windows ending on the target date and including sold positions.
export const RATIO_PROBE_PERFORMANCE_GROUPS=Object.freeze({asset:RATIO_PROBE_GROUP,income:'小程序收益分类',top:'小程序前五收益',stock:'小程序股票市场收益'});
export const RATIO_PROBE_PERFORMANCE_WINDOWS=Object.freeze(['all','oneYear']);
// A shape probe needs only a start early enough to precede every holding; it
// is not the published inception date and no return figure is read out.
const ALL_WINDOW_START='2000-01-01';
const REPO='huanwujoy-crypto/fee-console',OWNER=283054367,API='https://api.sharesight.com';
const PRIVATE=['FEE_CLOUD_SHARESIGHT_CLIENT_ID','FEE_CLOUD_SHARESIGHT_CLIENT_SECRET'];
// Nothing else that can read or write financial state may be present.
const FORBIDDEN=['NODE_OPTIONS','NODE_PATH','GH_TOKEN','GITHUB_TOKEN','FEE_DATA_KEY','FEE_ECON_GIST_ID','FEE_ECON_GITHUB_TOKEN','FEE_ECON_FILE','FEE_ECON_V3_FILE',
  'FEE_CLOUD_GITHUB_TOKEN','FEE_RATIO_MANAGER_TOKEN','FEE_REPORT_ACTIONS_TOKEN','FEE_IB_DIAGNOSTIC_ACTIONS_TOKEN','IB_MANAGER_READ_ENABLED','IB_MANAGER_BASELINE_SHA256',
  'RATIO_STORAGE_ACCESS_TOKEN','RATIO_PLAN','FEE_REPORT_ONCE_MAIN','FEE_AUTOMATIC_DAILY_REQUEST','BENCHMARK_CACHE_PATH'];
const CLOUD_CREDENTIAL_PATHS=['GOOGLE_APPLICATION_CREDENTIALS','CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE','GOOGLE_GHA_CREDS_PATH'];
const api=createApiRatioSourceCore();
// Fixed public codes only. Any other failure is RATIO_PROBE_FAILED.
export const RATIO_PROBE_CODES=Object.freeze([
  ...['ARGUMENT','ENVIRONMENT','EVENT','TARGET_DATE','BUDGET','DEADLINE','TRANSPORT','AUTH_RESPONSE','SHAPE','INCOMPLETE','VIEW_IDENTITY','GROUP_IDENTITY','MEMBERS','FAILED'].map(c=>'RATIO_PROBE_'+c),
  ...api.CODES.map(c=>'RATIO_API_SOURCE_'+c)]);
class ProbeError extends Error{constructor(code){super('RATIO_PROBE_'+code);}}
const fail=code=>{throw new ProbeError(code);};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const hkDate=ms=>new Date(ms+8*3600000).toISOString().slice(0,10);
const id=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0?String(v):typeof v==='string'&&/^[1-9]\d{0,14}$/.test(v)?v:null;
const TOKEN_RE=/^[A-Za-z0-9._~+/=-]{20,16384}$/;

export function ratioProbeArgs(argv){
  let expectedMain,target,checkOnly=false;
  for(const arg of Array.isArray(argv)?argv:[null]){
    if(arg==='--check-plan'&&!checkOnly)checkOnly=true;
    else if(typeof arg==='string'&&/^--expected-main=[a-f0-9]{40}$/.test(arg)&&expectedMain===undefined)expectedMain=arg.slice(16);
    else if(typeof arg==='string'&&/^--target=\d{4}-\d{2}-\d{2}$/.test(arg)&&target===undefined)target=arg.slice(9);
    else fail('ARGUMENT');
  }
  if(!expectedMain||!date(target))fail('ARGUMENT');
  return Object.freeze({expectedMain,target,checkOnly});
}
// Exact owner dispatch at the exact main, first attempt. The target is the
// owner's own input, at most four Hong Kong days old and never in the future.
export function validateRatioProbeAdmission({args,env,event,now}){
  const simple=!!env&&typeof env==='object'&&!types.isProxy(env);
  if(!simple||env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==REPO||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_SHA!==args.expectedMain
    ||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_ACTOR_ID!==String(OWNER)||env.GITHUB_RUN_ATTEMPT!=='1'
    ||FORBIDDEN.some(k=>env[k]!==undefined)||CLOUD_CREDENTIAL_PATHS.some(k=>env[k]!==undefined&&env[k]!=='')
    ||(args.checkOnly?PRIVATE.some(k=>env[k]!==undefined):PRIVATE.some(k=>typeof env[k]!=='string'||!env[k]||env[k].length>8192||/[\r\n\0]/.test(env[k]))))fail('ENVIRONMENT');
  const i=event?.inputs;
  if(!object(event)||event.sender?.id!==OWNER||event.repository?.full_name!==REPO||!object(i)
    ||Object.keys(i).some(k=>![...RATIO_PROBE_INPUTS,...OFF,...BLANK].includes(k))
    ||![true,'true'].includes(i.source_probe_once)||i.source_probe_main!==args.expectedMain||i.source_probe_target!==args.target
    ||OFF.some(k=>!off(i[k]))||BLANK.some(k=>!blank(i[k])))fail('EVENT');
  const clock=now.getTime();if(!Number.isFinite(clock))fail('TARGET_DATE');
  const age=(Date.parse(hkDate(clock)+'T00:00:00Z')-Date.parse(args.target+'T00:00:00Z'))/86400000;
  if(!Number.isInteger(age)||age<0||age>4)fail('TARGET_DATE');
}
// The same pagination / incomplete markers the ordinary fee reader rejects.
function complete(payload){
  if(!object(payload))fail('SHAPE');
  if(payload.links?.next||payload.pagination?.next_page||payload.meta?.pagination?.next_page||payload.meta?.next_page
    ||payload.next_page||payload.has_more===true||payload.complete===false||payload.restricted===true||payload.limited===true||payload.truncated===true)fail('INCOMPLETE');
  return payload;
}
const listed=(payload,key)=>{complete(payload);if(!Array.isArray(payload[key])||payload[key].length>5000)fail('SHAPE');return payload[key];};
const kind=v=>v===null?'null':Array.isArray(v)?'array':['string','number','boolean','object'].includes(typeof v)?typeof v:'other';
const moreThanCents=v=>typeof v==='number'&&Number.isFinite(v)&&!/^-?\d+(?:\.\d{1,2})?$/.test(String(v));

// Value-free description of the report: field kinds for a fixed list of
// names and counts of rows that the strict projection would refuse. No row
// content, name, identifier or amount is copied.
export function ratioReportShapeFacts(report){
  const r=object(report)?report:{},holdings=Array.isArray(r.holdings)?r.holdings:[],cash=Array.isArray(r.cash_accounts)?r.cash_accounts:[];
  const first=object(holdings[0])?holdings[0]:{},firstCash=object(cash[0])?cash[0]:{};
  const kinds=(o,names)=>Object.fromEntries(names.map(n=>[n,Object.hasOwn(o,n)?kind(o[n]):'absent']));
  const count=(rows,test)=>rows.filter(x=>{try{return !object(x)||test(x);}catch{return true;}}).length;
  return {
    report:kinds(r,['portfolio_id','value','grouping','custom_group','currency','start_date','end_date','include_sales','holdings','cash_accounts','sub_totals','combined_holdings','percentages_annualised']),
    grouping:api.GROUPINGS.includes(r.grouping)?r.grouping:'OTHER',
    currencyIsUsd:r.currency?.code==='USD',
    hasHoldings:holdings.length>0,hasCash:cash.length>0,
    holding:kinds(first,['id','instrument','quantity','value','valid_position','limited','portfolio','group_id','group_name']),
    instrument:kinds(object(first.instrument)?first.instrument:{},['code','market_code','name']),
    holdingPortfolio:kinds(object(first.portfolio)?first.portfolio:{},['id','name','consolidated']),
    cash:kinds(firstCash,['id','name','value','portfolio','currency']),
    anomalies:{
      holdingsNotUnlimited:count(holdings,h=>h.limited!==false),
      holdingsWithoutValidPosition:count(holdings,h=>h.valid_position!==true),
      holdingValuesBeyondCents:count(holdings,h=>moreThanCents(h.value)),
      holdingValuesNotNumeric:count(holdings,h=>typeof h.value!=='number'||!Number.isFinite(h.value)),
      holdingValuesNegative:count(holdings,h=>typeof h.value==='number'&&h.value<0),
      holdingsWithoutGroupName:count(holdings,h=>typeof h.group_name!=='string'||!h.group_name),
      cashValuesBeyondCents:count(cash,c=>moreThanCents(c.value)),
      cashValuesNotNumeric:count(cash,c=>typeof c.value!=='number'||!Number.isFinite(c.value)),
      cashValuesNegative:count(cash,c=>typeof c.value==='number'&&c.value<0),
      reportValueBeyondCents:moreThanCents(r.value)?1:0
    }
  };
}
// Value-free description of one performance report: which API field names
// each row kind carries and the kinds of their values across all rows. Only
// field names of the API's own snake_case form are listed; no value, name,
// identifier or row count is copied.
const FIELD=/^[a-z][a-z0-9_]{0,47}$/;
function fieldKinds(rows){
  const seen=new Map();let other=0;
  for(const row of rows){
    if(!object(row)){other++;continue;}
    for(const [k,v]of Object.entries(row)){if(!FIELD.test(k)||!seen.has(k)&&seen.size>=80){other++;continue;}const s=seen.get(k)||new Set();s.add(kind(v));seen.set(k,s);}
  }
  const out={};for(const k of [...seen.keys()].sort())out[k]=[...seen.get(k)].sort().join('|');
  return {fields:out,unlisted:other>0};
}
export function ratioPerformanceShapeFacts(report,expected){
  const r=object(report)?report:{},list=k=>Array.isArray(r[k])?r[k]:[];
  const holdings=list('holdings'),subs=list('sub_totals'),cash=list('cash_accounts');
  const count=(rows,test)=>rows.filter(x=>{try{return !object(x)||test(x);}catch{return true;}}).length;
  const groupNames=new Set(holdings.map(h=>object(h)?h.group_name:null).filter(n=>typeof n==='string'&&n));
  return {
    echoes:{startDate:r.start_date===expected.start,endDate:r.end_date===expected.end,includeSales:r.include_sales===true,groupId:id(r.custom_group?.id)===expected.groupId,groupName:r.custom_group?.name===expected.groupName,currencyIsUsd:r.currency?.code==='USD'},
    grouping:api.GROUPINGS.includes(r.grouping)?r.grouping:'OTHER',
    percentagesAnnualised:typeof r.percentages_annualised==='boolean'?r.percentages_annualised:null,
    has:{holdings:holdings.length>0,subTotals:subs.length>0,cash:cash.length>0,oneSubTotalPerGroupName:subs.length===groupNames.size},
    report:fieldKinds([Object.fromEntries(Object.entries(r).filter(([k])=>!['holdings','sub_totals','cash_accounts'].includes(k)))]),
    holding:fieldKinds(holdings),subTotal:fieldKinds(subs),cash:fieldKinds(cash),
    anomalies:{holdingsNotUnlimited:count(holdings,h=>h.limited!==false),holdingsWithoutGroupName:count(holdings,h=>typeof h.group_name!=='string'||!h.group_name),holdingsWithoutPortfolio:count(holdings,h=>!object(h.portfolio)||!id(h.portfolio.id))}
  };
}
const safeCode=error=>{const m=String(error?.message||'');return RATIO_PROBE_CODES.includes(m)?m:'RATIO_PROBE_FAILED';};
const newResult=()=>({schema:RATIO_PROBE_SCHEMA,mode:'probe',outcome:'FAILED',stage:'ADMISSION',code:null,diagnostic:null,requests:0,requestBudget:RATIO_PROBE_BUDGET.requests,facts:null});

// The overall deadline is a hard bound on the returned result: a timer from
// the start aborts any in-flight request, and no new request starts after it.
export async function runRatioSourceProbe(options={}){
  const state={budgetExceeded:false,deadlineExceeded:false},deadline=new AbortController(),result=newResult();
  let timer;
  const expired=new Promise(resolve=>{timer=setTimeout(()=>{state.deadlineExceeded=true;deadline.abort();resolve();},RATIO_PROBE_BUDGET.overallMs);});
  const work=probeWork(options,result,state,deadline.signal);
  try{
    if(await Promise.race([work.then(()=>true),expired.then(()=>false)]))return result;
    work.catch(()=>{});
    return {...result,outcome:'FAILED',code:'RATIO_PROBE_DEADLINE',diagnostic:null};
  }finally{clearTimeout(timer);}
}
async function probeWork({argv,env,event,now=new Date(),fetchImpl=globalThis.fetch,clock=()=>Date.now()}={},result,state,deadlineSignal){
  const started=clock();
  try{
    const args=ratioProbeArgs(argv);result.mode=args.checkOnly?'check-plan':'probe';
    validateRatioProbeAdmission({args,env,event,now});
    if(args.checkOnly){result.stage='COMPLETE';result.outcome='PLAN_OK';return result;}
    const request=async(url,init,maxBytes=2*1024*1024)=>{
      if(result.requests>=RATIO_PROBE_BUDGET.requests){state.budgetExceeded=true;fail('BUDGET');}
      if(state.deadlineExceeded||deadlineSignal.aborted||clock()-started>RATIO_PROBE_BUDGET.overallMs){state.deadlineExceeded=true;fail('DEADLINE');}
      result.requests++;
      return boundedJson(fetchImpl,url,{...init,signal:deadlineSignal},{timeoutMs:RATIO_PROBE_BUDGET.requestMs,maxBytes});
    };
    result.stage='TOKEN';
    const granted=await request(API+'/oauth2/token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'client_credentials',client_id:env.FEE_CLOUD_SHARESIGHT_CLIENT_ID,client_secret:env.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET}).toString()});
    if(!object(granted)||typeof granted.access_token!=='string'||!TOKEN_RE.test(granted.access_token)||String(granted.token_type||'').toLowerCase()!=='bearer')fail('AUTH_RESPONSE');
    let token=granted.access_token;
    const get=(route,maxBytes)=>request(API+route,{method:'GET',headers:{Accept:'application/json',Authorization:'Bearer '+token,'User-Agent':'fee-console-ratio-probe/1.0'}},maxBytes);
    const facts=result.facts={};

    result.stage='VIEWS';
    const views=listed(await get('/api/v3/portfolios?consolidated=true'),'portfolios').filter(v=>object(v)&&v.consolidated===true&&v.name===RATIO_PROBE_VIEW);
    facts.consolidatedViewMatches=views.length;
    const viewId=views.length===1?id(views[0].id):null;if(!viewId)fail('VIEW_IDENTITY');
    facts.viewCurrencyIsUsd=views[0].currency_code==='USD';
    const declared=Array.isArray(views[0].portfolio_ids)?views[0].portfolio_ids.map(id):null;
    facts.viewDeclaresMembers=declared!==null&&declared.every(Boolean);

    result.stage='PORTFOLIOS';
    const names=new Map();
    for(const p of listed(await get('/api/v2/portfolios.json'),'portfolios')){const pid=object(p)?id(p.id):null;if(pid&&typeof p.name==='string'&&p.name)names.set(pid,p.name);}

    result.stage='GROUPS';
    const listedGroups=listed(await get('/api/v2/groups.json'),'groups'),groups=listedGroups.filter(g=>object(g)&&g.name===RATIO_PROBE_GROUP);
    facts.groupMatches=groups.length;
    const groupId=groups.length===1?id(groups[0].id):null;if(!groupId)fail('GROUP_IDENTITY');

    result.stage='REPORT';
    const d=args.target;
    const payload=complete(await get(`/api/v3/portfolios/${viewId}/performance?consolidated=true&custom_group_id=${groupId}&end_date=${d}&grouping=custom_group&include_limited=true&include_sales=false&report_combined=false&start_date=${d}`,RATIO_PROBE_BUDGET.reportBytes));
    facts.rootHasOnlyKnownKeys=Object.keys(payload).every(k=>['report','api_transaction','links'].includes(k));
    if(!object(payload.report))fail('SHAPE');
    const report=complete(payload.report);
    facts.shape=ratioReportShapeFacts(report);

    result.stage='PROJECTION';
    // Members: the view's own declared list when it supplies one, otherwise
    // the distinct portfolios the report rows carry. Names come only from the
    // account's own portfolio list, never from a file or an argument.
    const observed=new Set();
    for(const row of [...(Array.isArray(report.holdings)?report.holdings:[]),...(Array.isArray(report.cash_accounts)?report.cash_accounts:[])]){const pid=object(row?.portfolio)?id(row.portfolio.id):null;if(pid)observed.add(pid);}
    const memberIds=facts.viewDeclaresMembers?[...new Set(declared)]:[...observed];
    facts.membersSource=facts.viewDeclaresMembers?'view':'report-rows';
    facts.memberCountIsTen=memberIds.length===10;
    facts.everyMemberListed=memberIds.every(m=>names.has(m));
    facts.observedWithinMembers=[...observed].every(m=>memberIds.includes(m));
    if(!facts.memberCountIsTen||!facts.everyMemberListed)fail('MEMBERS');
    const accounts=memberIds.map(m=>({id:m,name:names.get(m)}));
    facts.scopeMatchesReviewedTen=crypto.createHash('sha256').update(JSON.stringify(accounts.map(a=>a.name.replaceAll('&amp;','&')).sort())).digest('hex')===ALL_TOGETHER_SCOPE_SHA256;
    const projected=api.project({schema:api.CAPTURE,provider:'Sharesight',view:{id:viewId,name:RATIO_PROBE_VIEW},group:{id:groupId,name:RATIO_PROBE_GROUP},asOf:d,capturedAt:new Date(now.getTime()).toISOString(),accounts,report});
    const delta=Math.abs(projected.totals.reportDeltaCents);
    facts.projection={responseGrouping:projected.responseGrouping,reportTotalEqualsRows:delta===0,reportTotalDifference:delta===0?'NONE':delta<=100?'AT_MOST_ONE_USD':delta<=10000?'AT_MOST_100_USD':'OVER_100_USD',membersWithoutRows:projected.accountsWithoutRows.length,
      categoriesWithinKnownFour:projected.positions.some(p=>['VC/PE','对冲基金','常青基金'].includes(p.sharesightCategory))};
    // Read-only shape check of the eight performance reports. A report that
    // cannot be read is recorded by its fixed code and the next one is still
    // tried: the classification result above already stands on its own.
    result.stage='PERFORMANCE';
    const allGroups=listedGroups,performance=facts.performance={complete:false,reports:{}};
    const oneYear=new Date(Date.parse(d+'T00:00:00Z'));oneYear.setUTCFullYear(oneYear.getUTCFullYear()-1);
    const starts={all:ALL_WINDOW_START,oneYear:oneYear.toISOString().slice(0,10)};
    let reference=null,good=0;
    for(const [key,name]of Object.entries(RATIO_PROBE_PERFORMANCE_GROUPS)){
      const matches=allGroups.filter(g=>object(g)&&g.name===name),gid=matches.length===1?id(matches[0].id):null;
      for(const window of RATIO_PROBE_PERFORMANCE_WINDOWS){
        const slot=key+'.'+window;
        if(!gid){performance.reports[slot]={read:false,code:'RATIO_PROBE_GROUP_IDENTITY'};continue;}
        if(result.requests>=RATIO_PROBE_BUDGET.requests||state.deadlineExceeded||deadlineSignal.aborted){performance.reports[slot]={read:false,code:'RATIO_PROBE_BUDGET'};continue;}
        try{
          const body=complete(await get(`/api/v3/portfolios/${viewId}/performance?consolidated=true&custom_group_id=${gid}&end_date=${d}&grouping=custom_group&include_limited=true&include_sales=true&report_combined=false&start_date=${starts[window]}`,RATIO_PROBE_BUDGET.reportBytes));
          if(!object(body.report))fail('SHAPE');
          const shape=ratioPerformanceShapeFacts(complete(body.report),{start:starts[window],end:d,groupId:gid,groupName:name}),text=JSON.stringify([shape.report,shape.holding,shape.subTotal,shape.cash]);
          // The full field list is printed once; later reports say whether theirs is identical.
          if(reference===null){reference=text;performance.reports[slot]={read:true,...shape};}
          else performance.reports[slot]={read:true,echoes:shape.echoes,grouping:shape.grouping,percentagesAnnualised:shape.percentagesAnnualised,has:shape.has,anomalies:shape.anomalies,sameFieldsAsFirst:text===reference,...(text===reference?{}:{report:shape.report,holding:shape.holding,subTotal:shape.subTotal,cash:shape.cash})};
          good++;
        }catch(error){
          if(state.deadlineExceeded||deadlineSignal.aborted)throw error;
          const bounded=error instanceof BoundedJsonError;
          performance.reports[slot]={read:false,code:bounded?'RATIO_PROBE_TRANSPORT':safeCode(error),...(bounded?{httpCode:['HTTP','TYPE','SIZE','BODY','JSON','TIMEOUT','ABORTED','CONFIG'].includes(error.code)?error.code:'OTHER'}:{})};
        }
      }
    }
    performance.complete=good===8;

    // Where can a position's first-buy date come from? The same holdings and
    // trades routes the fee reader already uses, here for the ten members.
    // Only field names, enumerated codes and counts of anomalies are kept.
    result.stage='INCEPTION';
    const inception=facts.inception={consolidated:null,membersRead:0,memberCodes:[],holding:null,anomalies:null,classification:null,trades:null};
    const slot=async(route,key,use)=>{
      if(result.requests>=RATIO_PROBE_BUDGET.requests||state.deadlineExceeded||deadlineSignal.aborted)return {read:false,code:'RATIO_PROBE_BUDGET'};
      try{return {read:true,...use(listed(await get(route,RATIO_PROBE_BUDGET.reportBytes),key))};}
      catch(error){
        if(state.deadlineExceeded||deadlineSignal.aborted)throw error;
        const bounded=error instanceof BoundedJsonError;
        return {read:false,code:bounded?'RATIO_PROBE_TRANSPORT':safeCode(error),...(bounded?{httpCode:['HTTP','TYPE','SIZE','BODY','JSON','TIMEOUT','ABORTED','CONFIG'].includes(error.code)?error.code:'OTHER'}:{})};
      }
    };
    const dated=h=>object(h)&&date(h.inception_date);
    const coverage=rows=>rows.length===0?'NO_ROWS':rows.every(dated)?'ALL':rows.some(dated)?'SOME':'NONE';
    inception.consolidated=await slot(`/api/v3/portfolios/${viewId}/holdings?consolidated=true`,'holdings',rows=>({inceptionDates:coverage(rows),...fieldKinds(rows)}));
    const listing=new Map(),allRows=[],codes=new Set();
    for(const account of accounts){
      const got=await slot(`/api/v3/portfolios/${account.id}/holdings?consolidated=false`,'holdings',rows=>{for(const h of rows){allRows.push(h);const hid=object(h)?id(h.id):null;if(hid)listing.set(account.id+'|'+hid,h);}return {};});
      if(got.read)inception.membersRead++;else codes.add(got.code);
    }
    inception.memberCodes=[...codes].sort();
    inception.holding=fieldKinds(allRows);
    inception.anomalies={listedWithoutInceptionDate:allRows.filter(h=>!dated(h)).length,inceptionAfterTarget:allRows.filter(h=>dated(h)&&h.inception_date>d).length,listedWithoutId:allRows.filter(h=>!object(h)||!id(h.id)).length};
    // Every position of the classification report should be found, with a date.
    const held=(Array.isArray(report.holdings)?report.holdings:[]).map(h=>(object(h?.portfolio)?id(h.portfolio.id):null)+'|'+(object(h)?id(h.id):null));
    inception.classification={everyPositionListed:held.every(k=>listing.has(k)),positionsNotListed:held.filter(k=>!listing.has(k)).length,listedPositionsWithoutDate:held.filter(k=>listing.has(k)&&!dated(listing.get(k))).length};
    const enumerated=(rows,key,pattern)=>{const out=new Set();for(const r of rows){const v=object(r)?r[key]:undefined;out.add(typeof v==='string'&&pattern.test(v)?v:v===undefined?'ABSENT':'OTHER');}return [...out].sort().slice(0,40);};
    inception.trades=await slot(`/api/v3/portfolios/${accounts[0].id}/trades.json?consolidated=false&end_date=${d}`,'trades',rows=>({hasRows:rows.length>0,descriptionCodes:enumerated(rows,'description_code',/^[A-Z][A-Z_]{0,23}$/),states:enumerated(rows,'state',/^[a-z][a-z_]{0,15}$/),transactionDates:rows.length===0?'NO_ROWS':rows.every(r=>object(r)&&date(r.transaction_date))?'ALL':'NOT_ALL',withHoldingId:rows.length===0?'NO_ROWS':rows.every(r=>object(r)&&id(r.holding_id))?'ALL':'NOT_ALL',...fieldKinds(rows)}));
    token=null;
    result.stage='COMPLETE';result.outcome='REPORT_PROJECTED';return result;
  }catch(error){
    // Only this helper's own fixed error class and its value-free facts are
    // read. No message, URL, status text, header or body reaches the result.
    const bounded=error instanceof BoundedJsonError,transport=bounded?boundedJsonTransportDiagnostic(error):null;
    result.code=state.budgetExceeded?'RATIO_PROBE_BUDGET':state.deadlineExceeded?'RATIO_PROBE_DEADLINE':bounded?'RATIO_PROBE_TRANSPORT':safeCode(error);
    result.diagnostic=bounded&&!state.budgetExceeded&&!state.deadlineExceeded?{phase:transport?.phase||'RESPONSE',category:transport?.category||'REJECTED',httpCode:['HTTP','TYPE','SIZE','BODY','JSON','TIMEOUT','ABORTED','CONFIG'].includes(error.code)?error.code:'OTHER'}:null;
    return result;
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  (async()=>{
    let event=null;try{const p=process.env.GITHUB_EVENT_PATH;if(p&&fs.statSync(p).size<=256*1024)event=JSON.parse(fs.readFileSync(p,'utf8'));}catch{event=null;}
    const result=await runRatioSourceProbe({argv:process.argv.slice(2),env:process.env,event});
    console.log(JSON.stringify(result));
    process.exitCode=['PLAN_OK','REPORT_PROJECTED'].includes(result.outcome)?0:1;
  })().catch(()=>{console.log(JSON.stringify({schema:RATIO_PROBE_SCHEMA,outcome:'FAILED',code:'RATIO_PROBE_FAILED'}));process.exitCode=1;});
}
