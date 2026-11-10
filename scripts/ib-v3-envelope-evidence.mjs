// Read-only response-difference evidence for the three IB v3 routes of the
// reviewed 2026-11-06 revision window. It never decides source stability, never
// feeds a reader, writer, revision, report or publication, and never reads any
// other account, v2 cash/payout route, economic source or encrypted file.
// Output is fixed literals only: preset path categories, JSON types and change
// natures. No value, id, key name, count, position, URL, hash or exception text.
import fs from 'node:fs';
import path from 'node:path';
import {types} from 'node:util';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {boundedJson,BoundedJsonError} from './fee-http-json.mjs';
import {authorizeEnvelopeEvidence,recoveryMetadataDiagnostic,RECOVERY_METADATA_STAGES,RECOVERY_METADATA_REQUESTS,RECOVERY_METADATA_CATEGORIES} from './fee-report-producer.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const API='https://api.sharesight.com',NAME='IB-HK',REPO='huanwujoy-crypto/fee-console',OWNER=283054367,OID=/^[a-f0-9]{40}$/;
export const ENVELOPE_EVIDENCE_SCOPE=Object.freeze({contractId:'ib-source-revision-20261106-envelope-evidence-v2',
  targetDate:'2026-11-06',previousDate:'2026-11-05',anchorDate:'2026-11-04',rounds:2,durationMs:8*60000});
// Exactly the reader's own v3 requests for checkpoint 2026-11-04 -> target
// 2026-11-06 (from = 11-05, dated performance anchor..target one day each), in
// the reader's order and with its query text. Nothing else is ever requested.
const performance=d=>'consolidated=false&end_date='+d+'&grouping=investment_type&include_limited=false&include_sales=false&report_combined=false&start_date='+d;
export const ENVELOPE_ROUTES=Object.freeze([
  {label:'HOLDINGS_CATALOG',path:'holdings',query:'consolidated=false',body:'holdings'},
  {label:'PERFORMANCE_ANCHOR',path:'performance',query:performance('2026-11-04'),body:'report'},
  {label:'PERFORMANCE_PREVIOUS',path:'performance',query:performance('2026-11-05'),body:'report'},
  {label:'PERFORMANCE_TARGET',path:'performance',query:performance('2026-11-06'),body:'report'},
  {label:'TRADES_WINDOW',path:'trades.json',query:'consolidated=false&end_date=2026-11-06&start_date=2026-11-05',body:'trades'},
].map(r=>Object.freeze(r)));
// Per round: OAuth token, v2 portfolio list (identity only, never classified or
// output), then the five v3 GETs. Two sequential rounds; hard upper bound 14.
export const ENVELOPE_STEPS=Object.freeze(['TOKEN','PORTFOLIOS',...ENVELOPE_ROUTES.map(r=>r.label)]);
export const ENVELOPE_MAX_REQUESTS=ENVELOPE_EVIDENCE_SCOPE.rounds*ENVELOPE_STEPS.length;
export const ENVELOPE_CATEGORIES=Object.freeze([
  'ROOT','ROOT_API_TRANSACTION','ROOT_API_TRANSACTION_ID','ROOT_API_TRANSACTION_TIMESTAMP','ROOT_API_TRANSACTION_OTHER',
  'ROOT_LINKS','ROOT_LINKS_SELF','ROOT_LINKS_OTHER','ROOT_PAGING','ROOT_OTHER',
  'BODY','BODY_ROWSET','BODY_API_TRANSACTION','BODY_LINKS','BODY_CATALOG_UNCONSUMED',
  'BODY_ID','BODY_INSTRUMENT','BODY_PORTFOLIO','BODY_QUANTITY','BODY_AMOUNT','BODY_CURRENCY','BODY_DATE','BODY_TIMESTAMP',
  'BODY_STATE','BODY_TEXT','BODY_KIND','BODY_STRUCTURE','BODY_OTHER']);
export const ENVELOPE_CHANGES=Object.freeze(['VALUE','TYPE','ADDED','REMOVED','ORDER','MEMBER_ORDER','DUPLICATE_MEMBER']);
export const ENVELOPE_TYPES=Object.freeze(['null','boolean','number','string','object','array']);
export const ENVELOPE_KEYING=Object.freeze(['ID','POSITION']);
export const ENVELOPE_READ_CODES=Object.freeze(['CONFIG','HTTP','TYPE','SIZE','BODY','JSON','ABORTED','TIMEOUT','NETWORK','REFUSED']);
const CODES=Object.freeze(['ARGUMENT','ENVIRONMENT','HEAD','EXPIRED','ROUTE','BUDGET','READ','AUTH','IDENTITY','IDENTITY_CHANGED','SCOPE','PARSE','ADMISSION','RESULT','CLEANUP','FAILED']);
const ERRORS=new WeakMap();
const failure=(code,step=null,readCode=null)=>{const e=new Error('FEE_ENVELOPE_EVIDENCE_'+code);ERRORS.set(e,{code,step,readCode});return Object.freeze(e);};
const fail=(code,step,readCode)=>{throw failure(code,step,readCode);};

