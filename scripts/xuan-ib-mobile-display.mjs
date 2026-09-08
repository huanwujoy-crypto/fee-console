// Display only, after paired-report verification. No network, trading or ledger writes.
import {retireFourBucketDisplay} from './xuan-ib-four-bucket-retirement.mjs';
import {improveOrderCards,ORDER_CARDS_CSS} from './xuan-ib-order-cards.mjs';
import {improveAllocationCards,ALLOCATION_CARDS_CSS} from './xuan-ib-allocation-cards.mjs';
import {improveHoldingsCards,HOLDINGS_CARDS_CSS} from './xuan-ib-holdings-cards.mjs';
import {simplifyReportNotes} from './xuan-ib-routine-reading.mjs';
export {organizeRoutineRecords} from './xuan-ib-routine-reading.mjs';
export const GUIDE_BODY = `<ol><li><b>概览</b>：先看数据日期，再看持仓变化；市值大的排前面。</li><li><b>风险 / 配置</b>：看提醒与现金参考，箭头展开详情。</li><li><b>待办</b>：只处理需要你的事项；挂单仅提醒，不自动撤单。</li><li><b>ETF</b>：A 实际、B 协作方案、C 标普500；看趋势与截止日期。</li><li><b>刷新</b>：读取已发布结果，不生成新报告。上午版周二至周六 08:00；睡前版美股开市时启动。</li></ol><p>颜色是提醒，不是交易指令；所有页面均不自动买卖或转账。</p>`;

export const MOBILE_READING_CSS = `
.kpis{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:10px!important}
.kpi{container-type:inline-size;padding:14px!important;min-width:0}
.kpi .big{font-size:clamp(18px,14cqi,32px)!important;white-space:nowrap!important;overflow-wrap:normal!important;letter-spacing:-.04em}
.kpi .lab{font-size:13px!important;line-height:1.3}.mobile-state{display:block;font-size:12px;color:var(--mut);margin-top:5px}
.mobile-cash-guidance{margin:8px 0 0;font-size:12px}.mobile-cash-guidance div{display:flex;justify-content:space-between;gap:4px;padding:3px 0}.mobile-cash-guidance dt,.mobile-cash-guidance dd{margin:0;white-space:nowrap}.mobile-cash-guidance dd{font-weight:750}
.pane-notes{margin-top:20px!important}.pane-notes>summary{font-size:15px}.pane-notes .notes-section{padding:10px 0;border-bottom:1px solid var(--line)}
.pane-notes p,.pane-notes li{font-size:14px!important;line-height:1.6}.pane-notes table{min-width:550px}
.mobile-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:10px 0}.mobile-metrics div{padding:10px;background:var(--bg);border-radius:10px;min-width:0}.mobile-metrics dt{font-size:12px;color:var(--mut)}.mobile-metrics dd{margin:5px 0 0;font-weight:750;font-size:16px;white-space:nowrap}.mobile-metric-caveat{font-size:12px!important;color:#9a6500}
.mobile-risk-table{table-layout:fixed!important;min-width:0!important;width:100%!important}
.mobile-risk-table th:first-child,.mobile-risk-table td:first-child{width:42%!important;text-align:left}
.mobile-risk-table td:last-child{width:58%;text-align:right;white-space:nowrap!important}
.mobile-risk-table th,.mobile-risk-table td{font-size:14px!important;overflow-wrap:normal!important;padding:10px 6px!important}
.mobile-risk-table strong{font-size:17px}.mobile-risk-table small{display:block;font-size:12px;line-height:1.6;color:var(--mut);white-space:nowrap}
.pane table th,.pane table td{overflow-wrap:normal!important;word-break:normal!important}
.pane table td:not(:first-child){white-space:nowrap}.pane table th{font-size:13px}.pane .tblwrap{overflow-x:auto}
@media(min-width:850px){.kpis{grid-template-columns:repeat(4,minmax(0,1fr))!important}}
@media(max-width:360px){.wrap{padding:8px!important}.kpi{padding:10px!important}.kpi .big{font-size:clamp(17px,14cqi,25px)!important}}
`;

