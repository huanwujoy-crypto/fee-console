// Adapt only an original, same-reader validated capture. No source fetch,
// credential discovery, synchronization assertion, writer or run authorization.
import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {SharesightCloudReader,CLOUD_ACCOUNTS} from './fee-cloud-source.mjs';
import {SharesightIbManagerReader} from './ib-manager-source.mjs';
import {sourceContractInputHash} from './fee-source-contract.mjs';
import {projectSharesightSyncAccount} from './fee-sync-source-projection.mjs';
import {lexicalBatchesEquivalent,lexicalBodiesCanonical} from './fee-source-lexical.mjs';

const PREFIX='FEE_SYNC_CAPTURE_',failures=new WeakMap();
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
const bytesHash=v=>createHash('sha256').update(v,'utf8').digest('hex');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function fail(code){const e=new Error(PREFIX+code);failures.set(e,code);throw Object.freeze(e);}
export const capturedInputFailureCode=e=>PREFIX+(failures.get(e)||'REFUSED');
function exact(v,keys,code='SCHEMA'){if(!object(v)||Object.keys(v).sort().join(',')!==[...keys].sort().join(','))fail(code);}
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function copyScope(scope){try{sourceContractInputHash(scope);return JSON.parse(JSON.stringify(scope));}catch{fail('SCOPE');}}
function day(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v+'T00:00:00Z'))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)fail('DATE');return v;}
function parse(body){try{return JSON.parse(body);}catch{fail('SOURCE');}}
const performanceQuery=d=>({consolidated:'false',end_date:d,grouping:'investment_type',include_limited:'false',include_sales:'false',report_combined:'false',start_date:d});