// ---- strict JSON tree: member order, duplicate members and number spelling are kept.
const TYPE_OF={z:'null',b:'boolean',n:'number',s:'string',o:'object',a:'array'};
export function parseEnvelopeJson(text){
  if(typeof text!=='string'||text.length>16*1024*1024)fail('PARSE');
  let i=0,nodes=0;const ws=()=>{while(i<text.length&&' \t\n\r'.includes(text[i]))i++;};
  const string=()=>{
    const m=/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;m.lastIndex=i;const r=m.exec(text);if(!r)fail('PARSE');
    i=m.lastIndex;return JSON.parse(r[0]);
  };
  const value=depth=>{
    if(++nodes>400000||depth>64)fail('PARSE');ws();const c=text[i];
    if(c==='{'){i++;const m=[];ws();if(text[i]==='}'){i++;return {t:'o',m};}
      for(;;){ws();if(text[i]!=='"')fail('PARSE');const k=string();ws();if(text[i++]!==':')fail('PARSE');m.push([k,value(depth+1)]);ws();
        if(text[i]===','){i++;continue;}if(text[i]==='}'){i++;return {t:'o',m};}fail('PARSE');}}
    if(c==='['){i++;const v=[];ws();if(text[i]===']'){i++;return {t:'a',v};}
      for(;;){v.push(value(depth+1));ws();if(text[i]===','){i++;continue;}if(text[i]===']'){i++;return {t:'a',v};}fail('PARSE');}}
    if(c==='"')return {t:'s',v:string()};
    for(const [word,node] of [['true',{t:'b',v:true}],['false',{t:'b',v:false}],['null',{t:'z',v:null}]])if(text.startsWith(word,i)){i+=word.length;return node;}
    const m=/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;m.lastIndex=i;const r=m.exec(text);if(!r||!r[0])fail('PARSE');i=m.lastIndex;return {t:'n',v:r[0]};
  };
  const root=value(0);ws();if(i!==text.length)fail('PARSE');return root;
}

