// Shared, pure lexical-stability rule for captured Sharesight GET evidence.
// No IO, no network, no credential, no source value is ever returned or logged.
//
// Strict lexical equivalence of two raw JSON documents. Only object member
// order and whitespace *between* JSON tokens are ignored. Every number keeps its
// original lexeme (1 stays different from 1.0 and 1e0), every string keeps its
// original escaping, array order is preserved, unknown members are preserved and
// no member - including a generation timestamp - is dropped. Leading and
// trailing whitespace are not between tokens, so they stay part of the form.
// Each token is emitted with a type tag and a length prefix, so a number,
// string, literal, member key or structural marker can never encode as another.
// A document that cannot be reduced (invalid JSON, duplicate member, limits)
// keeps its raw bytes as the only accepted proof.
import crypto from 'node:crypto';

export const SOURCE_LEXICAL_RULE='fee-console.sharesight-lexical-json.v2';
// v2 adds one explicit, route-bound contract (opt-in per reader): the order of a
// listed top-level array is not significant when, and only when, every element
// is an object with a unique positive safe-integer `id`. That mirrors the IB
// reader, which itself refuses duplicate ids and keys these rows by id. Element
// content, element count, nested arrays and every other array stay ordered.
// Nothing is dropped or reordered in the delivered evidence: the first round's
// original bytes remain the proof; this only defines what "the same" means.
const IB_PORTFOLIO=/^\/api\/v3\/portfolios\/[1-9]\d{0,14}\//;
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const exactQuery=(q,keys)=>q&&typeof q==='object'&&!Array.isArray(q)&&Object.keys(q).sort().join()===[...keys].sort().join()&&Object.values(q).every(v=>typeof v==='string');
// Each entry is one exact GET route + exact query shape the IB reader issues +
// the response root path of an array whose rows the reader itself requires to
// carry a unique positive integer id. Anything else gets no contract at all.
export const IB_UNORDERED_ID_ARRAYS=Object.freeze((path,query)=>{
  if(path==='/api/v2/portfolios.json'&&exactQuery(query,[]))return [['portfolios']];
  if(IB_PORTFOLIO.test(path)&&path.endsWith('/holdings')&&path.split('/').length===6&&exactQuery(query,['consolidated'])&&query.consolidated==='false')return [['holdings']];
  if(IB_PORTFOLIO.test(path)&&path.endsWith('/performance')&&path.split('/').length===6
    &&exactQuery(query,['consolidated','end_date','grouping','include_limited','include_sales','report_combined','start_date'])
    &&query.consolidated==='false'&&query.grouping==='investment_type'&&query.include_limited==='false'&&query.include_sales==='false'&&query.report_combined==='false'
    &&DAY.test(query.start_date)&&query.start_date===query.end_date)return [['report','holdings'],['report','cash_accounts']];
  if(IB_PORTFOLIO.test(path)&&path.endsWith('/trades.json')&&path.split('/').length===6&&exactQuery(query,['consolidated','end_date','start_date'])
    &&query.consolidated==='false'&&DAY.test(query.start_date)&&DAY.test(query.end_date)&&query.start_date<=query.end_date)return [['trades']];
  if(/^\/api\/v2\/portfolios\/[1-9]\d{0,14}\/cash_accounts\.json$/.test(path)&&exactQuery(query,['date'])&&DAY.test(query.date))return [['cash_accounts']];
  if(/^\/api\/v2\/cash_accounts\/[1-9]\d{0,14}\/cash_account_transactions\.json$/.test(path)&&exactQuery(query,['from','to'])
    &&DAY.test(query.from)&&DAY.test(query.to)&&query.from<=query.to)return [['cash_account_transactions']];
  return [];
});
// Fixed RECORDS sub-locations: which route class and which kind of difference.
// Never a value, an id, a date, a field name or a byte offset.
// Short literals keep every composed public code within the producer's
// 64-character safe-code bound (FEE_REPORT_ + at most 64).
export const SOURCE_RECORDS_ROUTES=Object.freeze(['PORT','HOLD','PERF','CASH','TRADE','TXN','PAYOUT','OTHER']);
// SET route set differs; DUP a route read twice; RAW body not reducible;
// LEX same parsed value, different lexical form; VAL parsed content differs.
export const SOURCE_RECORDS_KINDS=Object.freeze(['SET','DUP','RAW','LEX','VAL']);
export const SOURCE_RECORDS_SITES=Object.freeze(SOURCE_RECORDS_ROUTES.flatMap(r=>SOURCE_RECORDS_KINDS.map(k=>r+'_'+k)));
// Fixed capture-gate locations shared by every two-attempt Sharesight capture.
// FINGERPRINT is the normalized business re-read, RECORDS the raw GET batch and
// TRANSPORT the local fetch/credential object identity. A location, never a value.
export const SOURCE_CAPTURE_UNSTABLE_CODES=Object.freeze(['UNCLASSIFIED','FINGERPRINT','RECORDS','TRANSPORT']);

