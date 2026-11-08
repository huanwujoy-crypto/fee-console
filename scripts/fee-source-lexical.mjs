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

export const SOURCE_LEXICAL_RULE='fee-console.sharesight-lexical-json.v4';
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
// v3: on the exact undated IB holdings-catalog route only, three row members
// that no consumer of this chain reads are left out of the stability
// comparison. Static evidence: the IB reader reads catalog rows only for id,
// portfolio id/name, valid_position and instrument id/code/market/currency_code
// plus the row set; no projection, readiness, acquisition, currentness consumer
// or report reads the catalog. They are "catalog members this chain does not
// consume", not inherently non-business data: the dated performance route,
// which this chain does consume, keeps its quantity/value/currency strict. Every
// other catalog member, including any unknown one, the row set and every other
// route stay strict. The delivered first-round bytes still include them.
export const IB_CATALOG_UNCONSUMED_MEMBERS_LIST=Object.freeze(['quantity','value','instrument_currency']);
export const IB_CATALOG_UNCONSUMED_MEMBERS=Object.freeze((path,query)=>
  IB_PORTFOLIO.test(path)&&path.endsWith('/holdings')&&path.split('/').length===6&&exactQuery(query,['consolidated'])&&query.consolidated==='false'
    ?{root:['holdings'],members:IB_CATALOG_UNCONSUMED_MEMBERS_LIST}:null);
// v4: only the three exact IB v3 routes/query shapes above may vary the values
// of root api_transaction.id (number) and .timestamp (string). Their keys,
// presence, types and surrounding structure remain strict, as does every
// other member. No v2 route or default/fee-reader comparison opts in.
export const IB_RESPONSE_METADATA_VALUES=Object.freeze((path,query)=>IB_PORTFOLIO.test(path)&&IB_UNORDERED_ID_ARRAYS(path,query).length>0);
// The whole IB comparison contract; a bare function keeps the v2 behaviour.
export const IB_CAPTURE_CONTRACT=Object.freeze({unordered:IB_UNORDERED_ID_ARRAYS,excluded:IB_CATALOG_UNCONSUMED_MEMBERS,metadata:IB_RESPONSE_METADATA_VALUES});
const norm=c=>typeof c==='function'?{unordered:c}:c&&typeof c==='object'?c:{};
const rulesFor=(c,r)=>{const n=norm(c);return {unordered:n.unordered?n.unordered(r.path,r.query):[],excluded:n.excluded?n.excluded(r.path,r.query):null,
  metadata:r.method==='GET'&&!!n.metadata&&n.metadata(r.path,r.query)};};
const metadataType=path=>path?.length===2&&path[0]==='api_transaction'?(path[1]==='id'?'number':path[1]==='timestamp'?'string':null):null;
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

