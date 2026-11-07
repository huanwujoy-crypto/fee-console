// Pure source projection, not a synchronization receipt or business approval.
// Only a trusted coordinator may select scope and supply authenticated raw GET
// results. No network, credentials, writes, date adjustment or financial math.
import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {CLOUD_ACCOUNTS,parseSourceJson,exactNumberText} from './fee-cloud-source.mjs';

const PREFIX='FEE_SYNC_PROJECTION_',failures=new WeakMap();
const MAX_BYTES=4*1024*1024,MAX_DOCUMENT=2*1024*1024,MAX_NODES=100000;
const ID_KEYS=new Set(['id','portfolio_id','holding_id','cash_account_id','trade_id','payout_id','company_event_id']);
const names=Object.freeze({schwab:'Schwab-HK',webull:'Webull','ib-manager':'IB-HK'});
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function fail(code){const e=new Error(PREFIX+code);failures.set(e,code);throw Object.freeze(e);}
export const syncProjectionFailureCode=e=>PREFIX+(failures.get(e)||'REFUSED');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':object(v)?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function plain(value){
  let nodes=0,bytes=0;const active=new Set();
  const copy=(v,depth)=>{
    if(++nodes>MAX_NODES||depth>64)fail('JSON');
    if(v===null||typeof v==='boolean')return v;
    if(typeof v==='string'){bytes+=Buffer.byteLength(v,'utf8');if(bytes>MAX_BYTES)fail('SIZE');return v;}
    if(typeof v==='number'){if(!Number.isFinite(v)||Object.is(v,-0)||Math.abs(v)>Number.MAX_SAFE_INTEGER)fail('JSON');return v;}
    if(typeof v!=='object'||types.isProxy(v)||active.has(v))fail('JSON');
    const array=Array.isArray(v),proto=Object.getPrototypeOf(v);
    if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)fail('JSON');
    const ds=Object.getOwnPropertyDescriptors(v),ks=Reflect.ownKeys(ds);
    if(ks.some(k=>typeof k!=='string'||['__proto__','constructor','prototype'].includes(k)))fail('JSON');
    active.add(v);let result;
    if(array){
      const size=ds.length?.value;
      if(!Number.isSafeInteger(size)||size<0||size>MAX_NODES||ks.length!==size+1)fail('JSON');
      result=[];for(let i=0;i<size;i++){const d=ds[String(i)];if(!d||!Object.hasOwn(d,'value')||!d.enumerable)fail('JSON');result.push(copy(d.value,depth+1));}
    }else{
      result={};for(const k of ks.sort()){const d=ds[k];if(!Object.hasOwn(d,'value')||!d.enumerable)fail('JSON');bytes+=Buffer.byteLength(k);if(bytes>MAX_BYTES)fail('SIZE');Object.defineProperty(result,k,{value:copy(d.value,depth+1),enumerable:true});}
    }
    active.delete(v);return result;
  };
  return copy(value,0);
}
function exact(o,required,optional=[]){if(!object(o)||required.some(k=>!Object.hasOwn(o,k))||Object.keys(o).some(k=>!required.includes(k)&&!optional.includes(k)))fail('SCHEMA');}
function id(v){if(!Number.isSafeInteger(v)||v<=0)fail('IDENTITY');return v;}
const nullableId=v=>v==null?null:id(v);
function text(v,max=4096){if(typeof v!=='string'||v.length>max||/[\u0000-\u001f\u007f]/.test(v))fail('SCHEMA');return v;}
function day(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v+'T00:00:00Z'))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)fail('DATE');return v;}
function timestamp(v){
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(v)||!Number.isFinite(Date.parse(v)))fail('DATE');
  if(/[+-]14:(?!00$)/.test(v))fail('DATE');
  day(v.slice(0,10));return v;
}
function currency(v){if(typeof v!=='string'||!(/^[A-Z]{3}$/).test(v))fail('CURRENCY');return v;}
function inRange(v,scope){day(v);if(v<scope.fromDate||v>scope.targetDate)fail('DATE');return v;}