export function extractReadingMetrics(text) {
  // Copy explicit labelled figures only; never derive status, prices or ratios.
  const specs=[['持仓数量',/(\d+) 只/],['持仓市值',/权威市值 (\$[\d,.]+)/],
    ['AI 中情景',/中情景 (\d+(?:\.\d+)?%)/],['三账户总额',/分母 (\$[\d,.]+)/],
    ['现金池',/现金池 (\$[\d,.]+)/],['预留 CALL',/reserve (\$[\d,.]+)/],
    ['现金覆盖',/现金覆盖待 call 款 ([\d.]+x)/],['可用现金',/可用现金 (\$[\d,.]+)/],
    ['HL 当前 / 目标',/HL ([\d.]+% \/ [\d.]+%)/],['VC-PE 当前 / 目标',/VC-PE ([\d.]+% \/ [\d.]+%)/],
    ['HF',/HF ([\d.]+%)/],['常青基金',/常青(?:基金)? ([\d.]+%)/],
    ['美国底仓 / 目标',/美国底仓 ([\d.]+% \/ [\d.]+%)/],['美国科技 / 目标',/美国科技 ([\d.]+% \/ [\d.]+%)/],
    ['非美发达 / 目标',/非美发达 EXUS·VCN ([\d.]+% \/ [\d.]+%)/],['新兴市场 / 目标',/新兴市场 EIMI·INDA ([\d.]+% \/ [\d.]+%)/],
    ['HSBC 赎回进度',/HSBC-HK 赎回进度 ([\d.]+%)/]];
  return specs.flatMap(([label,re])=>{const m=text.match(re);return m?[[label,m[1]+(label==='持仓数量'?' 只':'')]]:[];});
}

export function extractCashGuidance(text){
  return ['EXUS','EIMI','USSC'].flatMap(ticker=>{const match=text.match(new RegExp(`(?:^|[^A-Z])${ticker}\\s*(\\$[\\d,]+(?:\\.\\d+)?|待回款后重算)`));return match?[[ticker,match[1]]]:[];});
}