function canonicalJson(text,unordered=[],excluded=null,responseMetadata=false){
  if(typeof text!=='string'||text.length>MAX_TEXT)return null;
  let index=0,nodes=0;const metadata=new Map();
  const listed=new Set(unordered.map(p=>JSON.stringify(p)));
  const excludedRoot=excluded?JSON.stringify(excluded.root):null,excludedMembers=new Set(excluded?.members||[]);
  const refuse=()=>{throw REFUSED;};
  const part=(tag,lexeme)=>tag+lexeme.length+':'+lexeme;
  const scalar=(tag,type,lexeme,path)=>{
    if(responseMetadata&&metadataType(path)===type){metadata.set(path[1],lexeme);return part('m',type);}
    return part(tag,lexeme);
  };
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
  // omit: a member-name set to leave out of this object only (catalog rows).
  const value=(depth,path=[],omit=null)=>{
    if(++nodes>MAX_NODES||depth>MAX_DEPTH)refuse();
    const c=text[index];
    if(c==='"')return scalar('s','string',string(),path);
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
        const form=part('k',lexeme)+value(depth+1,path===null?null:[...path,key]);
        if(!omit||!omit.has(key))members.push([key,form]);space();
        if(text[index]===','){index++;space();continue;}
        if(text[index]==='}'){index++;break;}
        refuse();
      }
      members.sort((a,b)=>a[0]<b[0]?-1:1);
      return (omit?'x{':'{')+members.map(member=>member[1]).join('')+'}';
    }
    if(c==='['){
      index++;space();
      if(text[index]===']'){index++;return '[]';}
      const items=[],starts=[],ends=[];
      const rowOmit=path!==null&&excludedRoot!==null&&JSON.stringify(path)===excludedRoot?excludedMembers:null;
      for(;;){
        starts.push(index);items.push(text[index]==='{'?value(depth+1,null,rowOmit):value(depth+1,null));ends.push(index);space();
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
    if(c==='-'||c>='0'&&c<='9'){NUMBER.lastIndex=index;const m=NUMBER.exec(text);if(!m||m.index!==index)refuse();index=NUMBER.lastIndex;return scalar('n','number',m[0],path);}
    return refuse();
  };
  try{
    const lead=space(),body=value(0),trail=space();
    if(index!==text.length)refuse();
    return {form:part('w',lead)+body+part('w',trail),metadata};
  }catch(error){if(error===REFUSED)return null;throw error;}
}
export function lexicalCanonicalJson(text,unordered=[],excluded=null,responseMetadata=false){
  return canonicalJson(text,unordered,excluded,responseMetadata)?.form??null;
}

// Route and query identity are never relaxed; only the body is reduced.
export function lexicalRecord(record,contract=null){
  const rules=rulesFor(contract,record);
  const lexical=lexicalCanonicalJson(record.body,rules.unordered,rules.excluded,rules.metadata);
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
// Normalized parsed form under the same rules: contract id-arrays become id
// maps, excluded catalog members are dropped. Equal normalized forms with
// different lexical forms are a LEX difference, otherwise VAL.
const idRows=x=>Array.isArray(x)&&x.every(e=>e&&typeof e==='object'&&!Array.isArray(e)&&Number.isSafeInteger(e.id)&&e.id>0)&&new Set(x.map(e=>e.id)).size===x.length;
function normalized(body,rules){
  let v;try{v=JSON.parse(body);}catch{return undefined;}
  const listed=new Set(rules.unordered.map(p=>JSON.stringify(p))),ex=rules.excluded,exRoot=ex?JSON.stringify(ex.root):null,exSet=new Set(ex?.members||[]);
  const walk=(x,path,omit)=>{
    if(rules.metadata&&metadataType(path)===typeof x)return typeof x==='number'?0:'';
    if(Array.isArray(x)){
      const rowOmit=path&&exRoot===JSON.stringify(path)?exSet:null;
      const out=x.map(y=>walk(y,null,y&&typeof y==='object'&&!Array.isArray(y)?rowOmit:null));
      if(path&&listed.has(JSON.stringify(path))&&idRows(out))return {__idset:Object.fromEntries(out.map(e=>[e.id,e]))};
      return out;
    }
    if(x&&typeof x==='object')return Object.fromEntries(Object.keys(x).filter(k=>!omit||!omit.has(k)).map(k=>[k,walk(x[k],path===null?null:[...path,k],null)]));
    return x;
  };
  return walk(v,[],null);
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
    const rules=rulesFor(contract,r);
    if(lexicalCanonicalJson(r.body,rules.unordered,rules.excluded,rules.metadata)===null||lexicalCanonicalJson(s.body,rules.unordered,rules.excluded,rules.metadata)===null)return site(r.path,'RAW');
    const pr=normalized(r.body,rules),ps=normalized(s.body,rules);
    return site(r.path,pr!==undefined&&canonical(pr)===canonical(ps)?'LEX':'VAL');
  }
  return null;
}