// JSON.parse silently accepts duplicate keys and non-finite numeric literals.
// Scan the actual source text before parsing, including escaped key aliases.
function checkJson(source){
  if(typeof source!=='string'||Buffer.byteLength(source,'utf8')>MAX_DOCUMENT)fail('SIZE');
  let i=0,nodes=0;const ws=()=>{while(/[\x20\t\r\n]/.test(source[i]||'!'))i++;};
  const string=()=>{
    if(source[i]!=='"')fail('JSON');const start=i++;
    while(i<source.length){const c=source[i++];if(c==='"'){try{return JSON.parse(source.slice(start,i));}catch{fail('JSON');}}if(c==='\\')i++;}
    fail('JSON');
  };
  const value=(depth,key=null)=>{
    if(++nodes>MAX_NODES||depth>64)fail('JSON');ws();const c=source[i];
    if(c==='{'){
      i++;ws();const keys=new Set();if(source[i]==='}'){i++;return;}
      for(;;){ws();const k=string();if(keys.has(k)||['__proto__','constructor','prototype'].includes(k))fail('JSON');keys.add(k);ws();if(source[i++]!==':')fail('JSON');value(depth+1,k);ws();const next=source[i++];if(next==='}')return;if(next!==',')fail('JSON');}
    }
    if(c==='['){i++;ws();if(source[i]===']'){i++;return;}for(;;){value(depth+1);ws();const next=source[i++];if(next===']')return;if(next!==',')fail('JSON');}}
    if(c==='"'){string();return;}
    for(const literal of ['true','false','null'])if(source.startsWith(literal,i)){i+=literal.length;return;}
    const m=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(i));
    if(!m||m[0].length>128)fail('JSON');const n=Number(m[0]);
    if(!Number.isFinite(n)||Object.is(n,-0)||Math.abs(n)>Number.MAX_SAFE_INTEGER||n===0&&/[1-9]/.test(m[0].split(/[eE]/)[0]))fail('JSON');
    if(ID_KEYS.has(key)){
      const q=/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(m[0]);
      let digits=(q[2]+(q[3]||'')).replace(/^0+/,'');const zeros=/0+$/.exec(digits)?.[0].length||0;
      digits=digits.slice(0,digits.length-zeros);const exponent=Number(q[4]||0)-(q[3]||'').length+zeros;
      if(q[1]||!digits||!Number.isSafeInteger(n)||n<=0||exponent<0||exponent>15||BigInt(digits)*10n**BigInt(exponent)!==BigInt(n))fail('IDENTITY');
    }
    i+=m[0].length;
  };
  value(0);ws();if(i!==source.length)fail('JSON');
}
function parse(source){checkJson(source);try{return parseSourceJson(source);}catch{fail('JSON');}}
function complete(o){
  if(!object(o)||o.links?.next||o.pagination?.next_page||o.meta?.pagination?.next_page||o.meta?.next_page||o.next_page||o.has_more===true||o.complete===false||o.restricted===true||o.limited===true||o.truncated===true)fail('INCOMPLETE');
  if(['has_more','complete','restricted','limited','truncated'].some(k=>Object.hasOwn(o,k)&&typeof o[k]!=='boolean'))fail('INCOMPLETE');
  return o;
}
function rows(o,key){complete(o);if(!Array.isArray(o[key])||o[key].length>10000||o[key].some(x=>!object(x)))fail('SCHEMA');const seen=new Set();for(const r of o[key]){const n=id(r.id);if(seen.has(n))fail('DUPLICATE');seen.add(n);}return o[key];}
function number(row,key){try{return exactNumberText(row,key);}catch{fail('NUMBER');}}
function portfolio(row,scope){if(row.portfolio?.id!==scope.portfolioId||row.portfolio?.name!==scope.name)fail('IDENTITY');}
function instrument(row){
  if(row==null)return null;
  if(!object(row))fail('IDENTITY');
  const code=text(row.code,128),marketCode=text(row.market_code,32);
  if(!code.trim()||!marketCode.trim())fail('IDENTITY');
  return {id:nullableId(row.id),code,marketCode,currency:currency(row.currency_code)};
}
function keyed(o){if(!object(o)||Object.keys(o).length>10000||Object.keys(o).some(k=>!/^\d+$/.test(k)||String(id(Number(k)))!==k||typeof o[k]!=='string'))fail('SCHEMA');return Object.keys(o).sort((a,b)=>Number(a)-Number(b));}
const sorted=xs=>xs.sort((a,b)=>a.id-b.id);

