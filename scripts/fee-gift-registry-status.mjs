// Read-only display/query core. This status never authorises a fee, enrolment,
// source read or production attempt. Query files contain selectors only.
export function createFeeGiftRegistryStatusCore(){
 const unknown=()=>({state:'unknown'});
 const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
 const id=n=>Number.isSafeInteger(n)&&n>0;
 const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
 const symbol=s=>typeof s==='string'&&/^[A-Z0-9][A-Z0-9./^-]{0,31}$/.test(s);
 function query(v){
  return exact(v,['schema','account','portfolioId','holdingId','ticker','tradeId','date'])
   &&v.schema==='fee-console.gift-registry-query.v1'&&v.account==='webull'&&v.portfolioId===1350094
   &&id(v.holdingId)&&id(v.tradeId)&&symbol(v.ticker)&&v.date==='2026-10-28';
 }
 function parse(text){
  if(typeof text!=='string'||text.length<2||text.length>2048)throw Error('GIFT_QUERY_INVALID');
  try{
   const value=JSON.parse(text),keys=[...text.matchAll(/"((?:\\.|[^"\\])*)"\s*:/g)].map(m=>JSON.parse('"'+m[1]+'"'));
   if(!query(value)||keys.length!==7||new Set(keys).size!==7)throw Error();
   return value;
  }catch{throw Error('GIFT_QUERY_INVALID');}
 }
 function registry(v){
  if(!exact(v,['schemaVersion','entries'])||v.schemaVersion!==1||!Array.isArray(v.entries)||!v.entries.length||v.entries.length>100)return false;
  const names=new Set(),holdings=new Set();
  for(const r of v.entries){
   if(!exact(r,['id','account','portfolioId','holdingId','ticker','firstHeldOn','effectiveFrom','authorizationRef','giftTradeIds'])
    ||typeof r.id!=='string'||!/^[a-z0-9-]{1,64}$/.test(r.id)||names.has(r.id)||r.account!=='webull'||r.portfolioId!==1350094
    ||!id(r.holdingId)||holdings.has(r.holdingId)||!symbol(r.ticker)||!date(r.firstHeldOn)||!date(r.effectiveFrom)||r.effectiveFrom<r.firstHeldOn
    ||typeof r.authorizationRef!=='string'||!r.authorizationRef.trim()||r.authorizationRef.length>1000
    ||!Array.isArray(r.giftTradeIds)||!r.giftTradeIds.length||!r.giftTradeIds.every(id)||new Set(r.giftTradeIds).size!==r.giftTradeIds.length)return false;
   names.add(r.id);holdings.add(r.holdingId);
  }
  return true;
 }
 function status({ready=false,query:scope,registry:rules}={}){
  if(ready!==true||!query(scope)||!registry(rules))return unknown();
  const r=rules.entries.find(r=>r.account===scope.account&&r.portfolioId===scope.portfolioId
   &&r.holdingId===scope.holdingId&&r.ticker===scope.ticker);
  return {state:r&&r.firstHeldOn<=scope.date&&r.effectiveFrom<=scope.date&&r.giftTradeIds.includes(scope.tradeId)?'matched':'unmatched'};
 }
 return Object.freeze({parse,status});
}
