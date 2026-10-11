import crypto from 'node:crypto';
// Same four-card action report, with explicit unknown dependencies. No I/O.
import {calculateCashPlan} from './xuan-ib-cash-plan.mjs';
import {ordersOf,projectOpenBuys} from './xuan-ib-night-action-model.mjs';
import {parseSharesightCash,parseSharesightStockAllocation,STOCK_CLASS_TARGETS} from './xuan-ib-sharesight-allocation.mjs';
const fail=code=>{throw new Error('EOD_MODEL_'+code);};
const finite=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1e12;
const cents=n=>Math.round(n*100)/100;
const exact=(o,keys)=>{if(!o||Object.getPrototypeOf(o)!==Object.prototype||Object.keys(o).sort().join('|')!==keys.sort().join('|'))fail('PUBLIC_KEYS');};
const hash=o=>crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
const snapshotUsable=status=>status==='verified'||status==='date-verified'||status==='ui-export-observed';
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const instant=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const validHktRange=(label,d)=>{const t=label.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?:–(\d{2}:\d{2}))? HKT/);if(!t||t[1]!==d)return false;const start=Date.parse(d+'T'+t[2]+':00+08:00'),end=Date.parse(d+'T'+(t[3]||t[2])+':00+08:00');return Number.isFinite(start)&&Number.isFinite(end)&&start<=end&&[t[2],t[3]||t[2]].every(v=>Number(v.slice(0,2))<24&&Number(v.slice(3))<60);};
const hktLabel=(start,end)=>{const a=new Date(Date.parse(start)+28800000).toISOString(),b=new Date(Date.parse(end)+28800000).toISOString();return a.slice(0,10)+' '+a.slice(11,16)+(a.slice(11,16)===b.slice(11,16)?'':'–'+b.slice(11,16))+' HKT';};
const fixedNotes=d=>[`EOD 数据至 ${d}；挂单仅在本轮独立核实后显示。`,'待 CALL 原额按 50% 预留；买单预占＝剩余数量×限价；卖单不计预计回款。','EXUS／EIMI／USSC 沿用原规则；类现金不默认卖出；仅作规划，不下单。'];
const unknown=reason=>({status:'unknown',reason});
const planInput=(a,asOfHkt)=>({schemaVersion:2,status:'snapshot',sourceAsOfHkt:asOfHkt.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?:–\d{2}:\d{2})? HKT/)?.[0],equityTotal:a.total,developed:a.developed,emerging:a.emerging,usBase:a.usBase,ussc:a.ussc,ibCash:0,noahCash:0,reserve:0,usscBudgetShare:.10,currency:'USD',denominator:'equity-only'});
export function buildEodActionModel(input){
  if(input.live?.status!=='captured')return buildValidatedEodActionModel(input);
  // Validate the identical core facts independently before trying any optional
  // contribution. A core failure must escape; only a capture-induced failure
  // may degrade. Reuse the complete final guard for every derived constraint
  // (reserve, projection, category totals/percentages, capacity and cash plan).
  const baselineOutcomes=structuredClone(input.sourceOutcomes);
  baselineOutcomes.find(s=>s.sourceKey==='ib.optionalLive').status='not-called';
  const baseline=buildValidatedEodActionModel({...input,live:null,sourceOutcomes:baselineOutcomes});
  try{return buildValidatedEodActionModel(input);}
  catch{
    baseline.orders.reason='ORDERS_MALFORMED_OR_UNMATCHED';
    baseline.sourceOutcomes.find(s=>s.sourceKey==='ib.optionalLive').status='malformed';
    baseline.evidenceSha256=hash({sourceOutcomes:baseline.sourceOutcomes,sourceManifestSha256:baseline.sourceManifestSha256});
    return validateEodActionModel(baseline);
  }
}
function buildValidatedEodActionModel({dataDate,sourceDate,asOfHkt,flex,snapshots,live=null,reserve,evidenceSha256,sourceOutcomes}){
  if(!finite(reserve)||flex?.provenance?.sourceDate!==sourceDate||!Array.isArray(snapshots))fail('INPUT');
  const get=key=>snapshots.find(s=>s.sourceKey===key&&snapshotUsable(s.status));
  let a=null,n=null;
  const outcomes=structuredClone(sourceOutcomes);
  try {const s=get('sharesight.ibGroupedPerformance');if(s)a=parseSharesightStockAllocation(s.raw);}catch{outcomes.find(s=>s.sourceKey==='sharesight.ibGroupedPerformance').status='malformed';}
  try {const s=get('sharesight.noahPerformance');if(s){
    if(s.status==='ui-export-observed'){exact(s.uiCash,['currency','dataDate','total']);if(s.uiCash.currency!=='USD'||!finite(s.uiCash.total))fail('UI_CASH');n=s.uiCash;}
    else n=parseSharesightCash(s.raw,{portfolioId:936238});
  }}catch{outcomes.find(s=>s.sourceKey==='sharesight.noahPerformance').status='malformed';}
  if(a&&a.dataDate!==sourceDate||n&&n.dataDate!==sourceDate)fail('SOURCE_DATE');
  let orders={status:'unknown',asOfHkt:'未取得',buys:null,sells:null,reason:live?.status==='timeout'?'OPTIONAL_LIVE_TIMEOUT':live?.status==='failed'?'OPTIONAL_LIVE_FAILED':'ORDERS_NOT_CAPTURED'},projection=null;
  if(live?.status==='captured'){
    try {
      const keys=['ib.accountSummary','ib.positions','ib.orders'];
      if(live.sources?.length!==3||keys.some(key=>live.sources.filter(s=>s.sourceKey===key).length!==1)||live.sources.some(s=>!instant(s.startedAt)||!instant(s.completedAt)||Date.parse(s.completedAt)<Date.parse(s.startedAt)||Date.parse(s.completedAt)>Date.parse(flex.provenance.readAt)||Date.parse(flex.provenance.readAt)-Date.parse(s.startedAt)>300_000))fail('LIVE_SOURCES');
      const raw=key=>live.sources.find(s=>s.sourceKey===key).raw;
      const groups=ordersOf(raw('ib.orders'),raw('ib.positions'),{dataDate,previousHtml:live.previousHtml??''});
      const capturedStartedAt=live.sources.map(s=>s.startedAt).sort()[0],capturedCompletedAt=live.sources.map(s=>s.completedAt).sort().at(-1);
      const candidateOrders={status:'ready',asOfHkt:hktLabel(capturedStartedAt,capturedCompletedAt),capturedStartedAt,capturedCompletedAt,...groups};
      validateEodOrders(candidateOrders,{dataDate,readAt:flex.provenance.readAt});
      const candidateProjection=a?projectOpenBuys(a,groups.buys):null;
      orders=candidateOrders;projection=candidateProjection;
    }catch{orders={status:'unknown',asOfHkt:'未取得',buys:null,sells:null,reason:'ORDERS_MALFORMED_OR_UNMATCHED'};projection=null;outcomes.find(s=>s.sourceKey==='ib.optionalLive').status='malformed';}
  }
  const ib=flex.cash?cents(flex.cash.tradeDate):null,noah=n?cents(n.total):null;
  const pool=ib!==null&&noah!==null?cents(ib+noah):null,callApplied=cents(reserve*.5);
  const orderReserve=projection?.reserved??null;
  const qualifiedEod=flex.reconciliation.status==='verified'&&flex.reconciliation.cashResidual===0&&!flex.reconciliation.cancellationPending&&flex.tradeCoverageProven===true&&!snapshots.some(s=>s.status==='ui-export-observed');
  const planning=qualifiedEod&&pool!==null&&orderReserve!==null?Math.max(0,cents(pool-callApplied-orderReserve)):null;
  let replenishment={status:'unavailable',reason:planning===null?'CASH_OR_ORDERS_UNKNOWN':'POLICY_EDGE',executableBudget:null};
  let fundingNeed=null;
  if(a){try{const baseline=calculateCashPlan(planInput(a,asOfHkt));fundingNeed={status:'verified',scope:'current-buy-only-developed-emerging',fullNeed:baseline.fullNeed,full:baseline.full,staticGaps:baseline.staticGaps};}catch{fundingNeed=unknown('POLICY_EDGE');}}
  if(projection&&planning!==null){try{
    const p=calculateCashPlan({...planInput({...a,...projection},asOfHkt),ibCash:ib,noahCash:noah,reserve:callApplied+orderReserve});
    replenishment={status:'ready',budget:p.budget,total:p.plannedSpend,retained:p.budgetUnused,
      items:['EXUS','EIMI','USSC'].map((symbol,i)=>({symbol,amount:p.allocations[i]})),executableBudget:null};
  }catch{}}
  // Activity Flex has no AvailableFunds or outstanding-orderbook capability.
  // No EOD balance is relabeled as broker buying power or an executable budget.
  const categories=a?.categories.map(c=>({...c,projectedMarketValue:projection?.categories.find(p=>p.label===c.label).projectedMarketValue??null,projectedPct:projection?.categories.find(p=>p.label===c.label).projectedPct??null}))??null;
  const sourceManifestSha256='0'.repeat(64);
  const model={schemaVersion:9,mode:'eod-action',dataDate,sourceDate,asOfHkt,status:'partial',sourceManifestSha256,evidenceSha256:hash({sourceOutcomes:outcomes,sourceManifestSha256}),
    sourceOutcomes:outcomes,provenance:{flex: flex.provenance && {sourceDate,coveredFrom:flex.provenance.coveredFrom,coveredThrough:flex.provenance.coveredThrough,
      providerGeneratedText:flex.provenance.providerGeneratedText,providerTimezone:flex.provenance.providerTimezone,readAt:flex.provenance.readAt,archiveSha256:flex.rawFingerprint},
      sharesight:snapshots.filter(s=>snapshotUsable(outcomes.find(o=>o.sourceKey===s.sourceKey)?.status)).map(s=>({sourceKey:s.sourceKey,sourceDate:s.provenance.sourceDate,readAt:s.provenance.readAt,syncCompletedAt:s.provenance.syncCompletedAt,snapshotGeneration:s.provenance.snapshotGeneration,receiptSha256:s.provenance.receiptSha256,...(s.status==='ui-export-observed'?{uiReportStart:s.provenance.uiReportStart,uiExportedAt:s.provenance.uiExportedAt}:{})}))},
    replenishment,orders,
    cash:{status:flex.cash||n?'partial':'unavailable',ib,noah,pool,reserve:cents(reserve),callApplied,orderReserve,planning,
      cashLike:a?.cashLike??null,totalCapacity:planning!==null&&a?cents(planning+a.cashLike.total):null,
      planningBasis:planning!==null?{status:'conditional',assumption:'NO_UNREFLECTED_ACTIVITY_SINCE_EOD',sourceDate}:{status:'unknown',reason:qualifiedEod?'CASH_OR_ORDERS_UNKNOWN':'EOD_RECONCILIATION_UNRESOLVED'},availableFunds:unknown('ACTIVITY_FLEX_HAS_NO_AVAILABLE_FUNDS'),executableBudget:null,
      eod:flex.cash?{status:'verified',currency:'USD',tradeDate:flex.cash.tradeDate,settled:flex.cash.settled,native:flex.cash.native.map(r=>({currency:r.currency,level:r.level,endingCash:r.endingCash,endingSettledCash:r.endingSettledCash,components:Object.fromEntries(Object.entries(r.components).filter(([k])=>['commissions','fxTranslationGainLoss','netTradesPurchases','netTradesSales'].includes(k)))}))}:unknown(flex.cashUnavailableReason??'FLEX_CASH_MISSING')},
    allocation:a?{status:'ready',total:a.total,projectedTotal:projection?.total??null,categories,fundingNeed}: {status:'unavailable',total:null,projectedTotal:null,categories:null,fundingNeed:null},
    reconciliation:{status:flex.reconciliation.status,cashResidual:flex.reconciliation.cashResidual,cancellationPending:flex.reconciliation.cancellationPending,verificationSha256:flex.reconciliation.verificationSha256??null},
    notes:fixedNotes(sourceDate)};
  return validateEodActionModel(model);
}
export function validateEodActionModel(m){
  if(m?.schemaVersion!==9||m.mode!=='eod-action'||m.status!=='partial'||!date(m.dataDate)||!date(m.sourceDate)||m.sourceDate>=m.dataDate||typeof m.asOfHkt!=='string'||!new RegExp('^'+m.dataDate+' \\d{2}:\\d{2}(?:–\\d{2}:\\d{2})? HKT · 数据至 '+m.sourceDate+'$').test(m.asOfHkt)||!/^[a-f0-9]{64}$/.test(m.evidenceSha256||''))fail('HEADER');
  if(!validHktRange(m.asOfHkt,m.dataDate))fail('REPORT_TIME');
  if(!/^[a-f0-9]{64}$/.test(m.sourceManifestSha256||'')||m.evidenceSha256!==hash({sourceOutcomes:m.sourceOutcomes,sourceManifestSha256:m.sourceManifestSha256}))fail('EVIDENCE_HASH');
  if(!Array.isArray(m.sourceOutcomes)||m.sourceOutcomes.length!==4||new Set(m.sourceOutcomes.map(s=>s.sourceKey)).size!==4||m.sourceOutcomes.some(s=>!['ib.flexEod','sharesight.ibGroupedPerformance','sharesight.noahPerformance','ib.optionalLive'].includes(s.sourceKey)||!['verified','date-verified','ui-export-observed','captured','not-called','request-failure','missing-fields','date-mismatch','malformed','unverified','failed','timeout'].includes(s.status)||s.status==='date-verified'&&!s.sourceKey.startsWith('sharesight.')||s.status==='ui-export-observed'&&s.sourceKey!=='sharesight.noahPerformance'||s.rawFingerprint!==null&&!/^[a-f0-9]{64}$/.test(s.rawFingerprint||'')))fail('OUTCOMES');
  m.sourceOutcomes.forEach(s=>exact(s,['sourceKey','status','rawFingerprint']));
  const outcome=k=>m.sourceOutcomes.find(s=>s.sourceKey===k);
  if(m.sourceOutcomes.some(s=>s.status==='ui-export-observed')&&m.cash?.planning!==null)fail('UI_PRIVATE_BUDGET');
  if(outcome('ib.flexEod').status!=='verified')fail('FLEX_OUTCOME');
  const o=m.orders;validateEodOrders(o,{dataDate:m.dataDate,readAt:m.provenance.flex.readAt});
  if((o.status==='ready')!==(outcome('ib.optionalLive').status==='captured'))fail('ORDER_OUTCOME');
  const c=m.cash;if(!c||!['partial','unavailable'].includes(c.status)||!finite(c.reserve)||!finite(c.callApplied)||Math.abs(cents(c.reserve*.5)-c.callApplied)>.001||c.executableBudget!==null||c.availableFunds?.status!=='unknown')fail('CASH');
  if(c.noah!==null&&!snapshotUsable(outcome('sharesight.noahPerformance').status))fail('CASH_OUTCOME');
  exact(c,['status','ib','noah','pool','reserve','callApplied','orderReserve','planning','cashLike','totalCapacity','planningBasis','availableFunds','executableBudget','eod']);exact(c.availableFunds,['status','reason']);if(c.availableFunds.reason!=='ACTIVITY_FLEX_HAS_NO_AVAILABLE_FUNDS')fail('CASH_REASON');
  if(c.planningBasis?.status==='conditional'){exact(c.planningBasis,['status','assumption','sourceDate']);if(c.planningBasis.assumption!=='NO_UNREFLECTED_ACTIVITY_SINCE_EOD'||c.planningBasis.sourceDate!==m.sourceDate||m.reconciliation.status!=='verified'||m.reconciliation.cashResidual!==0||m.reconciliation.cancellationPending)fail('PLANNING_BASIS');}else{exact(c.planningBasis,['status','reason']);if(c.planningBasis.status!=='unknown'||!['CASH_OR_ORDERS_UNKNOWN','EOD_RECONCILIATION_UNRESOLVED'].includes(c.planningBasis.reason)||c.planning!==null)fail('PLANNING_BASIS');}
  for(const k of ['ib','noah','pool','orderReserve','planning','totalCapacity'])if(c[k]!==null&&!finite(c[k]))fail('CASH_NUMBER');
  if(c.pool!==(c.ib===null||c.noah===null?null:cents(c.ib+c.noah)))fail('POOL');
  if(o.status==='unknown'&&(c.orderReserve!==null||c.planning!==null||c.totalCapacity!==null||m.allocation.projectedTotal!==null))fail('UNKNOWN_DEPENDENCIES');
  if(o.status==='ready'&&c.orderReserve!==null&&Math.abs(o.buys.reduce((s,r)=>s+cents(Number(r.quantity)*Number(r.limit)),0)-c.orderReserve)>.011)fail('ORDER_RESERVE');
  if(c.planning!==(c.planningBasis.status!=='conditional'||c.pool===null||c.orderReserve===null?null:Math.max(0,cents(c.pool-c.callApplied-c.orderReserve))))fail('PLANNING');
  if(c.cashLike!==null&&(!finite(c.cashLike.total)||!Array.isArray(c.cashLike.items)||c.cashLike.items.length>3||new Set(c.cashLike.items.map(i=>i.symbol)).size!==c.cashLike.items.length||c.cashLike.items.some(i=>!['VGSH','VGIT','TLT'].includes(i.symbol)||!finite(i.amount))||Math.abs(c.cashLike.items.reduce((s,i)=>s+i.amount,0)-c.cashLike.total)>.011))fail('CASH_LIKE');
  if(c.cashLike){exact(c.cashLike,['total','items']);c.cashLike.items.forEach(r=>exact(r,['symbol','amount']));}
  if(c.totalCapacity!==(c.planning===null||c.cashLike===null?null:cents(c.planning+c.cashLike.total)))fail('CAPACITY');
  if(c.eod?.status==='verified'){if(c.eod.currency!=='USD'||!finite(c.eod.tradeDate)||!finite(c.eod.settled)||c.ib!==cents(c.eod.tradeDate)||!Array.isArray(c.eod.native)||c.eod.native.length>100||c.eod.native.some(r=>! /^[A-Z]{3}$/.test(r.currency)||!finite(r.endingCash)||!finite(r.endingSettledCash)))fail('EOD_CASH');}else if(c.eod?.status!=='unknown'||c.ib!==null)fail('EOD_CASH');
  if(c.eod.status==='verified'){exact(c.eod,['status','currency','tradeDate','settled','native']);for(const r of c.eod.native){exact(r,['currency','level','endingCash','endingSettledCash','components']);if(r.level!=='Currency'||!r.components||Object.keys(r.components).some(k=>!['commissions','fxTranslationGainLoss','netTradesPurchases','netTradesSales'].includes(k))||Object.values(r.components).some(n=>typeof n!=='number'||!Number.isFinite(n)))fail('CASH_COMPONENTS');}}else{exact(c.eod,['status','reason']);if(!['FLEX_CASH_MISSING','FLEX_BASE_CURRENCY_UNVERIFIED'].includes(c.eod.reason))fail('CASH_REASON');}
  const a=m.allocation;if(!a||!['ready','unavailable'].includes(a.status))fail('ALLOCATION');
  exact(a,['status','total','projectedTotal','categories','fundingNeed']);
  if(a.status==='unavailable'&&(a.total!==null||a.categories!==null||a.projectedTotal!==null||a.fundingNeed!==null))fail('ALLOCATION_UNKNOWN');
  if(a.status==='ready'){
    if(!snapshotUsable(outcome('sharesight.ibGroupedPerformance').status))fail('ALLOCATION_OUTCOME');
    if(!finite(a.total)||a.total<=0||!Array.isArray(a.categories)||a.categories.length!==4)fail('ALLOCATION');
    for(const [i,[label,target]] of [...STOCK_CLASS_TARGETS].entries()){const r=a.categories[i];exact(r,['label','marketValue','currentPct','targetPct','projectedMarketValue','projectedPct']);if(r.label!==label||r.targetPct!==target||!finite(r.marketValue)||!finite(r.currentPct)||Math.abs(r.marketValue/a.total*100-r.currentPct)>1e-8||!(r.projectedMarketValue===null||finite(r.projectedMarketValue)&&r.projectedMarketValue>=r.marketValue)||!(r.projectedPct===null||finite(r.projectedPct)&&r.projectedPct<=100))fail('CATEGORY');if(a.projectedTotal===null&&(r.projectedMarketValue!==null||r.projectedPct!==null))fail('PROJECTION_UNKNOWN');if(a.projectedTotal!==null&&(r.projectedMarketValue===null||Math.abs(r.projectedMarketValue/a.projectedTotal*100-r.projectedPct)>1e-8))fail('PROJECTION');}
    if(Math.abs(a.categories.reduce((s,r)=>s+r.marketValue,0)-a.total)>.011||a.projectedTotal!==null&&(!finite(a.projectedTotal)||Math.abs(a.categories.reduce((s,r)=>s+r.projectedMarketValue,0)-a.projectedTotal)>.011))fail('DENOMINATOR');
    if(a.fundingNeed?.status==='verified'&&(!finite(a.fundingNeed.fullNeed)||!Array.isArray(a.fundingNeed.full)||a.fundingNeed.full.length!==2||a.fundingNeed.full.some(n=>!finite(n))||Math.abs(a.fundingNeed.full.reduce((s,n)=>s+n,0)-a.fundingNeed.fullNeed)>.011))fail('FUNDING_NEED');
  }
  if(a.fundingNeed?.status==='verified'){const de=a.categories.slice(2);const baseline=calculateCashPlan({schemaVersion:1,status:'snapshot',sourceAsOfHkt:m.asOfHkt.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?:–\d{2}:\d{2})? HKT/)?.[0],equityTotal:a.total,developed:de[0].marketValue,emerging:de[1].marketValue,ibCash:0,noahCash:0,reserve:0,currency:'USD',denominator:'equity-only'});if(a.fundingNeed.scope!=='current-buy-only-developed-emerging'||Math.abs(baseline.fullNeed-a.fundingNeed.fullNeed)>.011||!Array.isArray(a.fundingNeed.staticGaps)||a.fundingNeed.staticGaps.length!==2||baseline.staticGaps.some((n,i)=>Math.abs(n-a.fundingNeed.staticGaps[i])>.011)||baseline.full.some((n,i)=>Math.abs(n-a.fundingNeed.full[i])>.011))fail('FUNDING_CALCULATION');}
  if(a.fundingNeed){if(a.fundingNeed.status==='verified')exact(a.fundingNeed,['status','scope','fullNeed','full','staticGaps']);else{exact(a.fundingNeed,['status','reason']);if(a.fundingNeed.status!=='unknown'||a.fundingNeed.reason!=='POLICY_EDGE')fail('FUNDING_REASON');}}
  const p=m.replenishment;if(!p||!['ready','unavailable'].includes(p.status)||p.executableBudget!==null)fail('PLAN');
  if(p.status==='ready'&&(!finite(p.budget)||p.budget!==c.planning||!finite(p.total)||!finite(p.retained)||Math.abs(p.total+p.retained-p.budget)>.011||!Array.isArray(p.items)||p.items.length!==3||p.items.some((r,i)=>r.symbol!==['EXUS','EIMI','USSC'][i]||!finite(r.amount))||Math.abs(p.items.reduce((s,r)=>s+r.amount,0)-p.total)>.011||o.status!=='ready'||a.status!=='ready'))fail('PLAN');
  if(p.status==='ready'){const u=cents(p.budget*.1);const de=calculateCashPlan({schemaVersion:1,status:'snapshot',sourceAsOfHkt:m.asOfHkt.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?:–\d{2}:\d{2})? HKT/)?.[0],equityTotal:a.projectedTotal+u,developed:a.categories[2].projectedMarketValue,emerging:a.categories[3].projectedMarketValue,ibCash:cents(p.budget-u),noahCash:0,reserve:0,currency:'USD',denominator:'equity-only'});if(Math.abs(p.items[2].amount-u)>.001||de.allocations.some((n,i)=>Math.abs(n-p.items[i].amount)>.001)||Math.abs(p.retained-de.budgetUnused)>.001)fail('PLAN_CALCULATION');}
  if(p.status==='unavailable'&&!['CASH_OR_ORDERS_UNKNOWN','POLICY_EDGE'].includes(p.reason))fail('PLAN_REASON');
  exact(p,p.status==='ready'?['status','budget','total','retained','items','executableBudget']:['status','reason','executableBudget']);if(p.status==='ready')p.items.forEach(r=>exact(r,['symbol','amount']));
  if(JSON.stringify(m.notes)!==JSON.stringify(fixedNotes(m.sourceDate)))fail('NOTES');
  if(!m.provenance?.flex||m.provenance.flex.sourceDate!==m.sourceDate||m.provenance.flex.coveredThrough!==m.sourceDate||!/^[a-f0-9]{64}$/.test(m.provenance.flex.archiveSha256||'')||!instant(m.provenance.flex.readAt)||!Array.isArray(m.provenance.sharesight)||m.provenance.sharesight.some(s=>s.sourceDate!==m.sourceDate||!instant(s.readAt)))fail('PROVENANCE');
  if(m.provenance.flex.archiveSha256!==outcome('ib.flexEod').rawFingerprint||m.provenance.sharesight.length!==m.sourceOutcomes.filter(s=>s.sourceKey.startsWith('sharesight.')&&snapshotUsable(s.status)).length||new Set(m.provenance.sharesight.map(s=>s.sourceKey)).size!==m.provenance.sharesight.length||m.provenance.sharesight.some(s=>!s.sourceKey.startsWith('sharesight.')||!snapshotUsable(outcome(s.sourceKey)?.status)||!/^[a-f0-9]{64}$/.test(outcome(s.sourceKey)?.rawFingerprint||'')))fail('PROVENANCE_BINDING');
  for(const s of m.provenance.sharesight){
    if(['date-verified','ui-export-observed'].includes(outcome(s.sourceKey).status)){
      if(s.syncCompletedAt!==null||s.snapshotGeneration!==null||s.receiptSha256!==null)fail('SYNC_COMPLETION_CLAIM');
    }else if(!instant(s.syncCompletedAt)||Date.parse(s.syncCompletedAt)>Date.parse(s.readAt)||!/^[a-f0-9]{64}$/.test(s.receiptSha256||'')||!/^\d+$/.test(s.snapshotGeneration||''))fail('PROVENANCE');
    if(outcome(s.sourceKey).status==='ui-export-observed'&&(!date(s.uiReportStart)||s.uiReportStart>m.sourceDate||!instant(s.uiExportedAt)||Date.parse(s.uiExportedAt)>Date.parse(s.readAt)))fail('UI_PROVENANCE');
  }
  exact(m.provenance,['flex','sharesight']);exact(m.provenance.flex,['sourceDate','coveredFrom','coveredThrough','providerGeneratedText','providerTimezone','readAt','archiveSha256']);m.provenance.sharesight.forEach(s=>exact(s,['sourceKey','sourceDate','readAt','syncCompletedAt','snapshotGeneration','receiptSha256',...(outcome(s.sourceKey).status==='ui-export-observed'?['uiReportStart','uiExportedAt']:[])]));
  const f=m.provenance.flex;if(!date(f.coveredFrom)||f.coveredFrom>m.sourceDate||!(/^(?:\d{8};\d{6}|\d{4}-\d{2}-\d{2};\d{2}:\d{2}:\d{2})$/.test(f.providerGeneratedText))||f.providerTimezone!==null&&typeof f.providerTimezone!=='string')fail('PROVENANCE');
  if(f.providerTimezone!==null){try{new Intl.DateTimeFormat('en',{timeZone:f.providerTimezone});}catch{fail('PROVIDER_TIMEZONE');}}
  exact(m.reconciliation,['status','cashResidual','cancellationPending','verificationSha256']);if(!(m.reconciliation.verificationSha256===null||/^[a-f0-9]{64}$/.test(m.reconciliation.verificationSha256||''))||m.reconciliation.status!=='unknown'&&m.reconciliation.verificationSha256===null)fail('FINANCIAL_PROOF');if(!['verified','pending','unknown'].includes(m.reconciliation.status)||typeof m.reconciliation.cancellationPending!=='boolean'||!(m.reconciliation.cashResidual===null||Number.isFinite(m.reconciliation.cashResidual)&&Math.abs(m.reconciliation.cashResidual)<=1e12))fail('RECONCILIATION');
  if(m.reconciliation.status==='verified'&&(m.reconciliation.cashResidual!==0||m.reconciliation.cancellationPending)||m.reconciliation.status==='unknown'&&m.reconciliation.cashResidual!==null||m.reconciliation.cashResidual===null&&m.reconciliation.status!=='unknown')fail('RECONCILIATION');
  // Public marker allowlist excludes account IDs, raw payloads and archive paths.
  const top=['schemaVersion','mode','dataDate','sourceDate','asOfHkt','status','sourceManifestSha256','evidenceSha256','sourceOutcomes','provenance','replenishment','orders','cash','allocation','reconciliation','notes'];
  if(Object.keys(m).some(k=>!top.includes(k)))fail('PUBLIC_KEYS');
  return m;
}