export function projectSharesightSyncAccount(request){
  try{
    const copied=plain(request);exact(copied,['scope','raw']);const {scope,raw}=copied;
    exact(scope,['role','portfolioId','name','targetDate','fromDate']);
    if(!Object.hasOwn(names,scope.role)||scope.name!==names[scope.role])fail('SCOPE');id(scope.portfolioId);
    if(scope.role!=='ib-manager'&&scope.portfolioId!==CLOUD_ACCOUNTS[scope.role].portfolioId)fail('SCOPE');
    day(scope.targetDate);day(scope.fromDate);if(scope.fromDate>scope.targetDate)fail('DATE');
    exact(raw,['performance','cashAccounts','trades','cashTransactions'],['payouts']);
    const cashKeys=keyed(raw.cashTransactions),payoutKeys=keyed(raw.payouts||{});
    const performance=complete(parse(raw.performance)),report=complete(performance.report);
    if(report.portfolio_id!==scope.portfolioId||report.start_date!==scope.targetDate||report.end_date!==scope.targetDate||report.currency?.code!=='USD'||report.portfolio_tz_name!=='America/New_York'||report.include_sales!==false)fail('IDENTITY');
    const holdings=sorted(rows(report,'holdings').map(r=>{
      portfolio(r,scope);if(r.valid_position!==true)fail('IDENTITY');const ins=instrument(r.instrument);
      if(!ins||currency(r.instrument_currency?.code)!==ins.currency)fail('IDENTITY');
      return {id:r.id,instrument:ins,quantity:number(r,'quantity'),value:number(r,'value')};
    }));
    const reportCash=rows(report,'cash_accounts'),cash=sorted(rows(parse(raw.cashAccounts),'cash_accounts').map(r=>{
      if(r.portfolio_id!==scope.portfolioId||r.portfolio_currency!=='USD'||r.date!==scope.targetDate)fail('IDENTITY');
      const c=reportCash.find(x=>x.id===r.id);if(!c)fail('IDENTITY');portfolio(c,scope);
      if(currency(r.currency)!==currency(c.currency?.code))fail('CURRENCY');
      return {id:r.id,currency:r.currency,date:r.date,nativeBalance:number(r,'balance'),portfolioBalance:number(r,'balance_in_portfolio_currency'),reportValue:number(c,'value')};
    }));
    if(cash.length!==reportCash.length||cashKeys.length!==cash.length||cash.some(c=>!Object.hasOwn(raw.cashTransactions,String(c.id))))fail('IDENTITY');
    const trades=sorted(rows(parse(raw.trades),'trades').map(r=>{
      if(r.portfolio_id!==scope.portfolioId)fail('IDENTITY');
      return {id:r.id,holdingId:id(r.holding_id),transactionDate:inRange(r.transaction_date,scope),type:text(r.description_code,128),state:text(r.state,128),instrument:instrument(r.instrument),quantity:number(r,'quantity'),price:number(r,'price'),value:number(r,'value'),brokerage:number(r,'brokerage')};
    }));
    const eventIds=new Set(),cashEvents=[];
    for(const key of cashKeys){
      const c=cash.find(x=>x.id===Number(key));
      for(const r of rows(parse(raw.cashTransactions[key]),'cash_account_transactions')){
        if(r.cash_account_id!==c.id||eventIds.has(r.id))fail('IDENTITY');eventIds.add(r.id);
        if(r.links?.portfolio&&r.links.portfolio!=='https://api.sharesight.com/api/v2/portfolios/'+scope.portfolioId)fail('IDENTITY');
        // A timestamp's printed date is neither the trusted GET query range nor
        // necessarily this event's business date. UTC/offset crossings and
        // linked trade/payout date carriers are interpreted by the original
        // business validator. Preserve the exact source timestamp here; scope
        // and every raw byte remain hash-bound, without granting acceptance.
        const dateTime=timestamp(r.date_time);
        cashEvents.push({id:r.id,cashAccountId:c.id,currency:c.currency,dateTime,type:text(r.cash_account_transaction_type?.name,128),amount:number(r,'amount'),balance:number(r,'balance'),tradeId:nullableId(r.trade_id),holdingId:nullableId(r.holding_id),payoutId:nullableId(r.payout_id),description:r.description==null?'':text(r.description,8192),foreignIdentifier:r.foreign_identifier==null?'':text(r.foreign_identifier,8192)});
      }
    }
    sorted(cashEvents);
    const payouts=payoutKeys.map(key=>{
      const r=complete(parse(raw.payouts[key]));if(id(r.id)!==Number(key)||r.portfolio_id!==scope.portfolioId)fail('IDENTITY');
      if(typeof r.confirmed!=='boolean')fail('SCHEMA');
      const h=id(r.holding_id),cc=currency(r.currency),events=cashEvents.filter(x=>x.payoutId===r.id);
      if(!events.length||events.some(e=>e.holdingId!==h||e.currency!==cc))fail('IDENTITY');
      // Official payout date may precede its evidenced cash posting window.
      // Preserve it; the original validator checks the actual event linkage.
      return {id:r.id,holdingId:h,currency:cc,paidOn:day(r.paid_on),confirmed:r.confirmed,state:text(r.state,128),grossAmount:number(r,'gross_amount'),withholdingTax:number(r,'resident_withholding_tax'),amount:number(r,'amount'),taxCredit:number(r,'tax_credit')};
    });
    return freeze({schema:'fee-console.sync-source-projection.v1',sourceSha256:hash({scope,raw}),identity:{...scope,provider:'Sharesight',currency:'USD',timezone:report.portfolio_tz_name},reportedValue:number(report,'value'),holdings,cash,trades,cashEvents,payouts});
  }catch(e){if(failures.has(e))throw e;fail('REFUSED');}
}
