import {adaptFlexCashReport} from './xuan-ib-flex-cash-adapter.mjs';
// Offline basis projection. Existing Flex dictionary mapping is implemented;
// authorized output path and independent identity proof remain unestablished.
// No endpoint, query, secret, email, ledger synchronization or network fallback.
import {parseSharesightStockAllocation,parseSharesightCash} from './xuan-ib-sharesight-allocation.mjs';
const fail=code=>{throw new Error(`Night action basis: ${code}`);};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1e12;
const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)).toISOString()===v;
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>`USD ${v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
/** The injected verifier binds the exact existing scrubbed dictionary,
 * original archive hash, private account and recurring association policy. A raw self-asserted
 * status/hash alone is never accepted. Producer integration must supply a
 * reviewed independent verifier; there is deliberately no default verifier. */
export function buildBasisModel({dataDate,sourceDate,flexCash,ibGroupedPerformance,noahPerformance,sharesightAcquiredAt,noahAcquiredAt,now,association,verifyProof}) {
  if(!date(dataDate)||!date(sourceDate)||sourceDate>=dataDate||!time(noahAcquiredAt)||Date.parse(noahAcquiredAt)>now||now-Date.parse(noahAcquiredAt)>1800000||!time(sharesightAcquiredAt)||Date.parse(sharesightAcquiredAt)>now||now-Date.parse(sharesightAcquiredAt)>1800000)fail('SOURCE_DATE_OR_TIME');
  const cash=adaptFlexCashReport(flexCash,{sourceDate,now,association,verifyProof});
  const allocation=parseSharesightStockAllocation(ibGroupedPerformance),noah=parseSharesightCash(noahPerformance,{portfolioId:936238});
  if(allocation.dataDate!==sourceDate||noah.dataDate!==sourceDate)fail('SOURCE_DATE_NOT_READY');
  // Current values only; no projected allocation, FX merge, reserve deduction,
  // buying power, cash pool or replenishment budget exists in this capability.
  const model={schemaVersion:9,dataDate,status:'basis',sourceDate,sharesightAcquiredAt,
    capabilities:{valuation:true,cashStatement:true,orders:false,action:false},
    cash, noahCash:{amount:noah.total,currency:'USD',basis:'sharesight-cash-valuation',valuationDate:noah.dataDate,acquiredAt:noahAcquiredAt},
    allocation:{total:allocation.total,categories:allocation.categories}};
  return validateBasisModel(model);
}
export function validateBasisModel(m) {
  if(!exact(m,['schemaVersion','dataDate','status','sourceDate','sharesightAcquiredAt','capabilities','cash','noahCash','allocation'])||m.schemaVersion!==9||m.status!=='basis'
    ||!date(m.dataDate)||!date(m.sourceDate)||m.sourceDate>=m.dataDate||!time(m.sharesightAcquiredAt)
    ||JSON.stringify(m.capabilities)!==JSON.stringify({valuation:true,cashStatement:true,orders:false,action:false}))fail('MODEL_SCOPE');
  if(!exact(m.cash,['amount','settledAmount','currency','basis','coverageFrom','coverageDate','acquiredAt','generatedAt','generationTimezone'])||!finite(m.cash.amount)||!finite(m.cash.settledAmount)||!date(m.cash.coverageFrom)||m.cash.coverageFrom>m.cash.coverageDate||m.cash.generationTimezone!==null||!/^\d{4}-\d{2}-\d{2};\d{2}:\d{2}:\d{2}$/.test(m.cash.generatedAt)||m.cash.currency!=='USD'||m.cash.basis!=='ending-cash-base-currency'||m.cash.coverageDate!==m.sourceDate||!time(m.cash.acquiredAt)
    ||!exact(m.noahCash,['amount','currency','basis','valuationDate','acquiredAt'])||!finite(m.noahCash.amount)||m.noahCash.currency!=='USD'||m.noahCash.basis!=='sharesight-cash-valuation'||m.noahCash.valuationDate!==m.sourceDate||!time(m.noahCash.acquiredAt))fail('MODEL_CASH');
  const a=m.allocation,labels=['美国底仓','美国科技','非美发达','新兴市场'],targets=[45,20,23,12];
  if(!exact(a,['total','categories'])||!finite(a.total)||a.total<=0||!Array.isArray(a.categories)||a.categories.length!==4)fail('MODEL_ALLOCATION');
  a.categories.forEach((c,i)=>{if(!exact(c,['label','marketValue','currentPct','targetPct'])||c.label!==labels[i]||!finite(c.marketValue)||!finite(c.currentPct)||c.currentPct>100||c.targetPct!==targets[i]||Math.abs(c.currentPct-c.marketValue/a.total*100)>1e-8)fail('MODEL_ALLOCATION');});
  if(Math.abs(a.categories.reduce((sum,c)=>sum+c.marketValue,0)-a.total)>0.001)fail('MODEL_ALLOCATION');
  return m;
}
export function renderBasisReport(m) {
  validateBasisModel(m);
  const marker=Buffer.from(JSON.stringify(m)).toString('base64url');
  return `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>XUAN · 开市前基础版</title><style>body{margin:0;background:#f6f7f8;color:#17191c;font:16px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}main{max-width:720px;margin:auto;padding:18px}section{background:white;border:1px solid #e4e6e8;border-radius:16px;padding:16px;margin:14px 0}h1{font-size:24px}h2{font-size:19px}small,p{color:#6c727a}.row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid #eee}.state{color:#9a6700;font-weight:700}@media(max-width:520px){main{padding:12px}.row{flex-wrap:wrap}}</style></head><body><!-- xuan-ib-night-action-v1:${marker} --><main><header><span class="state" id="report-state">基础版 · ${esc(m.dataDate)}</span><h1>XUAN · 开市前基础版</h1><p>估值来源日：${esc(m.sourceDate)}<br>Sharesight 取得时间：${esc(m.sharesightAcquiredAt)}</p></header><section><h2>本轮挂单未取得</h2><p>本轮不显示挂单和具体补仓金额。现金报表不证明当前可下单金额；Sharesight 估值日不证明成交已全部导入，取得时间不证明行情实时。</p></section><section><h2>现金报表与估值</h2><div class="row"><span>IB 期末现金报表</span><b>${money(m.cash.amount)}</b></div><p>覆盖期：${esc(m.cash.coverageFrom)} 至 ${esc(m.cash.coverageDate)}<br>覆盖日：${esc(m.cash.coverageDate)}<br>取得时间：${esc(m.cash.acquiredAt)}<br>报表生成标记：${esc(m.cash.generatedAt)}（来源未提供时区）<br>口径：报表期末基础币种现金；已结算期末现金 ${money(m.cash.settledAmount)}，均不等于当前购买力。</p><div class="row"><span>NOAH-HK 现金估值</span><b>${money(m.noahCash.amount)}</b></div><p>估值日：${esc(m.noahCash.valuationDate)}<br>取得时间：${esc(m.noahCash.acquiredAt)}；口径：Sharesight 现金估值。两项口径分别显示，不合并为可用现金。</p></section><section><h2>股票四类配置</h2><small>Sharesight · 当前 → 参考目标 · USD 估值</small>${m.allocation.categories.map(c=>`<div class="row"><span>${esc(c.label)}</span><b>${c.currentPct.toFixed(1)}% → ${c.targetPct.toFixed(1)}%<br>${money(c.marketValue)}</b></div>`).join('')}</section><footer><p>只读基础版；不下单、撤单、改单、转账或同步流水。页面状态由本轮报告证据决定。</p></footer></main></body></html>`;
}
