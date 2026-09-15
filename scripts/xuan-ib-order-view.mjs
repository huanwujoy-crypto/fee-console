import {createHash} from 'node:crypto';
// Display-only order grouping. Inputs require same-currency limit and market
// prices and an explicit quote date; never infer a missing price from P/L.
const fail=()=>{throw new Error('Invalid normalized order display');};
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e12;
export function groupOrders(orders){
  if(!Array.isArray(orders)||orders.length>200)fail();
  const normalized=orders.map((order,index)=>{
    const keys=['symbol','side','quantity','limitPrice','marketPrice','currency','marketAsOfHkt','ageDays','status','cancelReview'];
    if(!order||Object.keys(order).sort().join('|')!==keys.sort().join('|'))fail();
    if(!['buy','sell'].includes(order.side)||typeof order.symbol!=='string'||!order.symbol.trim()
      ||!finite(order.quantity)||order.quantity<=0||!finite(order.limitPrice)||order.limitPrice<=0
      ||!/^[A-Z]{3}$/.test(order.currency)||typeof order.status!=='string'||!order.status.trim()
      ||typeof order.cancelReview!=='boolean'||!(order.ageDays===null||Number.isInteger(order.ageDays)&&order.ageDays>=0))fail();
    if(order.marketPrice===null){if(order.marketAsOfHkt!==null)fail();}
    else if(!finite(order.marketPrice)||order.marketPrice<=0||typeof order.marketAsOfHkt!=='string'||!order.marketAsOfHkt.trim())fail();
    const distancePct=order.marketPrice===null?null:(order.limitPrice/order.marketPrice-1)*100;
    return {...order,distancePct,index};
  });
  return ['buy','sell'].map(side=>({side,orders:normalized.filter(order=>order.side===side)
    .sort((a,b)=>(a.distancePct===null?Infinity:Math.abs(a.distancePct))-(b.distancePct===null?Infinity:Math.abs(b.distancePct))||a.index-b.index)
    .map(({index,...order})=>order)}));
}

const attr=(tag,name)=>tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1]??null;
export const orderTrendKey=order=>createHash('sha256').update(JSON.stringify([
  order.symbol.trim(),order.side,order.quantity,order.limitPrice,order.currency,
])).digest('hex');

// Approximate trend state is carried by the last verified report itself. It
// adds no historical quote request and therefore can never delay publication.
export function buildOrderTrends(orders,{previousHtml='',dataDate}={}){
  const groups=groupOrders(orders),previous=new Map();
  if(typeof previousHtml==='string')for(const match of previousHtml.matchAll(/<tr\b[^<>]*\bdata-order-trend-v1="1"[^<>]*>/g)){
    const tag=match[0],key=attr(tag,'data-order-key'),firstDate=attr(tag,'data-order-first-date'),firstPrice=attr(tag,'data-order-first-price'),age=attr(tag,'data-order-age-days');
    if(!/^[0-9a-f]{64}$/.test(key||'')||!/^\d{4}-\d{2}-\d{2}$/.test(firstDate||'')||!/^\d+(?:\.\d+)?$/.test(firstPrice||'')||!/^\d+$/.test(age||'')||previous.has(key))continue;
    const price=Number(firstPrice);if(Number.isFinite(price)&&price>0)previous.set(key,{firstDate,firstPrice:price,ageDays:Number(age)});
  }
  const trends=new Map();
  for(const order of groups.flatMap(group=>group.orders)){
    const key=orderTrendKey(order);
    if(order.marketPrice===null){if(order.ageDays>0)trends.set(key,{kind:'unavailable',label:'趋势未取得',attributes:''});continue;}
    let base=previous.get(key),carried=Boolean(base);
    if(!base||base.firstDate>dataDate||order.ageDays!==null&&base.ageDays>order.ageDays){base={firstDate:dataDate,firstPrice:order.marketPrice,ageDays:order.ageDays??0};carried=false;}
    const attributes=` data-order-trend-v1="1" data-order-key="${key}" data-order-first-date="${base.firstDate}" data-order-first-price="${base.firstPrice}" data-order-age-days="${order.ageDays??0}"`;
    if(order.ageDays===null||order.ageDays===0){trends.set(key,{kind:'none',label:'',attributes});continue;}
    const days=Math.max(0,Math.round((Date.parse(`${dataDate}T00:00:00Z`)-Date.parse(`${base.firstDate}T00:00:00Z`))/86400000));
    if(!carried||days===0){trends.set(key,{kind:'building',label:'趋势建立中',attributes});continue;}
    const pct=(order.marketPrice/base.firstPrice-1)*100,arrow=Math.abs(pct)<0.05?'→':pct>0?'↑':'↓';
    trends.set(key,{kind:pct>0.05?'up':pct<-.05?'down':'flat',label:`约 ${arrow} ${Math.abs(pct).toFixed(1)}% · 观察${days}天`,attributes});
  }
  return trends;
}