// ---- fixed path categories. Key names choose a category and are then dropped.
const PAGING=new Set(['pagination','meta','next_page','has_more','complete','restricted','limited','truncated']);
const CATALOG_UNCONSUMED=new Set(['quantity','value','instrument_currency']);
const GROUP_KEYS={
  ID:['id','portfolio_id','holding_id','trade_id','payout_id','cash_account_id','instrument_id'],
  QUANTITY:['quantity'],
  AMOUNT:['value','amount','balance','balance_in_portfolio_currency','price','brokerage','gross_amount','resident_withholding_tax','tax_credit'],
  CURRENCY:['currency','currency_code','portfolio_currency','instrument_currency'],
  DATE:['date','date_time','start_date','end_date','paid_on','transaction_date'],
  TIMESTAMP:['timestamp','created_at','updated_at'],
  STATE:['valid_position','state','confirmed','non_taxable','include_sales','include_limited','consolidated','report_combined','grouping','portfolio_tz_name'],
  TEXT:['name','description','foreign_identifier','comments','annotation'],
  KIND:['description_code','cash_account_transaction_type'],
  STRUCTURE:['report','holdings','cash_accounts','trades','cash_account_transactions','portfolios'],
};
const KEY_GROUP=new Map(Object.entries(GROUP_KEYS).flatMap(([g,ks])=>ks.map(k=>[k,g])));
const PARENT_GROUP={instrument:'INSTRUMENT',portfolio:'PORTFOLIO',currency:'CURRENCY',instrument_currency:'CURRENCY',cash_account_transaction_type:'KIND'};
// A context is {zone, key, parent, depth, catalogRow}. zone is a fixed literal.
const ROOT_CTX=Object.freeze({zone:'ROOT'});
function childContext(ctx,key,route){
  switch(ctx.zone){
    case 'ROOT':
      if(key==='api_transaction')return {zone:'RAT'};
      if(key==='links')return {zone:'RL'};
      if(key===route.body)return {zone:'BODY_ROOT',key,parent:null};
      return {zone:PAGING.has(key)?'PAGING':'ROOT_OTHER'};
    case 'RAT':return {zone:key==='id'?'RAT_ID':key==='timestamp'?'RAT_TS':'RAT_OTHER'};
    case 'RL':return {zone:key==='self'?'RL_SELF':'RL_OTHER'};
    case 'RAT_ID':case 'RAT_TS':case 'RAT_OTHER':return {zone:'RAT_OTHER'};
    case 'RL_SELF':case 'RL_OTHER':return {zone:'RL_OTHER'};
    case 'PAGING':case 'ROOT_OTHER':case 'BLINKS':case 'BAT':case 'BCAT':return {zone:ctx.zone};
    default:
      if(key==='links')return {zone:'BLINKS'};
      if(key==='api_transaction')return {zone:'BAT'};
      if(ctx.catalogRow&&CATALOG_UNCONSUMED.has(key))return {zone:'BCAT'};
      return {zone:'BODY',key,parent:ctx.key};
  }
}
function elementContext(ctx,route){
  if(ctx.zone==='BODY_ROOT')return {zone:'BODY',key:ctx.key,parent:null,catalogRow:route.label==='HOLDINGS_CATALOG'};
  if(ctx.zone==='ROOT')return {zone:'ROOT_OTHER'};
  return {...ctx,catalogRow:false};
}
function category(ctx){
  switch(ctx.zone){
    case 'ROOT':return 'ROOT';case 'RAT':return 'ROOT_API_TRANSACTION';case 'RAT_ID':return 'ROOT_API_TRANSACTION_ID';
    case 'RAT_TS':return 'ROOT_API_TRANSACTION_TIMESTAMP';case 'RAT_OTHER':return 'ROOT_API_TRANSACTION_OTHER';
    case 'RL':return 'ROOT_LINKS';case 'RL_SELF':return 'ROOT_LINKS_SELF';case 'RL_OTHER':return 'ROOT_LINKS_OTHER';
    case 'PAGING':return 'ROOT_PAGING';case 'ROOT_OTHER':return 'ROOT_OTHER';case 'BODY_ROOT':return 'BODY';
    case 'BLINKS':return 'BODY_LINKS';case 'BAT':return 'BODY_API_TRANSACTION';case 'BCAT':return 'BODY_CATALOG_UNCONSUMED';
    default:return 'BODY_'+(PARENT_GROUP[ctx.parent]||KEY_GROUP.get(ctx.key)||'OTHER');
  }
}
const rowsetCategory=ctx=>ctx.zone==='BODY_ROOT'||ctx.zone==='BODY'?'BODY_ROWSET':category(ctx);

