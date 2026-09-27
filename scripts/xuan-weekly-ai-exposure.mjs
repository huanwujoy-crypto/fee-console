// Weekly-only observation: market-value allocation, never a loss model.
// Reuses verified source identities but no legacy AI tiers or coefficients.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
export const DEFAULT_POLICY=JSON.parse(fs.readFileSync(new URL('../claude/xuan-weekly-ai-exposure-v1.json',import.meta.url),'utf8'));
const day=d=>/^\d{4}-\d{2}-\d{2}$/.test(d)?Date.parse(d+'T00:00:00Z'):NaN;
const integer=(v,label)=>{if(!/^\d+$/.test(String(v)))throw Error('ai_exposure_invalid_'+label);return BigInt(v);};
const percent=(value,total)=>Number((value*10000n+total/2n)/total)/100;
const cents=micro=>String((micro+5000n)/10000n);
const labels={infrastructure:'AI 投资周期敏感',platform:'综合平台与应用',other:'其他已复核',pending:'待确认',etfUncovered:'ETF 未穿透'};
export function buildAiExposure(envelope,{cutoff,policy=DEFAULT_POLICY,previous=null}={}){
  if(!Number.isFinite(day(cutoff))||!Number.isFinite(day(policy.reviewedOn))||!Number.isFinite(day(policy.reviewBy))||policy.reviewedOn>policy.reviewBy)throw Error('ai_exposure_date_invalid');
  // Review dates are administrative, not price dates (Sunday review can use Friday values).
  const policyHash=createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  const defs=new Map();
  for(const s of policy.stocks){
    if(defs.has(s.id)||!['infrastructure','platform','other'].includes(s.group)||!s.source||!s.symbols?.length)throw Error('ai_exposure_policy_invalid');
    defs.set(s.id,s);
  }
  const components=envelope.riskDenominator.components;
  if(new Set(components.map(c=>c.key)).size!==3||components.length!==3)throw Error('ai_exposure_accounts_invalid');
  const base=components.reduce((sum,c)=>sum+integer(c.valueMicro,'denominator'),0n);
  if(base<=0n)throw Error('ai_exposure_denominator_invalid');
  const totals=Object.fromEntries(Object.keys(labels).map(k=>[k,0n]));
  const contributors=new Map(),rows=[],seen=new Set();let holdingTotal=0n;
  const reviewed=cutoff<=policy.reviewBy;
  const classify=(id,symbol)=>{const s=defs.get(String(id));return reviewed&&s?.symbols.includes(symbol)?s:null;};
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
    const s=r.assetType==='STK'?classify(r.instrumentId,r.symbol):null;
    let group=s?.group||'pending',uncovered=micro;
    if(r.assetType==='ETF'){
      group='etfUncovered';const snapshot=snapshots.get(String(r.instrumentId));
      const age=snapshot?(day(cutoff)-day(snapshot.asOf))/86400000:NaN;
      if(reviewed&&snapshot&&Number.isFinite(age)&&age>=0&&age<=100&&/^https:\/\//.test(snapshot.source)){
        let weight=0,allocated=0n;const constituentIds=new Set();
        for(const p of snapshot.holdings){
          if(!Number.isSafeInteger(p.weightBp)||p.weightBp<0||p.weightBp>10000||constituentIds.has(String(p.instrumentId)))throw Error('ai_exposure_etf_weights_invalid');
          constituentIds.add(String(p.instrumentId));weight+=p.weightBp;
          if(weight>10000)throw Error('ai_exposure_etf_weights_invalid');
          const stock=classify(p.instrumentId,p.symbol);
          if(!stock)continue; // Unknown composition stays visibly uncovered.
          const part=micro*BigInt(p.weightBp)/10000n;allocated+=part;
          add(stock.group,part,stock.issuer,r.symbol);
        }
        uncovered=micro-allocated;add('etfUncovered',uncovered,r.symbol,r.symbol);
      }else add(group,micro,r.symbol,r.symbol);
    }else add(group,micro,s?.issuer||r.symbol,r.custodian);
    rows.push({symbol:r.symbol,custodian:r.custodian,assetType:r.assetType,group,marketValueCents:cents(micro),uncoveredCents:cents(uncovered)});
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
    <details><summary>分类与覆盖说明${ai.reviewOverdue?' · 分类待复核':''}</summary><p>按已核实业务分类，直接股票使用完整市值，不乘主观系数。综合平台不代表低风险。ETF 仅计有日期和来源的成分；未穿透部分单列，不重复加总 ETF 与成分。现金留在分母，新增现金也可能降低比例。</p><p>每周更新金额；每三个月及新增标的时复核。分类 ${esc(ai.reviewedOn)}，下次复核 ${esc(ai.reviewBy)}。新方法首期不与旧“AI 压力”比较；没有损失阈值或自动买卖提醒。</p>
    ${coverage.map(g=>`<h3>${esc(g.label)}</h3>${ai.rows.filter(r=>r.group===g.key&&BigInt(r.uncoveredCents)>0n).map(r=>`<div class="line"><span>${esc(r.symbol)} <small>${esc(r.custodian)}</small></span><b>${usd(r.uncoveredCents)}</b></div>`).join('')||'<p>无</p>'}`).join('')}<p class="muted">来源：Sharesight 已记录数据。分类证据与计算规则随代码保留；账户原始资料不公开。</p></details>`;
}