// ---- Evidence only. Decides nothing; acceptance stays with the strict rule.
// Every route of both acquired batches is compared; each route class gets the
// fixed groups that differ. Only literals below ever leave this function.
// These two non-blocking markers record use of the exact catalog-member or
// root response-metadata value exception. Every other group blocks.
export const SOURCE_EVIDENCE_ALLOWED='ALLOWED_UNCONSUMED_CATALOG';
export const SOURCE_EVIDENCE_METADATA_ALLOWED='ALLOWED_ROOT_TRANSACTION_METADATA';
export const SOURCE_EVIDENCE_GROUPS=Object.freeze([SOURCE_EVIDENCE_ALLOWED,SOURCE_EVIDENCE_METADATA_ALLOWED,'ROUTE_SET','DUP_ROUTE','RAW','LEX','ROWSET','MEMBER_SET','STRUCTURE',
  'ID','INSTRUMENT','PORTFOLIO','QUANTITY','AMOUNT','CURRENCY','DATE','STATE','TEXT','KIND','ARRAY','TYPE','UNKNOWN']);
const GROUP_KEYS={
  ID:['id','portfolio_id','holding_id','trade_id','payout_id','cash_account_id','instrument_id'],
  QUANTITY:['quantity'],
  AMOUNT:['value','amount','balance','balance_in_portfolio_currency','price','brokerage','gross_amount','resident_withholding_tax','tax_credit'],
  CURRENCY:['currency','currency_code','portfolio_currency','instrument_currency'],
  DATE:['date','date_time','start_date','end_date','paid_on','transaction_date'],
  STATE:['valid_position','state','confirmed','non_taxable','include_sales','include_limited','consolidated','report_combined','grouping','portfolio_tz_name'],
  TEXT:['name','description','foreign_identifier','comments','annotation'],
  KIND:['description_code','cash_account_transaction_type'],
  STRUCTURE:['report','holdings','cash_accounts','trades','cash_account_transactions','portfolios','links'],
};
const keyGroup=new Map(Object.entries(GROUP_KEYS).flatMap(([g,ks])=>ks.map(k=>[k,g])));
const PARENT_GROUP={instrument:'INSTRUMENT',portfolio:'PORTFOLIO',currency:'CURRENCY',instrument_currency:'CURRENCY',cash_account_transaction_type:'KIND',links:'ID'};
const groupOf=(key,parent)=>PARENT_GROUP[parent]||keyGroup.get(key)||'UNKNOWN';
function diffGroups(p,q,key,parent,out){
  const isSet=v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===1&&Object.hasOwn(v,'__idset');
  if(isSet(p)&&isSet(q)){
    const a=p.__idset,b=q.__idset,ids=new Set([...Object.keys(a),...Object.keys(b)]);
    for(const id of ids){if(!Object.hasOwn(a,id)||!Object.hasOwn(b,id)){out.add('ROWSET');continue;}diffGroups(a[id],b[id],key,parent,out);}
    return;
  }
  if(isSet(p)!==isSet(q)){out.add('ARRAY');return;}
  if(Array.isArray(p)&&Array.isArray(q)){if(p.length!==q.length){out.add('ARRAY');return;}p.forEach((e,i)=>diffGroups(e,q[i],key,parent,out));return;}
  const obj=v=>v&&typeof v==='object'&&!Array.isArray(v);
  if(obj(p)&&obj(q)){
    for(const k of new Set([...Object.keys(p),...Object.keys(q)])){
      if(!Object.hasOwn(p,k)||!Object.hasOwn(q,k)){out.add('MEMBER_SET');out.add(groupOf(k,key));continue;}
      diffGroups(p[k],q[k],k,key,out);
    }
    return;
  }
  if(Array.isArray(p)!==Array.isArray(q)||obj(p)!==obj(q)||typeof p!==typeof q||(p===null)!==(q===null)){out.add('TYPE');return;}
  if(p!==q)out.add(groupOf(key,parent));
}
// Did any excluded member of a matched catalog row differ? Rows are matched by
// id; only the listed member names are read, nothing else is derived.
function excludedMembersDiffer(r,s,rules){
  const ex=rules.excluded;if(!ex)return false;
  let u,v;try{u=JSON.parse(r.body);v=JSON.parse(s.body);}catch{return false;}
  const rowsOf=o=>ex.root.reduce((x,k)=>x&&typeof x==='object'?x[k]:undefined,o);
  const ru=rowsOf(u),rv=rowsOf(v);if(!idRows(ru)||!idRows(rv))return false;
  const m=new Map(rv.map(e=>[e.id,e]));
  return ru.some(e=>m.has(e.id)&&ex.members.some(k=>canonical(e[k]===undefined?null:e[k])!==canonical(m.get(e.id)[k]===undefined?null:m.get(e.id)[k])||Object.hasOwn(e,k)!==Object.hasOwn(m.get(e.id),k)));
}
function metadataValuesDiffer(r,s,rules){
  if(!rules.metadata)return false;
  const a=canonicalJson(r.body,rules.unordered,rules.excluded,true),b=canonicalJson(s.body,rules.unordered,rules.excluded,true);
  // Only same-type values present in both valid documents use the exception.
  // The lexer also observes value lexemes, so 1 -> 1.0 is marked, not silent.
  return !!a&&!!b&&[...a.metadata].some(([key,value])=>b.metadata.has(key)&&b.metadata.get(key)!==value);
}
export function recordsEvidence(a,b,contract=null){
  const routes={},add=(path,g)=>{const c=routeClass(path);(routes[c]||=new Set()).add(g);};
  for(const records of [a,b]){const seen=new Set();for(const r of records){const k=routeKey(r);if(seen.has(k))add(r.path,'DUP_ROUTE');seen.add(k);}}
  const x=new Map(a.map(r=>[routeKey(r),r])),y=new Map(b.map(r=>[routeKey(r),r]));
  for(const k of [...new Set([...x.keys(),...y.keys()])].sort()){
    const r=x.get(k),s=y.get(k);
    if(!r||!s){add((r||s).path,'ROUTE_SET');continue;}
    const rules=rulesFor(contract,r);
    if(excludedMembersDiffer(r,s,rules))add(r.path,SOURCE_EVIDENCE_ALLOWED);
    if(metadataValuesDiffer(r,s,rules))add(r.path,SOURCE_EVIDENCE_METADATA_ALLOWED);
    if(lexicalRecordEquivalent(r,s,contract))continue;
    if(lexicalCanonicalJson(r.body,rules.unordered,rules.excluded,rules.metadata)===null||lexicalCanonicalJson(s.body,rules.unordered,rules.excluded,rules.metadata)===null){add(r.path,'RAW');continue;}
    const pr=normalized(r.body,rules),ps=normalized(s.body,rules);
    if(canonical(pr)===canonical(ps)){add(r.path,'LEX');continue;}
    const out=new Set();diffGroups(pr,ps,null,null,out);
    for(const g of out)add(r.path,g);
    if(!out.size)add(r.path,'UNKNOWN');
  }
  const ordered={};
  for(const c of SOURCE_RECORDS_ROUTES)if(routes[c])ordered[c]=Object.freeze(SOURCE_EVIDENCE_GROUPS.filter(g=>routes[c].has(g)));
  return Object.freeze(ordered);
}
// True when the evidence holds a blocking group (anything but allowed markers).
export const evidenceHasBlocking=v=>Object.values(v||{}).some(g=>g.some(x=>x!==SOURCE_EVIDENCE_ALLOWED&&x!==SOURCE_EVIDENCE_METADATA_ALLOWED));
// Strict shape check for anything that is about to leave as evidence.
export function isRecordsEvidence(v){
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype)return false;
  return Object.keys(v).every(c=>SOURCE_RECORDS_ROUTES.includes(c)&&Array.isArray(v[c])&&v[c].length>0&&v[c].every(g=>SOURCE_EVIDENCE_GROUPS.includes(g)));
}
// A raw body string is compared in its lexical form; a non-string is compared
// structurally. Used for a projection of raw bodies (path→body maps).
export function lexicalBodiesCanonical(value){
  const walk=v=>typeof v==='string'?(()=>{const l=lexicalCanonicalJson(v);return l===null?{rawBody:v}:{lexicalBody:l};})()
    :Array.isArray(v)?v.map(walk):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).map(k=>[k,walk(v[k])])):v;
  return canonical(walk(value));
}
