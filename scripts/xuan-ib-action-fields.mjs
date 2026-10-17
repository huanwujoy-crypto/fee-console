// One bounded current capture; retain each successful sibling independently.
import {ordersOf} from './xuan-ib-night-action-model.mjs';
import {normalizePositions,unwrapSource} from './xuan-ib-source-adapter.mjs';
import {parseSharesightCash} from './xuan-ib-sharesight-allocation.mjs';
import {inspectOrdersAccountEvidence} from '../cloud/xuan-preopen/orders_probe.mjs';
const keys=['ib.accountSummary','ib.positions','ib.orders'];
const instant=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)&&Number.isFinite(Date.parse(s));
const hkt=s=>new Date(Date.parse(s)+28800000).toISOString().slice(0,10);
export const fieldState=(source,status,dataDate=null,readAt=null)=>({source,status,dataDate,readAt});
export const ACTION_ERROR_CODES=Object.freeze({
  ibCash:['CASH_SOURCE_UNAVAILABLE','CASH_FIELDS_MISSING','CASH_SOURCE_INVALID','CASH_SOURCE_DATE_MISMATCH','CASH_VALUE_OUT_OF_RANGE'],
  noahCash:['CASH_SOURCE_UNAVAILABLE','CASH_FIELDS_MISSING','CASH_SOURCE_INVALID','CASH_SOURCE_DATE_MISMATCH','CASH_VALUE_OUT_OF_RANGE'],
  allocation:['ALLOCATION_SOURCE_INVALID','ALLOCATION_SOURCE_UNAVAILABLE','ALLOCATION_SOURCE_DATE_MISMATCH'],
  orderCurrency:['CURRENCY_SOURCE_INVALID','CURRENCY_SOURCE_UNAVAILABLE','CURRENCY_AMBIGUOUS'],
  orders:['ORDERS_SOURCE_UNAVAILABLE','ORDERS_PAYLOAD_INVALID','ORDERS_COVERAGE_UNVERIFIED'],
  orderReserve:['BUY_RESERVE_DEPENDENCIES_UNKNOWN','BUY_RESERVE_CURRENCY_UNKNOWN','BUY_RESERVE_OUT_OF_RANGE'],
  allocationProjection:['PROJECTION_DEPENDENCIES_UNKNOWN','PROJECTION_INVALID'],
  fundingNeed:['FUNDING_NEED_INVALID'],replenishment:['PLAN_DEPENDENCIES_UNKNOWN','PLAN_DERIVATION_INVALID'],
  cashPool:['CASH_POOL_OUT_OF_RANGE'],cashLike:['CASH_LIKE_INVALID'],capacity:['TOTAL_CAPACITY_OUT_OF_RANGE'],
  holdings:['HOLDINGS_SOURCE_UNAVAILABLE','HOLDINGS_DETAIL_UNSUPPORTED'],call:['OWNER_DECLARATION_UNAVAILABLE']});