function recognize(reader,captured,role){
  try{
    if(!reader||types.isProxy(reader)||types.isProxy(captured))fail('ORIGIN');
    const Type=role==='ib-manager'?SharesightIbManagerReader:SharesightCloudReader;
    // Invoke the real class method; an instance property supplied by a caller
    // cannot replace its private capture registry with matched:true.
    if(!Type.prototype.isPrototypeOf(reader)||Reflect.apply(Type.prototype.verifyCapturedRead,reader,[captured])!==true)fail('ORIGIN');
  }catch(e){if(failures.has(e))throw e;fail('ORIGIN');}
}
function indexCapture(batch,attempt){
  exact(batch,['attempt','records','sha256']);
  if(batch.attempt!==attempt||!Array.isArray(batch.records)||batch.records.length<1)fail('BATCH');
  const indexed=new Map();
  for(const r of batch.records){
    exact(r,['method','path','query','body','sha256']);
    if(r.method!=='GET'||typeof r.path!=='string'||!r.path.startsWith('/api/')||/[?#]/.test(r.path)
      ||!object(r.query)||Object.values(r.query).some(x=>typeof x!=='string')||typeof r.body!=='string'||bytesHash(r.body)!==r.sha256)fail('SOURCE');
    const key=r.path+'?'+canonical(r.query);if(indexed.has(key))fail('DUPLICATE');indexed.set(key,r);
  }
  if(digest(batch.records)!==batch.sha256)fail('BATCH');
  return (path,query,required=true)=>{const r=indexed.get(path+'?'+canonical(query));if(!r&&required)fail('MISSING');return r;};
}
function mapping(batch,attempt,scope){
  const get=indexCapture(batch,attempt),listing=parse(get('/api/v2/portfolios.json',{}).body);
  if(!Array.isArray(listing?.portfolios))fail('IDENTITY');
  const matches=listing.portfolios.filter(p=>p.name===scope.name&&(scope.role==='ib-manager'||p.id===scope.portfolioId));
  if(matches.length!==1||matches[0].id!==scope.portfolioId||matches[0].currency_code!=='USD')fail('IDENTITY');
  const base='/api/v3/portfolios/'+scope.portfolioId;
  const performance=get(base+'/performance',performanceQuery(scope.targetDate)).body;
  const cashAccounts=get('/api/v2/portfolios/'+scope.portfolioId+'/cash_accounts.json',{date:scope.targetDate}).body;
  const trades=get(base+'/trades.json',{consolidated:'false',end_date:scope.targetDate,start_date:scope.fromDate}).body;
  const cash=parse(cashAccounts)?.cash_accounts;if(!Array.isArray(cash))fail('SOURCE');
  const cashTransactions={},payouts={},cashIds=new Set(),payoutIds=new Set();
  for(const c of cash){
    if(!Number.isSafeInteger(c.id)||c.id<1||cashIds.has(c.id))fail('IDENTITY');cashIds.add(c.id);
    const body=get('/api/v2/cash_accounts/'+c.id+'/cash_account_transactions.json',{from:scope.fromDate,to:scope.targetDate}).body;
    cashTransactions[c.id]=body;
    const rows=parse(body)?.cash_account_transactions;if(!Array.isArray(rows))fail('SOURCE');
    for(const r of rows)if(r.payout_id!=null){if(!Number.isSafeInteger(r.payout_id)||r.payout_id<1)fail('IDENTITY');payoutIds.add(r.payout_id);}
  }
  // Only native explicit payout links enter this projection. Memo-associated
  // payout evidence, catalog/history and all other original validation inputs
  // remain bound by captureSourceSha256. Never invent a missing payout_id.
  for(const id of [...payoutIds].sort((a,b)=>a-b)){
    const r=get('/api/v2/payouts/'+id+'.json',{},false);if(r)payouts[id]=r.body;
  }
  return {performance,cashAccounts,trades,cashTransactions,...(Object.keys(payouts).length?{payouts}:{})};
}

export function projectCapturedSharesightAccount(request){
  try{
    if(!object(request)||types.isProxy(request))fail('SCHEMA');
    const ds=Object.getOwnPropertyDescriptors(request),keys=Reflect.ownKeys(ds);
    if(keys.length!==3||keys.some(k=>typeof k!=='string'||!['reader','captured','scope'].includes(k)||!Object.hasOwn(ds[k],'value')||!ds[k].enumerable))fail('SCHEMA');
    const {reader,captured,scope}=Object.fromEntries(keys.map(k=>[k,ds[k].value]));
    const s=copyScope(scope);exact(s,['role','portfolioId','name','targetDate','fromDate'],'SCOPE');
    if(!['schwab','webull','ib-manager'].includes(s.role)||!Number.isSafeInteger(s.portfolioId)||s.portfolioId<1)fail('SCOPE');
    const expected=s.role==='ib-manager'?{name:'IB-HK',portfolioId:s.portfolioId}:CLOUD_ACCOUNTS[s.role];
    if(s.name!==expected.name||s.portfolioId!==expected.portfolioId)fail('SCOPE');
    day(s.targetDate);day(s.fromDate);if(s.fromDate>s.targetDate||s.role!=='ib-manager'&&s.fromDate!==s.targetDate)fail('DATE');
    recognize(reader,captured,s.role);
    exact(captured,['input','evidence']);const e=captured.evidence;
    exact(e,['schema','provider','targetDate','captures','sourceSha256']);
    if(e.schema!=='fee-console.sharesight-capture.v1'||e.provider!=='Sharesight'||e.targetDate!==s.targetDate
      ||!Array.isArray(e.captures)||e.captures.length!==2)fail('BATCH');
    const raw=mapping(e.captures[0],1,s),other=mapping(e.captures[1],2,s);
    // Re-derived here from the evidence itself, never from the reader's verdict:
    // identical bytes, or the shared strict lexical rule over both whole batches
    // and over both selected projections. The original first round's bodies and
    // byte hash remain the projected input and captureSourceSha256.
    if(e.sourceSha256!==e.captures[0].sha256||!lexicalBatchesEquivalent(e.captures[0],e.captures[1])
      ||canonical(raw)!==canonical(other)&&lexicalBodiesCanonical(raw)!==lexicalBodiesCanonical(other))fail('BATCH');
    if(s.role==='ib-manager'){
      if(captured.input?.scope!=='ib-manager'||captured.input.sourceAsOf!==s.targetDate
        ||captured.input.portfolioIdentityHash!==digest({name:s.name,id:s.portfolioId,currency:'USD'}))fail('IDENTITY');
    }else if(captured.input?.targetDate!==s.targetDate||captured.input.sourceDates?.[s.role]!==s.targetDate)fail('DATE');
    const projection=projectSharesightSyncAccount({scope:s,raw});
    return freeze({scope:s,raw,projection,captureSourceSha256:e.sourceSha256,validatedInputSha256:sourceContractInputHash(captured.input)});
  }catch(e){if(failures.has(e))throw e;fail('REFUSED');}
}
