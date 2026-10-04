// Weekly-only observation: market-value allocation, never a loss model.
// Reuses verified source identities but no legacy AI tiers or coefficients.
import fs from 'node:fs';
import {resolveLeveragedProduct,LEVERAGED_POLICY} from './xuan-weekly-leveraged-products.mjs';
import {createHash} from 'node:crypto';
export const DEFAULT_POLICY=JSON.parse(fs.readFileSync(new URL('../claude/xuan-weekly-ai-exposure-v1.json',import.meta.url),'utf8'));
const day=d=>/^\d{4}-\d{2}-\d{2}$/.test(d)?Date.parse(d+'T00:00:00Z'):NaN;
const integer=(v,label)=>{if(!/^\d+$/.test(String(v)))throw Error('ai_exposure_invalid_'+label);return BigInt(v);};
const percent=(value,total)=>Number((value*10000n+total/2n)/total)/100;
const cents=micro=>String((micro+5000n)/10000n);
const labels={infrastructure:'AI 投资周期敏感',platform:'综合平台与应用',other:'其他已复核',pending:'待确认',etfUncovered:'ETF 待穿透／待分类'};
export function buildAiExposure(envelope,{cutoff,policy=DEFAULT_POLICY,previous=null}={}){
  if(!Number.isFinite(day(cutoff))||!Number.isFinite(day(policy.reviewedOn))||!Number.isFinite(day(policy.reviewBy))||policy.reviewedOn>policy.reviewBy)throw Error('ai_exposure_date_invalid');
  // Review dates are administrative, not price dates (Sunday review can use Friday values).
  const policyHash=createHash('sha256').update(JSON.stringify({policy,leverage:LEVERAGED_POLICY})).digest('hex');
  const defs=new Map();
  for(const s of policy.stocks){
    if(defs.has(s.id)||!['infrastructure','platform','other'].includes(s.group)||!s.source||!s.symbols?.length||(s.assetTypes&&(!s.assetTypes.length||s.group!=='other'||s.assetTypes.some(t=>!['ETF','COMMODITY'].includes(t)))))throw Error('ai_exposure_policy_invalid');
    defs.set(s.id,s);
  }
  // These keys belong only to reviewed fund constituents, not live broker identities.
  const underlying=new Map();
  for(const s of policy.underlyingIssuers||[]){
    if(!s.key||underlying.has(s.key)||!['infrastructure','platform','other'].includes(s.group)||!/^https:\/\//.test(s.source)||!s.issuer)throw Error('ai_exposure_underlying_invalid');
    underlying.set(s.key,s);
  }
  const scoped=new Map();
  for(const s of policy.directHoldings||[]){
    const key=s.portfolioId+':'+s.holdingId;
    if(!/^\d+:\d+$/.test(key)||scoped.has(key)||s.assetType!=='STK'||!s.symbol||!['infrastructure','platform','other'].includes(s.group)||!/^https:\/\//.test(s.source)||!s.issuer)throw Error('ai_exposure_direct_scope_invalid');
    scoped.set(key,s);
  }
  const components=envelope.riskDenominator.components;
  if(new Set(components.map(c=>c.key)).size!==3||components.length!==3)throw Error('ai_exposure_accounts_invalid');
  const base=components.reduce((sum,c)=>sum+integer(c.valueMicro,'denominator'),0n);
  if(base<=0n)throw Error('ai_exposure_denominator_invalid');
  const totals=Object.fromEntries(Object.keys(labels).map(k=>[k,0n]));
  const contributors=new Map(),rows=[],seen=new Set();let holdingTotal=0n;
  const reviewed=cutoff<=policy.reviewBy;
  const classify=(id,symbol,type='STK')=>{const s=defs.get(String(id));return reviewed&&s?.symbols.includes(symbol)&&(s.assetTypes||['STK']).includes(type)?s:null;};
  const add=(group,micro,label,via)=>{
    totals[group]+=micro;
    if(['infrastructure','platform'].includes(group)){
      const key=group+':'+label,entry=contributors.get(key)||{group,label,micro:0n,via:new Set()};
      entry.micro+=micro;entry.via.add(via);contributors.set(key,entry);
    }
  };
  const snapshots=new Map();
  for(const s of policy.etfSnapshots||[]){
    if(snapshots.has(String(s.instrumentId)))throw Error('ai_exposure_duplicate_etf');
    snapshots.set(String(s.instrumentId),s);
  }
  for(const r of envelope.riskConstituents){
    const key=r.portfolioId+':'+r.instrumentId;
    if(seen.has(key)||r.identityVerified!==true||r.valueDate!==cutoff)throw Error('ai_exposure_source_invalid');
    seen.add(key);const micro=integer(r.marketValueMicro,'holding');holdingTotal+=micro;
    const scopedStock=scoped.get(r.portfolioId+':'+r.holdingId);
    const leveraged=resolveLeveragedProduct(r,{cutoff});
    const s=classify(r.instrumentId,r.symbol,r.assetType)||(reviewed&&scopedStock?.symbol===r.symbol&&scopedStock.assetType===r.assetType?scopedStock:null)||(leveraged?classify(leveraged.underlyingInstrumentId,leveraged.underlying):null);
    let recordedBp=0,unclassifiedBp=0;
    let group=s?.group||'pending',uncovered=s?0n:micro,etfAsOf=null,coveredBp=0;
    // Verified Treasury / physical commodity mandates are not equity look-through.
    if(r.assetType==='ETF'&&!s){
      group='etfUncovered';const snapshot=snapshots.get(String(r.instrumentId));
      const age=snapshot?(day(cutoff)-day(snapshot.asOf))/86400000:NaN;
      if(reviewed&&snapshot?.symbol===r.symbol&&snapshot.fundName&&['physical-holdings','economic-exposure'].includes(snapshot.basis)&&Number.isFinite(age)&&age>=0&&age<=100&&/^https:\/\//.test(snapshot.source)){
        etfAsOf=snapshot.asOf;
        let weight=0,allocated=0n;const constituentIds=new Set();
        for(const p of snapshot.holdings){
          const identity=p.issuerKey?'issuer:'+p.issuerKey:'stock:'+p.instrumentId;
          if((p.issuerKey&&p.instrumentId)||(!p.issuerKey&&!p.instrumentId)||!Number.isSafeInteger(p.weightBp)||p.weightBp<0||p.weightBp>10000||constituentIds.has(identity))throw Error('ai_exposure_etf_weights_invalid');
          constituentIds.add(identity);weight+=p.weightBp;
          if(weight>10000)throw Error('ai_exposure_etf_weights_invalid');
          const stock=p.issuerKey?underlying.get(p.issuerKey):classify(p.instrumentId,p.symbol);
          if(!stock){unclassifiedBp+=p.weightBp;continue;} // Unknown composition stays visibly uncovered.
          coveredBp+=p.weightBp;
          const part=micro*BigInt(p.weightBp)/10000n;allocated+=part;
          add(stock.group,part,stock.issuer,r.symbol);
        }
        recordedBp=weight;uncovered=micro-allocated;add('etfUncovered',uncovered,r.symbol,r.symbol);
      }else add(group,micro,r.symbol,r.symbol);
    }else add(group,micro,s?.issuer||r.symbol,r.custodian);
    rows.push({symbol:r.symbol,custodian:r.custodian,assetType:r.assetType,group,marketValueCents:cents(micro),uncoveredCents:cents(uncovered),etfAsOf,coveredBp,recordedBp,unclassifiedBp,unrecordedBp:etfAsOf?10000-recordedBp:null,coverageReason:s?null:r.assetType!=='ETF'?'尚缺唯一标的业务分类证据':etfAsOf?'仅覆盖有日期资料中的已复核成分':'尚缺可用的发行方成分快照'});
  }
  if(holdingTotal>base)throw Error('ai_exposure_holdings_exceed_nav');
  const serialize=(micro)=>({marketValueCents:cents(micro),percent:percent(micro,base)});
  const comparable=previous?.methodId===policy.methodId&&previous.policyHash===policyHash
    &&Number.isFinite(day(previous.cutoff))&&(day(cutoff)-day(previous.cutoff))/86400000>=7
    &&(day(cutoff)-day(previous.cutoff))/86400000<=14;
  const ranked=[...contributors.values()].sort((a,b)=>a.micro===b.micro?a.label.localeCompare(b.label):a.micro>b.micro?-1:1);
  return {methodId:policy.methodId,policyHash,cutoff,reviewedOn:policy.reviewedOn,reviewBy:policy.reviewBy,reviewOverdue:!reviewed,
    denominatorCents:cents(base),cash:serialize(base-holdingTotal),
    groups:Object.entries(totals).map(([key,micro])=>({key,label:labels[key],...serialize(micro),
      changePp:comparable&&Number.isFinite(previous.groups?.find(g=>g.key===key)?.percent)?
        Math.round((percent(micro,base)-previous.groups.find(g=>g.key===key).percent)*100)/100:null})),
    contributors:ranked.map(c=>({group:c.group,label:c.label,via:[...c.via].sort(),...serialize(c.micro)})),
    comparisonDate:comparable?previous.cutoff:null,rows,
    coverageComplete:totals.pending===0n&&totals.etfUncovered===0n};
}
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=c=>'$'+(Number(c)/100).toLocaleString('en-US',{maximumFractionDigits:0});
export function renderAiExposure(ai){
  const line=r=>`<div class="line"><span>${esc(r.label)}<br><small>${esc(r.via?.join(' · ')||'')}</small></span><b>${r.percent.toFixed(2)}%<br><small>${usd(r.marketValueCents)}</small></b></div>`;
  const cards=ai.groups.filter(g=>['infrastructure','platform'].includes(g.key)).map(g=>{
    const list=ai.contributors.filter(r=>r.group===g.key);
    const delta=g.changePp===null?'首期／暂无同口径周对比':`较 ${esc(ai.comparisonDate)} ${g.changePp>0?'+':''}${g.changePp.toFixed(2)} 个百分点`;
    return `<div class="ai-category"><h3>${esc(g.label)}</h3><div class="big">${g.percent.toFixed(2)}%</div><p>${usd(g.marketValueCents)} <small>· ${delta}</small></p>${list.slice(0,3).map(line).join('')}${list.length>3?`<details><summary>其余 ${list.length-3} 项</summary>${list.slice(3).map(line).join('')}</details>`:''}</div>`;
  }).join('');
  const coverage=ai.groups.filter(g=>['pending','etfUncovered'].includes(g.key));
  return `<h2>AI 相关集中度</h2><p class="muted">已确认部分 · 三账户含现金 $${(Number(ai.denominatorCents)/100).toLocaleString('en-US',{maximumFractionDigits:0})}<br>相关公司持仓占比，不是纯 AI 收入比例或预计亏损。</p>${cards}
    <p class="ai-coverage">${coverage.map(g=>`${esc(g.label)} ${g.percent.toFixed(2)}% · ${usd(g.marketValueCents)}`).join('<br>')}${ai.coverageComplete?'':'<br>以上两类不是全部 AI 敞口；未覆盖不等于零风险。'}</p>
    <details><summary>分类与覆盖说明${ai.reviewOverdue?' · 分类待复核':''}</summary><p>按已核实业务分类，直接股票使用完整市值，不乘主观系数。已核实单股杠杆产品按底层业务分类，但此处只分配实际投资市值；杠杆倍数仅用于单票等效敞口，避免混淆净值配置与风险敞口。综合平台不代表低风险。基金名称、主题或行业类别不能代替逐项成分与权重证据，也不自动归为 100% AI。ETF 按本期市值 × 发行商已披露权重估算；剩余部分单列，不把前十大持仓放大到 100%，不重复加总 ETF 与成分。合成 ETF 使用指数经济敞口，不使用抵押品。现金留在分母，新增现金也可能降低比例。</p><p>国债、实物贵金属及加密资产产品不计入这两类 AI 股票集中度；这不表示没有利率、商品或市场风险。每周更新持仓金额；成分权重是有日期的已核验快照，不是实时权重，超过 100 天自动退回待确认。分类每三个月及新增标的时复核。分类 ${esc(ai.reviewedOn)}，下次复核 ${esc(ai.reviewBy)}。口径变更不与旧结果硬比；没有损失阈值或自动买卖提醒。</p>
    ${ai.rows.filter(r=>r.etfAsOf).length?`<h3>ETF 已核实范围</h3><p class="muted">已记录待分类：本次已有明确成分及权重，尚未完成业务分类。本次快照未纳入：当前计算没有逐项纳入该部分；不表示发行人从不提供完整文件。</p>${ai.rows.filter(r=>r.etfAsOf).map(r=>`<div class="line"><span>${esc(r.symbol)}<br><small>成分 ${esc(r.etfAsOf)} · 已记录 ${(r.recordedBp/100).toFixed(2)}% · 已记录待分类 ${(r.unclassifiedBp/100).toFixed(2)}% · 本次快照未纳入 ${(r.unrecordedBp/100).toFixed(2)}%</small></span><b>${(r.coveredBp/100).toFixed(2)}%<br><small>该基金已分类部分</small></b></div>`).join('')}`:''}
    ${ai.rows.some(r=>r.symbol==='IVAI'&&r.etfAsOf==='2026-08-31'&&r.recordedBp===3152)?'<p class="muted">IVAI 当前仅纳入 2026-08-31 前十项 31.52%；剩余 68.48% 的同日完整成分及权重尚未在本流程取得并核对，不能视为已经穿透。</p>':''}
    ${coverage.map(g=>`<h3>${esc(g.label)}</h3>${ai.rows.filter(r=>r.group===g.key&&BigInt(r.uncoveredCents)>0n).map(r=>`<div class="line"><span>${esc(r.symbol)} <small>${esc(r.custodian)} · ${esc(r.coverageReason||'')}</small></span><b>${usd(r.uncoveredCents)}</b></div>`).join('')||'<p>无</p>'}`).join('')}<p class="muted">来源：Sharesight 已记录数据。分类证据与计算规则随代码保留；账户原始资料不公开。</p></details>`;
}
