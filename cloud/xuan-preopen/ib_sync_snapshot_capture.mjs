// Adapter for an IbReadSession already admitted by the existing protected
// controller. No credential loading, refresh, orders, CLI or automatic run.
const used = new WeakSet();
export async function capturePositionsCash(session, {now = Date.now} = {}) {
  if (!session || typeof session.initialize !== 'function' || typeof session.read !== 'function')
    throw new Error('IB_SNAPSHOT_SESSION_REQUIRED');
  if (used.has(session)) throw new Error('IB_SNAPSHOT_SESSION_ALREADY_USED');
  used.add(session); // Admit before any I/O; a failed session is not replayed.
  const startedAt = new Date(now()).toISOString();
  if (session.initialized !== true) await session.initialize();
  const sources = [];
  for (const [tool, expected] of [
    ['get_account_positions', 'ib.positions'],
    ['get_account_balances', 'ib.balances'],
  ]) {
    const readStartedAt = new Date(now()).toISOString();
    const result = await session.read(tool);
    if (result?.sourceKey !== expected || !result.raw || typeof result.raw !== 'object')
      throw new Error('IB_SNAPSHOT_SOURCE_SHAPE_INVALID');
    sources.push({...result, startedAt: readStartedAt, completedAt: new Date(now()).toISOString()});
  }
  // Raw values stay in the existing private pipeline. Completeness follows
  // the recorded provider tool contract below, never the observed row count.
  return {source: 'IB_MCP', startedAt, completedAt: new Date(now()).toISOString(),
          sources, toolCalls: 2, refreshCalls: 0, financialMutations: 0};
}

// Official ibkr-cpapi-mcp 1.2.2 tool definitions captured 2026-10-17:
// get_account_positions: all open positions; get_account_balances: one entry
// per currency. Both take {} and return one array, without paging parameters
// or required complete/total_count/cash_basis/as_of fields. This is the MCP
// contract, not the separate paginated Client Portal positions REST endpoint.
// Source: private-action-20261017/ib-tool-contract.safe.json, SHA256 below.
export const IB_SNAPSHOT_CONTRACT_SHA256='475bef6cf463c7b11cb94a48c9a5aca66f8aa972d8221f0000c480a84444f22d';
// cash_balance is the currency's cash, distinct from settled_cash. Normalize
// cash to the existing trade-date basis (IBKR Account Balances: cash includes
// trade-time sales); never substitute settled cash/buying power or add BASE.
// https://www.ibkrguides.com/traderworkstation/account-balances.htm
const numberText=v=>typeof v==='string'&&/^[+-]?\d+(?:\.\d+)?$/.test(v)
  ||typeof v==='number'&&Number.isFinite(v)&&(!Number.isInteger(v)||Number.isSafeInteger(v));
const currency=v=>typeof v==='string'&&/^[A-Z]{3}$/.test(v);
export function assessCapture(capture){
  const result={comparisonReady:false,code:'IB_SYNC_CAPTURE_INCOMPLETE',positionsComplete:false,cashComplete:false,
    positionsFieldsValid:false,cashFieldsValid:false,cashBasisVerified:false,paginationComplete:false,
    providerTimesValid:true,providerAsOfBySource:{positions:null,balances:null},providerAsOf:null,
    completenessBasis:'ibkr-mcp-all-positions-per-currency-balances',contractSha256:IB_SNAPSHOT_CONTRACT_SHA256,
    cashField:'cash_balance',baseAggregateExcluded:true};
  if(capture?.source!=='IB_MCP'||!Array.isArray(capture.sources)||capture.sources.length!==2
    ||capture.sources[0]?.sourceKey!=='ib.positions'||capture.sources[1]?.sourceKey!=='ib.balances')return result;
  let pagePending=false,nodes=0;
  const scan=(value,depth=0)=>{
    if(++nodes>50000||depth>20)throw Error('IB_SYNC_CAPTURE_UNSAFE');
    if(!value||typeof value!=='object')return;
    for(const [key,child] of Object.entries(value)){
      if(/^(access_token|refresh_token|client_secret|authorization|cookie|password|credential|credentials)$/i.test(key))throw Error('IB_SYNC_CAPTURE_UNSAFE');
      if(['next','next_page','nextPage','nextPageToken','next_page_token','next_cursor','nextCursor','has_more','hasMore','truncated','is_truncated'].includes(key)&&child)pagePending=true;
      scan(child,depth+1);
    }
  };
  for(const r of capture.sources)scan(r.raw);
  const p=capture.sources[0].raw,b=capture.sources[1].raw;
  if(!p||!b||!Array.isArray(p.positions)||!Array.isArray(b.balances))return result;
  const full=(body,rows)=>{
    // No invented positive flag is needed. Any supplied error or contradictory
    // coverage/paging metadata still overrides the known all-rows contract.
    if(Object.hasOwn(body,'error')||Object.hasOwn(body,'isError')&&body.isError!==false)return false;
    if(Object.hasOwn(body,'complete')&&body.complete!==true)return false;
    if(Object.hasOwn(body,'total_count')&&(!Number.isSafeInteger(body.total_count)||body.total_count!==rows.length))return false;
    return true;
  };
  result.paginationComplete=!pagePending;
  result.positionsComplete=!pagePending&&full(p,p.positions);
  result.cashComplete=!pagePending&&full(b,b.balances);
  const contracts=new Set(),currencies=new Set();
  result.positionsFieldsValid=p.positions.every(row=>{
    if(!row||!['string','number'].includes(typeof row.contract_id)||!/^[1-9]\d{0,17}$/.test(String(row.contract_id))
      ||typeof row.contract_id==='number'&&!Number.isSafeInteger(row.contract_id)||String(row.contract_id)==='0'
      ||!currency(row.currency)||!numberText(row.position)||contracts.has(String(row.contract_id)))return false;
    contracts.add(String(row.contract_id));return true;
  });
  result.cashFieldsValid=b.balances.every(row=>{
    if(!row||!(currency(row.currency)||row.currency==='BASE')||currencies.has(row.currency))return false;
    currencies.add(row.currency);return row.currency==='BASE'||numberText(row.cash_balance);
  })&&[...currencies].some(c=>c!=='BASE');
  // Basis comes from the documented cash_balance field, not a provider field
  // that its schema never promised. Reject a future contradictory assertion.
  result.cashBasisVerified=result.cashFieldsValid&&(!Object.hasOwn(b,'cash_basis')||b.cash_basis==='total_trade_date');
  for(const [index,key] of [[0,'positions'],[1,'balances']]){
    const value=capture.sources[index].raw.as_of;
    if(value===undefined||value===null)continue; // Missing source time remains explicit.
    const fields=typeof value==='string'&&value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
    if(!fields||!Number.isFinite(Date.parse(value))||+fields[2]<1||+fields[2]>12||+fields[3]<1
      ||+fields[3]>new Date(Date.UTC(+fields[1],+fields[2],0)).getUTCDate()
      ||+fields[4]>23||+fields[5]>59||+fields[6]>59){
      result.providerTimesValid=false;continue;
    }
    result.providerAsOfBySource[key]=new Date(value).toISOString();
  }
  const times=Object.values(result.providerAsOfBySource);
  if(result.providerTimesValid&&times[0]!==null&&times[0]===times[1])result.providerAsOf=times[0];
  result.comparisonReady=result.positionsComplete&&result.cashComplete&&result.positionsFieldsValid
    &&result.cashFieldsValid&&result.cashBasisVerified&&result.providerTimesValid;
  if(result.comparisonReady)result.code='IB_SYNC_SNAPSHOT_CAPTURED';
  return result;
}
