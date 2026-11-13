// Pure projection of ONE already-captured Sharesight API V3 consolidated
// performance report (custom-group classification, same start and end date)
// into the classification rows the ratio pipeline already consumes.
//
// This module performs no network request, reads no credential, writes no
// file and publishes nothing. It is not wired into any producer, workflow or
// page. Passing these checks proves only that the supplied object has the
// expected shape and scope; it is not source authentication, a reconciliation
// with the official UI, or permission to publish.
//
// Every refusal names its stage, so a failed capture reports where it stopped
// instead of a generic error. No value is repaired, rounded, defaulted to zero
// or inferred from a total.
export function createApiRatioSourceCore(){
  const CAPTURE='fee-console.ratio-api-classification.v1';
  const CODES=Object.freeze(['CAPTURE','SCOPE','REPORT','DATES','GROUP','CURRENCY','HOLDING','HOLDING_LIMITED','HOLDING_POSITION','HOLDING_ACCOUNT','HOLDING_VALUE','HOLDING_DUPLICATE','CASH','CASH_ACCOUNT','CASH_VALUE','CASH_DUPLICATE']);
  const fail=code=>{throw Error('RATIO_API_SOURCE_'+(CODES.includes(code)?code:'CAPTURE'));};
  const plain=o=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&Object.getPrototypeOf(o)===Object.prototype;
  const exact=(o,k)=>plain(o)&&Object.keys(o).sort().join('|')===[...k].sort().join('|');
  const text=s=>typeof s==='string'&&s.length>0&&s.length<=1000&&s===s.trim()&&!/[\u0000-\u001f\u007f]/.test(s);
  const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
  const instant=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
  // Sharesight identifiers arrive as JSON numbers or digit strings. Compare
  // them as canonical positive decimal strings; never as rounded floats.
  const id=v=>{
    if(typeof v==='number'&&Number.isSafeInteger(v)&&v>0)return String(v);
    if(typeof v==='string'&&/^[1-9]\d{0,14}$/.test(v))return v;
    return null;
  };
  // Money is accepted only when it is already an exact USD amount to the
  // cent. A value with more precision is refused, not rounded.
  const cents=n=>{
    if(typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>1e12||!/^-?\d+(?:\.\d{1,2})?$/.test(String(n)))return null;
    const c=Math.round(n*100);return Number.isSafeInteger(c)?c:null;
  };
  const GROUPINGS=['custom_group','custom_group_category'];

  function project(capture){
    if(!exact(capture,['schema','provider','view','group','asOf','capturedAt','accounts','report'])||capture.schema!==CAPTURE||capture.provider!=='Sharesight'||!date(capture.asOf)||!instant(capture.capturedAt))fail('CAPTURE');
    // The data date is a Hong Kong calendar date; a capture cannot precede it.
    if(new Date(Date.parse(capture.capturedAt)+8*3600000).toISOString().slice(0,10)<capture.asOf)fail('CAPTURE');
    if(!exact(capture.view,['id','name'])||!exact(capture.group,['id','name'])||!text(capture.view.name)||!text(capture.group.name))fail('SCOPE');
    const viewId=id(capture.view.id),groupId=id(capture.group.id);
    if(!viewId||!groupId||!Array.isArray(capture.accounts)||capture.accounts.length!==10)fail('SCOPE');
    const byId=new Map(),names=new Set();
    for(const a of capture.accounts){
      const aid=exact(a,['id','name'])?id(a.id):null;
      if(!aid||!text(a.name)||byId.has(aid)||names.has(a.name)||aid===viewId)fail('SCOPE');
      byId.set(aid,a.name);names.add(a.name);
    }

    const r=capture.report;
    if(!plain(r)||!Array.isArray(r.holdings)||!Array.isArray(r.cash_accounts)||!Array.isArray(r.sub_totals)||r.holdings.length>5000||r.cash_accounts.length>500)fail('REPORT');
    if(id(r.portfolio_id)!==viewId)fail('SCOPE');
    // Classification is a point-in-time holding list: one date, sold positions excluded.
    if(r.start_date!==capture.asOf||r.end_date!==capture.asOf||r.include_sales!==false)fail('DATES');
    if(!GROUPINGS.includes(r.grouping)||!plain(r.custom_group)||id(r.custom_group.id)!==groupId||r.custom_group.name!==capture.group.name)fail('GROUP');
    if(!plain(r.currency)||r.currency.code!=='USD')fail('CURRENCY');
    const reportCents=cents(r.value);if(reportCents===null)fail('REPORT');

    // The response carries each row's own portfolio. It must be one of the ten
    // declared members by BOTH id and name; a consolidated row is not a member.
    const member=(p,code)=>{
      const pid=plain(p)?id(p.id):null;
      if(!pid||!byId.has(pid)||byId.get(pid)!==p.name||p.consolidated===true)fail(code);
      return byId.get(pid);
    };
    const positions=[],cashAccounts=[],holdingIds=new Set(),cashIds=new Set(),positionKeys=new Set(),cashKeys=new Set(),observed=new Set();
    let row=0,positionCents=0,cashCents=0;
    for(const h of r.holdings){
      const hid=plain(h)?id(h.id):null;
      if(!hid||holdingIds.has(hid)||!plain(h.instrument))fail('HOLDING');
      holdingIds.add(hid);
      if(h.limited!==false)fail('HOLDING_LIMITED');
      if(h.valid_position!==true)fail('HOLDING_POSITION');
      const i=h.instrument;
      if(!text(i.code)||!text(i.market_code)||!text(i.name)||!text(h.group_name)||!(h.quantity===null||typeof h.quantity==='number'&&Number.isFinite(h.quantity)&&h.quantity>=0))fail('HOLDING');
      const account=member(h.portfolio,'HOLDING_ACCOUNT'),value=cents(h.value);
      if(value===null||value<0)fail('HOLDING_VALUE');
      const key=JSON.stringify([account,i.code,i.market_code]);
      if(positionKeys.has(key))fail('HOLDING_DUPLICATE');
      positionKeys.add(key);observed.add(account);positionCents+=value;
      positions.push({sourceRow:++row,account,name:i.name,valueUSD:value/100,sharesightCategory:h.group_name,securityCode:i.code,market:i.market_code,quantity:h.quantity});
    }
    for(const c of r.cash_accounts){
      const cid=plain(c)?id(c.id):null;
      if(!cid||cashIds.has(cid)||!text(c.name))fail('CASH');
      cashIds.add(cid);
      const account=member(c.portfolio,'CASH_ACCOUNT'),value=cents(c.value);
      if(value===null||value<0)fail('CASH_VALUE');
      const key=JSON.stringify([account,c.name]);
      if(cashKeys.has(key))fail('CASH_DUPLICATE');
      cashKeys.add(key);observed.add(account);cashCents+=value;
      cashAccounts.push({sourceRow:++row,account,name:c.name,valueUSD:value/100,sharesightCategory:'Cash Accounts'});
    }
    if(!Number.isSafeInteger(positionCents)||!Number.isSafeInteger(cashCents))fail('REPORT');

    // Each actually held position is one Direct row and each cash account one
    // Cash row at the same value. No ETF look-through row is created, so a
    // ranking built from these rows is a direct-holdings ranking by design.
    const rows=[
      ...positions.map(p=>({sourceRow:p.sourceRow,account:p.account,securityCode:p.securityCode,market:p.market,name:p.name,withinETF:null,ownership:'Direct',valueUSD:p.valueUSD,sourcePercentage:null})),
      ...cashAccounts.map(c=>({sourceRow:c.sourceRow,account:c.account,securityCode:null,market:null,name:c.name,withinETF:null,ownership:'Cash',valueUSD:c.valueUSD,sourcePercentage:null}))
    ];
    const accounts=capture.accounts.map(a=>a.name);
    return {
      asOf:capture.asOf,capturedAt:capture.capturedAt,accounts,
      view:{id:viewId,name:capture.view.name},group:{id:groupId,name:capture.group.name},
      responseGrouping:r.grouping,
      positions,cashAccounts,rows,
      // Disclosed, never reconciled away: the provider's own report total can
      // differ from the sum of its rows. No tolerance is applied here.
      totals:{positionsCents:positionCents,cashCents,rowsCents:positionCents+cashCents,reportCents,reportDeltaCents:reportCents-(positionCents+cashCents)},
      // A member with no open position and no cash is legitimately absent.
      accountsWithoutRows:accounts.filter(a=>!observed.has(a))
    };
  }
  return {CAPTURE,CODES,GROUPINGS,project};
}
