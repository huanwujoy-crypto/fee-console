// Offline weekly observation. Inputs remain only in the existing private bundle.
import {fingerprint} from './xuan-ib-run-manifest.mjs';
import {buildAiExposure,renderAiExposure,riskAccountScopeFingerprint} from './xuan-weekly-ai-exposure.mjs';
import {renderAiReviewPriority} from './xuan-weekly-ai-review-priority.mjs';
const pct=(a,k)=>a.groups.find(g=>g.key===k).percent;
const bounds=a=>{const lower=pct(a,'infrastructure')+pct(a,'platform');const unknown=pct(a,'pending')+pct(a,'etfUncovered'),complex=a.rows.filter(r=>r.complexUnknown).reduce((s,r)=>s+Number(r.uncoveredCents),0)/Number(a.denominatorCents)*100;const rangeApplicable=!a.rows.some(r=>r.complexUnknown);return {lower,upper:rangeApplicable?lower+unknown-complex:null,unknown,complex,rangeApplicable};};
export function comparisonInputs(envelope,cutoff){
 const components=envelope.riskDenominator.components.map(c=>({key:c.key,valueMicro:c.valueMicro}));
 const rows=envelope.riskConstituents.map(r=>Object.fromEntries(['portfolioId','holdingId','instrumentId','symbol','assetType','custodian','identityVerified','valueDate','marketValueMicro'].map(k=>[k,r[k]])));
 const provenance=(envelope.provenance||[]).map(p=>({key:p.key,portfolioId:p.portfolioId,custodian:p.custodian}));
 return {schema:'weekly-risk-comparison-inputs.v1',cutoff,accountScopeFingerprint:riskAccountScopeFingerprint(envelope),provenance,riskDenominator:{components},riskConstituents:rows};
}
export function buildRiskObservation(envelope,{cutoff,policy,actual,previous=null,previousInputs=null}={}){
 const current=bounds(actual);let comparison=null;
 const age=(Date.parse(cutoff)-Date.parse(previousInputs?.cutoff))/86400000;
 if(previous&&previousInputs?.schema==='weekly-risk-comparison-inputs.v1'&&previous.cutoff===previousInputs.cutoff&&age>=7&&age<=14){
  try{
   const scope=riskAccountScopeFingerprint(previousInputs);
   if(fingerprint(previousInputs)!==previous.comparisonInputFingerprint)throw Error('comparison_fingerprint_invalid');
   if(scope!==actual.accountScopeFingerprint||scope!==previousInputs.accountScopeFingerprint||scope!==previous.accountScopeFingerprint)throw Error('comparison_scope_invalid');
   const rows=previousInputs.riskConstituents,accounts=previousInputs.provenance,components=previousInputs.riskDenominator.components;
   if(!Array.isArray(accounts)||accounts.length!==3||components.length!==3||new Set(components.map(c=>c.key)).size!==3||new Set(accounts.map(p=>String(p.portfolioId))).size!==3||new Set(accounts.map(p=>p.key)).size!==3)throw Error('comparison_account_mapping_invalid');
   const byPortfolio=new Map();
   for(const p of accounts){if(!p.key||!p.portfolioId||!p.custodian||!components.some(c=>c.key===p.key))throw Error('comparison_account_mapping_invalid');byPortfolio.set(String(p.portfolioId),p);}
   const holdingKeys=new Set();
   for(const r of rows){const account=byPortfolio.get(String(r.portfolioId)),key=String(r.portfolioId)+':'+String(r.holdingId);if(!account||account.custodian!==r.custodian||holdingKeys.has(key))throw Error('comparison_holding_account_invalid');holdingKeys.add(key);}

   if(rows.some(r=>r.valueDate!==previousInputs.cutoff||r.identityVerified!==true||!r.portfolioId||!r.holdingId||!r.instrumentId||!r.symbol||!r.assetType||!r.custodian))throw Error('comparison_identity_invalid');
   // Replay with the current evaluation cutoff, freezing TTL/review/mapping for both sides.
   const replay={provenance:previousInputs.provenance,riskDenominator:previousInputs.riskDenominator,riskConstituents:rows.map(r=>({...r,valueDate:cutoff}))};
   const bridged=buildAiExposure(replay,{cutoff,policy});
   const old=bounds(previous),base=bounds(bridged);
   if(!current.rangeApplicable||!base.rangeApplicable)throw Error('comparison_complex_unknown');
   if(previous.methodVersion!==actual.methodVersion||previous.methodId!==actual.methodId)throw Error('comparison_method_invalid');
   // The calculator exports exact weight coefficients from its verified effective mask.
   // Aggregate stable securities across accounts before taking uncertainty bounds.
   const weights=(e,a)=>{
    const result=new Map();
    for(const [i,r] of e.riskConstituents.entries()){
     const row=a.rows[i],key=String(r.instrumentId)+':'+r.symbol+':'+r.assetType;
     const coefficients=[row.allocationCoefficientLower,row.allocationCoefficientUpper];
     if(coefficients.some(c=>!Number.isFinite(c)||c<0||c>1)||coefficients[0]>coefficients[1])throw Error('comparison_coefficients_invalid');
     const entry=result.get(key)||{valueMicro:0n,coefficients};
     if(entry.coefficients.some((c,j)=>c!==coefficients[j]))throw Error('comparison_security_coefficients_conflict');
     entry.valueMicro+=BigInt(r.marketValueMicro);result.set(key,entry);
    }
    return result;
   };
   const now=weights(envelope,actual),before=weights(replay,bridged),currentNav=envelope.riskDenominator.components.reduce((s,c)=>s+BigInt(c.valueMicro),0n),previousNav=replay.riskDenominator.components.reduce((s,c)=>s+BigInt(c.valueMicro),0n);let loNumerator=0n,hiNumerator=0n;
   const denominator=currentNav*previousNav*100000000n;
   for(const key of new Set([...now.keys(),...before.keys()])){
    const n=now.get(key),p=before.get(key),c=n?.coefficients||p.coefficients;
    if(n&&p&&n.coefficients.some((v,j)=>v!==p.coefficients[j]))throw Error('comparison_security_coefficients_conflict');
    const delta=(n?.valueMicro||0n)*previousNav-(p?.valueMicro||0n)*currentNav,l=delta*BigInt(Math.round(c[0]*100000000)),u=delta*BigInt(Math.round(c[1]*100000000));loNumerator+=l<u?l:u;hiNumerator+=l>u?l:u;
   }
   const pp=n=>Number(n*1000000000000n/denominator)/10000000000,lo=pp(loNumerator),hi=pp(hiNumerator);
   comparison={date:previous.cutoff,lowerChangePp:lo,upperChangePp:hi,identifiedChangePp:current.lower-base.lower,sourceImpactPp:base.lower-old.lower,observedChangePp:current.lower-old.lower,significant:loNumerator*100n>=denominator*2n||hiNumerator*100n<=-denominator*2n,small:loNumerator*100n>-denominator*2n&&hiNumerator*100n<denominator*2n};
  }catch{comparison=null;}
 }
 return {methodVersion:actual.methodVersion,cutoff,...current,comparison,status:comparison?(comparison.small?'同口径变化较小':comparison.lowerChangePp>0?'同口径占比上升':comparison.upperChangePp<0?'同口径占比下降':'变化方向尚不明确'):'本周已更新 · 建立新的可比段'};
}
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const signed=v=>(v>=0?'+':'')+v.toFixed(2);
export function renderRiskObservation(o,actual,dual,priority){
 const products=dual.knownLeverageProducts||dual.leveragedProducts;
 const invested=products.reduce((s,p)=>s+Number(p.investedCents),0)/Number(actual.denominatorCents)*100,equivalent=products.reduce((s,p)=>s+Number(p.equivalentCents),0)/Number(actual.denominatorCents)*100;
 const overlays=actual.rows.filter(r=>r.economicUnclassifiedOverlay);
 const trend=o.comparison?`按本期资料重算的可比周变化 ${signed(o.comparison.lowerChangePp)} 至 ${signed(o.comparison.upperChangePp)} 个百分点；资料更新影响已识别占比 ${signed(o.comparison.sourceImpactPp)} 个百分点。${o.comparison.significant?'可比变化达到 2 个百分点，重点观察。':o.comparison.small?'':'变化范围尚不能归为小幅。'}`:'尚无足够的前周比较输入；资料或有效覆盖改变不解释成风险下降。';
 return `<h2>风险观察</h2><p>${esc(o.status)}</p>
 ${priority.exceptions.length?`<p class="ai-coverage">注意：${priority.exceptions.length} 项工具存在未知结构或杠杆映射；不适用小额豁免，潜在敞口仍待核实。市值不能界定潜在损失，空头或卖出期权可能损失超过投入，部分结构可能没有损失上限。</p>`:''}
 <div class="ai-category"><h3>AI／平台关联实际配置 · 估算范围</h3>
 <div class="big">${o.rangeApplicable&&o.unknown<5?`约 ${o.lower.toFixed(1)}%–${o.upper.toFixed(1)}%`:`已识别约 ${o.lower.toFixed(1)}%`}</div>
 <p>已识别约 ${o.lower.toFixed(1)}%；未细分约 ${o.unknown.toFixed(1)}%。${o.rangeApplicable?'普通多头配置估算范围。':`其中未知结构投入 ${o.complex.toFixed(2)}% 单列；市值不能界定潜在敞口，无法给出全组合上界。`}</p>
 ${priority.unknownPoolObservation?`<p class="ai-coverage">未细分池达到 5% NAV，保留整体观察。其中未取得成分 ${priority.unobtainedComposition.percent.toFixed(2)}%；小额已记录但未分类 ${priority.smallUnreviewed.percent.toFixed(2)}%。两者均为未知，不能推断没有风险。</p>`:''}
 <p>${trend}</p><small>相关公司配置，不是纯 AI 收入或预计亏损。占比变化包含现金、市值和汇率影响。</small></div>
 ${overlays.length?`<p class="ai-coverage">基金资料另有 ${overlays.length} 项指数期货名义敞口观察，未纳入上述市值配置范围。本期持有、滚动与业务穿透尚未核实；期货市值为零或负数不表示零风险。来源日期和条件性估算见下方资料。</p>`:''}
 <h3>现金与已知杠杆</h3><p>账面现金 ${actual.cash.percent.toFixed(2)}%；杠杆产品投入 ${invested.toFixed(2)}%；每日目标等效 ${equivalent.toFixed(2)}%。</p>
 <small>每日目标倍数不保证多日收益按同倍数变化。账面现金不等于购买力；这里不是账户总杠杆，也不是亏损上限。未知结构仍保留。</small>
 <p class="muted">持仓 ${esc(o.cutoff)} · 三账户同轮含现金 NAV。部分使用有日期的基金资料，未细分不是零风险。</p>
 ${renderAiReviewPriority(priority)}<details><summary>估算方法、资料日期与有效覆盖</summary>
 ${o.rangeApplicable?`<p>普通多头配置精确显示范围 ${o.lower.toFixed(2)}%–${o.upper.toFixed(2)}%；仍为有日期资料估算，不含另列期货名义敞口，不是潜在亏损上限。</p>`:''}
 ${renderAiExposure(actual,{compactUnverified:true})}</details>`;
}
