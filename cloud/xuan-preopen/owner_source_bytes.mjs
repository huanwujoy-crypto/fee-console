// One worker invocation only. Reuse immutable public bytes, never live main,
// parsed context, approval, timestamps or a caller-supplied source snapshot.
import {AsyncLocalStorage} from 'node:async_hooks';

const scopes=new AsyncLocalStorage();
const RAW='https://raw.githubusercontent.com/huanwujoy-crypto/fee-console/';
const API='https://api.github.com/repos/huanwujoy-crypto/fee-console/compare/';
const SHA='[a-f0-9]{40}';
const paths=new Map([
  ['claude/xuan-ib-account-association-v1.json',8_000_000],
  ['claude/xuan-ib-etf-pending-calls-v1.json',8_000_000],
  ['xuan-ib/latest.meta.json',8_000_000],
  ['xuan-ib/latest.html',8_000_000],
  ['security/xuan-owner-accepted-preview.json',500000],
  ['security/xuan-owner-preview-replacement.json',500000],
  ['security/xuan-owner-registered-canary.json',500000],
]);
const MAX_TOTAL=16*1024*1024,MAX_ENTRIES=16;

function immutableLimit(url,options){
  if(typeof url!=='string'||(options.method??'GET')!=='GET'||options.body!==undefined
    ||options.credentials!==undefined&&options.credentials!=='omit'
    ||options.redirect!==undefined&&options.redirect!=='error')return null;
  let u,headers;
  try{u=new URL(url);headers=new Headers(options.headers);}catch{return null;}
  if(u.href!==url||u.search||u.hash||u.username||u.password
    ||[...headers.keys()].some(key=>key!=='user-agent'))return null;
  if(url.startsWith(RAW)){
    const match=new RegExp('^'+SHA+'/([^?#]+)$').exec(url.slice(RAW.length));
    return match?paths.get(match[1])??null:null;
  }
  return url.startsWith(API)&&new RegExp('^'+SHA+'\\.\\.\\.'+SHA+'$').test(url.slice(API.length))?2*1024*1024:null;
}

export async function withOwnerSourceByteReuse(work){
  if(arguments.length!==1||typeof work!=='function')throw Error('OWNER_SOURCE_SCOPE_ARGUMENTS');
  const scope={open:true,entries:new Map(),size:0};
  return scopes.run(scope,async()=>{
    try{return await work();}
    finally{scope.open=false;scope.entries.clear();scope.size=0;}
  });
}

function cachedResponse(entry,signal){
  // The existing boundedText reader still consumes and bounds every hit.
  let abort,sent=false;
  const cleanup=()=>signal?.removeEventListener('abort',abort);
  const body=new ReadableStream({
    start(controller){abort=()=>{cleanup();controller.error(signal.reason);};signal?.addEventListener('abort',abort,{once:true});},
    pull(controller){
      if(signal?.aborted){cleanup();controller.error(signal.reason);}
      else if(sent){cleanup();controller.close();}
      else{sent=true;controller.enqueue(Uint8Array.from(entry.bytes));}
    },
    cancel:cleanup,
  },{highWaterMark:0});
  return new Response(body,{status:200,statusText:entry.statusText,headers:entry.headers});
}

export async function ownerSourceFetch(url,options={}){
  const scope=scopes.getStore();
  if(scope&&!scope.open)throw Error('OWNER_SOURCE_SCOPE_CLOSED');
  const limit=scope?immutableLimit(url,options):null;
  if(limit===null)return globalThis.fetch(url,options);
  options.signal?.throwIfAborted();
  const entry=scope.entries.get(url);
  if(entry)return cachedResponse(entry,options.signal);
  const response=await globalThis.fetch(url,options);
  if(!scope.open||response.status!==200||response.redirected||!response.body
    ||response.url&&response.url!==url||response.headers.has('content-range'))return response;
  const chunks=[];let size=0,complete=true;
  // Pass through without awaiting the body here: body failures retain the
  // original boundedText error boundary instead of becoming fetch failures.
  const stream=new TransformStream({
    transform(chunk,controller){
      controller.enqueue(chunk);
      if(!scope.open||options.signal?.aborted||!complete)return;
      size+=chunk.byteLength;
      if(size>limit||size>MAX_TOTAL){complete=false;chunks.length=0;return;}
      chunks.push(Buffer.from(chunk));
    },
    flush(){
      if(!complete||!scope.open||options.signal?.aborted)return;
      const bytes=Buffer.concat(chunks);
      try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return;}
      if(scope.entries.has(url)||scope.entries.size>=MAX_ENTRIES||scope.size+bytes.length>MAX_TOTAL)return;
      scope.entries.set(url,{bytes,statusText:response.statusText,headers:[...response.headers]});
      scope.size+=bytes.length;
    },
  });
  return new Response(response.body.pipeThrough(stream,{signal:options.signal}),{status:200,statusText:response.statusText,headers:response.headers});
}
