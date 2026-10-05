// Review priority only: never classifies or removes unknown financial exposure.
import {createHash} from 'node:crypto';
import {DEFAULT_POLICY} from './xuan-weekly-ai-exposure.mjs';
import {DEFAULT_TOP10_POLICY} from './xuan-weekly-concentration.mjs';
import {resolveLeveragedProduct} from './xuan-weekly-leveraged-products.mjs';
export const REVIEW_POLICY={methodId:'weekly-ai-review-priority-v1',navPartsPerMillion:250,
  // Existing reviewed issuer aliases; candidate links below affect priority only.
  knownAliases:{tsmc:'TSM',alphabet:'ALPHABET',berkshire:'BERKSHIRE','sk-hynix':'SKHYNIX',samsung:'SAMSUNG',rbc:'RBC',td:'TD_BANK',bmo:'BMO',bns:'BNS',cibc:'CIBC',enbridge:'ENBRIDGE',agnico:'AGNICO',shopify:'SHOPIFY',cnrl:'CNRL','unreviewed-brookfield':'BROOKFIELD'},
  candidateLinks:{'unreviewed-isin-US0937121079':'known:BE','unreviewed-isin-INE018A01030':'candidate:LT','unreviewed-lt':'candidate:LT','unreviewed-isin-INE101A01026':'candidate:M_AND_M','unreviewed-m_and_m':'candidate:M_AND_M'}};
