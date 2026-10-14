// Fixed official HTTPS report transport. No realtime MCP, token rotation,
// trading endpoint or caller-selected URL. One SendRequest, bounded polling
// of its exact accepted reference; an unknown generation outcome is not retried.
import {boundedText} from './cloud_io.mjs';
import {ibError,httpCategory,networkCategory} from './ib_diagnostics.mjs';
const ENDPOINT='https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/';
const reject=()=>{throw Error('RESPONSE_INVALID');};
const knownCodes=new Set([1001,...Array.from({length:19},(_,i)=>1003+i)]);
const contentKind=headers=>{
  const v=(headers?.get('content-type')||'').split(';')[0].trim().toLowerCase();
  return !v?'missing':['application/xml','text/xml'].includes(v)||v.endsWith('+xml')?'xml':v==='text/html'?'html':v==='application/json'||v.endsWith('+json')?'json':v.startsWith('text/')?'text':'other';
};
function decode(text){
  if(/&(?!amp;|lt;|gt;|quot;|apos;|#(?:[0-9]+|x[0-9a-fA-F]+);)/.test(text))reject();
  return text.replace(/&(amp|lt|gt|quot|apos|#(?:[0-9]+|x[0-9a-fA-F]+));/g,(_,key)=>{
    if(key[0]!=='#')return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[key];
    const n=key[1]==='x'?parseInt(key.slice(2),16):Number(key.slice(1));
    if(!Number.isSafeInteger(n)||!([9,10,13].includes(n)||n>=32&&n<=0xd7ff||n>=0xe000&&n<=0xfffd||n>=0x10000&&n<=0x10ffff))reject();
    return String.fromCodePoint(n);
  });
}
function statement(text){
  const xml=text.trim().replace(/^<\?xml[^>]*\?>\s*/,'');
  if(/<!|<\?/.test(xml))reject();
  const body=/^<FlexStatementResponse(?:\s+timestamp\s*=\s*(?:"[^"<>\r\n]{1,128}"|'[^'<>\r\n]{1,128}'))?\s*>\s*([\s\S]*?)\s*<\/FlexStatementResponse\s*>$/.exec(xml)?.[1];
  if(body===undefined)reject();
  // Validate standard XML entities even in ignored attributes/fields. Never
  // follow or emit the supplier Url or ErrorMessage.
  decode(xml);
  const fields={},pattern=/<(Status|ReferenceCode|ErrorCode|ErrorMessage|Url|url)\s*(?:\/>|>([^<>]*)<\/\1\s*>)/g;
  let rest=body,match;
  while((match=pattern.exec(body))){
    const field=match[1]==='url'?'Url':match[1];
    if(Object.hasOwn(fields,field))reject();
    fields[field]=decode(match[2]??'');rest=rest.replace(match[0],'');
  }
  if(rest.trim())reject();
  return fields;
}
function shape(text,context){
  const xml=typeof text==='string'?text.trim().replace(/^<\?xml[^>]*\?>\s*/,''):'';
  const root=/^<([A-Za-z_][\w:.-]*)(\s[^<>]*)?>/.exec(xml),local=root?.[1].split(':').at(-1);
  const rootKind=!xml?'unavailable':local==='FlexStatementResponse'?'statement_response':local==='FlexQueryResponse'?'query_response':'other';
  const field=name=>{
    const nodes=[...xml.matchAll(new RegExp('<((?:[A-Za-z_][\\w.-]*:)?'+name+')\\b([^<>]*?)(?:\\/>|>([^<>]*?)<\\/\\1\\s*>)','g'))];
    if(nodes.length>1)return ['ambiguous',null];
    if(!nodes.length)return ['missing',null];
    const n=nodes[0];
    if(n[1]!==name)return ['qualified',null];
    if(n[2].trim())return ['attribute',null];
    let depth=0;for(const token of xml.slice(0,n.index).matchAll(/<[^>]*>/g)){const t=token[0];if(t.startsWith('</'))depth--;else if(!t.startsWith('<?')&&!t.startsWith('<!')&&!t.endsWith('/>'))depth++;}
    if(depth!==1)return ['nested',null];
    let value;try{value=decode(n[3]??'');}catch{return ['noncanonical',null];}
    if(name==='Status')return [value==='Success'?'success':value==='Fail'?'fail':'noncanonical',null];
    if(!/^[0-9]{4}$/.test(value)||value.length!==4)return ['noncanonical',null];
    const code=Number(value);return knownCodes.has(code)?['known',code]:['unrecognized',null];
  };
  const [statusShape]=field('Status'),[errorCodeShape,upstreamErrorCode]=field('ErrorCode');
  return {...context,rootKind,rootNamespacePresent:!!(root?.[1].includes(':')||/\bxmlns(?:\:[\w.-]+)?\s*=/.test(root?.[2]??'')),statusShape,errorCodeShape,upstreamErrorCode};
}
export async function fetchFlexArchive({token,configuredQueryId,fetchImpl=fetch,now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  if(typeof token!=='string'||!token||/[\r\n\0]/.test(token)||typeof configuredQueryId!=='string'||!/^[1-9]\d{0,19}$/.test(configuredQueryId)||/[\r\n]/.test(configuredQueryId))throw ibError('FLEX_SOURCE_CONFIGURATION_REQUIRED');
  const deadline=now()+150_000;let sendCount=0,getCount=0,context=null,lastText;
  function fail(code,category='response_invalid',reason=code.toLowerCase()){
    throw ibError('FLEX_SOURCE_'+code,{phase:context?.operation==='send_request'?'flex_send_request':context?.operation==='get_statement'?'flex_get_statement':'unknown',category,httpStatus:context?.httpStatus??null,flex:context?shape(lastText,{...context,reason}):null});
  }
  async function get(operation,query){
    const remaining=deadline-now();if(remaining<=0)fail('TIMEOUT','timeout');
    if(operation==='SendRequest')sendCount++;else getCount++;
    context={operation:operation==='SendRequest'?'send_request':'get_statement',sendCount,getCount,httpStatus:null,contentType:'missing'};lastText=undefined;
    const url=new URL(ENDPOINT+operation);url.search=new URLSearchParams({t:token,q:query,v:'3'}).toString();
    let response;
    try{response=await fetchImpl(url,{method:'GET',redirect:'error',headers:{'User-Agent':`Node/${process.versions.node}`},signal:AbortSignal.timeout(Math.min(30_000,remaining))});}
    catch(error){fail('NETWORK_FAILED',networkCategory(error));}
    context.httpStatus=response.status;context.contentType=contentKind(response.headers);
    if(!response.ok)fail('HTTP_FAILED',httpCategory(response.status));
    try{lastText=await boundedText(response,8_000_000);}catch(error){
      const reasons={CLOUD_EMPTY_RESPONSE:'empty_body',CLOUD_RESPONSE_TOO_LARGE:'body_too_large',CLOUD_INVALID_UTF8:'invalid_utf8'};
      const reason=Object.hasOwn(reasons,error?.message)?reasons[error.message]:'body_read_failed';
      fail('RESPONSE_INVALID','response_invalid',reason);
    }
    if(!lastText.trim())fail('RESPONSE_INVALID','response_invalid','empty_body');
    return lastText;
  }
  function envelope(text){try{return statement(text);}catch{fail('RESPONSE_INVALID','response_invalid','envelope_invalid');}}
  const requested=envelope(await get('SendRequest',configuredQueryId));
  if(requested.Status!=='Success'||requested.ErrorCode!==undefined||!/^[1-9]\d{0,29}$/.test(requested.ReferenceCode||'')||/[\r\n]/.test(requested.ReferenceCode||''))fail('REQUEST_REJECTED');
  for(let count=0;count<24;count++){
    if(now()+6200>=deadline)fail('TIMEOUT','timeout');await wait(6200);
    const bytes=await get('GetStatement',requested.ReferenceCode);
    if(/^(?:\s*<\?xml[^>]*\?>)?\s*<FlexQueryResponse\b/.test(bytes)){if(now()>=deadline)fail('TIMEOUT','timeout');return {bytes,requestedQueryId:configuredQueryId};}
    const pending=envelope(bytes);
    if(pending.Status!=='Fail'||pending.ReferenceCode!==undefined||!['1009','1019'].includes(pending.ErrorCode))fail('STATEMENT_REJECTED');
  }
  fail('TIMEOUT','timeout');
}