// ---- pairwise comparison of the same route between the two rounds.
const idOf=n=>{if(n?.t!=='o')return null;const ids=n.m.filter(([k])=>k==='id');return ids.length===1&&ids[0][1].t==='n'&&/^[1-9]\d{0,15}$/.test(ids[0][1].v)?ids[0][1].v:null;};
const keyedIds=list=>{const ids=list.map(idOf);return ids.every(Boolean)&&new Set(ids).size===ids.length?ids:null;};
export function compareEnvelopeBodies(route,textA,textB){
  if(!ENVELOPE_ROUTES.includes(route)||typeof textA!=='string'||typeof textB!=='string')fail('RESULT');
  const a=parseEnvelopeJson(textA),b=parseEnvelopeJson(textB),out=new Map(),keying=new Set();let changed=false;
  const note=(cat,typeNames,change)=>{let e=out.get(cat);if(!e)out.set(cat,e={types:new Set(),changes:new Set()});
    for(const t of typeNames)e.types.add(t);if(change){e.changes.add(change);changed=true;}};
  const one=(node,ctx,change)=>{
    note(category(ctx),[TYPE_OF[node.t]],change);
    if(node.t==='o')for(const [k,v] of node.m)one(v,childContext(ctx,k,route),change);
    else if(node.t==='a'){if(node.v.length)note(rowsetCategory(ctx),['array'],change);for(const v of node.v)one(v,elementContext(ctx,route),change);}
  };
  const both=(p,q,ctx)=>{
    const cat=category(ctx);
    if(!p||!q){one(p||q,ctx,p?'REMOVED':'ADDED');return;}
    note(cat,[TYPE_OF[p.t],TYPE_OF[q.t]]);
    if(p.t!==q.t){note(cat,[],'TYPE');
      for(const [node,change] of [[p,'REMOVED'],[q,'ADDED']]){
        if(node.t==='o')for(const [k,v] of node.m)one(v,childContext(ctx,k,route),change);
        if(node.t==='a')for(const v of node.v)one(v,elementContext(ctx,route),change);
      }
      return;}
    if(p.t==='o'){
      const map=n=>{const m=new Map();let dup=false;for(const [k,v] of n.m){if(m.has(k))dup=true;m.set(k,v);}return {m,dup};};
      const x=map(p),y=map(q);
      if(x.dup||y.dup)note(cat,[],'DUPLICATE_MEMBER');
      const order=n=>[...new Map(n.m).keys()];
      const common=order(p).filter(k=>y.m.has(k)),commonB=order(q).filter(k=>x.m.has(k));
      if(common.join('\u0000')!==commonB.join('\u0000'))note(cat,[],'MEMBER_ORDER');
      for(const k of new Set([...x.m.keys(),...y.m.keys()]))both(x.m.get(k),y.m.get(k),childContext(ctx,k,route));
      return;
    }
    if(p.t==='a'){
      const rows=rowsetCategory(ctx),element=elementContext(ctx,route),ip=keyedIds(p.v),iq=keyedIds(q.v);
      if(ip&&iq&&(p.v.length||q.v.length)){
        keying.add('ID');
        const mq=new Map(q.v.map((v,n)=>[iq[n],v])),mp=new Map(p.v.map((v,n)=>[ip[n],v]));
        if(ip.some(id=>!mq.has(id)))note(rows,['array'],'REMOVED');if(iq.some(id=>!mp.has(id)))note(rows,['array'],'ADDED');
        if(ip.filter(id=>mq.has(id)).join(',')!==iq.filter(id=>mp.has(id)).join(','))note(rows,['array'],'ORDER');
        for(const [n,id] of ip.entries())if(mq.has(id))both(p.v[n],mq.get(id),element);else one(p.v[n],element,'REMOVED');
        for(const [n,id] of iq.entries())if(!mp.has(id))one(q.v[n],element,'ADDED');
      }else{
        if(p.v.length||q.v.length)keying.add('POSITION');
        if(p.v.length>q.v.length)note(rows,['array'],'REMOVED');if(q.v.length>p.v.length)note(rows,['array'],'ADDED');
        for(let n=0;n<Math.max(p.v.length,q.v.length);n++)both(p.v[n],q.v[n],element);
      }
      return;
    }
    if(p.v!==q.v)note(cat,[],'VALUE');
  };
  both(a,b,ROOT_CTX);
  return Object.freeze({route:route.label,bytes:textA===textB?'SAME':'DIFF',structure:changed?'DIFF':'SAME',
    arrayKeying:ENVELOPE_KEYING.filter(k=>keying.has(k)),
    categories:ENVELOPE_CATEGORIES.filter(c=>out.has(c)).map(c=>Object.freeze({category:c,
      types:ENVELOPE_TYPES.filter(t=>out.get(c).types.has(t)),changes:ENVELOPE_CHANGES.filter(x=>out.get(c).changes.has(x))}))});
}
// Strict shape check for anything about to leave as evidence: literals only.
export function isEnvelopeRouteEvidence(v){
  const simple=x=>x&&typeof x==='object'&&!Array.isArray(x)&&!types.isProxy(x)&&Object.getPrototypeOf(x)===Object.prototype;
  const list=(x,allowed)=>Array.isArray(x)&&x.every(y=>allowed.includes(y))&&new Set(x).size===x.length&&x.join()===allowed.filter(y=>x.includes(y)).join();
  return Array.isArray(v)&&v.length===ENVELOPE_ROUTES.length&&v.every((r,n)=>simple(r)&&Object.keys(r).sort().join()==='arrayKeying,bytes,categories,route,structure'
    &&r.route===ENVELOPE_ROUTES[n].label&&['SAME','DIFF'].includes(r.bytes)&&['SAME','DIFF'].includes(r.structure)&&list(r.arrayKeying,ENVELOPE_KEYING)
    &&Array.isArray(r.categories)&&list(r.categories.map(c=>c?.category),ENVELOPE_CATEGORIES)
    &&r.categories.every(c=>simple(c)&&Object.keys(c).sort().join()==='category,changes,types'&&list(c.types,ENVELOPE_TYPES)&&c.types.length>0&&list(c.changes,ENVELOPE_CHANGES))
    &&(r.structure==='DIFF')===r.categories.some(c=>c.changes.length>0)&&(r.bytes==='SAME'?r.structure==='SAME':true));
}