const MAX_TEXT=32*1024*1024,MAX_NODES=400000,MAX_DEPTH=64;
const WHITESPACE=new Set([' ','\t','\n','\r']);
const NUMBER=/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPE=/[0-9a-fA-F]{4}/y;
const REFUSED=Symbol('fee-source-lexical-refused');

const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const hash=v=>crypto.createHash('sha256').update(canonical(v)).digest('hex');

export function lexicalCanonicalJson(text,unordered=[]){
  if(typeof text!=='string'||text.length>MAX_TEXT)return null;
  let index=0,nodes=0;
  const listed=new Set(unordered.map(p=>JSON.stringify(p)));
  const refuse=()=>{throw REFUSED;};
  const part=(tag,lexeme)=>tag+lexeme.length+':'+lexeme;
  const space=()=>{const start=index;while(index<text.length&&WHITESPACE.has(text[index]))index++;return text.slice(start,index);};
  const string=()=>{
    const start=index++;
    for(;;){
      if(index>=text.length)refuse();
      const c=text[index];
      if(c==='"'){index++;break;}
      if(c==='\\'){
        const escape=text[index+1];
        if(escape===undefined)refuse();
        if('"\\/bfnrt'.includes(escape))index+=2;
        else if(escape==='u'){ESCAPE.lastIndex=index+2;if(!ESCAPE.exec(text))refuse();index+=6;}
        else refuse();
      }else if(c<' ')refuse();
      else index++;
    }
    return text.slice(start,index);
  };
  // path is the member-key path from the root; it is null inside any array.
  const value=(depth,path=[])=>{
    if(++nodes>MAX_NODES||depth>MAX_DEPTH)refuse();
    const c=text[index];
    if(c==='"')return part('s',string());
    if(c==='{'){
      index++;space();
      if(text[index]==='}'){index++;return '{}';}
      const members=[],keys=new Set();
      for(;;){
        if(text[index]!=='"')refuse();
        const lexeme=string();
        let key;try{key=JSON.parse(lexeme);}catch{refuse();}
        // Duplicate members are never collapsed or reordered: a document that
        // relies on last-wins is refused here and stays raw-byte compared.
        if(keys.has(key))refuse();keys.add(key);
        space();if(text[index]!==':')refuse();index++;space();
        members.push([key,part('k',lexeme)+value(depth+1,path===null?null:[...path,key])]);space();
        if(text[index]===','){index++;space();continue;}
        if(text[index]==='}'){index++;break;}
        refuse();
      }
      members.sort((a,b)=>a[0]<b[0]?-1:1);
      return '{'+members.map(member=>member[1]).join('')+'}';
    }
    if(c==='['){
      index++;space();
      if(text[index]===']'){index++;return '[]';}
      const items=[],starts=[],ends=[];
      for(;;){
        starts.push(index);items.push(value(depth+1,null));ends.push(index);space();
        if(text[index]===','){index++;space();continue;}
        if(text[index]===']'){index++;break;}
        refuse();
      }
      if(path!==null&&listed.has(JSON.stringify(path))){
        // Contract array: order-free only with a unique positive integer id per
        // object element. Otherwise it stays ordered (strict), never repaired.
        const ids=[];
        for(let i=0;i<items.length;i++){
          let el;try{el=JSON.parse(text.slice(starts[i],ends[i]));}catch{el=null;}
          if(!el||typeof el!=='object'||Array.isArray(el)||!Number.isSafeInteger(el.id)||el.id<1){ids.length=0;break;}
          ids.push(el.id);
        }
        if(ids.length===items.length&&new Set(ids).size===ids.length)
          return 'u['+items.map((it,i)=>[ids[i],it]).sort((a,b)=>a[0]-b[0]).map(x=>x[1]).join('')+']';
      }
      return '['+items.join('')+']';
    }
    for(const literal of ['true','false','null'])if(text.startsWith(literal,index)){index+=literal.length;return part('l',literal);}
    if(c==='-'||c>='0'&&c<='9'){NUMBER.lastIndex=index;const m=NUMBER.exec(text);if(!m||m.index!==index)refuse();index=NUMBER.lastIndex;return part('n',m[0]);}
    return refuse();
  };
  try{
    const lead=space(),body=value(0),trail=space();
    if(index!==text.length)refuse();
    return part('w',lead)+body+part('w',trail);
  }catch(error){if(error===REFUSED)return null;throw error;}
}

