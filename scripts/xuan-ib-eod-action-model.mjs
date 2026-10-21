import {SHARESIGHT_BROWSER_SOURCE} from '../cloud/xuan-preopen/eod_sources.mjs';
import crypto from 'node:crypto';
// Same four-card action report, with explicit unknown dependencies. No I/O.
import {calculateCashPlan} from './xuan-ib-cash-plan.mjs';
import {ordersOf,projectOpenBuys} from './xuan-ib-night-action-model.mjs';
import {parseSharesightCash,parseSharesightStockAllocation,STOCK_CLASS_TARGETS} from './xuan-ib-sharesight-allocation.mjs';
import {buildEodHoldings,validateEodHoldings,buildBookConcentration,validateBookConcentration} from './xuan-ib-eod-holdings.mjs';
import {validProviderGeneratedText} from '../cloud/xuan-preopen/eod_sources.mjs';
import {buildActionConcentrationCandidate,validateActionConcentration} from './xuan-ib-action-concentration.mjs';
import {readCurrentActionFields,sharesightBookCash,sharesightOrderCurrencies,fieldState,validateActionFieldState,emptyActionErrors} from './xuan-ib-action-fields.mjs';
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
const fixedNotes=(d,fields=false)=>[fields?`Sharesight 账面现金与配置记录至 ${d}；来源与缺项分别标注，挂单独立读取。`:`EOD 数据至 ${d}；挂单仅在本轮独立核实后显示。`,'待 CALL 原额按 50% 预留；买单预占＝剩余数量×限价；卖单不计预计回款。','EXUS／EIMI／USSC 沿用原规则；类现金不默认卖出；仅作规划，不下单。'];
export const SHARESIGHT_BOOK_BASIS='sharesight-book-user-synchronized.v1';
export function actionUnknownFields(m){
  const book=m.calculationBasis===SHARESIGHT_BOOK_BASIS;
  return [...(m.orders.status==='ready'?[]:['orders']),...(m.holdings?.status==='ready'&&(!book||m.bookConcentration?.status==='ready')?[]:['holdings']),...(m.allocation.status==='ready'&&(!book||m.replenishment.status==='ready')?[]:['allocation']),...(!book||m.cash.planning===null?['cash']:[]),...(!book?['prices']:[])];
}
const bookStatus=m=>m.cash.planning!==null&&m.replenishment.status==='ready'&&m.holdings.status==='ready'&&m.bookConcentration.status==='ready'?'ready':'partial';
const unknown=reason=>({status:'unknown',reason});
const planInput=(a,asOfHkt)=>({schemaVersion:2,status:'snapshot',sourceAsOfHkt:asOfHkt.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?:–\d{2}:\d{2})? HKT/)?.[0],equityTotal:a.total,developed:a.developed,emerging:a.emerging,usBase:a.usBase,ussc:a.ussc,ibCash:0,noahCash:0,reserve:0,usscBudgetShare:.10,currency:'USD',denominator:'equity-only'});
export function buildEodActionModel(input){
  if(input.fieldMode)return buildValidatedEodActionModel(input);
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
function buildValidatedEodActionModel({dataDate,sourceDate,asOfHkt,flex,snapshots,live=null,reserve,evidenceSha256,sourceOutcomes,
  fieldMode=false,callRecord=null,captureStartedAt=null,captureCompletedAt=null,concentrationInput=null,assumeSharesightSynchronized=false}){
  if(typeof assumeSharesightSynchronized!=='boolean'||assumeSharesightSynchronized&&(!fieldMode||concentrationInput!==null))fail('CALCULATION_BASIS');
  if(fieldMode&&!flex)flex={cash:null,positions:null,trades:null,tradeCoverageProven:false,rawFingerprint:null,
    reconciliation:{status:'unknown',cashResidual:null,cancellationPending:false,verificationSha256:null},
    provenance:{sourceDate,coveredFrom:null,coveredThrough:null,providerGeneratedText:null,providerTimezone:null,readAt:null}};
  if(!finite(reserve)||flex?.provenance?.sourceDate!==sourceDate||!Array.isArray(snapshots))fail('INPUT');
  if(snapshots.some(s=>!s||Object.getPrototypeOf(s)!==Object.prototype||!['sharesight.ibGroupedPerformance','sharesight.noahPerformance'].includes(s.sourceKey)))fail('INPUT');
  validateSourceOutcomes(sourceOutcomes,fieldMode);
  const get=key=>snapshots.find(s=>s.sourceKey===key&&snapshotUsable(s.status));
  const fieldErrors=emptyActionErrors();
  let a=null,n=null;
  const outcomes=structuredClone(sourceOutcomes);
  try {const s=get('sharesight.ibGroupedPerformance');if(s){a=parseSharesightStockAllocation(s.raw);if(fieldMode)validateAllocationContribution(allocationContribution(a),asOfHkt);}else fieldErrors.allocation='ALLOCATION_SOURCE_UNAVAILABLE';}
  catch{a=null;fieldErrors.allocation='ALLOCATION_SOURCE_INVALID';outcomes.find(s=>s.sourceKey==='sharesight.ibGroupedPerformance').status='malformed';}
  try {const s=get('sharesight.noahPerformance');if(s){
    if(s.status==='ui-export-observed'){exact(s.uiCash,['currency','dataDate','total']);if(s.uiCash.currency!=='USD'||!finite(s.uiCash.total))fail('UI_CASH');n=s.uiCash;}
    else n=parseSharesightCash(s.raw,{portfolioId:936238});
  }}catch{outcomes.find(s=>s.sourceKey==='sharesight.noahPerformance').status='malformed';}
  if(a&&a.dataDate!==sourceDate){if(!fieldMode)fail('SOURCE_DATE');a=null;fieldErrors.allocation='ALLOCATION_SOURCE_DATE_MISMATCH';outcomes.find(s=>s.sourceKey==='sharesight.ibGroupedPerformance').status='date-mismatch';}
  if(n&&n.dataDate!==sourceDate){if(!fieldMode)fail('SOURCE_DATE');n=null;outcomes.find(s=>s.sourceKey==='sharesight.noahPerformance').status='date-mismatch';}
  if(fieldMode&&a&&!finite(a.total)){a=null;outcomes.find(s=>s.sourceKey==='sharesight.ibGroupedPerformance').status='malformed';}
  let orders={status:'unknown',asOfHkt:'未取得',buys:null,sells:null,reason:live?.status==='timeout'?'OPTIONAL_LIVE_TIMEOUT':live?.status==='failed'?'OPTIONAL_LIVE_FAILED':'ORDERS_NOT_CAPTURED'},projection=null;
  if(!fieldMode&&live?.status==='captured'){
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
  const ibSnapshot=get('sharesight.ibGroupedPerformance'),noahSnapshot=get('sharesight.noahPerformance');
  const bookIb=fieldMode?sharesightBookCash(ibSnapshot,{portfolioId:936247,sourceDate,onFailure:code=>{fieldErrors.ibCash=code;}}):null;
  let currentFields=null;
  if(fieldMode){
    currentFields=readCurrentActionFields({live,dataDate,startedAt:captureStartedAt,completedAt:captureCompletedAt,previousHtml:live?.previousHtml??'',
      currencyBySymbol:sharesightOrderCurrencies(ibSnapshot,{onFailure:code=>{fieldErrors.orderCurrency=code;}})});
    orders=currentFields.orders;
    try{validateEodOrders(orders,{dataDate,readAt:captureCompletedAt,startedAt:captureStartedAt,fieldMode:true});}
    catch{
      orders={status:'unknown',asOfHkt:'未取得',buys:null,sells:null,reason:'ORDERS_MALFORMED_OR_UNMATCHED'};
      currentFields.states['ib.orders']=fieldState('ib.orders','malformed');
      outcomes.find(s=>s.sourceKey==='ib.optionalLive').status='malformed';
    }
    fieldErrors.orders=orders.status==='unknown'?(currentFields.states['ib.orders'].status==='malformed'?'ORDERS_PAYLOAD_INVALID':'ORDERS_SOURCE_UNAVAILABLE'):orders.status==='partial'?'ORDERS_COVERAGE_UNVERIFIED':null;
    if(a&&orders.status==='ready'){
      try{projection=projectOpenBuys(a,orders.buys);validateAllocationContribution(allocationContribution(a,projection),asOfHkt);}
      catch{projection=null;fieldErrors.allocationProjection='PROJECTION_INVALID';}
    }else fieldErrors.allocationProjection='PROJECTION_DEPENDENCIES_UNKNOWN';
  }
  const ib=bookIb!==null?bookIb:flex.cash?cents(flex.cash.tradeDate):null,
    noah=fieldMode?sharesightBookCash(noahSnapshot,{portfolioId:936238,sourceDate,onFailure:code=>{fieldErrors.noahCash=code;}}):n?cents(n.total):null;
  const pool=ib!==null&&noah!==null&&finite(cents(ib+noah))?cents(ib+noah):null;
  if(fieldMode&&ib!==null&&noah!==null&&pool===null)fieldErrors.cashPool='CASH_POOL_OUT_OF_RANGE';
  const callConfirmed=!fieldMode||callRecord?.status==='owner-declared',callAmount=callConfirmed?cents(reserve):null,callApplied=callAmount===null?null:cents(callAmount*.5);
  let orderReserve=fieldMode?(orders.status==='ready'&&orders.buys.every(r=>r.currency==='USD')?cents(orders.buys.reduce((sum,r)=>cents(sum+cents(Number(r.quantity)*Number(r.limit))),0)):null):projection?.reserved??null;
  if(fieldMode&&orderReserve===null)fieldErrors.orderReserve=orders.status!=='ready'?'BUY_RESERVE_DEPENDENCIES_UNKNOWN':'BUY_RESERVE_CURRENCY_UNKNOWN';
  if(!finite(orderReserve)){if(fieldMode&&orderReserve!==null)fieldErrors.orderReserve='BUY_RESERVE_OUT_OF_RANGE';orderReserve=null;}
  const qualifiedEod=flex.reconciliation.status==='verified'&&flex.reconciliation.cashResidual===0&&!flex.reconciliation.cancellationPending&&flex.tradeCoverageProven===true&&!snapshots.some(s=>s.status==='ui-export-observed');
  const planning=(fieldMode?bookIb!==null&&callConfirmed:qualifiedEod)&&pool!==null&&orderReserve!==null?Math.max(0,cents(pool-callApplied-orderReserve)):null;
  let replenishment={status:'unavailable',reason:planning===null?'CASH_OR_ORDERS_UNKNOWN':'POLICY_EDGE',executableBudget:null};
  let fundingNeed=null;
  if(a){try{const baseline=calculateCashPlan(planInput(a,asOfHkt));fundingNeed={status:'verified',scope:'current-buy-only-developed-emerging',fullNeed:baseline.fullNeed,full:baseline.full,staticGaps:baseline.staticGaps};
    if(fieldMode)validateAllocationContribution(allocationContribution(a,null,fundingNeed),asOfHkt);
  }catch{fundingNeed=unknown('POLICY_EDGE');fieldErrors.fundingNeed='FUNDING_NEED_INVALID';}}
  if(projection&&planning!==null){try{
    const p=calculateCashPlan({...planInput({...a,...projection},asOfHkt),ibCash:ib,noahCash:noah,reserve:callApplied+orderReserve});
    replenishment={status:'ready',budget:p.budget,total:p.plannedSpend,retained:p.budgetUnused,
      items:['EXUS','EIMI','USSC'].map((symbol,i)=>({symbol,amount:p.allocations[i]})),executableBudget:null};
    if(fieldMode)validateReplenishmentContribution(replenishment,{c:{planning},o:orders,a:allocationContribution(a,projection,fundingNeed),asOfHkt});
  }catch{replenishment={status:'unavailable',reason:'POLICY_EDGE',executableBudget:null};fieldErrors.replenishment='PLAN_DERIVATION_INVALID';}}
  else if(fieldMode)fieldErrors.replenishment='PLAN_DEPENDENCIES_UNKNOWN';
  // Activity Flex has no AvailableFunds or outstanding-orderbook capability.
  // No EOD balance is relabeled as broker buying power or an executable budget.
  let cashLike=a?.cashLike??null;
  if(fieldMode){try{validateCashLikeContribution(cashLike);}catch{cashLike=null;fieldErrors.cashLike='CASH_LIKE_INVALID';}}
  let totalCapacity=planning!==null&&cashLike!==null?cents(planning+cashLike.total):null;
  if(fieldMode&&totalCapacity!==null&&!finite(totalCapacity)){totalCapacity=null;fieldErrors.capacity='TOTAL_CAPACITY_OUT_OF_RANGE';}
  let holdings;
  try{holdings=buildEodHoldings(get('sharesight.ibGroupedPerformance'),a,sourceDate,Array.isArray(flex.positions));validateEodHoldings(holdings,allocationContribution(a),sourceDate);}
  catch(error){if(!fieldMode)throw error;holdings={status:'unavailable',reason:'DETAIL_UNSUPPORTED'};}
  if(fieldMode&&holdings.status!=='ready')fieldErrors.holdings=holdings.reason==='SOURCE_UNAVAILABLE'?'HOLDINGS_SOURCE_UNAVAILABLE':'HOLDINGS_DETAIL_UNSUPPORTED';
  const sourceManifestSha256='0'.repeat(64);
  const model={schemaVersion:9,mode:'eod-action',dataDate,sourceDate,asOfHkt,status:'partial',sourceManifestSha256,evidenceSha256:hash({sourceOutcomes:outcomes,sourceManifestSha256}),
    sourceOutcomes:outcomes,provenance:{flex: flex.provenance && {sourceDate,coveredFrom:flex.provenance.coveredFrom,coveredThrough:flex.provenance.coveredThrough,
      providerGeneratedText:flex.provenance.providerGeneratedText,providerTimezone:flex.provenance.providerTimezone,readAt:flex.provenance.readAt,archiveSha256:flex.rawFingerprint},
      sharesight:snapshots.filter(s=>snapshotUsable(outcomes.find(o=>o.sourceKey===s.sourceKey)?.status)).map(s=>({sourceKey:s.sourceKey,sourceDate:s.provenance.sourceDate,readAt:s.provenance.readAt,syncCompletedAt:s.provenance.syncCompletedAt,snapshotGeneration:s.provenance.snapshotGeneration,receiptSha256:s.provenance.receiptSha256,...(assumeSharesightSynchronized?{channel:s.raw?.source===SHARESIGHT_BROWSER_SOURCE?'authenticated-browser':'api',classificationReadAt:s.raw?.source===SHARESIGHT_BROWSER_SOURCE?s.raw.classification?.provenance.readAt??null:null}:{}),...(s.status==='ui-export-observed'?{uiReportStart:s.provenance.uiReportStart,uiExportedAt:s.provenance.uiExportedAt}:{})}))},
    replenishment,orders,
    cash:{status:fieldMode&&[ib,noah,pool].every(finite)?'recorded':ib!==null||noah!==null?'partial':'unavailable',ib,noah,pool,reserve:callAmount,callApplied,orderReserve,planning,
      cashLike,totalCapacity,
      planningBasis:planning!==null?{status:fieldMode?'reference':'conditional',assumption:fieldMode?'BOOK_CASH_AND_REMAINING_ORDERS':'NO_UNREFLECTED_ACTIVITY_SINCE_EOD',sourceDate}:{status:'unknown',reason:fieldMode||qualifiedEod?'CASH_OR_ORDERS_UNKNOWN':'EOD_RECONCILIATION_UNRESOLVED'},availableFunds:fieldMode?currentFields.availableFunds:unknown('ACTIVITY_FLEX_HAS_NO_AVAILABLE_FUNDS'),executableBudget:null,
      eod:flex.cash?{status:'verified',currency:'USD',tradeDate:flex.cash.tradeDate,settled:flex.cash.settled,native:flex.cash.native.map(r=>({currency:r.currency,level:r.level,endingCash:r.endingCash,endingSettledCash:r.endingSettledCash,components:Object.fromEntries(Object.entries(r.components).filter(([k])=>['commissions','fxTranslationGainLoss','netTradesPurchases','netTradesSales'].includes(k)))}))}:unknown('FLEX_CASH_MISSING')},
    allocation:allocationContribution(a,projection,fundingNeed),holdings,
    reconciliation:{status:flex.reconciliation.status,cashResidual:flex.reconciliation.cashResidual,cancellationPending:flex.reconciliation.cancellationPending,verificationSha256:flex.reconciliation.verificationSha256??null},
    notes:fixedNotes(sourceDate,fieldMode)};
  if(fieldMode){
    const call=callRecord??{status:'unavailable',declarationDate:null,declarationSha256:null};
    if(call.status!=='owner-declared')fieldErrors.call='OWNER_DECLARATION_UNAVAILABLE';
    model.fieldErrors=fieldErrors;
    const {amountUsd,...callMeta}=call;model.cash.call=callMeta;model.cash.book={ib:bookIb,sourceDate};
    if(model.cash.availableFunds.status==='recorded'){
      // The original optional capture is the immutable hash preimage already
      // bound by sourceOutcomes. Keep it private so the guard can reconstruct
      // the observation, including an absent response account identifier.
      const {previousHtml,...proof}=live;
      model.cash.availableFundsProof=structuredClone(proof);
    }
    model.provenance.capture={startedAt:captureStartedAt,completedAt:captureCompletedAt};
    const snapshotState=(key,known)=>{const s=snapshots.find(s=>s.sourceKey===key),o=outcomes.find(o=>o.sourceKey===key);
      return fieldState(key,known?(o?.status==='verified'?'ready':'recorded'):snapshotUsable(o?.status)?'missing-fields':o?.status??'not-called',known?sourceDate:null,known?s?.provenance?.readAt??null:null);};
    model.fieldState={ibCash:bookIb!==null?snapshotState('sharesight.ibGroupedPerformance',true):flex.cash?fieldState('ib.flexEod','recorded',sourceDate,flex.provenance.readAt):snapshotState('sharesight.ibGroupedPerformance',false),
      noahCash:snapshotState('sharesight.noahPerformance',noah!==null),orders:currentFields.states['ib.orders'],allocation:snapshotState('sharesight.ibGroupedPerformance',!!a),
      call:fieldState('owner.callDeclaration',call.status,call.declarationDate,captureCompletedAt),
      orderReserve:fieldState('derived.buyReserve',orderReserve===null?'blocked':'ready',orderReserve===null?null:dataDate,orderReserve===null?null:orders.capturedCompletedAt),
      planning:fieldState('derived.cashPlan',planning===null?'blocked':'ready',planning===null?null:dataDate,planning===null?null:captureCompletedAt)};
  }
  if(assumeSharesightSynchronized){
    model.calculationBasis=SHARESIGHT_BOOK_BASIS;
    model.cash.preOrderPlanning=pool!==null&&callApplied!==null?Math.max(0,cents(pool-callApplied)):null;
    model.bookConcentration=buildBookConcentration(ibSnapshot,sourceDate);
    model.status=bookStatus(model);
  }
  if(concentrationInput!==null)model.concentration=buildActionConcentrationCandidate({...concentrationInput,cutoff:sourceDate});
  return validateEodActionModel(model);
}
export function validateEodActionModel(m){
  const fields=Boolean(m?.fieldState),book=m?.calculationBasis===SHARESIGHT_BOOK_BASIS;
  if(Object.hasOwn(m??{},'calculationBasis')&&(!book||!fields||Object.hasOwn(m,'concentration')))fail('CALCULATION_BASIS');
  if(m?.schemaVersion!==9||m.mode!=='eod-action'||!(book?['ready','partial'].includes(m.status):m.status==='partial')||!date(m.dataDate)||!date(m.sourceDate)||m.sourceDate>=m.dataDate||typeof m.asOfHkt!=='string'||!new RegExp('^'+m.dataDate+' \\d{2}:\\d{2}(?:–\\d{2}:\\d{2})? HKT · 数据至 '+m.sourceDate+'$').test(m.asOfHkt)||!/^[a-f0-9]{64}$/.test(m.evidenceSha256||''))fail('HEADER');
  if(!validHktRange(m.asOfHkt,m.dataDate))fail('REPORT_TIME');
  if(!/^[a-f0-9]{64}$/.test(m.sourceManifestSha256||'')||m.evidenceSha256!==hash({sourceOutcomes:m.sourceOutcomes,sourceManifestSha256:m.sourceManifestSha256}))fail('EVIDENCE_HASH');
  validateSourceOutcomes(m.sourceOutcomes,fields);
  const outcome=k=>m.sourceOutcomes.find(s=>s.sourceKey===k);
  if(m.sourceOutcomes.some(s=>s.status==='ui-export-observed')&&m.cash?.planning!==null)fail('UI_PRIVATE_BUDGET');
  if(!fields&&outcome('ib.flexEod').status!=='verified')fail('FLEX_OUTCOME');
  const o=m.orders;validateEodOrders(o,{dataDate:m.dataDate,readAt:fields?m.provenance.capture?.completedAt:m.provenance.flex.readAt,startedAt:m.provenance.capture?.startedAt,fieldMode:fields});
  if(!fields&&(o.status==='ready')!==(outcome('ib.optionalLive').status==='captured')||fields&&o.status!=='unknown'&&!['captured','partial'].includes(outcome('ib.optionalLive').status))fail('ORDER_OUTCOME');
  const c=m.cash;if(!c||!['partial','unavailable',...(fields?['recorded']:[])].includes(c.status)||c.status==='recorded'&&![c.ib,c.noah,c.pool].every(finite)||!(fields&&c.reserve===null&&c.callApplied===null)&&(!finite(c.reserve)||!finite(c.callApplied)||Math.abs(cents(c.reserve*.5)-c.callApplied)>.001)||c.executableBudget!==null)fail('CASH');
  if(c.noah!==null&&!snapshotUsable(outcome('sharesight.noahPerformance').status))fail('CASH_OUTCOME');
  exact(c,['status','ib','noah','pool','reserve','callApplied','orderReserve','planning','cashLike','totalCapacity','planningBasis','availableFunds','executableBudget','eod',...(fields?['call','book']:[]),...(c.availableFunds?.status==='recorded'?['availableFundsProof']:[]),...(book?['preOrderPlanning']:[])]);
  if(fields&&c.availableFunds?.status==='recorded'){
    const f=c.availableFunds;exact(f,['status','amount','currency','source','readAt','accountBasis']);
    if(typeof f.amount!=='number'||!Number.isFinite(f.amount)||Math.abs(f.amount)>1e12||! /^[A-Z]{3}$/.test(f.currency)||f.currency==='BASE'
      ||f.source!=='ib.accountSummary'||!['response-account-id','owner-attested'].includes(f.accountBasis)||!instant(f.readAt)
      ||f.readAt<m.provenance.capture?.startedAt||f.readAt>m.provenance.capture?.completedAt||!['captured','partial'].includes(outcome('ib.optionalLive').status))fail('BROKER_FUNDS');
    if(hash(c.availableFundsProof)!==outcome('ib.optionalLive').rawFingerprint)fail('BROKER_FUNDS_SOURCE_BINDING');
    const rebuilt=readCurrentActionFields({live:c.availableFundsProof,dataDate:m.dataDate,startedAt:m.provenance.capture.startedAt,completedAt:m.provenance.capture.completedAt}).availableFunds;
    if(JSON.stringify(rebuilt)!==JSON.stringify(f))fail('BROKER_FUNDS_SOURCE_BINDING');
  }else{exact(c.availableFunds,['status','reason']);if(c.availableFunds.status!=='unknown'||!(fields?['BOOK_BALANCE_NOT_AVAILABLE_FUNDS','BROKER_FUNDS_SOURCE_UNAVAILABLE','BROKER_FUNDS_FIELD_MISSING','BROKER_FUNDS_VALUE_INVALID','BROKER_FUNDS_CURRENCY_UNVERIFIED']:['ACTIVITY_FLEX_HAS_NO_AVAILABLE_FUNDS']).includes(c.availableFunds.reason))fail('CASH_REASON');}
  if(fields&&c.planningBasis?.status==='reference'){exact(c.planningBasis,['status','assumption','sourceDate']);}
  else if(c.planningBasis?.status==='conditional'){exact(c.planningBasis,['status','assumption','sourceDate']);if(c.planningBasis.assumption!=='NO_UNREFLECTED_ACTIVITY_SINCE_EOD'||c.planningBasis.sourceDate!==m.sourceDate||m.reconciliation.status!=='verified'||m.reconciliation.cashResidual!==0||m.reconciliation.cancellationPending)fail('PLANNING_BASIS');}else{exact(c.planningBasis,['status','reason']);if(c.planningBasis.status!=='unknown'||!['CASH_OR_ORDERS_UNKNOWN','EOD_RECONCILIATION_UNRESOLVED'].includes(c.planningBasis.reason)||c.planning!==null)fail('PLANNING_BASIS');}
  for(const k of ['ib','noah','pool','orderReserve','planning','totalCapacity'])if(c[k]!==null&&!finite(c[k]))fail('CASH_NUMBER');
  if(c.pool!==(c.ib===null||c.noah===null||!finite(cents(c.ib+c.noah))?null:cents(c.ib+c.noah)))fail('POOL');
  if(['unknown','partial'].includes(o.status)&&(c.orderReserve!==null||c.planning!==null||c.totalCapacity!==null||m.allocation.projectedTotal!==null))fail('UNKNOWN_DEPENDENCIES');
  if(o.status==='ready'&&c.orderReserve!==null&&(fields&&o.buys.some(r=>r.currency!=='USD')||Math.abs(o.buys.reduce((s,r)=>s+cents(Number(r.quantity)*Number(r.limit)),0)-c.orderReserve)>.011))fail('ORDER_RESERVE');
  if(c.planning!==(!['conditional',...(fields?['reference']:[])].includes(c.planningBasis.status)||c.pool===null||c.orderReserve===null||c.callApplied===null?null:Math.max(0,cents(c.pool-c.callApplied-c.orderReserve))))fail('PLANNING');
  validateCashLikeContribution(c.cashLike);
  const expectedCapacity=c.planning===null||c.cashLike===null?null:cents(c.planning+c.cashLike.total);
  if(c.totalCapacity!==(fields&&expectedCapacity!==null&&!finite(expectedCapacity)?null:expectedCapacity))fail('CAPACITY');
  if(c.eod?.status==='verified'){if(c.eod.currency!=='USD'||!finite(c.eod.tradeDate)||!finite(c.eod.settled)||!fields&&c.ib!==cents(c.eod.tradeDate)||!Array.isArray(c.eod.native)||c.eod.native.length>100||c.eod.native.some(r=>! /^[A-Z]{3}$/.test(r.currency)||!finite(r.endingCash)||!finite(r.endingSettledCash)))fail('EOD_CASH');}else if(c.eod?.status!=='unknown'||!fields&&c.ib!==null)fail('EOD_CASH');
  if(c.eod.status==='verified'){exact(c.eod,['status','currency','tradeDate','settled','native']);for(const r of c.eod.native){exact(r,['currency','level','endingCash','endingSettledCash','components']);if(r.level!=='Currency'||!r.components||Object.keys(r.components).some(k=>!['commissions','fxTranslationGainLoss','netTradesPurchases','netTradesSales'].includes(k))||Object.values(r.components).some(n=>typeof n!=='number'||!Number.isFinite(n)))fail('CASH_COMPONENTS');}}else{exact(c.eod,['status','reason']);if(c.eod.reason!=='FLEX_CASH_MISSING')fail('CASH_REASON');}
  const a=m.allocation;if(!a||!['ready','unavailable'].includes(a.status))fail('ALLOCATION');
  if(Object.hasOwn(m,'holdings')){validateEodHoldings(m.holdings,a,m.sourceDate);if(m.holdings.status==='ready'&&!snapshotUsable(outcome('sharesight.ibGroupedPerformance').status))fail('HOLDINGS_OUTCOME');}
  if(a.status==='ready'&&!snapshotUsable(outcome('sharesight.ibGroupedPerformance').status))fail('ALLOCATION_OUTCOME');
  validateAllocationContribution(a,m.asOfHkt);
  validateReplenishmentContribution(m.replenishment,{c,o,a,asOfHkt:m.asOfHkt});
  if(JSON.stringify(m.notes)!==JSON.stringify(fixedNotes(m.sourceDate,fields)))fail('NOTES');
  const flexKnown=outcome('ib.flexEod').status==='verified';
  if(!m.provenance?.flex||m.provenance.flex.sourceDate!==m.sourceDate||(flexKnown||!fields)&&(m.provenance.flex.coveredThrough!==m.sourceDate||!/^[a-f0-9]{64}$/.test(m.provenance.flex.archiveSha256||'')||!instant(m.provenance.flex.readAt))||!Array.isArray(m.provenance.sharesight)||m.provenance.sharesight.some(s=>s.sourceDate!==m.sourceDate||!instant(s.readAt)))fail('PROVENANCE');
  if(m.provenance.flex.archiveSha256!==outcome('ib.flexEod').rawFingerprint||m.provenance.sharesight.length!==m.sourceOutcomes.filter(s=>s.sourceKey.startsWith('sharesight.')&&snapshotUsable(s.status)).length||new Set(m.provenance.sharesight.map(s=>s.sourceKey)).size!==m.provenance.sharesight.length||m.provenance.sharesight.some(s=>!s.sourceKey.startsWith('sharesight.')||!snapshotUsable(outcome(s.sourceKey)?.status)||!/^[a-f0-9]{64}$/.test(outcome(s.sourceKey)?.rawFingerprint||'')))fail('PROVENANCE_BINDING');
  for(const s of m.provenance.sharesight){
    if(['date-verified','ui-export-observed'].includes(outcome(s.sourceKey).status)){
      if(s.syncCompletedAt!==null||s.snapshotGeneration!==null||s.receiptSha256!==null)fail('SYNC_COMPLETION_CLAIM');
    }else if(!instant(s.syncCompletedAt)||Date.parse(s.syncCompletedAt)>Date.parse(s.readAt)||!/^[a-f0-9]{64}$/.test(s.receiptSha256||'')||!/^\d+$/.test(s.snapshotGeneration||''))fail('PROVENANCE');
    if(outcome(s.sourceKey).status==='ui-export-observed'&&(!date(s.uiReportStart)||s.uiReportStart>m.sourceDate||!instant(s.uiExportedAt)||Date.parse(s.uiExportedAt)>Date.parse(s.readAt)))fail('UI_PROVENANCE');
  }
  if(book)for(const s of m.provenance.sharesight){
    if(!['authenticated-browser','api'].includes(s.channel)||(s.classificationReadAt!==null&&(!instant(s.classificationReadAt)||s.classificationReadAt>s.readAt))
      ||s.channel==='api'&&s.classificationReadAt!==null)fail('BROWSER_PROVENANCE');
  }
  exact(m.provenance,['flex','sharesight',...(fields?['capture']:[])]);exact(m.provenance.flex,['sourceDate','coveredFrom','coveredThrough','providerGeneratedText','providerTimezone','readAt','archiveSha256']);m.provenance.sharesight.forEach(s=>exact(s,['sourceKey','sourceDate','readAt','syncCompletedAt','snapshotGeneration','receiptSha256',...(book?['channel','classificationReadAt']:[]),...(outcome(s.sourceKey).status==='ui-export-observed'?['uiReportStart','uiExportedAt']:[])]));
  const f=m.provenance.flex;if(flexKnown&&(!date(f.coveredFrom)||f.coveredFrom>m.sourceDate||!validProviderGeneratedText(f.providerGeneratedText)||f.providerTimezone!==null&&typeof f.providerTimezone!=='string')||!flexKnown&&Object.entries(f).some(([k,v])=>k!=='sourceDate'&&v!==null))fail('PROVENANCE');
  if(f.providerTimezone!==null){try{new Intl.DateTimeFormat('en',{timeZone:f.providerTimezone});}catch{fail('PROVIDER_TIMEZONE');}}
  exact(m.reconciliation,['status','cashResidual','cancellationPending','verificationSha256']);if(!(m.reconciliation.verificationSha256===null||/^[a-f0-9]{64}$/.test(m.reconciliation.verificationSha256||''))||m.reconciliation.status!=='unknown'&&m.reconciliation.verificationSha256===null)fail('FINANCIAL_PROOF');if(!['verified','pending','unknown'].includes(m.reconciliation.status)||typeof m.reconciliation.cancellationPending!=='boolean'||!(m.reconciliation.cashResidual===null||Number.isFinite(m.reconciliation.cashResidual)&&Math.abs(m.reconciliation.cashResidual)<=1e12))fail('RECONCILIATION');
  if(m.reconciliation.status==='verified'&&(m.reconciliation.cashResidual!==0||m.reconciliation.cancellationPending)||m.reconciliation.status==='unknown'&&m.reconciliation.cashResidual!==null||m.reconciliation.cashResidual===null&&m.reconciliation.status!=='unknown')fail('RECONCILIATION');
  // This schema-9 marker is private. Its source proof and risk envelope never
  // enter the separate, closed public projection schemas.
  if(Object.hasOwn(m,'concentration')){
    validateActionConcentration(m.concentration,m.sourceDate);
    if(new Date(Date.parse(m.concentration.readWindow.completedAt)+28800000).toISOString().slice(0,10)!==m.dataDate)fail('CONCENTRATION_DATE');
  }
  if(book){
    validateBookConcentration(m.bookConcentration,m.sourceDate);
    if(c.preOrderPlanning!==(c.pool!==null&&c.callApplied!==null?Math.max(0,cents(c.pool-c.callApplied)):null)
      ||m.status!==bookStatus(m))fail('BOOK_BUDGET');
  }else if(Object.hasOwn(m,'bookConcentration'))fail('CALCULATION_BASIS');
  const top=['schemaVersion','mode','dataDate','sourceDate','asOfHkt','status','sourceManifestSha256','evidenceSha256','sourceOutcomes','provenance','replenishment','orders','cash','allocation','holdings','reconciliation','notes','fieldState','fieldErrors','concentration','calculationBasis','bookConcentration'];
  if(Object.keys(m).some(k=>!top.includes(k)))fail('PUBLIC_KEYS');
  if(fields)validateActionFieldState(m);else if(Object.hasOwn(m,'fieldErrors'))fail('PUBLIC_KEYS');
  return m;
}

export function validateEodOrders(orders,{dataDate,readAt,startedAt=null,fieldMode=false}) {
  const o=orders;if(!o||!['ready','unknown',...(fieldMode?['partial']:[])].includes(o.status)||typeof o.asOfHkt!=='string')fail('ORDERS');
  const present=o.status!=='unknown';
  if(o.status==='unknown'&&(o.buys!==null||o.sells!==null))fail('UNKNOWN_ORDERS');
  if(present&&(!Array.isArray(o.buys)||!Array.isArray(o.sells)||o.buys.length+o.sells.length>60))fail('ORDERS');
  if(present)for(const [side,rows] of [['BUY',o.buys],['SELL',o.sells]])for(const r of rows){if(r.side!==side||typeof r.description!=='string'||! /^[A-Z][A-Z0-9./-]{0,20}$/.test(r.description)||!/^\d+(?:\.\d+)?$/.test(r.quantity)||!/^\d+(?:\.\d+)?$/.test(r.limit)||!finite(Number(r.quantity))||!finite(Number(r.limit))||Number(r.limit)<=0||!['NEW','REPLACED'].includes(r.status)||!(r.currency===null||/^[A-Z]{3}$/.test(r.currency))||!(r.distancePct===null||Number.isFinite(r.distancePct))||!(r.ageDays===null||Number.isInteger(r.ageDays)&&r.ageDays>=0))fail('ORDER');if(r.trend!==null&&(!/^[a-f0-9]{64}$/.test(r.trend?.key||'')||!finite(r.trend.firstPrice)||r.trend.firstPrice<=0||!date(r.trend.firstDate)||r.trend.firstDate>dataDate||!Number.isInteger(r.trend.ageDays)||r.trend.ageDays<0||!['none','up','down','flat'].includes(r.trend.kind)||!(r.trend.label===null||typeof r.trend.label==='string'&&/^约 [→↑↓] \d+(?:\.\d+)?% · 观察\d+天$/.test(r.trend.label))))fail('TREND');if(r.trend&&(r.trend.kind==='none')!==(r.trend.label===null))fail('TREND');}
  exact(o,o.status==='unknown'?['status','asOfHkt','buys','sells','reason']:['status','asOfHkt','capturedStartedAt','capturedCompletedAt','buys','sells',...(fieldMode?['coverage']:[])]);
  if(fieldMode&&present&&(o.coverage!==(o.status==='ready'?'complete':'unknown')||!instant(startedAt)||o.capturedStartedAt<startedAt))fail('ORDER_COVERAGE');
  if(o.status==='unknown'&&(o.asOfHkt!=='未取得'||!['ORDERS_NOT_CAPTURED','OPTIONAL_LIVE_FAILED','OPTIONAL_LIVE_TIMEOUT','ORDERS_MALFORMED_OR_UNMATCHED'].includes(o.reason)))fail('ORDER_REASON');
  if(present&&(!instant(o.capturedStartedAt)||!instant(o.capturedCompletedAt)||Date.parse(o.capturedCompletedAt)<Date.parse(o.capturedStartedAt)||Date.parse(o.capturedCompletedAt)>Date.parse(readAt)||Date.parse(readAt)-Date.parse(o.capturedStartedAt)>300_000||!hktLabel(o.capturedStartedAt,o.capturedCompletedAt).startsWith(dataDate+' ')||o.asOfHkt!==hktLabel(o.capturedStartedAt,o.capturedCompletedAt)))fail('ORDER_TIME');
  if(present)for(const r of [...o.buys,...o.sells]){exact(r,['side','description','limit','quantity','status','currency','ageDays','distancePct','trend']);if(r.trend)exact(r.trend,['key','firstDate','firstPrice','ageDays','kind','label']);}
  return orders;
}

// The producer and final tamper guard share these complete contribution checks.
function validateAllocationContribution(a,asOfHkt){
  if(!a||!['ready','unavailable'].includes(a.status))fail('ALLOCATION');
  exact(a,['status','total','projectedTotal','categories','fundingNeed']);
  if(a.status==='unavailable'&&(a.total!==null||a.categories!==null||a.projectedTotal!==null||a.fundingNeed!==null))fail('ALLOCATION_UNKNOWN');
  if(a.status==='ready'){
    if(!finite(a.total)||a.total<=0||!Array.isArray(a.categories)||a.categories.length!==4)fail('ALLOCATION');
    for(const [i,[label,target]] of [...STOCK_CLASS_TARGETS].entries()){const r=a.categories[i];exact(r,['label','marketValue','currentPct','targetPct','projectedMarketValue','projectedPct']);if(r.label!==label||r.targetPct!==target||!finite(r.marketValue)||!finite(r.currentPct)||Math.abs(r.marketValue/a.total*100-r.currentPct)>1e-8||!(r.projectedMarketValue===null||finite(r.projectedMarketValue)&&r.projectedMarketValue>=r.marketValue)||!(r.projectedPct===null||finite(r.projectedPct)&&r.projectedPct<=100))fail('CATEGORY');if(a.projectedTotal===null&&(r.projectedMarketValue!==null||r.projectedPct!==null))fail('PROJECTION_UNKNOWN');if(a.projectedTotal!==null&&(r.projectedMarketValue===null||Math.abs(r.projectedMarketValue/a.projectedTotal*100-r.projectedPct)>1e-8))fail('PROJECTION');}
    if(Math.abs(a.categories.reduce((s,r)=>s+r.marketValue,0)-a.total)>.011||a.projectedTotal!==null&&(!finite(a.projectedTotal)||Math.abs(a.categories.reduce((s,r)=>s+r.projectedMarketValue,0)-a.projectedTotal)>.011))fail('DENOMINATOR');
    if(a.fundingNeed?.status==='verified'&&(!finite(a.fundingNeed.fullNeed)||!Array.isArray(a.fundingNeed.full)||a.fundingNeed.full.length!==2||a.fundingNeed.full.some(n=>!finite(n))||Math.abs(a.fundingNeed.full.reduce((s,n)=>s+n,0)-a.fundingNeed.fullNeed)>.011))fail('FUNDING_NEED');
  }
  if(a.fundingNeed?.status==='verified'){const de=a.categories.slice(2);const baseline=calculateCashPlan({schemaVersion:1,status:'snapshot',sourceAsOfHkt:asOfHkt.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?:–\d{2}:\d{2})? HKT/)?.[0],equityTotal:a.total,developed:de[0].marketValue,emerging:de[1].marketValue,ibCash:0,noahCash:0,reserve:0,currency:'USD',denominator:'equity-only'});if(a.fundingNeed.scope!=='current-buy-only-developed-emerging'||Math.abs(baseline.fullNeed-a.fundingNeed.fullNeed)>.011||!Array.isArray(a.fundingNeed.staticGaps)||a.fundingNeed.staticGaps.length!==2||baseline.staticGaps.some((n,i)=>Math.abs(n-a.fundingNeed.staticGaps[i])>.011)||baseline.full.some((n,i)=>Math.abs(n-a.fundingNeed.full[i])>.011))fail('FUNDING_CALCULATION');}
  if(a.fundingNeed){if(a.fundingNeed.status==='verified')exact(a.fundingNeed,['status','scope','fullNeed','full','staticGaps']);else{exact(a.fundingNeed,['status','reason']);if(a.fundingNeed.status!=='unknown'||a.fundingNeed.reason!=='POLICY_EDGE')fail('FUNDING_REASON');}}
  return a;
}
function validateReplenishmentContribution(p,{c,o,a,asOfHkt}){
if(!p||!['ready','unavailable'].includes(p.status)||p.executableBudget!==null)fail('PLAN');
  if(p.status==='ready'&&(!finite(p.budget)||p.budget!==c.planning||!finite(p.total)||!finite(p.retained)||Math.abs(p.total+p.retained-p.budget)>.011||!Array.isArray(p.items)||p.items.length!==3||p.items.some((r,i)=>r.symbol!==['EXUS','EIMI','USSC'][i]||!finite(r.amount))||Math.abs(p.items.reduce((s,r)=>s+r.amount,0)-p.total)>.011||o.status!=='ready'||a.status!=='ready'))fail('PLAN');
  if(p.status==='ready'){const u=cents(p.budget*.1);const de=calculateCashPlan({schemaVersion:1,status:'snapshot',sourceAsOfHkt:asOfHkt.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?:–\d{2}:\d{2})? HKT/)?.[0],equityTotal:a.projectedTotal+u,developed:a.categories[2].projectedMarketValue,emerging:a.categories[3].projectedMarketValue,ibCash:cents(p.budget-u),noahCash:0,reserve:0,currency:'USD',denominator:'equity-only'});if(Math.abs(p.items[2].amount-u)>.001||de.allocations.some((n,i)=>Math.abs(n-p.items[i].amount)>.001)||Math.abs(p.retained-de.budgetUnused)>.001)fail('PLAN_CALCULATION');}
  if(p.status==='unavailable'&&!['CASH_OR_ORDERS_UNKNOWN','POLICY_EDGE'].includes(p.reason))fail('PLAN_REASON');
  exact(p,p.status==='ready'?['status','budget','total','retained','items','executableBudget']:['status','reason','executableBudget']);if(p.status==='ready')p.items.forEach(r=>exact(r,['symbol','amount']));
  return p;
}
function allocationContribution(a,projection=null,fundingNeed=null){
  return a?{status:'ready',total:a.total,projectedTotal:projection?.total??null,
    categories:a.categories.map(c=>({...c,projectedMarketValue:projection?.categories.find(p=>p.label===c.label)?.projectedMarketValue??null,projectedPct:projection?.categories.find(p=>p.label===c.label)?.projectedPct??null})),fundingNeed}
    :{status:'unavailable',total:null,projectedTotal:null,categories:null,fundingNeed:null};
}
function validateCashLikeContribution(value){
  if(value===null)return value;
  exact(value,['total','items']);
  if(!finite(value.total)||!Array.isArray(value.items)||value.items.length>3||new Set(value.items.map(i=>i?.symbol)).size!==value.items.length
    ||value.items.some(i=>!i||!['VGSH','VGIT','TLT'].includes(i.symbol)||!finite(i.amount))||Math.abs(value.items.reduce((s,i)=>s+i.amount,0)-value.total)>.011)fail('CASH_LIKE');
  value.items.forEach(r=>exact(r,['symbol','amount']));return value;
}

function validateSourceOutcomes(outcomes,fields){
  if(!Array.isArray(outcomes)||outcomes.length!==4||new Set(outcomes.map(s=>s.sourceKey)).size!==4||outcomes.some(s=>!['ib.flexEod','sharesight.ibGroupedPerformance','sharesight.noahPerformance','ib.optionalLive'].includes(s.sourceKey)||!['verified','date-verified','ui-export-observed','captured','not-called','request-failure','missing-fields','date-mismatch','malformed','unverified','failed','timeout',...(fields?['partial']:[])].includes(s.status)||s.status==='date-verified'&&!s.sourceKey.startsWith('sharesight.')||s.status==='ui-export-observed'&&s.sourceKey!=='sharesight.noahPerformance'||s.rawFingerprint!==null&&!/^[a-f0-9]{64}$/.test(s.rawFingerprint||'')))fail('OUTCOMES');
  outcomes.forEach(s=>exact(s,['sourceKey','status','rawFingerprint']));
}