// ---- the only network sequence. Sequential, no retry, no redirect, no
// pagination or route expansion; bodies stay in memory and are dropped.
const credential=v=>typeof v==='string'&&v.length>0&&v.length<=8192&&!/[\r\n\0]/.test(v);
function readReason(error){
  if(!error||typeof error!=='object'||types.isProxy(error)||Object.getPrototypeOf(error)!==BoundedJsonError.prototype)return 'REFUSED';
  const d=Object.getOwnPropertyDescriptor(error,'code');return d&&Object.hasOwn(d,'value')&&ENVELOPE_READ_CODES.includes(d.value)?d.value:'REFUSED';
}
export async function readEnvelopeEvidence({clientId,clientSecret,fetchImpl,beforeRound=async()=>{},afterRead=async()=>{}}={}){
  if(!credential(clientId)||!credential(clientSecret)||typeof fetchImpl!=='function'||typeof beforeRound!=='function'||typeof afterRead!=='function')fail('ENVIRONMENT');
  let used=0,identity=null;const rounds=[];
  const request=async(step,url,init)=>{
    if(++used>ENVELOPE_MAX_REQUESTS)fail('BUDGET',step);
    let response;
    try{response=await boundedJson(fetchImpl,url,init,{timeoutMs:20000,maxBytes:2*1024*1024,requireJsonType:true,includeBytes:true});}
    catch(error){if(ERRORS.has(error))throw error;fail('READ',step,readReason(error));}
    let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(response.bytes);}catch{fail('READ',step,'BODY');}finally{response.bytes.fill(0);}
    return {json:response.json,text};
  };
  try{
    for(let round=0;round<ENVELOPE_EVIDENCE_SCOPE.rounds;round++){
      await beforeRound(round);
      const auth=(await request('TOKEN',API+'/oauth2/token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({grant_type:'client_credentials',client_id:clientId,client_secret:clientSecret}).toString()})).json;
      if(typeof auth?.access_token!=='string'||!/^[A-Za-z0-9._~+/=-]{20,16384}$/.test(auth.access_token)||String(auth.token_type).toLowerCase()!=='bearer')fail('AUTH','TOKEN');
      const token=auth.access_token,secrets=[token,clientId,clientSecret].filter(s=>s.length>=8),get={method:'GET',headers:{Accept:'application/json',Authorization:'Bearer '+token}};
      const listing=(await request('PORTFOLIOS',API+'/api/v2/portfolios.json',get)).json;
      const matches=Array.isArray(listing?.portfolios)?listing.portfolios.filter(p=>p&&typeof p==='object'&&p.name===NAME):[];
      if(matches.length!==1||matches[0].currency_code!=='USD'||!Number.isSafeInteger(matches[0].id)||matches[0].id<=0)fail('IDENTITY','PORTFOLIOS');
      if(identity!==null&&identity!==matches[0].id)fail('IDENTITY_CHANGED','PORTFOLIOS');identity=matches[0].id;
      const bodies=[];
      for(const route of ENVELOPE_ROUTES){
        const {text}=await request(route.label,API+'/api/v3/portfolios/'+identity+'/'+route.path+'?'+route.query,get);
        if(secrets.some(s=>text.includes(s)))fail('SCOPE',route.label);
        bodies.push(text);
      }
      rounds.push(bodies);
    }
    await afterRead();
    const routes=ENVELOPE_ROUTES.map((route,n)=>compareEnvelopeBodies(route,rounds[0][n],rounds[1][n]));
    if(!isEnvelopeRouteEvidence(routes))fail('RESULT');
    return Object.freeze({routes,requestsUsed:used});
  }finally{rounds.length=0;identity=null;}
}

// ---- outer boundary for the executable: one deadline, fixed hosts and routes.
const GITHUB_READ=/^(?:git\/ref\/heads\/main|commits\/[a-f0-9]{40}(?:\?per_page=1|\/pulls\?per_page=100)|compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}\?per_page=100|git\/trees\/[a-f0-9]{40}\?recursive=1|pulls\/[1-9]\d*|issues\/(?:[1-9]\d*\/comments\?per_page=100|comments\/[1-9]\d*)|actions\/runs\/[1-9]\d*)$/;
const SHARESIGHT_GET=new Set(ENVELOPE_ROUTES.map(r=>r.path+'?'+r.query));
export function envelopeEvidenceTransport({fetchImpl=globalThis.fetch,clock=Date.now,durationMs=ENVELOPE_EVIDENCE_SCOPE.durationMs}={}){
  if(typeof fetchImpl!=='function'||typeof clock!=='function'||!Number.isSafeInteger(durationMs)||durationMs<1||durationMs>ENVELOPE_EVIDENCE_SCOPE.durationMs)fail('ENVIRONMENT');
  const started=clock(),controller=new AbortController();let closed=false,last=started,refusal=null;
  if(!Number.isSafeInteger(started)||started<0)fail('ENVIRONMENT');
  const timer=setTimeout(()=>controller.abort(),durationMs);timer.unref?.();
  // This boundary's own refusal is remembered as a fixed literal: a caller's
  // wrapper may turn the thrown error into a generic network failure.
  const refuse=code=>{refusal??=code;fail(code);};
  const active=()=>{const now=clock();if(closed||controller.signal.aborted||!Number.isSafeInteger(now)||now<last||now-started>=durationMs)refuse('EXPIRED');last=now;};
  const fetch=async(url,init={})=>{
    active();let u;try{u=new URL(url);}catch{refuse('ROUTE');}
    const method=init.method||'GET',prefix='/repos/'+REPO+'/';
    const oauth=u.href===API+'/oauth2/token';
    const github=u.origin==='https://api.github.com'&&u.pathname.startsWith(prefix)&&GITHUB_READ.test(u.pathname.slice(prefix.length)+u.search);
    const v3=/^\/api\/v3\/portfolios\/[1-9]\d{0,15}\/(holdings|performance|trades\.json)$/.exec(u.pathname);
    const sharesight=u.origin===API&&(u.pathname==='/api/v2/portfolios.json'&&u.search===''||v3&&SHARESIGHT_GET.has(v3[1]+u.search));
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!(oauth||github||sharesight)
      ||(oauth?method!=='POST':method!=='GET'||init.body!==undefined))refuse('ROUTE');
    const signal=init.signal?AbortSignal.any([init.signal,controller.signal]):controller.signal;
    let listener;
    const aborted=new Promise((_,reject)=>{listener=()=>{if(controller.signal.aborted)refusal??='EXPIRED';reject(failure('EXPIRED'));};if(signal.aborted)listener();else signal.addEventListener('abort',listener,{once:true});});
    try{const result=await Promise.race([fetchImpl(url,{...init,redirect:'error',signal}),aborted]);active();return result;}
    finally{signal.removeEventListener('abort',listener);}
  };
  return Object.freeze({fetch,assertCurrent:active,refusal:()=>refusal,close(){closed=true;clearTimeout(timer);controller.abort();}});
}

