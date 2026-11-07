// Explicit existing-token transport for the one reviewed historical revision.
// No credential discovery, write, retries, log output, or arbitrary URL ingress.
import {types} from 'node:util';
import {boundedJson,BoundedJsonError} from './fee-http-json.mjs';

const REPO='/repos/huanwujoy-crypto/fee-console/',ORIGIN='https://api.github.com';
const instances=new WeakSet(),failures=new WeakMap();
const JSON_ROUTE=/^(?:git\/ref\/heads\/main|(?:git\/)?commits\/[a-f0-9]{40}|git\/trees\/[a-f0-9]{40}|contents\/(?:data\.json|fee-data-health\.json)\?ref=[a-f0-9]{40}|actions\/runs\/[1-9][0-9]{0,15}(?:\/jobs\?per_page=100)?)$/;
const JSON_CODES=Object.freeze(['CONFIG','HTTP','TYPE','SIZE','BODY','JSON','ABORTED','TIMEOUT','NETWORK']);
const HTTP_CODES=Object.freeze({400:'BAD_REQUEST',401:'UNAUTHORIZED',403:'FORBIDDEN',404:'NOT_FOUND',408:'TIMEOUT',
  409:'CONFLICT',410:'GONE',422:'UNPROCESSABLE',429:'RATE_LIMIT'});