const amount=v=>{if(!/^\d+$/.test(String(v)))throw Error('weekly_review_amount_invalid');return BigInt(v);};
const cents=v=>String((v+5000n)/10000n);
const pct=(v,nav)=>Number((v*10000n+nav/2n)/nav)/100;
export function buildAiReviewPriority(envelope,{cutoff,actualAllocation,policy=DEFAULT_POLICY,reviewPolicy=REVIEW_POLICY,aliases=DEFAULT_TOP10_POLICY.directAliases}={}){
 const actual=actualAllocation;
 if(reviewPolicy.navPartsPerMillion!==250||reviewPolicy.methodId!==REVIEW_POLICY.methodId)throw Error('weekly_review_rule_invalid');
 if(!actual||actual.cutoff!==cutoff||actual.rows.length!==envelope.riskConstituents.length)throw Error('weekly_review_scope_invalid');
 const nav=envelope.riskDenominator.components.reduce((s,c)=>s+amount(c.valueMicro),0n);
 if(nav<=0n||cents(nav)!==actual.denominatorCents)throw Error('weekly_review_nav_invalid');
 const defs=new Map(policy.stocks.map(s=>[s.id,s])),under=new Map((policy.underlyingIssuers||[]).map(s=>[s.key,s])),snapshots=new Map(policy.etfSnapshots.map(s=>[s.instrumentId,s]));
 const canon=label=>aliases[policy.issuerAliases?.[label]||label]||policy.issuerAliases?.[label]||aliases[label]||label;
 const knownKey=(key,def)=>'known:'+(reviewPolicy.knownAliases[key]||canon(def.issuer));
 const groups=new Map(),blocks=new Map(),sources=new Map();let balance=0n;
 const add=(key,label,value,unknown,via,identity='reviewed-issuer')=>{const g=groups.get(key)||{key,label,total:0n,unknown:0n,via:new Set(),identity};g.total+=value;g.unknown+=unknown;g.via.add(via);if(identity==='priority-link-needs-review')g.identity=identity;groups.set(key,g);};
 const missing=(row,value)=>{const g=blocks.get(row.symbol)||{symbol:row.symbol,value:0n,asOf:row.etfAsOf||null};g.value+=value;blocks.set(row.symbol,g);};
 for(const [index,r] of envelope.riskConstituents.entries()){
  const row=actual.rows[index],value=amount(r.marketValueMicro);
  if(r.identityVerified!==true||r.valueDate!==cutoff||row.symbol!==r.symbol||row.custodian!==r.custodian||row.assetType!==r.assetType||row.marketValueCents!==cents(value))throw Error('weekly_review_source_invalid');
  const product=resolveLeveragedProduct(r,{cutoff});
  if(product){add('known:'+canon(product.underlying),product.underlying,value,['pending','etfUncovered'].includes(row.group)?value:0n,r.custodian);continue;}
  if(r.assetType==='STK'||(r.assetType!=='ETF'&&row.group==='pending')){const stock=defs.get(String(r.instrumentId));const scoped=(policy.directHoldings||[]).find(s=>s.portfolioId===r.portfolioId&&s.holdingId===r.holdingId&&s.symbol===r.symbol);const label=(stock?.symbols.includes(r.symbol)?stock.issuer:null)||scoped?.issuer||r.symbol;add('known:'+canon(label),label,value,row.group==='pending'?value:0n,r.custodian,row.group==='pending'?'source-security-only':'reviewed-issuer');continue;}
  if(row.group!=='etfUncovered')continue;
  const snapshot=snapshots.get(String(r.instrumentId));
  if(!row.etfAsOf||!snapshot||snapshot.symbol!==r.symbol||snapshot.asOf!==row.etfAsOf){missing(row,value);continue;}
  sources.set(snapshot.symbol,{symbol:snapshot.symbol,asOf:snapshot.asOf,source:snapshot.source,basis:snapshot.basis,complete:snapshot.sourceCompositionComplete===true,evidenceKind:row.evidenceKind});
  let recorded=0n;
  for(const h of snapshot.holdings){
   const units=h.weightMicroPercent??h.weightBp*10000;
   if(!Number.isSafeInteger(units)||units<0||units>100000000)throw Error('weekly_review_weight_invalid');
   const part=value*BigInt(units)/100000000n;recorded+=part;
   const stock=defs.get(h.instrumentId);const def=h.issuerKey?under.get(h.issuerKey):(stock?.symbols.includes(h.symbol)&&(stock.assetTypes||['STK']).includes('STK')?stock:null);
   if(h.kind==='cash'&&def?.group==='other')continue;
   const sourceKey=h.issuerKey||'unmapped:'+h.instrumentId,linked=reviewPolicy.candidateLinks[sourceKey];
   const key=def?knownKey(h.issuerKey,def):(linked||sourceKey);
   const label=def?.issuer||(linked?.startsWith('known:')?linked.slice(6):h.sourceRows?.[0]?.name||h.symbol||sourceKey);
   add(key,label,part,def?0n:part,snapshot.symbol,def?'reviewed-issuer':linked?'priority-link-needs-review':'source-security-only');
  }
  if(recorded>value)throw Error('weekly_review_recorded_invalid');
  const remainder=value-recorded;
  if(snapshot.sourceCompositionComplete===true)balance+=remainder;
  else missing(row,remainder);
 }
 const recordedUnknown=[...groups.values()].reduce((n,g)=>n+g.unknown,0n),missingTotal=[...blocks.values()].reduce((n,g)=>n+g.value,0n);
 const expected=actual.groups.filter(g=>['pending','etfUncovered'].includes(g.key)).reduce((s,g)=>s+amount(g.marketValueCents),0n);
 if(BigInt(cents(recordedUnknown+missingTotal+balance))-expected>2n||expected-BigInt(cents(recordedUnknown+missingTotal+balance))>2n)throw Error('weekly_review_unknown_reconciliation_invalid');
 return summarizeAiReviewPriority({cutoff,actualAllocation:actual,navMicro:String(nav),identityGroups:[...groups.values()].map(g=>({...g,totalMicro:String(g.total),unknownMicro:String(g.unknown),via:[...g.via]})),missingBlocks:[...blocks.values()].map(g=>({...g,valueMicro:String(g.value)})),completeBalanceMicro:String(balance),sources:[...sources.values()]},{reviewPolicy,aliases});
}
export function summarizeAiReviewPriority({cutoff,actualAllocation:actual,navMicro,identityGroups,missingBlocks=[],completeBalanceMicro='0',sources:sourceRows=[]},{reviewPolicy=REVIEW_POLICY,aliases=DEFAULT_TOP10_POLICY.directAliases}={}){
 const nav=amount(navMicro),balance=amount(completeBalanceMicro);
 if(reviewPolicy.navPartsPerMillion!==250||reviewPolicy.methodId!==REVIEW_POLICY.methodId||nav<=0n||cents(nav)!==actual.denominatorCents||cutoff!==actual.cutoff)throw Error('weekly_review_summary_scope_invalid');
 const groups=new Map(),blocks=new Map(),sources=new Map(sourceRows.map(s=>[s.symbol,s]));
 for(const g of identityGroups){const total=amount(g.totalMicro),unknown=amount(g.unknownMicro);if(unknown>total||groups.has(g.key))throw Error('weekly_review_group_invalid');groups.set(g.key,{...g,total,unknown,via:new Set(g.via)});}
 for(const g of missingBlocks){if(blocks.has(g.symbol))throw Error('weekly_review_block_invalid');blocks.set(g.symbol,{...g,value:amount(g.valueMicro)});}
 const unknown=[...groups.values()].filter(g=>g.unknown>0n).sort((a,b)=>a.total===b.total?a.key.localeCompare(b.key):a.total>b.total?-1:1);
 const selected=unknown.filter(g=>g.total*1000000n>=nav*250n),tail=unknown.filter(g=>g.total*1000000n<nav*250n);
 const serialize=v=>({marketValueCents:cents(v),percent:pct(v,nav)});
 const sum=(rows,key)=>rows.reduce((s,g)=>s+g[key],0n);
 const recordedUnknown=sum(unknown,'unknown'),missingTotal=sum([...blocks.values()],'value');
 const policyHash=createHash('sha256').update(JSON.stringify({reviewPolicy,aliases,actualPolicyHash:actual.policyHash})).digest('hex');
 return {methodId:reviewPolicy.methodId,policyHash,actualMethodId:actual.methodId,actualPolicyHash:actual.policyHash,cutoff,navPartsPerMillion:250,thresholdPercent:0.025,denominatorCents:actual.denominatorCents,thresholdCents:cents(nav*250n/1000000n),
  priorityCount:selected.length,priorityMergedTotal:serialize(sum(selected,'total')),priorityUnknown:serialize(sum(selected,'unknown')),smallUnreviewedCount:tail.length,smallUnreviewed:serialize(sum(tail,'unknown')),recordedUnknown:serialize(recordedUnknown),unobtainedComposition:serialize(missingTotal),completeSourceBalance:serialize(balance),
  priorityRows:selected.map(g=>({label:g.label,identity:g.identity,via:[...g.via].sort(),mergedTotal:serialize(g.total),unknown:serialize(g.unknown)})),
  missingCompositionBlocks:[...blocks.values()].sort((a,b)=>a.value>b.value?-1:1).map(g=>({symbol:g.symbol,asOf:g.asOf,...serialize(g.value)})),sources:[...sources.values()],
  limitation:'优先级依据已取得成分的合并总敞口，不是分类结论。未核实的发行人身份可能含同公司不同股类；身份候选只用于保守合并优先级，不批准业务分类。未取得成分可能增加任何发行人的敞口；小额仅指当前已记录身份组，不保证全局发行人低于门槛。旧报告不倒算。'};
}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=c=>'$'+(Number(c)/100).toLocaleString('en-US',{maximumFractionDigits:0});
export function renderAiReviewPriority(p){return `<h3>未知敞口 · 审核优先级</h3><p>按合并后占净值 0.025% 的总敞口筛选；本期门槛 ${usd(p.thresholdCents)}，随净值变化。跨账户、ETF 与直接持仓按当前身份关联合并，审核按实际投资金额，不另乘杠杆倍数。</p><p class="ai-coverage">优先核实 ${p.priorityCount} 组：合并总敞口 ${usd(p.priorityMergedTotal.marketValueCents)}，其中待审未知份额 ${usd(p.priorityUnknown.marketValueCents)}。<br>小额未逐项核实（当前已记录身份组）${p.smallUnreviewedCount} 组：合计 ${usd(p.smallUnreviewed.marketValueCents)} · ${p.smallUnreviewed.percent.toFixed(2)}% NAV；保留为未知，不当作零。身份关联未完整核实，不能保证同一发行人的全局敞口低于门槛。</p><p>未取得完整成分 ${usd(p.unobtainedComposition.marketValueCents)} · ${p.unobtainedComposition.percent.toFixed(2)}% NAV，独立保留，不能称作小额尾部。${p.missingCompositionBlocks.length?`优先补齐 ${p.missingCompositionBlocks.slice(0,3).map(r=>esc(r.symbol)).join("、")}。`:""}完整资料的非权益未分配／舍入余量 ${usd(p.completeSourceBalance.marketValueCents)} 另列。</p><details><summary>优先核实对象与资料日期（${p.priorityCount} 组）</summary>${p.priorityRows.map(r=>`<div class="line"><span style="overflow-wrap:anywhere">${esc(r.label)}<br><small>${esc(r.via.join(' · '))} · ${r.identity==='reviewed-issuer'?'已核实身份关联':'身份关联仍需核实'}</small></span><b>${usd(r.mergedTotal.marketValueCents)}<br><small>待审 ${usd(r.unknown.marketValueCents)}</small></b></div>`).join('')}<h3>完整成分缺口</h3>${p.missingCompositionBlocks.map(r=>`<div class="line"><span>${esc(r.symbol)}<br><small>${esc(r.asOf||'未取得可用资料日期')}</small></span><b>${usd(r.marketValueCents)}</b></div>`).join('')}<p>${esc(p.limitation)}</p><p>风险日期 ${esc(p.cutoff)}；审核规则版本 1。本期成分来源：${p.sources.map(s=>`${esc(s.symbol)} ${esc(s.asOf)}（${s.evidenceKind==='proxy_estimated'?'代理资料':s.complete?'完整':'部分'}）`).join('；')}。</p></details>`;}