// ---- exact owner dispatch of this job only; every other input stays off.
const OFF=['ib_diagnostic_once','source_plan_check_only','source_acceptance_once','run_reviewed_once','source_probe_once'];
const BLANK=['ib_diagnostic_main','ratio_main','ratio_plan','source_from','source_target','source_main','manual_sync_completed_for','confirmed_main','recovery_main','report_kind','report_target','report_markets','source_probe_main','source_probe_target'];
const PRIVATE=['FEE_CLOUD_SHARESIGHT_CLIENT_ID','FEE_CLOUD_SHARESIGHT_CLIENT_SECRET'];
const FORBIDDEN=['NODE_OPTIONS','NODE_PATH','GH_TOKEN','GITHUB_TOKEN','FEE_DATA_KEY','FEE_ECON_GIST_ID','FEE_ECON_GITHUB_TOKEN','FEE_ECON_FILE','FEE_ECON_V3_FILE',
  'FEE_CLOUD_GITHUB_TOKEN','FEE_RATIO_MANAGER_TOKEN','FEE_IB_DIAGNOSTIC_ACTIONS_TOKEN','IB_MANAGER_READ_ENABLED','IB_MANAGER_BASELINE_SHA256','RATIO_STORAGE_ACCESS_TOKEN'];
// The WIF step exports a credential file path for later steps; this job blanks
// it for the probe step. A non-empty value means the identity was handed over.
const CLOUD_CREDENTIAL_PATHS=['GOOGLE_APPLICATION_CREDENTIALS','CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE','GOOGLE_GHA_CREDS_PATH'];
const simple=v=>v&&typeof v==='object'&&!types.isProxy(v)&&Object.getPrototypeOf(v)===Object.prototype;
export function envelopeEvidenceArgs(argv){
  let expectedMain,checkOnly=false;
  for(const arg of argv)if(arg==='--check-plan'&&!checkOnly)checkOnly=true;
  else if(typeof arg==='string'&&/^--expected-main=[a-f0-9]{40}$/.test(arg)&&expectedMain===undefined)expectedMain=arg.slice(16);
  else fail('ARGUMENT');
  if(!OID.test(expectedMain||''))fail('ARGUMENT');return Object.freeze({expectedMain,checkOnly});
}
export function validateEnvelopeEvidenceEvent({env,event,expectedMain,checkOnly=false,execArgv=[]}={}){
  if(!simple(env)||!simple(event)||!OID.test(expectedMain||'')||typeof checkOnly!=='boolean'
    ||!Array.isArray(execArgv)||execArgv.length||FORBIDDEN.some(k=>Object.hasOwn(env,k))
    ||Object.keys(env).some(k=>/^(LD_|DYLD_)/.test(k))||CLOUD_CREDENTIAL_PATHS.some(k=>env[k]!==undefined&&env[k]!=='')
    ||env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==REPO||env.GITHUB_REF!=='refs/heads/main'
    ||env.GITHUB_SHA!==expectedMain||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_ACTOR_ID!==String(OWNER)
    ||env.GITHUB_ACTOR!=='huanwujoy-crypto'||env.GITHUB_TRIGGERING_ACTOR!==undefined&&env.GITHUB_TRIGGERING_ACTOR!=='huanwujoy-crypto'
    ||env.GITHUB_RUN_ATTEMPT!=='1'||!/^[1-9]\d{7,15}$/.test(env.GITHUB_RUN_ID||'')
    ||!credential(env.FEE_REPORT_ACTIONS_TOKEN)||!/^[A-Za-z0-9_.-]{20,8192}$/.test(env.FEE_REPORT_ACTIONS_TOKEN)
    ||event.sender?.id!==OWNER||event.sender?.login!=='huanwujoy-crypto'||event.sender?.type!=='User'
    ||event.repository?.full_name!==REPO||event.repository?.owner?.id!==OWNER||event.repository?.default_branch!=='main')fail('ENVIRONMENT');
  const i=event.inputs;
  if(!simple(i)||![true,'true'].includes(i.ib_envelope_once)||i.ib_envelope_main!==expectedMain
    ||Object.keys(i).some(k=>!['ib_envelope_once','ib_envelope_main',...OFF,...BLANK].includes(k))
    ||BLANK.some(k=>i[k]!==undefined&&i[k]!=='')||OFF.some(k=>i[k]!==undefined&&![false,'false'].includes(i[k])))fail('ARGUMENT');
  if(checkOnly?PRIVATE.some(k=>Object.hasOwn(env,k)):PRIVATE.some(k=>!credential(env[k])))fail('ENVIRONMENT');
  return true;
}