// Route and query identity are never relaxed; only the body is reduced.
export function lexicalRecord(record,contract=null){
  const lexical=lexicalCanonicalJson(record.body,contract?contract(record.path,record.query):[]);
  return {method:record.method,path:record.path,query:record.query,
    ...(lexical===null?{rawBody:record.body}:{lexicalBody:lexical})};
}
// Order-independent digest of a whole GET batch in lexical form. It is a
// comparison key only; the original records and byte hashes remain the proof.
const routeKey=r=>canonical({method:r.method,path:r.path,query:r.query});
const uniqueRoutes=records=>new Set(records.map(routeKey)).size===records.length;
// A batch that reads the same route twice is never reduced: two same-route
// bodies could otherwise be matched to each other and hide a later change. It
// is then compared by its original bytes only.
export const lexicalRecordsSha256=(records,contract=null)=>uniqueRoutes(records)
  ?hash([...records.map(r=>lexicalRecord(r,contract))].sort((a,b)=>{const x=canonical(a),y=canonical(b);return x<y?-1:x>y?1:0;}))
  :'raw:'+hash([...records].map(r=>({method:r.method,path:r.path,query:r.query,body:r.body})).sort((a,b)=>{const x=canonical(a),y=canonical(b);return x<y?-1:x>y?1:0;}));
export const lexicalRecordEquivalent=(current,original,contract=null)=>current!==undefined&&original!==undefined
  &&canonical(lexicalRecord(current,contract))===canonical(lexicalRecord(original,contract));
// Identical byte batch, or a strictly lexically equivalent one. Never weaker.
export const lexicalBatchesEquivalent=(a,b,contract=null)=>a.sha256===b.sha256||lexicalRecordsSha256(a.records,contract)===lexicalRecordsSha256(b.records,contract);

const routeClass=path=>path==='/api/v2/portfolios.json'?'PORT':/\/holdings$/.test(path)?'HOLD':/\/performance$/.test(path)?'PERF'
  :/\/cash_accounts\.json$/.test(path)?'CASH':/\/trades\.json$/.test(path)?'TRADE':/\/cash_account_transactions\.json$/.test(path)?'TXN'
  :/^\/api\/v2\/payouts\/[1-9]\d*\.json$/.test(path)?'PAYOUT':'OTHER';
// Parsed value with the same contract arrays ordered by id: equal parsed values
// with different lexical forms are a LEXEME difference, otherwise VALUE.
function parsedForm(body,listed){
  let v;try{v=JSON.parse(body);}catch{return null;}
  const walk=(x,path)=>{
    if(Array.isArray(x)){const out=x.map(y=>walk(y,null));
      if(path&&listed.has(JSON.stringify(path))&&out.every(e=>e&&typeof e==='object'&&!Array.isArray(e)&&Number.isSafeInteger(e.id)&&e.id>0)&&new Set(out.map(e=>e.id)).size===out.length)
        return {u:[...out].sort((a,b)=>a.id-b.id)};
      return out;}
    if(x&&typeof x==='object')return Object.fromEntries(Object.keys(x).map(k=>[k,walk(x[k],path===null?null:[...path,k])]));
    return x;
  };
  return canonical(walk(v,[]));
}
// First differing route (in a stable order) and the kind of difference. Used
// only to name a fixed location after the RECORDS gate has already failed.
export function classifyRecordsDifference(a,b,contract=null){
  const site=(path,kind)=>routeClass(path)+'_'+kind;
  for(const records of [a,b]){const seen=new Set();for(const r of records){const k=routeKey(r);if(seen.has(k))return site(r.path,'DUP');seen.add(k);}}
  const byRoute=rs=>new Map(rs.map(r=>[routeKey(r),r]));
  const x=byRoute(a),y=byRoute(b),keys=[...new Set([...x.keys(),...y.keys()])].sort();
  for(const k of keys){const r=x.get(k)||y.get(k);if(!x.has(k)||!y.has(k))return site(r.path,'SET');}
  for(const k of keys){
    const r=x.get(k),s=y.get(k);if(lexicalRecordEquivalent(r,s,contract))continue;
    const listed=new Set((contract?contract(r.path,r.query):[]).map(p=>JSON.stringify(p)));
    const lr=lexicalCanonicalJson(r.body,[...listed].map(p=>JSON.parse(p))),ls=lexicalCanonicalJson(s.body,[...listed].map(p=>JSON.parse(p)));
    if(lr===null||ls===null)return site(r.path,'RAW');
    const pr=parsedForm(r.body,listed),ps=parsedForm(s.body,listed);
    return site(r.path,pr!==null&&pr===ps?'LEX':'VAL');
  }
  return null;
}
// A raw body string is compared in its lexical form; a non-string is compared
// structurally. Used for a projection of raw bodies (path→body maps).
export function lexicalBodiesCanonical(value){
  const walk=v=>typeof v==='string'?(()=>{const l=lexicalCanonicalJson(v);return l===null?{rawBody:v}:{lexicalBody:l};})()
    :Array.isArray(v)?v.map(walk):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).map(k=>[k,walk(v[k])])):v;
  return canonical(walk(value));
}
