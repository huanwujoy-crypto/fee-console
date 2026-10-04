// Weekly-only issuer concentration. The ETF itself is never added to its constituents.
import fs from 'node:fs';
import {resolveLeveragedProduct} from './xuan-weekly-leveraged-products.mjs';

export const DEFAULT_TOP10_POLICY=JSON.parse(fs.readFileSync(new URL('../claude/xuan-weekly-concentration-top10-v1.json',import.meta.url),'utf8'));
const dateMs=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')?Date.parse(value+'T00:00:00Z'):NaN;
const integer=(value,label)=>{if(!/^\d+$/.test(String(value)))throw Error('weekly_concentration_invalid_'+label);return BigInt(value);};
const cents=micro=>String((micro+5000n)/10000n);
const percent=(value,total)=>Number((value*10000n+total/2n)/total)/100;

export function buildWeeklyConcentration(envelope,{cutoff,policy=DEFAULT_TOP10_POLICY}={}){
  if(!Number.isFinite(dateMs(cutoff))||!Number.isSafeInteger(policy.maxSnapshotAgeDays)||policy.maxSnapshotAgeDays<1)throw Error('weekly_concentration_date_invalid');
  const components=envelope.riskDenominator?.components;
  if(!Array.isArray(components)||components.length!==3||new Set(components.map(c=>c.key)).size!==3)throw Error('weekly_concentration_accounts_invalid');
  const denominator=components.reduce((sum,c)=>sum+integer(c.valueMicro,'denominator'),0n);
  if(denominator<=0n)throw Error('weekly_concentration_denominator_invalid');
  const funds=new Map();
  for(const fund of policy.funds){
    const id=String(fund.instrumentId);
    if(funds.has(id)||!fund.symbol||!/^https:\/\//.test(fund.source)||!['physical-holdings','economic-exposure'].includes(fund.basis)||!Array.isArray(fund.topTen)||fund.topTen.length!==10)throw Error('weekly_concentration_fund_invalid');
    let sum=0,previous=10001;
    for(const [issuer,weight] of fund.topTen){
      if(!issuer||!Number.isSafeInteger(weight)||weight<0||weight>previous)throw Error('weekly_concentration_topten_invalid');
      sum+=weight;previous=weight;
    }
    if(sum>10000)throw Error('weekly_concentration_topten_invalid');
    const topTenIssuers=new Set(fund.topTen.map(([issuer])=>issuer));
    const extraIssuers=new Set();
    for(const [issuer,weight] of fund.directIssuerMatches||[]){
      if(!issuer||!Number.isSafeInteger(weight)||weight<0||topTenIssuers.has(issuer)||extraIssuers.has(issuer))throw Error('weekly_concentration_direct_match_invalid');
      extraIssuers.add(issuer);sum+=weight;
    }
    if(sum>10000)throw Error('weekly_concentration_direct_match_invalid');
    funds.set(id,fund);
  }
  const excluded=new Set(policy.nonEquityEtfIds.map(String));
  if([...excluded].some(id=>funds.has(id)))throw Error('weekly_concentration_fund_exclusion_conflict');
  const issuers=new Map(),missingFunds=new Map(),usedFunds=new Map(),seen=new Set();
  const directCandidates=new Set(),topTenCandidates=new Set(),etfRows=[];
  const add=(issuer,micro,part)=>{
    const item=issuers.get(issuer)||{issuer,direct:0n,indirect:0n,leveraged:0n,leveragedInvestment:0n,parts:[]};
    item[part.kind==='direct'?'direct':part.kind==='leveraged'?'leveraged':'indirect']+=micro;
    if(part.kind==='leveraged')item.leveragedInvestment+=part.investmentMicro;
    item.parts.push({...part,micro});issuers.set(issuer,item);
  };
  for(const r of envelope.riskConstituents){
    const identity=r.portfolioId+':'+r.instrumentId;
    if(seen.has(identity)||r.identityVerified!==true||r.valueDate!==cutoff)throw Error('weekly_concentration_source_invalid');
    seen.add(identity);
    const marketValue=integer(r.marketValueMicro,'holding');
    const leveraged=resolveLeveragedProduct(r,{cutoff});
    if(leveraged){
      const issuer=policy.directAliases[leveraged.underlying]||leveraged.underlying;
      directCandidates.add(issuer);
      add(issuer,marketValue*BigInt(leveraged.dailyMultiplierBp)/10000n,{kind:'leveraged',symbol:r.symbol,custodian:r.custodian,investmentMicro:marketValue,multiplierBp:leveraged.dailyMultiplierBp,source:leveraged.source});
      continue;
    }
    if(r.assetType==='STK'){
      const symbol=String(r.symbol||'').toUpperCase();
      if(!symbol)throw Error('weekly_concentration_stock_identity_invalid');
      const issuer=policy.directAliases[symbol]||symbol;
      directCandidates.add(issuer);
      add(issuer,marketValue,{kind:'direct',symbol,custodian:r.custodian});
      continue;
    }
    if(r.assetType==='ETF'&&!excluded.has(String(r.instrumentId)))etfRows.push([r,marketValue]);
  }
  for(const [r,marketValue] of etfRows){
    const fund=funds.get(String(r.instrumentId));
    const age=fund?(dateMs(cutoff)-dateMs(fund.asOf))/86400000:NaN;
    if(!fund||fund.symbol!==r.symbol||!Number.isFinite(age)||age<0||age>policy.maxSnapshotAgeDays){
      const key=String(r.instrumentId)+':'+r.symbol;
      const entry=missingFunds.get(key)||{symbol:r.symbol,reason:fund?'前十资料过期或身份不符':'未取得前十资料',marketValueMicro:0n};
      entry.marketValueMicro+=marketValue;missingFunds.set(key,entry);
      continue;
    }
    usedFunds.set(String(r.instrumentId),fund);
    for(const [issuer,weightBp] of fund.topTen){
      topTenCandidates.add(issuer);
      const indirect=marketValue*BigInt(weightBp)/10000n;
      add(issuer,indirect,{kind:'etf',scope:'topTen',fund:fund.symbol,fundValueMicro:marketValue,weightBp,asOf:fund.asOf,source:fund.source,basis:fund.basis});
    }
    for(const [issuer,weightBp] of fund.directIssuerMatches||[]){
      if(!directCandidates.has(issuer))continue;
      const indirect=marketValue*BigInt(weightBp)/10000n;
      add(issuer,indirect,{kind:'etf',scope:'directMatch',fund:fund.symbol,fundValueMicro:marketValue,weightBp,asOf:fund.asOf,source:fund.source,basis:fund.basis});
    }
  }
  const candidates=[...issuers.values()].map(item=>{
    const total=item.direct+item.indirect+item.leveraged;
    return {issuer:item.issuer,label:policy.displayNames[item.issuer]||item.issuer,
      directCents:cents(item.direct),etfCents:cents(item.indirect),leveragedCents:cents(item.leveraged),leveragedInvestmentCents:cents(item.leveragedInvestment),equivalentExposureCents:cents(total),marketValueCents:cents(total),
      percent:percent(total,denominator),aboveOnePercent:total*100n>=denominator,
      parts:item.parts.map(({micro,fundValueMicro,investmentMicro,...part})=>({...part,marketValueCents:cents(micro),...(investmentMicro===undefined?{}:{investmentCents:cents(investmentMicro)}),
        ...(fundValueMicro===undefined?{}:{fundValueCents:cents(fundValueMicro)})})),
      _total:total};
  }).sort((a,b)=>a._total===b._total?a.label.localeCompare(b.label):a._total>b._total?-1:1);
  const listed=candidates.filter(r=>r.aboveOnePercent);
  const listedTotal=listed.reduce((sum,r)=>sum+r._total,0n);
  const rows=listed.map(({_total,...row})=>row);
  return {methodId:policy.methodId+'-daily-leverage-v1',measure:'equivalent-exposure',cutoff,denominatorCents:cents(denominator),rows,
    listedEquivalentExposureCents:cents(listedTotal),listedMarketValueCents:cents(listedTotal),listedPercent:percent(listedTotal,denominator),
    candidateCount:candidates.length,candidateSources:{direct:directCandidates.size,etfTopTen:topTenCandidates.size},
    matchedFunds:[...usedFunds.values()].map(f=>({symbol:f.symbol,asOf:f.asOf,source:f.source,basis:f.basis})).sort((a,b)=>a.symbol.localeCompare(b.symbol)),
    missingFunds:[...missingFunds.values()].map(({marketValueMicro,...rest})=>({...rest,marketValueCents:cents(marketValueMicro)})).sort((a,b)=>a.symbol.localeCompare(b.symbol))};
}

const esc=value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const money=centsValue=>'$'+(Number(centsValue)/100).toLocaleString('en-US',{maximumFractionDigits:0});
export function renderWeeklyConcentration(result){
  const rows=result.rows.map(r=>`<div class="line"><span>${esc(r.label)}<br><small>直接 ${money(r.directCents)} ＋ ETF 穿透 ${money(r.etfCents)}${BigInt(r.leveragedCents||0)>0n?` ＋ 杠杆等效 ${money(r.leveragedCents)}`:''}</small></span><b>${r.percent.toFixed(2)}%<br><small>${money(r.marketValueCents)}</small></b></div>`).join('')||'<p>已核实部分没有达到 1% 的发行人。</p>';
  const missing=result.missingFunds.length?`<p class="ai-coverage">未计入：${result.missingFunds.map(f=>`${esc(f.symbol)} ${money(f.marketValueCents)}（${esc(f.reason)}）`).join('；')}。这些敞口不能视为零。</p>`:'';
  const audit=result.rows.map(r=>`<h3>${esc(r.label)} · ${money(r.marketValueCents)} / ${r.percent.toFixed(2)}%</h3><p>直接 ${money(r.directCents)} ＋ ETF 穿透 ${money(r.etfCents)}${BigInt(r.leveragedCents||0)>0n?` ＋ 杠杆等效 ${money(r.leveragedCents)}（实际投资 ${money(r.leveragedInvestmentCents)}）`:""}</p><ul>${r.parts.map(p=>p.kind==='leveraged'?`<li>${esc(p.custodian)} ${esc(p.symbol)} 投资市值 ${money(p.investmentCents)} × ${p.multiplierBp/10000} ＝ ${money(p.marketValueCents)} 每日目标等效敞口（<a href="${esc(p.source)}" rel="noopener noreferrer">发行方目标</a>）</li>`:p.kind==='direct'
    ?`<li>直接 ${esc(p.custodian)} ${esc(p.symbol)}：${money(p.marketValueCents)}</li>`
    :`<li>${esc(p.fund)} ${money(p.fundValueCents)} × ${(p.weightBp/100).toFixed(2)}% ＝ ${money(p.marketValueCents)}（${p.scope==='topTen'?'前十':'直接持股同名、非前十'}；成分日 ${esc(p.asOf)}，<a href="${esc(p.source)}" rel="noopener noreferrer">发行方资料</a>）</li>`).join('')}</ul>`).join('');
  const sourceList=result.matchedFunds.map(f=>`<li>${esc(f.symbol)}：${esc(f.asOf)} · <a href="${esc(f.source)}" rel="noopener noreferrer">发行方前十</a>${f.basis==='economic-exposure'?'（经济敞口）':''}</li>`).join('');
  return `<h2>单票集中度</h2><p class="muted">三账户含现金 · 直接个股＋ETF 同名穿透／前十大股票＋已核实杠杆等效敞口 · 合计至少 1% · 含 BRK.B</p><div class="line"><span>已列 ${result.rows.length} 个单票合计<br><small>仅统计下列达到 1% 的发行人等效敞口</small></span><b>${money(result.listedMarketValueCents)}<br><small>${result.listedPercent.toFixed(2)}%</small></b></div>${rows}${missing}<details><summary>计算过程与资料日期</summary><p>先合并两组候选：①直接持有的个股，加上各 ETF 中已核实的同名金额；②各 ETF 的前十成分股。两组中相同发行人及不同股类只算一个名字，合计后再筛选至少 1%。本轮候选：直接持股 ${result.candidateSources.direct} 个、ETF 前十 ${result.candidateSources.etfTopTen} 个，合并去重 ${result.candidateCount} 个。</p><p>ETF 间接金额＝该 ETF 本轮美元市值 × 已核实的成分权重；加直接持股后，除以三账户含现金总额 ${money(result.denominatorCents)}。权重逐行向下截取至 0.01%，金额只在显示时四舍五入；用未四舍五入的合计值判断是否达到 1%。合成 ETF 用经济敞口，不用抵押品篮子。</p><p>VSTL 按投资市值 × 2 归入 VST 每日目标等效敞口，与直接 VST 合并；不是把投资市值或账户净值翻倍，三账户含现金分母不变。每日目标不是多日收益的两倍，也不代表实时衍生品 delta。杠杆等效敞口及其合计可能超过 100%；不截断、不重新归一化，也不把它称为实际投资市值占比。类似产品仅在底层、每日倍数及来源持仓身份均核实后按明确映射计入；未核实仍列缺口。</p><p>已列单票合计先汇总达到 1% 的发行人未四舍五入金额，再除以相同分母；不包含低于 1% 或资料未核实的敞口。</p><p>只计入已核实的前十及直接持股同名成分。其余 ETF 成分或缺资料基金仍未知，因此结果是可见下限，不保证列全所有超过 1% 的发行人；ETF 本身不重复计入单票。</p><h3>本轮 ETF 成分资料</h3><ul>${sourceList||'<li>本轮没有可用的 ETF 成分资料</li>'}</ul>${audit}</details>`;
}