export const ENVELOPE_TRANSPORT_REFUSALS=Object.freeze(['ROUTE','EXPIRED']);
const ADMISSION_CODES=['RECOVERY_SCOPE','RECOVERY_RELEASE','RECOVERY_METADATA','RECOVERY_RUN','RECOVERY_CONSUMED'].map(c=>'FEE_REPORT_'+c);
export function envelopeEvidenceFailure(error){
  const own=ERRORS.get(error);
  if(!own){
    // Only the producer's exact fixed admission codes pass through; nothing else.
    let message;try{if(error&&typeof error==='object'&&!types.isProxy(error))message=Object.getOwnPropertyDescriptor(error,'message')?.value;}catch{}
    if(!ADMISSION_CODES.includes(message))return {reasonCode:'FEE_ENVELOPE_EVIDENCE_FAILED'};
    // GitHub verification failures add the producer's fixed sub-location, read
    // by error identity and re-checked literal by literal; nothing else.
    const d=message==='FEE_REPORT_RECOVERY_METADATA'?recoveryMetadataDiagnostic(error):null;
    return {reasonCode:message,...(d&&RECOVERY_METADATA_STAGES.includes(d.stage)&&RECOVERY_METADATA_REQUESTS.includes(d.request)&&RECOVERY_METADATA_CATEGORIES.includes(d.category)
      ?{metadataStage:d.stage,metadataRequest:d.request,metadataCategory:d.category}:{})};
  }
  if(!CODES.includes(own.code))return {reasonCode:'FEE_ENVELOPE_EVIDENCE_FAILED'};
  return {reasonCode:'FEE_ENVELOPE_EVIDENCE_'+own.code,...(ENVELOPE_STEPS.includes(own.step)?{failedStep:own.step}:{}),
    ...(own.code==='READ'&&ENVELOPE_READ_CODES.includes(own.readCode)?{readCode:own.readCode}:{})};
}
const result=(status,extra={})=>Object.freeze({schema:'fee-console.ib-v3-envelope-evidence-result.v1',status,
  contractId:ENVELOPE_EVIDENCE_SCOPE.contractId,targetDate:ENVELOPE_EVIDENCE_SCOPE.targetDate,reasonCode:'NONE',
  stabilityDecisionChanged:false,reportGenerated:false,publicationReady:false,...extra});

