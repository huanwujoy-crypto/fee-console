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
