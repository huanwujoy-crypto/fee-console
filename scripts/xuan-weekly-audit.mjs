// Read-only reconciliation of the existing weekly engine. No new strategy or trades.
const arms=['A','B','C'];
const check=(ok,message)=>{if(!ok)throw Error(message);};
const near=(a,b)=>Math.abs(a-b)<0.005;
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=(v,n=2)=>Number(v).toLocaleString('en-US',{minimumFractionDigits:n,maximumFractionDigits:n});
const dollars=v=>`$${num(v)}`;

export function buildWeeklyAudit(input,abc){
  const result=abc.result, rows=result.rows, first=rows[0], last=rows.at(-1);
  check(!result.stop && result.latestCompleteDate===last.date,'audit_requires_complete_interval');
  const symbols=Object.keys(abc.weights.B), ids=new Map();
  for(const f of input.flows){
    const previous=ids.get(f.id);
    check(!previous||JSON.stringify([previous.date,previous.usd,previous.kind,previous.sourceKind])===JSON.stringify([f.date,f.usd,f.kind,f.sourceKind]),'audit_conflicting_flow');
    ids.set(f.id,f);
  }
  // Whitelist public fields. Never publish transaction IDs, descriptions or account data.
  const flows=[...ids.values()].filter(f=>f.date>first.date&&f.date<=last.date).map(f=>({
    date:f.date,usd:f.usd,category:f.sourceKind==='asset-transfer-daily-net'?'securities':'cash',
  })).sort((a,b)=>a.date.localeCompare(b.date)||a.usd-b.usd);
  const totals={cashIn:0,cashOut:0,securitiesIn:0,securitiesOut:0,net:0};
  for(const f of flows){totals[(f.category==='cash'?'cash':'securities')+(f.usd>=0?'In':'Out')]+=Math.abs(f.usd);totals.net+=f.usd;}
  check(near(totals.net,last.cumulativeFlowUsd),'audit_flow_total_mismatch');
  const prices=Object.fromEntries(symbols.map(s=>[s,input.quotes[first.date][s].usd]));
  const portfolios={};
  const initialPurchases=[];
  for(const arm of ['B','C']){
    const weights=abc.weights[arm];
    portfolios[arm]={cash:0,units:Object.fromEntries(symbols.map(s=>[s,0]))};
    for(const [symbol,weight] of Object.entries(weights)){
      const amount=result.initialUsd*weight, units=amount/prices[symbol];
      portfolios[arm].units[symbol]=units;
      initialPurchases.push({arm,symbol,weight,amount,price:prices[symbol],units});
    }
  }
  const product={A:1,B:1,C:1},daily=[],simulation=[];
  for(let i=1;i<rows.length;i++){
    const row=rows[i],previous=rows[i-1];
    const flow=flows.filter(f=>f.date===row.date).reduce((v,f)=>v+f.usd,0);
    const perArm={};
    for(const symbol of symbols){const q=input.quotes[row.date][symbol];if(q.status==='close')prices[symbol]=q.usd;}
    for(const arm of arms){
      const beginning=previous.endingUsd[arm], ending=row.endingUsd[arm],beforeFlow=ending-flow;
      const dailyReturn=beforeFlow/beginning-1;
      product[arm]*=1+dailyReturn;
      check(Math.abs(product[arm]*100-row.index[arm])<1e-8,'audit_twr_mismatch');
      perArm[arm]={beginning,ending,beforeFlow,dailyReturn,cumulativeReturn:product[arm]-1};
      if(arm==='A')continue;
      const p=portfolios[arm];
      const value=()=>p.cash+symbols.reduce((n,s)=>n+p.units[s]*prices[s],0);
      check(near(value(),beforeFlow),'audit_before_flow_mismatch');
      if(flow>=0)p.cash+=flow;
      else{
        const used=Math.min(p.cash,-flow);p.cash-=used;
        const needed=-flow-used;
        if(needed>1e-8){
          check(row.canTrade,'audit_sale_without_close');
          const invested=symbols.reduce((n,s)=>n+p.units[s]*prices[s],0);
          const fraction=needed/invested;
          check(fraction<=1+1e-10,'audit_overdraw');
          for(const s of symbols)p.units[s]*=1-fraction;
        }
      }
      if(row.canTrade&&p.cash>1e-8){
        for(const [s,w] of Object.entries(abc.weights[arm]))p.units[s]+=p.cash*w/prices[s];
        p.cash=0;
      }
      check(near(value(),ending),'audit_portfolio_mismatch');
    }
    daily.push({date:row.date,flow,...perArm});
  }
  for(const arm of ['B','C']){
    const p=portfolios[arm];
    for(const symbol of Object.keys(abc.weights[arm]))simulation.push({arm,symbol,units:p.units[symbol],
      price:prices[symbol],quoteDate:last.quoteDates[symbol],value:p.units[symbol]*prices[symbol]});
    if(p.cash>1e-8)simulation.push({arm,symbol:'现金',units:null,price:null,quoteDate:last.date,value:p.cash});
  }
  const summary=Object.fromEntries(arms.map(arm=>[arm,{initial:result.initialUsd,netFlow:totals.net,
    ending:last.endingUsd[arm],gain:last.endingUsd[arm]-result.initialUsd-totals.net,twr:product[arm]-1}]));
  return {baselineDate:first.date,cutoff:last.date,totals,flows,summary,initialPurchases,simulation,daily};
}