// Dependency injection is for synthetic tests only; the executable pins them.
export async function inspectEnvelopeEvidence({checkOnly=false,authorize,checkCheckout,read,cleanup,assertCurrent=()=>{},transportRefusal=()=>null}={}){
  let admission,answer,error,cleanupFailed=false;
  try{
    assertCurrent();checkCheckout();admission=await authorize();assertCurrent();
    if(!admission||typeof admission.checkCurrent!=='function'||typeof admission.close!=='function')fail('ADMISSION');
    await admission.checkCurrent();assertCurrent();checkCheckout();
    if(checkOnly)answer=result('plan-verified');
    else{
      const evidence=await read({beforeRound:async()=>{assertCurrent();await admission.checkCurrent();assertCurrent();checkCheckout();},
        afterRead:async()=>{assertCurrent();await admission.checkCurrent();assertCurrent();checkCheckout();}});
      if(!evidence||!isEnvelopeRouteEvidence(evidence.routes)||!Number.isSafeInteger(evidence.requestsUsed)||evidence.requestsUsed!==ENVELOPE_MAX_REQUESTS)fail('RESULT');
      answer=result('verified',{requestsUsed:evidence.requestsUsed,routes:evidence.routes.map(r=>({...r,arrayKeying:[...r.arrayKeying],
        categories:r.categories.map(c=>({category:c.category,types:[...c.types],changes:[...c.changes]}))}))});
    }
  }catch(e){error=e;}
  finally{
    try{admission?.close();}catch{cleanupFailed=true;}
    try{await cleanup?.();}catch{cleanupFailed=true;}
    admission=null;
  }
  if(cleanupFailed)return result('incomplete',{reasonCode:'FEE_ENVELOPE_EVIDENCE_CLEANUP'});
  if(!error)return answer;
  let refusal=null;try{refusal=transportRefusal();}catch{}
  return result('incomplete',{...envelopeEvidenceFailure(error),...(ENVELOPE_TRANSPORT_REFUSALS.includes(refusal)?{transportRefusal:refusal}:{})});
}

function readRegular(filename,max){
  let fd;try{fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const before=fs.fstatSync(fd);
    if(!before.isFile()||before.size<1||before.size>max)fail('ENVIRONMENT');const bytes=fs.readFileSync(fd);
    if(bytes.length!==before.size)fail('ENVIRONMENT');return bytes;
  }finally{if(fd!==undefined)fs.closeSync(fd);}
}
function checkout(expectedMain){
  const git=args=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000,maxBuffer:1024*1024}).trim();
  if(git(['rev-parse','HEAD'])!==expectedMain||git(['diff','--name-only','HEAD'])
    ||git(['ls-files','--others','--exclude-standard']).split('\n').filter(Boolean).some(f=>!/^gha-creds-[a-f0-9]+\.json$/.test(f)))fail('HEAD');
}

async function main(){
  const options=envelopeEvidenceArgs(process.argv.slice(2)),env=process.env;
  const event=JSON.parse(readRegular(env.GITHUB_EVENT_PATH,65536));
  validateEnvelopeEvidenceEvent({env:{...env},event,...options,execArgv:process.execArgv});
  const transport=envelopeEvidenceTransport();
  try{
    const answer=await inspectEnvelopeEvidence({checkOnly:options.checkOnly,assertCurrent:transport.assertCurrent,transportRefusal:transport.refusal,
      checkCheckout:()=>checkout(options.expectedMain),
      authorize:()=>authorizeEnvelopeEvidence({expectedMain:options.expectedMain,now:new Date(),currentRunId:env.GITHUB_RUN_ID,actionsToken:env.FEE_REPORT_ACTIONS_TOKEN,fetchImpl:transport.fetch}),
      read:hooks=>readEnvelopeEvidence({clientId:env.FEE_CLOUD_SHARESIGHT_CLIENT_ID,clientSecret:env.FEE_CLOUD_SHARESIGHT_CLIENT_SECRET,fetchImpl:transport.fetch,...hooks}),
      cleanup(){for(const name of [...PRIVATE,'FEE_REPORT_ACTIONS_TOKEN'])delete env[name];}});
    console.log(JSON.stringify(answer));if(!['verified','plan-verified'].includes(answer.status))process.exitCode=1;
  }finally{transport.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify(result('incomplete',envelopeEvidenceFailure(error))));process.exitCode=1;});
