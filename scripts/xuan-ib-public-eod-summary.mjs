// Public projection only. Never copy private model/receipt/source objects.
import {validateEodActionModel} from './xuan-ib-eod-action-model.mjs';
const fail=code=>{throw Error('EOD_PUBLIC_SUMMARY_'+code);};
const exact=(v,keys)=>{if(!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).sort().join('|')!==[...keys].sort().join('|'))fail('FIELDS');};
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const instant=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const hktDate=v=>new Date(Date.parse(v)+28800000).toISOString().slice(0,10);
const pct=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100&&Math.abs(v*10-Math.round(v*10))<1e-8;
export function validatePublicEodSummary(m){
 exact(m,['schemaVersion','mode','status','dataDate','sourceDate','captureStartedAt','captureCompletedAt','risks','unknowns','concentration']);
 if(m.schemaVersion!==10||m.mode!=='stored-eod-public-summary'||m.status!=='partial'||!date(m.dataDate)||!date(m.sourceDate)||m.sourceDate>=m.dataDate||!instant(m.captureStartedAt)||!instant(m.captureCompletedAt)||hktDate(m.captureStartedAt)!==m.dataDate||hktDate(m.captureCompletedAt)!==m.dataDate||Date.parse(m.captureCompletedAt)<Date.parse(m.captureStartedAt)||Date.parse(m.captureCompletedAt)-Date.parse(m.captureStartedAt)>300000)fail('DATES');
 exact(m.risks,['reconciliation','liveSource']);
 if(!['verified','pending','unknown'].includes(m.risks.reconciliation)||m.risks.liveSource!=='not-called')fail('RISKS');
 exact(m.unknowns,['orders','orderReserve','planning','executableBudget','availableFunds']);
 if(Object.values(m.unknowns).some(v=>v!==null))fail('UNKNOWNS');
 exact(m.concentration,['status','top1Pct','top5Pct']);
 if(m.concentration.status==='observed'){
  if(!pct(m.concentration.top1Pct)||!pct(m.concentration.top5Pct)||m.concentration.top1Pct>m.concentration.top5Pct)fail('PERCENTAGES');
 }else if(m.concentration.status!=='unknown'||m.concentration.top1Pct!==null||m.concentration.top5Pct!==null)fail('PERCENTAGES');
 return m;
}
export function buildPublicEodSummary(model,receipt){
 validateEodActionModel(model);
  const started=Date.parse(receipt?.startedAt),completed=Date.parse(receipt?.completedAt);
  const minute=v=>new Date(v+28800000).toISOString().slice(11,16);
  const prefix=new RegExp('^report-check/'+String(receipt?.startedAt).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'-[a-f0-9-]{36}/');
  const originalWindow=model.asOfHkt.match(/^\d{4}-\d{2}-\d{2} (\d{2}:\d{2})–(\d{2}:\d{2}) HKT/);
  const modelCompleted=Date.parse(`${model.dataDate}T${originalWindow?.[2]}:00+08:00`);
  // Model preparation precedes immutable uploads and receipt completion;
  // slow uploads may legitimately end in a later minute.
  if(!Number.isFinite(started)||!Number.isFinite(completed)||!Array.isArray(receipt.sources)||receipt.sources.some(s=>!prefix.test(s.privateObject))||originalWindow?.[1]!==minute(started)||!Number.isFinite(modelCompleted)||modelCompleted<Math.floor(started/60000)*60000||modelCompleted>completed||[model.provenance.flex,...model.provenance.sharesight].some(s=>Date.parse(s.readAt)<started||Date.parse(s.readAt)>completed))fail('CAPTURE_BINDING');
 if(receipt?.mode!=='private_eod_action'||receipt.dataDate!==model.dataDate||receipt.sourceDate!==model.sourceDate||model.orders.status!=='unknown'||model.orders.buys!==null||model.orders.sells!==null||model.cash.orderReserve!==null||model.cash.planning!==null||model.cash.executableBudget!==null||model.cash.availableFunds.status!=='unknown'||model.sourceOutcomes.find(s=>s.sourceKey==='ib.optionalLive')?.status!=='not-called')fail('PRIVATE_SCOPE');
 const observed=model.holdings?.status==='ready';
 const rounded=v=>Math.max(0,Math.min(100,Math.round(v*10)/10));
 return validatePublicEodSummary({schemaVersion:10,mode:'stored-eod-public-summary',status:'partial',dataDate:model.dataDate,sourceDate:model.sourceDate,captureStartedAt:receipt.startedAt,captureCompletedAt:receipt.completedAt,
  risks:{reconciliation:model.reconciliation.status,liveSource:'not-called'},unknowns:{orders:null,orderReserve:null,planning:null,executableBudget:null,availableFunds:null},
  concentration:observed?{status:'observed',top1Pct:rounded(model.holdings.concentration.top1Pct),top5Pct:rounded(model.holdings.concentration.top5Pct)}:{status:'unknown',top1Pct:null,top5Pct:null}});
}
export function renderPublicEodSummary(m){
 validatePublicEodSummary(m);
 const time=v=>new Date(Date.parse(v)+28800000).toISOString().slice(11,19);
 const label={verified:'已核实',pending:'待核实',unknown:'未核实'}[m.risks.reconciliation];
 const concentration=m.concentration.status==='observed'?`<div class="metrics"><div><span>匿名单票第1名</span><b>${m.concentration.top1Pct.toFixed(1)}%</b></div><div><span>匿名前5名合计</span><b>${m.concentration.top5Pct.toFixed(1)}%</b></div></div>`:'<p class="unknown">集中度比例未知</p>';
 const marker=Buffer.from(JSON.stringify(m)).toString('base64url');
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>XUAN · 已保存 EOD 摘要</title><style>
:root{color-scheme:light;--bg:#f6f7f8;--card:#fff;--text:#17191c;--mut:#6c727a;--line:#e4e6e8}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:720px;margin:auto;padding:calc(16px + env(safe-area-inset-top)) 14px calc(28px + env(safe-area-inset-bottom))}header{padding:4px 2px 10px}h1{font-size:24px;margin:0}header p{margin:4px 0;color:var(--mut);font-size:13px}.state{float:right;color:#9a6700;font-weight:700}.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px;margin:12px 0;box-shadow:0 1px 2px #00000008}.card h2{font-size:19px;margin:0 0 12px}.unknown,.notes{color:var(--mut)}.metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px}.metrics div{background:#f7f8f9;border-radius:12px;padding:11px}.metrics span{display:block;color:var(--mut);font-size:12px}.metrics b{font-size:24px}.notes{font-size:12px;padding:2px 4px}@media(max-width:520px){h1{font-size:22px}.card{padding:14px}}
</style></head><body><!-- xuan-ib-night-action-v1:${marker} --><main><header><span class="state">已保存 · 部分信息</span><h1>XUAN · 已保存 EOD 摘要</h1><p>${m.dataDate} · 来源日 ${m.sourceDate}</p><p>原成品 ${time(m.captureCompletedAt).slice(0,5)} HKT 生成 · 原取数时间 ${time(m.captureStartedAt)}–${time(m.captureCompletedAt)} HKT</p><p>这是已保存的收盘摘要，不是新的实时取数。</p></header>
<section class="card"><h2>本轮补仓</h2><p class="unknown">可执行预算未知；不提供下单金额或股数。</p></section>
<section class="card"><h2>挂单提醒</h2><p class="unknown">实时挂单未取得；不代表无挂单，不沿用旧挂单。</p></section>
<section class="card"><h2>现金优先补仓参考</h2><p>EOD 对账状态：${label}</p><p class="unknown">可用资金、买单预留及规划预算未知。余额与账户信息仅保留私有。</p></section>
<section class="card"><h2>股票四类配置</h2>${concentration}<p class="unknown">仅公开匿名集中度；不公开持仓名称、数量、市值或配置金额。</p></section>
<footer class="notes"><p>日期、风险状态和集中度比例来自原已保存成品。未知值不当作零；此摘要不表示即时购买能力。</p></footer></main></body></html>`;
}