const HTTP_CLASSES=Object.freeze([...Object.values(HTTP_CODES),'SERVER','OTHER']);
export const IB_REVISION_GITHUB_FAILURE_CODES=Object.freeze([
  'INPUT','CONFIG','CLOSED','REQUEST','SCOPE','RESPONSE','LOG','LOG_HOST','REFUSED',...JSON_CODES.map(code=>'JSON_'+code),
  ...HTTP_CLASSES.map(code=>'JSON_HTTP_'+code),
].map(code=>'IB_REVISION_GITHUB_'+code));
function failure(code){const e=new Error('IB_REVISION_GITHUB_'+code);failures.set(e,code);return Object.freeze(e);}
function fail(code){throw failure(code);}
function boundedFailureCode(error){
  // Only the bounded helper's fixed native enum is diagnostic evidence. Never
  // inspect/coerce message, stack, cause, URL or response content for a code.
  if(!error||typeof error!=='object'||types.isProxy(error)||Object.getPrototypeOf(error)!==BoundedJsonError.prototype)return null;
  const descriptor=Object.getOwnPropertyDescriptor(error,'code');
  return descriptor&&Object.hasOwn(descriptor,'value')&&JSON_CODES.includes(descriptor.value)?'JSON_'+descriptor.value:null;
}
export const revisionGithubFailureCode=e=>'IB_REVISION_GITHUB_'+(failures.get(e)||'REFUSED');
export const isRevisionGithubRead=value=>instances.has(value);
function plain(value,required,optional=[]){
  if(!value||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('INPUT');
  const d=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(d);
  if(required.some(k=>!Object.hasOwn(d,k))||keys.some(k=>typeof k!=='string'||![...required,...optional].includes(k)||!Object.hasOwn(d[k],'value')||!d[k].enumerable))fail('INPUT');
  return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
export function createRevisionGithubRead(options){
  const c=plain(options,['token','fetchImpl','clock'],['timeoutMs']);
  const timeoutMs=c.timeoutMs??15000;
  if(typeof c.token!=='string'||c.token.length<20||c.token.length>8192||!/^[A-Za-z0-9_.-]+$/.test(c.token)
    ||typeof c.fetchImpl!=='function'||types.isProxy(c.fetchImpl)||typeof c.clock!=='function'||types.isProxy(c.clock)
    ||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>20000)fail('CONFIG');
  let token=c.token,fetchImpl=c.fetchImpl,closed=false;c.token=null;c.fetchImpl=null;
  const active=new Set();
  const live=()=>{if(closed)fail('CLOSED');};
  const headers=()=>({Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',Authorization:'Bearer '+token});
  const run=async(operation,jsonMode=false)=>{
    live();const controller=new AbortController();let timer,rejectClose;
    const close=new Promise((_,reject)=>{rejectClose=reject;});const entry={controller,rejectClose};active.add(entry);
    try{return await Promise.race([operation(controller.signal),close,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(failure(jsonMode?'JSON_TIMEOUT':'REQUEST'));},timeoutMs);})]);}
    catch(e){if(closed)fail('CLOSED');if(failures.has(e))throw e;fail(jsonMode?boundedFailureCode(e)||'REQUEST':'REQUEST');}
    finally{clearTimeout(timer);active.delete(entry);controller.abort();}
  };
  const json=async path=>{
    if(typeof path!=='string'||!JSON_ROUTE.test(path))fail('SCOPE');
    return run(async signal=>{
      let httpClass='OTHER';
      // A transport may throw an arbitrary object, including an externally
      // constructed BoundedJsonError. Replace it before the helper handles it.
      // Retain only a fixed status class in this request's closure, never the
      // response, its body, headers, URL or authentication as diagnostic state.
      const jsonFetch=async(...args)=>{try{
        const response=await fetchImpl(...args),status=response?.status;
        if(Number.isInteger(status))httpClass=Object.hasOwn(HTTP_CODES,status)?HTTP_CODES[status]:status>=500&&status<=599?'SERVER':'OTHER';
        return response;
      }catch{throw new Error();}};
      let result;
      try{result=await boundedJson(jsonFetch,ORIGIN+REPO+path,{method:'GET',redirect:'error',credentials:'omit',signal,headers:headers()},
        {timeoutMs,maxBytes:8*1024*1024,requireJsonType:true});}
      catch(error){if(boundedFailureCode(error)==='JSON_HTTP')fail('JSON_HTTP_'+httpClass);throw error;}
      live();if(!result||typeof result!=='object'||JSON.stringify(result).includes(token))fail('RESPONSE');return result;
    },true);
  };
  const raw=async(response,signal)=>{
    if(response.status!==200||response.redirected||!response.body?.getReader)fail('LOG');
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{for(;;){live();if(signal.aborted)fail('REQUEST');const row=await reader.read();live();if(signal.aborted)fail('REQUEST');if(row.done)break;
      if(!(row.value instanceof Uint8Array))fail('LOG');size+=row.value.byteLength;if(size>2*1024*1024)fail('LOG');chunks.push(Buffer.from(row.value));}
      const bytes=Buffer.concat(chunks);if(!size)fail('LOG');
      let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{bytes.fill(0);fail('LOG');}
      if(text.includes(token)){bytes.fill(0);fail('LOG');}return bytes;
    }finally{for(const chunk of chunks)chunk.fill(0);Promise.resolve(reader.cancel()).catch(()=>{});reader.releaseLock();}
  };
  const api=Object.freeze({
    readJson:json,
    readJobLog(jobId){
      if(!Number.isSafeInteger(jobId)||jobId<=0)fail('SCOPE');
      return run(async signal=>{
        const url=ORIGIN+REPO+'actions/jobs/'+jobId+'/logs';
        const first=await fetchImpl(url,{method:'GET',redirect:'manual',credentials:'omit',signal,headers:headers()});
        live();if(signal.aborted)fail('REQUEST');
        if(first.redirected||(first.url&&first.url!==url))fail('LOG');
        if(first.status===200)return raw(first,signal);
        if(first.status!==302)fail('LOG');
        let location;try{const header=first.headers.get('location');location=new URL(header);
          if(header.includes(token)||decodeURIComponent(header).includes(token))fail('LOG');
        }catch(e){if(failures.has(e))throw e;fail('LOG');}
        // GitHub's short-lived Actions result location only. Never forward the
        // repository token or accept a caller-supplied redirect destination.
        if(location.protocol!=='https:'||location.username||location.password||location.port||location.hash
          ||!/^productionresultssa[0-9]+\.blob\.core\.windows\.net$/.test(location.hostname)
          ||!location.pathname.startsWith('/actions-results/'))fail('LOG_HOST');
        live();if(signal.aborted)fail('REQUEST');
        const second=await fetchImpl(location.href,{method:'GET',redirect:'error',credentials:'omit',signal,headers:{Accept:'text/plain'}});
        live();if(signal.aborted)fail('REQUEST');
        if(second.url&&second.url!==location.href)fail('LOG');return raw(second,signal);
      });
    },
    close(){if(closed)return;closed=true;token='';fetchImpl=null;for(const entry of active){entry.controller.abort();entry.rejectClose(new Error());}active.clear();},
  });instances.add(api);return api;
}
