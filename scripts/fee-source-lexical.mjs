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

export const SOURCE_LEXICAL_RULE='fee-console.sharesight-lexical-json.v1';
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

export function lexicalCanonicalJson(text){
  if(typeof text!=='string'||text.length>MAX_TEXT)return null;
  let index=0,nodes=0;
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
  const value=depth=>{
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
        members.push([key,part('k',lexeme)+value(depth+1)]);space();
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
      const items=[];
      for(;;){
        items.push(value(depth+1));space();
        if(text[index]===','){index++;space();continue;}
        if(text[index]===']'){index++;break;}
        refuse();
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
export function lexicalRecord(record){
  const lexical=lexicalCanonicalJson(record.body);
  return {method:record.method,path:record.path,query:record.query,
    ...(lexical===null?{rawBody:record.body}:{lexicalBody:lexical})};
}
// Order-independent digest of a whole GET batch in lexical form. It is a
// comparison key only; the original records and byte hashes remain the proof.
export const lexicalRecordsSha256=records=>hash([...records.map(lexicalRecord)]
  .sort((a,b)=>{const x=canonical(a),y=canonical(b);return x<y?-1:x>y?1:0;}));
export const lexicalRecordEquivalent=(current,original)=>current!==undefined&&original!==undefined
  &&canonical(lexicalRecord(current))===canonical(lexicalRecord(original));
// Identical byte batch, or a strictly lexically equivalent one. Never weaker.
export const lexicalBatchesEquivalent=(a,b)=>a.sha256===b.sha256||lexicalRecordsSha256(a.records)===lexicalRecordsSha256(b.records);
// A raw body string is compared in its lexical form; a non-string is compared
// structurally. Used for a projection of raw bodies (path→body maps).
export function lexicalBodiesCanonical(value){
  const walk=v=>typeof v==='string'?(()=>{const l=lexicalCanonicalJson(v);return l===null?{rawBody:v}:{lexicalBody:l};})()
    :Array.isArray(v)?v.map(walk):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).map(k=>[k,walk(v[k])])):v;
  return canonical(walk(value));
}