export function renderWeeklyAudit(a){
  const t=a.totals;
  const flowType=f=>f.category==='securities'?(f.usd>=0?'证券净转入':'证券净转出'):(f.usd>=0?'入金':'出金');
  const table=(heads,body)=>`<div class="audit-scroll" tabindex="0"><table class="audit-table"><thead><tr>${heads.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
  const row=values=>`<tr>${values.map(v=>`<td>${v}</td>`).join('')}</tr>`;
  const history=[...a.daily].sort((x,y)=>y.date.localeCompare(x.date));
  const start=new Date(Date.parse(a.cutoff+'T00:00:00Z')-6*86400000).toISOString().slice(0,10);
  const recent=history.filter(d=>d.date>=start),older=new Map();
  for(const d of history.filter(d=>d.date<start)){
    const day=new Date(d.date+'T00:00:00Z');day.setUTCDate(day.getUTCDate()-(day.getUTCDay()+6)%7);
    const key=day.toISOString().slice(0,10);if(!older.has(key))older.set(key,[]);older.get(key).push(d);
  }
  const dailyTable=days=>table(['日期／方案','期初 USD','净流入 USD','期末 USD','日收益','累计 TWR'],days.flatMap(d=>arms.map(k=>row([`${d.date} ${k}`,num(d[k].beginning),num(d.flow),num(d[k].ending),num(d[k].dailyReturn*100,6)+'%',num(d[k].cumulativeReturn*100,6)+'%']))).join(''));
  const dailyHtml=`<p class="muted">最新日期在前，默认展开截至 ${esc(a.cutoff)} 的最近七个日历日；更早历史按周折叠，累计结果仍使用全部历史。</p>${dailyTable(recent)}${[...older].map(([week,days])=>`<details class="abc-history-week"><summary>${esc(week)} 当周 · ${days.length} 日</summary>${dailyTable(days)}</details>`).join('')}`;
  return `<div id="cashflows"><h3>资金记录 · IB 自动读取</h3><p>现金入金 ${dollars(t.cashIn)} · 出金 ${dollars(t.cashOut)}<br>证券净转入 ${dollars(t.securitiesIn)} · 净转出 ${dollars(t.securitiesOut)}<br><b>资本净流入 ${dollars(t.net)}</b></p>
  <details><summary>查看资金记录（${a.flows.length} 条）</summary><p class="muted">截至 ${esc(a.cutoff)}。证券转仓按 IB 每日净额记录，不冒充现金出入；买卖、股息、利息和费用不列为外部资金。</p>${a.flows.length?table(['日期','类型','USD'],a.flows.map(f=>row([esc(f.date),flowType(f),dollars(f.usd)])).join('')):'<p>本区间没有外部资金变动。</p>'}</details></div>
  <details><summary>计算过程与逐日核算</summary><p>期初（${esc(a.baselineDate)}）${dollars(a.summary.A.initial)}；从 8 月 1 日起计算。损益＝期末－期初－资本净流入。</p>
  ${table(['方案','期末 USD','投资损益 USD','累计 TWR'],arms.map(k=>row([k,num(a.summary[k].ending),num(a.summary[k].gain),num(a.summary[k].twr*100,4)+'%'])).join(''))}
  <h3>① 模拟期初买入</h3><p class="muted">投入金额÷当日收盘价＝模拟份额。允许碎股；没有真实交易。</p>
  ${table(['方案／ETF','投入 USD','单价 USD','份额'],a.initialPurchases.map(r=>row([`${r.arm} · ${r.symbol}`,num(r.amount),num(r.price,4),num(r.units,6)])).join(''))}
  <h3>② 模拟期末核对</h3><p class="muted">份额×价格＝市值；分项合计应等于上表期末金额。入金按目标比例投入，出金先现金、不足按市值比例减仓；不每日再平衡。</p>
  ${table(['方案／ETF','期末份额','单价 USD','市值 USD'],a.simulation.map(r=>row([`${r.arm} · ${r.symbol}`,r.units===null?'—':num(r.units,6),r.price===null?'—':num(r.price,4),num(r.value)])).join(''))}
  <h3>③ 逐日核算</h3><p class="muted">日收益＝（期末－净流入）÷期初－1。累计 TWR＝每日（1＋日收益）连乘－1。金额显示至分、收益至六位小数，内部不逐日舍入。周末按已核验休市记录承接资产；行情日期可能因市场休市不同。</p>
  ${dailyHtml}</details>`;
}