export function validateEodOrders(orders,{dataDate,readAt}) {
  const o=orders;if(!o||!['ready','unknown'].includes(o.status)||typeof o.asOfHkt!=='string')fail('ORDERS');
  if(o.status==='unknown'&&(o.buys!==null||o.sells!==null))fail('UNKNOWN_ORDERS');
  if(o.status==='ready'&&(!Array.isArray(o.buys)||!Array.isArray(o.sells)||o.buys.length+o.sells.length>60))fail('ORDERS');
  if(o.status==='ready')for(const [side,rows] of [['BUY',o.buys],['SELL',o.sells]])for(const r of rows){if(r.side!==side||typeof r.description!=='string'||! /^[A-Z][A-Z0-9./-]{0,20}$/.test(r.description)||!/^\d+(?:\.\d+)?$/.test(r.quantity)||!/^\d+(?:\.\d+)?$/.test(r.limit)||!['NEW','REPLACED'].includes(r.status)||!(r.currency===null||/^[A-Z]{3}$/.test(r.currency))||!(r.distancePct===null||Number.isFinite(r.distancePct))||!(r.ageDays===null||Number.isInteger(r.ageDays)&&r.ageDays>=0))fail('ORDER');if(r.trend!==null&&(!/^[a-f0-9]{64}$/.test(r.trend?.key||'')||!finite(r.trend.firstPrice)||r.trend.firstPrice<=0||!date(r.trend.firstDate)||r.trend.firstDate>dataDate||!Number.isInteger(r.trend.ageDays)||r.trend.ageDays<0||!['none','up','down','flat'].includes(r.trend.kind)||!(r.trend.label===null||typeof r.trend.label==='string'&&/^约 [→↑↓] \d+(?:\.\d+)?% · 观察\d+天$/.test(r.trend.label))))fail('TREND');if(r.trend&&(r.trend.kind==='none')!==(r.trend.label===null))fail('TREND');}
  exact(o,o.status==='unknown'?['status','asOfHkt','buys','sells','reason']:['status','asOfHkt','capturedStartedAt','capturedCompletedAt','buys','sells']);
  if(o.status==='unknown'&&(o.asOfHkt!=='未取得'||!['ORDERS_NOT_CAPTURED','OPTIONAL_LIVE_FAILED','OPTIONAL_LIVE_TIMEOUT','ORDERS_MALFORMED_OR_UNMATCHED'].includes(o.reason)))fail('ORDER_REASON');
  if(o.status==='ready'&&(!instant(o.capturedStartedAt)||!instant(o.capturedCompletedAt)||Date.parse(o.capturedCompletedAt)<Date.parse(o.capturedStartedAt)||Date.parse(o.capturedCompletedAt)>Date.parse(readAt)||Date.parse(readAt)-Date.parse(o.capturedStartedAt)>300_000||!hktLabel(o.capturedStartedAt,o.capturedCompletedAt).startsWith(dataDate+' ')||o.asOfHkt!==hktLabel(o.capturedStartedAt,o.capturedCompletedAt)))fail('ORDER_TIME');
  if(o.status==='ready')for(const r of [...o.buys,...o.sells]){exact(r,['side','description','limit','quantity','status','currency','ageDays','distancePct','trend']);if(r.trend)exact(r.trend,['key','firstDate','firstPrice','ageDays','kind','label']);}
  return orders;
}