export function simplifyPaneReading(doc) {
  if(!doc.createElement || doc.getElementById('xuan-pane-notes-p1'))return;
  const names=['概览','风险','配置','待办'];
  const notes=new Map();
  for(let i=1;i<=4;i++){
    const pane=doc.querySelector(`.pane.p${i}`);if(!pane)continue;
    const fold=doc.createElement('details');fold.id=`xuan-pane-notes-p${i}`;fold.className='pane-notes';
    const heading=doc.createElement('summary');heading.textContent=`报告说明 · ${names[i-1]}`;fold.append(heading);
    const body=doc.createElement('div');body.className='dbody';fold.append(body);notes.set(i,{pane,fold,body});
  }
  const move=(i,title,nodes)=>{
    const target=notes.get(i);if(!target||!nodes.length)return;
    const section=doc.createElement('section');section.className='notes-section';
    const h=doc.createElement('h3');h.textContent=title;section.append(h);
    nodes.forEach(n=>section.append(n));target.body.append(section);
  };
  // Keep exact original explanations and figures accessible, not deleted.
  [...doc.querySelectorAll('.kpis .kpi')].forEach((kpi,index)=>{
    const title=kpi.querySelector('.lab')?.textContent||'指标说明';
    const descriptions=[...kpi.children].filter(n=>n.matches('.sub,details'));
    const brief=descriptions.map(n=>n.textContent).join(' ');
    move(index===2?2:index===3?3:1,title,descriptions);
    if(index===3){
      const guidance=extractCashGuidance(brief);
      if(guidance.length){const rows=doc.createElement('dl');rows.className='mobile-cash-guidance';
        for(const [ticker,amount] of guidance){const pair=doc.createElement('div'),name=doc.createElement('dt'),value=doc.createElement('dd');name.textContent=ticker;value.textContent=amount;pair.append(name,value);rows.append(pair);}kpi.append(rows);}
    }
    const status=doc.createElement('small');status.className='mobile-state';
    status.textContent=index===3?'现金优先 · 非下单':/提醒区间/.test(brief)?'提醒区间':/预警/.test(brief)?'需留意':'';
    if(status.textContent)kpi.append(status);
  });
  for(const [i,{pane}] of notes){
    for(const card of [...pane.querySelectorAll(':scope > section.card,:scope > details')]){
      // Decision/receipt DOM is owned by the interaction renderer. Never move it.
      if(card.matches('.dcard,[data-decision-id]')||card.querySelector('[data-decision-id]'))continue;
      const title=card.querySelector(':scope > h2,:scope > summary')?.textContent.trim()||names[i-1];
      const paragraphs=[...card.querySelectorAll(':scope > p,:scope > ol.brief-lines,:scope > .dbody > p,:scope > .dbody > ol.brief-lines')];
      const originalText=paragraphs.map(p=>p.textContent).join(' ');
      const metrics=extractReadingMetrics(originalText);
      if(metrics.length){
        const grid=doc.createElement('dl');grid.className='mobile-metrics';
        for(const [label,value] of metrics){const pair=doc.createElement('div'),dt=doc.createElement('dt'),dd=doc.createElement('dd');dt.textContent=label;dd.textContent=value;pair.append(dt,dd);grid.append(pair);}
        const anchor=card.querySelector(':scope > h2,:scope > summary');anchor?.after(grid);
        if(/沿用|近似|待核实|未查询|不含 AAOI/.test(originalText)){
          const caveat=doc.createElement('p');caveat.className='mobile-metric-caveat';
          caveat.textContent=/四桶/.test(originalText)?'四桶沿用旧快照 · 日期见说明':/不含 AAOI/.test(originalText)?'原报告口径 · 尚未计入 AAOI':'含沿用或待核数据 · 见说明';grid.after(caveat);
        }
      }
      move(i,title,paragraphs);
      if(i===2){const h=card.querySelector(':scope > h2');if(h){
        if(/AI 压力/.test(title))h.textContent='AI 压力敞口';
        else if(/单票集中度/.test(title))h.textContent='单票集中度';
        else if(/弹药.*reserve/.test(title))h.textContent='现金与预留款';
      }}
      for(const detail of [...card.querySelectorAll(':scope > details,:scope > .dbody > details')]){
        if(/详细说明|排序与报价说明|使用前核对/.test(detail.querySelector('summary')?.textContent||''))move(i,title,[detail]);
      }
      if(!card.querySelector('table,.kv,.mobile-metrics,.brief-signal,details,li')&&!card.querySelector(':scope > p'))card.remove();
    }
  }
  // Two-column risk ledger: compact identity/weight left, contribution/value right.
  for(const table of [...doc.querySelectorAll('.pane.p2 table')]){
    if(table.closest('.pane-notes'))continue;
    const heads=[...table.querySelectorAll('thead th')];
    const exposure=heads.length===4&&/账户.*标的/.test(heads[0].textContent)&&/计入/.test(heads[3].textContent);
    const concentration=heads.length===4&&/IB 视图标的/.test(heads[0].textContent)&&/余量/.test(heads[3].textContent);
    if(!exposure&&!concentration)continue;
    move(2,'风险逐项原始口径',[table.cloneNode(true)]);
    for(const row of [...table.querySelectorAll('tbody tr')]){
      const cells=[...row.children];if(cells.length!==4)continue;
      const identity=cells[0].textContent.trim(),match=identity.match(/^(IB-HK|Schwab-HK|Webull)\s+(\S+)/);
      const left=doc.createElement('td'),right=doc.createElement('td');
      const name=doc.createElement('strong');name.textContent=match?match[2]:identity;left.append(name);
      const weight=doc.createElement('small');weight.textContent=exposure?`${match?match[1]+' · ':''}${cells[2].textContent.trim()}`:`市值 ${cells[1].textContent.trim()}`;left.append(weight);
      const contribution=doc.createElement('strong');contribution.textContent=cells[exposure?3:2].textContent.trim();right.append(contribution);
      const value=doc.createElement('small');value.textContent=exposure?`市值 ${cells[1].textContent.trim()}`:`余量 ${cells[3].textContent.trim()}`;right.append(value);
      row.replaceChildren(left,right);
    }
    const h1=doc.createElement('th'),h2=doc.createElement('th');h1.textContent=exposure?'标的 / 系数':'标的 / 市值 USD';h2.textContent=exposure?'计入 USD / 市值':'占比 / 参考线';
    heads[0].parentElement.replaceChildren(h1,h2);table.classList.add('mobile-risk-table');
    const rows=[...table.querySelectorAll('tbody tr')];
    if(rows.length>5){
      const fold=doc.createElement('details'),heading=doc.createElement('summary');heading.textContent=`其余明细（${rows.length-5} 行）`;fold.append(heading);
      const extra=table.cloneNode(false);extra.append(table.querySelector('thead').cloneNode(true));
      const body=doc.createElement('tbody');rows.slice(5).forEach(r=>body.append(r));extra.append(body);fold.append(extra);table.parentElement.after(fold);
    }
  }
  // Each pane also gets the shared provenance/disclaimer, while the original
  // global fold stays available for the ETF pane and legacy consumers.
  const common=[...doc.querySelectorAll('details')].find(d=>!d.closest('.pane')&&/^报告说明/.test(d.querySelector('summary')?.textContent||''));
  for(const [i,{pane,fold,body}] of notes){
    if(common){const copy=common.querySelector('.dbody')?.cloneNode(true);if(copy){
      for(const n of copy.querySelectorAll('[id]'))n.removeAttribute('id');
      for(const n of copy.querySelectorAll('template,script,style'))n.remove();
      move(i,'数据日期与共同口径',[copy]);
    }}
    if(!body.children.length){const p=doc.createElement('p');p.textContent='金额与日期按本报告来源展示；只读，不自动执行交易。';body.append(p);}
    for(const table of body.querySelectorAll('table'))if(!table.parentElement.classList.contains('tblwrap')){const wrap=doc.createElement('div');wrap.className='tblwrap';table.replaceWith(wrap);wrap.append(table);}
    pane.append(fold);
  }
  if(common){const etf=doc.querySelector('.pane.p5');if(etf){common.querySelector('summary').textContent='报告说明 · ETF';etf.append(common);}}
}

