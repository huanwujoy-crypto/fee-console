// Fixed repository GET transport for the published-base verifier. The reviewed
// runtime must explicitly supply its existing short-lived Actions token and fetch.
// This module discovers no credentials, grants no permissions and has no CLI.
import {types} from 'node:util';
import {boundedJson,BoundedJsonError} from './fee-http-json.mjs';

const PREFIX='FEE_SYNC_GITHUB_',failures=new WeakMap();
const REPO='/repos/huanwujoy-crypto/fee-console/',ORIGIN='https://api.github.com';
const ROUTE=/^(?:git\/ref\/heads\/(?:main|market-data-cache)|git\/matching-refs\/heads\/codex\/fee-daily-\d{8}-|contents\/(?:data\.json|fee-data-health\.json|benchmark-close\.json)\?ref=[a-f0-9]{40}|commits\/[a-f0-9]{40}|actions\/workflows\/validate-fee-data\.yml\/runs\?branch=codex%2Ffee-daily-\d{8}-[a-z0-9]{6}&per_page=5)$/;
const HTTP_CODES=new Set(['TIMEOUT','ABORTED','HTTP','TYPE','SIZE','BODY','JSON','NETWORK']);
function fail(code){const e=new Error(PREFIX+code);failures.set(e,code);throw Object.freeze(e);}
export const syncGithubReadFailureCode=error=>PREFIX+(failures.get(error)||'REFUSED');
function dataObject(value,required,optional=[],code='CONFIG'){
  try{
    if(!value||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(code);
    const ds=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(ds);
    if(required.some(k=>!Object.hasOwn(ds,k))||keys.some(k=>typeof k!=='string'||![...required,...optional].includes(k)
      ||!Object.hasOwn(ds[k],'value')||!ds[k].enumerable))fail(code);
    return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
  }catch{fail(code);}
}
function httpFailure(error){
  // An injected fetch can throw arbitrary objects, getters or modified errors.
  // Never evaluate its message, cause, stack or arbitrary error-code getter.
  try{
    if(error&&typeof error==='object'&&!types.isProxy(error)&&error instanceof BoundedJsonError){
      const d=Object.getOwnPropertyDescriptor(error,'code');
      if(d&&Object.hasOwn(d,'value')&&HTTP_CODES.has(d.value))return d.value;
    }
  }catch{/* A failed classification is not source text. */}
  return 'REQUEST';
}

export function createSyncGithubRead(options){
  const c=dataObject(options,['token','fetchImpl'],['timeoutMs','maxBytes']);
  const timeoutMs=c.timeoutMs??15000,maxBytes=c.maxBytes??8*1024*1024;
  if(typeof c.token!=='string'||!c.token.length||c.token.length>8192||!/^[A-Za-z0-9_.-]+$/.test(c.token)
    ||typeof c.fetchImpl!=='function'||types.isProxy(c.fetchImpl)
    ||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>20000
    ||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>8*1024*1024)fail('CONFIG');
  let token=c.token,fetchImpl=c.fetchImpl,closed=false;
  // Do not retain a second options copy containing the token.
  c.token=null;c.fetchImpl=null;
  const active=new Set();
  const readGithubJson=async request=>{
    if(closed)fail('CLOSED');
    const r=dataObject(request,['method','path'],[],'SCOPE');
    if(r.method!=='GET'||typeof r.path!=='string'||r.path.length>512||/[\x00-\x20\x7f-\x9f]/.test(r.path)
      ||!r.path.startsWith(REPO)||!ROUTE.test(r.path.slice(REPO.length)))fail('SCOPE');
    const controller=new AbortController();let rejectClosed;
    const closing=new Promise((_,reject)=>{rejectClosed=reject;});
    const entry={controller,rejectClosed};active.add(entry);
    try{
      const result=await Promise.race([
        boundedJson(fetchImpl,ORIGIN+r.path,{method:'GET',redirect:'error',credentials:'omit',signal:controller.signal,
          headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',Authorization:'Bearer '+token}},
          {timeoutMs,maxBytes,requireJsonType:true}),closing,
      ]);
      if(closed)fail('CLOSED');
      if(!result||typeof result!=='object')fail('RESPONSE');
      return result;
    }catch(error){
      if(closed)fail('CLOSED');
      if(failures.has(error))throw error;
      fail(httpFailure(error));
    }finally{
      active.delete(entry);controller.abort();entry.rejectClosed=null;
    }
  };
  return Object.freeze({readGithubJson,close(){
    if(closed)return;closed=true;token=null;fetchImpl=null;
    for(const entry of active){entry.controller.abort();entry.rejectClosed?.(new Error(PREFIX+'CLOSED'));}
    active.clear();
    // References owned here are released; JS immutable strings or copies retained
    // by the trusted transport/caller cannot be promised physical memory erasure.
  }});
}
