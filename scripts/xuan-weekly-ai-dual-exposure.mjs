// Weekly-only paired observations: preserve actual allocation and add reviewed daily target exposure.
import {createHash} from 'node:crypto';
import {DEFAULT_POLICY,renderAiExposure} from './xuan-weekly-ai-exposure.mjs';
import {LEVERAGED_POLICY,resolveLeveragedProduct} from './xuan-weekly-leveraged-products.mjs';
const METHOD='weekly-ai-related-daily-equivalent-v1';
const integer=v=>{if(!/^\d+$/.test(String(v)))throw Error('weekly_ai_dual_amount_invalid');return BigInt(v);};
const cents=m=>String((m+5000n)/10000n);
const percent=(value,total)=>Number((value*10000n+total/2n)/total)/100;
const day=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')?Date.parse(d+'T00:00:00Z'):NaN;
export function buildAiDualExposure(envelope,{cutoff,actualAllocation,policy=DEFAULT_POLICY,leveragePolicy=LEVERAGED_POLICY,previous=null}={}){
  const actual=actualAllocation;
  if(!actual||actual.cutoff!==cutoff||!Number.isFinite(day(cutoff))||actual.rows.length!==envelope.riskConstituents.length)throw Error('weekly_ai_dual_actual_scope_invalid');
  const nav=integer(actual.denominatorCents),navMicro=envelope.riskDenominator.components.reduce((s,c)=>s+integer(c.valueMicro),0n);
  if(nav<=0n||cents(navMicro)!==actual.denominatorCents)throw Error('weekly_ai_dual_denominator_invalid');
  const totals=new Map(actual.groups.map(g=>[g.key,integer(g.marketValueCents)*10000n]));
  const products=new Map();let extra=0n;
  for(const [index,row] of envelope.riskConstituents.entries()){
    const observed=actual.rows[index];
    if(row.identityVerified!==true||observed.symbol!==row.symbol||observed.assetType!==row.assetType||observed.custodian!==row.custodian||cents(integer(row.marketValueMicro))!==observed.marketValueCents)throw Error('weekly_ai_dual_row_identity_invalid');
    const product=resolveLeveragedProduct(row,{cutoff,policy:leveragePolicy});
    if(!product)continue;
    const def=policy.stocks.find(s=>s.id===product.underlyingInstrumentId&&s.symbols.includes(product.underlying)&&(s.assetTypes||['STK']).includes('STK'));
    // A verified leverage multiplier cannot supply missing/expired business classification.
    if(!def||cutoff>policy.reviewBy)continue;
    if(observed.group!==def.group||!totals.has(def.group))throw Error('weekly_ai_dual_business_scope_invalid');
    const invested=integer(row.marketValueMicro),equivalent=invested*BigInt(product.dailyMultiplierBp)/10000n,delta=equivalent-invested;
    totals.set(def.group,totals.get(def.group)+delta);extra+=delta;
    const key=product.symbol+':'+product.underlying+':'+product.dailyMultiplierBp;
    const entry=products.get(key)||{symbol:product.symbol,underlying:product.underlying,group:def.group,multiplierBp:product.dailyMultiplierBp,basis:product.basis,source:product.source,invested:0n,equivalent:0n};
    entry.invested+=invested;entry.equivalent+=equivalent;products.set(key,entry);
  }
  const policyHash=createHash('sha256').update(JSON.stringify({actualMethodId:actual.methodId,actualPolicyHash:actual.policyHash,leveragePolicy})).digest('hex');
  const age=(day(cutoff)-day(previous?.cutoff))/86400000;
  const comparable=previous?.methodId===METHOD&&previous.policyHash===policyHash&&age>=7&&age<=14;
  const groups=actual.groups.map(g=>({key:g.key,label:g.label,marketValueCents:cents(totals.get(g.key)),percent:percent(totals.get(g.key),nav*10000n),changePp:comparable&&Number.isFinite(previous.primaryEquivalent?.groups?.find(p=>p.key===g.key)?.percent)?Math.round((percent(totals.get(g.key),nav*10000n)-previous.primaryEquivalent.groups.find(p=>p.key===g.key).percent)*100)/100:null}));
  const extraCents=cents(extra),gross=nav+BigInt(extraCents);
  return {schema:'weekly-ai-dual-exposure.v1',methodId:METHOD,policyHash,cutoff,denominatorCents:actual.denominatorCents,
    comparisonDate:comparable?previous.cutoff:null,
    primaryEquivalent:{measure:'reviewed-daily-target-equivalent',groups,grossEquivalentCents:String(gross),extraExposureCents:extraCents,displayRoundingResidualCents:String(gross-integer(actual.cash.marketValueCents)-groups.reduce((s,g)=>s+integer(g.marketValueCents),0n))},
    actualAllocation:{methodId:actual.methodId,policyHash:actual.policyHash,groups:actual.groups,cash:actual.cash,denominatorCents:actual.denominatorCents},
    leveragedProducts:[...products.values()].map(({invested,equivalent,...p})=>({...p,investedCents:cents(invested),equivalentCents:cents(equivalent)})),
    historicalNote:'旧报告保留实际配置口径；新等效口径只与同版本、同分类规则的先前周报比较，不倒算旧结果。'};
}
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=v=>'$'+(Number(v)/100).toLocaleString('en-US',{maximumFractionDigits:0});
export function renderAiDualExposure(actual,dual){
  const cards=dual.primaryEquivalent.groups.filter(g=>['infrastructure','platform'].includes(g.key)).map(g=>{const a=actual.groups.find(a=>a.key===g.key);return `<div class="ai-category"><h3>${esc(g.label)}</h3><div class="big">${g.percent.toFixed(2)}%</div><p>每日目标等效敞口 ${usd(g.marketValueCents)}<br>实际配置对照 ${a.percent.toFixed(2)}% · ${usd(a.marketValueCents)}</p><p class="muted">${g.changePp===null?'本期不显示周变化：尚无同口径可比结果':`较可比前周 ${g.changePp>=0?'+':''}${g.changePp.toFixed(2)} 个百分点`}</p></div>`;}).join('');
  const products=dual.leveragedProducts.map(p=>`<p>${esc(p.symbol)} → ${esc(p.underlying)} · 每日目标 ${(p.multiplierBp/10000).toFixed(1)}×：投资市值 ${usd(p.investedCents)}，等效敞口 ${usd(p.equivalentCents)}。</p>`).join('');
  return `<h2>AI 相关等效敞口</h2><p class="muted">风险 ${esc(dual.cutoff)} · 三账户含现金净值 ${usd(dual.denominatorCents)}</p>${cards}${products}<p class="muted">主要指标将已核实的杠杆产品按底层公司和每日目标倍数计入；净值分母不变，直接股票和 ETF 成分各计一次。实际配置仍按投资市值。等效敞口可以超过净值，不截断、不归一化；这是每日目标近似，不保证多日收益按同一倍数变化，也不是纯 AI 收入比例或预计亏损。</p><p class="ai-coverage">待确认／待穿透金额继续保留，不因本期未逐项审阅而归零。${esc(dual.historicalNote)}</p><details><summary>实际配置与成分核验说明</summary>${renderAiExposure(actual).replace("杠杆倍数仅用于单票等效敞口，避免混淆净值配置与风险敞口。", "该实际配置对照保持 1× 市值；主要等效风险指标另按已核实的每日目标倍数计算。")}</details>`;
}