export function improveMobileDisplay(doc) {
  if (!doc?.querySelectorAll) return;
  // Reorder existing cells intact; never calculate or change their amounts.
  for (const table of doc.querySelectorAll('.pane.p1 table')) {
    const heads = [...table.querySelectorAll('thead th')];
    const valueIndex = heads.findIndex(h => /^市值\s*\$?$/.test(h.textContent.trim()));
    if (valueIndex < 1 || !/标的/.test(heads[0]?.textContent || '')) continue;
    for (const row of table.querySelectorAll('tr')) {
      const cells = [...row.children];
      if (cells.length !== heads.length) continue;
      row.insertBefore(cells[valueIndex], cells[1]);
    }
    const body = table.querySelector('tbody');
    if (!body) continue;
    const value = row => {
      const raw = row.children[1]?.textContent.trim().replace(/[$,\s]/g, '');
      return raw && /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : -Infinity;
    };
    [...body.children].sort((a,b) => value(b)-value(a)).forEach(row => body.append(row));
    table.classList.add('mobile-holdings');
  }
  // Label-only alias. Do not mutate templates, receipts or attribute values.
  const allocation = doc.querySelector('.pane.p3');
  if (allocation && doc.createTreeWalker) {
    const walk = doc.createTreeWalker(allocation, 4);
    const nodes=[]; for(let n=walk.nextNode();n;n=walk.nextNode()) nodes.push(n);
    for(const n of nodes) if(!n.parentElement?.closest('template,script,style'))
      n.textContent=n.textContent.replace(/常青(?!基金)/g,'常青基金');
  }
  const pane=doc.querySelector('.pane.p4');
  const old=pane&&[...pane.children].find(n=>n.tagName==='DETAILS'&&n.querySelector('summary')?.textContent.includes('换仓触发检查'));
  if(old){
    const reminders=doc.createElement('details');reminders.open=true;
    const heading=doc.createElement('summary');heading.textContent='⑥ 挂单提醒';reminders.append(heading);
    const body=doc.createElement('div');body.className='dbody';
    const note=doc.createElement('p');note.textContent='仅供查看已有挂单；是否处理由你决定，不作换仓触发判定。';body.append(note);
    for(const table of old.querySelectorAll('table')) {
      const copy=table.cloneNode(true),rows=[...copy.querySelectorAll('tbody tr')];
      const side=r=>/买/.test(r.children[0]?.textContent||'')?0:/卖/.test(r.children[0]?.textContent||'')?1:2;
      const distance=r=>{const m=r.children[2]?.textContent.match(/[+-]?\d+(?:\.\d+)?/);return m?Math.abs(Number(m[0])):Infinity;};
      rows.sort((a,b)=>side(a)-side(b)||distance(a)-distance(b)).forEach(r=>copy.querySelector('tbody').append(r));
      const wrap=doc.createElement('div');wrap.className='tblwrap';wrap.append(copy);body.append(wrap);
    }
    reminders.append(body);old.replaceWith(reminders);
  }
  if(!doc.getElementById('xuan-mobile-display-style')){
    const style=doc.createElement('style');style.id='xuan-mobile-display-style';
    style.textContent='.mobile-holdings{min-width:640px!important;table-layout:fixed}.mobile-holdings th:first-child,.mobile-holdings td:first-child{width:100px}.mobile-holdings th:nth-child(2),.mobile-holdings td:nth-child(2){width:110px;white-space:nowrap;font-weight:650}.mobile-holdings td{overflow-wrap:normal}';
    style.textContent+=MOBILE_READING_CSS+ORDER_CARDS_CSS+ALLOCATION_CARDS_CSS+HOLDINGS_CARDS_CSS;
    doc.head.append(style);
  }
  improveHoldingsCards(doc);
  simplifyPaneReading(doc);
  improveOrderCards(doc);
  retireFourBucketDisplay(doc);
  improveAllocationCards(doc);
  simplifyReportNotes(doc);
}