export const emptyActionErrors=()=>Object.fromEntries(Object.keys(ACTION_ERROR_CODES).map(k=>[k,null]));
export function readCurrentActionFields({live,dataDate,startedAt,completedAt,previousHtml='',currencyBySymbol={}}={}){
  const sources=Array.isArray(live?.sources)?live.sources:[],states={},accepted={};
  let brokerFundsReason='BROKER_FUNDS_SOURCE_UNAVAILABLE';
  for(const key of keys){
    const rows=sources.filter(s=>s&&typeof s==='object'&&s.sourceKey===key),row=rows[0];
    let status=live?.status==='not-called'||!live?'not-called':'request-failure';
    if(rows.length===1&&row.raw){
      status='malformed';
      try{
        if(!instant(row.startedAt)||!instant(row.completedAt)||row.startedAt>row.completedAt||row.startedAt<startedAt||row.completedAt>completedAt
          ||hkt(row.startedAt)!==dataDate||hkt(row.completedAt)!==dataDate||Date.parse(row.completedAt)-Date.parse(row.startedAt)>300000)throw Error('TIME');
        const kind=key.split('.')[1];
        if(kind==='accountSummary'&&row.raw.currency==='BASE')brokerFundsReason='BROKER_FUNDS_CURRENCY_UNVERIFIED';
        unwrapSource(kind,row.raw);inspectOrdersAccountEvidence(row.raw);if(kind==='positions')normalizePositions(row.raw);
        accepted[key]=row;status='ready';
      }catch{}
    }
    states[key]=fieldState(key,status,status==='ready'?dataDate:null,status==='ready'?row.completedAt:null);
  }
  let current=null;
  const summary=accepted['ib.accountSummary'];
  if(summary){if(summary.raw.currency==='USD')current={currency:'USD',cash:summary.raw.total_cash_value,
    availableFunds:typeof summary.raw.available_funds==='number'&&Number.isFinite(summary.raw.available_funds)?summary.raw.available_funds:null};
    else states['ib.accountSummary']=fieldState('ib.accountSummary','malformed');}
  let orders={status:'unknown',asOfHkt:'未取得',buys:null,sells:null,reason:'ORDERS_NOT_CAPTURED'},coverage='unknown';
  const orderSource=accepted['ib.orders'];
  if(orderSource){
    try{
      const raw=orderSource.raw,groups=ordersOf(raw,accepted['ib.positions']?.raw??{positions:[]},{dataDate,previousHtml,currencyBySymbol});
      const counts=['total_count','order_count'].filter(key=>Object.hasOwn(raw,key));
      const countsAgree=counts.every(key=>Number.isSafeInteger(raw[key])&&raw[key]>=0&&raw[key]===raw.orders.length);
      const flagsAgree=(!Object.hasOwn(raw,'complete')||raw.complete===true)
        &&(!Object.hasOwn(raw,'has_more')||raw.has_more===false);
      const noContinuation=(!Object.hasOwn(raw,'next_cursor')||raw.next_cursor===null||raw.next_cursor==='')
        &&(!Object.hasOwn(raw,'pagination')||raw.pagination===null);
      coverage=(raw.complete===true||counts.length>0)&&countsAgree&&flagsAgree&&noContinuation?'complete':'unknown';
      if(groups.buys.length+groups.sells.length>60)throw Error('ORDER_LIMIT');
      const start=orderSource.startedAt,end=orderSource.completedAt,clock=s=>new Date(Date.parse(s)+28800000).toISOString().slice(11,16);
      orders={status:coverage==='complete'?'ready':'partial',asOfHkt:dataDate+' '+clock(start)+(clock(start)===clock(end)?'':'–'+clock(end))+' HKT',capturedStartedAt:start,capturedCompletedAt:end,...groups,coverage};
      states['ib.orders'].status=coverage==='complete'?'ready':'partial';
    }catch{states['ib.orders']=fieldState('ib.orders','malformed');orders.reason='ORDERS_MALFORMED_OR_UNMATCHED';}
  }
  let availableFunds={status:'unknown',reason:brokerFundsReason};
  if(summary){
    const raw=summary.raw;
    if(!Object.hasOwn(raw,'available_funds'))availableFunds.reason='BROKER_FUNDS_FIELD_MISSING';
    else if(typeof raw.available_funds!=='number'||!Number.isFinite(raw.available_funds)||Math.abs(raw.available_funds)>1e12)availableFunds.reason='BROKER_FUNDS_VALUE_INVALID';
    else if(!/^[A-Z]{3}$/.test(raw.currency)||raw.currency==='BASE')availableFunds.reason='BROKER_FUNDS_CURRENCY_UNVERIFIED';
    else availableFunds={status:'recorded',amount:raw.available_funds,currency:raw.currency,source:'ib.accountSummary',readAt:summary.completedAt,
      accountBasis:inspectOrdersAccountEvidence(raw).responseAccountEvidence==='matched'?'response-account-id':'owner-attested'};
  }
  return {states,current,orders,coverage,availableFunds};
}
export function sharesightBookCash(snapshot,{portfolioId,sourceDate,onFailure=()=>{}}={}){
  const missing=code=>{onFailure(code);return null;};
  if(!['verified','date-verified'].includes(snapshot?.status))return missing('CASH_SOURCE_UNAVAILABLE');
  const raw=snapshot.raw,r=raw?.report??raw?.data?.report??raw?.result?.data?.report;
  // An absent/empty cash ledger is not evidence of a zero cash balance.
  if(!Array.isArray(r?.cash_accounts))return missing('CASH_SOURCE_INVALID');
  if(r.cash_accounts.length===0)return missing('CASH_FIELDS_MISSING');
  try{const cash=parseSharesightCash(raw,{portfolioId});
    if(cash.dataDate!==sourceDate)return missing('CASH_SOURCE_DATE_MISMATCH');
    if(!Number.isFinite(cash.total)||cash.total<0||cash.total>1e12)return missing('CASH_VALUE_OUT_OF_RANGE');
    return Math.round(cash.total*100)/100;
  }catch{return missing('CASH_SOURCE_INVALID');}
}
export function sharesightOrderCurrencies(snapshot,{onFailure=()=>{}}={}){
  if(!['verified','date-verified'].includes(snapshot?.status)){onFailure('CURRENCY_SOURCE_UNAVAILABLE');return {};}
  const r=snapshot?.raw?.report??snapshot?.raw?.data?.report??snapshot?.raw?.result?.data?.report,map={};
  if(!Array.isArray(r?.holdings)||r.holdings.length>5000){onFailure('CURRENCY_SOURCE_INVALID');return {};}
  for(const h of r.holdings){const i=h?.instrument,symbol=i?.code;
    if(!h||Object.getPrototypeOf(h)!==Object.prototype||!i||Object.getPrototypeOf(i)!==Object.prototype||typeof symbol!=='string'||!symbol.trim()){
      onFailure('CURRENCY_SOURCE_INVALID');return {};
    }
    const supplied=[];
    if(Object.hasOwn(i,'currency'))supplied.push(i.currency?.code);
    if(Object.hasOwn(i,'currency_code'))supplied.push(i.currency_code);
    const currency=supplied.length&&supplied.every(v=>/^[A-Z]{3}$/.test(v||'')&&v===supplied[0])?supplied[0]:null;
    // A missing/invalid/conflicting same-code row makes the key ambiguous.
    // Once ambiguous, later valid rows must not turn it back into USD.
    const key=symbol.trim().toUpperCase();map[key]=Object.hasOwn(map,key)&&(map[key]===null||currency===null||map[key]!==currency)?null:currency;
    if(map[key]===null)onFailure('CURRENCY_AMBIGUOUS');
  }
  return map;
}
export function validateActionFieldState(m){
  const fail=()=>{throw Error('EOD_MODEL_FIELD_STATE');},exact=(o,ks)=>o&&Object.keys(o).sort().join('|')===ks.sort().join('|'),finite=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1e12;
  const date=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d+'T00:00:00Z'));
  const capture=m.provenance?.capture;
  if(!exact(capture,['startedAt','completedAt'])||!instant(capture.startedAt)||!instant(capture.completedAt)||capture.startedAt>capture.completedAt
    ||hkt(capture.startedAt)!==m.dataDate||hkt(capture.completedAt)!==m.dataDate||Date.parse(capture.completedAt)-Date.parse(capture.startedAt)>300000)fail();
  const allowed={ibCash:['sharesight.ibGroupedPerformance','ib.flexEod'],noahCash:['sharesight.noahPerformance'],orders:['ib.orders'],allocation:['sharesight.ibGroupedPerformance'],call:['owner.callDeclaration'],orderReserve:['derived.buyReserve'],planning:['derived.cashPlan']};
  if(!exact(m.fieldState,Object.keys(allowed)))fail();
  if(!exact(m.fieldErrors,Object.keys(ACTION_ERROR_CODES))||Object.entries(m.fieldErrors).some(([k,v])=>v!==null&&!ACTION_ERROR_CODES[k].includes(v)))fail();
  for(const [key,s] of Object.entries(m.fieldState)){
    if(!exact(s,['source','status','dataDate','readAt'])||!allowed[key].includes(s.source)
      ||!['ready','recorded','partial','blocked','not-called','request-failure','missing-fields','date-mismatch','malformed','unverified','failed','timeout','owner-declared','unavailable','invalid'].includes(s.status)
      ||!(s.dataDate===null||date(s.dataDate)&&s.dataDate<=m.dataDate)||!(s.readAt===null||instant(s.readAt)&&s.readAt>=capture.startedAt&&s.readAt<=capture.completedAt))fail();
  }
  const c=m.cash,call=c.call,b=c.book;
  if(!exact(call,['status','declarationDate','declarationSha256'])||!['owner-declared','unavailable','invalid'].includes(call.status)
    ||!(call.declarationDate===null||date(call.declarationDate)&&call.declarationDate<=m.dataDate)
    ||!(call.declarationSha256===null||/^[a-f0-9]{64}$/.test(call.declarationSha256))
    ||call.declarationDate===null&&call.declarationSha256!==null||call.declarationDate!==null&&call.declarationSha256===null
    ||(call.status==='owner-declared'?(!finite(c.reserve)||call.declarationDate===null):(c.reserve!==null||c.callApplied!==null||c.planning!==null)))fail();
  if(!exact(b,['ib','sourceDate'])||b.sourceDate!==m.sourceDate||!(b.ib===null||finite(b.ib))||c.ib!==(b.ib!==null?b.ib:c.eod.status==='verified'?c.eod.tradeDate:null))fail();
  for(const [key,known] of [['ibCash',c.ib!==null],['noahCash',c.noah!==null],['allocation',m.allocation.status==='ready']]){
    const s=m.fieldState[key];if(known!==['ready','recorded'].includes(s.status)||known&&(s.dataDate!==m.sourceDate||s.readAt===null))fail();
  }
  if(b.ib!==null&&m.fieldState.ibCash.source!=='sharesight.ibGroupedPerformance'||b.ib===null&&c.ib!==null&&m.fieldState.ibCash.source!=='ib.flexEod')fail();
  if(m.fieldState.call.status!==call.status||m.fieldState.call.dataDate!==call.declarationDate)fail();
  if(m.fieldState.orders.status!==(m.orders.status==='unknown'?m.fieldState.orders.status:m.orders.status==='partial'?'partial':'ready')
    ||m.orders.status==='unknown'&&['ready','partial','recorded'].includes(m.fieldState.orders.status))fail();
  if(m.orders.status==='partial'&&(c.orderReserve!==null||c.planning!==null||m.allocation.projectedTotal!==null))fail();
  if((c.orderReserve!==null)!==(m.fieldState.orderReserve.status==='ready')||(c.planning!==null)!==(m.fieldState.planning.status==='ready'))fail();
  if(c.planningBasis.status==='reference'&&(b.ib===null||call.status!=='owner-declared'||m.orders.status!=='ready'||m.orders.coverage!=='complete'
    ||c.planningBasis.assumption!=='BOOK_CASH_AND_REMAINING_ORDERS'||c.planningBasis.sourceDate!==m.sourceDate||c.noah===null))fail();
  // Diagnostics are closed and bound to the contribution states. A recognized
  // failure code cannot accompany a successful contribution to hide tampering.
  const errors=m.fieldErrors,a=m.allocation,o=m.orders;
  if((b.ib!==null)!==(errors.ibCash===null)||(c.noah!==null)!==(errors.noahCash===null)
    ||(a.status==='ready')!==(errors.allocation===null)||(c.orderReserve!==null)!==(errors.orderReserve===null)
    ||(a.projectedTotal!==null)!==(errors.allocationProjection===null)
    ||(m.replenishment.status==='ready')!==(errors.replenishment===null)
    ||(m.holdings.status==='ready')!==(errors.holdings===null)
    ||(call.status==='owner-declared')!==(errors.call===null))fail();
  const ordersError=o.status==='ready'?null:o.status==='partial'?'ORDERS_COVERAGE_UNVERIFIED':m.fieldState.orders.status==='malformed'?'ORDERS_PAYLOAD_INVALID':'ORDERS_SOURCE_UNAVAILABLE';
  if(errors.orders!==ordersError||errors.fundingNeed!==(a.fundingNeed?.status==='unknown'?'FUNDING_NEED_INVALID':null)
    ||errors.cashLike!==(a.status==='ready'&&c.cashLike===null?'CASH_LIKE_INVALID':null)
    ||errors.cashPool!==(c.ib!==null&&c.noah!==null&&!finite(Math.round((c.ib+c.noah)*100)/100)?'CASH_POOL_OUT_OF_RANGE':null)
    ||errors.capacity!==(c.planning!==null&&c.cashLike!==null&&!finite(Math.round((c.planning+c.cashLike.total)*100)/100)?'TOTAL_CAPACITY_OUT_OF_RANGE':null))fail();
  return m;
}
